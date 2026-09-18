import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from '../src/adapters/standardized_dataset.js';
import { starterAllows, validateStarterSelection } from '../src/adapters/starter_selection.js';
import { readStarterPreference, saveStarterPreference } from '../src/cache/starter_preferences.js';

const read = (game, file) => JSON.parse(fs.readFileSync(new URL(`../src/generated/datasets/${game}/${file}`, import.meta.url)));
function context(game) {
  return createDatasetContext({ manifest: read(game, 'dataset_manifest.json'), mechanics: read(game, 'battle_mechanics.json'),
    documents: Object.fromEntries([...REQUIRED_DATASET_SOURCES, 'starter_selection.json'].map(f => [f, read(game, f)])) });
}
test('all twenty games filter mapped routes and preserve unmapped trainers without mutating data', () => {
  const games = fs.readdirSync(new URL('../src/generated/datasets/', import.meta.url)).filter(g => g !== 'radical-red');
  assert.equal(games.length, 20);
  for (const game of games) {
    const data = context(game);
    const before = JSON.stringify([...data.indexes.trainers]);
    const doc = data.starterSelection;
    for (const choice of doc.choices) {
      const groups = data.trainerGroups(choice.id);
      for (const trainer of groups.flatMap(g => g.trainers)) assert.ok(starterAllows(doc, choice.id, trainer.id), `${game}:${choice.id}:${trainer.id}`);
      for (const binding of doc.trainerBindings) assert.ok(data.trainer(binding.trainerId), 'full lookup remains usable for imported plans');
    }
    assert.equal(JSON.stringify([...data.indexes.trainers]), before);
  }
});
test('RP and PK alternate rivals stay in their split instead of disappearing or falling into Other', () => {
  for (const [game, starter, expected] of [
    ['renegade-platinum', 'chimchar', 'renegade-platinum-trainer-0852'],
    ['platinum-kaizo', 'piplup', 'platinum-kaizo-trainer-0907']
  ]) {
    const data = context(game);
    const groups = data.trainerGroups(starter);
    assert.ok(groups.find(g => g.id === 'roark').trainers.some(t => t.id === expected));
    assert.equal(groups.filter(g => g.id === 'other').some(g => g.trainers.some(t => t.id === expected)), false);
  }
});
test('starter preferences persist per game, reject invalid choices, and write no Box or draft keys', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const vw = context('volt-white-2r').starterSelection;
  const fro = context('fire-red-omega').starterSelection;
  assert.equal(readStarterPreference(storage, 'volt-white-2r', vw), null);
  saveStarterPreference(storage, 'volt-white-2r', vw, 'snivy');
  saveStarterPreference(storage, 'fire-red-omega', fro, 'magby');
  assert.equal(readStarterPreference(storage, 'volt-white-2r', vw), 'snivy');
  assert.equal(readStarterPreference(storage, 'fire-red-omega', fro), 'magby');
  assert.throws(() => saveStarterPreference(storage, 'fire-red-omega', fro, 'snivy'));
  assert.equal(values.size, 2);
  assert.ok([...values.keys()].every(k => k.startsWith('plc-starter-v1:')));
  values.set('plc-starter-v1:volt-white-2r', 'stale-id');
  assert.equal(readStarterPreference(storage, 'volt-white-2r', vw), null);
});
test('invalid contract fails closed; unknown choice never silently chooses a route', () => {
  const data = context('volt-white-2r');
  assert.deepEqual(data.trainerGroups('invalid'), data.trainerGroups());
  const bad = structuredClone(data.starterSelection);
  bad.trainerBindings[0].starterIds = ['not-a-choice'];
  assert.throws(() => validateStarterSelection(bad, data.gameId, data.indexes.trainers, data.indexes.species));
});
test('partner choices filter starter only, preserving exact ROM and gender alternatives', () => {
  const data = context('volt-white-2r');
  const eligible = data.trainer('vw2r-trainer-0097').playerPartnerBinding.partnerOptions
    .filter(o => starterAllows(data.starterSelection, 'snivy', o.trainerId, o.trainerVariantId));
  assert.ok(eligible.length >= 1);
  assert.ok(eligible.every(o => o.trainerId === 'vw2r-trainer-0099'));
  const unbound = context('pokemon-unbound');
  const variants = unbound.trainer('pokemon-unbound-trainer-0465').mechanicsVariants;
  assert.equal(variants.filter(v => starterAllows(unbound.starterSelection, 'gible', 'pokemon-unbound-trainer-0465', v.id)).length, 1);
});

test('all games retain valid ally choices for each starter without altering trainer lookup', () => {
  const games = fs.readdirSync(new URL('../src/generated/datasets/', import.meta.url)).filter(g => g !== 'radical-red');
  for (const game of games) {
    const data = context(game);
    const groups = read(game, 'trainer_battle_groups.json').playerPartners?.bindings || [];
    for (const group of groups) for (const starter of data.starterSelection.choices) {
      const eligible = group.partnerOptions.filter(o => starterAllows(data.starterSelection, starter.id, o.trainerId, o.trainerVariantId));
      assert.ok(eligible.length, `${game}:${group.id}:${starter.id}`);
      for (const option of group.partnerOptions) assert.ok(data.trainer(option.trainerId), 'imports retain unfiltered lookup');
    }
  }
});

test('assistant and ally selection respects retail, hack and protagonist identity boundaries', () => {
  for (const [game, enemy, starter, expected] of [
    ['pokemon-diamond',414,'chimchar',[613,616]],
    ['pokemon-pearl',848,'turtwig',[621,624]],
    ['pokemon-platinum',414,'piplup',[614,617]],
    ['platinum-kaizo',414,'chimchar',[613,616]],
    ['renegade-platinum',414,'turtwig',[618,615]],
    ['pokemon-heartgold',733,'totodile',[735]],
    ['pokemon-soulsilver',733,'cyndaquil',[737]],
    ['pokemon-black',62,'snivy',[56]],
    ['pokemon-white',401,'tepig',[91]]
  ]) {
    const data = context(game), id = n => `${game}-trainer-${String(n).padStart(4,'0')}`;
    const options = data.trainer(id(enemy)).playerPartnerBinding.partnerOptions;
    const eligible = options.filter(o => starterAllows(data.starterSelection, starter, o.trainerId, o.trainerVariantId));
    assert.deepEqual(eligible.map(o => o.trainerId).sort(), expected.map(id).sort(), `${game}:${starter}`);
  }
  for (const game of ['pokemon-black-2','pokemon-white-2']) {
    const data = context(game), id = n => `${game}-trainer-${String(n).padStart(4,'0')}`;
    const groups = read(game,'trainer_battle_groups.json').playerPartners.bindings;
    for (const [suffix, starter, expected] of [['nimbasa-subway-bosses','snivy',[360,363]],
      ['plasma-frigate-north-entrance','tepig',[795]],['plasma-frigate-command-center','oshawott',[796]]]) {
      const options = groups.find(g => g.id.endsWith(suffix)).partnerOptions;
      assert.deepEqual(options.filter(o => starterAllows(data.starterSelection,starter,o.trainerId,o.trainerVariantId)).map(o=>o.trainerId).sort(),expected.map(id).sort());
    }
  }
});
