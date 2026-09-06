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
let browser = null;
let server = null;

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

try {
  await fs.access(path.join(publicRoot, "public-build-manifest.json"));
  await fs.mkdir(profile, { recursive: true });
  const serverPort = await availablePort();
  server = await startStaticServer(serverPort);
  const debugPort = await availablePort();
  const appUrl = `http://127.0.0.1:${serverPort}${publicPrefix}`;
  const chrome = await findBrowser();
  browser = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-software-rasterizer", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", `--remote-debugging-port=${debugPort}`, "--remote-allow-origins=*",
    `--user-data-dir=${profile}`, appUrl
  ], { windowsHide: true, stdio: "ignore" });

  const target = await waitForTarget(debugPort, appUrl);
  const page = cdpClient(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Network.enable");

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
    game.value = 'volt-white-2r';
    game.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => /is ready\./.test(document.getElementById('app-status')?.textContent || '')
      && document.getElementById('trainer-select').options.length > 400, 'public game data and worker');
    if (document.getElementById('plan-context-dialog').open) document.getElementById('plan-context-dialog').close();
    const assetResolver = globalThis.PokemonAssets.createResolver();
    const sprite = document.createElement('img');
    const spriteResult = await assetResolver.setImage(sprite, { appearanceId: 'clefairy', spriteType: 'g5-animated', view: 'front' });
    await sprite.decode();
    return {
      profile: document.querySelector('meta[name="plc-build-profile"]')?.content,
      spriteLoaded: spriteResult.status === 'ok' && sprite.naturalWidth > 0,
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
  })()`, true);

  assert.equal(state.profile, "public");
  assert.equal(state.spriteLoaded, true);
  assert.match(state.status, /is ready\./);
  assert.equal(state.gameCredit, "by AphexCubed and Drayano");
  assert.equal(state.siteCredit, "twitch.tv/phantomsafe");
  assert.equal(state.eyebrowCount, 0);
  assert.ok(state.trainers > 400);
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
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(badResponses, []);
  assert.equal(requestedUrls.some(url => {
    const pathname = new URL(url).pathname;
    return pathname.startsWith("/Datasets/") || pathname.startsWith("/Battle%20Mechanics/");
  }), false);
  assert.equal(requestedUrls.some(url => /__stream-tools/i.test(url)), false);
  assert.ok(requestedUrls.filter(url => url.startsWith(`http://127.0.0.1:${serverPort}/`)).every(url => url.startsWith(appUrl)));

  page.close();
  console.log(JSON.stringify({ status: "public-browser-smoke-valid", state, mobile, requests: requestedUrls.length, screenshot }, null, 2));
} finally {
  if (browser && browser.exitCode === null) browser.kill();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
