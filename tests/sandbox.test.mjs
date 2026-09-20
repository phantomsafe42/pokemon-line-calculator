import assert from 'node:assert/strict';
import test from 'node:test';
import { fixturePlan, fixtureDoublesPlan, fixtureTriplePlan, fixtureRotationPlan, damageAdapter } from './helpers.mjs';
import { createPlanDocument } from '../src/core/plan.js';
import { isSandbox, editSandboxCombatant, placeSandboxCombatant, admitSandboxReserve } from '../src/core/sandbox.js';
import { assertValidPlanDocument } from '../src/contracts/plan_contract.js';
import { parsePlan, serializePlan, exportSelectedPlan } from '../src/contracts/plan_file.js';
import { previewTurn, commitPreview } from '../src/core/planner.js';
import { recalculatePlanDocument } from '../src/core/recalculation.js';
import { planTurnTreeOrder } from '../src/core/graph.js';
import { nodeTreeSections } from '../src/ui/node_tree.js';
import { activeKey } from '../src/core/battle_slots.js';
import { createDraftRecord } from '../src/cache/active_draft.js';
import { savedDraftSnapshot } from '../src/cache/saved_drafts.js';
import { branchProgressionSnapshot, applyBranchProgressionToLibrary } from '../src/boxes/progression.js';
import { sandboxPickerCandidates } from '../src/ui/sandbox_picker.js';

function sandbox(fixture = fixturePlan) {
  const data = fixture();
  data.plan = createPlanDocument({ dataset: data.dataset, trainerId: data.plan.game.trainerId,
    playerCombatants: data.players, enemyCombatants: data.enemies,
    battleFormat: data.plan.game.battleFormat, planningMode: 'sandbox', sourceSnapshot: data.plan.sourceSnapshot });
  return data;
}
const move = (actorKey, target) => ({actionType:'move',actorKey,moveId:'tackle',targetKeys:[target],mechanicActivations:[],declaredAtStateHash:'fixture'});
const commit = (plan, id, dataset) => {
  const state = plan.stateNodes[id];
  const actions = {player:move(activeKey(state,'player'),activeKey(state,'enemy')),enemy:move(activeKey(state,'enemy'),activeKey(state,'player'))};
  const preview = previewTurn({plan,parentStateNodeId:id,actions,dataset,damageAdapter:damageAdapter(()=>[1])});
  return commitPreview(plan,preview,dataset,{selectedPreviewOutcomeId:preview.defaultPreviewOutcomeId,commitSelectedOnly:true});
};

test('Sandbox sprite pickers list unadmitted records without mutations and retain slot ownership and branch HP', () => {
  const {plan,players,enemies}=sandbox(fixtureDoublesPlan);
  const state=plan.stateNodes[plan.initialStateNodeId];
  const reserve={...structuredClone(players[0]),combatantKey:'box:new'};
  const fainted={...structuredClone(players[0]),combatantKey:'box:fainted'};
  state.combatantStates[fainted.combatantKey]={...structuredClone(state.combatantStates[players[0].combatantKey]),hp:{min:0,max:0,maxHp:100}};
  const all=[...players,...enemies,reserve,fainted];
  const original=structuredClone(plan);
  const keys=options=>sandboxPickerCandidates(plan,state,'player',0,all,options).map(m=>m.combatantKey);
  const switches=keys();
  assert.ok(switches.includes(players[0].combatantKey));assert.ok(switches.includes(reserve.combatantKey));
  assert.ok(!switches.includes(players[1].combatantKey));assert.ok(!switches.includes(enemies[0].combatantKey));
  assert.ok(!switches.includes(fainted.combatantKey));assert.ok(keys({replace:true}).includes(fainted.combatantKey));
  assert.deepEqual(plan,original);
  plan.game.partyOwnership={player:{slotOwnerIds:['player','partner']}};
  reserve.source={...reserve.source,partyOwnerId:'player'};
  assert.ok(keys().includes(reserve.combatantKey));
  assert.equal(sandboxPickerCandidates(plan,state,'player',1,[reserve],{replace:true}).length,0);
});

test('Sandbox is explicit schema v6; ordinary plans retain their existing contract', () => {
  const ordinary = fixturePlan().plan;
  assert.equal(ordinary.schemaVersion,2); assert.equal(isSandbox(ordinary),false);
  assert.throws(()=>editSandboxCombatant(ordinary,ordinary.initialStateNodeId,'missing',{},null),/not a Sandbox/);
  const {plan} = sandbox(); assert.equal(plan.schemaVersion,6); assert.ok(isSandbox(plan));
  assertValidPlanDocument(plan);
  assert.throws(()=>assertValidPlanDocument({...plan,schemaVersion:5}),/Sandbox requires/);
  assert.throws(()=>assertValidPlanDocument({...plan,game:{...plan.game,planningMode:'unknown'}}),/Sandbox/);
});

for (const fixture of [fixturePlan,fixtureDoublesPlan,fixtureTriplePlan,fixtureRotationPlan]) test(`${fixture.name} Sandbox edits are transactional and normal-tree only`, () => {
  const {plan:original,dataset,players} = sandbox(fixture); const baseline=structuredClone(original);
  const edit=editSandboxCombatant(original,original.initialStateNodeId,players[0].combatantKey,{hp:17,status:'tox',statStages:{atk:2},moves:['tackle','protect']},dataset);
  assert.deepEqual(original,baseline);
  const state=edit.plan.stateNodes[edit.stateId]; assert.equal(state.turnNumber,0); assert.equal(state.freeCalc,undefined);
  assert.equal(state.combatantStates[players[0].combatantKey].hp.max,17);
  const twice=editSandboxCombatant(edit.plan,edit.stateId,players[0].combatantKey,{hp:18},dataset);
  assert.equal(twice.stateId,edit.stateId); assert.equal(Object.keys(twice.plan.manualTransitions).length,1);
  assert.equal(planTurnTreeOrder(twice.plan).length,1);
  assert.deepEqual(nodeTreeSections(twice.plan,planTurnTreeOrder(twice.plan)).map(s=>s.id),['planned']);
  const before=structuredClone(twice.plan);
  assert.throws(()=>editSandboxCombatant(twice.plan,twice.stateId,players[0].combatantKey,{hp:1,status:'invalid'},dataset),/Invalid/);
  assert.deepEqual(twice.plan,before);
});

test('Historical Sandbox edits branch without rewriting existing turns or consuming a turn',()=>{
  const {plan:original,dataset,players}=sandbox();
  const edited=editSandboxCombatant(original,original.initialStateNodeId,players[0].combatantKey,{hp:90},dataset);
  const committed=commit(edited.plan,edited.stateId,dataset);
  const oldOutcome=structuredClone(committed.plan.stateNodes[committed.cursorStateNodeId]);
  const fork=editSandboxCombatant(committed.plan,edited.stateId,players[0].combatantKey,{hp:70},dataset);
  assert.notEqual(fork.stateId,edited.stateId);
  assert.deepEqual(fork.plan.stateNodes[committed.cursorStateNodeId],oldOutcome);
  assert.equal(fork.plan.stateNodes[edited.stateId].combatantStates[players[0].combatantKey].hp.max,90);
  const branch=commit(fork.plan,fork.stateId,dataset);
  const turns=planTurnTreeOrder(branch.plan).filter(e=>e.kind==='committed');
  assert.equal(turns.length,2); assert.ok(turns.every(e=>e.turnNumber===1));
  assert.notEqual(turns[0].lane,turns[1].lane);
});

test('Direct placement preserves outgoing and returning HP/status/PP with no entry events',()=>{
  const {plan,dataset,players}=sandbox(); const key=players[0].combatantKey;
  const edited=editSandboxCombatant(plan,plan.initialStateNodeId,key,{hp:70,status:'par'},dataset);
  edited.plan.stateNodes[edited.stateId].combatantStates[key].movePp.tackle=3;
  const newcomer={...structuredClone(players[1]),combatantKey:'player:box:new',originalAbilityId:'intimidate'};
  const placed=placeSandboxCombatant(edited.plan,edited.stateId,'player',0,newcomer);
  assert.equal(placed.plan.stateNodes[placed.stateId].combatantStates[key].hp.max,70);
  assert.deepEqual(placed.plan.stateNodes[placed.stateId].resolutionEventIds,[]);
  const back=placeSandboxCombatant(placed.plan,placed.stateId,'player',0,players[0]);
  const restored=back.plan.stateNodes[back.stateId].combatantStates[key];
  assert.equal(restored.hp.max,70);assert.equal(restored.majorStatus,'par');assert.equal(restored.movePp.tackle,3);
  assert.equal(Object.keys(back.plan.combatants).length,Object.keys(plan.combatants).length+1);
  assert.equal(plan.combatants[newcomer.combatantKey],undefined);
});

test('Box admission does not switch; an ordinary subsequent Switch resolves entry hazards',()=>{
  const {plan,dataset,players,enemies}=sandbox();
  const newcomer={...structuredClone(players[1]),combatantKey:'player:box:new'};
  const added=admitSandboxReserve(plan,plan.initialStateNodeId,'player',0,newcomer);
  const state=added.plan.stateNodes[added.stateId];
  assert.equal(activeKey(state,'player'),players[0].combatantKey);
  state.fieldState.sides.player.hazards.spikes=1;
  const actions={player:{actionType:'switch',actorKey:players[0].combatantKey,switchToKey:newcomer.combatantKey},enemy:move(enemies[0].combatantKey,players[0].combatantKey)};
  const preview=previewTurn({plan:added.plan,parentStateNodeId:added.stateId,actions,dataset,damageAdapter:damageAdapter(()=>[1])});
  const done=commitPreview(added.plan,preview,dataset,{selectedPreviewOutcomeId:preview.defaultPreviewOutcomeId,commitSelectedOnly:true});
  const end=done.plan.stateNodes[done.cursorStateNodeId];
  assert.equal(activeKey(end,'player'),newcomer.combatantKey);
  assert.ok(end.combatantStates[newcomer.combatantKey].hp.max < newcomer.calculatedStats.hp-1);
  assert.ok(end.resolutionEventIds.some(id=>done.plan.resolutionEvents[id].eventType==='switch'));
});

test('Enemy choices and partner-owned slots remain bounded, with other active slots excluded',()=>{
  const {plan,players,enemies}=sandbox(fixtureDoublesPlan);
  plan.game.partyOwnership={player:{policy:'per-trainer',slotOwnerIds:['player','ally']},enemy:{policy:'per-trainer',slotOwnerIds:['a','b']}};
  players.forEach((mon,i)=>plan.combatants[mon.combatantKey].source.partyOwnerId=i%2?'ally':'player');
  enemies.forEach((mon,i)=>plan.combatants[mon.combatantKey].source.partyOwnerId=i%2?'b':'a');
  assert.throws(()=>placeSandboxCombatant(plan,plan.initialStateNodeId,'enemy',0,plan.combatants[enemies[3].combatantKey]),/different trainer/);
  assert.throws(()=>placeSandboxCombatant(plan,plan.initialStateNodeId,'enemy',0,{...plan.combatants[enemies[0].combatantKey],combatantKey:'enemy:new'}),/party/);
  assert.throws(()=>admitSandboxReserve(plan,plan.initialStateNodeId,'player',1,{...players[2],combatantKey:'player:new',source:{partyOwnerId:'player'}}),/Only player/);
  const normal=sandbox(fixtureDoublesPlan);
  assert.throws(()=>placeSandboxCombatant(normal.plan,normal.plan.initialStateNodeId,'player',0,normal.players[1]),/another slot/);
});

test('Fainted and terminal Sandbox states can be edited without losing required replacements',()=>{
  const {plan,dataset,players}=sandbox(fixtureDoublesPlan);
  const first=editSandboxCombatant(plan,plan.initialStateNodeId,players[0].combatantKey,{hp:0},dataset);
  const second=editSandboxCombatant(first.plan,first.stateId,players[1].combatantKey,{hp:0},dataset);
  assert.equal(second.plan.stateNodes[second.stateId].pendingReplacementSlots.length,2);
  const restored=placeSandboxCombatant(second.plan,second.stateId,'player',0,players[2]);
  assert.deepEqual(restored.plan.stateNodes[restored.stateId].pendingReplacementSlots,[{side:'player',slot:1}]);
  let dead=restored;
  for(const player of players) dead=editSandboxCombatant(dead.plan,dead.stateId,player.combatantKey,{hp:0},dataset);
  assert.equal(dead.plan.stateNodes[dead.stateId].battleEnded,true);
  const alive=editSandboxCombatant(dead.plan,dead.stateId,players[2].combatantKey,{hp:10},dataset);
  assert.equal(alive.plan.stateNodes[alive.stateId].battleEnded,false);
});

test('Sandbox mode and edited state round-trip through drafts, export, import and recalculation',async()=>{
  const {plan,dataset,players}=sandbox();
  const edited=editSandboxCombatant(plan,plan.initialStateNodeId,players[0].combatantKey,{hp:70,level:55,moves:['tackle','recover']},dataset);
  const done=commit(edited.plan,edited.stateId,dataset);
  const exported=exportSelectedPlan(done.plan,[done.cursorStateNodeId]).plan;
  const parsed=parsePlan(serializePlan(exported));assert.ok(isSandbox(parsed));
  assert.ok(isSandbox(savedDraftSnapshot(parsed).document));
  const cached=createDraftRecord(parsed,parsed.initialStateNodeId);assert.ok(JSON.stringify(cached).includes('sandbox'));
  const replay=await recalculatePlanDocument(parsed,{dataset,previewTurnFn:request=>previewTurn({...request,dataset,damageAdapter:damageAdapter(()=>[1])})});
  assert.ok(isSandbox(replay));assert.equal(replay.schemaVersion,6);
  const manual=Object.values(replay.stateNodes).find(s=>s.parentManualTransitionId);
  assert.equal(manual.combatantStates[players[0].combatantKey].hp.max,70);
  assert.equal(manual.combatantStates[players[0].combatantKey].currentLevel,55);
  assert.equal(Object.keys(replay.actionGroups).length,1);
});

test('Sandbox EXP progression cannot modify Box records, even through the non-UI API',()=>{
  const {plan}=sandbox();
  assert.deepEqual(branchProgressionSnapshot(plan,plan.initialStateNodeId),[]);
  assert.throws(()=>applyBranchProgressionToLibrary({},plan,plan.initialStateNodeId),/cannot be saved/);
});
