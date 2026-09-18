import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixtureDoublesPlan, damageAdapter } from './helpers.mjs';
import { normalizePlayerPartnerRoster, normalizeTrainerRoster } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';
import { eligibleReserves } from '../src/core/party_ownership.js';
import { resolveTurn, resolveForcedReplacement } from '../src/core/resolver.js';
import { serializePlan, parsePlan } from '../src/contracts/plan_file.js';
import { planPlayerPartyRecords } from '../src/boxes/plan_import.js';
import { projectExperience } from '../src/rulesets/vw2r_experience.js';
import { installTrainerEncounters } from '../src/adapters/trainer_encounters.js';
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from '../src/adapters/standardized_dataset.js';
import { recalculatePlanDocument } from '../src/core/recalculation.js';
import { validatePlanReferences } from '../src/contracts/plan_compatibility.js';

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

function realDataset(gameId) {
  const root = new URL(`../src/generated/datasets/${gameId}/`, import.meta.url);
  const load = file => JSON.parse(fs.readFileSync(new URL(file,root),'utf8'));
  const documents = Object.fromEntries(REQUIRED_DATASET_SOURCES.map(name=>[name,load(name)]));
  return {documents, dataset:createDatasetContext({manifest:load('dataset_manifest.json'),mechanics:load('battle_mechanics.json'),documents})};
}

for (const [gameId,count] of [['renegade-platinum',24],['storm-silver',6],['volt-white-2r',10],
  ['pokemon-emerald',1],['pokemon-diamond',30],['pokemon-pearl',30],['pokemon-platinum',31],
  ['pokemon-heartgold',2],['pokemon-soulsilver',2],['pokemon-black',1],['pokemon-white',1],['pokemon-black-2',16],['pokemon-white-2',16]]) {
  test(`${gameId}: all documented partners normalize, deploy and round-trip with exact ownership`, () => {
    const {dataset,documents} = realDataset(gameId);
    const bindings = documents['trainer_battle_groups.json'].playerPartners.bindings;
    assert.equal(bindings.length,count);
    for (const binding of bindings) {
      const enemies = normalizeTrainerRoster(binding.id,null,dataset);
      const choices = dataset.trainerBattleChoices(binding.choiceFamilyId ? binding.id : binding.enemyTrainerIds[0]);
      if (binding.formatChoice === 'single-or-double') {
        assert.equal(choices[0].format,'singles');
        assert.equal(choices[0].withoutPlayerPartner,true);
        assert.ok(choices.some(choice=>choice.trainerId===binding.id && !choice.withoutPlayerPartner));
        assert.equal(choices.some(choice=>choice.id===`unallied:${binding.id}`),binding.allowWithoutPartner);
      } else assert.equal(choices[0].trainerId,binding.id);
      for (const option of binding.partnerOptions) {
        const allies = normalizePlayerPartnerRoster(option.trainerId,dataset,option.trainerVariantId || null);
        // Synthetic user-owned lead from the same normalized species avoids
        // injecting cross-generation fixtures into game-specific mechanics.
        const own = structuredClone(allies[0]);
        own.combatantKey='player:owned'; own.source={kind:'test-player'};
        const playerPartner={trainerId:option.trainerId,trainerVariantId:option.trainerVariantId || null,bindingId:binding.id};
        const plan = createPlanDocument({dataset,trainerId:binding.id,playerCombatants:[own,...allies],enemyCombatants:enemies,battleFormat:'doubles',playerPartner});
        const state=plan.stateNodes[plan.initialStateNodeId];
        assert.deepEqual(state.active.playerCombatantKeys,[own.combatantKey,allies[0].combatantKey]);
        assert.deepEqual(plan.game.partyOwnership.enemy.slotOwnerIds,binding.enemyTrainerIds);
        assert.deepEqual(eligibleReserves(plan,state,'player',0),[]);
        assert.ok(eligibleReserves(plan,state,'player',1).every(mon=>mon.source.partyOwnerId===option.trainerId));
        assert.deepEqual(parsePlan(serializePlan(plan)).game.playerPartner,playerPartner);
        assert.equal(validatePlanReferences(plan,dataset).valid,true);
        if(option.trainerVariantId) assert.ok(allies.every(mon=>mon.source.trainerVariantId===option.trainerVariantId));
      }
    }
  });
}

test('retail choices preserve exact partners, source records and ordinary trainer battles', () => {
  for (const game of ['pokemon-black-2','pokemon-white-2']) {
    const {dataset,documents}=realDataset(game);
    const nav=dataset.trainerGroups().flatMap(group=>group.trainers);
    const choices=nav.filter(trainer=>trainer.encounter?.choiceFamilyId===`${game}-striaton-restaurant-brothers`);
    assert.equal(choices.length,3);
    const all=new Set([494,495,496].map(n=>`${game}-trainer-0${n}`));
    for(const choice of choices) {
      const binding=choice.playerPartnerBinding;
      assert.equal(binding.partnerOptions.length,1);
      assert.deepEqual(new Set([...binding.enemyTrainerIds,binding.partnerOptions[0].trainerId]),all);
      assert.ok(!binding.enemyTrainerIds.includes(binding.partnerOptions[0].trainerId));
    }
    assert.equal(dataset.trainer(`${game}-trainer-0494`).playerPartnerBinding,undefined);
    assert.equal(dataset.trainer(`${game}-giant-chasm-plasma-pair`),null);
    assert.ok(documents['trainer_battle_groups.json'].playerPartners.validation.excludedEvidenceConflicts.length);
    assert.equal(dataset.trainer(`${game}-nimbasa-subway-bosses`).playerPartnerBinding.partnerOptions.length,6);
    assert.equal(dataset.trainer(`${game}-trainer-0648`).playerPartnerBinding,undefined,'outside Cheren escort segment');
  }
  for(const game of ['pokemon-diamond','pokemon-pearl','pokemon-platinum']) {
    const {dataset}=realDataset(game);
    assert.equal(dataset.trainer(`${game}-trainer-0390`).playerPartnerBinding,undefined,'Marley cannot cross Surf');
    assert.equal(dataset.trainer(`${game}-trainer-0503`).playerPartnerBinding,undefined,'Riley is not on the other Iron Island floor');
    assert.equal(dataset.trainerBattleChoices(`${game}-trainer-0201`)[0].format,'doubles','Jack/Briana is mandatory Multi');
    assert.equal(dataset.trainerBattleChoices(`${game}-trainer-0206`)[0].format,'singles','Lindsey/Elijah has a Singles option');
  }
  for(const game of ['pokemon-black','pokemon-white']) {
    const {dataset}=realDataset(game);
    assert.ok(dataset.trainerGroups().flatMap(g=>g.trainers).some(t=>t.id===`${game}-trainer-0056`),'Cheren opponent remains available');
  }
});

test('Emerald enforces the selected three without discarding user party records', () => {
  const {dataset}=realDataset('pokemon-emerald');
  const trainerId='pokemon-emerald-mossdeep-space-center-maxie-tabitha';
  const binding=dataset.trainer(trainerId).playerPartnerBinding;
  const option=binding.partnerOptions[0];
  const allies=normalizePlayerPartnerRoster(option.trainerId,dataset);
  assert.equal(allies.length,3);
  const owned=Array.from({length:4},(_,i)=>({...structuredClone(allies[0]),combatantKey:`player:owned${i}`,source:{kind:'test-player'}}));
  assert.throws(()=>createPlanDocument({dataset,trainerId,playerCombatants:[...owned,...allies],
    enemyCombatants:normalizeTrainerRoster(trainerId,null,dataset),battleFormat:'doubles',
    playerPartner:{trainerId:option.trainerId,bindingId:binding.id}}),/at most 3/);
});

test('Drayano partners never hide separately documented opponent appearances or spread by location', () => {
  const {dataset:rp}=realDataset('renegade-platinum');
  const rpNavigation=rp.trainerGroups().flatMap(group=>group.trainers.map(trainer=>trainer.id));
  for(const id of [1064,1065,974,471,472,470]) assert.ok(rpNavigation.includes(`renegade-platinum-trainer-${String(id).padStart(4,'0')}`),`Opponent ${id} retained`);
  assert.equal(rp.trainer('renegade-platinum-trainer-0390').playerPartnerBinding,undefined,'ordinary Victory Road pair has no Marley');
  const {dataset:vw}=realDataset('volt-white-2r');
  for(const id of [95,96,225,330,331,360,361]) assert.equal(vw.trainer(`vw2r-trainer-${String(id).padStart(4,'0')}`).playerPartnerBinding,undefined);
  const subway=vw.trainer('nimbasa-subway-bosses-tag').playerPartnerBinding;
  assert.equal(subway.partnerOptions.length,6);
  assert.throws(()=>normalizePlayerPartnerRoster('vw2r-trainer-0099',vw),/variant/i);
  assert.equal(realDataset('fire-red-omega').documents['trainer_battle_groups.json'].playerPartners,undefined);
});
