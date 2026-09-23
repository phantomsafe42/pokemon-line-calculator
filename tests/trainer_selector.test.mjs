import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixtureTriplePlan } from './helpers.mjs';
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from '../src/adapters/standardized_dataset.js';
import { triplePositionForSlot } from '../src/rulesets/triple_battle.js';
import { campaignTrainerGroups, displayBattleLabel, displayTrainerName, trainerDisplayBlocks, trainerRequirement, trainerSpriteQuery, trainerSplitBadgeQuery, trainerSearchIndex, searchTrainerIndex, trainerPortraitFallback, trainerPortraitParticipants, trainerSpriteQueries, preloadTrainerSprites } from '../src/ui/trainer_selector.js';

test('portrait preload deduplicates classes, includes alternatives and participants, and bounds concurrent loads', async () => {
  const identity = subjectId => ({status:'resolved',gameStyle:'platinum',presentation:'battle-front',subjectKind:'character',subjectId,gender:'default',variant:'default'});
  const records = Object.fromEntries(Array.from({length:12},(_,i)=>[i,{trainerVisualIdentity:identity(String(i%7))}]));
  records.pair={trainerVisualParticipants:[{trainerVisualIdentity:identity('partner')}]};
  records.variant={trainerVisualIdentity:{status:'ambiguous',alternatives:[identity('alternative'),identity('0')]}};
  const dataset={documents:{'trainers.json':{records}}};
  assert.equal(trainerSpriteQueries(dataset).length,9);
  const before=JSON.stringify(records), oldDocument=globalThis.document;
  globalThis.document={createElement:()=>({})};
  let active=0, peak=0, requests=0;
  const resolver={setAssetImage(image){requests++;peak=Math.max(peak,++active);setTimeout(()=>{active--;image.onload();},1);}};
  try {
    await preloadTrainerSprites(dataset,resolver);assert.equal(peak,4);assert.equal(requests,9);
    await preloadTrainerSprites(dataset,resolver);assert.equal(requests,9);
    assert.equal(JSON.stringify(records),before);
  } finally {globalThis.document=oldDocument;}
});

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
    ['Pokémon Trainer Barry #2 [Piplup]', 'Rival'],
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
    ['Science Society Scientist (Supply and Demand) - Difficult', 'Science Society Scientist (Supply and Demand)'],
    ['Black Ferrothorn Goon ("Odd Odd Docks") |Antisis City| #2', 'Black Ferrothorn Goon ("Odd Odd Docks")'],
    ['Rival ???', 'Rival']
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


test('review cleanup preserves initials, paired names, user titles and internal identities', () => {
  for (const [input, expected] of [
    ['Clerk ♀ Ingrid2', 'Clerk Ingrid'], ['Swimmer-M Luis', 'Swimmer Luis'],
    ['Tuber~3 Alexis', 'Tuber Alexis'], ['Cooltrainer {Mary}12', 'Cool Trainer Mary'],
    ['Team Plasma Grunt Team Plasma Grunt18 1', 'Team Plasma Grunt'],
    ['Leader..Roark3', 'Leader Roark'], ['Hiker J.J. Ahern', 'Hiker J.J. Ahern'],
    ['Lucas12 & Dawn11', 'Lucas & Dawn'], ['Team Rocket Grunt (M)', 'Team Rocket Grunt'],
    ['Rival Blue12', 'Rival'], ['Lt. Surge', 'Lt. Surge']
  ]) assert.equal(displayTrainerName(input), expected);
  assert.equal(displayTrainerName('Leader Brock', 'fire-red-omega'), 'Brock');
  assert.equal(displayTrainerName('Leader Brock', 'pokemon-firered'), 'Leader Brock');
  assert.equal(displayBattleLabel('My attempt 12'), 'My attempt 12');
  assert.equal(displayBattleLabel('Variant 360'), 'Variant 360');
});


test('campaign UI ends at the first league and hidden cards remain addressable', () => {
  for (const game of fs.readdirSync(new URL('../src/generated/datasets/', import.meta.url))) {
    const dataset = load(game), all = dataset.trainerGroups(), groups = campaignTrainerGroups(all);
    assert.match(groups.at(-1).id, /^(champion|league|elitefour)$/u, game);
    assert.ok(groups.every(g => !['other','postgame','facilities','frontier'].includes(g.id)), game);
    const index = trainerSearchIndex(dataset, groups, null), shown = new Set(index.map(e=>e.trainer.id));
    for(const group of all.filter(g=>!groups.includes(g)))for(const trainer of group.trainers){
      assert.ok(dataset.trainer(trainer.id), 'hidden trainer remains in data');
      if(!groups.some(g=>g.trainers.some(t=>t.id===trainer.id)))assert.ok(!shown.has(trainer.id));
    }
  }
  assert.equal(displayTrainerName('Roughneck {{un|Nicky}}'), 'Roughneck Nicky');
  assert.equal(displayTrainerName('Battle Girl {{hoTessa}}'), 'Battle Girl Tessa');
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

test('PK Rival borders remain required for every starter across all five campaign splits', () => {
  const dataset = load('platinum-kaizo');
  const before = JSON.stringify(dataset.documents);
  for (const starter of ['turtwig', 'chimchar', 'piplup']) {
    const groups = campaignTrainerGroups(dataset.trainerGroups(starter));
    for (const [split, count] of [['roark', 2], ['maylene', 1], ['wake', 1], ['byron', 1], ['elitefour', 1]]) {
      const rivals = groups.find(group => group.id === split).trainers.filter(trainer => trainer.displayName === 'Rival');
      assert.equal(rivals.length, count, `${starter}/${split} Rival inventory`);
      for (const trainer of rivals) assert.equal(trainerRequirement(dataset, trainer, split), 'required', `${starter}/${split}/${trainer.id}`);
    }
    for (const group of groups) for (const trainer of group.trainers)
      assert.notEqual(trainerRequirement(dataset, trainer, group.id), 'unknown', `${starter}/${group.id}/${trainer.id}`);
  }
  assert.equal(JSON.stringify(dataset.documents), before, 'Border lookup must not mutate Dataset data');
});

test('variant requirement lookup respects rematch splits and preserves optional and unknown states', () => {
  const dataset = {documents: {'trainer_order.json': {records: [
    {trainerId: 'base-a', splitId: 'first', mandatory: true, mechanicsVariants: [{trainerId: 'variant'}]},
    {trainerId: 'base-b', splitId: 'rematch', mandatory: false, mechanicsVariants: [{trainerId: 'variant'}]},
    {trainerId: 'base-c', splitId: 'first', mandatory: null, mechanicsVariants: [{trainerId: 'unclassified'}]}
  ]}}};
  assert.equal(trainerRequirement(dataset, {id: 'variant'}, 'first'), 'required');
  assert.equal(trainerRequirement(dataset, {id: 'variant'}, 'rematch'), 'optional');
  assert.equal(trainerRequirement(dataset, {id: 'variant'}, 'unrelated'), 'unknown');
  assert.equal(trainerRequirement(dataset, {id: 'unclassified'}, 'first'), 'unknown');
  assert.equal(trainerRequirement(dataset, {id: 'missing', displayName: 'Rival'}, 'first'), 'unknown');
  assert.equal(trainerRequirement(dataset, {encounter: {enemyTrainerIds: ['variant', 'missing']}}, 'first'), 'required');
  assert.equal(trainerRequirement(dataset, {encounter: {enemyTrainerIds: ['variant', 'missing']}}, 'rematch'), 'unknown');
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


test('explicit approved artwork editions reach the resolver while ordinary portraits retain defaults', () => {
  const trainer={trainerVisualIdentity:{status:'resolved',gameStyle:'diamond-pearl',presentation:'battle-front',subjectKind:'class',subjectId:'sis-and-bro',gender:'default',variant:'default',spriteSet:'dp',edition:'beta'}};
  assert.equal(trainerSpriteQuery(trainer).edition,'beta');
  delete trainer.trainerVisualIdentity.edition;
  assert.equal(Object.hasOwn(trainerSpriteQuery(trainer),'edition'),false);
  trainer.trainerVisualIdentity.status='unavailable';
  assert.equal(trainerSpriteQuery(trainer),null);
});

test('paired portraits preserve participant order and labels without changing encounter teams', () => {
  const dataset = load('pokemon-unbound');
  const records = Object.values(dataset.documents['trainers.json'].records);
  const before = JSON.stringify(records);
  const pairs = records.filter(row => row.trainerVisualParticipants?.length);
  assert.equal(pairs.length, 21);
  for (const pair of pairs) {
    const portraits = trainerPortraitParticipants(pair);
    assert.equal(portraits.length, 2);
    for (const [index, portrait] of portraits.entries()) {
      assert.equal(portrait.displayName, pair.trainerVisualParticipants[index].label);
      assert.equal(portrait.slot, index);
      assert.ok(trainerSpriteQuery(portrait), pair.id);
      assert.equal(portrait.team, undefined);
    }
  }
  assert.deepEqual(trainerPortraitParticipants({sourceType:'boss-wild'}), []);
  assert.deepEqual(trainerPortraitParticipants(null), []);
  assert.equal(JSON.stringify(records), before);
});
