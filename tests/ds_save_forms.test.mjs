import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from '../src/adapters/standardized_dataset.js';
import { parseSave, selectSavePokemon } from '../src/boxes/save_import.js';
import { parseSave as parseNeutralSave } from '../src/generated/save-mechanics/adapters/src/parse-save.js';
import { syntheticDsSave } from './ds_save_fixture.mjs';

function dataset(gameId) {
  const read = name => JSON.parse(fs.readFileSync(new URL(`../src/generated/datasets/${gameId}/${name}`, import.meta.url)));
  return createDatasetContext({manifest:read('dataset_manifest.json'),mechanics:read('battle_mechanics.json'),
    documents:Object.fromEntries(REQUIRED_DATASET_SOURCES.map(name=>[name,read(name)]))});
}
const vw2r = dataset('volt-white-2r'), platinum = dataset('pokemon-platinum');
const forms = [
  ...Array.from('bcdefghijklmnopqrstuvwxyz', (letter,index)=>[201,index+1,`unown${letter}`]),
  [201,26,'unownexclamation'],[201,27,'unownquestion'],
  [421,1,'cherrimsunshine'],[422,1,'shelloseast'],[423,1,'gastrodoneast'],
  [585,1,'deerlingsummer'],[585,2,'deerlingautumn'],[585,3,'deerlingwinter'],
  [586,1,'sawsbucksummer'],[586,2,'sawsbuckautumn'],[586,3,'sawsbuckwinter'],
];

test('PLC actual SAV/DSV imports preserve all 36 VW2R compound forms in Box records', () => {
  assert.equal(forms.length,36);
  assert.equal(typeof vw2r.getSpeciesBySaveIdentity,'undefined','Exercise the PLC documents-only contract');
  for (const dsv of [false,true]) for (const [species,form,id] of forms) {
    const bytes = syntheticDsSave('bw2',[[species,form]],{dsv}), before = bytes.slice();
    const neutral = parseNeutralSave(bytes,{gameId:vw2r.gameId,dataset:vw2r,rejectInvalidPokemonChecksums:true});
    const imported = parseSave(bytes,vw2r);
    assert.equal(neutral.party[0].speciesId,id);
    assert.equal(neutral.party[0].speciesNumericId,species);
    assert.equal(neutral.party[0].formIndex,form);
    assert.equal(imported.pokemon[0].speciesId,id);
    assert.equal(imported.pokemon[0].formId,id);
    assert.equal(imported.pokemon[0].displayName,vw2r.get('species',id).name);
    assert.equal(imported.pokemon[0].experience,1000);
    assert.deepEqual(bytes,before,'Import never changes the supplied bytes');
  }
});

test('Gen 4 and Gen 5 party/PC form identities survive PLC box selection, while ordinary stats stay unchanged', () => {
  for (const [data,format] of [[platinum,'platinum'],[vw2r,'bw2']]) for (const dsv of [false,true]) {
    const bytes=syntheticDsSave(format,[[422,0],[422,1],[25,0]],{dsv,boxed:[{identity:[423,1],box:2}]});
    const imported=parseSave(bytes,data);
    assert.deepEqual(imported.pokemon.map(mon=>mon.speciesId),['shellos','shelloseast','pikachu','gastrodoneast']);
    assert.deepEqual(selectSavePokemon(imported,[]).pokemon.map(mon=>mon.speciesId),['shellos','shelloseast','pikachu']);
    assert.deepEqual(selectSavePokemon(imported,[2]).pokemon.map(mon=>mon.speciesId),['shellos','shelloseast','pikachu','gastrodoneast']);
    const ordinary=imported.pokemon[2];
    assert.deepEqual(ordinary.ivs,{hp:31,atk:30,def:29,spe:28,spa:27,spd:26});
    assert.deepEqual(ordinary.evs,{hp:1,atk:2,def:3,spe:4,spa:5,spd:6});
    assert.equal(ordinary.experience,1000);
    assert.equal(ordinary.itemId,null);
    assert.equal(ordinary.moves.length,4);
  }
});

test('PLC import retains base fallback for unsupported forms and rejects broken compound contracts', () => {
  assert.equal(parseSave(syntheticDsSave('bw2',[[422,31]]),vw2r).pokemon[0].speciesId,'shellos');
  const bytes=syntheticDsSave('bw2',[[422,1]]);
  const missingTarget={...vw2r,get(kind,id){return kind==='species' && id==='shelloseast' ? null : vw2r.get(kind,id);}};
  assert.throws(()=>parseSave(bytes,missingTarget),/no species identity for save ID 422 form 1/);
  assert.throws(()=>parseSave(bytes,{...vw2r,documents:{}}),/no species identity for save ID 422 form 1/);
  assert.throws(()=>parseSave(syntheticDsSave('bw2',[[65535,1]]),vw2r),/no species identity/);
  const corrupt=syntheticDsSave('bw2',[[422,1]],{dsv:true}); corrupt[corrupt.length-1]^=1;
  assert.throws(()=>parseSave(corrupt,vw2r),/footer|DeSmuME/i);
});
