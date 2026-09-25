import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shellBellFixture } from '../tests/item_effect_fixture.mjs';

const root=process.env.PLC_ITEM_REFERENCE_ROOT;
if(!root)throw new Error('Set PLC_ITEM_REFERENCE_ROOT to the Dataset-owned item-battle-mechanics reference directory');
const expected=JSON.parse(fs.readFileSync(path.join(root,'shell_bell_known_answers.json')));
const inventory=JSON.parse(fs.readFileSync(path.join(root,'showdown_item_callbacks.json')));
assert.equal(expected.provenance.package,'pokemon-showdown@0.11.11');
assert.deepEqual(expected.provenance,inventory.provenance);
let checked=0;
for(const spec of expected.cases){
  const f=shellBellFixture(spec,spec.generation);
  const rows=f.run().filter(row => row.outcome.probability !== 0);assert.ok(rows.length,`${spec.generation}/${spec.id} missing outcomes`);
  for(const row of rows){
    const actual={hp:row.state.combatantStates[f.playerKey].hp.min,itemId:row.state.combatantStates[f.playerKey].currentItemId,
      healed:row.events.some(e=>e.eventType==='heal'&&e.metadata?.itemId==='shellbell')};
    assert.deepEqual(actual,spec.expected,`Showdown parity: Gen ${spec.generation} ${spec.id}`);
    assert.equal(row.state.combatantStates[f.playerKey].hp.max,actual.hp);
  }
  checked++;
}
console.log(JSON.stringify({status:'showdown-item-reference-valid',knownAnswerCases:checked}));
