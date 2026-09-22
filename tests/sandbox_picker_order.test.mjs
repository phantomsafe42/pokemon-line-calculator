import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSandboxCandidates } from '../src/ui/sandbox_picker.js';
const mon=(id,boxId='box-a')=>({combatantKey:`${boxId}:${id}`,source:{boxId,uniqueKey:id},level:30});
const roster=Array.from({length:12},(_,i)=>mon(String(i+1)));

test('Sandbox picks stay in Box order after admission beyond the initial six',()=>{
  const admitted={...roster[10],combatantKey:'plan-eleven',level:41};
  const candidates=[...roster.slice(0,6),admitted,...roster.slice(6).filter(m=>m!==roster[10])];
  const before=structuredClone(candidates);
  const result=orderSandboxCandidates(candidates,roster);
  assert.deepEqual(result.map(m=>m.source.uniqueKey),roster.map(m=>m.source.uniqueKey));
  assert.equal(result[10],admitted,'Reuse edited plan combatant, never overwrite it from Box defaults');
  assert.deepEqual(candidates,before,'Do not mutate canonical input or plan order');
  assert.deepEqual(orderSandboxCandidates([...result.slice(0,6),result[11],...result.slice(6,11)],roster),result);
});
test('Cross-Box identities do not collide; records absent from Boxes remain available at the end',()=>{
  const ordered=[mon('same','a'),mon('second','a'),mon('same','b')];
  const unbound={combatantKey:'legacy'},removed=mon('deleted','a');
  const result=orderSandboxCandidates([unbound,ordered[2],removed,ordered[1],ordered[0]],ordered);
  assert.deepEqual(result,[...ordered,unbound,removed]);
});
test('Stable key fallback handles records without Box provenance without inventing positions',()=>{
  const a={combatantKey:'a'},b={combatantKey:'b'},c={combatantKey:'c'};
  assert.deepEqual(orderSandboxCandidates([b,a,c],[a,b]),[a,b,c]);
  assert.deepEqual(orderSandboxCandidates([b,a,c],[]),[b,a,c]);
});
