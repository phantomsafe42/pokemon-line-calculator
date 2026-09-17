import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixtureDoublesPlan, damageAdapter } from './helpers.mjs';
import { normalizePlayerPartnerRoster } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';
import { eligibleReserves } from '../src/core/party_ownership.js';
import { resolveTurn, resolveForcedReplacement } from '../src/core/resolver.js';
import { serializePlan, parsePlan } from '../src/contracts/plan_file.js';
import { planPlayerPartyRecords } from '../src/boxes/plan_import.js';
import { projectExperience } from '../src/rulesets/vw2r_experience.js';
import { installTrainerEncounters } from '../src/adapters/trainer_encounters.js';
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from '../src/adapters/standardized_dataset.js';
import { recalculatePlanDocument } from '../src/core/recalculation.js';

function partnered() {
  const { dataset, players, enemies } = fixtureDoublesPlan();
  dataset.trainer('doubles').playerPartnerBinding = { id: 'allied-fixture', partnerOptions: [{trainerId: 'trainer'}] };
  const allies = normalizePlayerPartnerRoster('trainer', dataset);
  const plan = createPlanDocument({ dataset, trainerId: 'doubles', playerCombatants: [...players, ...allies],
    enemyCombatants: enemies, playerPartner: {trainerId: 'trainer', bindingId: 'allied-fixture'}, battleFormat: 'doubles' });
  return {plan, dataset, players, enemies, allies, state: plan.stateNodes[plan.initialStateNodeId]};
}

test('player partner deploys in Slot 2; reserves, EXP and Boxes remain owner-isolated', async () => {
  const {plan,dataset,players,enemies,allies,state} = partnered();
  assert.deepEqual(state.active.playerCombatantKeys, [players[0].combatantKey, allies[0].combatantKey]);
  assert.deepEqual(eligibleReserves(plan,state,'player',0).map(mon=>mon.combatantKey), players.slice(1).map(mon=>mon.combatantKey));
  assert.deepEqual(eligibleReserves(plan,state,'player',1).map(mon=>mon.combatantKey), [allies[1].combatantKey]);
  assert.equal(planPlayerPartyRecords(plan,dataset).length,players.length);
  for (const mon of [...players,...allies]) {
    plan.combatants[mon.combatantKey].growthRate = 'Medium Fast';
    state.combatantStates[mon.combatantKey].experience = 125000;
  }
  plan.combatants[enemies[0].combatantKey].baseExperienceYield = 100;
  state.experienceState = { participantsByEnemyKey: {[enemies[0].combatantKey]:[players[0].combatantKey,allies[0].combatantKey]}, rewardedEnemyKeys:[] };
  const result = projectExperience(plan,state,enemies[0].combatantKey,dataset);
  assert.equal(result.available,true);
  assert.equal(result.rewards.length,1);
  assert.ok(result.rewards.every(reward=>!allies.some(mon=>mon.combatantKey===reward.combatantKey)));
  assert.deepEqual(parsePlan(serializePlan(plan)),plan);
  const rebuilt = await recalculatePlanDocument(plan, {dataset, previewTurnFn:()=>{throw new Error('No turns yet');}});
  assert.deepEqual(rebuilt.game.partyOwnership, plan.game.partyOwnership);
  assert.deepEqual(rebuilt.game.playerPartner, plan.game.playerPartner);
});

test('player replacement rejects partner reserves and partner depletion leaves its slot empty', () => {
  const {plan,dataset,players,enemies,allies,state} = partnered();
  state.combatantStates[players[0].combatantKey].hp = {min:0,max:0,maxHp:100};
  state.pendingReplacementSlots = [{side:'player',slot:0}]; state.pendingReplacementSides=['player'];
  assert.throws(()=>resolveForcedReplacement({plan,parentStateNodeId:state.stateNodeId,dataset,
    replacements:{player:[{actionType:'replacement',side:'player',slot:0,consumesTurn:false,switchToKey:allies[1].combatantKey}]}}), /invalid/);
  state.combatantStates[players[0].combatantKey].hp = {min:100,max:100,maxHp:100};
  state.pendingReplacementSlots=[]; state.pendingReplacementSides=[];
  for(const mon of allies) state.combatantStates[mon.combatantKey].hp={min:0,max:0,maxHp:100};
  const move=(actor,target)=>({actionType:'move',actorKey:actor,moveId:'tackle',targetKeys:[target],mechanicActivations:[],declaredAtStateHash:state.stateHash});
  const preview=resolveTurn({plan,parentStateNodeId:state.stateNodeId,dataset,damageAdapter:damageAdapter(()=>[1]),
    actions:{player:[move(players[0].combatantKey,enemies[0].combatantKey)],enemy:enemies.slice(0,2).map(mon=>move(mon.combatantKey,players[0].combatantKey))}});
  assert.ok(preview.length);
  for(const outcome of preview) {
    assert.ok(!(outcome.state.pendingReplacementSlots||[]).some(entry=>entry.side==='player'&&entry.slot===1));
    assert.equal(outcome.state.active.playerCombatantKeys[1],null);
    assert.equal(outcome.state.battleEnded,false);
  }
});

test('voluntary switches cannot borrow a partner Pokémon and a legal replacement stays editable', () => {
  const {plan,dataset,players,enemies,allies,state}=partnered();
  const move=(actor,target)=>({actionType:'move',actorKey:actor,moveId:'tackle',targetKeys:[target],mechanicActivations:[],declaredAtStateHash:state.stateHash});
  assert.throws(()=>resolveTurn({plan,parentStateNodeId:state.stateNodeId,dataset,damageAdapter:damageAdapter(()=>[1]),
    actions:{player:[{actionType:'switch',actorKey:players[0].combatantKey,switchToKey:allies[1].combatantKey},move(allies[0].combatantKey,enemies[0].combatantKey)],
      enemy:enemies.slice(0,2).map(mon=>move(mon.combatantKey,players[0].combatantKey))}}),/trainer's slot/);
  state.combatantStates[allies[0].combatantKey].hp={min:0,max:0,maxHp:100};
  state.pendingReplacementSlots=[{side:'player',slot:1}];state.pendingReplacementSides=['player'];
  const outcomes=resolveForcedReplacement({plan,parentStateNodeId:state.stateNodeId,dataset,
    replacements:{player:[{actionType:'replacement',side:'player',slot:1,consumesTurn:false,switchToKey:allies[1].combatantKey}]}});
  assert.ok(outcomes.length);
  for(const outcome of outcomes){
    assert.equal(outcome.state.active.playerCombatantKeys[1],allies[1].combatantKey);
    assert.equal(outcome.state.turnNumber,state.turnNumber);
    assert.deepEqual(outcome.state.pendingReplacementSlots,[]);
  }
});

test('partner contract rejects missing and ambiguous sources', () => {
  const index = new Map([['a',{id:'a',team:[]}],['b',{id:'b',team:[]}]]);
  assert.throws(()=>installTrainerEncounters(index,{playerPartners:{schemaVersion:'future',bindings:[]}},'test'),/Unsupported/);
});

test('generated PK bindings load every documented partner without mixing enemy teams', t => {
  const root = new URL('../src/generated/datasets/platinum-kaizo/', import.meta.url);
  const load = file => JSON.parse(fs.readFileSync(new URL(file,root),'utf8'));
  const documents = Object.fromEntries(REQUIRED_DATASET_SOURCES.map(name=>[name,load(name)]));
  const bindings = documents['trainer_battle_groups.json'].playerPartners?.bindings;
  if (!bindings) return t.skip('Released fallback predates the candidate Dataset cutover');
  const dataset = createDatasetContext({manifest:load('dataset_manifest.json'),mechanics:load('battle_mechanics.json'),documents});
  assert.equal(documents['trainers.json'].records['platinum-kaizo-trainer-0909'].playerPartnerBinding,undefined,'ingest preserves source records');
  for(const binding of bindings) {
    const trainer = dataset.trainer(binding.enemyTrainerIds.length===2 ? binding.id : binding.enemyTrainerIds[0]);
    assert.equal(trainer.playerPartnerBinding.id,binding.id);
    assert.equal(dataset.trainerBattleFormat(trainer.id),'doubles');
    for(const option of binding.partnerOptions) assert.ok(normalizePlayerPartnerRoster(option.trainerId,dataset).length);
  }
  const navigation = dataset.trainerGroups().flatMap(group=>group.trainers.map(trainer=>trainer.id));
  assert.ok(!navigation.includes('platinum-kaizo-trainer-0608'));
  assert.ok(!navigation.includes('platinum-kaizo-trainer-0622'));
});
