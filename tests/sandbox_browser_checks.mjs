import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePlayerCollection, normalizeTrainerRoster } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';
import { createEmptyBoxLibrary, addBox } from '../src/boxes/library.js';
import { planPlayerPartyRecords } from '../src/boxes/plan_import.js';

export async function checkSandbox({ page, evaluate, delay, dataset, tempRoot, pickerOnly = false }) {
  const readStore = (database, store) => evaluate(page, `(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(${JSON.stringify(database)});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    try{return await new Promise((resolve,reject)=>{const r=db.transaction(${JSON.stringify(store)},'readonly').objectStore(${JSON.stringify(store)}).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{db.close();}
  })()`,true);
  const upload = async (id, value) => evaluate(page, `(()=>{
    const t=new DataTransfer();t.items.add(new File([${JSON.stringify(JSON.stringify(value))}],'sandbox.json',{type:'application/json'}));
    const el=document.getElementById(${JSON.stringify(id)});el.files=t.files;el.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  const wait = async (expression, message) => {
    for(let i=0;i<160;i++){if(await evaluate(page,expression)) return;await delay(100);}
    throw new Error(message+': '+await evaluate(page,`document.getElementById('app-status').textContent+' / '+document.getElementById('context-status').textContent`));
  };
  const trainer=dataset.trainerGroups().flatMap(g=>g.trainers).find(t=>{
    try{return normalizeTrainerRoster(t.id,null,dataset).length>=4 && !t.playerPartnerBinding && !t.encounter;}catch{return false;}
  });
  const stats=value=>Object.fromEntries(['hp','atk','def','spa','spd','spe'].map(k=>[k,value]));
  const players=normalizePlayerCollection({party:['squirtle','bulbasaur','charmander','pikachu'].map((speciesId,index)=>({
    speciesId,uniqueKey:`sandbox-${index}`,nickname:`Sandbox ${index+1}`,level:30,nature:'Hardy',ability:'Pressure',ivs:stats(31),evs:stats(0),moves:['tackle','protect']
  }))},dataset);
  const enemies=normalizeTrainerRoster(trainer.id,null,dataset);
  const fixture=format=>createPlanDocument({name:`Sandbox ${format}`,dataset,trainerId:trainer.id,playerCombatants:players,enemyCombatants:enemies,battleFormat:format,planningMode:'sandbox'});
  let library=createEmptyBoxLibrary();
  const records=planPlayerPartyRecords(fixture('singles'),dataset);
  for(const [gameId,name,nickname] of [[dataset.gameId,'Sandbox Other Box','Other Box Mon'],['platinum','Foreign Box','Foreign Mon']]) {
    library=addBox(library,gameId,{name,pokemon:[{...records[0],id:`sandbox-${gameId}`,nickname,majorStatus:'par'}]}).library;
  }
  const startingRecords=Array.from({length:7},(_,i)=>({...records[i%records.length],id:`sandbox-start-${i}`,nickname:`Box Order ${i+1}`,majorStatus:i===0?'tox':null,itemId:i===0?'leftovers':null}));
  library=addBox(library,dataset.gameId,{name:'Sandbox Start Order',pokemon:startingRecords,
    partyPokemonIds:startingRecords.slice(0,6).reverse().map(record=>record.id)}).library;
  await upload('import-boxes',library);await delay(200);
  const baseline=await readStore('pokemon-line-calculator-boxes','library');
  for(const format of ['singles','doubles','triples','rotation']) {
    await upload('import-plan',fixture(format));
    await wait(`(()=>{if(document.getElementById('destructive-dialog').open) document.getElementById('destructive-discard').click();return document.getElementById('plan-toolbar-label').textContent===${JSON.stringify('Sandbox '+format)} && Boolean(document.querySelector('[data-free-calc-control="player-0-HP"]'));})()`,'Sandbox import');
    await delay(150);
    const movePickers=await evaluate(page,`(()=>{
      const results=[];
      for(const side of ['player','enemy']) {
        const card=()=>document.querySelector('[data-side="'+side+'"][data-action-slot="0"]');
        const control=i=>card().querySelector('[data-free-calc-control="'+side+'-0-Move '+i+'"]');
        const change=(i,value)=>{const el=control(i);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));};
        const original=control(1).value;
        change(1,'watergun');
        const face=()=>control(1).closest('.sandbox-move-main').querySelector('.move-button');
        const unselected=face().getAttribute('aria-pressed')==='false';
        const name=face().querySelector('strong').textContent;
        face().click();const selected=face().getAttribute('aria-pressed')==='true';
        control(1).click();const pickerDoesNotToggle=face().getAttribute('aria-pressed')==='true';
        face().click();const deselected=face().getAttribute('aria-pressed')==='false';
        change(1,original);
        results.push({unselected,name,selected,pickerDoesNotToggle,deselected,count:card().querySelectorAll('.sandbox-move-picker select').length,
          separate:card().querySelectorAll('.free-calc-move-row > select').length});
      }
      const empty=()=>document.querySelector('[data-free-calc-control="player-0-Move 3"]');
      empty().value='scratch';empty().dispatchEvent(new Event('change',{bubbles:true}));
      const added=empty().closest('.sandbox-move-main').querySelector('strong').textContent==='Scratch';
      empty().value='';empty().dispatchEvent(new Event('change',{bubbles:true}));
      const cleared=empty().closest('.sandbox-move-main').querySelector('.move-button').textContent==='None';
      empty().focus();const focusable=document.activeElement===empty();
      return {results,added,cleared,focusable};
    })()`);
    assert.ok(movePickers.results.every(r=>r.unselected && r.name==='Water Gun' && r.selected && r.pickerDoesNotToggle && r.deselected && r.count===4 && r.separate===0),JSON.stringify(movePickers));
    assert.ok(movePickers.added && movePickers.cleared && movePickers.focusable,'Empty slots stay editable and keyboard accessible');
    await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
    await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
    assert.equal(await evaluate(page,`(()=>{
      const select=document.querySelector('[data-free-calc-control="player-0-Move 3"]');
      const changed=Boolean(select.value) && Boolean(select.closest('.sandbox-move-main').querySelector('strong'));
      select.value='';select.dispatchEvent(new Event('change',{bubbles:true}));return changed;
    })()`),true,'Arrow key changes the embedded native move selector');
    await delay(150);
    const beforePicker=(await readStore('pokemon-line-calculator','draft'))[0].document;
    const picker=await evaluate(page,`(()=>{
      const card=document.querySelector('[data-side="player"][data-action-slot="0"]');
      card.querySelector('.switch-button').click();
      const current=document.querySelector('[data-side="player"][data-action-slot="0"]');
      return {names:[...current.querySelectorAll('.switch-target')].map(b=>b.textContent),
        dropdowns:document.querySelectorAll('.sandbox-reserve-picker,.combatant-name select').length,
        buttons:[...current.querySelectorAll('.sandbox-switch-actions button')].map(b=>b.textContent)};
    })()`);
    assert.ok(picker.names.some(n=>n.includes('Other Box Mon')));
    assert.ok(!picker.names.some(n=>n.includes('Foreign Mon')));
    assert.equal(picker.dropdowns,0);assert.deepEqual(picker.buttons,['Switch','Replace']);
    if(format!=='singles') assert.ok(!picker.names.some(n=>n.includes('Sandbox 2')),'other active slot excluded');
    await delay(150);
    const afterPicker=(await readStore('pokemon-line-calculator','draft'))[0].document;
    assert.deepEqual(afterPicker.combatants,beforePicker.combatants,'showing all Boxes does not admit them');
    assert.deepEqual(afterPicker.stateNodes,beforePicker.stateNodes,'opening picker does not edit a node');
    const result=await evaluate(page,`(()=>{
      const control=label=>document.querySelector('[data-free-calc-control="player-0-'+label+'"]');
      const change=(label,value)=>{const el=control(label);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));};
      const card=()=>document.querySelector('[data-side="player"][data-action-slot="0"]');
      card().querySelector('.switch-button').click();
      change('HP','25');change('Status','tox');change('Item','leftovers');change('Level EXP','10');
      const openReplace=()=>{if(card().querySelector('.replace-button').getAttribute('aria-pressed')!=='true')card().querySelector('.replace-button').click();};
      openReplace();
      const names=[...card().querySelectorAll('.switch-target')].map(o=>o.textContent);
      const original=card().querySelector('.switch-target.is-current').dataset.combatantKey;
      [...card().querySelectorAll('.switch-target')].find(o=>o.textContent.includes('Other Box Mon')).click();
      const orderAfterReplace=[...card().querySelectorAll('.switch-target')].map(o=>o.textContent.replace(' · Current',''));
      const incomingStatus=control('Status').value;
      change('HP','19');openReplace();
      [...card().querySelectorAll('.switch-target')].find(o=>o.dataset.combatantKey===original).click();
      const restored={hp:control('HP').value,status:control('Status').value,item:control('Item').value};
      return {names,orderAfterReplace,incomingStatus,restored,aiHidden:document.querySelector('.ai-forecast-panel').hidden,
        freeCalcHidden:document.getElementById('free-calc').hidden,commitHidden:document.getElementById('commit-turn').hidden,
        sections:[...document.querySelectorAll('#node-tree > .node-tree-section')].map(s=>s.dataset.treeSection),
        nodeCount:document.querySelectorAll('#node-tree .node-button').length,badge:document.getElementById('revision-label').textContent};
    })()`);
    assert.ok(result.names.some(n=>n.includes('Other Box Mon')));assert.ok(!result.names.some(n=>n.includes('Foreign Mon')));
    assert.deepEqual(result.orderAfterReplace,result.names.map(name=>name.replace(' · Current','')),`Replace preserves Box order in ${format}`);
    assert.equal(result.incomingStatus,'par');assert.deepEqual(result.restored,{hp:'25',status:'tox',item:'leftovers'});
    assert.equal(result.aiHidden,true);assert.equal(result.freeCalcHidden,true);assert.equal(result.commitHidden,false);
    assert.deepEqual(result.sections,['planned']);assert.equal(result.nodeCount,1);assert.match(result.badge,/Sandbox/);
    for(const width of pickerOnly ? [] : [390,1280,1920,2560]) {
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width<600});await delay(80);
      assert.equal(await evaluate(page,`document.documentElement.scrollWidth<=innerWidth+1`),true,`${format} fits ${width}`);
      assert.equal(await evaluate(page,`[...document.querySelectorAll('.combatant-card .combatant-header')].every(header=>{
        const sprite=header.querySelector('.combatant-sprite').getBoundingClientRect(),identity=header.children[1].getBoundingClientRect();
        const hp=header.querySelector('.combatant-corner-stats').getBoundingClientRect();
        return identity.top<sprite.bottom && identity.bottom>sprite.top && identity.left>=sprite.right &&
          !(identity.left<hp.right && identity.right>hp.left && identity.top<hp.bottom && identity.bottom>hp.top);
      })`),true,`Sandbox identity stays beside its sprite without overlapping HP: ${format} ${width}`);
      if(width===2560 || width===390) {
        await evaluate(page,`document.getElementById('player-action-panel').scrollIntoView({block:'start'})`);
        const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await fs.writeFile(path.join(tempRoot,`sandbox-header-${format}-${width}.png`),Buffer.from(shot.data,'base64'));
      }
      const pickerGeometry = await evaluate(page,`[...document.querySelectorAll('.sandbox-move-main')].map(main=>{
        const face=(main.querySelector('.move-heading') || main.querySelector('.move-button')).getBoundingClientRect(),select=main.querySelector('select').getBoundingClientRect();
        return {name:main.textContent.slice(0,40),top:face.top-select.top,right:face.right-select.right,bottom:face.bottom-select.bottom,width:select.width};
      })`);
      assert.ok(pickerGeometry.every(row=>Math.abs(row.top)<=1 && Math.abs(row.right)<=1 && Math.abs(row.bottom)<=1 && row.width>=32),`Move picker stays inside its heading: ${format} ${width} ${JSON.stringify(pickerGeometry)}`);
      if(width===1280 || width===390) {
        await evaluate(page,`document.getElementById('player-action-panel').scrollIntoView({block:'start'})`);
        const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await fs.writeFile(path.join(tempRoot,`sandbox-move-picker-${format}-${width}.png`),Buffer.from(shot.data,'base64'));
      }
    }
    await delay(120);
    assert.deepEqual(await readStore('pokemon-line-calculator-boxes','library'),baseline,'Sandbox import/edit must not touch Boxes');
  }
  if(pickerOnly) {
    console.log(JSON.stringify({status:'sandbox-picker-browser-valid',formats:4,boxOrder:true,restoredState:true,boxIsolation:true}));
    return;
  }
  // A fresh Singles line checks cross-Box normal switching, commitment, history,
  // and saving an incomplete edited continuation without a special Free Calc UI.
  await upload('import-plan',fixture('singles'));
  await wait(`(()=>{if(document.getElementById('destructive-dialog').open)document.getElementById('destructive-discard').click();return document.getElementById('plan-toolbar-label').textContent==='Sandbox singles' && document.querySelectorAll('.combatant-card').length===2;})()`,'Singles Sandbox');
  await evaluate(page,`(()=>{
    const change=(side,label,value)=>{const el=document.querySelector('[data-free-calc-control="'+side+'-0-'+label+'"]');el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));};
    change('enemy','Move 1','protect');
    document.querySelector('[data-side="enemy"] .move-button').click();
    document.querySelector('[data-side="player"] .switch-button').click();
    [...document.querySelectorAll('[data-side="player"] .switch-target')].find(o=>o.textContent.includes('Other Box Mon')).click();
  })()`);
  await wait(`!document.getElementById('commit-turn').disabled`,'Sandbox Switch preview');
  await evaluate(page,`document.getElementById('commit-turn').click()`);
  await wait(`document.getElementById('turn-label').textContent.startsWith('Turn 2')`,'Sandbox Next Turn');
  await evaluate(page,`document.querySelector('#node-tree .node-button[data-kind="committed"]').click()`);
  await evaluate(page,`(()=>{const el=document.querySelector('[data-free-calc-control="player-0-HP"]');el.value='21';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(`!document.getElementById('commit-turn').disabled`,'Sandbox historical preview');
  assert.equal(await evaluate(page,`document.getElementById('commit-turn').textContent`),'New Branch');
  assert.equal(await evaluate(page,`document.querySelectorAll('#node-tree .node-button[data-kind="committed"]').length`),1);
  await evaluate(page,`document.getElementById('save-plan').click()`);await delay(150);
  const drafts=await readStore('plc-saved-lines','lines');
  assert.ok(drafts.some(d=>d.document?.game?.planningMode==='sandbox'));
  const active=(await readStore('pokemon-line-calculator','draft'))[0];
  assert.equal(active.document.game.planningMode,'sandbox');
  const editedState=active.document.stateNodes[active.workingCursorStateNodeId];
  const editedKey=active.sandboxEditor.actionDraft.player[0].switchToKey;
  assert.equal(editedState.combatantStates[editedKey].hp.max,21);
  await page.send('Page.reload',{});
  await wait(`document.getElementById('game-dialog')?.open && Boolean(document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]:not(:disabled)'))`,'Game picker after reload');
  await evaluate(page,`document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]').click()`);
  await wait(`!document.getElementById('game-dialog').open && document.querySelector('[data-free-calc-control="player-0-HP"]')?.value==='21'`,'Sandbox cache recovery');
  assert.equal(await evaluate(page,`document.querySelector('.ai-forecast-panel').hidden`),true);
  const image=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await fs.writeFile(path.join(tempRoot,'sandbox-singles.png'),Buffer.from(image.data,'base64'));
  assert.deepEqual(await readStore('pokemon-line-calculator-boxes','library'),baseline);
  await evaluate(page,`window.openNewLineForTest()`,true);
  assert.equal(await evaluate(page,`document.getElementById('context-mode-select').value`),'','New Line requires explicit mode selection');
  assert.equal(await evaluate(page,`document.getElementById('context-box-field').hidden && document.getElementById('saved-party-field').hidden`),true);
  await evaluate(page,`(()=>{
    const select=(id,value)=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));};
    select('context-mode-select','sandbox');
    select('trainer-select',[...document.getElementById('trainer-select').options].find(o=>o.textContent.includes('School Kid Neil')).value);
    select('context-box-select',[...document.getElementById('context-box-select').options].find(o=>o.textContent.includes('Sandbox Start Order')).value);
  })()`);
  await wait(`!document.getElementById('begin-plan').disabled`,'Sandbox ready immediately after trainer and Box selection');
  assert.equal(await evaluate(page,`document.getElementById('context-pokemon-grid').children.length`),0);
  assert.equal(await evaluate(page,`document.getElementById('party-selection-actions').hidden && document.getElementById('edge-party-exp').hidden && document.getElementById('edit-party-selection').hidden`),true);
  await evaluate(page,`document.getElementById('begin-plan').click()`);
  await wait(`(()=>{if(document.getElementById('destructive-dialog').open)document.getElementById('destructive-discard').click();return !document.getElementById('plan-context-dialog').open && Boolean(document.querySelector('[data-free-calc-control="player-0-HP"]'));})()`,'New Line Sandbox mode');
  assert.match(await evaluate(page,`document.getElementById('revision-label').textContent`),/Sandbox/);
  const started=(await readStore('pokemon-line-calculator','draft'))[0].document;
  assert.deepEqual(Object.values(started.combatants).filter(mon=>mon.side==='player').map(mon=>mon.nickname),
    startingRecords.slice(0,6).map(record=>record.nickname),'Sandbox starts in Box order, ignoring reversed saved Party');
  const lead=Object.values(started.combatants).find(mon=>mon.nickname==='Box Order 1');
  assert.equal(lead.originalItemId,'leftovers');
  assert.equal(started.stateNodes[started.initialStateNodeId].combatantStates[lead.combatantKey].majorStatus,'tox','Sandbox retains Box status without rendering cards or saving a Party');
  assert.deepEqual(await readStore('pokemon-line-calculator-boxes','library'),baseline,'New Line does not reorder the Box or its Party');
  await evaluate(page,`window.openNewLineForTest()`,true);
  assert.equal(await evaluate(page,`document.getElementById('context-mode-select').value`),'');
  await evaluate(page,`document.getElementById('plan-context-dialog').close()`);
  console.log(JSON.stringify({status:'sandbox-browser-valid',formats:4,crossBox:true,history:true,cache:true,newLine:true,boxIsolation:true}));
}
