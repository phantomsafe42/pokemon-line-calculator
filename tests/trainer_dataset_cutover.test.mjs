import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from '../src/adapters/standardized_dataset.js';

function load(game) {
  const read = file => JSON.parse(fs.readFileSync(new URL(`../src/generated/datasets/${game}/${file}`, import.meta.url)));
  const documents = Object.fromEntries([...REQUIRED_DATASET_SOURCES, 'starter_selection.json'].map(file => [file, read(file)]));
  return { documents, dataset: createDatasetContext({manifest:read('dataset_manifest.json'),mechanics:read('battle_mechanics.json'),documents}) };
}

test('HGSS trainer labels use source display names without leaking raw class identifiers', () => {
  for (const game of ['pokemon-heartgold', 'pokemon-soulsilver']) {
    const {dataset, documents} = load(game);
    assert.equal(dataset.trainer(`${game}-trainer-0012`).displayName, 'Team Rocket Grunt');
    assert.equal(dataset.trainer(`${game}-trainer-0133`).displayName, 'PokéManiac Morgan');
    assert.equal(dataset.trainer(`${game}-trainer-0165`).displayName, 'Swimmer ♀ Mickey');
    for (const trainer of Object.values(documents['trainers.json'].records)) {
      assert.doesNotMatch(trainer.displayName, /Trainerclass_/iu);
    }
  }
});

test('Unbound confirmed Doubles remain locked while retaining their source trainer identity', () => {
  const {dataset, documents} = load('pokemon-unbound');
  const confirmed = Object.values(documents['trainers.json'].records)
    .filter(trainer => trainer.battleFormatEvidence?.kind === 'user-confirmed-double-battle');
  assert.ok(confirmed.length >= 21);
  for (const trainer of confirmed) {
    const choices = dataset.trainerBattleChoices(trainer.id);
    assert.ok(choices.length > 0, trainer.id);
    assert.ok(choices.every(choice => choice.format === 'doubles' && choice.locked), trainer.id);
    assert.equal(dataset.trainer(trainer.id).id, trainer.id);
  }
  const ordinary = dataset.trainer('pokemon-unbound-trainer-0001');
  assert.equal(ordinary.displayName, 'Swimmer Harold');
  assert.match(ordinary.sourceDisplayName, /Auburn Waterway/u);
  assert.equal(dataset.trainerBattleChoices(ordinary.id)[0].format, 'singles');
  const multi = dataset.trainer('pokemon-unbound-occurrence-0448');
  assert.ok(multi.encounter);
  assert.equal(multi.encounter.enemyTrainerIds.length, 2);
});
