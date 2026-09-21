import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkBoxCards({ page, evaluate, delay, tempRoot }) {
  await evaluate(page, `(async () => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    document.getElementById('boxes-tab').click();
    document.getElementById('showdown-open').click();
    document.getElementById('showdown-text').value = 'Box Layout (Virizion) (M) @ Leftovers\\nAbility: Justified\\nLevel: 44\\nModest Nature\\n- Giga Drain\\n- Protect\\n- Quick Attack\\n- Swords Dance\\n\\nDitto\\nLevel: 100\\nHardy Nature\\n- Transform';
    document.getElementById('import-showdown').click();
    for (let i=0;i<150;i++) {
      if (!document.getElementById('showdown-dialog').open && [...document.querySelectorAll('.box-pokemon-card h3')].some(el=>el.textContent==='Box Layout')) return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Box-card fixture import timed out');
  })()`, true);
  const before = await evaluate(page, `(() => {
    const card=[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Box Layout');
    const empty=[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Ditto');
    return {stats:[...card.querySelectorAll('.combatant-stat-value')].map(el=>Number(el.textContent)),
      stages:[...card.querySelectorAll('.combatant-stat-stage')].map(el=>el.textContent),
      names:[...card.querySelectorAll('.box-pokemon-move')].map(el=>el.textContent),
      details:[...card.querySelectorAll('.static-detail strong')].map(el=>el.textContent),
      nature:card.querySelector('.combatant-stat-name-buff')?.textContent,
      species:card.querySelector('.combatant-species').textContent,
      empty:[...empty.querySelectorAll('.box-pokemon-move')].map(el=>el.textContent)};
  })()`);
  assert.equal(before.stats.length,5); assert.ok(before.stats.every(Number.isFinite));
  assert.deepEqual(before.stages,Array(5).fill('—'));
  assert.deepEqual(before.names,['Giga Drain','Protect','Quick Attack','Swords Dance']);
  assert.deepEqual(before.details,['Justified','Leftovers']);
  assert.equal(before.nature,'SpA'); assert.equal(before.species,'Virizion');
  assert.deepEqual(before.empty,['Transform','—','—','—']);
  for (const width of [2560,1280,390,320]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(page,`[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Box Layout').scrollIntoView({block:'center'})`);
    await delay(200);
    const geometry=await evaluate(page,`(() => {
      const card=[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Box Layout');
      const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      return {card:rect(card),left:rect(card.querySelector('.box-pokemon-summary')),right:rect(card.querySelector('.box-pokemon-loadout')),
        sprite:rect(card.querySelector('.combatant-sprite')),icons:[...card.querySelectorAll('.combatant-type img')].map(rect),
        stats:[...card.querySelectorAll('.combatant-stat')].map(rect),moves:[...card.querySelectorAll('.box-pokemon-move')].map(rect),
        overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.equal(geometry.overflow,false,`No page overflow at ${width}`);
    assert.ok(geometry.stats.every(stat=>Math.abs(stat.y-geometry.stats[0].y)<1),'Stats remain one row');
    assert.ok(geometry.moves.every((move,i)=>!i || move.y>=geometry.moves[i-1].bottom),'Moves are stacked');
    assert.equal(geometry.sprite.width,76); assert.equal(geometry.sprite.height,76);
    assert.ok(geometry.icons.every(icon=>icon.width===85 && icon.height===17),'PLC type icon dimensions');
    if (width>=1280) assert.ok(geometry.right.x>=geometry.left.right-1,'Two columns');
    else assert.ok(geometry.right.y>=geometry.left.bottom-1,'Mobile stacks columns');
    const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(tempRoot,`box-cards-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  await evaluate(page,`[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Box Layout').querySelector('.box-card-actions button').click()`);
  assert.equal(await evaluate(page,`document.getElementById('pokemon-editor-dialog').open`),true,'Edit remains available');
  await evaluate(page,`document.getElementById('pokemon-editor-dialog').close()`);
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  console.log(JSON.stringify({status:'box-card-layout-valid',widths:[2560,1280,390,320],...before}));
}
