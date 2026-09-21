import assert from 'node:assert/strict';

// Real asset requests are held or failed through CDP to exercise recovery.
export async function checkTrainerBadgeRecovery({page,evaluate,delay}) {
  await page.send("Fetch.enable",{patterns:[{urlPattern:"*badge-icon*",requestStage:"Request"}]});
  await evaluate(page, `(async()=>{
    const wait=async f=>{for(let i=0;i<600;i++){if(f())return;await new Promise(r=>setTimeout(r,50));}throw Error('timeout');};
    await wait(()=>document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]:not(:disabled)'));
    document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]').click();
    await wait(()=>document.getElementById('starter-dialog').open);
    document.querySelector('[data-starter-id="snivy"]').click();
    document.getElementById('new-plan').click();
    await wait(()=>document.getElementById('trainer-selector-dialog').open);
  })()`,true);

  const waitFor=async fn=>{for(let i=0;i<600;i++){const value=fn();if(value)return value;await delay(25);}throw Error('Paused badge request timeout: '+JSON.stringify(paused().map(e=>e.params.request.url))+' DOM '+JSON.stringify(await evaluate(page,`[...document.querySelectorAll('.trainer-split-tabs button')].map(t=>({text:t.textContent,state:t.dataset.badgeStatus,url:t.querySelector('img')?.src}))`)));};
  const paused=()=>page.events.filter(e=>e.method==='Fetch.requestPaused');
  const checkLabels=async()=>{
    const result=await evaluate(page,`[...document.querySelectorAll('.trainer-split-tabs button')].map(t=>({text:t.innerText,status:t.dataset.badgeStatus}))`);
    assert.equal(result.length,10); assert.ok(result.every(t=>t.text.trim()),JSON.stringify(result));
  };
  await waitFor(()=>paused().length>=10); await checkLabels();
  // Hold every response past the deadline, then permit the automatic retry.
  await waitFor(()=>paused().length>=20); await checkLabels();
  for(const event of paused().slice(10,20)) await page.send('Fetch.continueRequest',{requestId:event.params.requestId});
  await evaluate(page,`(async()=>{for(let i=0;i<600;i++){if(document.querySelectorAll('.trainer-split-tabs [data-badge-status="loaded"]').length===10)return;await new Promise(r=>setTimeout(r,50));}throw Error('Badges did not recover after stalled request');})()`,true);
  console.log('stalled-badge-retry-valid: all 10 actual images loaded');
  await evaluate(page,`document.getElementById('trainer-selector-dialog').close();`); await delay(100);
  const before=paused().length;
  await page.send('Network.setCacheDisabled',{cacheDisabled:true});
  // A fresh document discards the in-memory image cache as well as HTTP cache.
  const contexts = page.events.filter(e=>e.method==='Runtime.executionContextCreated').length;
  await page.send('Page.reload',{ignoreCache:true});
  await waitFor(()=>page.events.filter(e=>e.method==='Runtime.executionContextCreated').length>contexts);
  await evaluate(page,`(async()=>{
    const wait=async fn=>{for(let i=0;i<600;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Game reload timeout');};
    await wait(()=>document.getElementById('game-dialog')?.open && document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]:not(:disabled)'));
    document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]').click();
    await wait(()=>!document.getElementById('game-dialog').open);
    document.getElementById('new-plan').click();
    await wait(()=>document.getElementById('trainer-selector-dialog').open);
  })()`,true);
  await waitFor(()=>paused().length>=before+10);
  for(const event of paused().slice(before,before+10)) await page.send('Fetch.failRequest',{requestId:event.params.requestId,errorReason:'Failed'});
  await waitFor(()=>paused().length>=before+20); await checkLabels();
  for(const event of paused().slice(before+10,before+20)) await page.send('Fetch.failRequest',{requestId:event.params.requestId,errorReason:'Failed'});
  await delay(100); await checkLabels();
  const failed=await evaluate(page,`document.querySelectorAll('.trainer-split-tabs [data-badge-status="unavailable"]').length`);
  assert.equal(failed,10); console.log('failed-badge-fallback-valid: all 10 tabs remain readable');
  await page.send('Fetch.disable');
}
