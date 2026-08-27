import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectLocalTestingStateCapability, storeLocalTestingState } from "../src/integrations/local_testing_state.js";
import { createTestingStateSnapshot } from "../src/testing/state_snapshot.js";
import { fixturePlan, fixtureTriplePlan } from "./helpers.mjs";

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Isolated static server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Isolated static server did not become healthy");
}

test("loopback testing-state endpoint stores one fixed safe snapshot", async () => {
  const port = await availablePort();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plc-testing-endpoint-"));
  const launcherRoot = path.resolve("..", "..", "Local Tools", "Stream Tools Launcher");
  const child = spawn(process.execPath, ["static_server.js"], {
    cwd: launcherRoot,
    env: { ...process.env, STREAM_TOOLS_STATIC_PORT: String(port), STREAM_TOOLS_STATE_ROOT: stateRoot },
    windowsHide: true,
    stdio: "ignore"
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const localFetch = (input, init) => fetch(new URL(input, baseUrl), init);
  try {
    await waitForHealth(`${baseUrl}/__stream-tools/health`, child);
    const capability = await detectLocalTestingStateCapability(localFetch);
    assert.equal(capability?.storage, "fixed-latest");

    const { plan } = fixturePlan({ battleFormat: "doubles" });
    const snapshot = createTestingStateSnapshot({
      capturedAt: "2026-08-25T12:00:00.000Z",
      selectedGameId: "volt-white-2r",
      plan,
      cursorStateNodeId: plan.initialStateNodeId,
      actionDraft: {
        player: [{ type: "move", moveId: "tackle", targetKey: "enemy:a" }, {}],
        enemy: [{}, {}]
      }
    });
    const receipt = await storeLocalTestingState(snapshot, localFetch);
    assert.equal(receipt.ok, true);

    const latestPath = path.join(stateRoot, "plc-testing-state", "latest.json");
    const original = await fs.readFile(latestPath, "utf8");
    const stored = JSON.parse(original);
    assert.equal(stored.transientTurn.actionDraft.player[0].moveId, "tackle");
    assert.deepEqual(stored.transientTurn.actionDraft.player[1], {});
    assert.equal(stored.transientTurn.currentPreview, null);

    const { plan: triplePlan } = fixtureTriplePlan();
    const tripleSnapshot = createTestingStateSnapshot({
      capturedAt: "2026-08-26T12:00:00.000Z",
      selectedGameId: "volt-white-2r",
      plan: triplePlan,
      cursorStateNodeId: triplePlan.initialStateNodeId,
      actionDraft: {
        player: [{ type: "move", moveId: "tackle", targetKey: "enemy:a" }, { type: "shift", actorKey: "player:b" }, {}],
        enemy: [{}, { type: "move", moveId: "tackle", targetKey: "player:b" }, {}]
      }
    });
    const tripleReceipt = await storeLocalTestingState(tripleSnapshot, localFetch);
    assert.equal(tripleReceipt.ok, true);
    const current = await fs.readFile(latestPath, "utf8");
    const storedTriple = JSON.parse(current);
    assert.equal(storedTriple.plan.schemaVersion, 3);
    assert.equal(storedTriple.plan.game.battleFormat, "triples");
    assert.equal(storedTriple.transientTurn.actionDraft.player.length, 3);
    assert.equal(storedTriple.transientTurn.actionDraft.player[1].type, "shift");

    const wrongOrigin = await fetch(`${baseUrl}/__stream-tools/plc-testing-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://example.invalid" },
      body: JSON.stringify(snapshot)
    });
    assert.equal(wrongOrigin.status, 403);

    const forbidden = await fetch(`${baseUrl}/__stream-tools/plc-testing-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...snapshot, sessionId: "not-allowed" })
    });
    assert.equal(forbidden.status, 400);
    assert.equal(await fs.readFile(latestPath, "utf8"), current);
  } finally {
    if (child.exitCode === null) child.kill();
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});
