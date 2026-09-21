import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkBoxCards({ page, evaluate, delay, tempRoot }) {
  await evaluate(page, `(async () => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    document.getElementById('boxes-tab').click();
    document.getElementById('showdown-open').click();
    document.getElementById('showdown-text').value = 'Box Layout (Virizion) (M) @ Leftovers\\nAbility: Justified\\nLevel: 44\\nModest Nature\\nEVs: 252 SpA / 4 SpD / 252 Spe\\nIVs: 0 Atk\\n- Giga Drain\\n- Protect\\n- Quick Attack\\n- Swords Dance\\n\\nDitto\\nLevel: 100\\nHardy Nature\\n- Transform\\n\\nWWWWWWWWWW (Rotom-Frost)\\nLevel: 50\\nModest Nature\\n- Blizzard';
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
      training:[...card.querySelectorAll('.box-stat-training')].map(el=>[...el.children].map(part=>part.textContent)),
      names:[...card.querySelectorAll('.box-pokemon-move strong')].map(el=>el.textContent),
      types:[...card.querySelectorAll('.box-pokemon-move')].map(el=>el.dataset.moveType),
      meta:[...card.querySelectorAll('.box-pokemon-move small')].map(el=>el.textContent),
      details:[...card.querySelectorAll('.static-detail strong')].map(el=>el.textContent),
      nature:card.querySelector('.combatant-stat-name-buff')?.textContent,
      species:card.querySelector('.combatant-species').textContent,
      checkboxes:card.querySelectorAll('input[type=checkbox]').length,
      empty:[...empty.querySelectorAll('.box-pokemon-move strong')].map(el=>el.textContent)};
  })()`);
  assert.equal(before.stats.length,5); assert.ok(before.stats.every(Number.isFinite));
  assert.deepEqual(before.training,[['0IV','0EV'],['31IV','0EV'],['31IV','252EV'],['31IV','4EV'],['31IV','252EV']]);
  assert.deepEqual(before.names,['Giga Drain','Protect','Quick Attack','Swords Dance']);
  assert.deepEqual(before.types,['grass','normal','normal','normal']);
  assert.match(before.meta[0],/^\d+ BP · \d+ PP$/); assert.match(before.meta[1],/^\d+ PP$/);
  assert.equal(before.details[0],'44','Showdown does not invent an EXP total'); assert.ok(Number(before.details[1])>0);
  assert.deepEqual(before.details.slice(2),['Justified','Leftovers']);
  assert.equal(before.checkboxes,0);
  assert.equal(before.nature,'SpA'); assert.equal(before.species,'Virizion');
  assert.deepEqual(before.empty,['Transform','—','—','—']);
  for (const width of [2560,1800,1280,800,390,320]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(page,`[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Box Layout').scrollIntoView({block:'center'})`);
    await delay(200);
    const geometry=await evaluate(page,`(() => {
      const card=[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Box Layout');
      const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const grid=card.parentElement, next=card.nextElementSibling;
      const actions=card.querySelector('.box-card-actions');
      const name=card.querySelector('.combatant-name'),species=card.querySelector('.combatant-species');
      const value=card.querySelector('.combatant-stat-value'),training=card.querySelector('.box-stat-training > span');
      return {card:rect(card),left:rect(card.querySelector('.box-pokemon-summary')),right:rect(card.querySelector('.box-pokemon-loadout')),
        sprite:rect(card.querySelector('.combatant-sprite')),icons:[...card.querySelectorAll('.combatant-type img')].map(rect),
        stats:[...card.querySelectorAll('.combatant-stat')].map(rect),moves:[...card.querySelectorAll('.box-pokemon-move')].map(rect),
        buttons:[...actions.children].map(rect),actions:rect(actions),
        typeRequests:[...card.querySelectorAll('.combatant-type img')].map(el=>el.src),
        speciesBelow:rect(species).y>=rect(name).bottom,
        trainingColors:[getComputedStyle(value).color,getComputedStyle(training).color],
        moveColor:getComputedStyle(card.querySelector('.box-pokemon-move')).backgroundColor,
        next:rect(next),grid:rect(grid),gridScrollWidth:grid.scrollWidth,
        overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.equal(geometry.overflow,false,`No page overflow at ${width}`);
    assert.ok(geometry.stats.every(stat=>Math.abs(stat.y-geometry.stats[0].y)<1),'Stats remain one row');
    assert.ok(geometry.moves.every((move,i)=>!i || move.y>=geometry.moves[i-1].bottom),'Moves are stacked');
    assert.equal(geometry.card.width,820,'Fixed card width');
    assert.equal(geometry.sprite.width,114); assert.equal(geometry.sprite.height,114);
    assert.ok(geometry.icons.every(icon=>Math.abs(icon.width-30.8)<.1 && Math.abs(icon.height-30.8)<.1),'SV symbol icon dimensions');
    assert.ok(geometry.typeRequests.every(url=>url.includes('presentation=symbol') && url.includes('style=sv')),'Symbol assets requested');
    assert.ok(geometry.right.x>=geometry.left.right-1,'Columns never compress or stack');
    assert.ok(geometry.buttons.every(button=>button.height>=44 && Math.abs(button.width-geometry.buttons[0].width)<1),'Equal-sized actions');
    assert.ok(Math.abs(geometry.actions.bottom-(geometry.left.bottom-14.4))<1,'Actions anchored to padded bottom');
    assert.ok(geometry.speciesBelow,'Species below nickname');
    assert.equal(geometry.trainingColors[0],geometry.trainingColors[1],'IV/EV number color');
    assert.equal(geometry.moveColor,'rgb(58, 80, 52)','Grass move background');
    if (geometry.grid.width>=1688) assert.equal(geometry.next.y,geometry.card.y,'Whole cards share a row when space permits');
    else assert.ok(geometry.next.y>=geometry.card.bottom,'Whole cards wrap onto another row');
    if (width<900) assert.ok(geometry.gridScrollWidth>geometry.grid.width,'Narrow view scrolls only the Box grid');
    const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(tempRoot,`box-cards-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  // Long names and form identities must never extend into the adjacent details.
  const longName=await evaluate(page,`(() => {
    const card=[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='WWWWWWWWWW');
    const name=card.querySelector('.box-pokemon-name'),details=card.querySelector('.box-pokemon-details');
    const range=document.createRange();range.selectNodeContents(name);
    return {right:Math.max(...[...range.getClientRects()].map(r=>r.right)),detailsLeft:details.getBoundingClientRect().left,
      sprite:card.querySelector('.combatant-sprite img').src,species:card.querySelector('.combatant-species').textContent};
  })()`);
  assert.ok(longName.right<=longName.detailsLeft,'Long names do not overlap details');
  assert.match(longName.species,/Rotom/); assert.match(longName.sprite,/appearanceId=/);
  await evaluate(page,`[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Box Layout').querySelector('.box-card-actions button').click()`);
  assert.equal(await evaluate(page,`document.getElementById('pokemon-editor-dialog').open`),true,'Edit remains available');
  await evaluate(page,`document.getElementById('pokemon-editor-dialog').close()`);
  await evaluate(page,`[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Box Layout').querySelectorAll('.box-card-actions button')[1].click()`);
  assert.equal(await evaluate(page,`document.getElementById('showdown-dialog').open`),true,'Showdown remains available');
  assert.match(await evaluate(page,`document.getElementById('showdown-text').value`),/Box Layout \(Virizion\)/);
  await evaluate(page,`document.getElementById('showdown-dialog').close()`);
  // Confirming Erase affects only this disposable fixture, not a user library.
  await evaluate(page,`(() => {
    const original=window.confirm;window.confirm=()=>true;
    try{[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='WWWWWWWWWW').querySelectorAll('.box-card-actions button')[2].click();}
    finally{window.confirm=original;}
  })()`);
  for(let i=0;i<100;i++) {
    if(await evaluate(page,`![...document.querySelectorAll('.box-pokemon-card h3')].some(el=>el.textContent==='WWWWWWWWWW')`))break;
    await delay(50);
  }
  assert.equal(await evaluate(page,`[...document.querySelectorAll('.box-pokemon-card h3')].some(el=>el.textContent==='WWWWWWWWWW')`),false,'Erase remains available');
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  console.log(JSON.stringify({status:'box-card-layout-valid',widths:[2560,1800,1280,800,390,320],...before}));
}
