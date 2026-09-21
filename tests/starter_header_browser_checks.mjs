import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkStarterHeader({page,evaluate,delay,tempRoot}) {
  const wait=async expression=>{for(let i=0;i<400;i++){if(await evaluate(page,expression))return;await delay(100);}throw Error('Starter header timeout: '+expression);};
  const library=()=>evaluate(page,`(async()=>{const {IndexedDbBoxLibraryStore}=await import('./src/boxes/library.js');return new IndexedDbBoxLibraryStore().load();})()`,true);
  const before=await library();
  for(const [game,choices] of [
    ['volt-white-2r',[['snivy','grass'],['tepig','fire'],['oshawott','water']]],
    ['fire-red-omega',[['elekid','electric'],['smoochum','ice'],['magby','fire']]],
    ['pokemon-unbound',[['beldum','steel'],['gible','ground'],['larvitar','dark']]]
  ]) {
    await evaluate(page,`(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();document.getElementById('new-game').click();document.querySelector('[data-game-id="${game}"]').click();})()`);
    await wait(`!document.getElementById('game-dialog').open && !document.getElementById('change-starter').disabled`);
    for(const [id,type] of choices) {
      await evaluate(page,`(()=>{const d=document.getElementById('starter-dialog');if(!d.open)document.getElementById('change-starter').click();document.querySelector('[data-starter-id="${id}"]').click();})()`);
      await wait(`(()=>{const b=document.getElementById('change-starter'),img=b.querySelector('img');return b.dataset.moveType==='${type}'&&img?.complete&&img.naturalWidth>0;})()`);
      assert.ok(await evaluate(page,`document.querySelector('.game-control').contains(document.getElementById('change-starter'))`));
      assert.equal(await evaluate(page,`document.getElementById('change-starter').querySelector('img').alt.toLowerCase()`),id);
      assert.ok(await evaluate(page,`(()=>{const b=document.getElementById('change-starter');return getComputedStyle(b).getPropertyValue('--move-type-bg').trim().length>0;})()`));
    }
  }
  assert.deepEqual(await library(),before,'Starter navigation never changes Box records');
  await page.send('Page.reload');
  await wait(`document.getElementById('game-dialog')?.open && !!document.querySelector('[data-game-id="pokemon-unbound"]')`);
  await evaluate(page,`document.querySelector('[data-game-id="pokemon-unbound"]').click()`);
  await wait(`document.getElementById('change-starter')?.querySelector('img')?.alt==='Larvitar'`);
  assert.equal(await evaluate(page,`document.getElementById('starter-dialog').open`),false,'Remembered starter does not re-prompt');
  for(const width of [1440,1280,390,320]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
    await evaluate(page,`window.scrollTo(0,0)`);
    assert.equal(await evaluate(page,`document.documentElement.scrollWidth>innerWidth`),false,'Header no overflow at '+width);
    const screenshot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(tempRoot,'starter-header-'+width+'.png'),Buffer.from(screenshot.data,'base64'));
  }
  console.log(JSON.stringify({status:'starter-header-browser-valid',choices:9,persistence:true,boxIsolation:true,widths:[1440,1280,390,320]}));
}
