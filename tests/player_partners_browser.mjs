// Isolated headless regression. No user's browser, save, or active draft is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenario = process.env.PLC_PARTNER_SCENARIO || 'platinum-kaizo';
const gameId = scenario === 'subway' ? 'volt-white-2r' : ['striaton','frigate'].includes(scenario) ? 'pokemon-black-2' : scenario;
const cases = {
  frigate: {trainer:'pokemon-black-2-giant-chasm-plasma-pair',partner:null,species:'Scraggy',cards:0},
  'pokemon-black': {trainer:'pokemon-black-wellspring-cave-plasma-pair',partner:'pokemon-black-trainer-0056',species:'Tepig',cards:2},
  'pokemon-white': {trainer:'pokemon-white-wellspring-cave-plasma-pair',partner:'pokemon-white-trainer-0056',species:'Tepig',cards:2},
  'pokemon-emerald': {trainer:'pokemon-emerald-mossdeep-space-center-maxie-tabitha',partner:'pokemon-emerald-documentation-trainer-0539',species:'Metang',cards:3},
  'pokemon-diamond': {trainer:'pokemon-diamond-player-partner-201-204',partner:'pokemon-diamond-trainer-0608',species:'Chansey',cards:1},
  'pokemon-heartgold': {trainer:'heartgold-soulsilver-script-pair-0479-0499',partner:'pokemon-heartgold-trainer-0675',species:'Dragonite',cards:1},
  'pokemon-black-2': {trainer:'pokemon-black-2-nimbasa-subway-bosses',partner:'pokemon-black-2-trainer-0363',species:'Dewott',cards:2},
  striaton: {trainer:'pokemon-black-2-striaton-restaurant-brothers-with-0496',partner:'pokemon-black-2-trainer-0496',species:'Maractus',cards:3},
  'renegade-platinum': {trainer:'renegade-platinum-trainer-0201', choice:'allied:renegade-platinum-player-partner-201-204',partner:'renegade-platinum-trainer-0608',species:'Chansey',cards:3},
  'storm-silver': {trainer:'storm-silver-player-partner-88-87',partner:'storm-silver-trainer-0040',species:'Porygon2',cards:3},
  'volt-white-2r': {trainer:'castelia-sewers-plasma-tag',partner:'vw2r-trainer-0062',species:'Pignite',cards:3},
  subway: {trainer:'nimbasa-subway-bosses-tag',partner:'vw2r-trainer-0099:final-rom-trainer-363',species:'Dewott',cards:2}
};
const temporary = path.join(root, '.codex-tmp');
await fs.mkdir(temporary, {recursive:true});
const profile = await fs.mkdtemp(path.join(temporary, 'partner-browser-'));
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const server = http.createServer(async(req,res)=>{
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root+path.sep)) return res.writeHead(403).end();
    const bytes = await fs.readFile(file);
    res.writeHead(200, {'content-type': {'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css'}[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-store'}).end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url = process.env.PLC_PARTNER_TEST_URL || `http://127.0.0.1:${server.address().port}/`;
const chrome = process.env.PLC_CHROME_PATH || path.join(process.env.ProgramFiles,'Google/Chrome/Application/chrome.exe');
const browser = spawn(chrome, ['--headless=new','--disable-gpu','--disable-web-security','--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], {windowsHide:true,stdio:'ignore'});
let socket;
try {
  let port;
  for(let i=0;i<100;i++) { try { port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]); break; } catch { await delay(100); } }
  assert.ok(port,'Headless browser started');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
  await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
  const pending=new Map(); const errors=[]; let nextId=0;
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const task=pending.get(message.id);
    if(task){pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(new Error(message.error.message)):task.resolve(message.result);}
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++nextId; const timer=setTimeout(()=>reject(new Error(method+' timeout')),45000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async(expression)=>{
    const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable'); await send('Network.enable');
  // Exercise the checked-in candidate projection, not the older public release.
  await send('Network.setBlockedURLs',{urls:['*datasets.phantomsafe.tv*']});
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url}); await delay(1000);
  const evidence=await evaluate(`(async()=>{
    const wait=async(predicate,label)=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error(label+': '+document.querySelector('#app-status')?.textContent)};
    const el=id=>document.getElementById(id);
    await wait(()=>document.querySelector('[data-game-id="${gameId}"]'),'game picker');
    // Seed only this isolated test profile with one user-owned Pokémon.
    const {addBox,IndexedDbBoxLibraryStore}=await import('./src/boxes/library.js');
    const species=(await (await fetch('./src/generated/datasets/${gameId}/species.json')).json()).records.charmeleon;
    const record={id:'test-player',speciesId:'charmeleon',displayName:'Charmeleon',level:23,natureId:'hardy',abilityId:'blaze',baseStats:species.baseStats,
      ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},evs:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0},
      moves:[{moveId:'ember',name:'Ember',pp:25,basePower:40,type:'fire'}]};
    const pokemon=${JSON.stringify(scenario)}==='frigate'?[record,{...structuredClone(record),id:'test-player-two'}]:[record];
    await new IndexedDbBoxLibraryStore().save(addBox(null,'${gameId}',{pokemon,partyPokemonIds:pokemon.map(mon=>mon.id)}).library);
    return true;
  })()`);
  assert.equal(evidence,true);
  await send('Page.reload'); await delay(1000);
  const result=await evaluate(`(async()=>{
    const wait=async(predicate,label)=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error(label+': '+document.querySelector('#app-status')?.textContent)};
    const el=id=>document.getElementById(id), change=id=>el(id).dispatchEvent(new Event('change',{bubbles:true}));
    await wait(()=>document.querySelector('[data-game-id="${gameId}"]'),'game picker');
    document.querySelector('[data-game-id="${gameId}"]').click();
    await wait(()=>el('trainer-select').options.length>1 && el('plan-context-dialog').open,'game load');
    const scenario=${JSON.stringify(cases[scenario] || null)};
    let ambiguous=null, singles=null;
    if (!scenario) {
      el('trainer-select').value='platinum-kaizo-veilstone-tag-battle'; change('trainer-select');
      ambiguous={options:el('player-partner-select').options.length,selected:el('player-partner-select').value,beginDisabled:el('begin-plan').disabled};
      el('trainer-select').value='platinum-kaizo-occurrence-0047'; change('trainer-select');
    } else {
      el('trainer-select').value=scenario.trainer; change('trainer-select');
      if(scenario.choice) {
        singles={format:el('battle-format-choice').selectedOptions[0]?.text,partnerHidden:el('player-partner-panel').hidden};
        el('battle-format-choice').value=scenario.choice;change('battle-format-choice');
      }
      ambiguous={options:el('player-partner-select').options.length,selected:el('player-partner-select').value,beginDisabled:el('begin-plan').disabled};
      if(scenario.partner) {el('player-partner-select').value=scenario.partner;change('player-partner-select');}
    }
    const partner={id:el('player-partner-select').value,cards:el('player-partner-summary').children.length,visible:!el('player-partner-panel').hidden};
    el('context-box-select').selectedIndex=1; change('context-box-select');
    el('context-party-select').selectedIndex=1; change('context-party-select');
    el('save-party-selection').click();
    const ready=!el('begin-plan').disabled;
    return {ambiguous,singles,partner,ready};
  })()`);
  await send('Page.enable');
  const setupLayouts=[];
  for(const width of (scenario==='frigate'?[]:[1920,1280,390,320])) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:960,deviceScaleFactor:1,mobile:false});
    const layout=await evaluate(`(()=>{
      const select=document.getElementById('player-partner-select'); select.focus(); select.scrollIntoView({block:'center'});
      const cards=document.getElementById('player-partner-summary');
      const style=getComputedStyle(select);
      const gap=cards.getBoundingClientRect().top-select.getBoundingClientRect().bottom;
      const focusExtent=parseFloat(style.outlineWidth)+Math.max(0,parseFloat(style.outlineOffset));
      return {gap,focusExtent,overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.ok(layout.gap>=8 && layout.gap>layout.focusExtent, `Partner dropdown/cards overlap at ${width}px: ${JSON.stringify(layout)}`);
    assert.equal(layout.overflow,false);
    setupLayouts.push({width,...layout});
    const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(temporary,`partner-setup-${scenario}-${width}.png`),Buffer.from(screenshot.data,'base64'));
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false});
  Object.assign(result,await evaluate(`(async()=>{
    document.getElementById('begin-plan').click();
    for(let i=0;i<300;i++) {
      if(!document.getElementById('plan-context-dialog').open && document.querySelectorAll('.combatant-card').length>=4) break;
      if(i===299) throw new Error('Partner plan did not open');
      await new Promise(r=>setTimeout(r,100));
    }
    const text=document.body.innerText;
    return {hasPartner:text.includes(${JSON.stringify(cases[scenario]?.species || 'Chansey')}),hasCharmeleon:text.includes('Charmeleon'),
      cards:document.querySelectorAll('.combatant-card').length,overflow:document.documentElement.scrollWidth>innerWidth};
  })()`));
  if(scenario === 'platinum-kaizo' || scenario === 'subway') {
    assert.equal(result.ambiguous.options,7); assert.equal(result.ambiguous.selected,''); assert.equal(result.ambiguous.beginDisabled,true);
  }
  if(cases[scenario]?.choice) assert.deepEqual(result.singles,{format:'Singles',partnerHidden:true});
  if(scenario==='frigate') assert.equal(result.partner.visible,false);
  else assert.deepEqual(result.partner,{id:cases[scenario]?.partner || 'platinum-kaizo-trainer-0608',cards:cases[scenario]?.cards || 6,visible:true});
  assert.equal(result.ready,true); assert.equal(result.hasPartner,true); assert.equal(result.hasCharmeleon,true); assert.equal(result.overflow,false);
  await send('Page.enable');
  await delay(2000);
  for(const [name,width] of [['wide',1920],['desktop',1280],['mobile',390]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:960,deviceScaleFactor:1,mobile:false}); await delay(400);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(temporary,`player-partner-${scenario}-${name}.png`),Buffer.from(screenshot.data,'base64'));
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'player-partner-browser-valid',result,setupLayouts},null,2));
} finally {
  socket?.close(); browser.kill(); await new Promise(resolve=>server.close(resolve));
  // Keep the isolated profile and screenshots as local diagnostic evidence.
}
