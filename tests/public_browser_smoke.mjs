import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from "../src/adapters/standardized_dataset.js";
import { checkFreeCalcInline } from './free_calc_browser_checks.mjs';
import { checkSandbox } from './sandbox_browser_checks.mjs';
import { checkMoveSelection } from './move_selection_browser_checks.mjs';
import { checkInteractionPerformance } from './interaction_performance_browser_checks.mjs';
import { checkEventHover } from './event_hover_browser_checks.mjs';
import { checkProtectOutcomes } from './protect_browser_checks.mjs';
import { checkDsSaveForms } from './ds_save_forms_browser_checks.mjs';
import { checkBoxCards } from './box_cards_browser_checks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const publicRoot = path.join(projectRoot, "dist");
const publicPrefix = "/pokemon-line-calculator/";
const tempRoot = path.join(projectRoot, ".codex-tmp");
const profile = path.join(tempRoot, `public-browser-smoke-${process.pid}`);
const screenshot = path.join(tempRoot, "plc-public-pages.png");
const datasetLock = JSON.parse(await fs.readFile(path.join(projectRoot, "dataset-lock.json"), "utf8"));
const assetLock = JSON.parse(await fs.readFile(path.join(projectRoot, "asset-lock.json"), "utf8"));
const hostedReleaseRoot = `${datasetLock.hosted.origin}/v1/releases/${datasetLock.releaseVersion}`;
const hostedAssetReleaseRoot = `${assetLock.gateway.origin}/v1/releases/${assetLock.gateway.releaseVersion}`;
const vw2rRoot = path.join(projectRoot, "src/generated/datasets/volt-white-2r");
const readVw2r = async name => JSON.parse(await fs.readFile(path.join(vw2rRoot, name), "utf8"));
const vw2rContext = createDatasetContext({
  manifest: await readVw2r("dataset_manifest.json"),
  mechanics: await readVw2r("battle_mechanics.json"),
  documents: Object.fromEntries(await Promise.all([...REQUIRED_DATASET_SOURCES, 'starter_selection.json'].map(async name => [name, await readVw2r(name)])))
});
// Ally-only teams are not enemy encounters. Check the exact released navigation
// inventory rather than assuming a minimum number of raw trainer records.
const expectedVw2rTrainerIds = vw2rContext.trainerGroups('snivy').flatMap(group => group.trainers.map(trainer => trainer.id));
const vanillaGameOptions = [
  ["pokemon-ruby", "Ruby"],
  ["pokemon-sapphire", "Sapphire"],
  ["pokemon-emerald", "Emerald"],
  ["pokemon-firered", "FireRed"],
  ["pokemon-leafgreen", "LeafGreen"],
  ["pokemon-diamond", "Diamond"],
  ["pokemon-pearl", "Pearl"],
  ["pokemon-platinum", "Platinum"],
  ["pokemon-heartgold", "HeartGold"],
  ["pokemon-soulsilver", "SoulSilver"],
  ["pokemon-black", "Black"],
  ["pokemon-white", "White"],
  ["pokemon-black-2", "Black 2"],
  ["pokemon-white-2", "White 2"]
];
let browser = null;
let server = null;
const servedRequests = [];

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
    probe.on("error", reject);
  });
}

async function findBrowser() {
  const candidates = [
    process.env.PLC_CHROME_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error("No supported headless Chrome or Edge executable was found; set PLC_CHROME_PATH");
}

function startStaticServer(port) {
  const instance = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!url.pathname.startsWith(publicPrefix)) {
        response.writeHead(404).end("Not found");
        return;
      }
      let relativePath = decodeURIComponent(url.pathname.slice(publicPrefix.length));
      if (!relativePath || relativePath.endsWith("/")) relativePath += "index.html";
      const absolute = path.resolve(publicRoot, relativePath);
      const relative = path.relative(publicRoot, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const bytes = await fs.readFile(absolute);
      servedRequests.push({ path: relativePath.replaceAll("\\", "/"), bytes: bytes.byteLength });
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": contentTypes.get(path.extname(absolute).toLowerCase()) || "application/octet-stream"
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500).end("Not found");
    }
  });
  return new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(port, "127.0.0.1", () => resolve(instance));
  });
}

async function waitForTarget(port, appUrl, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(entry => entry.type === "page" && entry.url.startsWith(appUrl));
        if (page) return page;
      }
    } catch (error) { lastError = error; }
    await delay(200);
  }
  throw lastError || new Error("Headless browser page did not become ready");
}

function cdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(`${entry.method}: ${message.error.message}`)) : entry.resolve(message.result);
    } else events.push(message);
  });
  const rejectPending = reason => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    pending.clear();
  };
  socket.addEventListener("close", () => rejectPending("CDP WebSocket closed"));
  socket.addEventListener("error", () => rejectPending("CDP WebSocket failed"));
  return {
    events,
    ready: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    send(method, params = {}) {
      const id = ++nextId;
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 60_000);
        pending.set(id, { resolve, reject, timer, method });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() { socket.close(); }
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitForStableRuntime(client, expectedUrl, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(client, "({ href: location.href, readyState: document.readyState })");
      if (state.href.startsWith(expectedUrl) && state.readyState === "complete") return;
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
      lastError = error;
    }
    await delay(200);
  }
  throw lastError || new Error("Headless browser runtime did not become stable");
}

try {
  await fs.access(path.join(publicRoot, "public-build-manifest.json"));
  const corsProbe = await fetch(`${hostedReleaseRoot}/profiles/${datasetLock.profile}/manifest`, {
    headers: { Origin: "https://phantomsafe42.github.io" }
  });
  assert.equal(corsProbe.status, 200);
  assert.equal(corsProbe.headers.get("access-control-allow-origin"), "https://phantomsafe42.github.io");
  assert.match(corsProbe.headers.get("access-control-expose-headers") || "", /X-Content-Length/i);
  assert.match(corsProbe.headers.get("access-control-expose-headers") || "", /X-Content-SHA256/i);
  assert.equal(corsProbe.headers.get("x-content-sha256"), datasetLock.hosted.manifest.sha256);
  await corsProbe.arrayBuffer();
  await fs.mkdir(profile, { recursive: true });
  const serverPort = await availablePort();
  server = await startStaticServer(serverPort);
  const debugPort = await availablePort();
  const appUrl = `http://127.0.0.1:${serverPort}${publicPrefix}`;
  const chrome = await findBrowser();
  browser = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-software-rasterizer", "--disable-web-security", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", `--remote-debugging-port=${debugPort}`, "--remote-allow-origins=*",
    `--user-data-dir=${profile}`, appUrl
  ], { windowsHide: true, stdio: "ignore" });

  const target = await waitForTarget(debugPort, appUrl);
  const page = cdpClient(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Network.enable");
  await waitForStableRuntime(page, appUrl);

  const state = await evaluate(page, `(async () => {
    const wait = (predicate, message) => new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const poll = () => predicate() ? resolve() : Date.now() > deadline
        ? reject(new Error(message + ': ' + document.getElementById('app-status')?.textContent))
        : setTimeout(poll, 100);
      poll();
    });
    await wait(() => /Select a game to load/.test(document.getElementById('app-status')?.textContent || '')
      && document.getElementById('game-dialog')?.open
      && document.querySelectorAll('.game-picker-option').length === 20, 'public game picker');
    await wait(() => [...document.querySelectorAll('.game-picker-option img')].every(image => image.src), 'game artwork');
    const initialDialogOpen = document.getElementById('game-dialog').open;
    const gameOptions = [...document.querySelectorAll('.game-picker-option')].map(gameButton => ({
      value: gameButton.dataset.gameId,
      label: gameButton.getAttribute('aria-label'),
      visibleText: gameButton.textContent.trim(),
      disabled: gameButton.disabled,
      group: gameButton.parentElement.id,
      artTitle: gameButton.querySelector('img')?.dataset.pokemonAssetTitle || null,
      artSource: gameButton.querySelector('img')?.getAttribute('src') || null
    }));
    document.querySelector('.game-picker-option[data-game-id="pokemon-ruby"]').click();
    await wait(() => /Ruby is ready\./.test(document.getElementById('app-status')?.textContent || '')
      && document.getElementById('trainer-select').options.length > 1, 'public vanilla game data and worker');
    await wait(() => !document.getElementById('game-dialog').open, 'Ruby game selection complete');
    await wait(() => document.getElementById('starter-dialog').open, 'Ruby starter selection');
    document.querySelector('[data-starter-id="treecko"]').click();
    if (document.getElementById('plan-context-dialog').open) throw new Error('Game selection must not open New Line');
    document.getElementById('new-plan').click();
    await wait(() => document.getElementById('plan-context-dialog').open, 'explicit New Line dialog');
    const trainerSelect = document.getElementById('trainer-select');
    const planName = document.getElementById('plan-name');
    const initialPlanName = planName.value;
    trainerSelect.selectedIndex = 1;
    const expectedTrainerName = trainerSelect.selectedOptions[0].textContent.split(' · ')[0];
    trainerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => planName.value === expectedTrainerName, 'trainer-derived plan name');
    const selectedPlanName = planName.value;
    document.getElementById('plan-context-dialog').close();
    if (document.getElementById('new-plan').textContent.trim() !== 'New Line') throw new Error('New Line button label');
    if (document.querySelector('#empty-plan strong')?.textContent.trim() !== 'New Line') throw new Error('New Line empty-state hint');
    document.getElementById('new-plan').click();
    await wait(() => document.getElementById('plan-context-dialog').open
      && trainerSelect.value === ''
      && planName.value === '', 'reset clean-plan title');
    const reopenedPlanName = planName.value;
    const vanilla = {
      status: document.getElementById('app-status').textContent,
      credit: document.getElementById('game-credit').textContent,
      name: document.getElementById('current-game-name').textContent,
      trainers: document.getElementById('trainer-select').options.length,
      saveImportVisible: !document.getElementById('save-import').closest('label').hidden,
      initialPlanName,
      selectedPlanName,
      expectedTrainerName,
      reopenedPlanName
    };
    if (document.getElementById('plan-context-dialog').open) document.getElementById('plan-context-dialog').close();
    document.getElementById('new-game').click();
    await wait(() => document.getElementById('game-dialog').open, 'reopened game picker');
    document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]').click();
    await wait(() => /is ready\./.test(document.getElementById('app-status')?.textContent || '')
      && document.getElementById('trainer-select').options.length > 1, 'public game data, AI bootstrap, and resolver');
    await wait(() => !document.getElementById('game-dialog').open, 'VW2R game selection complete');
    await wait(() => document.getElementById('starter-dialog').open, 'VW2R starter selection');
    document.querySelector('[data-starter-id="snivy"]').click();
    if (document.getElementById('plan-context-dialog').open) throw new Error('Changing game must not open New Line');
    document.getElementById('new-plan').click();
    await wait(() => document.getElementById('plan-context-dialog').open, 'explicit VW2R New Line dialog');
    const vw2rTrainerSelect = document.getElementById('trainer-select');
    const neilOption = [...vw2rTrainerSelect.options].find(entry => entry.textContent.startsWith('School Kid Neil ·'));
    if (!neilOption) throw new Error('School Kid Neil is unavailable for encounter-format validation');
    vw2rTrainerSelect.value = neilOption.value;
    vw2rTrainerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const battleFormatChoice = document.getElementById('battle-format-choice');
    await wait(() => !battleFormatChoice.hidden && battleFormatChoice.options.length === 3, 'ordinary trainer format choices');
    battleFormatChoice.value = [...battleFormatChoice.options].find(entry => entry.textContent === 'Multi').value;
    battleFormatChoice.dispatchEvent(new Event('change', { bubbles: true }));
    const partnerField = document.getElementById('partner-trainer-field');
    const partnerSelect = document.getElementById('partner-trainer-select');
    await wait(() => !partnerField.hidden && partnerSelect.options.length > 1, 'same-split partner choices');
    const sameSplitPartnerCount = partnerSelect.options.length - 1;
    document.getElementById('partner-trainer-scope').click();
    await wait(() => !document.getElementById('partner-trainer-search-field').hidden
      && partnerSelect.options.length > sameSplitPartnerCount + 1, 'full-game partner choices');
    const partnerSearch = document.getElementById('partner-trainer-search');
    partnerSearch.value = 'Lenora';
    partnerSearch.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(() => [...partnerSelect.options].some(entry => /Lenora/i.test(entry.textContent)), 'full-game partner search');
    const encounterFormats = {
      choices: [...battleFormatChoice.options].map(entry => entry.textContent),
      sameSplitPartnerCount,
      searchedPartners: [...partnerSelect.options].slice(1).map(entry => entry.textContent),
      partnerHeading: partnerField.querySelector('h3')?.textContent
    };
    if (document.getElementById('plan-context-dialog').open) document.getElementById('plan-context-dialog').close();
    const assetResolver = globalThis.PokemonAssetGateway.createClient();
    const sprite = document.createElement('img');
    const spriteResult = await assetResolver.setImage(sprite, { appearanceId: 'clefairy', spriteType: 'g5-animated', view: 'front' });
    await sprite.decode();
    const result = {
      profile: document.querySelector('meta[name="plc-build-profile"]')?.content,
      initialDialogOpen,
      gameOptions,
      gameGroups: [...document.querySelectorAll('.game-picker-group > h3')].map(heading => heading.textContent),
      newGameLabel: document.getElementById('new-game').textContent,
      dropdownPresent: Boolean(document.getElementById('game-select')),
      vanilla,
      encounterFormats,
      spriteLoaded: spriteResult.status === 'ok' && sprite.naturalWidth > 0,
      assetApiVersion: assetResolver.apiVersion,
      assetOrigin: assetResolver.origin,
      assetReleaseVersion: assetResolver.releaseVersion,
      localAssetGlobalType: typeof globalThis.PokemonAssets,
      status: document.getElementById('app-status').textContent,
      gameCredit: document.getElementById('game-credit').textContent,
      currentGameName: document.getElementById('current-game-name').textContent,
      siteCredit: document.querySelector('.site-credit')?.textContent,
      eyebrowCount: document.querySelectorAll('.eyebrow').length,
      trainers: document.getElementById('trainer-select').options.length,
      tabsVisible: !document.getElementById('app-tabs').hidden,
      trainerIds: [...document.getElementById('trainer-select').options].slice(1).map(option => option.value),
      localGlobalType: typeof globalThis.__PLC_TESTING_STATE__,
      viewToggle: Boolean(document.getElementById('view-mode-toggle')),
      outputState: Boolean(document.getElementById('output-state') || document.getElementById('output-state-anchor')),
      liveEdit: Boolean(document.getElementById('live-edit-anchor') || document.getElementById('live-stop-dialog')),
      localLabels: [...document.querySelectorAll('button')].some(button => /Output State|Live Edit/i.test(button.textContent)),
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth
    };
    document.getElementById('new-game').click();
    await wait(() => document.getElementById('game-dialog').open, 'reopened game picker for Renegade Platinum');
    document.querySelector('.game-picker-option[data-game-id="renegade-platinum"]').click();
    await wait(() => /Renegade Platinum is ready\./.test(document.getElementById('app-status')?.textContent || '')
      && document.getElementById('trainer-select').options.length > 100, 'Renegade Platinum data, AI bootstrap, and resolver');
    await wait(() => document.getElementById('starter-dialog').open, 'Renegade starter selection');
    document.querySelector('[data-starter-id="chimchar"]').click();
    result.renegadePlatinum = {
      status: document.getElementById('app-status').textContent,
      trainers: document.getElementById('trainer-select').options.length
    };
    document.getElementById('new-box').click();
    await wait(() => document.querySelector('.box-card'), 'new Box rendering');
    [...document.querySelectorAll('.box-card button')].find(button => button.textContent === 'Add Pokémon').click();
    await wait(() => document.getElementById('pokemon-editor-dialog').open
      && document.getElementById('editor-species').options.length > 100
      && document.querySelectorAll('#editor-moves select').length >= 8, 'deferred Pokémon editor');
    result.deferredEditor = {
      species: document.getElementById('editor-species').options.length,
      moveControls: document.querySelectorAll('#editor-moves select').length
    };
    document.getElementById('pokemon-editor-dialog').close();
    // Exercise the simplified selector through real UI events in this isolated
    // browser profile; never read or replace the user's Boxes or active line.
    if (document.getElementById('plan-context-dialog').open) document.getElementById('plan-context-dialog').close();
    document.getElementById('showdown-open').click();
    document.getElementById('showdown-text').value = Array.from({ length: 7 }, (_, i) =>
      'Picker ' + (i + 1) + ' (Bulbasaur)\\nLevel: 15\\n- Tackle').join('\\n\\n');
    document.getElementById('import-showdown').click();
    await wait(() => !document.getElementById('showdown-dialog').open && document.querySelectorAll('.box-card').length === 2, 'picker fixture import');
    document.getElementById('new-plan').click();
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const change = (element, value) => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); };
    const dialog = document.getElementById('plan-context-dialog');
    check(document.getElementById('plan-context-title').textContent === 'New Line', 'New Line dialog title');
    for (const [id, label] of [['battle-format', 'Format'], ['plan-name', 'Plan Name'], ['initial-weather', 'Weather'], ['initial-terrain', 'Terrain']]) {
      check(document.getElementById(id).closest('label').firstChild.textContent.trim() === label, 'context label ' + id);
    }
    check(!document.getElementById('party-source-mode') && !dialog.textContent.includes('Selection source'), 'removed source selector');
    const boxSelect = document.getElementById('context-box-select');
    const partySelect = document.getElementById('context-party-select');
    const modeSelect = document.getElementById('context-mode-select');
    const boxField = document.getElementById('context-box-field');
    const partyField = document.getElementById('saved-party-field');
    const grid = document.getElementById('context-pokemon-grid');
    const saveParty = document.getElementById('save-party-selection');
    const fixtureBox = [...boxSelect.options].find(entry => /7 Pokémon/.test(entry.textContent));
    check(Boolean(fixtureBox), 'seven-member fixture Box');
    check(!document.getElementById('sandbox-mode'), 'old Sandbox toggle removed');
    check(modeSelect.value === '' && boxField.hidden && partyField.hidden, 'only blank Mode initially visible');
    check([...modeSelect.options].map(o => o.textContent).join('|') === 'Select Mode…|Sandbox|Party Lock', 'Mode choices');
    change(modeSelect, 'party-lock');
    check(!boxField.hidden && partyField.hidden && boxSelect.value === '', 'Party Lock reveals only Box');
    change(boxSelect, fixtureBox.value);
    check(!partyField.hidden, 'Box reveals Party for Party Lock');
    check(partySelect.value === '' && partySelect.selectedOptions[0].textContent === '', 'default blank Party');
    check(grid.children.length === 0 && saveParty.disabled, 'blank Party does not select or show Pokémon');
    change(partySelect, '__new_party__');
    check(grid.children.length === 7 && saveParty.disabled, 'manual picker initially empty');
    check([...grid.children].every(card => /^Lv\\. \\d+$/.test(card.querySelector('small').textContent)), 'player picker level-only subtitles');
    check([...document.querySelectorAll('.party-card-grid .context-pokemon small')].some(detail => detail.textContent.includes('Bulbasaur · Lv.')), 'Boxes retains species subtitles');
    check([...grid.querySelectorAll('.context-held-item')].every(item => item.textContent === 'No Item'), 'No Item card labels');
    check([...grid.querySelectorAll('.context-pre-item')].every(select => select.options[0].textContent === 'No Item'), 'No Item picker labels');
    for (let index = 0; index < 7; index++) grid.children[index].querySelector('button').click();
    check(grid.querySelectorAll('.is-selected').length === 6, 'six-Pokémon manual limit');
    const savedPartyId = partySelect.options[2].value;
    change(partySelect, savedPartyId);
    check(grid.children.length === 6 && !saveParty.disabled, 'saved Party loads its six members');
    check(![...grid.querySelectorAll('button')].some(button => /^(Select|Remove)$/.test(button.textContent)), 'saved Party is not manual');
    change(partySelect, '');
    check(grid.children.length === 0 && saveParty.disabled && document.getElementById('begin-plan').disabled, 'blank clears saved Party');
    change(partySelect, '__new_party__');
    check(grid.children.length === 7 && !grid.querySelector('.is-selected') && saveParty.disabled, 'returning to New Party clears saved selection');
    grid.children[6].querySelector('button').click();
    saveParty.click();
    check(!document.getElementById('party-selection-summary').hidden && document.getElementById('party-selection-summary').children.length === 1, 'save manual Party summary');
    check(/^Lv\\. \\d+$/.test(document.querySelector('#party-selection-summary .context-pokemon small').textContent), 'saved player summary level-only subtitle');
    document.getElementById('edit-party-selection').click();
    check(partySelect.value === '__new_party__' && grid.children[6].classList.contains('is-selected'), 'edit manual selection preserves chosen member');
    change(partySelect, savedPartyId);
    dialog.close();
    document.getElementById('new-plan').click();
    check(partySelect.value === '' && grid.children.length === 0 && saveParty.disabled, 'new line resets saved Party to blank');
    check(modeSelect.value === '' && boxSelect.value === '' && boxField.hidden && partyField.hidden, 'new line resets full Mode sequence');
    change(modeSelect, 'sandbox');
    check(!boxField.hidden && partyField.hidden, 'Sandbox reveals only Box');
    change(boxSelect, fixtureBox.value);
    check(partyField.hidden && partySelect.value === '' && grid.children.length === 0, 'Sandbox shows no Party or player cards');
    check(document.getElementById('party-selection-actions').hidden && document.getElementById('edit-party-selection').hidden && document.getElementById('edge-party-exp').hidden, 'Sandbox hides party setup actions');
    check(document.getElementById('party-selection-summary').hidden, 'Sandbox has no saved-party summary');
    change(document.getElementById('trainer-select'), 'renegade-platinum-trainer-0201');
    check(!document.getElementById('begin-plan').disabled, 'Sandbox can begin with Box then trainer, without saving');
    change(modeSelect, 'party-lock');
    check(!document.getElementById('party-selection-actions').hidden, 'Party Lock restores save controls');
    check(boxSelect.value === '' && partySelect.value === '' && partyField.hidden && grid.children.length === 0 && saveParty.disabled && document.getElementById('begin-plan').disabled, 'switching modes clears stale selection');
    change(modeSelect, '');
    check(boxField.hidden && partyField.hidden, 'clearing Mode hides both dropdowns');
    change(modeSelect, 'sandbox');
    const emptyBox = [...boxSelect.options].find(entry => /0 Pokémon/.test(entry.textContent));
    change(boxSelect, emptyBox.value);
    check(partySelect.value === '' && grid.children.length === 0 && saveParty.disabled, 'empty Box resets picker');
    check(document.getElementById('begin-plan').disabled, 'empty Sandbox Box cannot begin');
    change(modeSelect, 'party-lock');
    change(boxSelect, fixtureBox.value);
    change(partySelect, savedPartyId);
    change(document.getElementById('trainer-select'), 'renegade-platinum-trainer-0201');
    change(document.getElementById('battle-format-choice'), 'allied:renegade-platinum-player-partner-201-204');
    await wait(() => document.querySelectorAll('#player-partner-summary .context-pokemon').length > 0, 'Cheryl partner preview');
    for (const panel of ['enemy-team-summary', 'player-partner-summary']) {
      const cards = [...document.querySelectorAll('#' + panel + ' .context-pokemon')];
      check(cards.length > 0 && cards.every(card => /^Lv\\. \\d+$/.test(card.querySelector('small').textContent)), 'level-only subtitles ' + panel);
    }
    saveParty.click();
    check(!document.getElementById('begin-plan').disabled, 'saved party can begin partner battle');
    result.newLineDialog = { manualLimit: 6, savedPartyMembers: 6, enemyAndPartnerLevelOnly: true, labelsVerified: true };
    dialog.close();
    return result;
  })()`, true);

  assert.equal(state.profile, "public");
  assert.deepEqual(state.encounterFormats.choices, ["Singles", "Doubles", "Multi"]);
  assert.ok(state.encounterFormats.sameSplitPartnerCount > 0);
  assert.ok(state.encounterFormats.searchedPartners.every(label => /Lenora/i.test(label)));
  assert.equal(state.encounterFormats.partnerHeading, "Opponent Partner");
  const gameOptionById = new Map(state.gameOptions.map(option => [option.value, option]));
  assert.deepEqual(
    vanillaGameOptions.map(([gameId]) => [gameId, gameOptionById.get(gameId)?.label]),
    vanillaGameOptions
  );
  assert.equal(vanillaGameOptions.every(([gameId]) => gameOptionById.get(gameId)?.disabled === false), true);
  assert.equal(state.initialDialogOpen, true);
  assert.deepEqual(state.gameGroups, ["ROM Hacks", "Vanilla"]);
  assert.equal(state.gameOptions.length, 20);
  assert.equal(state.gameOptions.every(option => option.visibleText === "" && option.label && option.artSource), true);
  assert.equal(state.gameOptions.filter(option => option.group === "rom-hacks-games").length, 6);
  assert.equal(state.gameOptions.filter(option => option.group === "vanilla-games").length, 14);
  assert.equal(gameOptionById.get("fire-red-omega")?.artTitle, "fire-red-omega");
  assert.equal(gameOptionById.get("platinum-kaizo")?.artTitle, "platinum-kaizo");
  assert.equal(state.newGameLabel, "New Game");
  assert.equal(state.dropdownPresent, false);
  assert.match(state.vanilla.status, /starter saved for Ruby/);
  assert.equal(state.vanilla.credit, "by Game Freak");
  assert.equal(state.vanilla.name, "Ruby");
  assert.ok(state.vanilla.trainers > 1);
  assert.equal(state.vanilla.saveImportVisible, true);
  assert.equal(state.vanilla.initialPlanName, "");
  assert.equal(state.vanilla.selectedPlanName, state.vanilla.expectedTrainerName);
  assert.equal(state.vanilla.selectedPlanName.endsWith(" Plan"), false);
  assert.equal(state.vanilla.reopenedPlanName, "");
  assert.equal(state.spriteLoaded, true);
  assert.equal(state.assetApiVersion, "pokemon-asset-gateway-client/v1");
  assert.equal(state.assetOrigin, assetLock.gateway.origin);
  assert.equal(state.assetReleaseVersion, assetLock.gateway.releaseVersion);
  assert.equal(state.localAssetGlobalType, "undefined");
  assert.match(state.status, /starter saved for Volt White 2 Redux/);
  assert.equal(state.gameCredit, "by AphexCubed and Drayano");
  assert.equal(state.currentGameName, "Volt White 2 Redux - Challenge Mode");
  assert.equal(state.siteCredit, "twitch.tv/phantomsafe");
  assert.equal(state.eyebrowCount, 0);
  assert.equal(state.trainers, expectedVw2rTrainerIds.length + 1);
  assert.deepEqual(state.trainerIds, expectedVw2rTrainerIds);
  assert.match(state.renegadePlatinum.status, /starter saved for Renegade Platinum/);
  assert.ok(state.renegadePlatinum.trainers > 100);
  assert.ok(state.deferredEditor.species > 100);
  assert.equal(state.deferredEditor.moveControls, 8);
  assert.equal(state.tabsVisible, true);
  assert.equal(state.localGlobalType, "undefined");
  assert.equal(state.viewToggle, false);
  assert.equal(state.outputState, false);
  assert.equal(state.liveEdit, false);
  assert.equal(state.localLabels, false);
  assert.ok(state.scrollWidth <= state.viewport);

  await evaluate(page, `(() => {
    [...document.querySelectorAll('.box-card button')].find(button => button.textContent === 'Add Pokémon').click();
    document.getElementById('editor-species').focus();
  })()`);
  const speciesChoices = await evaluate(page, `({
    separateSearch: Boolean(document.getElementById('editor-species-search')),
    labels: [...document.getElementById('editor-species').options].map(option => option.textContent)
  })`);
  assert.equal(speciesChoices.separateSearch, false);
  assert.match(speciesChoices.labels[0], /^Bulbasaur · #001$/);
  assert.ok(speciesChoices.labels.indexOf('Ivysaur · #002') < speciesChoices.labels.indexOf('Charmander · #004'));
  for (const key of 'turtwig') {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  }
  assert.equal(await evaluate(page, `document.getElementById('editor-species').value`), 'turtwig');
  assert.equal(await evaluate(page, `document.getElementById('pokemon-editor-dialog').open`), true);
  await evaluate(page, `document.getElementById('pokemon-editor-dialog').close()`);

  await evaluate(page, `document.getElementById('new-game').click()`);
  await delay(150);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(250);
  const mobile = await evaluate(page, `({
    viewport: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    pickerOpen: document.getElementById('game-dialog').open,
    pickerWidth: document.getElementById('game-dialog').getBoundingClientRect().width
  })`);
  assert.ok(mobile.scrollWidth <= mobile.viewport);
  assert.equal(mobile.pickerOpen, true);
  assert.ok(mobile.pickerWidth <= mobile.viewport);

  await evaluate(page, `(() => {
    document.getElementById('game-dialog').close();
    document.getElementById('new-plan').click();
    const change = (id, value) => { const element = document.getElementById(id); element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); };
    const boxes = document.getElementById('context-box-select');
    change('context-mode-select', 'party-lock');
    change('context-box-select', [...boxes.options].find(entry => /7 Pokémon/.test(entry.textContent)).value);
    change('context-party-select', document.getElementById('context-party-select').options[2].value);
    change('trainer-select', 'renegade-platinum-trainer-0201');
    change('battle-format-choice', 'allied:renegade-platinum-player-partner-201-204');
  })()`);
  for (const width of [320, 390, 1280, 1920]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await delay(150);
    const layout = await evaluate(page, `(() => {
      const dialog = document.getElementById('plan-context-dialog');
      return { open: dialog.open, width: dialog.getBoundingClientRect().width, innerWidth, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth };
    })()`);
    assert.equal(layout.open, true);
    assert.ok(layout.width <= layout.innerWidth, 'New Line dialog fits viewport ' + width);
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, 'New Line dialog has no horizontal overflow ' + width);
  }
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await delay(150);
  const image = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile(screenshot, Buffer.from(image.data, "base64"));

  const beforeForecastEventCount = page.events.length;
  // Actual worker-to-panel replacement evidence, in this disposable browser only.
  await evaluate(page, `(() => {
    const trainers = document.getElementById('trainer-select');
    trainers.value = 'renegade-platinum-trainer-0246';
    trainers.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('save-party-selection').click();
    document.getElementById('begin-plan').click();
    const toggle = document.getElementById('ai-forecast-toggle');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  let replacementText = [];
  const replacementDeadline = Date.now() + 60000;
  while (Date.now() < replacementDeadline) {
    replacementText = await evaluate(page, `[...document.querySelectorAll('.ai-replacement-note .ai-forecast-option')].map(row => row.textContent)`);
    if (replacementText.length) break;
    await delay(250);
  }
  assert.ok(replacementText.length, 'real replacement forecast renders');
  assert.ok(replacementText.every(text => /Type score|AI damage score|First eligible Pokémon/.test(text)), JSON.stringify(replacementText));
  assert.ok(replacementText.every(text => !/Guaranteed|Likely|Unlikely|Selection details unavailable/.test(text)));
  for (const width of [390, 1280]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    await delay(150);
    const fits = await evaluate(page, `document.documentElement.scrollWidth <= innerWidth + 1`);
    assert.ok(fits, 'replacement descriptions fit ' + width);
    await evaluate(page, `document.querySelector('.ai-replacement-note').scrollIntoView({block:'center'})`);
    const forecastImage = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(path.join(tempRoot, 'replacement-reasons-' + width + '.png'), Buffer.from(forecastImage.data, 'base64'));
  }

  await evaluate(page, `(async () => {
    const wait = async (check, label) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(label); };
    const change = (id, value) => { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('change', {bubbles:true})); };
    document.getElementById('new-game').click();
    document.querySelector('.game-picker-option[data-game-id="volt-white-2r"]').click();
    await wait(() => document.getElementById('destructive-dialog').open, 'confirm disposable test line replacement');
    document.getElementById('destructive-discard').click();
    await wait(() => /Volt White 2 Redux.*is ready/.test(document.getElementById('app-status').textContent), 'VW2R ready');
    document.getElementById('showdown-open').click();
    document.getElementById('showdown-text').value = 'Squirtle\\nLevel: 20\\nHardy Nature\\n- Tackle';
    document.getElementById('import-showdown').click();
    await wait(() => !document.getElementById('showdown-dialog').open, 'Showdown import');
    document.getElementById('new-plan').click();
    const box = document.getElementById('context-box-select');
    change('context-mode-select', 'party-lock');
    change('context-box-select', [...box.options].find(option => /1 Pokémon/.test(option.textContent)).value);
    change('context-party-select', document.getElementById('context-party-select').options[2].value);
    const trainers = document.getElementById('trainer-select');
    change('trainer-select', [...trainers.options].find(option => option.textContent.startsWith('School Kid Neil ·')).value);
    document.getElementById('save-party-selection').click();
    document.getElementById('begin-plan').click();
    const toggle = document.getElementById('ai-forecast-toggle');
    toggle.checked = true; toggle.dispatchEvent(new Event('change', {bubbles:true}));
  })()`, true);
  const gen5Deadline = Date.now() + 60000;
  let gen5Lines = [];
  while (Date.now() < gen5Deadline) {
    gen5Lines = await evaluate(page, `[...document.querySelectorAll('.ai-replacement-note .ai-forecast-option')].map(row => row.textContent)`);
    if (gen5Lines.some(text => text.includes(' × '))) break;
    await delay(250);
  }
  assert.ok(gen5Lines.length && gen5Lines.every(text => /\(\d+ × [\d.]+ = \d+/.test(text)), JSON.stringify(gen5Lines));
  await evaluate(page, `document.querySelector('.ai-replacement-note').scrollIntoView({block:'center'})`);
  const gen5Image = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(tempRoot, 'replacement-reasons-gen5.png'), Buffer.from(gen5Image.data, 'base64'));

  await delay(250);
  const browserErrors = page.events
    .filter(event => event.method === "Runtime.exceptionThrown")
    .map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
  const failedRequests = page.events
    .filter(event => event.method === "Network.loadingFailed")
    .map(event => `${event.params.errorText}: ${event.params.requestId}`);
  const badResponses = page.events
    .filter(event => event.method === "Network.responseReceived" && event.params.response.status >= 400)
    .map(event => `${event.params.response.status} ${event.params.response.url}`);
  const requestedUrls = page.events.slice(0, beforeForecastEventCount)
    .filter(event => event.method === "Network.requestWillBeSent")
    .map(event => event.params.request.url);
  const performance = {
    requests: requestedUrls.length,
    servedRequests: servedRequests.length,
    servedBytes: servedRequests.reduce((sum, request) => sum + request.bytes, 0),
    localDatasetRequests: servedRequests.filter(request => request.path.includes("/src/generated/datasets/") || request.path.includes("/src/generated/trainer-ai/")).length,
    hostedCatalogRequests: requestedUrls.filter(url => url === `${hostedReleaseRoot}/catalog`).length,
    hostedManifestRequests: requestedUrls.filter(url => url === `${hostedReleaseRoot}/profiles/${datasetLock.profile}/manifest`).length,
    hostedDatasetManifestRequests: requestedUrls.filter(url => url.startsWith(`${hostedReleaseRoot}/`) && url.endsWith("/dataset_manifest.json")).length,
    hostedTrainerAiBootstrapRequests: requestedUrls.filter(url => url === `${hostedReleaseRoot}/profiles/${datasetLock.profile}/files/trainer-ai/bootstrap.json`).length,
    hostedTrainerAiEvaluatorRequests: requestedUrls.filter(url => url.startsWith(`${hostedReleaseRoot}/profiles/${datasetLock.profile}/files/trainer-ai/`)
      && /\/(?:gen\d|[^/]+)\/trainer_ai(?:_engine_semantics)?\.json$/u.test(new URL(url).pathname)).length,
    hostedAssetRequests: requestedUrls.filter(url => url.startsWith(`${hostedAssetReleaseRoot}/asset?`)).length,
    bundledAssetRequests: requestedUrls.filter(url => /\/public-assets\//u.test(new URL(url).pathname)).length
  };
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(badResponses, []);
  assert.equal(requestedUrls.some(url => {
    const pathname = new URL(url).pathname;
    return pathname.startsWith("/Datasets/") || pathname.startsWith("/Battle%20Mechanics/");
  }), false);
  assert.equal(requestedUrls.some(url => /__stream-tools/i.test(url)), false);
  assert.ok(requestedUrls.filter(url => url.startsWith(`http://127.0.0.1:${serverPort}/`)).every(url => url.startsWith(appUrl)));
  assert.equal(performance.localDatasetRequests, 0, "A healthy hosted release must not mix in checked-in Dataset files");
  assert.equal(performance.hostedCatalogRequests, 1, "The immutable Dataset catalog must be shared through the release cache");
  assert.equal(performance.hostedManifestRequests, 1, "The immutable PLC manifest must be shared through the release cache");
  assert.equal(performance.hostedDatasetManifestRequests, 3, "Only the three explicitly selected games may load hosted Dataset manifests");
  assert.equal(performance.hostedTrainerAiBootstrapRequests, 1, "The compact Trainer AI bootstrap must be shared through the release cache");
  assert.equal(performance.hostedTrainerAiEvaluatorRequests, 0, "Collapsed AI Forecast must not load heavyweight Trainer AI evaluator documents");
  assert.ok(performance.hostedAssetRequests > 0, "Public sprites must use the immutable selector-only asset gateway");
  assert.equal(performance.bundledAssetRequests, 0, "Public sprites must not use a bundled asset projection");

  await checkFreeCalcInline({ page, evaluate, delay, dataset: vw2rContext, tempRoot });
  await checkSandbox({ page, evaluate, delay, dataset: vw2rContext, tempRoot });
  await checkMoveSelection({ page, evaluate, delay, dataset: vw2rContext });
  await checkInteractionPerformance({ page, evaluate, delay, dataset: vw2rContext });
  await checkEventHover({ page, evaluate, delay, dataset: vw2rContext });
  await checkProtectOutcomes({ page, evaluate, delay, dataset: vw2rContext });
  await checkDsSaveForms({ page, evaluate, delay, dataset: vw2rContext });
  await checkBoxCards({ page, evaluate, delay, tempRoot });
  if (process.env.PLC_LAYOUT_SNAPSHOT) {
    const snapshot = JSON.parse(await fs.readFile(process.env.PLC_LAYOUT_SNAPSHOT, 'utf8'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: snapshot.view.viewport.width, height: snapshot.view.viewport.height, deviceScaleFactor: 1, mobile: false });
    await evaluate(page, `(async () => {
      const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(JSON.stringify(snapshot.plan))}], 'layout.json', {type:'application/json'}));
      const input = document.getElementById('import-plan'); input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
      for(let i=0;i<200;i++) {
        if(document.getElementById('destructive-dialog').open) document.getElementById('destructive-discard').click();
        if(document.getElementById('plan-toolbar-label').textContent === ${JSON.stringify(snapshot.plan.name)} && document.querySelectorAll('.combatant-card').length===6) return;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error('Layout snapshot import timed out');
    })()`, true);
    await delay(500);
    const geometry = await evaluate(page, `(() => [...document.querySelectorAll('.combatant-card')].map(card => {
      const height=card.getBoundingClientRect().height;
      card.style.alignSelf='start'; const naturalHeight=card.getBoundingClientRect().height; card.style.removeProperty('align-self');
      return {slot:card.querySelector('.combatant-slot-heading')?.textContent,height,naturalHeight,extra:height-naturalHeight};
    }))()`);
    console.log(JSON.stringify({snapshotCardGeometry:geometry}));
    assert.ok(geometry.every(card=>Math.abs(card.extra)<1), 'Snapshot cards must not stretch to match adjacent cards');
    await evaluate(page, `document.getElementById('enemy-action-panel').scrollIntoView({block:'start'})`);
    const layoutImage = await page.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(tempRoot,'output-state-layout.png'),Buffer.from(layoutImage.data,'base64'));
  }
  const freeCalcErrors = page.events.filter(event => event.method === 'Runtime.exceptionThrown');
  assert.deepEqual(freeCalcErrors, [], 'No exceptions during inline Free Calc checks');
  page.close();
  console.log(JSON.stringify({ status: "public-browser-smoke-valid", state, mobile, performance, screenshot }, null, 2));
} finally {
  if (browser && browser.exitCode === null) browser.kill();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
