import assert from 'node:assert/strict';
import { normalizePlayerCollection, normalizeTrainerRoster } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';

export async function checkSavedDraftGuard({page,evaluate,delay,dataset}) {
  const wait=async(expression,label)=>{for(let i=0;i<160;i++){if(await evaluate(page,expression))return;await delay(50);}throw Error(label+': '+await evaluate(page,`document.getElementById('app-status').textContent`));};
  const click=async id=>evaluate(page,`document.getElementById(${JSON.stringify(id)}).click()`);
  const save=async()=>{
    await evaluate(page,`document.getElementById('app-status').textContent='Saving test';document.getElementById('save-plan').click()`);
    await wait(`document.getElementById('app-status').textContent==='Line saved to Drafts.'`,'save draft');
  };
  const exit=async expectedPrompt=>{
    await click('new-plan');
    await wait(`document.getElementById('destructive-dialog').open || document.getElementById('trainer-selector-dialog').open`,'exit guard');
    assert.equal(await evaluate(page,`document.getElementById('destructive-dialog').open`),expectedPrompt);
    if(expectedPrompt)await evaluate(page,`document.querySelector('#destructive-dialog [value="cancel"]').click()`);
    else await evaluate(page,`document.getElementById('trainer-selector-dialog').close('cancel')`);
    await delay(30);
  };
  const stats=n=>Object.fromEntries(['hp','atk','def','spa','spd','spe'].map(k=>[k,n]));
  const players=normalizePlayerCollection({party:[{speciesId:'squirtle',nickname:'Draft Test',level:30,nature:'Hardy',ability:'Pressure',ivs:stats(31),evs:stats(0),moves:['tackle','protect']}]},dataset);
  const trainer=dataset.trainerGroups().flatMap(g=>g.trainers).find(t=>(t.displayName||t.name).includes('School Kid Neil'));
  assert.ok(trainer);
  for(const planningMode of ['party-lock','sandbox']) {
    const plan=createPlanDocument({name:`Draft Guard ${planningMode}`,dataset,trainerId:trainer.id,playerCombatants:players,
      enemyCombatants:normalizeTrainerRoster(trainer.id,null,dataset),battleFormat:'singles',...(planningMode==='sandbox'?{planningMode}:{})});
    await evaluate(page,`(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify(plan))}],'guard.json',{type:'application/json'}));const input=document.getElementById('import-plan');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`(()=>{if(document.getElementById('destructive-dialog').open)document.getElementById('destructive-discard').click();return document.getElementById('plan-toolbar-label').textContent===${JSON.stringify(plan.name)};})()`,'import');
    await exit(true); // Active recovery cache is not a saved Draft.
    await save();await exit(false);await exit(false);
    await evaluate(page,`document.querySelector('[data-side="player"] .move-button').click()`);
    await exit(true); // Incomplete selections do not increment the plan revision.
    await save();await exit(false);
    await evaluate(page,`document.getElementById('node-notes').value='Unsaved note';document.getElementById('node-notes').dispatchEvent(new Event('input',{bubbles:true}))`);
    await exit(true);await save();await exit(false);
    if(planningMode==='sandbox') {
      await evaluate(page,`const hp=document.querySelector('[data-free-calc-control="player-0-HP"]');hp.value='10';hp.dispatchEvent(new Event('change',{bubbles:true}));`);
      await exit(true);await save();await exit(false);
    }
    await click('drafts-tab');
    await wait(`Boolean([...document.querySelectorAll('.saved-line')].find(c=>c.querySelector('h2').textContent===${JSON.stringify(plan.name)}))`,'saved list');
    await evaluate(page,`[...document.querySelectorAll('.saved-line')].find(c=>c.querySelector('h2').textContent===${JSON.stringify(plan.name)}).querySelector('button').click()`);
    await wait(`document.getElementById('plc-tab').getAttribute('aria-selected')==='true'`,'reopen without prompt');
    assert.equal(await evaluate(page,`document.getElementById('destructive-dialog').open`),false);
    await exit(false);
    // Read-only node navigation must not dirty the saved line.
    await evaluate(page,`document.querySelector('#node-tree .node-button').click()`);
    await exit(false);
    await save();
    await page.send('Page.reload',{});
    await wait(`document.getElementById('game-dialog')?.open && Boolean(document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]:not(:disabled)'))`,'reload picker');
    await evaluate(page,`document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]').click()`);
    await wait(`document.getElementById('plan-toolbar-label').textContent===${JSON.stringify(plan.name)} && !document.getElementById('game-dialog').open`,'cached line');
    await exit(false);
    // A failed overwrite cannot mark changed selections as saved.
    await evaluate(page,`document.querySelector('[data-side="player"] .move-button').click();globalThis.guardOriginalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='lines')throw new DOMException('Test quota failure','QuotaExceededError');return globalThis.guardOriginalPut.apply(this,args);};document.getElementById('save-plan').click()`);
    await wait(`document.getElementById('app-status').textContent.includes('Test quota failure')`,'save failure');
    await evaluate(page,`IDBObjectStore.prototype.put=globalThis.guardOriginalPut;delete globalThis.guardOriginalPut;`);
    await exit(true);await save();await exit(false);
    await click('drafts-tab');await delay(150);
    await evaluate(page,`(()=>{const original=window.confirm;window.confirm=()=>true;[...document.querySelectorAll('.saved-line')].find(c=>c.querySelector('h2').textContent===${JSON.stringify(plan.name)}).querySelector('.danger').click();window.confirm=original;})()`);
    await wait(`![...document.querySelectorAll('.saved-line')].some(c=>c.querySelector('h2').textContent===${JSON.stringify(plan.name)})`,'delete saved copy');
    await click('plc-tab');await exit(true);
  }
  console.log(JSON.stringify({status:'saved-draft-guard-browser-valid',modes:2,unchanged:true,partialSelections:true,notes:true,sandboxEdits:true,navigation:true,reload:true,failedSave:true,deletedDraft:true}));
}
