import { performance } from 'node:perf_hooks';
import { fixtureTriplePlan } from '../tests/helpers.mjs';
import { createPlanDocument } from '../src/core/plan.js';
import { editSandboxCombatant } from '../src/core/sandbox.js';
import { createDraftRecord, updateDraftRecord } from '../src/cache/active_draft.js';
import { DamagePreviewQueue } from '../src/worker/damage_preview_queue.js';

const median = async (run, repeats = 7) => {
  const times = [];
  for (let i = 0; i < repeats; i++) { const start = performance.now(); await run(); times.push(performance.now() - start); }
  return +times.sort((a,b)=>a-b)[Math.floor(repeats/2)].toFixed(2);
};
const f = fixtureTriplePlan();
let plan = createPlanDocument({dataset:f.dataset,trainerId:f.plan.game.trainerId,playerCombatants:f.players,
  enemyCombatants:f.enemies,battleFormat:'triples',planningMode:'sandbox',sourceSnapshot:f.plan.sourceSnapshot});
const root = plan.initialStateNodeId, actorKey = f.players[0].combatantKey;
let count = 0, leaf = root;
for (const branches of [1,25,100,250]) {
  while (count < branches) { const next = editSandboxCombatant(plan,root,actorKey,{hp:100},f.dataset); plan=next.plan;leaf=next.stateId;count++; }
  const record = createDraftRecord(plan,leaf);
  const jobs = Array.from({length:48},(_,i)=>({plan,stateNodeId:leaf,actorKey,
    targetKey:f.enemies[i%3].combatantKey,moveId:['tackle','surf','earthquake','revenge'][i%4],criticalHit:i%2===0}));
  const before = () => { for (const payload of jobs) structuredClone(payload); };
  const after = () => {
    const queue = new DamagePreviewQueue(async payload => {
      const wire = structuredClone(payload);
      return wire.requests.map(()=>({ok:true,value:{label:'fixture'}}));
    });
    return Promise.all(jobs.map(job=>queue.request(job)));
  };
  console.log(JSON.stringify({branches,states:Object.keys(plan.stateNodes).length,
    jsonMiB:+(Buffer.byteLength(JSON.stringify(plan))/1048576).toFixed(3),
    legacyDamageCopies48Ms:await median(before),batchedDamageColdMs:await median(after),
    legacyDraftCopiesMs:await median(()=>({...structuredClone(record),document:structuredClone(plan)})),
    draftUpdateMs:await median(()=>updateDraftRecord(record,plan,leaf)),
    isolatedLeafEditMs:await median(()=>editSandboxCombatant(plan,leaf,actorKey,{hp:99},f.dataset))}));
}
