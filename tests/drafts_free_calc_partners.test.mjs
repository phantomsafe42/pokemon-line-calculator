import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fixturePlan, fixtureDoublesPlan, damageAdapter } from './helpers.mjs';
import { addFreeCalcBranch, editFreeCalcCombatant, replaceFreeCalcSlot, freeCalcAsNewPlan } from '../src/core/free_calc.js';
import { savedDraftSnapshot } from '../src/cache/saved_drafts.js';
import { eligibleReserves } from '../src/core/party_ownership.js';
import { planTreeOrder, planTurnTreeOrder } from '../src/core/graph.js';
import { recalculatePlanDocument } from '../src/core/recalculation.js';
import { serializePlan, parsePlan, exportSelectedPlan } from '../src/contracts/plan_file.js';
import { resolveTurn, resolveForcedReplacement } from '../src/core/resolver.js';
import { commitPreview, previewTurn } from '../src/core/planner.js';
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from '../src/adapters/standardized_dataset.js';
import { normalizeTrainerRoster } from '../src/adapters/combatant_ingest.js';

const move = (key, target) => ({ actionType:'move', actorKey:key, moveId:'tackle', targetKeys:[target], mechanicActivations:[], declaredAtStateHash:'fixture' });
function ownedFixture() {
  const data = fixtureDoublesPlan();
  data.plan.game.partyOwnership = { enemy: { policy:'per-trainer', slotOwnerIds:['owner-a','owner-b'] } };
  data.enemies.forEach((mon, index) => { data.plan.combatants[mon.combatantKey].source.partyOwnerId = index % 2 ? 'owner-b' : 'owner-a'; });
  return data;
}

test('Free Calc edits are isolated, round-trip and survive recalculation as an explicit same-turn branch', async () => {
  const {plan: original, dataset, players} = fixturePlan(); const baseline = structuredClone(original);
  const {plan,stateId} = addFreeCalcBranch(original, original.initialStateNodeId);
  editFreeCalcCombatant(plan,stateId,players[0].combatantKey,{level:60,hp:12,status:'tox',statStages:{spa:2},moves:['tackle','recover']},dataset);
  const state = plan.stateNodes[stateId]; const mon = state.combatantStates[players[0].combatantKey];
  assert.equal(mon.hp.max,12); assert.equal(mon.currentLevel,60); assert.equal(mon.majorStatus,'tox'); assert.equal(mon.statStages.spa,2);
  assert.equal(state.turnNumber,0); assert.deepEqual(state.resolutionEventIds,[]); assert.deepEqual(original,baseline);
  assert.equal(planTreeOrder(plan).length,2); assert.equal(planTurnTreeOrder(plan).length,2);
  const output = exportSelectedPlan(plan,[stateId]).plan;
  assert.deepEqual(parsePlan(serializePlan(output)),output);
  const rebuilt = await recalculatePlanDocument(plan,{dataset,previewTurnFn:()=> {throw new Error('Manual edits must not resolve as moves');}});
  const restored = Object.values(rebuilt.stateNodes).find(row=>row.freeCalc);
  assert.equal(restored.combatantStates[players[0].combatantKey].hp.max,12);
  const draft = freeCalcAsNewPlan(plan,stateId,'New line');
  assert.equal(Object.keys(draft.stateNodes).length,1); assert.equal(draft.stateNodes[draft.initialStateNodeId].turnNumber,0);
});

test('Free Calc slot selection replaces without switch events and rejects non-party enemy additions',()=>{
  const {plan:original,players,enemies}=fixturePlan(); const {plan,stateId}=addFreeCalcBranch(original,original.initialStateNodeId);
  replaceFreeCalcSlot(plan,stateId,'player',0,players[1]);
  assert.equal(plan.stateNodes[stateId].active.playerCombatantKeys[0],players[1].combatantKey);
  assert.deepEqual(plan.stateNodes[stateId].resolutionEventIds,[]);
  assert.throws(()=>replaceFreeCalcSlot(plan,stateId,'enemy',0,{...enemies[0],combatantKey:'enemy-new'}),/party/);
});

test('Added Free Calc branches can resolve and iterate without retaining the manual parent on outcomes',()=>{
  const {plan:original,dataset,players,enemies}=fixturePlan();const {plan,stateId}=addFreeCalcBranch(original,original.initialStateNodeId);
  const actions={player:move(players[0].combatantKey,enemies[0].combatantKey),enemy:move(enemies[0].combatantKey,players[0].combatantKey)};
  const preview=previewTurn({plan,parentStateNodeId:stateId,actions,dataset,damageAdapter:damageAdapter(()=>[1])});
  const committed=commitPreview(plan,preview,dataset,{selectedPreviewOutcomeId:preview.defaultPreviewOutcomeId,commitSelectedOnly:true});
  const state=committed.plan.stateNodes[committed.cursorStateNodeId];
  assert.equal(state.parentManualTransitionId,null);assert.equal(state.freeCalc,true);assert.equal(state.turnNumber,1);
  assert.deepEqual(parsePlan(serializePlan(committed.plan)),JSON.parse(JSON.stringify(committed.plan)));
});

test('Saved drafts clone incomplete selections and do not overwrite a separately started line',()=>{
  const {plan}=fixturePlan(); const editor={actionDraft:{player:[{moveId:'tackle'}],enemy:[{}]}};
  const saved=savedDraftSnapshot(plan,editor); editor.actionDraft.player[0].moveId='recover';
  assert.equal(saved.editor.actionDraft.player[0].moveId,'tackle');
  assert.equal(savedDraftSnapshot(plan).id,saved.id);
  assert.notEqual(savedDraftSnapshot({...plan,createdAt:'2026-09-05T01:00:00.000Z'}).id,saved.id);
});

test('Box newcomers can be changed back without losing the original member or its HP',()=>{
  const {plan:original,players}=fixturePlan();const {plan,stateId}=addFreeCalcBranch(original,original.initialStateNodeId);
  const newcomer={...structuredClone(players[1]),combatantKey:'player:new-box-mon'};
  const hp=plan.stateNodes[stateId].combatantStates[players[0].combatantKey].hp.max;
  replaceFreeCalcSlot(plan,stateId,'player',0,newcomer);
  replaceFreeCalcSlot(plan,stateId,'player',0,players[0]);
  const state=plan.stateNodes[stateId];assert.equal(state.combatantStates[players[0].combatantKey].hp.max,hp);
  assert.ok(!state.freeCalcRemovedKeys.includes(players[0].combatantKey));assert.ok(state.freeCalcRemovedKeys.includes(newcomer.combatantKey));
});

test('Partner reserves are slot-owned for both voluntary and forced replacements',()=>{
  const {plan,dataset,players,enemies}=ownedFixture(); const state=plan.stateNodes[plan.initialStateNodeId];
  assert.deepEqual(eligibleReserves(plan,state,'enemy',0).map(mon=>mon.combatantKey),[enemies[2].combatantKey]);
  const actions={player:players.slice(0,2).map((mon,i)=>move(mon.combatantKey,enemies[i].combatantKey)),enemy:[{actionType:'switch',actorKey:enemies[0].combatantKey,switchToKey:enemies[3].combatantKey},move(enemies[1].combatantKey,players[1].combatantKey)]};
  assert.throws(()=>resolveTurn({plan,parentStateNodeId:state.stateNodeId,actions,dataset,damageAdapter:damageAdapter(()=>[1])}),/trainer's slot/);
  state.pendingReplacementSlots=[{side:'enemy',slot:0}]; state.pendingReplacementSides=['enemy'];
  state.combatantStates[enemies[0].combatantKey].hp.min=state.combatantStates[enemies[0].combatantKey].hp.max=0;
  assert.throws(()=>resolveForcedReplacement({plan,parentStateNodeId:state.stateNodeId,dataset,replacements:{enemy:[{actionType:'replacement',side:'enemy',slot:0,consumesTurn:false,switchToKey:enemies[3].combatantKey}]}}),/invalid/);
});

test('An exhausted partner leaves its slot empty while the other trainer still has a reserve',()=>{
  const {plan,dataset,players,enemies}=ownedFixture(); const state=plan.stateNodes[plan.initialStateNodeId];
  for(const key of [enemies[0].combatantKey,enemies[2].combatantKey]) {state.combatantStates[key].hp.min=state.combatantStates[key].hp.max=key===enemies[0].combatantKey?1:0; state.combatantStates[key].hpDistribution=null;}
  const actions={player:players.slice(0,2).map(mon=>move(mon.combatantKey,enemies[0].combatantKey)),enemy:enemies.slice(0,2).map((mon,i)=>move(mon.combatantKey,players[i].combatantKey))};
  const outcomes=resolveTurn({plan,parentStateNodeId:state.stateNodeId,actions,dataset,damageAdapter:damageAdapter(()=>[2])});
  for(const outcome of outcomes){assert.equal(outcome.state.active.enemyCombatantKeys[0],null);assert.equal(outcome.state.battleEnded,false);assert.deepEqual(outcome.state.pendingReplacementSlots,[]);}
});

for(const gameId of ['volt-white-2r','fire-red-omega','storm-silver','renegade-platinum','platinum-kaizo','pokemon-unbound']) test(`${gameId} encounter data loads and mandatory/choice navigation stays source-driven`,()=>{
  const root=new URL(`../src/generated/datasets/${gameId}/`,import.meta.url);
  const read=file=>JSON.parse(fs.readFileSync(new URL(file,root),'utf8'));
  const dataset=createDatasetContext({manifest:read('dataset_manifest.json'),mechanics:read('battle_mechanics.json'),documents:Object.fromEntries(REQUIRED_DATASET_SOURCES.map(file=>[file,read(file)]))});
  const groups=Object.values(dataset.documents['trainer_battle_groups.json'].records);
  for(const group of groups){
    if(group.consumerActivation?.plc===false||!['double','doubles','tag','multi-trainer'].includes(group.battleFormat)) continue;
    assert.equal(dataset.trainerBattleFormat(group.id),'doubles');
    const team=normalizeTrainerRoster(group.id,null,dataset); assert.ok(team.every(mon=>mon.source.partyOwnerId));
    const choices=dataset.trainerBattleChoices(group.enemyTrainerIds[0]);
    assert.equal(choices.length,group.formatChoice==='single-or-double'?2:1);
    if(choices.length===2) assert.equal(choices[0].format,'singles');
  }
});
