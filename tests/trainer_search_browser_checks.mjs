import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkTrainerSearch({page,evaluate,delay,tempRoot}) {
  const result = await evaluate(page, `(async()=>{
    const wait=async(fn,label)=>{for(let i=0;i<600;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error(label);};
    await wait(()=>document.querySelector('.game-picker-option[data-game-id="platinum-kaizo"]:not(:disabled)'), 'PK picker');
    document.querySelector('.game-picker-option[data-game-id="platinum-kaizo"]').click();
    await wait(()=>document.getElementById('starter-dialog').open,'starter');
    document.querySelector('[data-starter-id="chimchar"]').click(); document.getElementById('new-plan').click();
    await wait(()=>document.getElementById('trainer-selector-dialog').open,'selector');
    const input=document.querySelector('.trainer-search'), list=document.querySelector('.trainer-options'), next=document.querySelector('.trainer-continue');
    const initial=[...list.querySelectorAll('.trainer-option')].map(r=>r.dataset.trainerId);
    const search=async text=>{input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,180));};
    await search('cUpId');
    const pair=list.querySelector('[data-trainer-id="platinum-kaizo-veilstone-tag-battle"]');
    if(!pair || pair.querySelectorAll('.trainer-block').length!==2) throw Error('Combined encounter search');
    if(document.querySelector('.trainer-split-tabs [aria-selected="true"]')) throw Error('Search must deselect all splits');
    pair.click(); if(next.disabled) throw Error('Search result must be selectable');
    await search('not-a-trainer-or-pokemon');
    if(!next.disabled || list.querySelector('.trainer-option') || !list.textContent.includes('No trainers match')) throw Error('Empty search selection guard');
    await search('');
    if(JSON.stringify(initial)!==JSON.stringify([...list.querySelectorAll('.trainer-option')].map(r=>r.dataset.trainerId))) throw Error('Clear must restore split');
    await search('Abomasnow');
    const speciesCount=list.querySelectorAll('.trainer-option').length;
    if(!speciesCount || !list.querySelector('[data-trainer-id="platinum-kaizo-veilstone-tag-battle"]')) throw Error('Game-wide species search');
    await search('Veilstone');
    if(!list.querySelector('[data-trainer-id="platinum-kaizo-veilstone-tag-battle"]')) throw Error('Location search');
    [...document.querySelectorAll('.trainer-split-tabs button')].find(t=>t.title.includes('Maylene')).click();
    if(input.value || !document.querySelector('.trainer-split-tabs [aria-selected="true"]')?.title.includes('Maylene')) throw Error('Split click must clear search');
    await search('Cupid');
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    if(!document.getElementById('trainer-selector-dialog').open) throw Error('Search Enter closed dialog');
    return {speciesCount,initialCount:initial.length};
  })()`,true);
  for(const width of [1280,390,320]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600}); await delay(100);
    const geometry=await evaluate(page,`(()=>{const d=document.getElementById('trainer-selector-dialog'),i=d.querySelector('.trainer-search').getBoundingClientRect(),b=d.querySelector('.trainer-continue').getBoundingClientRect(),r=d.getBoundingClientRect();return {dialog:r.width,input:i.width,inputBottom:i.bottom,buttonLeft:b.left,inputRight:i.right,bottom:r.bottom,overflow:d.scrollWidth-d.clientWidth};})()`);
    assert.ok(geometry.dialog<=width && geometry.input>80 && geometry.inputRight<=geometry.buttonLeft && geometry.inputBottom<=geometry.bottom && geometry.overflow<=1,JSON.stringify(geometry));
    if(width!==320) {const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(path.join(tempRoot,`trainer-search-${width}.png`),Buffer.from(shot.data,'base64'));}
  }
  await evaluate(page,`(async()=>{
    document.querySelector('[data-trainer-id="platinum-kaizo-veilstone-tag-battle"]').click(); document.querySelector('.trainer-continue').click();
    for(let i=0;i<300;i++){if(document.getElementById('plan-context-dialog').open){if(document.getElementById('trainer-select').value!=='platinum-kaizo-veilstone-tag-battle')throw Error('Wrong continued encounter');return;}await new Promise(r=>setTimeout(r,50));}throw Error('Continue timed out');
  })()`,true);
  assert.deepEqual(page.events.filter(e=>e.method==='Runtime.exceptionThrown'),[]);
  console.log(JSON.stringify({status:'trainer-search-browser-valid',...result,widths:[1280,390,320]}));
}
