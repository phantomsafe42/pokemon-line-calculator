import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";

const appUrl = process.env.PLC_APP_URL || "http://127.0.0.1:8000/Web%20Tools/Pokemon%20Line%20Calculator/";
const saveFixture = process.env.PLC_VW2R_SAVE_FIXTURE ? path.resolve(process.env.PLC_VW2R_SAVE_FIXTURE) : null;
const testingStateFile = process.env.PLC_TESTING_STATE_FILE ? path.resolve(process.env.PLC_TESTING_STATE_FILE) : null;
const layoutStateFile = process.env.PLC_LAYOUT_STATE_FILE ? path.resolve(process.env.PLC_LAYOUT_STATE_FILE) : null;
const compatibilityPlanFixture = process.env.PLC_COMPATIBILITY_PLAN_FIXTURE ? path.resolve(process.env.PLC_COMPATIBILITY_PLAN_FIXTURE) : null;
const expectTestingState = process.env.PLC_EXPECT_TESTING_STATE === "1";
const debugPort = await new Promise((resolve, reject) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); });
  server.on("error", reject);
});
const tempRoot = path.resolve(".codex-tmp");
const profile = path.join(tempRoot, `browser-smoke-${process.pid}`);
const screenshots = {
  desktop: path.join(tempRoot, "plc-redesign-desktop.png"),
  crafted: path.join(tempRoot, "plc-crafted-outcome.png"),
  boxes: path.join(tempRoot, "plc-redesign-boxes.png"),
  savePlan: path.join(tempRoot, "plc-save-plan-selection.png"),
  saveBox: path.join(tempRoot, "plc-save-box-keldeo.png"),
  saveImport: path.join(tempRoot, "plc-save-import-selection.png"),
  doubles: path.join(tempRoot, "plc-redesign-doubles.png"),
  doublesWide: path.join(tempRoot, "plc-redesign-doubles-wide.png"),
  triples: path.join(tempRoot, "plc-redesign-triples.png"),
  mobile: path.join(tempRoot, "plc-redesign-mobile.png"),
  battleEnd: path.join(tempRoot, "plc-battle-end-preview.png"),
  notes: path.join(tempRoot, "plc-node-notes.png"),
  battleEndLocked: path.join(tempRoot, "plc-battle-end-locked.png"),
  branchLanes: path.join(tempRoot, "plc-branch-lanes.png")
};
let browser = null;

async function findBrowser() {
  const candidates = [
    process.env.PLC_CHROME_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(Boolean);
  for (const candidate of candidates) try { await fs.access(candidate); return candidate; } catch {}
  throw new Error("No supported headless Chrome or Edge executable was found; set PLC_CHROME_PATH");
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForJson(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch (error) { lastError = error; }
    await delay(200);
  }
  throw lastError || new Error(`${url} did not become ready`);
}

function cdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer, method } = pending.get(message.id);
      pending.delete(message.id); clearTimeout(timer);
      message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result);
    } else events.push(message);
  });
  const rejectPending = reason => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(reason)); } pending.clear(); };
  socket.addEventListener("close", () => rejectPending("CDP WebSocket closed"));
  socket.addEventListener("error", () => rejectPending("CDP WebSocket failed"));
  return {
    events,
    ready: new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); }),
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
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await client.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    } catch (error) {
      if (!/(execution context was destroyed|cannot find default execution context)/i.test(error.message) || attempt === 3) throw error;
      await delay(250);
    }
  }
}

async function capture(page, file) {
  const result = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile(file, Buffer.from(result.data, "base64"));
}

try {
  await fs.rm(profile, { recursive: true, force: true });
  await fs.mkdir(profile, { recursive: true });
  let layoutPlanFixture = null;
  if (layoutStateFile) {
    const layoutState = JSON.parse(await fs.readFile(layoutStateFile, "utf8"));
    layoutPlanFixture = path.join(profile, "layout-plan.json");
    await fs.writeFile(layoutPlanFixture, JSON.stringify(layoutState.plan || layoutState));
  }
  const chrome = await findBrowser();
  browser = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-software-rasterizer", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", `--remote-debugging-port=${debugPort}`, "--remote-allow-origins=*",
    `--user-data-dir=${profile}`, appUrl
  ], { windowsHide: true, stdio: "ignore" });
  const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json`);
  const target = targets.find(entry => entry.type === "page" && entry.url === appUrl);
  assert.ok(target, "PLC page target opened");
  const page = cdpClient(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("DOM.enable");

  const selected = await evaluate(page, `(async () => {
    const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status')?.textContent)) : setTimeout(poll, 100); poll(); });
    await wait(() => document.getElementById('game-select') && /Select a game to load/.test(document.getElementById('app-status').textContent), 'shell');
    const game = document.getElementById('game-select'); game.value = 'volt-white-2r'; game.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => !document.getElementById('app-tabs').hidden && document.getElementById('trainer-select').options.length > 400, 'game data');
    await wait(() => document.getElementById('plan-context-dialog').open, 'plan context');
    document.getElementById('plan-context-dialog').close();
    const trainerSelect = document.getElementById('trainer-select');
    const neil = [...trainerSelect.options].find(entry => /School Kid Neil/i.test(entry.textContent));
    return {
      status: document.getElementById('app-status').textContent,
      trainers: trainerSelect.options.length,
      gateHidden: document.getElementById('game-gate').hidden,
      splitLabels: [...trainerSelect.querySelectorAll('optgroup')].map(group => group.label),
      groupedTrainers: [...trainerSelect.querySelectorAll('optgroup')].reduce((count, group) => count + group.querySelectorAll('option').length, 0),
      neilSplit: neil?.parentElement?.label || null
    };
  })()`, true);
  assert.ok(selected.trainers > 400);
  assert.equal(selected.gateHidden, true);
  assert.deepEqual(selected.splitLabels, ["Cheren Split", "Roxie Split", "Burgh Split", "Elesa Split", "Clay Split", "Skyla Split", "Drayden Split", "Marlon Split", "Ghetsis Split", "Champion Split"]);
  assert.equal(selected.groupedTrainers, 427);
  assert.equal(selected.neilSplit, "Burgh Split");

  const imported = await evaluate(page, `(async () => {
    const text = ${JSON.stringify(`Clefairy
Ability: Magic Guard
Level: 25
Serious Nature
- Moonlight
- Pound
- Iron Defense
  - Toxic

Swellow
Ability: Guts
Level: 25
Serious Nature
- Wing Attack
- Quick Attack

Charmander
Ability: Blaze
Level: 25
Serious Nature
- Ember
- Tackle

Solrock
Ability: Levitate
Level: 25
Serious Nature
- Rock Slide
- Tackle`)};
    document.getElementById('boxes-tab').click();
    document.getElementById('showdown-open').click();
    document.getElementById('showdown-text').value = text;
    document.getElementById('import-showdown').click();
    const deadline = Date.now() + 10000;
    while (!document.querySelector('.box-card') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    return { boxes: document.querySelectorAll('.box-card').length, pokemon: document.querySelectorAll('.box-pokemon-card').length, parties: document.querySelectorAll('.party-card').length, status: document.getElementById('app-status').textContent };
  })()`, true);
  assert.equal(imported.boxes, 1, imported.status);
  assert.equal(imported.pokemon, 4, imported.status);
  assert.equal(imported.parties, 1, imported.status);
  const edited = await evaluate(page, `(async () => {
    document.querySelector('.box-pokemon-card .box-card-actions button').click();
    const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message)) : setTimeout(poll, 50); poll(); });
    const species = document.getElementById('editor-species');
    const ability = document.getElementById('editor-ability');
    const originalSpecies = species.value;
    const originalAbility = ability.value;
    const hiddenPowerType = document.getElementById('editor-hidden-power-type');
    const autoHiddenPowerInitial = hiddenPowerType.options[0].textContent;
    const specialDefenseIv = document.getElementById('editor-iv-spd');
    specialDefenseIv.value = '30'; specialDefenseIv.dispatchEvent(new Event('input', { bubbles: true }));
    const autoHiddenPowerAfterIv = hiddenPowerType.options[0].textContent;
    const ivBeforeOverride = specialDefenseIv.value;
    hiddenPowerType.value = 'fire'; hiddenPowerType.dispatchEvent(new Event('change', { bubbles: true }));
    const ivAfterOverride = specialDefenseIv.value;
    specialDefenseIv.value = '31'; specialDefenseIv.dispatchEvent(new Event('input', { bubbles: true }));
    const manualHiddenPowerAfterIv = hiddenPowerType.value;
    const firstMoveRow = document.querySelector('#editor-moves .move-editor-row');
    const firstMoveSelect = firstMoveRow.querySelector('select');
    const firstMoveType = firstMoveRow.querySelectorAll('select')[1];
    firstMoveSelect.value = 'hiddenpower'; firstMoveSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const hiddenPowerMoveType = firstMoveType.value;
    const hiddenPowerMoveTypeLocked = firstMoveType.disabled;
    firstMoveSelect.value = 'moonlight'; firstMoveSelect.dispatchEvent(new Event('change', { bubbles: true }));
    hiddenPowerType.value = ''; hiddenPowerType.dispatchEvent(new Event('change', { bubbles: true }));
    const speciesOptions = [...species.options].map(option => ({ value: option.value, label: option.textContent }));
    species.value = 'charmander'; species.dispatchEvent(new Event('change', { bubbles: true }));
    ability.value = 'solarpower';
    species.value = 'charmeleon'; species.dispatchEvent(new Event('change', { bubbles: true }));
    const preservedAbility = ability.value;
    const charmeleonBaseHp = document.getElementById('editor-base-hp').value;
    const sprite = document.querySelector('#editor-sprite-preview img');
    await wait(() => sprite?.complete && sprite.naturalWidth > 0, 'Charmeleon editor sprite did not load');
    const charmeleonSpriteUrl = sprite.src;
    document.getElementById('save-pokemon').click();
    await wait(() => !document.getElementById('pokemon-editor-dialog').open, 'Charmeleon Box save did not finish');
    const changedCard = document.querySelector('.box-pokemon-card');
    const charmeleonCardDetail = changedCard.querySelector('p').textContent;
    const charmeleonCardSprite = changedCard.querySelector('img');
    await wait(() => charmeleonCardSprite.complete && charmeleonCardSprite.naturalWidth > 0, 'Charmeleon Box sprite did not load');
    const charmeleonCardSpriteUrl = charmeleonCardSprite.src;

    changedCard.querySelector('.box-card-actions button').click();
    species.value = originalSpecies; species.dispatchEvent(new Event('change', { bubbles: true }));
    ability.value = originalAbility;
    const level = document.getElementById('editor-level'); level.value = '26'; level.dispatchEvent(new Event('input', { bubbles: true }));
    const actualHp = document.getElementById('editor-actual-hp').textContent;
    document.getElementById('save-pokemon').click();
    await wait(() => !document.getElementById('pokemon-editor-dialog').open, 'restored Box save did not finish');
    const dexNumbers = speciesOptions.map(option => Number(option.label.match(/^#(\d+)/)?.[1])).filter(Number.isFinite);
    return {
      actualHp,
      card: document.querySelector('.box-pokemon-card p').textContent,
      firstSpeciesLabel: speciesOptions[0]?.label,
      charmanderLabel: speciesOptions.find(option => option.value === 'charmander')?.label,
      charmeleonLabel: speciesOptions.find(option => option.value === 'charmeleon')?.label,
      dexSorted: dexNumbers.every((number, index) => index === 0 || number >= dexNumbers[index - 1]),
      preservedAbility,
      charmeleonBaseHp,
      charmeleonSpriteUrl,
      charmeleonCardDetail,
      charmeleonCardSpriteUrl,
      autoHiddenPowerInitial,
      autoHiddenPowerAfterIv,
      ivBeforeOverride,
      ivAfterOverride,
      manualHiddenPowerAfterIv,
      hiddenPowerMoveType,
      hiddenPowerMoveTypeLocked
    };
  })()`, true);
  assert.ok(Number(edited.actualHp) > 0);
  assert.match(edited.card, /Lv\. 26/);
  assert.match(edited.firstSpeciesLabel, /^#001\b/);
  assert.equal(edited.charmanderLabel, "#004 Charmander");
  assert.equal(edited.charmeleonLabel, "#005 Charmeleon");
  assert.equal(edited.dexSorted, true);
  assert.equal(edited.preservedAbility, "solarpower");
  assert.equal(edited.charmeleonBaseHp, "58");
  assert.match(edited.charmeleonSpriteUrl, /\/charmeleon\.gif$/);
  assert.match(edited.charmeleonCardDetail, /^Charmeleon · Lv\. 25/);
  assert.match(edited.charmeleonCardSpriteUrl, /\/charmeleon\.gif$/);
  assert.equal(edited.autoHiddenPowerInitial, "Auto — Dark (from IVs)");
  assert.equal(edited.autoHiddenPowerAfterIv, "Auto — Steel (from IVs)");
  assert.equal(edited.ivBeforeOverride, "30");
  assert.equal(edited.ivAfterOverride, "30");
  assert.equal(edited.manualHiddenPowerAfterIv, "fire");
  assert.equal(edited.hiddenPowerMoveType, "fire");
  assert.equal(edited.hiddenPowerMoveTypeLocked, true);
  let saveReview = { skipped: true };
  if (saveFixture) {
    const documentNode = await page.send("DOM.getDocument", { depth: 1 });
    const fileInput = await page.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: "#save-import" });
    assert.ok(fileInput.nodeId, "save import file input is available");
    const boxesBefore = await evaluate(page, `document.querySelectorAll('.box-card').length`);
    await page.send("DOM.setFileInputFiles", { nodeId: fileInput.nodeId, files: [saveFixture] });
    const reviewBefore = await evaluate(page, `(async () => {
      const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 100); poll(); });
      await wait(() => document.getElementById('save-import-dialog').open, 'save review dialog');
      const choices = [...document.querySelectorAll('#save-import-pc-boxes input[type="checkbox"]')];
      const populated = choices.find(input => Number(input.dataset.pokemonCount) > 0);
      const before = {
        choiceCount: choices.length,
        checkedCount: choices.filter(input => input.checked).length,
        previewSprites: document.querySelectorAll('#save-import-dialog img').length,
        boxCount: document.querySelectorAll('.box-card').length,
        partyText: document.getElementById('save-import-party-summary').textContent
      };
      if (!populated) throw new Error('No populated PC Box was available in the fixture');
      populated.checked = true; populated.dispatchEvent(new Event('change', { bubbles: true }));
      const selectedBox = Number(populated.value);
      const selectedPokemon = Number(populated.dataset.pokemonCount);
      return { before, selectedBox, selectedPokemon };
    })()`, true);
    await capture(page, screenshots.saveImport);
    const reviewAfter = await evaluate(page, `(async () => {
      const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 100); poll(); });
      document.getElementById('confirm-save-import').click();
      await wait(() => !document.getElementById('save-import-dialog').open && document.querySelectorAll('.box-card').length === ${boxesBefore + 1}, 'saved import');
      const importedBox = [...document.querySelectorAll('.box-card')].at(-1);
      const cards = [...importedBox.querySelectorAll('.box-pokemon-card')];
      const details = cards.map(card => card.querySelector('p').textContent);
      const noItemCard = cards.find(card => /dukdukgoat/i.test(card.querySelector('h3').textContent));
      if (!noItemCard) throw new Error('Expected no-item save fixture Pokémon was unavailable');
      const keldeoCard = cards.find(card => /^HONSE$/i.test(card.querySelector('h3').textContent));
      if (!keldeoCard) throw new Error('Expected Ordinary Keldeo save fixture Pokémon was unavailable');
      const keldeoSprite = keldeoCard.querySelector('img');
      keldeoCard.scrollIntoView({ block: 'center' });
      await wait(() => keldeoSprite.complete && keldeoSprite.naturalWidth > 0, 'Ordinary Keldeo sprite');
      const keldeoCardRect = keldeoCard.getBoundingClientRect();
      const keldeoBodyRect = keldeoCard.querySelector(':scope > div').getBoundingClientRect();
      noItemCard.querySelector('.box-card-actions button').click();
      await wait(() => document.getElementById('pokemon-editor-dialog').open, 'save Pokémon editor');
      const noItemValue = document.getElementById('editor-item').value;
      document.getElementById('pokemon-editor-dialog').close('cancel');
      return {
        importedCards: details.length,
        experienceCards: details.filter(text => text.includes(' EXP · ')).length,
        noItemValue,
        keldeoDetail: keldeoCard.querySelector('p').textContent,
        keldeoSpriteUrl: keldeoSprite.src,
        keldeoSpriteWidth: keldeoSprite.naturalWidth,
        keldeoBodyWidth: keldeoBodyRect.width,
        keldeoCardWidth: keldeoCardRect.width,
        status: document.getElementById('app-status').textContent
      };
    })()`, true);
    saveReview = { ...reviewBefore, ...reviewAfter, skipped: false };
    assert.equal(saveReview.before.choiceCount, 7);
    assert.equal(saveReview.before.checkedCount, 0);
    assert.equal(saveReview.before.previewSprites, 0);
    assert.equal(saveReview.before.boxCount, boxesBefore);
    assert.match(saveReview.before.partyText, /always imported/i);
    assert.equal(saveReview.importedCards, 6 + saveReview.selectedPokemon);
    assert.equal(saveReview.experienceCards, saveReview.importedCards);
    assert.equal(saveReview.noItemValue, "");
    assert.match(saveReview.keldeoDetail, /^Keldeo - Ordinary \u00b7/);
    assert.match(saveReview.keldeoSpriteUrl, /\/keldeo\.gif$/);
    assert.ok(saveReview.keldeoSpriteWidth > 0);
    assert.ok(saveReview.keldeoBodyWidth > saveReview.keldeoCardWidth / 2);
    await capture(page, screenshots.saveBox);
  }
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(page, `window.scrollTo(0, 0)`);
  await capture(page, screenshots.boxes);

  const planReady = await evaluate(page, `(async () => {
    const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 100); poll(); });
    document.getElementById('plc-tab').click(); document.getElementById('new-plan').click();
    const trainer = document.getElementById('trainer-select');
    const neil = [...trainer.options].find(entry => /School Kid Neil/i.test(entry.textContent));
    if (!neil) throw new Error('School Kid Neil unavailable');
    trainer.value = neil.value; trainer.dispatchEvent(new Event('change', { bubbles: true }));
    const enemyTeamPanel = document.getElementById('enemy-team-panel');
    const partyPanel = document.getElementById('party-selector-controls').closest('.party-selector-panel');
    const enemyTeam = {
      cards: [...document.querySelectorAll('#enemy-team-summary .context-pokemon')].map(card => ({
        name: card.querySelector('strong')?.textContent || '',
        detail: card.querySelector('small')?.textContent || ''
      })),
      buttons: document.querySelectorAll('#enemy-team-summary button').length,
      aboveParty: Boolean(enemyTeamPanel.compareDocumentPosition(partyPanel) & Node.DOCUMENT_POSITION_FOLLOWING)
    };
    const box = document.getElementById('context-box-select'); box.value = box.options[1].value; box.dispatchEvent(new Event('change', { bubbles: true }));
    const party = document.getElementById('context-party-select'); party.value = party.options[1].value; party.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('save-party-selection').click();
    if (document.getElementById('begin-plan').disabled) throw new Error(document.getElementById('context-status').textContent);
    document.getElementById('begin-plan').click();
    await wait(() => !document.getElementById('workspace').hidden, 'workspace');
    return {
      format: document.querySelector('#player-action-panel .pill').textContent,
      player: document.querySelector('#player-action-panel .combatant-name').textContent,
      playerMeta: document.querySelector('#player-action-panel .meta-row').textContent,
      enemy: document.querySelector('#enemy-action-panel .combatant-name').textContent,
      enemySubtitle: document.querySelector('#enemy-action-panel .combatant-species').textContent,
      enemySubtitleHeight: document.querySelector('#enemy-action-panel .combatant-species').getBoundingClientRect().height,
      enemyTeam,
      nodes: document.querySelectorAll('.node-button').length,
      expHeadings: [...document.querySelectorAll('.field-exp[data-exp-projection] strong')].map(node => node.textContent),
      expLines: [...document.querySelectorAll('.field-exp[data-exp-projection] .field-exp-line')].map(node => node.textContent)
    };
  })()`, true);
  assert.equal(planReady.format, "Singles");
  assert.match(planReady.player, /Clefairy/i);
  assert.match(planReady.playerMeta, /Lv\. 26/);
  assert.ok(planReady.enemyTeam.cards.length >= 1);
  assert.ok(planReady.enemyTeam.cards.every(card => card.name && /Lv\. \d+/.test(card.detail)));
  assert.equal(planReady.enemyTeam.buttons, 0);
  assert.equal(planReady.enemyTeam.aboveParty, true);
  assert.equal(planReady.enemySubtitle, "");
  assert.ok(planReady.enemySubtitleHeight > 0);
  assert.equal(planReady.nodes, 1);
  assert.ok(planReady.expHeadings.some(text => /If Swellow faints/i.test(text)));
  assert.ok(planReady.expLines.some(text => /Clefairy \+[\d,]+ EXP/i.test(text)));

  const turn = await evaluate(page, `(async () => {
    const colorProbe = variable => {
      const probe = document.createElement('span'); probe.style.color = variable; document.body.append(probe);
      const color = getComputedStyle(probe).color; probe.remove(); return color;
    };
    const goldColor = colorProbe('var(--gold)');
    const redColor = colorProbe('var(--red)');
    const tone = node => ({
      current: node?.classList.contains('value-current') || false,
      gold: node ? getComputedStyle(node).color === goldColor : false,
      red: node ? getComputedStyle(node).color === redColor : false
    });
    const choose = (panelId, moveName) => {
      const buttons = [...document.querySelectorAll('#' + panelId + ' .move-button')];
      const target = buttons.find(entry => entry.textContent.includes(moveName));
      if (!target) throw new Error(moveName + ' unavailable in ' + panelId + ': ' + buttons.map(entry => entry.textContent).join('|'));
      if (target.disabled) throw new Error(moveName + ' is disabled: ' + target.title);
      target.click();
    };
    choose('enemy-action-panel', 'Wing Attack');
    const waitPreview = async moveName => {
      const deadline = Date.now() + 20000;
      while ((document.getElementById('commit-turn').disabled || ![...document.querySelectorAll('.event-line')].some(entry => entry.textContent.includes(moveName))) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (document.getElementById('commit-turn').disabled) throw new Error(moveName + ' preview did not resolve');
    };
    const detail = (panelId, label) => [...document.querySelectorAll('#' + panelId + ' .static-detail')].find(cell => cell.querySelector('small')?.textContent === label)?.querySelector('strong');

    choose('player-action-panel', 'Pound');
    await waitPreview('Pound');
    const enemyHp = detail('enemy-action-panel', 'HP');
    const damagePreview = { value: enemyHp?.textContent, ...tone(enemyHp) };
    const damageBranchButtons = [...document.querySelectorAll('#player-action-panel .branch-option')].map(node => node.textContent);

    choose('player-action-panel', 'Iron Defense');
    await waitPreview('Iron Defense');
    const defenseRow = [...document.querySelectorAll('#player-action-panel .stat-table tbody tr')].find(row => row.querySelector('th')?.textContent === 'Def');
    const stagePreview = { actual: defenseRow?.children[1]?.textContent, stage: defenseRow?.children[2]?.textContent, ...tone(defenseRow?.children[1]) };

    choose('player-action-panel', 'Toxic');
    await waitPreview('Toxic');
    const enemyStatus = detail('enemy-action-panel', 'Status');
    const statusPreview = { value: enemyStatus?.textContent, ...tone(enemyStatus) };
    const branchButtons = [...document.querySelectorAll('#player-action-panel .branch-option')];
    const outcomePresentation = {
      collapsedCards: document.querySelectorAll('.outcome').length,
      collapsedProbabilities: [...document.querySelectorAll('.outcome-probability')].map(node => node.textContent),
      collapsedReasons: [...document.querySelectorAll('.outcome-reason')].map(node => node.textContent),
      reasonsYellow: [...document.querySelectorAll('.outcome-reason')].every(node => getComputedStyle(node).color === goldColor),
      damageBranchButtons,
      branchButtons: branchButtons.map(node => node.textContent),
      toggleText: document.querySelector('.outcomes-toggle')?.textContent || null
    };
    branchButtons.find(node => node.textContent === 'Misses')?.click();
    outcomePresentation.craftedCards = document.querySelectorAll('.outcome').length;
    outcomePresentation.craftedReasons = [...document.querySelectorAll('.outcome-reason')].map(node => node.textContent);
    outcomePresentation.craftedProbabilities = [...document.querySelectorAll('.outcome-probability')].map(node => node.textContent);

    choose('player-action-panel', 'Moonlight');
    await waitPreview('Moonlight');
    const lines = [...document.querySelectorAll('.event-line')].map(entry => entry.textContent);
    const raw = [...document.querySelectorAll('.damage-amounts')].map(entry => entry.textContent);
    const actionRows = [...document.querySelectorAll('.outcome-action')].map((row, index) => {
      const sprite = row.querySelector('.outcome-action-sprite img');
      const copy = row.querySelector('.outcome-action-copy');
      const spriteRect = sprite?.getBoundingClientRect();
      const copyRect = copy?.getBoundingClientRect();
      return {
        lines: [...row.querySelectorAll('.event-line')].map(entry => entry.textContent),
        spriteAlt: sprite?.alt || null,
        spriteUrl: sprite?.src || null,
        spriteBesideText: Boolean(spriteRect && copyRect && spriteRect.right <= copyRect.left + 1),
        separated: index === 0 || getComputedStyle(row).borderTopWidth === '1px'
      };
    });
    const draftNode = document.querySelector('.node-button[data-kind="draft"]');
    const threatDeadline = Date.now() + 10000;
    let threatCandidates = [...document.querySelectorAll('#enemy-action-panel [data-enemy-threat-candidate]')];
    while ((!threatCandidates.length || threatCandidates.some(node => node.dataset.damageResolved !== 'true')) && Date.now() < threatDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      threatCandidates = [...document.querySelectorAll('#enemy-action-panel [data-enemy-threat-candidate]')];
    }
    const highestThreats = threatCandidates.filter(node => node.classList.contains('enemy-highest-damage'));
    const enemyThreat = {
      candidates: threatCandidates.length,
      highest: highestThreats.length,
      red: highestThreats.length > 0 && highestThreats.every(node => getComputedStyle(node).color === redColor),
      labelled: highestThreats.every(node => /highest damage move/i.test(node.getAttribute('aria-label') || ''))
    };
    return { ready: !document.getElementById('commit-turn').disabled, lines, raw, actionRows, damagePreview, stagePreview, statusPreview, outcomePresentation, enemyThreat, unsupported: document.body.innerText.match(/unsupported/gi)?.length || 0, finalProbability: document.querySelector('.outcome-probability')?.textContent || null, draftTurnLabel: draftNode?.closest('.node-column')?.querySelector('.node-column-title')?.textContent || null, draftProbability: draftNode?.querySelector(':scope > .node-probability')?.textContent.trim() || null, draftSpriteCount: draftNode?.querySelectorAll('.node-sprite').length || 0 };
  })()`, true);
  assert.equal(turn.ready, true);
  assert.ok(turn.lines.some(line => /^Moonlight ·/i.test(line)));
  assert.ok(turn.lines.some(line => /^Slot 1 · Wing Attack ·/i.test(line)));
  assert.ok(turn.lines.every(line => !/^Clefairy ·|^Swellow ·/i.test(line)));
  assert.ok(turn.raw.some(line => /^Possible damage amounts: \(\d+¹(?:, \d+¹)*\)$/.test(line)));
  assert.equal(turn.actionRows.length, 2);
  assert.ok(turn.actionRows.every(row => row.spriteAlt && row.spriteUrl && row.spriteBesideText && row.separated));
  assert.ok(turn.actionRows.some(row => /Clefairy sprite/i.test(row.spriteAlt)));
  assert.ok(turn.actionRows.some(row => /Swellow sprite/i.test(row.spriteAlt)));
  assert.match(turn.damagePreview.value, /^\d+(?:–\d+)? \/ \d+ \(\d+\.\d%(?:–\d+\.\d%)?\)$/);
  assert.notEqual(turn.damagePreview.value.split(" / ")[0], turn.damagePreview.value.split(" / ")[1].split(" ")[0]);
  assert.equal(turn.damagePreview.current, true);
  assert.equal(turn.damagePreview.gold, true);
  assert.equal(turn.damagePreview.red, false);
  assert.equal(turn.stagePreview.stage, "+2");
  assert.equal(turn.stagePreview.current, true);
  assert.equal(turn.stagePreview.gold, true);
  assert.equal(turn.stagePreview.red, false);
  assert.equal(turn.statusPreview.value, "Bad poison");
  assert.equal(turn.statusPreview.current, true);
  assert.equal(turn.statusPreview.gold, true);
  assert.equal(turn.statusPreview.red, false);
  assert.ok(turn.enemyThreat.candidates > 0);
  assert.ok(turn.enemyThreat.highest > 0);
  assert.equal(turn.enemyThreat.red, true);
  assert.equal(turn.enemyThreat.labelled, true);
  assert.equal(turn.outcomePresentation.collapsedCards, 1);
  assert.match(turn.outcomePresentation.collapsedProbabilities[0], /84\.38%/);
  assert.equal(turn.outcomePresentation.reasonsYellow, true);
  assert.equal(turn.outcomePresentation.toggleText, null);
  assert.ok(turn.outcomePresentation.branchButtons.includes("Misses"));
  assert.ok(turn.outcomePresentation.damageBranchButtons.includes("Crit"));
  assert.equal(turn.outcomePresentation.craftedCards, 1);
  assert.ok(turn.outcomePresentation.craftedReasons.some(reason => /missed/i.test(reason)));
  assert.notEqual(turn.outcomePresentation.craftedProbabilities[0], turn.outcomePresentation.collapsedProbabilities[0]);
  assert.ok(turn.lines.some(line => /Moonlight · Healed 24–28 HP \(30\.0% - 35\.0%\)/.test(line)));
  assert.equal(turn.unsupported, 0);
  assert.equal(turn.draftTurnLabel, "Turn 1");
  assert.equal(turn.draftSpriteCount, 2);
  assert.match(turn.finalProbability, new RegExp(turn.draftProbability.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await capture(page, screenshots.crafted);

  const committed = await evaluate(page, `(async () => {
    document.getElementById('commit-turn').click();
    const deadline = Date.now() + 10000;
    while (document.querySelectorAll('.node-button').length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const columns = [...document.querySelectorAll('.node-column')].map(entry => entry.querySelector('.node-column-title').textContent);
    const nodeContents = [...document.querySelectorAll('.node-button')].map(entry => ({
      text: entry.querySelector(':scope > .node-probability')?.textContent.trim() || '',
      kind: entry.dataset.kind,
      lane: Number(entry.dataset.lane),
      centerY: entry.getBoundingClientRect().top + entry.getBoundingClientRect().height / 2,
      probabilityChildren: entry.querySelectorAll(':scope > .node-probability').length,
      childCount: entry.children.length,
      spriteCount: entry.querySelectorAll('.node-sprite').length,
      faintSpriteCount: entry.querySelectorAll('.node-sprite.has-faint').length,
      hasFaint: entry.classList.contains('has-faint'),
      ariaLabel: entry.getAttribute('aria-label')
    }));
    const committedTurnOne = document.querySelector('.node-column:first-child .node-button[data-kind="committed"]');
    committedTurnOne.click();
    const reviewDeadline = Date.now() + 10000;
    while ((!globalThis.__PLC_TESTING_STATE__.capture().transientTurn.currentPreview || document.getElementById('turn-label').textContent !== 'Turn 1') && Date.now() < reviewDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    const reviewedPlayerMove = document.querySelector('#player-action-panel .move-button[aria-pressed="true"] .move-copy strong')?.textContent || null;
    const reviewedEnemyMove = document.querySelector('#enemy-action-panel .move-button[aria-pressed="true"] .move-copy strong')?.textContent || null;
    const reviewedProposedTurn = globalThis.__PLC_TESTING_STATE__.capture().transientTurn.currentPreview?.proposedTurnNumber || null;
    const turnTwoDraft = [...document.querySelectorAll('.node-column')].find(column => column.querySelector('.node-column-title')?.textContent === 'Turn 2')?.querySelector('.node-button[data-kind="draft"]');
    turnTwoDraft.click();
    const restoreDeadline = Date.now() + 10000;
    while (document.getElementById('turn-label').textContent !== 'Turn 2' && Date.now() < restoreDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    const blueProbe = document.createElement('span'); blueProbe.style.color = 'var(--accent-2)'; document.body.append(blueProbe);
    const moonlightMeta = [...document.querySelectorAll('#player-action-panel .move-button')].find(node => node.querySelector('strong')?.textContent === 'Moonlight')?.querySelector('small');
    const persistedMoonlight = {
      value: moonlightMeta?.textContent || null,
      persisted: moonlightMeta?.classList.contains('value-persisted') || false,
      blue: moonlightMeta ? getComputedStyle(moonlightMeta).color === getComputedStyle(blueProbe).color : false
    };
    blueProbe.remove();
    return { nodes: document.querySelectorAll('.node-button').length, columns, nodeContents, reviewedPlayerMove, reviewedEnemyMove, reviewedProposedTurn, restoredTurnLabel: document.getElementById('turn-label').textContent, persistedMoonlight };
  })()`, true);
  assert.ok(committed.nodes >= 2);
  assert.deepEqual(committed.columns.slice(0, 2), ["Turn 1", "Turn 2"]);
  assert.ok(committed.nodeContents.every(entry => /^(?:\d+(?:\.\d+)?%|Probability unknown|—)(?: · tied)?$/.test(entry.text)));
  assert.ok(committed.nodeContents.every(entry => entry.probabilityChildren === 1));
  assert.ok(committed.nodeContents.filter(entry => entry.kind === "committed").every(entry => entry.childCount === 2 && entry.spriteCount === 2 && !entry.hasFaint && entry.faintSpriteCount === 0));
  assert.ok(committed.nodeContents.filter(entry => entry.kind === "draft").every(entry => entry.childCount === 1 && entry.spriteCount === 0));
  assert.equal(committed.nodeContents.find(entry => entry.kind === "committed")?.lane, 0);
  assert.equal(committed.nodeContents.find(entry => entry.kind === "draft")?.lane, 0);
  assert.ok(Math.abs(committed.nodeContents.find(entry => entry.kind === "committed").centerY - committed.nodeContents.find(entry => entry.kind === "draft").centerY) < 0.5);
  assert.ok(committed.nodeContents.some(entry => /P: Clefairy · Moonlight/.test(entry.ariaLabel) && /E: Swellow · Wing Attack/.test(entry.ariaLabel)));
  assert.equal(committed.nodeContents.find(entry => entry.kind === "draft")?.text, "—");
  assert.equal(committed.reviewedPlayerMove, "Moonlight");
  assert.equal(committed.reviewedEnemyMove, "Wing Attack");
  assert.equal(committed.reviewedProposedTurn, 1);
  assert.equal(committed.restoredTurnLabel, "Turn 2");
  assert.match(committed.persistedMoonlight.value, /PP/);
  assert.equal(committed.persistedMoonlight.persisted, true);
  assert.equal(committed.persistedMoonlight.blue, true);
  await capture(page, screenshots.desktop);

  const exportControls = await evaluate(page, `(async () => {
    document.getElementById('save-plan').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    const dialog = document.getElementById('output-dialog');
    const branchHeaders = [...dialog.querySelectorAll('.export-branch-header strong')].map(node => node.textContent.trim());
    document.getElementById('select-all-export').click();
    const turnChecks = [...dialog.querySelectorAll('.export-branch-turns input[type="checkbox"]')];
    const result = {
      dialogOpen: dialog.open,
      importInToolbar: Boolean(document.getElementById('import-plan').closest('.toolbar-actions')),
      importInDialog: dialog.contains(document.getElementById('import-plan')),
      selectAllLabel: document.getElementById('select-all-export').textContent.trim(),
      branchHeaders,
      branchChecks: [...dialog.querySelectorAll('.export-branch-header input[type="checkbox"]')].map(input => input.checked),
      turnCount: turnChecks.length,
      allTurnsSelected: turnChecks.every(input => input.checked),
      outputEnabled: !document.getElementById('output-plan').disabled
    };
    return result;
  })()`, true);
  assert.equal(exportControls.dialogOpen, true);
  assert.equal(exportControls.importInToolbar, true);
  assert.equal(exportControls.importInDialog, false);
  assert.equal(exportControls.selectAllLabel, "Select All");
  assert.deepEqual(exportControls.branchHeaders, ["Branch 1"]);
  assert.deepEqual(exportControls.branchChecks, [true]);
  assert.equal(exportControls.turnCount, 1);
  assert.equal(exportControls.allTurnsSelected, true);
  assert.equal(exportControls.outputEnabled, true);
  await capture(page, screenshots.savePlan);
  await evaluate(page, `document.getElementById('output-dialog').close()`);

  let savePlan = { skipped: true };
  if (saveFixture) {
    savePlan = await evaluate(page, `(async () => {
      const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 100); poll(); });
      document.getElementById('new-plan').click();
      const trainer = document.getElementById('trainer-select');
      const neil = [...trainer.options].find(entry => /School Kid Neil/i.test(entry.textContent));
      trainer.value = neil.value; trainer.dispatchEvent(new Event('change', { bubbles: true }));
      const box = document.getElementById('context-box-select');
      box.value = [...box.options].filter(option => option.value).at(-1).value;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      const party = document.getElementById('context-party-select');
      party.value = [...party.options].find(option => option.value).value;
      party.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('save-party-selection').click();
      document.getElementById('begin-plan').click();
      await wait(() => document.getElementById('destructive-dialog').open, 'save-plan destructive confirmation');
      document.getElementById('destructive-discard').click();
      await wait(() => !document.getElementById('workspace').hidden && /fonky/i.test(document.querySelector('#player-action-panel .combatant-name')?.textContent || ''), 'save-backed workspace');
      const expCell = [...document.querySelectorAll('#player-action-panel .static-detail')].find(cell => cell.querySelector('small')?.textContent === 'EXP');
      if (!expCell) throw new Error('Player EXP detail was unavailable');
      return { skipped: false, player: document.querySelector('#player-action-panel .combatant-name').textContent, exp: expCell.querySelector('strong').textContent };
    })()`, true);
    assert.match(savePlan.player, /fonky/i);
    assert.match(savePlan.exp, /^\d{1,3}(?:,\d{3})*\/\d{1,3}(?:,\d{3})*$/);
  }

  const responsive = await evaluate(page, `({
    viewport: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    liveVisible: document.getElementById('live-edit-anchor').childElementCount > 0,
    overflowY: getComputedStyle(document.documentElement).overflowY,
    scrollbarGutter: getComputedStyle(document.documentElement).scrollbarGutter
  })`);
  assert.ok(responsive.scrollWidth <= responsive.viewport);
  assert.equal(responsive.liveVisible, true);
  assert.equal(responsive.overflowY, "scroll");
  assert.match(responsive.scrollbarGutter, /stable/);

  const doubles = await evaluate(page, `(async () => {
    const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 100); poll(); });
    document.getElementById('new-plan').click();
    const trainer = document.getElementById('trainer-select');
    let chosen = null;
    for (const entry of [...trainer.options].filter(option => option.value)) {
      trainer.value = entry.value; trainer.dispatchEvent(new Event('change', { bubbles: true }));
      if (document.getElementById('battle-format').value === 'Doubles') { chosen = entry; break; }
    }
    if (!chosen) throw new Error('No Doubles trainer found');
    const box = document.getElementById('context-box-select'); box.value = box.options[1].value; box.dispatchEvent(new Event('change', { bubbles: true }));
    const party = document.getElementById('context-party-select'); party.value = party.options[1].value; party.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('save-party-selection').click();
    if (document.getElementById('begin-plan').disabled) throw new Error(document.getElementById('context-status').textContent);
    document.getElementById('begin-plan').click();
    await wait(() => document.getElementById('destructive-dialog').open || document.querySelectorAll('#player-action-panel .combatant-card').length === 2, 'Doubles transition');
    if (document.getElementById('destructive-dialog').open) document.getElementById('destructive-discard').click();
    await wait(() => document.querySelectorAll('#player-action-panel .combatant-card').length === 2 && document.querySelectorAll('#enemy-action-panel .combatant-card').length === 2, 'Doubles workspace');
    const playerRects = [...document.querySelectorAll('#player-action-panel .combatant-card')].map(card => card.getBoundingClientRect());
    const enemyRects = [...document.querySelectorAll('#enemy-action-panel .combatant-card')].map(card => card.getBoundingClientRect());
    const goldProbe = document.createElement('span'); goldProbe.style.color = 'var(--gold)'; document.body.append(goldProbe);
    const goldColor = getComputedStyle(goldProbe).color; goldProbe.remove();
    const playerAttackStages = [...document.querySelectorAll('#player-action-panel .combatant-card')].map(card => {
      const row = [...card.querySelectorAll('.stat-table tbody tr')].find(entry => entry.querySelector('th')?.textContent === 'Atk');
      return { stage: row?.children[2]?.textContent, current: row?.children[1]?.classList.contains('value-current') || false, gold: row?.children[1] ? getComputedStyle(row.children[1]).color === goldColor : false };
    });
    const pause = () => new Promise(resolve => setTimeout(resolve, 75));
    const targetingMove = async panelId => {
      const names = [...document.querySelectorAll('#' + panelId + ' .combatant-card:first-of-type .move-button:not(:disabled) strong')].map(node => node.textContent);
      for (const name of names) {
        const card = document.querySelector('#' + panelId + ' .combatant-card:first-of-type');
        const moveButton = [...card.querySelectorAll('.move-button:not(:disabled)')].find(node => node.querySelector('strong')?.textContent === name);
        moveButton?.click();
        await pause();
        const selectedControl = () => {
          const currentCard = document.querySelector('#' + panelId + ' .combatant-card:first-of-type');
          const selectedMove = [...currentCard.querySelectorAll('.move-button[aria-pressed="true"]')].find(node => node.querySelector('strong')?.textContent === name);
          return selectedMove?.closest('.move-button-group') || selectedMove;
        };
        let control = selectedControl();
        let slotValues = [...(control?.querySelectorAll('.damage-slot') || [])].map(slot => ({
          slot: slot.dataset.slotLabel,
          value: slot.querySelector('.damage-slot-value')?.textContent
        }));
        const deadline = Date.now() + 3000;
        while (slotValues.some(entry => entry.value === '…') && Date.now() < deadline) {
          await pause();
          control = selectedControl();
          slotValues = [...(control?.querySelectorAll('.damage-slot') || [])].map(slot => ({ slot: slot.dataset.slotLabel, value: slot.querySelector('.damage-slot-value')?.textContent }));
        }
        if (slotValues.length) {
          const currentCard = document.querySelector('#' + panelId + ' .combatant-card:first-of-type');
          const targetSelect = [...currentCard.querySelectorAll('.action-aux label')].find(label => label.childNodes[0]?.textContent?.trim() === 'Target')?.querySelector('select');
          const selectableSlots = [...control.querySelectorAll('button.damage-slot')];
          let alternateSelected = null;
          let restoredSelected = selectableSlots.find(entry => entry.getAttribute('aria-pressed') === 'true')?.dataset.slotLabel || null;
          let shellShift = 0;
          if (selectableSlots.length > 1) {
            const shellLeftBefore = document.querySelector('.app-shell').getBoundingClientRect().left;
            selectableSlots[1].click();
            await pause();
            shellShift = Math.abs(document.querySelector('.app-shell').getBoundingClientRect().left - shellLeftBefore);
            control = selectedControl();
            alternateSelected = control.querySelector('button.damage-slot[aria-pressed="true"]')?.dataset.slotLabel || null;
            control.querySelector('button.damage-slot')?.click();
            await pause();
            control = selectedControl();
            restoredSelected = control.querySelector('button.damage-slot[aria-pressed="true"]')?.dataset.slotLabel || null;
          }
          return {
            name,
            labels: slotValues.map(entry => entry.slot),
            slotValues,
            targetDropdownAbsent: !targetSelect,
            alternateSelected,
            restoredSelected,
            shellShift
          };
        }
      }
      throw new Error('No targetable damaging move found in ' + panelId);
    };
    const playerTargeting = await targetingMove('player-action-panel');
    const enemyTargeting = await targetingMove('enemy-action-panel');
    const damageBeforeSwitch = enemyTargeting.slotValues.find(entry => entry.slot === 'Slot 1')?.value;
    const currentName = document.querySelector('#player-action-panel .combatant-card:first-of-type .combatant-name').textContent;
    const otherActiveName = document.querySelector('#player-action-panel .combatant-card:nth-of-type(2) .combatant-name').textContent;
    document.querySelector('#player-action-panel .combatant-card:first-of-type .switch-button').click();
    await pause();
    let switchingCard = document.querySelector('#player-action-panel .combatant-card:first-of-type');
    const switchMenuMoveCount = switchingCard.querySelectorAll('.move-button').length;
    const switchMenuMovesDisabled = [...switchingCard.querySelectorAll('.move-button')].every(button => button.disabled);
    const switchTargetLabels = [...switchingCard.querySelectorAll('.switch-target span')].map(node => node.textContent);
    const currentSwitchOption = switchingCard.querySelector('.switch-target.is-current');
    const currentSwitchOptionSelected = currentSwitchOption?.getAttribute('aria-pressed') === 'true';
    const switchTarget = switchingCard.querySelector('.switch-target:not(.is-current)');
    if (!switchTarget) throw new Error('Doubles switch target was unavailable');
    switchTarget.click();
    await pause();
    switchingCard = document.querySelector('#player-action-panel .combatant-card:first-of-type');
    const incomingName = switchingCard.querySelector('.combatant-name').textContent;
    const incomingMoveCount = switchingCard.querySelectorAll('.move-button').length;
    const incomingMovesDisabled = [...switchingCard.querySelectorAll('.move-button')].every(button => button.disabled);
    const selectedEnemyButton = document.querySelector('#enemy-action-panel .combatant-card:first-of-type .move-button[aria-pressed="true"]');
    const selectedEnemyMove = selectedEnemyButton?.closest('.move-button-group')?.querySelector('.damage-slot[data-slot-label="Slot 1"] .damage-slot-value');
    const damageDeadline = Date.now() + 3000;
    while (selectedEnemyMove?.textContent === '…' && Date.now() < damageDeadline) await pause();
    const damageAfterSwitch = selectedEnemyMove?.textContent || null;
    switchingCard.querySelector('.switch-target.is-current')?.click();
    await pause();
    switchingCard = document.querySelector('#player-action-panel .combatant-card:first-of-type');
    const restoredCurrentName = switchingCard.querySelector('.combatant-name').textContent;
    let restoredEnemyDamage = document.querySelector('#enemy-action-panel .combatant-card:first-of-type .move-button[aria-pressed="true"]')?.closest('.move-button-group')?.querySelector('.damage-slot[data-slot-label="Slot 1"] .damage-slot-value');
    const restoredDamageDeadline = Date.now() + 3000;
    while (restoredEnemyDamage?.textContent === '…' && Date.now() < restoredDamageDeadline) {
      await pause();
      restoredEnemyDamage = document.querySelector('#enemy-action-panel .combatant-card:first-of-type .move-button[aria-pressed="true"]')?.closest('.move-button-group')?.querySelector('.damage-slot[data-slot-label="Slot 1"] .damage-slot-value');
    }
    const damageAfterCurrentPreview = restoredEnemyDamage?.textContent || null;
    const threatDeadline = Date.now() + 10000;
    let enemyThreatCandidates = [...document.querySelectorAll('#enemy-action-panel [data-enemy-threat-candidate]')];
    while ((!enemyThreatCandidates.length || enemyThreatCandidates.some(node => node.dataset.damageResolved !== 'true')) && Date.now() < threatDeadline) {
      await pause();
      enemyThreatCandidates = [...document.querySelectorAll('#enemy-action-panel [data-enemy-threat-candidate]')];
    }
    const redProbe = document.createElement('span'); redProbe.style.color = 'var(--red)'; document.body.append(redProbe);
    const redColor = getComputedStyle(redProbe).color; redProbe.remove();
    const enemyHighestThreats = enemyThreatCandidates.filter(node => node.classList.contains('enemy-highest-damage'));
    const enemyThreatTargets = [...new Set(enemyThreatCandidates.filter(node => Number.isFinite(Number(node.dataset.damageMaxPercent))).map(node => node.dataset.damageTargetKey).filter(Boolean))];
    const enemyHighestTargets = [...new Set(enemyHighestThreats.map(node => node.dataset.damageTargetKey).filter(Boolean))];
    const enemyThreatRed = enemyHighestThreats.length > 0 && enemyHighestThreats.every(node => getComputedStyle(node).color === redColor);
    document.querySelector('#player-action-panel .combatant-card:first-of-type .switch-button[aria-pressed="true"]')?.click();
    await pause();
    return {
      trainer: chosen.textContent,
      format: document.querySelector('#player-action-panel .pill').textContent,
      playerCards: document.querySelectorAll('#player-action-panel .combatant-card').length,
      enemyCards: document.querySelectorAll('#enemy-action-panel .combatant-card').length,
      playerPanelLabels: [...document.querySelectorAll('#player-action-panel .combatant-slot-heading')].map(node => node.textContent),
      enemyPanelLabels: [...document.querySelectorAll('#enemy-action-panel .combatant-slot-heading')].map(node => node.textContent),
      enabledMoves: document.querySelectorAll('.move-button:not(:disabled)').length,
      unsupported: document.body.innerText.match(/unsupported/gi)?.length || 0,
      playerCardsHorizontal: playerRects.length === 2 && Math.abs(playerRects[0].top - playerRects[1].top) < 2 && playerRects[1].left > playerRects[0].left,
      enemyCardsHorizontal: enemyRects.length === 2 && Math.abs(enemyRects[0].top - enemyRects[1].top) < 2 && enemyRects[1].left > enemyRects[0].left,
      playerAttackStages,
      playerTargetLabels: playerTargeting.labels,
      enemyTargetLabels: enemyTargeting.labels,
      playerDamageSlots: playerTargeting.slotValues,
      enemyDamageSlots: enemyTargeting.slotValues,
      playerTargetDropdownAbsent: playerTargeting.targetDropdownAbsent,
      enemyTargetDropdownAbsent: enemyTargeting.targetDropdownAbsent,
      playerAlternateSelected: playerTargeting.alternateSelected,
      enemyAlternateSelected: enemyTargeting.alternateSelected,
      playerRestoredSelected: playerTargeting.restoredSelected,
      enemyRestoredSelected: enemyTargeting.restoredSelected,
      playerSelectionShellShift: playerTargeting.shellShift,
      enemySelectionShellShift: enemyTargeting.shellShift,
      incomingName,
      currentName,
      otherActiveName,
      switchTargetLabels,
      currentSwitchOptionSelected,
      restoredCurrentName,
      damageBeforeSwitch,
      damageAfterSwitch,
      damageAfterCurrentPreview,
      enemyThreatTargets,
      enemyHighestTargets,
      enemyThreatRed,
      switchMenuMoveCount,
      switchMenuMovesDisabled,
      incomingMoveCount,
      incomingMovesDisabled
    };
  })()`, true);
  assert.equal(doubles.format, "Doubles");
  assert.equal(doubles.playerCards, 2);
  assert.equal(doubles.enemyCards, 2);
  assert.deepEqual(doubles.playerPanelLabels, ["Slot 1", "Slot 2"]);
  assert.deepEqual(doubles.enemyPanelLabels, ["Slot 3", "Slot 4"]);
  assert.ok(doubles.enabledMoves >= 8);
  assert.equal(doubles.unsupported, 0);
  assert.equal(doubles.playerCardsHorizontal, true);
  assert.equal(doubles.enemyCardsHorizontal, true);
  assert.deepEqual(doubles.playerAttackStages.map(entry => entry.stage), ["-1", "-1"]);
  assert.ok(doubles.playerAttackStages.every(entry => entry.current && entry.gold));
  assert.deepEqual(doubles.playerTargetLabels, ["Slot 3", "Slot 4"]);
  assert.deepEqual(doubles.enemyTargetLabels, ["Slot 1", "Slot 2"]);
  assert.deepEqual(doubles.playerDamageSlots.map(entry => entry.slot), ["Slot 3", "Slot 4"]);
  assert.deepEqual(doubles.enemyDamageSlots.map(entry => entry.slot), ["Slot 1", "Slot 2"]);
  assert.ok([...doubles.playerDamageSlots, ...doubles.enemyDamageSlots].every(entry => /^\d{1,3}\.\d{2}–\d{1,3}\.\d{2}%$/.test(entry.value)));
  assert.equal(doubles.playerTargetDropdownAbsent, true);
  assert.equal(doubles.enemyTargetDropdownAbsent, true);
  assert.equal(doubles.playerAlternateSelected, "Slot 4");
  assert.equal(doubles.enemyAlternateSelected, "Slot 2");
  assert.equal(doubles.playerRestoredSelected, "Slot 3");
  assert.equal(doubles.enemyRestoredSelected, "Slot 1");
  assert.ok(doubles.playerSelectionShellShift < 0.5);
  assert.ok(doubles.enemySelectionShellShift < 0.5);
  assert.notEqual(doubles.damageAfterSwitch, doubles.damageBeforeSwitch);
  assert.equal(doubles.damageAfterCurrentPreview, doubles.damageBeforeSwitch);
  assert.equal(doubles.restoredCurrentName, doubles.currentName);
  assert.equal(doubles.currentSwitchOptionSelected, true);
  assert.ok(doubles.switchTargetLabels.some(label => label === `${doubles.currentName} · Current`));
  assert.ok(doubles.switchTargetLabels.every(label => !label.startsWith(doubles.otherActiveName)));
  assert.equal(doubles.enemyThreatTargets.length, 2);
  assert.deepEqual(doubles.enemyHighestTargets.sort(), doubles.enemyThreatTargets.sort());
  assert.equal(doubles.enemyThreatRed, true);
  assert.ok(doubles.switchMenuMoveCount > 0);
  assert.equal(doubles.switchMenuMovesDisabled, true);
  assert.ok(doubles.incomingMoveCount > 0);
  assert.equal(doubles.incomingMovesDisabled, true);

  const testingState = await evaluate(page, `(async () => {
    const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 100); poll(); });
    const playerButton = document.querySelector('#player-action-panel .combatant-card:first-of-type .move-button:not(:disabled)');
    const enemyButton = document.querySelector('#enemy-action-panel .combatant-card:first-of-type .move-button:not(:disabled)');
    if (!playerButton || !enemyButton) throw new Error('Partial-selection testing moves were unavailable');
    playerButton.click(); enemyButton.click();
    await new Promise(resolve => setTimeout(resolve, 150));
    const snapshot = globalThis.__PLC_TESTING_STATE__.capture();
    const outputButton = document.getElementById('output-state');
    const available = !outputButton.hidden;
    if (available && ${expectTestingState ? "true" : "false"}) {
      outputButton.click();
      await wait(() => /Testing state saved for Codex/.test(document.getElementById('app-status').textContent), 'testing-state output');
    }
    return {
      available,
      saved: available && /Testing state saved for Codex/.test(document.getElementById('app-status').textContent),
      playerMoveId: snapshot.transientTurn.actionDraft.player[0].moveId || null,
      playerSecondEmpty: Object.keys(snapshot.transientTurn.actionDraft.player[1]).length === 0,
      enemyMoveId: snapshot.transientTurn.actionDraft.enemy[0].moveId || null,
      enemySecondEmpty: Object.keys(snapshot.transientTurn.actionDraft.enemy[1]).length === 0,
      currentPreview: snapshot.transientTurn.currentPreview,
      commitDisabled: document.getElementById('commit-turn').disabled,
      probabilityCount: document.querySelectorAll('.outcome-probability').length,
      viewportWidth: snapshot.view.viewport.width,
      activeTab: snapshot.app.activeTab,
      planKind: snapshot.plan.kind,
      boxLibraryKind: snapshot.boxLibrary.kind
    };
  })()`, true);
  assert.ok(testingState.playerMoveId);
  assert.ok(testingState.enemyMoveId);
  assert.equal(testingState.playerSecondEmpty, true);
  assert.equal(testingState.enemySecondEmpty, true);
  assert.equal(testingState.currentPreview, null);
  assert.equal(testingState.commitDisabled, true);
  assert.equal(testingState.probabilityCount, 0);
  assert.equal(testingState.activeTab, "plc");
  assert.equal(testingState.planKind, "pokemon-battle-plan");
  assert.equal(testingState.boxLibraryKind, "pokemon-line-calculator-boxes");
  if (expectTestingState) {
    assert.equal(testingState.available, true);
    assert.equal(testingState.saved, true);
  }

  const targetRefreshStability = await evaluate(page, `(async () => {
    const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 50); poll(); });
    const playerFirstGroup = [...document.querySelectorAll('#player-action-panel .combatant-card:first-of-type .move-button-group')].find(group => group.querySelectorAll('.damage-slot').length === 2 && !group.querySelector('.move-button')?.disabled);
    const playerFirstMove = playerFirstGroup?.querySelector('.move-button');
    const playerSecondMove = document.querySelector('#player-action-panel .combatant-card:nth-child(2) .move-button:not(:disabled)');
    const enemySecondMove = document.querySelector('#enemy-action-panel .combatant-card:nth-child(2) .move-button:not(:disabled)');
    if (!playerFirstMove || !playerSecondMove || !enemySecondMove) throw new Error('Moves needed for complete-preview stability test were unavailable');
    playerFirstMove.click();
    playerSecondMove.click();
    enemySecondMove.click();
    await wait(() => !document.getElementById('commit-turn').disabled && globalThis.__PLC_TESTING_STATE__.capture().transientTurn.currentPreview, 'complete Doubles preview');
    const draftNode = document.querySelector('.node-button[data-kind="draft"]');
    const draftSpriteCount = draftNode?.querySelectorAll('.node-sprite').length || 0;
    const outcomeLines = [...document.querySelectorAll('.event-line, .outcome-effect-line')].map(node => node.textContent);
    const criticalControl = [...document.querySelectorAll('#player-action-panel .branch-control')].find(node => [...node.querySelectorAll('.branch-option')].some(button => button.textContent === 'Crit'));
    const criticalCombatantName = criticalControl?.closest('.combatant-card')?.querySelector('.combatant-name')?.textContent;
    const selectedPlayerCard = () => [...document.querySelectorAll('#player-action-panel .combatant-card')].find(card => card.querySelector('.combatant-name')?.textContent === criticalCombatantName);
    const selectedPlayerMoveName = selectedPlayerCard()?.querySelector('.move-button[aria-pressed="true"] strong')?.textContent;
    const selectedPlayerMoveGroup = () => {
      const card = selectedPlayerCard();
      const selectedMove = [...card.querySelectorAll('.move-button[aria-pressed="true"]')].find(node => node.querySelector('strong')?.textContent === selectedPlayerMoveName);
      return selectedMove?.closest('.move-button-group') || selectedMove;
    };
    const selectedPlayerDamageValues = () => [...(selectedPlayerMoveGroup()?.querySelectorAll('.damage-slot-value') || [])].map(node => node.textContent);
    const normalCriticalValues = selectedPlayerDamageValues();
    const critButton = [...selectedPlayerCard().querySelectorAll('.action-aux .branch-option')].find(node => node.textContent === 'Crit');
    if (!critButton) throw new Error('Doubles Crit selector was unavailable for ' + selectedPlayerMoveName + ': ' + [...document.querySelectorAll('.branch-control')].map(node => [node.closest('.panel')?.id, node.closest('.combatant-card')?.querySelector('.combatant-name')?.textContent, node.textContent].join('/')).join('|'));
    critButton.click();
    await wait(() => {
      const values = selectedPlayerDamageValues();
      return values.length === normalCriticalValues.length && values.length === 2 && values.every((value, index) => value !== '…' && value !== normalCriticalValues[index]);
    }, 'all-slot critical damage refresh');
    const selectedCriticalValues = selectedPlayerDamageValues();
    const normalButton = [...selectedPlayerCard().querySelectorAll('.action-aux .branch-option')].find(node => node.textContent === 'Normal');
    normalButton?.click();
    await wait(() => selectedPlayerDamageValues().every((value, index) => value === normalCriticalValues[index]), 'normal damage restoration');

    const measure = () => {
      const player = document.getElementById('player-action-panel').getBoundingClientRect();
      const enemy = document.getElementById('enemy-action-panel').getBoundingClientRect();
      const field = document.getElementById('field-state').getBoundingClientRect();
      const outcomes = document.getElementById('preview-outcomes').getBoundingClientRect();
      return { playerHeight: player.height, enemyHeight: enemy.height, fieldHeight: field.height, outcomesHeight: outcomes.height, documentHeight: document.documentElement.scrollHeight };
    };
    const delta = (left, right) => Math.max(...Object.keys(left).map(key => Math.abs(left[key] - right[key])));
    const before = measure();
    let selectedEnemy = document.querySelector('#enemy-action-panel .combatant-card:first-of-type .move-button[aria-pressed="true"]');
    let group = selectedEnemy?.closest('.move-button-group');
    const alternate = group?.querySelectorAll('button.damage-slot')[1];
    if (!alternate) throw new Error('Alternate enemy Slot target was unavailable');
    alternate.click();
    const immediate = measure();
    const immediateSnapshot = globalThis.__PLC_TESTING_STATE__.capture();
    await wait(() => !document.getElementById('commit-turn').disabled && globalThis.__PLC_TESTING_STATE__.capture().transientTurn.currentPreview, 'replacement target preview');
    const settled = measure();
    selectedEnemy = document.querySelector('#enemy-action-panel .combatant-card:first-of-type .move-button[aria-pressed="true"]');
    group = selectedEnemy?.closest('.move-button-group');
    group?.querySelector('button.damage-slot')?.click();
    await wait(() => !document.getElementById('commit-turn').disabled, 'restored first target preview');
    const switchButton = document.querySelector('#player-action-panel .combatant-card:first-of-type .switch-button');
    switchButton.click();
    const voluntarySwitchTarget = document.querySelector('#player-action-panel .combatant-card:first-of-type .switch-target:not(.is-current)');
    if (!voluntarySwitchTarget) throw new Error('A voluntary switch target was unavailable for node presentation');
    const switchTargetName = voluntarySwitchTarget.querySelector('span')?.textContent || '';
    voluntarySwitchTarget.click();
    await wait(() => !document.getElementById('commit-turn').disabled && globalThis.__PLC_TESTING_STATE__.capture().transientTurn.currentPreview, 'voluntary switch preview');
    const switchRow = [...document.querySelectorAll('.outcome-action')].find(row => /Switched to/.test(row.textContent));
    const switchedDraftNode = document.querySelector('.node-button[data-kind="draft"]');
    const switchedSprite = switchedDraftNode?.querySelector('.node-sprite.has-switch-in');
    const blueProbe = document.createElement('span'); blueProbe.style.color = 'var(--accent-2)'; document.body.append(blueProbe);
    const switchNodeBlueBorder = switchedSprite ? getComputedStyle(switchedSprite).borderTopColor === getComputedStyle(blueProbe).color : false;
    blueProbe.remove();
    return {
      immediatePreviewRetained: Boolean(immediateSnapshot.transientTurn.currentPreview),
      immediateLayoutDelta: delta(before, immediate),
      settledLayoutDelta: delta(before, settled),
      draftSpriteCount,
      normalCriticalValues,
      selectedCriticalValues,
      initialIntimidateShown: outcomeLines.some(line => line === 'Intimidate') && outcomeLines.filter(line => /Attack -1/.test(line)).length >= 2,
      switchOutcomeLine: switchRow?.querySelector('.event-line')?.textContent || null,
      switchRowSpriteCount: switchRow?.querySelectorAll('.outcome-action-sprite img').length || 0,
      switchNodeBlueCount: switchedDraftNode?.querySelectorAll('.node-sprite.has-switch-in').length || 0,
      switchNodeBlueBorder,
      switchTargetName
    };
  })()`, true);
  assert.equal(targetRefreshStability.immediatePreviewRetained, true);
  assert.ok(targetRefreshStability.immediateLayoutDelta < 0.5);
  assert.equal(targetRefreshStability.draftSpriteCount, 4);
  assert.equal(targetRefreshStability.normalCriticalValues.length, 2);
  assert.ok(targetRefreshStability.selectedCriticalValues.every((value, index) => value !== targetRefreshStability.normalCriticalValues[index]));
  assert.equal(targetRefreshStability.initialIntimidateShown, true);
  assert.equal(targetRefreshStability.switchOutcomeLine, `Slot 1 · Switched to ${targetRefreshStability.switchTargetName}`);
  assert.equal(targetRefreshStability.switchRowSpriteCount, 2);
  assert.equal(targetRefreshStability.switchNodeBlueCount, 1);
  assert.equal(targetRefreshStability.switchNodeBlueBorder, true);
  await capture(page, screenshots.doubles);

  await page.send("Emulation.setDeviceMetricsOverride", { width: 2560, height: 1390, deviceScaleFactor: 1, mobile: false });
  await delay(300);
  const doublesWide = await evaluate(page, `(() => {
    const shell = document.querySelector('.app-shell').getBoundingClientRect();
    const playerPanel = document.getElementById('player-action-panel').getBoundingClientRect();
    const centerColumn = document.querySelector('.center-column').getBoundingClientRect();
    const enemyPanel = document.getElementById('enemy-action-panel').getBoundingClientRect();
    const outcomesPanel = document.querySelector('.outcomes-panel').getBoundingClientRect();
    const notesPanel = document.querySelector('.notes-panel').getBoundingClientRect();
    const playerRects = [...document.querySelectorAll('#player-action-panel .combatant-card')].map(card => card.getBoundingClientRect());
    const enemyRects = [...document.querySelectorAll('#enemy-action-panel .combatant-card')].map(card => card.getBoundingClientRect());
    return {
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      shellWidth: Math.round(shell.width),
      shellUsage: shell.width / innerWidth,
      playerCardsHorizontal: playerRects.length === 2 && Math.abs(playerRects[0].top - playerRects[1].top) < 2 && playerRects[1].left > playerRects[0].left,
      enemyCardsHorizontal: enemyRects.length === 2 && Math.abs(enemyRects[0].top - enemyRects[1].top) < 2 && enemyRects[1].left > enemyRects[0].left,
      centerBetweenSides: playerPanel.right < centerColumn.left && centerColumn.right < enemyPanel.left && Math.abs(playerPanel.top - centerColumn.top) < 2 && Math.abs(centerColumn.top - enemyPanel.top) < 2,
      notesBelowOutcomes: notesPanel.top >= outcomesPanel.bottom,
      cardWidths: playerRects.map(rect => Math.round(rect.width))
    };
  })()`);
  assert.ok(doublesWide.scrollWidth <= doublesWide.viewport);
  assert.ok(doublesWide.shellUsage >= 0.95);
  assert.equal(doublesWide.playerCardsHorizontal, true);
  assert.equal(doublesWide.enemyCardsHorizontal, true);
  assert.equal(doublesWide.centerBetweenSides, true);
  assert.equal(doublesWide.notesBelowOutcomes, true);
  assert.ok(doublesWide.cardWidths.every(width => width >= 480));
  await capture(page, screenshots.doublesWide);

  const triples = await evaluate(page, `(async () => {
    const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 30000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 100); poll(); });
    document.getElementById('new-plan').click();
    const trainer = document.getElementById('trainer-select');
    let chosen = null;
    for (const entry of [...trainer.options].filter(option => option.value)) {
      trainer.value = entry.value; trainer.dispatchEvent(new Event('change', { bubbles: true }));
      if (document.getElementById('battle-format').value === 'Triples') { chosen = entry; break; }
    }
    if (!chosen) throw new Error('No Triple trainer found');
    const box = document.getElementById('context-box-select'); box.value = box.options[1].value; box.dispatchEvent(new Event('change', { bubbles: true }));
    const party = document.getElementById('context-party-select'); party.value = party.options[1].value; party.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('save-party-selection').click();
    if (document.getElementById('begin-plan').disabled) throw new Error(document.getElementById('context-status').textContent);
    document.getElementById('begin-plan').click();
    await wait(() => document.getElementById('destructive-dialog').open || document.querySelectorAll('#player-action-panel .combatant-card').length === 3, 'Triple transition');
    if (document.getElementById('destructive-dialog').open) document.getElementById('destructive-discard').click();
    await wait(() => document.querySelectorAll('#player-action-panel .combatant-card').length === 3 && document.querySelectorAll('#enemy-action-panel .combatant-card').length === 3, 'Triple workspace');
    await new Promise(resolve => setTimeout(resolve, 250));
    const cardInfo = panelId => [...document.querySelectorAll('#' + panelId + ' .combatant-card')].map(card => {
      const rect = card.getBoundingClientRect();
      return {
        actionSlot: Number(card.dataset.actionSlot),
        displaySlot: Number(card.dataset.displaySlot),
        label: card.querySelector('.combatant-slot-heading')?.textContent.trim() || '',
        name: card.querySelector('.combatant-name')?.textContent || '',
        subtitle: card.querySelector('.combatant-species')?.textContent || '',
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width)
      };
    });
    const playerInitial = cardInfo('player-action-panel');
    const enemyInitial = cardInfo('enemy-action-panel');
    const panelReach = panelId => [...document.querySelectorAll('#' + panelId + ' .combatant-card')]
      .sort((left, right) => Number(left.dataset.displaySlot) - Number(right.dataset.displaySlot))
      .map(card => {
        const displaySlot = Number(card.dataset.displaySlot);
        const expectedOutOfRange = displaySlot === 1 ? 0 : 1;
        const groups = [...card.querySelectorAll('.move-button-group')].filter(entry => entry.querySelectorAll('.damage-slot').length === 3);
        const group = groups.find(entry => entry.querySelectorAll('.damage-slot.is-out-of-range').length === expectedOutOfRange) || groups[0];
        return {
          displaySlot,
          actionSlot: Number(card.dataset.actionSlot),
          label: card.querySelector('.combatant-slot-heading')?.textContent.trim() || '',
          name: card.querySelector('.combatant-name')?.textContent || '',
          targets: [...(group?.querySelectorAll('.damage-slot') || [])].map(target => ({
            label: target.dataset.slotLabel,
            reachable: !target.classList.contains('is-out-of-range'),
            selectable: target.tagName === 'BUTTON'
          }))
        };
      });
    const playerReach = panelReach('player-action-panel');
    const enemyReach = panelReach('enemy-action-panel');
    const edgeGroups = [...document.querySelectorAll('#player-action-panel .combatant-card[data-action-slot="0"] .move-button-group')];
    const centerGroups = [...document.querySelectorAll('#player-action-panel .combatant-card[data-action-slot="1"] .move-button-group')];
    const edgeRangeShown = edgeGroups.some(group => group.querySelectorAll('.damage-slot').length === 3 && group.querySelectorAll('.damage-slot.is-out-of-range').length === 1);
    const centerRangeShown = centerGroups.some(group => group.querySelectorAll('.damage-slot').length === 3 && group.querySelectorAll('.damage-slot.is-out-of-range').length === 0);
    const edgeTargetGroup = edgeGroups.find(group => group.querySelectorAll('.damage-slot').length === 3 && group.querySelectorAll('.damage-slot.is-out-of-range').length === 1);
    const edgeTargetReach = [...(edgeTargetGroup?.querySelectorAll('.damage-slot') || [])].map(slot => ({ label: slot.dataset.slotLabel, reachable: !slot.classList.contains('is-out-of-range') }));
    const initialCenterShiftButtons = document.querySelectorAll('.combatant-card[data-display-slot="1"] .shift-button').length;
    const shift = document.querySelector('#player-action-panel .combatant-card[data-action-slot="0"] .shift-button');
    if (!shift) throw new Error('Left-slot Shift control was unavailable');
    const initialLeftName = document.querySelector('#player-action-panel .combatant-card[data-display-slot="0"] .combatant-name').textContent;
    const initialCenterName = document.querySelector('#player-action-panel .combatant-card[data-display-slot="1"] .combatant-name').textContent;
    shift.click();
    await wait(() => document.querySelector('#player-action-panel .combatant-card[data-display-slot="0"]')?.dataset.actionSlot === '1'
      && document.querySelector('#player-action-panel .combatant-card[data-display-slot="1"]')?.dataset.actionSlot === '0', 'Shift formation preview');
    const shiftedLeftName = document.querySelector('#player-action-panel .combatant-card[data-display-slot="0"] .combatant-name').textContent;
    const shiftedCenterName = document.querySelector('#player-action-panel .combatant-card[data-display-slot="1"] .combatant-name').textContent;
    const snapshot = globalThis.__PLC_TESTING_STATE__.capture();
    return {
      trainer: chosen.textContent,
      format: document.querySelector('#player-action-panel .pill').textContent,
      workspaceClass: document.getElementById('battle-workspace').className,
      playerInitial,
      enemyInitial,
      playerReach,
      enemyReach,
      edgeRangeShown,
      centerRangeShown,
      edgeTargetReach,
      shiftButtons: document.querySelectorAll('.shift-button').length,
      centerShiftButtons: initialCenterShiftButtons,
      shiftDraft: snapshot.transientTurn.actionDraft.player[0].type || null,
      initialLeftName,
      initialCenterName,
      shiftedLeftName,
      shiftedCenterName,
      shiftedSelected: document.querySelector('#player-action-panel .combatant-card[data-action-slot="0"] .shift-button')?.getAttribute('aria-pressed') === 'true',
      nodeSpriteCount: document.querySelector('.node-button[data-kind="draft"] .node-sprites.is-triples')?.querySelectorAll('.node-sprite').length || 0,
      nodeSpriteOrder: [...(document.querySelector('.node-button[data-kind="draft"] .node-sprites.is-triples')?.querySelectorAll('.node-sprite') || [])].map(holder => holder.title),
      pageOverflow: document.documentElement.scrollWidth - innerWidth
    };
  })()`, true);
  assert.equal(triples.format, "Triples");
  assert.match(triples.workspaceClass, /is-triples/);
  assert.deepEqual(triples.playerInitial.map(card => card.label), ["Slot 1 · Left", "Slot 2 · Center", "Slot 3 · Right"]);
  assert.deepEqual(triples.enemyInitial.map(card => card.label), ["Slot 4 · Left", "Slot 5 · Center", "Slot 6 · Right"]);
  assert.deepEqual(triples.enemyInitial.map(card => card.name), ["Lanturn", "Electivire", "Emolga"]);
  assert.ok(triples.enemyInitial.every(card => card.subtitle === ""));
  assert.deepEqual(triples.enemyInitial.map(card => card.actionSlot), [1, 2, 0]);
  assert.equal(triples.playerInitial[0].top, triples.playerInitial[1].top);
  assert.ok(triples.playerInitial[2].top > triples.playerInitial[1].top);
  assert.ok(triples.playerInitial[1].left > triples.playerInitial[0].left);
  assert.equal(triples.enemyInitial[0].top, triples.enemyInitial[1].top);
  assert.ok(triples.enemyInitial[2].top > triples.enemyInitial[0].top);
  assert.ok(triples.enemyInitial[0].left > triples.enemyInitial[1].left);
  assert.equal(triples.enemyInitial[2].left, triples.enemyInitial[1].left);
  assert.equal(triples.edgeRangeShown, true);
  assert.equal(triples.centerRangeShown, true);
  assert.deepEqual(triples.edgeTargetReach, [
    { label: "Slot 4", reachable: true },
    { label: "Slot 5", reachable: true },
    { label: "Slot 6", reachable: false }
  ]);
  const reach = values => values.map((reachable, index) => ({ label: `Slot ${index + 1}`, reachable, selectable: reachable }));
  const enemyTargets = values => values.map((reachable, index) => ({ label: `Slot ${index + 4}`, reachable, selectable: reachable }));
  assert.deepEqual(triples.playerReach.map(card => card.targets), [
    enemyTargets([true, true, false]),
    enemyTargets([true, true, true]),
    enemyTargets([false, true, true])
  ]);
  assert.deepEqual(triples.enemyReach.map(card => card.targets.map(({ label, reachable }) => ({ label, reachable }))), [
    reach([true, true, false]).map(({ label, reachable }) => ({ label, reachable })),
    reach([true, true, true]).map(({ label, reachable }) => ({ label, reachable })),
    reach([false, true, true]).map(({ label, reachable }) => ({ label, reachable }))
  ]);
  assert.equal(triples.shiftButtons, 4);
  assert.equal(triples.centerShiftButtons, 0);
  assert.equal(triples.shiftDraft, "shift");
  assert.equal(triples.shiftedLeftName, triples.initialCenterName);
  assert.equal(triples.shiftedCenterName, triples.initialLeftName);
  assert.equal(triples.shiftedSelected, true);
  assert.equal(triples.nodeSpriteCount, 6);
  assert.deepEqual(triples.nodeSpriteOrder, [...triples.playerInitial.map(card => card.name), ...triples.enemyInitial.map(card => card.name)]);
  assert.ok(triples.pageOverflow <= 0);
  await capture(page, screenshots.triples);

  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(300);
  const mobile = await evaluate(page, `(() => {
    const order = panelId => [...document.querySelectorAll('#' + panelId + ' .combatant-card')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map(card => Number(card.dataset.displaySlot));
    return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, columns: getComputedStyle(document.querySelector('.battle-workspace')).gridTemplateColumns, playerOrder: order('player-action-panel'), enemyOrder: order('enemy-action-panel') };
  })()`);
  assert.ok(mobile.scrollWidth <= mobile.viewport);
  assert.equal(mobile.columns.split(" ").length, 1);
  assert.deepEqual(mobile.playerOrder, [0, 1, 2]);
  assert.deepEqual(mobile.enemyOrder, [0, 1, 2]);
  await capture(page, screenshots.mobile);

  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const battleEndPreview = await evaluate(page, `(async () => {
    const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 100); poll(); });
    document.getElementById('boxes-tab').click();
    const firstCard = document.querySelector('.box-card .box-pokemon-card');
    firstCard.querySelector('.box-card-actions button').click();
    const level = document.getElementById('editor-level');
    level.value = '100'; level.dispatchEvent(new Event('input', { bubbles: true }));
    const firstMove = document.querySelector('#editor-moves .move-editor-row select');
    firstMove.value = 'hyperbeam'; firstMove.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('save-pokemon').click();
    await wait(() => !document.getElementById('pokemon-editor-dialog').open, 'battle-end fixture save');

    document.getElementById('plc-tab').click(); document.getElementById('new-plan').click();
    const trainer = document.getElementById('trainer-select');
    const soloTrainer = [...trainer.options].find(entry => (entry.textContent.match(/Lv\./g) || []).length === 1);
    if (!soloTrainer) throw new Error('A one-Pokémon trainer is required for the battle-end smoke');
    trainer.value = soloTrainer.value; trainer.dispatchEvent(new Event('change', { bubbles: true }));
    const box = document.getElementById('context-box-select'); box.value = box.options[1].value; box.dispatchEvent(new Event('change', { bubbles: true }));
    const party = document.getElementById('context-party-select'); party.value = party.options[1].value; party.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('save-party-selection').click();
    document.getElementById('begin-plan').click();
    await wait(() => !document.getElementById('plan-context-dialog').open
      && document.querySelectorAll('#player-action-panel .combatant-card').length === 1
      && /Lv\. 100/.test(document.querySelector('#player-action-panel .meta-row')?.textContent || '')
      && document.querySelectorAll('#enemy-action-panel .combatant-card').length === 1, 'battle-end workspace');
    const choose = (panelId, moveName) => {
      const target = [...document.querySelectorAll('#' + panelId + ' .move-button')].find(entry => entry.textContent.includes(moveName));
      if (!target || target.disabled) throw new Error(moveName + ' unavailable for battle-end preview: ' + [...document.querySelectorAll('#' + panelId + ' .move-button')].map(entry => entry.textContent.trim() + (entry.disabled ? ' [disabled]' : '')).join(' | '));
      target.click();
    };
    choose('player-action-panel', 'Hyper Beam');
    const enemyMove = document.querySelector('#enemy-action-panel .move-button:not(:disabled)');
    if (!enemyMove) throw new Error('Enemy move unavailable for battle-end preview');
    enemyMove.click();
    await wait(() => globalThis.__PLC_TESTING_STATE__.capture().transientTurn.currentPreview && !document.getElementById('commit-turn').disabled, 'battle-end preview');
    const notes = document.getElementById('node-notes');
    notes.value = 'Preserve the terminal winning line.';
    notes.dispatchEvent(new Event('input', { bubbles: true }));
    if (!document.querySelector('.outcome.battle-victory')) throw new Error('winning preview unavailable: ' + JSON.stringify({
      button: document.getElementById('commit-turn').textContent,
      outcomes: [...document.querySelectorAll('.outcome')].map(node => ({ className: node.className, text: node.textContent })),
      enemyHp: [...document.querySelectorAll('#enemy-action-panel .static-detail')].find(node => node.querySelector('small')?.textContent === 'HP')?.textContent
    }));
    const goldProbe = document.createElement('span'); goldProbe.style.color = 'var(--gold)'; document.body.append(goldProbe);
    const greenProbe = document.createElement('span'); greenProbe.style.color = 'var(--green)'; document.body.append(greenProbe);
    const redProbe = document.createElement('span'); redProbe.style.color = 'var(--red)'; document.body.append(redProbe);
    const card = document.querySelector('.outcome.battle-victory');
    const ended = card.querySelector('.battle-ended-text');
    const draftNode = document.querySelector('.node-button[data-kind="draft"]');
    const faintSprite = draftNode?.querySelector('.node-sprite.has-faint');
    const presentation = {
      button: document.getElementById('commit-turn').textContent,
      endedText: ended?.textContent || null,
      endedGreen: getComputedStyle(ended).color === getComputedStyle(greenProbe).color,
      goldBorder: getComputedStyle(card).borderTopColor === getComputedStyle(goldProbe).color,
      draftColumns: [...document.querySelectorAll('.node-column-title')].map(node => node.textContent),
      draftProbability: draftNode?.querySelector(':scope > .node-probability')?.textContent.trim() || null,
      draftNodeFaint: draftNode?.classList.contains('has-faint') || false,
      draftNodeRed: draftNode ? getComputedStyle(draftNode).borderTopColor === getComputedStyle(redProbe).color : false,
      draftSpriteCount: draftNode?.querySelectorAll('.node-sprite').length || 0,
      draftFaintSpriteCount: draftNode?.querySelectorAll('.node-sprite.has-faint').length || 0,
      draftFaintSpriteRed: faintSprite ? getComputedStyle(faintSprite).borderTopColor === getComputedStyle(redProbe).color : false,
      koLine: [...card.querySelectorAll('.damage-amounts')].map(node => node.textContent).find(text => /HKO/.test(text)) || null,
      notesValue: notes.value,
      notesStatus: document.getElementById('notes-status').textContent
    };
    goldProbe.remove(); greenProbe.remove(); redProbe.remove();
    return presentation;
  })()`, true);
  assert.equal(battleEndPreview.button, "Lock Branch");
  assert.equal(battleEndPreview.endedText, "Battle ended");
  assert.equal(battleEndPreview.endedGreen, true);
  assert.equal(battleEndPreview.goldBorder, true);
  assert.deepEqual(battleEndPreview.draftColumns, ["Turn 1"]);
  assert.equal(battleEndPreview.draftProbability, "84.38%");
  assert.equal(battleEndPreview.draftNodeFaint, true);
  assert.equal(battleEndPreview.draftNodeRed, true);
  assert.equal(battleEndPreview.draftSpriteCount, 2);
  assert.equal(battleEndPreview.draftFaintSpriteCount, 1);
  assert.equal(battleEndPreview.draftFaintSpriteRed, true);
  assert.equal(battleEndPreview.koLine, "Guaranteed OHKO");
  assert.equal(battleEndPreview.notesValue, "Preserve the terminal winning line.");
  assert.match(battleEndPreview.notesStatus, /Draft Turn 1 note/);
  await delay(150);
  await capture(page, screenshots.battleEnd);
  await evaluate(page, `document.querySelector('.notes-panel').scrollIntoView({ block: 'center' })`);
  await delay(150);
  await capture(page, screenshots.notes);
  await evaluate(page, `document.querySelector('.outcomes-panel').scrollIntoView({ block: 'center' })`);

  const battleEndLocked = await evaluate(page, `(async () => {
    const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 100); poll(); });
    document.getElementById('commit-turn').click();
    await wait(() => document.querySelectorAll('.node-button[data-kind="draft"]').length === 0 && document.querySelectorAll('.node-button[data-kind="committed"]').length === 1, 'locked terminal branch');
    await wait(() => document.getElementById('progression-dialog').open, 'locked branch progression prompt');
    const progressionPrompt = document.getElementById('progression-dialog').textContent;
    document.querySelector('#progression-dialog button[value="yes"]').click();
    await wait(() => !document.getElementById('progression-dialog').open && /Saved absolute EXP and levels/.test(document.getElementById('app-status').textContent), 'locked branch progression save');
    const testingSnapshot = globalThis.__PLC_TESTING_STATE__.capture();
    const lockedPlanState = testingSnapshot.plan.stateNodes[testingSnapshot.app.cursorStateNodeId];
    const eligiblePlayers = Object.values(testingSnapshot.plan.combatants).filter(entry => entry.side === 'player' && entry.source?.uniqueKey);
    const player = eligiblePlayers.find(entry => Number.isInteger(lockedPlanState.combatantStates[entry.combatantKey]?.experience)) || eligiblePlayers[0];
    const rootState = testingSnapshot.plan.stateNodes[testingSnapshot.plan.initialStateNodeId].combatantStates[player.combatantKey];
    const lockedState = lockedPlanState.combatantStates[player.combatantKey];
    const boxRecord = Object.values(testingSnapshot.boxLibrary.games).flatMap(game => Object.values(game.boxes)).map(box => box.pokemon[player.source.uniqueKey]).find(Boolean);
    const redProbe = document.createElement('span'); redProbe.style.color = 'var(--red)'; document.body.append(redProbe);
    const lockedNode = document.querySelector('.node-button[data-kind="committed"]');
    const lockedFaintSprite = lockedNode?.querySelector('.node-sprite.has-faint');
    const redColor = getComputedStyle(redProbe).color;
    redProbe.remove();
    return {
      lockedColumns: [...document.querySelectorAll('.node-column-title')].map(node => node.textContent),
      lockedKinds: [...document.querySelectorAll('.node-button')].map(node => node.dataset.kind),
      turnLabel: document.getElementById('turn-label').textContent,
      lockedButton: document.getElementById('commit-turn').textContent,
      lockedDisabled: document.getElementById('commit-turn').disabled,
      lockedNodeRed: lockedNode ? getComputedStyle(lockedNode).borderTopColor === redColor : false,
      lockedSpriteCount: lockedNode?.querySelectorAll('.node-sprite').length || 0,
      lockedFaintSpriteCount: lockedNode?.querySelectorAll('.node-sprite.has-faint').length || 0,
      lockedFaintSpriteRed: lockedFaintSprite ? getComputedStyle(lockedFaintSprite).borderTopColor === redColor : false,
      progressionPrompt,
      progressionSavedStatus: document.getElementById('app-status').textContent,
      rootExperience: rootState.experience,
      lockedExperience: lockedState.experience,
      boxExperience: boxRecord?.experience,
      boxExperienceMatches: !Number.isInteger(lockedState.experience) || boxRecord?.experience === lockedState.experience,
      rootLevel: rootState.currentLevel,
      lockedLevel: lockedState.currentLevel,
      boxLevel: boxRecord?.level
    };
  })()`, true);
  assert.deepEqual(battleEndLocked.lockedColumns, ["Turn 1"]);
  assert.deepEqual(battleEndLocked.lockedKinds, ["committed"]);
  assert.equal(battleEndLocked.turnLabel, "Turn 1");
  assert.equal(battleEndLocked.lockedButton, "Lock Branch");
  assert.equal(battleEndLocked.lockedDisabled, true);
  assert.equal(battleEndLocked.lockedNodeRed, true);
  assert.equal(battleEndLocked.lockedSpriteCount, 2);
  assert.equal(battleEndLocked.lockedFaintSpriteCount, 1);
  assert.equal(battleEndLocked.lockedFaintSpriteRed, true);
  assert.match(battleEndLocked.progressionPrompt, /Save EXP and level changes\?/);
  assert.match(battleEndLocked.progressionPrompt, /current plan remains frozen/i);
  assert.match(battleEndLocked.progressionSavedStatus, /Saved absolute EXP and levels/);
  assert.equal(battleEndLocked.boxExperienceMatches, true);
  assert.equal(battleEndLocked.boxLevel, battleEndLocked.lockedLevel);
  await capture(page, screenshots.battleEndLocked);
  const terminalPlanText = await evaluate(page, `(async () => {
    document.getElementById('save-plan').click();
    document.getElementById('select-all-export').click();
    const snapshot = globalThis.__PLC_TESTING_STATE__.capture();
    const { exportSelectedPlan } = await import('./src/contracts/plan_file.js');
    const exported = exportSelectedPlan(snapshot.plan, snapshot.app.exportSelection);
    document.getElementById('output-dialog').close();
    return exported.text;
  })()`, true);
  const terminalPlanFixture = path.join(profile, "terminal-lock-roundtrip.plc-plan.json");
  await fs.writeFile(terminalPlanFixture, terminalPlanText, "utf8");
  const terminalInputDocument = await page.send("DOM.getDocument", { depth: -1, pierce: true });
  const terminalInput = await page.send("DOM.querySelector", { nodeId: terminalInputDocument.root.nodeId, selector: "#import-plan" });
  await page.send("DOM.setFileInputFiles", { nodeId: terminalInput.nodeId, files: [terminalPlanFixture] });
  const terminalRoundTrip = await evaluate(page, `(async () => {
    const wait = (predicate, message) => new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + document.getElementById('app-status').textContent)) : setTimeout(poll, 100); poll(); });
    await wait(() => document.getElementById('destructive-dialog').open, 'terminal import confirmation');
    document.getElementById('destructive-discard').click();
    await wait(() => /Plan imported/.test(document.getElementById('app-status').textContent) && globalThis.__PLC_TESTING_STATE__.capture().transientTurn.currentPreview, 'terminal plan import');
    const snapshot = globalThis.__PLC_TESTING_STATE__.capture();
    return {
      turnLabel: document.getElementById('turn-label').textContent,
      button: document.getElementById('commit-turn').textContent,
      playerMove: document.querySelector('#player-action-panel .move-button[aria-pressed="true"] .move-copy strong')?.textContent || null,
      enemyMove: document.querySelector('#enemy-action-panel .move-button[aria-pressed="true"] .move-copy strong')?.textContent || null,
      reviewOutcomeStateNodeId: snapshot.app.reviewOutcomeStateNodeId,
      draftNodes: document.querySelectorAll('.node-button[data-kind="draft"]').length,
      committedNodes: document.querySelectorAll('.node-button[data-kind="committed"]').length,
      actionGroups: Object.keys(snapshot.plan.actionGroups).length,
      notesValue: document.getElementById('node-notes').value,
      importBoxNames: [...document.querySelectorAll('.box-name-input')].map(input => input.value).filter(name => /^Import \\d+$/.test(name))
    };
  })()`, true);
  assert.equal(terminalRoundTrip.turnLabel, "Turn 1");
  assert.equal(terminalRoundTrip.button, "Lock Branch");
  assert.equal(terminalRoundTrip.playerMove, "Hyper Beam");
  assert.ok(terminalRoundTrip.enemyMove);
  assert.ok(terminalRoundTrip.reviewOutcomeStateNodeId);
  assert.equal(terminalRoundTrip.draftNodes, 0);
  assert.equal(terminalRoundTrip.committedNodes, 1);
  assert.equal(terminalRoundTrip.actionGroups, 1);
  assert.equal(terminalRoundTrip.notesValue, "Preserve the terminal winning line.");
  assert.deepEqual(terminalRoundTrip.importBoxNames, ["Import 1"]);
  const battleEnd = { ...battleEndPreview, ...battleEndLocked, terminalRoundTrip };

  let branchLanes = { skipped: true };
  if (layoutPlanFixture) {
    const domDocument = await page.send("DOM.getDocument", { depth: -1, pierce: true });
    const input = await page.send("DOM.querySelector", { nodeId: domDocument.root.nodeId, selector: "#import-plan" });
    assert.ok(input.nodeId, "Plan import input is available for the branch-lane fixture");
    await page.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [layoutPlanFixture] });
    await evaluate(page, `(async () => {
      const deadline = Date.now() + 10000;
      while (!document.getElementById('destructive-dialog').open && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (document.getElementById('destructive-dialog').open) document.getElementById('destructive-discard').click();
      const importDeadline = Date.now() + 20000;
      while (!/Plan imported/.test(document.getElementById('app-status').textContent) && Date.now() < importDeadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (!/Plan imported/.test(document.getElementById('app-status').textContent)) throw new Error('Branch-lane fixture did not import: ' + document.getElementById('app-status').textContent);
    })()`, true);
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 900, deviceScaleFactor: 1, mobile: false });
    branchLanes = await evaluate(page, `(() => {
      const nodes = [...document.querySelectorAll('.node-button')].map(node => {
        const rect = node.getBoundingClientRect();
        return {
          turn: node.closest('.node-column').querySelector('.node-column-title').textContent,
          lane: Number(node.dataset.lane),
          kind: node.dataset.kind,
          stateNodeId: node.dataset.stateNodeId,
          centerY: rect.top + rect.height / 2
        };
      });
      const laneGroups = Object.groupBy(nodes, node => node.lane);
      const laneCenterDeltas = Object.values(laneGroups).map(group => Math.max(...group.map(node => node.centerY)) - Math.min(...group.map(node => node.centerY)));
      return {
        skipped: false,
        nodes,
        turn3Lanes: nodes.filter(node => node.turn === 'Turn 3').map(node => node.lane),
        turn4Lanes: nodes.filter(node => node.turn === 'Turn 4').map(node => node.lane),
        maxLaneCenterDelta: Math.max(...laneCenterDeltas)
      };
    })()`);
    assert.deepEqual(branchLanes.turn3Lanes, [0, 1, 2]);
    assert.deepEqual(branchLanes.turn4Lanes, [0, 2]);
    assert.ok(branchLanes.maxLaneCenterDelta < 0.5);
    await capture(page, screenshots.branchLanes);
  }

  let compatibilityPlanReview = { skipped: true };
  if (compatibilityPlanFixture) {
    const domDocument = await page.send("DOM.getDocument", { depth: -1, pierce: true });
    const input = await page.send("DOM.querySelector", { nodeId: domDocument.root.nodeId, selector: "#import-plan" });
    assert.ok(input.nodeId, "Plan import input is available for the compatibility fixture");
    await page.send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [compatibilityPlanFixture] });
    compatibilityPlanReview = await evaluate(page, `(async () => {
      const wait = (predicate, message, timeout = 30000) => new Promise((resolve, reject) => { const deadline = Date.now() + timeout; const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error(message + ': ' + JSON.stringify({ status: document.getElementById('app-status')?.textContent, readiness: document.getElementById('readiness')?.textContent, snapshot: globalThis.__PLC_TESTING_STATE__.capture().transientTurn }))) : setTimeout(poll, 75); poll(); });
      await wait(() => document.getElementById('destructive-dialog').open, 'compatibility import confirmation');
      const previousPlanId = globalThis.__PLC_TESTING_STATE__.capture().plan.planId;
      document.getElementById('destructive-discard').click();
      await wait(() => globalThis.__PLC_TESTING_STATE__.capture().plan.planId !== previousPlanId, 'compatibility plan import');
      const initial = globalThis.__PLC_TESTING_STATE__.capture();
      const requiredRecalculation = initial.app.needsRecalculation;
      if (requiredRecalculation) {
        document.getElementById('recalculate-plan').click();
        await wait(() => !globalThis.__PLC_TESTING_STATE__.capture().app.needsRecalculation && /Recalculation completed/.test(document.getElementById('app-status').textContent), 'compatibility recalculation', 60000);
      }
      const stateIds = [...document.querySelectorAll('.node-button[data-kind="committed"]')].map(node => node.dataset.stateNodeId);
      const reviews = [];
      for (const stateId of stateIds) {
        document.querySelector('.node-button[data-kind="committed"][data-state-node-id="' + CSS.escape(stateId) + '"]').click();
        await wait(() => {
          const snapshot = globalThis.__PLC_TESTING_STATE__.capture();
          return snapshot.transientTurn.currentPreview;
        }, 'committed node review ' + stateId);
        const snapshot = globalThis.__PLC_TESTING_STATE__.capture();
        reviews.push({
          stateId,
          label: document.getElementById('commit-turn').textContent,
          previewStatus: snapshot.transientTurn.currentPreview.previewStatus,
          reviewedStateId: snapshot.app.reviewOutcomeStateNodeId
        });
      }
      return { requiredRecalculation, stateNodes: stateIds.length, reviews, newBranchLabels: reviews.filter(review => review.label === 'New Branch').length };
    })()`, true);
    assert.equal(compatibilityPlanReview.stateNodes, 20);
    assert.equal(compatibilityPlanReview.newBranchLabels, 0);
    assert.ok(compatibilityPlanReview.reviews.every(review => review.previewStatus === "existing-expanded" && review.reviewedStateId === review.stateId));
  }

  const browserErrors = page.events.filter(event => event.method === "Runtime.exceptionThrown").map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
  assert.deepEqual(browserErrors, []);
  let storedTestingState = null;
  if (testingStateFile) {
    storedTestingState = JSON.parse(await fs.readFile(testingStateFile, "utf8"));
    assert.equal(storedTestingState.transientTurn.actionDraft.player[0].moveId, testingState.playerMoveId);
    assert.deepEqual(storedTestingState.transientTurn.actionDraft.player[1], {});
    assert.equal(storedTestingState.transientTurn.currentPreview, null);
    assert.equal(storedTestingState.plan.kind, "pokemon-battle-plan");
  }
  page.close();
  console.log(JSON.stringify({ selected, imported, edited, saveReview, planReady, turn, committed, savePlan, responsive, doubles, testingState, targetRefreshStability, storedTestingState: storedTestingState ? { capturedAt: storedTestingState.capturedAt, storedAt: storedTestingState.storedAt } : null, doublesWide, triples, mobile, battleEnd, branchLanes, compatibilityPlanReview, screenshots }, null, 2));
} finally {
  if (browser && browser.exitCode === null) browser.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
