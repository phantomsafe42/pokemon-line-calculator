import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixtureTriplePlan } from './helpers.mjs';
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from '../src/adapters/standardized_dataset.js';
import { triplePositionForSlot } from '../src/rulesets/triple_battle.js';
import { displayTrainerName, trainerDisplayBlocks, trainerRequirement, trainerSpriteQuery, trainerSplitBadgeQuery, trainerSearchIndex, searchTrainerIndex, trainerPortraitFallback } from '../src/ui/trainer_selector.js';

test('inapplicable portraits do not classify paired human trainers as wild battles', () => {
  const dataset = load('pokemon-unbound');
  const records = Object.values(dataset.documents['trainers.json'].records);
  const pairs = records.filter(trainer => trainer.trainerVisualParticipants?.length);
  assert.equal(pairs.length, 21);
  const before = JSON.stringify(records);
  for (const trainer of pairs) {
    assert.equal(trainer.trainerVisualIdentity.status, 'inapplicable');
    assert.equal(trainerPortraitFallback(trainer), 'Sprite unavailable', trainer.id);
    assert.equal(trainerSpriteQuery(trainer), null);
    assert.equal(trainer.trainerVisualParticipants.length, 2);
  }
  const wild = records.filter(trainer => trainer.sourceType === 'boss-wild');
  assert.ok(wild.length);
  for (const trainer of wild) assert.equal(trainerPortraitFallback(trainer), 'Wild encounter', trainer.id);
  assert.equal(trainerPortraitFallback({trainerVisualIdentity:{status:'inapplicable'}}), 'Sprite unavailable');
  assert.equal(trainerPortraitFallback(null), 'Sprite unavailable');
  assert.equal(trainerPortraitFallback({...pairs[0],sourceType:'boss-wild'}), 'Sprite unavailable');
  assert.equal(JSON.stringify(records), before);
});

test('game-wide search preserves navigation order, combined encounters, location and source data', () => {
  const dataset = load('platinum-kaizo'), groups = dataset.trainerGroups('chimchar');
  const before = JSON.stringify(groups);
  const index = trainerSearchIndex(dataset, groups, 'chimchar');
  assert.equal(new Set(index.map(entry => entry.trainer.id)).size, index.length);
  const pair = 'platinum-kaizo-veilstone-tag-battle';
  for (const query of ['Cupid', 'uranus', 'abomasnow', 'Veilstone']) assert.ok(searchTrainerIndex(index, query).some(entry => entry.trainer.id === pair), query);
  assert.ok(searchTrainerIndex(index, 'route 202').length);
  assert.deepEqual(searchTrainerIndex(index, 'not-a-trainer-or-pokemon'), []);
  assert.deepEqual(searchTrainerIndex(index, '').map(entry => entry.trainer.id), [...new Set(groups.flatMap(group => group.trainers.map(trainer => trainer.id)))]);
  assert.equal(JSON.stringify(groups), before);
});

test('search supports accents and starter-specific variant teams without indexing excluded species', () => {
  const trainer = {id:'rival',displayName:'Rivál',locationName:'Pokémon Tower',team:[{speciesId:'bulbasaur'}],mechanicsVariants:[{id:'a'},{id:'b'}]};
  const dataset = {get:()=>null,starterSelection:{choices:[{id:'starter'}],trainerBindings:[],variantBindings:[{trainerId:'rival',variantId:'b',starterIds:['other']}]},
    trainerTeam:(_id,variant)=>[{speciesId:variant==='a'?'mr-mime':'squirtle'}]};
  const index=trainerSearchIndex(dataset,[{id:'first',trainers:[trainer]}],'starter');
  for(const query of ['rival','pokemon tower','mr mime']) assert.equal(searchTrainerIndex(index,query).length,1,query);
  for(const query of ['bulbasaur','squirtle']) assert.equal(searchTrainerIndex(index,query).length,0,query);
});

test('every supported game can build a search index from existing consumer data', () => {
  for (const game of fs.readdirSync(new URL('../src/generated/datasets/',import.meta.url))) {
    const dataset=load(game), starter=dataset.starterSelection.choices[0].id;
    const index=trainerSearchIndex(dataset,dataset.trainerGroups(starter),starter);
    assert.ok(index.length, game);
  }
});

test('hidden location and starter annotations remain searchable without changing source names', () => {
  const trainer = {id:'bugsy',displayName:'Leader Bugsy [Rematch] |Goldenrod City|',team:[]};
  const before = structuredClone(trainer);
  const index = trainerSearchIndex({get:()=>null}, [{id:'johto',trainers:[trainer]}]);
  assert.equal(displayTrainerName(trainer.displayName), 'Leader Bugsy');
  for (const query of ['Bugsy', 'Goldenrod', 'Rematch']) {
    assert.deepEqual(searchTrainerIndex(index, query).map(entry=>entry.trainer.id), ['bugsy']);
  }
  assert.deepEqual(trainer, before);
});

test('split art retains game context for BW Iris and the new Unbound collection', () => {
  for (const game of ['pokemon-white', 'pokemon-white-2']) {
    assert.deepEqual(trainerSplitBadgeQuery(game, { id: 'iris' }),
      { kind: 'badge-icon', game: game.replace(/^pokemon-/, ''), style: 'b2w2-unova', badge: 'iris' });
  }
  assert.deepEqual(trainerSplitBadgeQuery('pokemon-unbound', { id: 'maxima' }),
    { kind: 'badge-icon', game: 'unbound', badge: 'maxima' });
  assert.deepEqual(trainerSplitBadgeQuery('pokemon-unbound', { id: 'league' }),
    { kind: 'badge-icon', game: 'unbound', badge: 'elite-four' });
  assert.equal(trainerSplitBadgeQuery('pokemon-white', { id: 'postgame' }).style, 'showdown');
  assert.equal(trainerSplitBadgeQuery('pokemon-white', { id: 'frontier' }).item, 'poke-ball');
  assert.deepEqual(trainerSplitBadgeQuery('storm-silver', {id:'other'}),
    {kind:'pokemon-sprite',spriteType:'pixel',species:'unown',form:'question',view:'front'});
});

function load(game) {
  const read = name => JSON.parse(fs.readFileSync(new URL(`../src/generated/datasets/${game}/${name}`, import.meta.url)));
  return createDatasetContext({ manifest: read('dataset_manifest.json'), mechanics: read('battle_mechanics.json'), documents: Object.fromEntries([...REQUIRED_DATASET_SOURCES, 'starter_selection.json'].map(name => [name, read(name)])) });
}

test('Technical trainer annotations are hidden across games without changing records', () => {
  for (const [input, expected] of [
    ['Pokémon Trainer Barry #2 [Piplup]', 'Pokémon Trainer Barry'],
    ['Plasma Grunt #884', 'Plasma Grunt'],
    ['Lenora #1 & Scientist Hawes #2', 'Lenora & Scientist Hawes'],
    ['Leader · Encounter #2', 'Leader'], ['Leader (Encounter #2)', 'Leader'],
    ['Route 9 Trainer', 'Route 9 Trainer'], ['Trainer [Round 2]', 'Trainer'],
    ['Leader Bugsy |Goldenrod City|', 'Leader Bugsy'],
    ['Leader Clair |Route 26|', 'Leader Clair'],
    ['Rival [Piplup] & Partner [Chimchar]', 'Rival & Partner'],
    ['Ace Trainer Bram [Double Battle] |Icicle Cave| #2', 'Ace Trainer Bram'],
    ['Veteran Grant (DOUBLE BATTLE)', 'Veteran Grant'],
    ['Jogger Raul (Morning only)', 'Jogger Raul'],
    ['Galactic Grunt (w. Galactic Grunt)', 'Galactic Grunt'],
    ['Science Society Scientist (Supply and Demand) - Difficult', 'Science Society Scientist (Supply and Demand) - Difficult'],
    ['Black Ferrothorn Goon ("Odd Odd Docks") |Antisis City| #2', 'Black Ferrothorn Goon ("Odd Odd Docks")'],
    ['Rival ???', 'Rival ???']
  ]) assert.equal(displayTrainerName(input), expected);
  const root = new URL('../src/generated/datasets/', import.meta.url);
  for (const game of fs.readdirSync(root)) {
    const file = new URL(`${game}/trainers.json`, root);
    if (!fs.existsSync(file)) continue;
    const records = JSON.parse(fs.readFileSync(file)).records;
    const before = JSON.stringify(records);
    for (const record of Object.values(records)) {
      const name = record.displayName || record.name || '';
      assert.doesNotMatch(displayTrainerName(name), /\s+#\d+(?=\s*(?:&|·|\[|\(|\||$))/u, `${game}: ${name}`);
      assert.doesNotMatch(displayTrainerName(name), /\[[^\]]*\]|\|[^|]*\|/u, `${game}: ${name}`);
    }
    assert.equal(JSON.stringify(records), before);
  }
});

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
