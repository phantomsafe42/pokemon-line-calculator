import assert from 'node:assert/strict';
import test from 'node:test';
import { starterPresentationType } from '../src/ui/starter_presentation.js';

test('Starter presentation uses approved FRO and Unbound trio colors without changing species types',()=>{
  for (const [gameId, rows] of Object.entries({
    'fire-red-omega': [['elekid','electric'],['smoochum','ice'],['magby','fire']],
    'pokemon-unbound': [['beldum','steel'],['gible','ground'],['larvitar','dark']]
  })) for (const [id,type] of rows) {
    const species={types:['rock','ground']},before=structuredClone(species);
    assert.equal(starterPresentationType(gameId,{speciesId:id,type:null},species),type);
    assert.deepEqual(species,before);
  }
});
test('Ordinary starter display follows its contract, with safe unavailable fallback',()=>{
  assert.equal(starterPresentationType('volt-white-2r',{speciesId:'snivy',type:'grass'},{types:['grass']}),'grass');
  assert.equal(starterPresentationType('pokemon-platinum',{speciesId:'piplup'},{types:['water']}),'water');
  assert.equal(starterPresentationType('unknown',null,null),null);
});
