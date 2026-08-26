import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDisplayProjection } from "../src/contracts/display_projection.js";
import { fixtureDoublesPlan } from "./helpers.mjs";

const serverPath = fileURLToPath(new URL("../../../Local Tools/Stream Tools Launcher/static_server.js", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/vw2r-branch-plan.json", import.meta.url));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`isolated static server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__stream-tools/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("isolated static server did not become healthy");
}

function startServer(port, stateRoot) {
  return spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      STREAM_TOOLS_STATIC_PORT: String(port),
      STREAM_TOOLS_STATE_ROOT: stateRoot,
      STREAM_TOOLS_LIVE_PLAN_LEASE_TTL_MS: "2000",
      STREAM_TOOLS_LIVE_PLAN_RECOVERY_GRACE_MS: "50"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once("exit", resolve));
}

test("isolated display endpoint atomically validates, persists, and rejects malformed replacement", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "plc-display-test-"));
  const port = await freePort();
  let child = startServer(port, stateRoot);
  try {
    await waitForHealth(port, child);
    const plan = JSON.parse(await readFile(fixturePath, "utf8"));
    const projection = createDisplayProjection(plan, ["state-turn-1-main", "state-turn-2-ko", "state-turn-2-survive"]);
    const route = `http://127.0.0.1:${port}/__stream-tools/battle-plan-display/volt-white-2r`;
    const accepted = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify(projection)
    });
    assert.equal(accepted.status, 200);
    const stored = await accepted.json();
    assert.equal(stored.projectionRevision, 1);
    assert.equal(stored.columns.length, 2);
    const rejected = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ ...projection, gameId: "other-game" })
    });
    assert.equal(rejected.status, 400);
    assert.equal((await (await fetch(route)).json()).projectionRevision, 1);
    await stopServer(child);
    child = startServer(port, stateRoot);
    await waitForHealth(port, child);
    const afterRestart = await (await fetch(route)).json();
    assert.equal(afterRestart.projectionRevision, 1);
    assert.equal(afterRestart.sourcePlanId, plan.planId);
  } finally {
    await stopServer(child);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("isolated live-edit broker enforces one writer, revision concurrency, reader leases, and cleanup", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "plc-live-test-"));
  const port = await freePort();
  const child = startServer(port, stateRoot);
  const origin = `http://127.0.0.1:${port}`;
  const headers = { "Content-Type": "application/json", Origin: origin };
  try {
    await waitForHealth(port, child);
    const plan = JSON.parse(await readFile(fixturePath, "utf8"));
    const base = `${origin}/__stream-tools/battle-plan-live`;
    const writerResponse = await fetch(`${base}/writer`, { method: "POST", headers, body: JSON.stringify({ plan }) });
    assert.equal(writerResponse.status, 200);
    const writer = await writerResponse.json();
    assert.equal(writer.liveRevision, 1);
    const duplicate = await fetch(`${base}/writer`, { method: "POST", headers, body: JSON.stringify({ plan }) });
    assert.equal(duplicate.status, 409);
    const readerResponse = await fetch(`${base}/reader`, { method: "POST", headers, body: JSON.stringify({ sessionId: writer.sessionId }) });
    assert.equal(readerResponse.status, 200);
    const reader = await readerResponse.json();
    const firstRead = await (await fetch(`${base}/session/${writer.sessionId}/plan?leaseId=${reader.readerLeaseId}&afterRevision=0`, { headers: { Origin: origin } })).json();
    assert.equal(firstRead.changed, true);
    assert.equal(firstRead.plan.planId, plan.planId);
    const nextPlan = structuredClone(plan);
    nextPlan.documentRevision += 1;
    nextPlan.updatedAt = "2026-08-23T00:00:01.000Z";
    const update = await fetch(`${base}/session/${writer.sessionId}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ leaseId: writer.writerLeaseId, expectedRevision: 1, plan: nextPlan })
    });
    assert.equal(update.status, 200);
    assert.equal((await update.json()).liveRevision, 2);
    const conflict = await fetch(`${base}/session/${writer.sessionId}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ leaseId: writer.writerLeaseId, expectedRevision: 1, plan: nextPlan })
    });
    assert.equal(conflict.status, 409);
    const secondRead = await (await fetch(`${base}/session/${writer.sessionId}/plan?leaseId=${reader.readerLeaseId}&afterRevision=1`, { headers: { Origin: origin } })).json();
    assert.equal(secondRead.liveRevision, 2);
    assert.equal(secondRead.plan.documentRevision, nextPlan.documentRevision);
    await fetch(`${base}/session/${writer.sessionId}/release`, { method: "POST", headers, body: JSON.stringify({ role: "writer", leaseId: writer.writerLeaseId }) });
    const finalRead = await (await fetch(`${base}/session/${writer.sessionId}/plan?leaseId=${reader.readerLeaseId}&afterRevision=0`, { headers: { Origin: origin } })).json();
    assert.equal(finalRead.changed, true);
    await fetch(`${base}/session/${writer.sessionId}/release`, { method: "POST", headers, body: JSON.stringify({ role: "reader", leaseId: reader.readerLeaseId }) });
    await new Promise(resolve => setTimeout(resolve, 75));
    const capability = await (await fetch(`${base}/capability`, { headers: { Origin: origin } })).json();
    assert.equal(capability.activeSession, null);
  } finally {
    await stopServer(child);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("isolated live-edit broker preserves schema-v2 Doubles slots", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "plc-live-doubles-test-"));
  const port = await freePort();
  const child = startServer(port, stateRoot);
  const origin = `http://127.0.0.1:${port}`;
  const headers = { "Content-Type": "application/json", Origin: origin };
  try {
    await waitForHealth(port, child);
    const { plan } = fixtureDoublesPlan();
    const base = `${origin}/__stream-tools/battle-plan-live`;
    const writerResponse = await fetch(`${base}/writer`, { method: "POST", headers, body: JSON.stringify({ plan }) });
    const writerBody = await writerResponse.json();
    assert.equal(writerResponse.status, 200, writerBody.error);
    const writer = writerBody;
    const reader = await (await fetch(`${base}/reader`, { method: "POST", headers, body: JSON.stringify({ sessionId: writer.sessionId }) })).json();
    const live = await (await fetch(`${base}/session/${writer.sessionId}/plan?leaseId=${reader.readerLeaseId}&afterRevision=0`, { headers: { Origin: origin } })).json();
    assert.equal(live.plan.schemaVersion, 2);
    assert.equal(live.plan.game.battleFormat, "doubles");
    assert.equal(live.plan.stateNodes[live.plan.initialStateNodeId].active.playerCombatantKeys.length, 2);
    await fetch(`${base}/session/${writer.sessionId}/release`, { method: "POST", headers, body: JSON.stringify({ role: "writer", leaseId: writer.writerLeaseId }) });
    await fetch(`${base}/session/${writer.sessionId}/release`, { method: "POST", headers, body: JSON.stringify({ role: "reader", leaseId: reader.readerLeaseId }) });
  } finally {
    await stopServer(child);
    await rm(stateRoot, { recursive: true, force: true });
  }
});
