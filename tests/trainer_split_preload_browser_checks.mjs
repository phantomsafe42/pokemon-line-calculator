import assert from 'node:assert/strict';

export async function checkTrainerSplitPreload({ page, evaluate, delay, gameId = 'pokemon-unbound' }) {
  const count = gameId === 'pokemon-unbound' ? 11 : 10;
  const result = await evaluate(page, `(async () => {
    const wait = async (fn, label) => { for(let i=0;i<600;i++) { if(fn()) return; await new Promise(r=>setTimeout(r,50)); } throw Error(label); };
    await wait(()=>document.querySelector('.game-picker-option[data-game-id="${gameId}"]:not(:disabled)'), 'game picker');
    document.querySelector('.game-picker-option[data-game-id="${gameId}"]').click();
    await wait(()=>document.getElementById('starter-dialog').open, 'starter');
    // Keep the selector closed while the game-start preload finishes.
    await wait(()=>performance.getEntriesByType('resource').filter(e=>e.name.includes('kind=badge-icon')).length >= ${count - (gameId === 'pokemon-unbound' ? 1 : 0)}, 'badge preload');
    const before = performance.getEntriesByType('resource').filter(e=>e.name.includes('kind=badge-icon')).map(e=>({url:e.name,start:e.startTime,duration:e.duration}));
    document.querySelector('[data-starter-id="${gameId === 'pokemon-unbound' ? 'beldum' : 'snivy'}"]').click();
    const start = performance.now(); document.getElementById('new-plan').click();
    await wait(()=>document.getElementById('trainer-selector-dialog').open, 'selector');
    const tabs = [...document.querySelectorAll('.trainer-split-tabs button')];
    const readyOnOpen = tabs.filter(t=>t.dataset.badgeStatus==='loaded').length;
    await wait(()=>tabs.length===${count} && tabs.every(t=>t.dataset.badgeStatus==='loaded'), 'all split images');
    const elapsed = performance.now()-start;
    const images = tabs.map(t=>{const img=t.querySelector('img'), r=img.getBoundingClientRect(); return {label:t.title,src:img.src,width:r.width,height:r.height,fit:getComputedStyle(img).objectFit,loaded:img.complete&&img.naturalWidth>0};});
    document.getElementById('trainer-selector-dialog').close();
    await new Promise(r=>setTimeout(r,100));
    document.getElementById('new-plan').click();
    await wait(()=>document.getElementById('trainer-selector-dialog').open, 'reopened selector');
    return {before,readyOnOpen,elapsed,images,reopenedReady:document.querySelectorAll('.trainer-split-tabs [data-badge-status="loaded"]').length};
  })()`, true);
  assert.equal(result.readyOnOpen, count, JSON.stringify(result));
  assert.equal(result.reopenedReady, count);
  assert.ok(result.images.every(i=>i.loaded && i.src.includes('/0.8.0-dev.1/') && Math.abs(i.width-57.6)<.1 && Math.abs(i.height-57.6)<.1 && i.fit==='contain'));
  await delay(200);
  const badgeRequests = page.events.filter(e=>e.method==='Network.requestWillBeSent' && e.params.request.url.includes('kind=badge-icon'));
  assert.equal(badgeRequests.length, result.before.length, 'Opening and reopening must reuse preloaded images');
  for (const width of [1280,390]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600}); await delay(100);
    const geometry=await evaluate(page,`(()=>{const d=document.getElementById('trainer-selector-dialog'),l=d.querySelector('.trainer-options');return {width:d.getBoundingClientRect().width,overflow:l.scrollWidth-l.clientWidth};})()`);
    assert.ok(geometry.width<=width && geometry.overflow<=1, JSON.stringify(geometry));
  }
  assert.deepEqual(page.events.filter(e=>e.method==='Runtime.exceptionThrown'),[]);
  console.log(JSON.stringify({status:'split-preload-valid',gameId,...result}));
}
