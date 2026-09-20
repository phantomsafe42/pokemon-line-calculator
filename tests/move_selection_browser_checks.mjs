import assert from 'node:assert/strict';
import { normalizePlayerCollection, normalizeTrainerRoster } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument, updateStateHash } from '../src/core/plan.js';

export async function checkMoveSelection({page,evaluate,delay,dataset}) {
  const trainer=dataset.trainerGroups().flatMap(g=>g.trainers).find(t=>{
    try{return normalizeTrainerRoster(t.id,null,dataset).length>=4 && !t.playerPartnerBinding && !t.encounter;}catch{return false;}
  });
  const stats=value=>Object.fromEntries(['hp','atk','def','spa','spd','spe'].map(key=>[key,value]));
  const players=normalizePlayerCollection({party:['squirtle','bulbasaur','charmander','pikachu'].map((speciesId,i)=>({
    speciesId,uniqueKey:`toggle-${i}`,nickname:`Toggle ${i}`,level:30,nature:'Hardy',ability:'Pressure',ivs:stats(31),evs:stats(0),moves:['tackle','protect','dig','hyperbeam']
  }))},dataset);
  const enemies=normalizeTrainerRoster(trainer.id,null,dataset).map(mon=>({...mon,moves:structuredClone(players[0].moves)}));
  const fixture=(format,mode)=>createPlanDocument({name:`Toggle ${mode} ${format}`,dataset,trainerId:trainer.id,
    playerCombatants:players,enemyCombatants:enemies,battleFormat:format,...(mode==='sandbox'?{planningMode:'sandbox'}:{})});
  const upload=async plan=>{
    await evaluate(page,`(()=>{const t=new DataTransfer();t.items.add(new File([${JSON.stringify(JSON.stringify(plan))}],'toggle.json',{type:'application/json'}));const el=document.getElementById('import-plan');el.files=t.files;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    for(let i=0;i<200;i++){
      if(await evaluate(page,`(()=>{if(document.getElementById('destructive-dialog').open)document.getElementById('destructive-discard').click();return document.getElementById('plan-toolbar-label').textContent===${JSON.stringify(plan.name)} && document.querySelectorAll('.combatant-card').length>=2;})()`))return;
      await delay(100);
    }
    throw new Error('Move toggle fixture import failed');
  };
  const modes=['normal','free-calc'];
  if(await evaluate(page,`Boolean(document.getElementById('sandbox-mode'))`))modes.push('sandbox');
  for(const mode of modes)for(const format of ['singles','doubles','triples','rotation']) {
    await upload(fixture(format,mode));
    if(mode==='free-calc')await evaluate(page,`document.getElementById('free-calc').click()`);
    const results=await evaluate(page,`(()=>{
      const results=[];
      for(const side of ['player','enemy']){
        const card=()=>document.querySelector('[data-side="'+side+'"][data-action-slot="0"]');
        const move=i=>card().querySelectorAll('.move-button')[i];
        move(0).click();const selected=move(0).getAttribute('aria-pressed');
        move(0).click();const cleared=move(0).getAttribute('aria-pressed');
        move(1).click();const statusSelected=move(1).getAttribute('aria-pressed');
        move(1).click();const statusCleared=move(1).getAttribute('aria-pressed');
        move(0).click();move(1).click();const changed=move(0).getAttribute('aria-pressed')==='false'&&move(1).getAttribute('aria-pressed')==='true';move(1).click();
        const targets=()=>move(0).closest('.move-button-group')?.querySelectorAll('button.damage-slot');
        let targetToggle=true,retarget=true;
        if(targets()?.length){targets()[0].click();const on=targets()[0].getAttribute('aria-pressed');targets()[0].click();targetToggle=on==='true'&&move(0).getAttribute('aria-pressed')==='false';
          if(targets().length>1){targets()[0].click();targets()[1].click();retarget=move(0).getAttribute('aria-pressed')==='true'&&targets()[1].getAttribute('aria-pressed')==='true'&&targets()[0].getAttribute('aria-pressed')==='false';move(0).click();}}
        results.push({selected,cleared,statusSelected,statusCleared,changed,targetToggle,retarget});
      }
      return results;
    })()`);
    for(const result of results)assert.deepEqual(result,{selected:'true',cleared:'false',statusSelected:'true',statusCleared:'false',changed:true,targetToggle:true,retarget:true},`${mode} ${format}`);
    await delay(150);
    assert.equal(await evaluate(page,`document.getElementById('commit-turn').disabled`),true,`${mode} ${format} incomplete actions cannot iterate`);
    assert.equal(await evaluate(page,`document.querySelectorAll('.move-button[aria-pressed="true"]').length`),0);
    if(mode==='free-calc')await evaluate(page,`document.getElementById('free-calc-close').click()`);
  }
  for(const kind of ['charge','recharge']){
    const plan=fixture('doubles','normal');plan.name=`Forced ${kind}`;
    const state=plan.stateNodes[plan.initialStateNodeId],mon=state.combatantStates[players[0].combatantKey];
    if(kind==='charge')mon.volatileConditions.chargingMoveId='dig';
    else {mon.volatileConditions.rechargeRequired=true;mon.lastMoveId='hyperbeam';}
    updateStateHash(state);await upload(plan);
    const result=await evaluate(page,`(()=>{
      const card=()=>document.querySelector('[data-side="player"][data-action-slot="0"]');
      const moves=()=>card().querySelectorAll('.move-button');
      const index=${kind==='charge'?2:3};
      if(!moves()[index].disabled){moves()[index].click();card().querySelectorAll('.move-button')[index].click();}
      return {selected:moves()[index].getAttribute('aria-pressed'),otherDisabled:moves()[0].disabled,
        otherTargets:!!moves()[0].closest('.move-button-group')?.querySelector('button.damage-slot'),switchDisabled:card().querySelector('.switch-button').disabled};
    })()`);
    assert.deepEqual(result,{selected:'true',otherDisabled:true,otherTargets:false,switchDisabled:true});
  }
  console.log(JSON.stringify({status:'move-selection-browser-valid',modes,formats:4,bothSides:true,targetToggle:true,forcedActions:true}));
}
