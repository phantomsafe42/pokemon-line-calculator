import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizePlayerCollection, normalizeTrainerRoster } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';

export async function checkEventHover({page,evaluate,delay,dataset}) {
  const wait=async(expression,label)=>{for(let i=0;i<300;i++){if(await evaluate(page,expression))return;await delay(50);}throw new Error(label);};
  await page.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
  const trainer=dataset.trainerGroups().flatMap(group=>group.trainers).find(trainer=>{
    try{return normalizeTrainerRoster(trainer.id,null,dataset).length>=3&&!trainer.playerPartnerBinding&&!trainer.encounter;}catch{return false;}
  });
  const players=normalizePlayerCollection({party:['squirtle','bulbasaur','charmander','pikachu'].map((speciesId,index)=>({
    speciesId,uniqueKey:`hover-${index}`,nickname:`Hover ${index}`,level:30,nature:'Hardy',ability:'Pressure',
    ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},moves:['tackle','protect']
  }))},dataset);
  for(const format of ['singles','doubles','triples','rotation']) {
    const enemies=normalizeTrainerRoster(trainer.id,null,dataset).map(mon=>({...mon,moves:[{moveId:'tackle',maxPp:35}]}));
    const plan=createPlanDocument({name:`Hover ${format}`,dataset,trainerId:trainer.id,playerCombatants:players,enemyCombatants:enemies,battleFormat:format});
    await evaluate(page,`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify(plan))}],'hover.json',{type:'application/json'}));const input=document.getElementById('import-plan');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`(()=>{if(document.getElementById('destructive-dialog').open)document.getElementById('destructive-discard').click();return document.getElementById('plan-toolbar-label').textContent===${JSON.stringify(plan.name)};})()`,'hover fixture import');
    const count=format==='rotation'||format==='singles'?1:format==='doubles'?2:3;
    for(const side of ['player','enemy'])for(let slot=0;slot<count;slot++) {
      await evaluate(page,`(()=>{const card=document.querySelector('#${side}-action-panel .combatant-card[data-action-slot="${slot}"]');const move=[...card.querySelectorAll('.move-button')].find(button=>button.querySelector('strong')?.textContent==='Tackle');if(!move)throw new Error('Missing Tackle');move.click();})()`);
    }
    await wait(`document.querySelectorAll('#preview-outcomes [data-event-index]').length>0&&!document.getElementById('commit-turn').disabled`,'hover outcome calculation');
    await wait(`[...document.querySelectorAll('.damage-slot-value,.damage-label')].every(el=>el.textContent!=='…')`,'hover label settlement');
    await delay(100);
    await evaluate(page,`(()=>{window.__hoverTraffic=0;const post=Worker.prototype.postMessage;Worker.prototype.postMessage=function(...args){window.__hoverTraffic++;return post.apply(this,args);};window.__hoverSaved=[...document.querySelectorAll('.action-panel-cards')];window.__hoverBefore={height:document.documentElement.scrollHeight,tree:document.getElementById('node-tree').textContent,revision:document.getElementById('revision-label').textContent};})()`);
    const result=await evaluate(page,`(()=>{
      const rows=[...document.querySelectorAll('#preview-outcomes .outcome-action[data-event-index]')];
      const row=rows.find(row=>/Tackle/.test(row.textContent))||document.querySelector('#preview-outcomes [data-event-index]');
      row.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));
      return {layers:document.querySelectorAll('.event-preview-layer').length,actors:document.querySelectorAll('.event-preview-layer .event-actor').length,affected:document.querySelectorAll('.event-preview-layer .event-affected').length,controls:document.querySelectorAll('.event-preview-layer button,.event-preview-layer input,.event-preview-layer select').length,height:document.documentElement.scrollHeight};
    })()`);
    assert.equal(result.layers,2);assert.ok(result.actors>0);assert.ok(result.affected>0);assert.equal(result.controls,0);
    assert.equal(result.height,await evaluate(page,'window.__hoverBefore.height'));
    const sectionTargets=await evaluate(page,`(()=>{
      const row=document.querySelector('#preview-outcomes .outcome-action[data-event-index]');
      const child=row.querySelector('.event-line');
      const layers=[...document.querySelectorAll('.event-preview-layer')];
      child.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse',relatedTarget:row}));
      child.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse',relatedTarget:row.querySelector('.outcome-action-sprite')}));
      return {innerTargets:document.querySelectorAll('.outcome-action [data-event-index],.outcome-action [tabindex]').length,unchanged:layers.every(layer=>layer.isConnected),wholeSection:document.querySelector('.is-inspected-event')?.classList.contains('outcome-action')};
    })()`);
    assert.deepEqual(sectionTargets,{innerTargets:0,unchanged:true,wholeSection:true});
    if(format==='triples') {
      await evaluate(page,`document.querySelector('#preview-outcomes .outcome-action[data-event-index]').click()`);
      await delay(100);
      assert.equal(await evaluate(page,`document.querySelectorAll('.event-preview-layer').length`),2);
      const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await fs.writeFile(new URL('../.codex-tmp/outcome-hover-triples.png',import.meta.url),Buffer.from(shot.data,'base64'));
      await evaluate(page,`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    }
    await evaluate(page,`(()=>{const rows=[...document.querySelectorAll('#preview-outcomes [data-event-index]')];for(let i=0;i<30;i++)rows[i%rows.length].dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));})()`);
    await delay(100);
    const restored=await evaluate(page,`({layers:document.querySelectorAll('.event-preview-layer').length,same:window.__hoverSaved.every(node=>node.isConnected&&node.style.visibility!== 'hidden'),traffic:window.__hoverTraffic,tree:document.getElementById('node-tree').textContent,revision:document.getElementById('revision-label').textContent,before:window.__hoverBefore})`);
    assert.equal(restored.layers,0);assert.equal(restored.same,true);assert.equal(restored.traffic,0);assert.equal(restored.tree,restored.before.tree);assert.equal(restored.revision,restored.before.revision);
    await evaluate(page,`(()=>{const row=document.querySelector('#preview-outcomes [data-event-index]');row.focus();row.click();row.dispatchEvent(new PointerEvent('pointerout',{bubbles:true}));})()`);
    assert.equal(await evaluate(page,`document.querySelectorAll('.event-preview-layer').length`),2);
    await evaluate(page,`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    if(format==='singles') {
      await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
      await delay(150);
      await evaluate(page,`document.querySelector('#preview-outcomes [data-event-index]').click()`);
      assert.equal(await evaluate(page,`document.querySelectorAll('.event-preview-layer').length`),2);
      assert.ok(await evaluate(page,`document.documentElement.scrollWidth<=window.innerWidth`));
      await evaluate(page,`document.querySelector('#preview-outcomes [data-event-index]').click()`);
      assert.equal(await evaluate(page,`document.querySelectorAll('.event-preview-layer').length`),0);
      await page.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
      await delay(150);
    }
    // Commit/revisit is the imported/historical path: it must rebuild from the
    // resolver preview, not reuse an end-of-turn card snapshot.
    await evaluate(page,`document.getElementById('commit-turn').click()`);
    await delay(100);
    console.log(JSON.stringify({status:'event-hover-browser-valid',format,...result}));
  }
}
