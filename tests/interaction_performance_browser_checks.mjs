import assert from 'node:assert/strict';
import { normalizePlayerCollection, normalizeTrainerRoster } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';
import { editSandboxCombatant } from '../src/core/sandbox.js';

export async function checkInteractionPerformance({page,evaluate,delay,dataset,expectBatched=true}) {
  await page.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
  await evaluate(page,`(()=>{
    window.__damagePerf=[];
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(message,...rest){
      const start=performance.now();const result=post.call(this,message,...rest);
      if(message.type?.startsWith('damage-preview')) window.__damagePerf.push({type:message.type,
        states:Object.keys(message.payload.plan?.stateNodes||{}).length,ms:performance.now()-start});
      return result;
    };
  })()`);
  const trainer=dataset.trainerGroups().flatMap(g=>g.trainers).find(t=>{
    try{return normalizeTrainerRoster(t.id,null,dataset).length>=3 && !t.playerPartnerBinding && !t.encounter;}catch{return false;}
  });
  const players=normalizePlayerCollection({party:['squirtle','bulbasaur','charmander','pikachu'].map((speciesId,i)=>({
    speciesId,uniqueKey:`perf-${i}`,nickname:`Perf ${i}`,level:30,nature:'Hardy',ability:'Pressure',
    ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},moves:['tackle','protect','surf','earthquake']
  }))},dataset);
  const base=createPlanDocument({name:'Performance fixture',dataset,trainerId:trainer.id,playerCombatants:players,
    enemyCombatants:normalizeTrainerRoster(trainer.id,null,dataset),battleFormat:'triples',planningMode:'sandbox'});
  const wait=async(expression,label)=>{
    for(let i=0;i<300;i++){if(await evaluate(page,expression))return;await delay(50);}throw new Error(label);
  };
  const measurements=[];
  let plan=base,count=0;
  for(const branches of [1,100]) {
    while(count<branches){plan=editSandboxCombatant(plan,base.initialStateNodeId,players[0].combatantKey,{hp:30},dataset).plan;count++;}
    plan.name=`Performance ${branches}`;
    await evaluate(page,`(()=>{
      const t=new DataTransfer();t.items.add(new File([${JSON.stringify(JSON.stringify(plan))}],'performance.json',{type:'application/json'}));
      const input=document.getElementById('import-plan');input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await wait(`(()=>{if(document.getElementById('destructive-dialog').open)document.getElementById('destructive-discard').click();return document.getElementById('plan-toolbar-label').textContent===${JSON.stringify(plan.name)};})()`,'performance fixture import');
    await wait(`[...document.querySelectorAll('.damage-slot-value,.damage-label')].every(el=>el.textContent!=='…')`,'initial damage labels');
    await delay(100);
    const times=[];
    for(let sample=0;sample<3;sample++) {
      await evaluate(page,`window.__damagePerf=[]`);
      const syncMs=await evaluate(page,`(()=>{
        const control=document.querySelector('[data-free-calc-control="player-0-HP"]');
        control.value=String(25+${sample});const start=performance.now();
        control.dispatchEvent(new Event('change',{bubbles:true}));return performance.now()-start;
      })()`);
      await wait(`[...document.querySelectorAll('.damage-slot-value,.damage-label')].every(el=>el.textContent!=='…')`,'edited damage labels');
      const traffic=await evaluate(page,`window.__damagePerf`);
      if(expectBatched){assert.ok(traffic.length>0);assert.ok(traffic.every(r=>r.type==='damage-preview-batch'&&r.states===1));assert.ok(traffic.length<=2);}
      times.push({syncMs:+syncMs.toFixed(2),messages:traffic.length,postMs:+traffic.reduce((n,r)=>n+r.ms,0).toFixed(2)});
    }
    measurements.push({branches,times});
  }
  console.log(JSON.stringify({status:'interaction-browser-performance',expectBatched,measurements}));
  return measurements;
}
