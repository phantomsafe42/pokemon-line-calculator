import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root=process.env.PLC_ITEM_REFERENCE_ROOT;
if(!root)throw Error('Set PLC_ITEM_REFERENCE_ROOT');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name)));
const inventory=read('showdown_item_callbacks.json');
const transition=read('held_item_known_answers.json'), damage=read('held_item_damage_answers.json');
const passive=read('held_item_passive_answers.json');
assert.deepEqual(transition.provenance,inventory.provenance);
assert.deepEqual(damage.provenance,inventory.provenance);
assert.deepEqual(passive.provenance,inventory.provenance);
const available=new Set();
for(const directory of fs.readdirSync('src/generated/datasets')) {
  const file=path.join('src/generated/datasets',directory,'items.json');
  const mechanics=path.join('src/generated/datasets',directory,'battle_mechanics.json');
  if(fs.existsSync(file)&&fs.existsSync(mechanics)) {
    const generation=JSON.parse(fs.readFileSync(mechanics)).damageGeneration;
    for(const [key,item] of Object.entries(JSON.parse(fs.readFileSync(file)).records))available.add(`${generation}:${item.id||key}`);
  }
}
const branchTests=new Set(['shellbell','metronome','micleberry','focusband','starfberry','kingsrock','razorfang','gripclaw','bindingband','destinyknot','custapberry','griseousorb','airballoon','quickclaw','shedshell','burndrive','chilldrive','dousedrive','shockdrive']);
const records=inventory.records.map(record=>{
  const transitionCases=transition.cases.filter(row=>row.generation===record.generation&&row.itemId===record.itemId).length;
  const damageCases=damage.cases.filter(row=>row.generation===record.generation&&row.itemId===record.itemId).length;
  const passiveCases=passive.cases.filter(row=>row.generation===record.generation&&row.itemId===record.itemId).length;
  const isAvailable=available.has(`${record.generation}:${record.itemId}`);
  return {...record,available:isAvailable,transitionCases,damageCases,passiveCases,
    branchTestFile:branchTests.has(record.itemId)?'tests/held_item_sweep.test.mjs, persistent_items.test.mjs, item_consumption.test.mjs, or action_order.test.mjs':null,
    status:!isAvailable?'outside-public-item-inventory':transitionCases||damageCases||passiveCases||branchTests.has(record.itemId)?'exercised':'needs-additional-reference-cases'};
});
fs.writeFileSync('.codex-tmp/item-effect-coverage.json',JSON.stringify({provenance:inventory.provenance,
  scope:'Coverage evidence, not full callback certification. Engine-side effects and game-specific deviations require separate review.',records},null,2)+'\n');
console.log(JSON.stringify({callbackRecords:records.length,exercised:records.filter(row=>row.status==='exercised').length,
  remainingReferenceRecords:records.filter(row=>row.status==='needs-additional-reference-cases').length}));
