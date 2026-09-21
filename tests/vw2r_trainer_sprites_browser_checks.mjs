import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkVw2rTrainerSprites({page,evaluate,delay,tempRoot}) {
  await evaluate(page, `(async () => {
    const wait = async (fn,label) => { for(let i=0;i<600;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error(label); };
    window.waitForTrainerArt = wait;
    await wait(()=>document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]:not(:disabled)'), 'VW2R picker');
    document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]').click();
    await wait(()=>document.getElementById('starter-dialog').open,'starter picker');
    document.querySelector('[data-starter-id="snivy"]').click();
    document.getElementById('new-plan').click();
    await wait(()=>document.getElementById('trainer-selector-dialog').open,'trainer selector');
  })()`,true);
  const result = await evaluate(page, `(async () => {
    let portraits=0,alternatives=0,wild=0;
    const tabs=[...document.querySelectorAll('.trainer-split-tabs button')];
    for(const tab of tabs){
      tab.click();
      const images=[...document.querySelectorAll('.trainer-options .trainer-portrait')];
      if(images.some(image=>image.crossOrigin!==null)) throw new Error('Trainer images must not require CORS pixel access');
      images.forEach(image=>image.loading='eager');
      await window.waitForTrainerArt(()=>images.every(image=>image.complete&&image.naturalWidth>0),tab.textContent+' portrait load');
      if([...document.querySelectorAll('.trainer-options .trainer-sprite-missing')].some(label=>label.textContent==='Sprite unavailable')) throw new Error(tab.textContent+' missing art');
      portraits+=images.length;
      alternatives+=document.querySelectorAll('.trainer-portrait-alternatives').length;
      wild+=[...document.querySelectorAll('.trainer-sprite-missing')].filter(label=>label.textContent==='Wild encounter').length;
    }
    tabs[0].click();
    const first=[...document.querySelectorAll('.trainer-options .trainer-option')].slice(0,2);
    const subjects=first.map(row=>new URL(row.querySelector('.trainer-portrait').src).searchParams.get('subject'));
    await window.waitForTrainerArt(()=>tabs.every(tab=>{const image=tab.querySelector('.trainer-split-badge');return image?.complete&&image.naturalWidth>0&&!image.hidden;}),'all ten VW2R badges load');
    const badges=tabs.map(tab=>new URL(tab.querySelector('img').src).searchParams.get('style'));
    return {tabs:tabs.length,portraits,alternatives,wild,subjects,badges};
  })()`,true);
  assert.equal(result.tabs,10);
  assert.deepEqual(result.badges,Array(10).fill('b2w2-unova'));
  assert.ok(result.portraits>350);
  assert.deepEqual(result.subjects,['hugh','youngster']);
  assert.equal(result.wild,2);
  // The three Nate/Rosa rows are player-partner choices, excluded from enemy selection.
  assert.equal(result.alternatives,1,JSON.stringify(result));
  for(const width of [1280,390]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});
    await delay(300);
    const overflow=await evaluate(page, `(()=>{const list=document.querySelector('.trainer-options');return list.scrollWidth-list.clientWidth})()`);
    assert.ok(overflow<=1);
    const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(tempRoot,'vw2r-trainer-sprites-'+width+'.png'),Buffer.from(shot.data,'base64'));
  }
  assert.deepEqual(page.events.filter(event=>event.method==='Runtime.exceptionThrown'),[]);
  console.log(JSON.stringify({status:'vw2r-trainer-sprites-browser-valid',...result}));
}
