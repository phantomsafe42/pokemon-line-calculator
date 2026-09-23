import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkDoraDiegoPortrait({page,evaluate,tempRoot}) {
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  const result=await evaluate(page, `(async()=>{
    const wait=async(fn,label)=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error(label);};
    await wait(()=>document.querySelector('.game-picker-option[data-game-id="platinum-kaizo"]:not(:disabled)'), 'PK ready');
    document.querySelector('.game-picker-option[data-game-id="platinum-kaizo"]').click();
    await wait(()=>document.getElementById('starter-dialog').open,'starter');
    document.querySelector('[data-starter-id="turtwig"]').click();
    document.getElementById('new-plan').click();
    await wait(()=>document.getElementById('trainer-selector-dialog').open,'selector');
    let row;
    for(const tab of document.querySelectorAll('.trainer-split-tabs button')) {
      tab.click();
      row=document.querySelector('[data-trainer-id="platinum-kaizo-trainer-0166"]');
      if(row)break;
    }
    if(!row)throw Error('Dora and Diego absent');
    row.scrollIntoView({block:'center'});
    await wait(()=>row.querySelector('.trainer-portrait')?.naturalWidth>0,'approved portrait loaded');
    const img=row.querySelector('.trainer-portrait');await img.decode();
    return {width:img.naturalWidth,height:img.naturalHeight,url:img.src,missing:row.querySelectorAll('.trainer-sprite-missing').length};
  })()`,true);
  assert.equal(result.width,80);assert.equal(result.height,80);assert.equal(result.missing,0);
  assert.equal(new URL(result.url).searchParams.get('edition'),'beta');
  const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await fs.writeFile(path.join(tempRoot,'dora-diego-approved-portrait.png'),Buffer.from(shot.data,'base64'));
  assert.deepEqual(page.events.filter(event=>event.method==='Runtime.exceptionThrown'),[]);
  console.log(JSON.stringify({status:'dora-diego-portrait-browser-valid',...result}));
}

export async function checkTrainerParticipants({page, evaluate, delay, tempRoot}) {
  const records = JSON.parse(await fs.readFile(new URL('../src/generated/datasets/pokemon-unbound/trainers.json', import.meta.url))).records;
  const expected = Object.fromEntries(Object.values(records).filter(r => r.trainerVisualParticipants?.length)
    .map(r => [r.id, r.trainerVisualParticipants.map(p => p.label)]));
  await evaluate(page, `(async () => {
    window.waitForPortraitTest = async (fn,label) => {for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error(label);};
    const wait=window.waitForPortraitTest;
    await wait(()=>document.querySelector('.game-picker-option[data-game-id="pokemon-unbound"]:not(:disabled)'), 'Unbound ready');
    document.querySelector('.game-picker-option[data-game-id="pokemon-unbound"]').click();
    await wait(()=>document.getElementById('starter-dialog').open,'starter');
    document.querySelector('[data-starter-id="beldum"]').click();
    document.getElementById('new-plan').click();
    await wait(()=>document.getElementById('trainer-selector-dialog').open,'trainer selector');
  })()`, true);
  const seen = new Set();
  const tabCount = await evaluate(page, `document.querySelectorAll('.trainer-split-tabs button').length`);
  for (let tab=0; tab<tabCount; tab++) {
    const ids = await evaluate(page, `(() => {
      document.querySelectorAll('.trainer-split-tabs button')[${tab}].click();
      return [...document.querySelectorAll('.trainer-option')].filter(row=>row.querySelector('.trainer-portrait-participants')).map(row=>row.dataset.trainerId);
    })()`);
    for (const id of ids) {
      const actual = await evaluate(page, `(async () => {
        const row=document.querySelector('[data-trainer-id=${JSON.stringify(id)}]');
        row.scrollIntoView({block:'center'});
        await window.waitForPortraitTest(()=>[...row.querySelectorAll('.trainer-portrait')].every(i=>i.complete&&i.naturalWidth>0),'participant images ${id}');
        return {labels:[...row.querySelectorAll('.trainer-portrait')].map(i=>i.alt), placeholders:row.querySelectorAll('.trainer-sprite-missing').length, blocks:row.querySelectorAll('.trainer-block').length};
      })()`, true);
      assert.deepEqual(actual.labels, expected[id], id);
      assert.equal(actual.placeholders, 0, id);
      assert.equal(actual.blocks, 1, 'Portraits must not split the encounter roster');
      seen.add(id);
    }
  }
  assert.equal(seen.size, 17);
  await evaluate(page, `document.querySelector('.trainer-split-tabs button').click()`);
  for (const width of [1280,390,320]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});
    await evaluate(page, `document.querySelector('[data-trainer-id="pokemon-unbound-trainer-0139"]').scrollIntoView({block:'start'})`);
    await delay(250);
    const geometry=await evaluate(page, `(() => {
      const row=document.querySelector('[data-trainer-id="pokemon-unbound-trainer-0139"]');
      const frames=[...row.querySelectorAll('.trainer-portrait-participants > .trainer-portrait-frame')].map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height};});
      const list=document.querySelector('.trainer-options');
      return {frames,overflow:list.scrollWidth-list.clientWidth};
    })()`);
    assert.ok(geometry.overflow<=1, JSON.stringify({width,geometry}));
    assert.equal(geometry.frames.length,2);
    assert.ok(geometry.frames[1].top>=geometry.frames[0].bottom, 'Portraits do not overlap');
    assert.ok(geometry.frames.every(r=>r.width>50&&r.height>=120), 'Portraits retain readable dimensions');
    const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(tempRoot,`trainer-participants-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  if(process.env.PLC_TRAINER_ASSET_ROOT) {
    const fixtures=JSON.parse(await fs.readFile(path.join(process.env.PLC_TRAINER_ASSET_ROOT,'tools/fixtures/trainer-semantic-queries.json')));
    const decoded=await evaluate(page, `(async()=>{
      const client=PokemonAssetGateway.createClient();
      const rows=${JSON.stringify(fixtures.cases)};
      document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
      const panel=document.createElement('section');panel.style='position:fixed;inset:0;background:#171e28;z-index:99999;display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:16px;overflow:auto;';document.body.append(panel);
      await Promise.all(rows.map(async row=>{const box=document.createElement('div');const image=new Image();image.src=client.assetUrl(row.query);image.style='width:100%;height:130px;object-fit:contain;image-rendering:pixelated;';box.append(image,document.createTextNode(row.query.gameStyle+' / '+row.query.subject+' / '+row.query.gender+' / '+row.query.variant));panel.append(box);await image.decode();if(!image.naturalWidth)throw Error('Undecoded portrait');}));
      return rows.length;
    })()`,true);
    assert.equal(decoded,24);
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
    await delay(500);
    const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(tempRoot,'trainer-semantic-artwork.png'),Buffer.from(shot.data,'base64'));
    console.log(JSON.stringify({status:'trainer-semantic-browser-decode-valid',queries:decoded}));
  }
  assert.deepEqual(page.events.filter(event=>event.method==='Runtime.exceptionThrown'),[]);
  console.log(JSON.stringify({status:'trainer-participants-browser-valid',pairs:seen.size,portraits:seen.size*2,widths:[1280,390,320]}));
}
