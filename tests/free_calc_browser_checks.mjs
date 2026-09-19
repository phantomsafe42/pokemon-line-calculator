import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePlayerCollection, normalizeTrainerRoster, snapshotFingerprint } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';

// Uses only the caller's disposable headless profile and synthetic teams.
export async function checkFreeCalcInline({ page, evaluate, delay, dataset, tempRoot }) {
  const readStore = (database, store) => evaluate(page, `(async () => {
    const db=await new Promise((resolve,reject)=>{ const request=indexedDB.open(${JSON.stringify(database)}); request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
    try { return await new Promise((resolve,reject)=>{ const request=db.transaction(${JSON.stringify(store)},'readonly').objectStore(${JSON.stringify(store)}).getAll(); request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); }); } finally { db.close(); }
  })()`, true);
  const trainer = dataset.trainerGroups().flatMap(group => group.trainers).find(row => {
    try { return normalizeTrainerRoster(row.id, null, dataset).length >= 4; } catch { return false; }
  });
  assert.ok(trainer, 'a released trainer with reserves');
  const stats = value => Object.fromEntries(['hp','atk','def','spa','spd','spe'].map(key => [key, value]));
  const players = normalizePlayerCollection({ party: ['squirtle','bulbasaur','charmander','pikachu'].map((speciesId, index) => ({
    uniqueKey: `inline-${index}`, speciesId, nickname: `Inline ${index + 1}`, level: 30,
    nature: 'Hardy', ability: 'Pressure', ivs: stats(31), evs: stats(0), moves: ['tackle','protect']
  })) }, dataset);
  const enemies = normalizeTrainerRoster(trainer.id, null, dataset);
  for (const format of ['singles','doubles','triples','rotation']) {
    const plan = createPlanDocument({ name: `Inline ${format}`, dataset, trainerId: trainer.id,
      playerCombatants: players, enemyCombatants: enemies, battleFormat: format,
      sourceSnapshot: snapshotFingerprint(players, enemies, '2026-09-18T00:00:00Z') });
    await evaluate(page, `(async () => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(JSON.stringify(plan))}], 'inline.json', {type:'application/json'}));
      const input = document.getElementById('import-plan'); input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
      for(let i=0;i<200;i++) {
        if(document.getElementById('destructive-dialog').open) document.getElementById('destructive-discard').click();
        if(document.getElementById('plan-toolbar-label').textContent === ${JSON.stringify(plan.name)} && !document.getElementById('free-calc').disabled
          && document.querySelector('[data-side="player"][data-action-slot="0"] .combatant-name')?.textContent.startsWith('Inline 1')) return;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error('Free Calc fixture import: '+document.getElementById('app-status').textContent);
    })()`, true);
    const cardText = `(() => { const card=document.querySelector('[data-side="player"][data-action-slot="0"]'); return [...card.querySelectorAll('.combatant-header,.static-details,.stat-table')].map(el=>el.textContent).join('|'); })()`;
    const baseline = await evaluate(page, cardText);
    const boxes = await readStore('pokemon-line-calculator-boxes','library');
    await evaluate(page, `document.getElementById('free-calc').click()`);
    const treeSections = await evaluate(page, `(() => {
      const sections=[...document.querySelectorAll('#node-tree > .node-tree-section')];
      return {ids:sections.map(section=>section.dataset.treeSection),
        selectedSection:document.querySelector('#node-tree [aria-selected="true"]')?.closest('.node-tree-section').dataset.treeSection,
        below:sections[1]?.getBoundingClientRect().top >= sections[0]?.getBoundingClientRect().bottom};
    })()`);
    assert.deepEqual(treeSections,{ids:['planned','free-calc'],selectedSection:'free-calc',below:true});
    const result = await evaluate(page, `(() => {
      const control = label => document.querySelector('[data-free-calc-control="player-0-'+label+'"]');
      const change = (label,value) => { const node=control(label); if(!node) throw new Error('Missing '+label); node.focus(); node.value=value; node.dispatchEvent(new Event('change',{bubbles:true})); };
      change('Level','30'); change('Level EXP','250'); change('HP','25'); change('Status','tox'); change('Item','leftovers'); change('Ability','intimidate');
      const initialStage=Number(control('atk up').parentElement.querySelector('span').textContent);
      control('atk up').click();
      change('Move 1','surf');
      const card = control('HP').closest('.combatant-card');
      const result = { level:control('Level').value, exp:control('Level EXP').value, hp:control('HP').value,
        status:control('Status').value, item:control('Item').value, ability:control('Ability').value,
        initialStage, stage:Number(control('atk up').parentElement.querySelector('span').textContent), move:control('Move 1').value,
        moveName:card.querySelector('.move-button .move-copy strong').textContent,
        separateEditor:Boolean(document.querySelector('.free-calc-editor')), nestedControls:Boolean(card.querySelector('button select,button input')),
        moveSelected:card.querySelector('.move-button').getAttribute('aria-pressed'), aiHidden:document.querySelector('.ai-forecast-panel').hidden,
        focus:document.activeElement?.dataset.freeCalcControl };
      card.querySelector('.move-button').click();
      result.canSelect = control('HP').closest('.combatant-card').querySelector('.move-button').getAttribute('aria-pressed');
      return result;
    })()`);
    assert.deepEqual({level:result.level,exp:result.exp,hp:result.hp,status:result.status,item:result.item,ability:result.ability},
      {level:'30',exp:'250',hp:'25',status:'tox',item:'leftovers',ability:'intimidate'});
    assert.equal(result.stage, result.initialStage+1); assert.equal(result.move,'surf');
    assert.equal(result.moveName,'Surf');
    assert.equal(result.separateEditor,false); assert.equal(result.nestedControls,false);
    assert.equal(result.moveSelected,'false'); assert.equal(result.canSelect,'true'); assert.equal(result.aiHidden,true);
    assert.equal(result.focus,'player-0-Move 1');
    const switchCheck = await evaluate(page, `(() => {
      const control=label=>document.querySelector('[data-free-calc-control="player-0-'+label+'"]');
      let card=control('HP').closest('.combatant-card'); card.querySelector('.switch-button').click();
      card=control('HP').closest('.combatant-card'); card.querySelector('.switch-target:not(.is-current)').click();
      const incoming=control('Pokémon').value;
      const hp=control('HP'); hp.value='13'; hp.dispatchEvent(new Event('change',{bubbles:true}));
      control('HP').closest('.combatant-card').querySelector('.switch-button').click();
      const outgoingHp=control('HP').value;
      const choose=control('Pokémon'); choose.value=incoming; choose.dispatchEvent(new Event('change',{bubbles:true}));
      const incomingHp=control('HP').value;
      const zero=control('HP'); zero.value='0'; zero.dispatchEvent(new Event('change',{bubbles:true}));
      const empty=control('HP').closest('.combatant-card').classList.contains('empty-combatant-slot');
      const heal=control('HP'); heal.value='13'; heal.dispatchEvent(new Event('change',{bubbles:true}));
      return {outgoingHp,incomingHp,empty,restored:!control('HP').closest('.combatant-card').classList.contains('empty-combatant-slot')};
    })()`);
    assert.deepEqual(switchCheck,{outgoingHp:'25',incomingHp:'13',empty:true,restored:true});
    for (const width of [390,1280,1920,2560]) {
      await page.send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width<600});
      await delay(120);
      const layout = await evaluate(page, `(() => {
        const cards=[...document.querySelectorAll('.combatant-card')];
        return {fits:document.documentElement.scrollWidth<=innerWidth+1,
          controlsFit:cards.every(card=>[...card.querySelectorAll('.free-calc-control')].every(el=>el.getBoundingClientRect().right<=card.getBoundingClientRect().right+1)),
          cards:cards.length,
          stackGaps:[...document.querySelectorAll('.action-panel:is(.is-triples,.is-rotation) .action-panel-cards')].map(grid=> {
            const center=grid.querySelector('.slot-position-1').getBoundingClientRect();
            const lower=grid.querySelector('.slot-position-2').getBoundingClientRect();
            return lower.top-center.bottom-parseFloat(getComputedStyle(grid).rowGap);
          })};
      })()`);
      assert.ok(layout.fits, `${format} page fits ${width}`); assert.ok(layout.controlsFit,`${format} controls fit ${width}`);
      assert.equal(layout.cards,format==='singles'?2:format==='doubles'?4:6);
      assert.ok(layout.stackGaps.every(gap=>Math.abs(gap)<1), `${format} stacked cards have only the intended gap at ${width}: ${layout.stackGaps}`);
      if(width===1280) {
        await evaluate(page, `document.getElementById('player-action-panel').scrollIntoView({block:'start'})`);
        const image=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await fs.writeFile(path.join(tempRoot,`free-calc-${format}.png`),Buffer.from(image.data,'base64'));
      }
    }
    await evaluate(page, `document.getElementById('free-calc-close').click()`);
    await delay(100);
    assert.equal(await evaluate(page, cardText),baseline);
    assert.equal(await evaluate(page, `document.querySelectorAll('.free-calc-control').length`),0);
    assert.equal(await evaluate(page, `document.querySelectorAll('[data-tree-section="free-calc"]').length`),0);
    assert.deepEqual(await readStore('pokemon-line-calculator-boxes','library'),boxes,'Close leaves every Box untouched');
  }
  const boxesBefore = await readStore('pokemon-line-calculator-boxes','library');
  await evaluate(page, `(async () => {
    document.getElementById('free-calc').click();
    const hp=document.querySelector('[data-free-calc-control="player-0-HP"]'); hp.value='23'; hp.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('free-calc-add').click();
    for(let i=0;i<100;i++) { if(!document.querySelector('.free-calc-control')) return; await new Promise(resolve=>setTimeout(resolve,50)); }
    throw new Error('Add did not finish');
  })()`, true);
  const activeAfterAdd = (await readStore('pokemon-line-calculator','draft'))[0];
  const selected = activeAfterAdd.document.stateNodes[activeAfterAdd.workingCursorStateNodeId];
  assert.equal(selected.combatantStates[selected.active.playerCombatantKeys[0]].hp.max,23);
  assert.equal(selected.freeCalc,true);
  assert.equal(await evaluate(page, `document.querySelector('#node-tree [aria-selected="true"]')?.closest('.node-tree-section').dataset.treeSection`),'free-calc');
  assert.deepEqual(await readStore('pokemon-line-calculator-boxes','library'),boxesBefore,'Add does not edit Boxes');
  await evaluate(page, `(async () => {
    document.getElementById('free-calc').click();
    const hp=document.querySelector('[data-free-calc-control="player-0-HP"]'); hp.value='22'; hp.dispatchEvent(new Event('change',{bubbles:true}));
    const savedPrompt=window.prompt; window.prompt=()=> 'Inline saved draft';
    try {
      document.getElementById('free-calc-save').click();
      for(let i=0;i<100;i++) { if(!document.querySelector('.free-calc-control')) return; await new Promise(resolve=>setTimeout(resolve,50)); }
      throw new Error('Save did not finish');
    } finally { window.prompt=savedPrompt; }
  })()`, true);
  const saved=(await readStore('plc-saved-lines','lines')).find(row=>row.name==='Inline saved draft');
  assert.ok(saved);
  assert.equal(Object.keys(saved.document.stateNodes).length,1);
  const root=saved.document.stateNodes[saved.document.initialStateNodeId];
  assert.equal(root.combatantStates[root.active.playerCombatantKeys[0]].hp.max,22);
  const activeAfterSave=(await readStore('pokemon-line-calculator','draft'))[0];
  assert.deepEqual(activeAfterSave.document,activeAfterAdd.document,'Save restores the original active line');
  console.log(JSON.stringify({status:'free-calc-inline-browser-valid',formats:4,close:true,add:true,save:true,boxIsolation:true}));
}
