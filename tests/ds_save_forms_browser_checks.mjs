import assert from 'node:assert/strict';
import { syntheticDsSave } from './ds_save_fixture.mjs';

export async function checkDsSaveForms({page,evaluate,delay,dataset}) {
  // Caller owns a disposable browser profile. No personal save or library is read.
  const wait=async(expression)=>{for(let i=0;i<150;i++){if(await evaluate(page,expression))return;await delay(100);}throw new Error('DS form import timed out: '+await evaluate(page,'document.getElementById("app-status").textContent'));};
  for (const dsv of [false,true]) {
    const name=dsv?'synthetic-ds-forms-dsv':'synthetic-ds-forms-sav';
    const bytes=syntheticDsSave('bw2',[[422,0],[422,1]],{dsv,boxed:[{identity:[423,1],box:2}]});
    const encoded=Buffer.from(bytes).toString('base64');
    await evaluate(page,`(()=>{
      const data=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));
      const transfer=new DataTransfer();transfer.items.add(new File([data],${JSON.stringify(name+(dsv?'.dsv':'.sav'))},{type:'application/octet-stream'}));
      const input=document.getElementById('save-import');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await wait('document.getElementById("save-import-dialog").open');
    assert.equal(await evaluate(page,'document.querySelectorAll("#save-import-dialog img").length'),0,'No sprites before PC box confirmation');
    await evaluate(page,`(()=>{
      const checkbox=document.querySelector('#save-import-pc-boxes input[value="2"]');
      checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('confirm-save-import').click();
    })()`);
    await wait(`!document.getElementById('save-import-dialog').open && [...document.querySelectorAll('.box-name-input')].some(el=>el.value===${JSON.stringify(name)})`);
    const names=await evaluate(page,`(()=>{
      const box=[...document.querySelectorAll('.box-card')].find(el=>el.querySelector('.box-name-input').value===${JSON.stringify(name)});
      return [...box.querySelectorAll('.box-pokemon-card h3')].map(el=>el.textContent);
    })()`);
    assert.deepEqual(names,['shellos','shelloseast','gastrodoneast'].map(id=>dataset.get('species',id).name));
    const stored=await evaluate(page,`(async()=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('pokemon-line-calculator-boxes');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      try {
        const entries=await new Promise((resolve,reject)=>{const r=db.transaction('library','readonly').objectStore('library').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const box=entries.flatMap(library=>Object.values(library.games).flatMap(game=>Object.values(game.boxes))).find(box=>box.name===${JSON.stringify(name)});
        return {ids:box.pokemonOrder.map(id=>box.pokemon[id].speciesId),party:box.parties[box.partyOrder[0]].pokemonIds.length};
      } finally { db.close(); }
    })()`,true);
    assert.deepEqual(stored,{ids:['shellos','shelloseast','gastrodoneast'],party:2});
  }
  console.log(JSON.stringify({status:'ds-form-browser-import-valid',containers:['sav','dsv'],party:true,pcSelection:true,persistence:true}));
}
