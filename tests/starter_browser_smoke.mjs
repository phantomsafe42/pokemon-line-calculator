// Isolated automated browser fixture. Never attaches to a user's browser profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.PLC_STARTER_TEST_URL;
if (!url) throw new Error('Set PLC_STARTER_TEST_URL to the candidate site.');
const temp = path.join(root, '.codex-tmp');
await fs.mkdir(temp, { recursive: true });
const profile = await fs.mkdtemp(path.join(temp, 'starter-browser-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const chrome = process.env.PLC_CHROME_PATH || path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe');
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
try {
  let port;
  for (let n = 0; n < 100; n++) {
    try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await delay(100); }
  }
  assert.ok(port);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let serial = 0;
  const pending = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const task = pending.get(message.id);
    if (task) { clearTimeout(task.timer); pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject, timer: setTimeout(() => reject(new Error(`${method} timed out`)), 60000) });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  await send('Network.setBlockedURLs', { urls: ['*datasets.phantomsafe.tv*'] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  const helpers = `
    const el = id => document.getElementById(id);
    const wait = async (test, label) => { for (let n=0;n<450;n++) { if(test()) return; await new Promise(r=>setTimeout(r,100)); } throw new Error(label+': '+el('app-status').textContent); };
    const check = (ok, label) => { if (!ok) throw new Error(label); };
    const chooseGame = async game => {
      if (!el('game-dialog').open) el('new-game').click();
      await wait(()=>document.querySelector('[data-game-id="'+game+'"]'), 'game artwork');
      document.querySelector('[data-game-id="'+game+'"]').click();
      await wait(()=>!el('game-dialog').open && !el('app-tabs').hidden, 'game loading');
    };
    const chooseStarter = async id => {
      await wait(()=>el('starter-dialog').open, 'starter prompt');
      document.querySelector('[data-starter-id="'+id+'"]').click();
      await wait(()=>!el('starter-dialog').open, 'save starter');
    };
    const trainerIds = () => [...el('trainer-select').options].map(o=>o.value);
  `;
  const routes = await evaluate(`(async()=>{ ${helpers}
    await wait(()=>el('game-dialog').open && document.querySelector('[data-game-id="volt-white-2r"]'), 'initial picker');
    const {IndexedDbBoxLibraryStore} = await import('./src/boxes/library.js');
    const store = new IndexedDbBoxLibraryStore();
    const before = JSON.stringify(await store.load());
    await chooseGame('volt-white-2r');
    await chooseStarter('snivy');
    check(trainerIds().includes('vw2r-trainer-0001') && !trainerIds().includes('vw2r-trainer-0002'), 'VW2R Snivy route');
    check(!el('plan-context-dialog').open, 'must not auto-create a line');
    await chooseGame('fire-red-omega');
    await wait(()=>el('starter-dialog').open, 'FRO choices');
    const fro = [...el('starter-choices').children].map(c=>c.textContent);
    check(fro.join('|')==='Elekid|Magby|Smoochum', 'FRO species choices');
    await chooseStarter('magby');
    check(trainerIds().includes('fire-red-omega-trainer-0630'), 'FRO route');
    await chooseGame('pokemon-unbound'); await chooseStarter('gible');
    check(trainerIds().includes('pokemon-unbound-trainer-0433') && !trainerIds().includes('pokemon-unbound-trainer-0434'), 'Unbound route');
    await chooseGame('renegade-platinum'); await chooseStarter('chimchar');
    const option = [...el('trainer-select').options].find(o=>o.value==='renegade-platinum-trainer-0852');
    check(option?.parentElement.label==='Roark Split', 'RP alternative stays in its split');
    await chooseGame('pokemon-ruby'); await chooseStarter('treecko');
    await chooseGame('volt-white-2r');
    check(!el('starter-dialog').open && el('change-starter').textContent.includes('Snivy'), 'per-game remembered choice');
    check(JSON.stringify(await store.load())===before, 'starter choice must not add/change Boxes');
    el('boxes-tab').click(); el('change-starter').click(); await chooseStarter('oshawott');
    check(trainerIds().includes('vw2r-trainer-0003') && !trainerIds().includes('vw2r-trainer-0001'), 'Boxes changes future routes');
    return {fro, emptyBoxesPreserved:true, testedGames:5};
  })()`);
  await send('Page.reload'); await delay(500);
  await evaluate(`(async()=>{ ${helpers}
    await wait(()=>el('game-dialog').open, 'reload picker');
    await chooseGame('volt-white-2r');
    check(!el('starter-dialog').open && el('change-starter').textContent.includes('Oshawott'), 'reload persistence');
    // Seed only this disposable browser with an owned party for the active-plan test.
    const {addBox,IndexedDbBoxLibraryStore} = await import('./src/boxes/library.js');
    const species = (await (await fetch('./src/generated/datasets/volt-white-2r/species.json')).json()).records.charmeleon;
    const pokemon = {id:'starter-test',speciesId:'charmeleon',displayName:'Charmeleon',level:23,natureId:'hardy',abilityId:'blaze',
      baseStats:species.baseStats,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31},evs:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0},
      moves:[{moveId:'ember',name:'Ember',pp:25,basePower:40,type:'fire'}]};
    await new IndexedDbBoxLibraryStore().save(addBox(null,'volt-white-2r',{pokemon:[pokemon],partyPokemonIds:[pokemon.id]}).library);
  })()`);
  await send('Page.reload'); await delay(500);
  const active = await evaluate(`(async()=>{ ${helpers}
    await wait(()=>el('game-dialog').open, 'seed reload'); await chooseGame('volt-white-2r');
    el('new-plan').click(); await wait(()=>el('plan-context-dialog').open, 'new line');
    el('trainer-select').value='vw2r-trainer-0003'; el('trainer-select').dispatchEvent(new Event('change'));
    el('context-box-select').selectedIndex=1; el('context-box-select').dispatchEvent(new Event('change'));
    el('context-party-select').selectedIndex=2; el('context-party-select').dispatchEvent(new Event('change'));
    el('save-party-selection').click(); await wait(()=>!el('begin-plan').hidden&&!el('begin-plan').disabled,'ready to begin');
    el('begin-plan').click(); await wait(()=>!el('plan-context-dialog').open&&!el('workspace').hidden,'started line');
    const {IndexedDbDraftStore} = await import('./src/cache/active_draft.js');
    const store = new IndexedDbDraftStore();
    await wait(()=>el('node-tree').children.length>0,'tree');
    const before = JSON.stringify(await store.load()); const tree = el('node-tree').innerHTML;
    el('boxes-tab').click(); el('change-starter').click(); await chooseStarter('snivy');
    check(JSON.stringify(await store.load())===before,'starter edit changed active draft');
    check(el('node-tree').innerHTML===tree,'starter edit changed active tree');
    el('change-starter').click();
    return {draftUnchanged:true,treeUnchanged:true};
  })()`);
  const layouts = [];
  for (const width of [1280, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
    await delay(200);
    const layout = await evaluate(`({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,choices:[...document.querySelectorAll('.starter-choice')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};})})`);
    assert.equal(layout.overflow, false);
    assert.ok(layout.choices.every(c => c.left >= 0 && c.right <= width && c.width > 50));
    layouts.push(layout);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(path.join(temp, `starter-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'starter-browser-valid', routes, active, layouts }, null, 2));
} finally { socket?.close(); browser.kill(); }
