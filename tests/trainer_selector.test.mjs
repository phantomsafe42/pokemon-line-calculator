import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixtureTriplePlan } from './helpers.mjs';
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from '../src/adapters/standardized_dataset.js';
import { triplePositionForSlot } from '../src/rulesets/triple_battle.js';
import { displayTrainerName, trainerDisplayBlocks, trainerRequirement, trainerSpriteQuery } from '../src/ui/trainer_selector.js';

function load(game) {
  const read = name => JSON.parse(fs.readFileSync(new URL(`../src/generated/datasets/${game}/${name}`, import.meta.url)));
  return createDatasetContext({ manifest: read('dataset_manifest.json'), mechanics: read('battle_mechanics.json'), documents: Object.fromEntries([...REQUIRED_DATASET_SOURCES, 'starter_selection.json'].map(name => [name, read(name)])) });
}

test('selector Triple labels match the actual plan opening without changing the roster', () => {
  const { dataset, enemies, plan } = fixtureTriplePlan();
  const trainer = dataset.trainer('doubles'), before = structuredClone(trainer);
  const [block] = trainerDisplayBlocks({ ...dataset, trainerBattleFormat: () => 'triples' }, trainer);
  const state = plan.stateNodes[plan.initialStateNodeId];
  for (const [slot, key] of state.active.enemyCombatantKeys.entries()) {
    const sourceIndex = enemies.findIndex(enemy => enemy.combatantKey === key);
    const entry = block.entries.find(entry => entry.sourceIndex === sourceIndex);
    assert.equal(entry.slot, 4 + triplePositionForSlot('triples', 'enemy', slot));
  }
  assert.deepEqual(trainer, before);
  assert.deepEqual(block.entries.slice(0, 3).map(entry => [entry.sourceIndex, entry.slot, entry.side]), [[2,4,'Left'],[1,5,'Center'],[0,6,'Right']]);
  assert.ok(block.entries.slice(3).every(entry => entry.slot === null));
});

test('PK paired encounter stays one choice with owner-specific teams, required flags, and leads', () => {
  const dataset = load('platinum-kaizo');
  const group = dataset.trainerGroups('chimchar').find(group => group.id === 'maylene');
  const trainer = group.trainers.find(trainer => trainer.id === 'platinum-kaizo-veilstone-tag-battle');
  assert.ok(trainer);
  const before = structuredClone(trainer);
  const blocks = trainerDisplayBlocks(dataset, trainer);
  assert.deepEqual(blocks.map(block => [block.trainer.id, block.entries.length, block.entries[0].slot]), [['platinum-kaizo-trainer-0848',6,3],['platinum-kaizo-trainer-0918',5,4]]);
  assert.deepEqual(blocks.map(block => block.entries[0].member.speciesId), ['abomasnow','clefable']);
  assert.deepEqual(trainer, before);
  assert.equal(trainerRequirement(dataset, trainer, 'maylene'), 'required');
  const requiredIds = group.trainers.slice(group.trainers.indexOf(trainer), group.trainers.indexOf(trainer) + 3).map(trainer => trainer.id);
  assert.deepEqual(requiredIds, [trainer.id, 'platinum-kaizo-trainer-0309', 'platinum-kaizo-trainer-0310']);
});

test('Elesa renders opening slots left to right while retaining canonical party order', () => {
  const dataset = load('volt-white-2r'), trainer = dataset.trainer('vw2r-trainer-0122');
  const before = structuredClone(trainer.team);
  const [block] = trainerDisplayBlocks(dataset, trainer);
  assert.deepEqual(block.entries.slice(0,3).map(entry => [entry.member.speciesId,entry.slot]), [['electivire',4],['lanturn',5],['emolga',6]]);
  assert.deepEqual(trainer.team,before);
});

test('names and art remain display-only; unresolved selectors and unknown mandatory flags stay explicit', () => {
  assert.equal(displayTrainerName('Galactic Uranus #2 & Galactic Cupid #1'), 'Galactic Uranus & Galactic Cupid');
  const identity = { status:'resolved', gameStyle:'platinum', presentation:'battle-front', subjectKind:'class',subjectId:'galactic-grunt',gender:'female',variant:'default' };
  assert.equal(trainerSpriteQuery({trainerVisualIdentity:identity}).subject,'galactic-grunt');
  assert.equal(trainerSpriteQuery({trainerVisualIdentity:{...identity,spriteSet:'b2w2'}}).spriteSet,'b2w2');
  assert.equal(trainerSpriteQuery({trainerVisualIdentity:{...identity,status:'ambiguous'}}), null);
  const dataset = { documents: {'trainer_order.json':{records:[{trainerId:'a',splitId:'s',mandatory:false},{trainerId:'a',splitId:'t',mandatory:true}]}}};
  assert.equal(trainerRequirement(dataset,{id:'a'},'s'),'optional');
  assert.equal(trainerRequirement(dataset,{id:'a'},'t'),'required');
  assert.equal(trainerRequirement(dataset,{id:'missing'},'s'),'unknown');
});
