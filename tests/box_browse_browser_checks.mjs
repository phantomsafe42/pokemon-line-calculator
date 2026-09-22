import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { addBox, createEmptyBoxLibrary } from '../src/boxes/library.js';
import { parseShowdown } from '../src/boxes/showdown.js';

export async function checkBoxBrowsing({page,evaluate,delay,dataset,tempRoot}) {
  const records=parseShowdown('Alpha (Virizion) (M) @ Leftovers\nAbility: Justified\nLevel: 44\n- Giga Drain\n- Protect\n- Quick Attack\n- Swords Dance\n\nBeta (Charmander) (F)\nAbility: Blaze\nLevel: 20\n- Ember\n\nGamma (Ditto)\nLevel: 30\n- Transform',dataset);
  records[0].majorStatus='tox';
  const added=addBox(createEmptyBoxLibrary(),dataset.gameId,{name:'Browse fixture',pokemon:records,partyPokemonIds:[records[0].id]});
  const root=`document.querySelector('.box-card[data-box-id="${added.boxId}"]')`;
  const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(page,expression))return;await delay(50);}throw Error('Browse check timed out: '+expression);};
  await evaluate(page,`(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();document.getElementById('boxes-tab').click();const t=new DataTransfer();t.items.add(new File([${JSON.stringify(JSON.stringify(added.library))}],'browse.json',{type:'application/json'}));const input=document.getElementById('import-boxes');input.files=t.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(`Boolean(${root})`);
  assert.equal(await evaluate(page,`document.querySelector('#boxes-heading')`),null,'Tab label is the only Boxes title');
  assert.ok(await evaluate(page,`document.querySelector('.box-toolbar').contains(document.getElementById('box-search'))`),'Search shares the button control panel');
  assert.equal(await evaluate(page,`document.querySelector('.box-toolbar').textContent.includes('A Pokémon is stored once per Box')`),false,'No explanatory description');
  assert.equal(await evaluate(page,`document.querySelector('.box-toolbar .toolbar-actions').firstElementChild.id`),'box-view-toggle');
  assert.equal(await evaluate(page,`document.querySelectorAll('.box-browse-controls label').length`),0,'Headings are replaced by accessible labels');
  assert.ok(await evaluate(page,`[...document.querySelectorAll('.box-browse-controls input,.box-browse-controls select')].every(c=>c.getAttribute('aria-label'))`));
  assert.deepEqual(await evaluate(page,`[...document.getElementById('box-sort').options].filter(o=>o.value.startsWith('base-')).map(o=>o.textContent)`),
    ['Base HP','Base Attack','Base Defense','Base Sp. Atk','Base Sp. Def','Base Speed']);
  assert.equal(await evaluate(page,`[...document.getElementById('box-sort').options].some(o=>/^Sort by:/i.test(o.textContent))`),false);
  assert.equal(await evaluate(page,`${root}.querySelector('.box-expand').getAttribute('aria-expanded')`),'false');
  assert.equal(await evaluate(page,`${root}.querySelectorAll('.box-pokemon-card').length`),0,'Collapsed Box defers card/sprite rendering');
  const saved=()=>evaluate(page,`new Promise((resolve,reject)=>{const request=indexedDB.open('pokemon-line-calculator-boxes');request.onsuccess=()=>{const db=request.result;const read=db.transaction('library').objectStore('library').get('active');read.onsuccess=()=>{db.close();resolve(read.result);};read.onerror=()=>reject(read.error);};})`,true);
  const before=await saved();
  await evaluate(page,`${root}.querySelector('.box-expand').click()`);
  assert.equal(await evaluate(page,`${root}.querySelectorAll('.box-pokemon-grid .box-pokemon-card').length`),3);
  await evaluate(page,`document.getElementById('box-view-toggle').click()`);
  assert.equal(await evaluate(page,`${root}.querySelectorAll('.box-simple-card').length`),3);
  assert.ok(await evaluate(page,`[...${root}.querySelectorAll('.box-simple-card .context-pre-item')].every(s=>s.options.length<=2)`),'Simple cards defer full item lists');
  await evaluate(page,`${root}.querySelector('.box-simple-card .context-pre-item').focus()`);
  assert.ok(await evaluate(page,`${root}.querySelector('.box-simple-card .context-pre-item').options.length>100`),'Focused item selector loads full list');
  assert.equal(await evaluate(page,`getComputedStyle(document.getElementById('box-view-toggle')).backgroundColor`),'rgb(57, 215, 123)');
  const change=async(id,value)=>evaluate(page,`(()=>{const s=document.getElementById(${JSON.stringify(id)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const ids=()=>evaluate(page,`[...${root}.querySelectorAll('.box-pokemon-grid .box-pokemon-card')].map(c=>c.dataset.pokemonId)`);
  await change('box-filter-type1','grass');await change('box-filter-type2','fighting');
  assert.deepEqual(await ids(),[records[0].id]);
  await change('box-filter-ability','justified');await change('box-filter-move','gigadrain');await change('box-filter-status','tox');await change('box-filter-item','leftovers');await change('box-filter-gender','M');
  assert.deepEqual(await ids(),[records[0].id]);
  await change('box-filter-move2','Swords Dance');await change('box-filter-move3','Protect');await change('box-filter-move4','Quick Attack');
  assert.deepEqual(await ids(),[records[0].id],'All four moves match regardless of moveset slot');
  await change('box-filter-move4','Ember');assert.deepEqual(await ids(),[]);
  await change('box-filter-move4','Quick Attack');
  assert.equal(await evaluate(page,`${root}.querySelectorAll('.party-card-grid > article').length`),1,'Filtering never filters party membership');
  await change('box-filter-gender','F'); assert.deepEqual(await ids(),[]);
  assert.match(await evaluate(page,`${root}.querySelector('.box-pokemon-grid').textContent`),/No Pokémon match/);
  await evaluate(page,`document.getElementById('box-clear-filters').click();document.getElementById('box-search').value='beta';document.getElementById('box-search').dispatchEvent(new Event('input'))`);
  await wait(`${root}.querySelectorAll('.box-pokemon-grid .box-pokemon-card').length===1`);
  assert.deepEqual(await ids(),[records[1].id]);
  await evaluate(page,`document.getElementById('box-clear-filters').click()`);
  await change('box-sort','level');await change('box-sort-direction','desc');
  await evaluate(page,`document.getElementById('box-clear-filters').click()`);
  assert.deepEqual(await ids(),[records[0].id,records[2].id,records[1].id]);
  await change('box-filter-type1','Grass');
  await evaluate(page,`document.getElementById('box-clear-sort').click()`);
  assert.deepEqual(await ids(),[records[0].id],'Clear sorting preserves filters');
  await evaluate(page,`document.getElementById('box-clear-filters').click()`);
  await change('box-sort','dex');await change('box-sort-direction','asc');
  assert.deepEqual(await ids(),[records[1].id,records[2].id,records[0].id]);
  await change('box-sort','spe');
  assert.equal((await ids()).length,3);
  for(const stat of ['hp','atk','def','spa','spd','spe']) {
    await change('box-sort',`base-${stat}`);
    for(const direction of ['asc','desc']) {
      await change('box-sort-direction',direction);
      const expected=[...records].sort((a,b)=>(direction==='asc'?1:-1)*(a.baseStats[stat]-b.baseStats[stat])).map(r=>r.id);
      assert.deepEqual(await ids(),expected,`${stat} base sort ${direction}`);
    }
  }
  // Edit does not select/deselect a member while the whole-card party picker is active.
  await evaluate(page,`${root}.querySelector('.party-edit').click()`);
  assert.equal(await evaluate(page,`${root}.querySelectorAll('.box-simple-card .box-party-select').length`),3);
  await evaluate(page,`${root}.querySelector('.box-simple-card .context-pokemon-actions button').click()`);
  assert.equal(await evaluate(page,`document.getElementById('pokemon-editor-dialog').open`),true);
  await evaluate(page,`document.getElementById('pokemon-editor-dialog').close();${root}.querySelector('.party-edit').click();document.getElementById('box-clear-filters').click()`);
  assert.deepEqual(await saved(),before,'View, search, filters, sort and Edit cancellation do not mutate saved records or order');
  for(const width of [2560,1280,390]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(page,`document.querySelector('.box-toolbar').scrollIntoView({block:'start'})`);
    const geometry=await evaluate(page,`(()=>{const cards=[...${root}.querySelectorAll('.box-simple-card')].map(c=>c.getBoundingClientRect());return {overflow:document.documentElement.scrollWidth>innerWidth,widths:cards.map(c=>c.width),sameRow:cards.every(c=>c.y===cards[0].y)};})()`);
    assert.equal(geometry.overflow,false,'No page overflow at '+width);
    assert.ok(await evaluate(page,`Math.abs(document.getElementById('box-view-toggle').getBoundingClientRect().left-document.getElementById('box-search').getBoundingClientRect().left)<2`),'Toolbar buttons align left with Search at '+width);
    if(width>=1280)assert.ok(await evaluate(page,`(()=>{const ids=['box-search','box-filter-type1','box-filter-type2','box-filter-ability'];return new Set(ids.map(id=>document.getElementById(id).getBoundingClientRect().top)).size===1;})()`),'Species, both Types and Ability share one row');
    assert.ok(geometry.widths.every(w=>w<800),'Simple cards narrower than Detail');
    if(width>=1280)assert.equal(geometry.sameRow,true);
    const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(tempRoot,'box-browse-'+width+'.png'),Buffer.from(shot.data,'base64'));
  }
  await evaluate(page,`document.getElementById('box-view-toggle').click();${root}.querySelector('.box-expand').click()`);
  assert.equal(await evaluate(page,`${root}.querySelector('.box-content').hidden`),true);
  await evaluate(page,`${root}.querySelector('.box-expand').click()`);
  assert.equal(await evaluate(page,`${root}.querySelectorAll('.box-pokemon-summary').length`),3,'Detailed layout restored');
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  console.log(JSON.stringify({status:'box-browsing-browser-valid',collapse:true,lazyCards:true,simpleDetail:true,filters:true,sorting:true,boxIsolation:true,widths:[2560,1280,390]}));
}
