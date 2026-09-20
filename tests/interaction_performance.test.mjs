import assert from 'node:assert/strict';
import test from 'node:test';
import { DamagePreviewQueue, damagePreviewSnapshot } from '../src/worker/damage_preview_queue.js';
import { LatestPreviewQueue } from '../src/worker/latest_preview_queue.js';
import { coalescedTask } from '../src/cache/coalesced_task.js';
import { createDraftRecord, updateDraftRecord, IndexedDbDraftStore } from '../src/cache/active_draft.js';
import { previewCombatantMove } from '../src/core/combatant_moves.js';
import { fixturePlan, fixtureDoublesPlan, fixtureTriplePlan, fixtureRotationPlan, damageAdapter } from './helpers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const request = f => ({plan:f.plan,stateNodeId:f.plan.initialStateNodeId,actorKey:f.players[0].combatantKey,targetKey:f.enemies[0].combatantKey,moveId:'tackle'});

for (const fixture of [fixturePlan,fixtureDoublesPlan,fixtureTriplePlan,fixtureRotationPlan]) test(`${fixture.name}: compact damage payload preserves exact engine inputs`, () => {
  const f=fixture(), payload=request(f), state=f.plan.stateNodes[payload.stateNodeId];
  const actor=state.combatantStates[payload.actorKey];
  actor.currentItemId='occaberry';actor.currentAbilityId='swarm';actor.statStages.atk=2;
  actor.turnFlags.wasDamaged=true;actor.majorStatus='brn';
  state.fieldState.weather={id:'rain',remainingTurns:3};
  state.notes='not calculation data';state.trainerAiForecast={huge:'x'.repeat(100000)};
  f.plan.stateNodes.unrelated=structuredClone(state);
  const compact=damagePreviewSnapshot(f.plan,payload.stateNodeId);
  assert.equal(Object.keys(compact.stateNodes).length,1);
  assert.equal(compact.stateNodes[payload.stateNodeId].trainerAiForecast,undefined);
  assert.equal(compact.stateNodes[payload.stateNodeId].notes,undefined);
  const calls=[];
  const adapter=damageAdapter(input=>{calls.push(structuredClone(input));return [1,2,3];});
  for(const moveId of ['tackle','surf','earthquake','revenge']) for(const criticalHit of [false,true]) {
    const full=previewCombatantMove({...payload,moveId,criticalHit,dataset:f.dataset,damageAdapter:adapter});
    const slim=previewCombatantMove({...payload,moveId,criticalHit,plan:compact,dataset:f.dataset,damageAdapter:adapter});
    assert.deepEqual(slim,full);assert.deepEqual(calls.at(-1),calls.at(-2));
  }
});

test('damage batches deduplicate, cache current content and invalidate in-place changes', async()=>{
  const f=fixtureTriplePlan(),payload=request(f),sent=[];
  const queue=new DamagePreviewQueue(async batch=>{sent.push(structuredClone(batch));return batch.requests.map(r=>({ok:true,value:{move:r.moveId,crit:r.criticalHit}}));});
  const responses=await Promise.all(Array.from({length:48},()=>queue.request(payload)));
  assert.equal(sent.length,1);assert.equal(sent[0].requests.length,1);assert.equal(responses.length,48);
  queue.reset();await queue.request(payload);assert.equal(sent.length,1,'unchanged render reuses damage');
  await queue.request({...payload,criticalHit:true});assert.equal(sent.length,2);
  f.plan.stateNodes[payload.stateNodeId].combatantStates[payload.actorKey].currentAbilityId='solarpower';
  await queue.request(payload);assert.equal(sent.length,3,'in-place edits invalidate cache');
  queue.reset({clearCache:true});await queue.request(payload);assert.equal(sent.length,4,'dataset changes invalidate cache');
});

test('damage queues discard obsolete views and isolate errors to the affected label',async()=>{
  const f=fixturePlan(),payload=request(f),pending=[];
  const queue=new DamagePreviewQueue(batch=>{const d=deferred();pending.push({batch,...d});return d.promise;});
  const first=queue.request(payload);const firstRejected=assert.rejects(first,{name:'StalePreviewError'});await tick();
  queue.reset();const dropped=queue.request({...payload,moveId:'surf'});const droppedRejected=assert.rejects(dropped,{name:'StalePreviewError'});
  queue.reset();const latest=queue.request({...payload,moveId:'revenge'});
  assert.equal(pending.length,1);
  pending[0].resolve([{ok:true,value:{old:true}}]);await tick();
  assert.equal(pending.length,2);assert.equal(pending[1].batch.requests[0].moveId,'revenge');
  pending[1].resolve([{ok:true,value:{latest:true}}]);
  assert.deepEqual(await latest,{latest:true});await firstRejected;await droppedRejected;
  queue.reset();const fail=queue.request({...payload,moveId:'bad'});const fails=assert.rejects(fail,/unsupported/);
  const good=queue.request(payload);await tick();pending[2].resolve([{ok:false,error:{name:'Error',message:'unsupported'}},{ok:true,value:42}]);
  await fails;assert.equal(await good,42);
});

test('turn queue calculates only in-flight and latest selections; cancel handles incomplete actions',async()=>{
  const sent=[];const queue=new LatestPreviewQueue(payload=>{const d=deferred();sent.push({payload,...d});return d.promise;});
  const a=queue.request('a');const ar=assert.rejects(a,{name:'StalePreviewError'});await tick();
  const b=queue.request('b');const br=assert.rejects(b,{name:'StalePreviewError'});
  const c=queue.request('c');sent[0].resolve('old');await tick();
  assert.deepEqual(sent.map(s=>s.payload),['a','c']);sent[1].resolve('new');assert.equal(await c,'new');await ar;await br;
  const incomplete=queue.request('d');const rejected=assert.rejects(incomplete,{name:'StalePreviewError'});queue.cancel();await rejected;
  assert.equal(sent.length,2);
});

test('draft metadata update does not clone discarded document; returned snapshot remains independent',()=>{
  const f=fixturePlan(),record=createDraftRecord(f.plan);record.exportSelectionDraft={ids:['a']};
  record.document={uncloneable:()=>{}}; // overwritten data must never be traversed
  const next=updateDraftRecord(record,f.plan,f.plan.initialStateNodeId);
  next.document.name='changed';next.exportSelectionDraft.ids.push('b');
  assert.notEqual(f.plan.name,'changed');assert.deepEqual(record.exportSelectionDraft.ids,['a']);
});

test('same-event autosaves coalesce without an idle delay and propagate failures',async()=>{
  let calls=0;const task=coalescedTask(()=>++calls);
  const a=task(),b=task();assert.equal(a,b);assert.equal(await b,1);assert.equal(await task(),2);
  const fail=coalescedTask(()=>{throw new Error('quota');});await assert.rejects(fail(),/quota/);await assert.rejects(fail(),/quota/);
});

test('draft store captures at call time, orders save/clear, and survives transaction failure',async()=>{
  const store=new IndexedDbDraftStore();const first=deferred(),ops=[];let value;
  store.performTransaction=async(mode,operation)=>{
    if(!ops.length){ops.push('opening');await first.promise;}
    return operation({put(snapshot){value=snapshot;ops.push('save');},delete(){value=null;ops.push('clear');},get(){return value;}});
  };
  const input={revision:1};const a=store.save(input);input.revision=2;const b=store.clear();const c=store.save({revision:3});
  first.resolve();await a;await b;await c;assert.deepEqual(ops,['opening','save','clear','save']);assert.deepEqual(await store.load(),{revision:3});
  const broken=new IndexedDbDraftStore();let count=0;broken.performTransaction=async()=>{if(!count++)throw new Error('quota');return 'recovered';};
  await assert.rejects(broken.save({}),/quota/);assert.equal(await broken.clear(),'recovered');
});
