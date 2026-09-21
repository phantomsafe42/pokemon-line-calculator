import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { addBox, addParty, createEmptyBoxLibrary } from '../src/boxes/library.js';

export async function checkBoxCards({ page, evaluate, delay, tempRoot }) {
  await evaluate(page, `(async () => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    document.getElementById('boxes-tab').click();
    document.getElementById('open-box-import').click();
    document.getElementById('showdown-open').click();
    document.getElementById('showdown-text').value = 'Box Layout (Virizion) (M) @ Leftovers\\nAbility: Justified\\nLevel: 44\\nModest Nature\\nEVs: 252 SpA / 4 SpD / 252 Spe\\nIVs: 0 Atk\\n- Giga Drain\\n- Protect\\n- Quick Attack\\n- Swords Dance\\n\\nDitto\\nLevel: 100\\nHardy Nature\\n- Transform\\n\\nWWWWWWWWWW (Rotom-Frost)\\nLevel: 50\\nModest Nature\\n- Blizzard';
    document.getElementById('import-showdown').click();
    for (let i=0;i<150;i++) {
      if (!document.getElementById('showdown-dialog').open) for (const toggle of document.querySelectorAll('.box-expand[aria-expanded="false"]')) toggle.click();
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
  const segments=await evaluate(page,`(()=>{const card=[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Box Layout');return [...card.querySelectorAll('.box-pokemon-move')].map(move=>[...move.querySelectorAll('.move-icon img')].map(image=>image.alt));})()`);
  assert.deepEqual(segments,[['grass','special'],['normal','status'],['normal','physical'],['normal','status']],'Detail moves use actual type and category icon segments');
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
        next:rect(next),third:rect(next.nextElementSibling),grid:rect(grid),gridScrollWidth:grid.scrollWidth,
        overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.equal(geometry.overflow,false,`No page overflow at ${width}`);
    assert.ok(geometry.stats.every(stat=>Math.abs(stat.y-geometry.stats[0].y)<1),'Stats remain one row');
    assert.ok(geometry.moves.every((move,i)=>!i || move.y>=geometry.moves[i-1].bottom),'Moves are stacked');
    assert.equal(geometry.card.width,800,'Fixed card width');
    assert.equal(geometry.left.width,475.5,'Left column retains its approved width');
    if (width===2560) assert.equal(geometry.third.y,geometry.card.y,'Three cards fit at the user viewport');
    assert.equal(geometry.sprite.width,114); assert.equal(geometry.sprite.height,114);
    assert.ok(geometry.icons.every(icon=>Math.abs(icon.width-30.8)<.1 && Math.abs(icon.height-30.8)<.1),'SV symbol icon dimensions');
    assert.ok(geometry.typeRequests.every(url=>url.includes('presentation=symbol') && url.includes('style=sv')),'Symbol assets requested');
    assert.ok(geometry.right.x>=geometry.left.right-1,'Columns never compress or stack');
    assert.ok(geometry.buttons.every(button=>button.height>=44 && Math.abs(button.width-geometry.buttons[0].width)<1),'Equal-sized actions');
    assert.ok(Math.abs(geometry.actions.bottom-(geometry.left.bottom-14.4))<1,'Actions anchored to padded bottom');
    assert.ok(geometry.speciesBelow,'Species below nickname');
    assert.equal(geometry.trainingColors[0],geometry.trainingColors[1],'IV/EV number color');
    assert.equal(geometry.moveColor,'rgb(58, 80, 52)','Grass move background');
    if (geometry.grid.width>=1648) assert.equal(geometry.next.y,geometry.card.y,'Whole cards share a row when space permits');
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
  assert.equal(await evaluate(page,`[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='Box Layout').querySelector('.box-card-actions').textContent`),'EditErase');
  // Confirming Erase affects only this disposable fixture, not a user library.
  await evaluate(page,`(() => {
    const original=window.confirm;window.confirm=()=>true;
    try{[...document.querySelectorAll('.box-pokemon-card')].find(el=>el.querySelector('h3').textContent==='WWWWWWWWWW').querySelectorAll('.box-card-actions button')[1].click();}
    finally{window.confirm=original;}
  })()`);
  for(let i=0;i<100;i++) {
    if(await evaluate(page,`![...document.querySelectorAll('.box-pokemon-card h3')].some(el=>el.textContent==='WWWWWWWWWW')`))break;
    await delay(50);
  }
  assert.equal(await evaluate(page,`[...document.querySelectorAll('.box-pokemon-card h3')].some(el=>el.textContent==='WWWWWWWWWW')`),false,'Erase remains available');
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  console.log(JSON.stringify({status:'box-card-layout-valid',widths:[2560,1800,1280,800,390,320],...before}));
  await checkPartyEditing({page,evaluate,delay,tempRoot});
}

async function checkPartyEditing({page,evaluate,delay,tempRoot}) {
  const stats = n => Object.fromEntries(['hp','atk','def','spa','spd','spe'].map(key=>[key,n]));
  const pokemon = Array.from({length:7},(_,i)=>({id:`party-edit-${i}`,speciesId:'ditto',displayName:'Ditto',nickname:`Member ${i+1}`,level:30,
    natureId:'hardy',abilityId:'imposter',baseStats:stats(48),ivs:stats(31),evs:stats(0),moves:[]}));
  const added=addBox(createEmptyBoxLibrary(),'volt-white-2r',{name:'Party edit fixture',pokemon,partyPokemonIds:[pokemon[0].id]});
  const second=addParty(added.library,'volt-white-2r',added.boxId,[pokemon[1].id],'Other party');
  const box=Object.values(second.library.games)[0].boxes[added.boxId];
  const root=`document.querySelector('.box-card[data-box-id="${box.id}"]')`;
  const row=id=>`${root}.querySelector('.party-card[data-party-id="${id}"]')`;
  const picker=i=>`${root}.querySelector('.box-pokemon-card[data-pokemon-id="party-edit-${i}"] .box-party-select')`;
  await evaluate(page,`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify(second.library))}],'party-test.json',{type:'application/json'}));const input=document.getElementById('import-boxes');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  for(let i=0;i<100 && !(await evaluate(page,`Boolean(${root})`));i++) await delay(50);
  assert.equal(await evaluate(page,`Boolean(${root})`),true);
  await evaluate(page,`${root}.querySelector('.box-expand').click()`);
  const firstId=box.partyOrder[0];
  const toggle=async i=>{
    await evaluate(page,`${picker(i)}.click()`);
    for(let j=0;j<100 && await evaluate(page,`${picker(i)}.getAttribute('aria-disabled')==='true'`);j++) await delay(30);
  };
  const members=async id=>evaluate(page,`[...${row(id)}.querySelectorAll('.party-card-grid > article')].map(e=>e.dataset.pokemonId)`);
  const initial=await evaluate(page,`(()=>{const row=${row(firstId)};return {buttons:[...row.querySelectorAll('.party-card-header button')].map(e=>e.textContent),controls:[...row.querySelector('.context-pokemon-actions').children].map(e=>e.tagName+':'+(e.textContent==='Edit'?'Edit':e.className)),pickers:document.querySelectorAll('.box-party-select').length};})()`);
  assert.deepEqual(initial.buttons,['Edit','Delete']);assert.equal(initial.pickers,0);
  assert.deepEqual(initial.controls,['SELECT:context-pre-item','SELECT:context-pre-status','BUTTON:Edit']);
  await evaluate(page,`${row(firstId)}.querySelector('.party-edit').click()`);
  assert.equal(await evaluate(page,`${picker(0)}.getAttribute('aria-pressed')`),'true');
  assert.equal(await evaluate(page,`document.querySelectorAll('.box-party-select').length`),7,'Only this Box is selectable');
  await toggle(0);assert.deepEqual(await members(firstId),[]);
  await toggle(1);assert.deepEqual(await members(firstId),['party-edit-1']);
  assert.deepEqual(await members(second.partyId),['party-edit-1'],'Shared member does not mutate another Party');
  for(const i of [0,2,3,4,5]) await toggle(i);
  await toggle(6);assert.equal((await members(firstId)).length,6,'Six-member limit');
  assert.equal(await evaluate(page,`${picker(6)}.getAttribute('aria-pressed')`),'false');
  await toggle(3);await toggle(6);
  assert.deepEqual(await members(firstId),['party-edit-1','party-edit-0','party-edit-2','party-edit-4','party-edit-5','party-edit-6'],'New members append without disturbing order');
  // Keyboard activation uses a native, whole-card toggle without trapping card actions.
  await evaluate(page,`${picker(6)}.focus()`);
  assert.equal(await evaluate(page,`document.activeElement === ${picker(6)}`),true,'Card selector is keyboard focusable');
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
  await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  for(let j=0;j<100 && (await members(firstId)).length===6;j++) await delay(30);
  assert.equal((await members(firstId)).length,5);
  await evaluate(page,`${root}.querySelector('.box-card-actions button').click()`);
  assert.equal(await evaluate(page,`document.getElementById('pokemon-editor-dialog').open`),true);
  assert.equal((await members(firstId)).length,5,'Card Edit never toggles membership');
  await evaluate(page,`document.getElementById('pokemon-editor-dialog').close()`);
  await evaluate(page,`${row(second.partyId)}.querySelector('.party-edit').click()`);
  assert.equal(await evaluate(page,`${row(firstId)}.querySelector('.party-edit').getAttribute('aria-pressed')`),'false');
  assert.equal(await evaluate(page,`${picker(1)}.getAttribute('aria-pressed')`),'true');
  assert.equal(await evaluate(page,`${picker(0)}.getAttribute('aria-pressed')`),'false');
  await evaluate(page,`${row(second.partyId)}.querySelector('.party-edit').click()`);
  assert.equal(await evaluate(page,`document.querySelectorAll('.box-party-select').length`),0,'Edit toggles off');
  const saved=await evaluate(page,`new Promise((resolve,reject)=>{const open=indexedDB.open('pokemon-line-calculator-boxes');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const read=db.transaction('library','readonly').objectStore('library').get('active');read.onerror=()=>{db.close();reject(read.error);};read.onsuccess=()=>{db.close();resolve(Object.values(read.result.games).flatMap(game=>Object.values(game.boxes)).find(box=>box.id===${JSON.stringify(box.id)}));};};})`,true);
  assert.deepEqual(saved.parties[firstId].pokemonIds,await members(firstId),'Membership persisted to IndexedDB');
  assert.deepEqual(saved.parties[second.partyId].pokemonIds,['party-edit-1']);
  assert.equal(saved.pokemonOrder.length,7,'No Pokémon erased');
  for(const width of [1280,390,320]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(page,`${row(firstId)}.scrollIntoView({block:'start'})`);
    const layout=await evaluate(page,`(()=>{const header=${row(firstId)}.querySelector('.party-card-header');const r=[...header.children].map(e=>e.getBoundingClientRect());return {overflow:document.documentElement.scrollWidth>innerWidth,sameRow:r.every(e=>Math.abs(e.y-r[0].y)<5),equal:r[1].width===r[2].width && r[1].height===r[2].height};})()`);
    assert.equal(layout.overflow,false);assert.equal(layout.sameRow,true);assert.equal(layout.equal,true);
    const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(tempRoot,`party-edit-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  console.log(JSON.stringify({status:'party-card-edit-valid',membership:true,limit:true,keyboard:true,isolation:true,persistence:true}));
}
