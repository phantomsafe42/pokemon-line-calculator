import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
  [".png", "image/png"]
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
    await wait(() => /Select a game to load/.test(document.getElementById('app-status')?.textContent || ''), 'public shell');
    const game = document.getElementById('game-select');
    const gameOptions = [...game.options].filter(option => option.value).map(option => ({
      value: option.value,
      label: option.textContent,
      disabled: option.disabled
    }));
    game.value = 'pokemon-ruby';
    game.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => /Ruby is ready\./.test(document.getElementById('app-status')?.textContent || '')
      && document.getElementById('trainer-select').options.length > 1, 'public vanilla game data and worker');
    const vanilla = {
      status: document.getElementById('app-status').textContent,
      credit: document.getElementById('game-credit').textContent,
      trainers: document.getElementById('trainer-select').options.length,
      saveImportVisible: !document.getElementById('save-import').closest('label').hidden
    };
    game.value = 'volt-white-2r';
    game.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => /is ready\./.test(document.getElementById('app-status')?.textContent || '')
      && document.getElementById('trainer-select').options.length > 400, 'public game data, AI bootstrap, and resolver');
    if (document.getElementById('plan-context-dialog').open) document.getElementById('plan-context-dialog').close();
    const assetResolver = globalThis.PokemonAssetGateway.createClient();
    const sprite = document.createElement('img');
    const spriteResult = await assetResolver.setImage(sprite, { appearanceId: 'clefairy', spriteType: 'g5-animated', view: 'front' });
    await sprite.decode();
    const result = {
      profile: document.querySelector('meta[name="plc-build-profile"]')?.content,
      gameOptions,
      vanilla,
      spriteLoaded: spriteResult.status === 'ok' && sprite.naturalWidth > 0,
      assetApiVersion: assetResolver.apiVersion,
      assetOrigin: assetResolver.origin,
      assetReleaseVersion: assetResolver.releaseVersion,
      localAssetGlobalType: typeof globalThis.PokemonAssets,
      status: document.getElementById('app-status').textContent,
      gameCredit: document.getElementById('game-credit').textContent,
      siteCredit: document.querySelector('.site-credit')?.textContent,
      eyebrowCount: document.querySelectorAll('.eyebrow').length,
      trainers: document.getElementById('trainer-select').options.length,
      tabsVisible: !document.getElementById('app-tabs').hidden,
      localGlobalType: typeof globalThis.__PLC_TESTING_STATE__,
      viewToggle: Boolean(document.getElementById('view-mode-toggle')),
      outputState: Boolean(document.getElementById('output-state') || document.getElementById('output-state-anchor')),
      liveEdit: Boolean(document.getElementById('live-edit-anchor') || document.getElementById('live-stop-dialog')),
      localLabels: [...document.querySelectorAll('button')].some(button => /Output State|Live Edit/i.test(button.textContent)),
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth
    };
    game.value = 'renegade-platinum';
    game.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => /Renegade Platinum is ready\./.test(document.getElementById('app-status')?.textContent || '')
      && document.getElementById('trainer-select').options.length > 100, 'Renegade Platinum data, AI bootstrap, and resolver');
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
    return result;
  })()`, true);

  assert.equal(state.profile, "public");
  const gameOptionById = new Map(state.gameOptions.map(option => [option.value, option]));
  assert.deepEqual(
    vanillaGameOptions.map(([gameId]) => [gameId, gameOptionById.get(gameId)?.label]),
    vanillaGameOptions
  );
  assert.equal(vanillaGameOptions.every(([gameId]) => gameOptionById.get(gameId)?.disabled === false), true);
  assert.match(state.vanilla.status, /Ruby is ready\./);
  assert.equal(state.vanilla.credit, "by Game Freak");
  assert.ok(state.vanilla.trainers > 1);
  assert.equal(state.vanilla.saveImportVisible, false);
  assert.equal(state.spriteLoaded, true);
  assert.equal(state.assetApiVersion, "pokemon-asset-gateway-client/v1");
  assert.equal(state.assetOrigin, assetLock.gateway.origin);
  assert.equal(state.assetReleaseVersion, assetLock.gateway.releaseVersion);
  assert.equal(state.localAssetGlobalType, "undefined");
  assert.match(state.status, /is ready\./);
  assert.equal(state.gameCredit, "by AphexCubed and Drayano");
  assert.equal(state.siteCredit, "twitch.tv/phantomsafe");
  assert.equal(state.eyebrowCount, 0);
  assert.ok(state.trainers > 400);
  assert.match(state.renegadePlatinum.status, /Renegade Platinum is ready\./);
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

  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(250);
  const mobile = await evaluate(page, `({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth })`);
  assert.ok(mobile.scrollWidth <= mobile.viewport);

  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const image = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile(screenshot, Buffer.from(image.data, "base64"));

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
  const requestedUrls = page.events
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

  page.close();
  console.log(JSON.stringify({ status: "public-browser-smoke-valid", state, mobile, performance, screenshot }, null, 2));
} finally {
  if (browser && browser.exitCode === null) browser.kill();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
