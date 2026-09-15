import assert from "node:assert/strict";
import test from "node:test";

import { ResolverWorkerClient } from "../src/worker/resolver_client.js";

class FakeWorker {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({ data });
  }

  terminate() {
    this.terminated = true;
  }
}

test("Trainer AI analysis uses a dedicated Worker lane and cannot block damage previews", async () => {
  const originalWorker = globalThis.Worker;
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker;
  try {
    const client = new ResolverWorkerClient(new URL("https://example.invalid/resolver_worker.js"));
    assert.equal(FakeWorker.instances.length, 2);
    const [resolverWorker, trainerAiWorker] = FakeWorker.instances;

    const initializing = client.initialize("dataset", "trainer-ai", "game");
    assert.equal(resolverWorker.messages[0].type, "initialize");
    assert.equal(trainerAiWorker.messages[0].type, "initialize");
    assert.equal(resolverWorker.messages[0].payload.role, "resolver");
    assert.equal(trainerAiWorker.messages[0].payload.role, "trainer-ai");
    resolverWorker.emit("message", { requestId: resolverWorker.messages[0].requestId, ok: true, result: { lane: "resolver" } });
    trainerAiWorker.emit("message", { requestId: trainerAiWorker.messages[0].requestId, ok: true, result: { lane: "trainer-ai" } });
    assert.deepEqual(await initializing, { lane: "resolver" });

    const aiPromise = client.trainerAi({ state: "slow" });
    const damagePromise = client.damagePreview({ move: "fast" });
    assert.equal(trainerAiWorker.messages.at(-1).type, "trainer-ai");
    assert.equal(resolverWorker.messages.at(-1).type, "damage-preview");
    resolverWorker.emit("message", { requestId: resolverWorker.messages.at(-1).requestId, ok: true, result: { damage: 42 } });
    assert.deepEqual(await damagePromise, { damage: 42 });
    trainerAiWorker.emit("message", { requestId: trainerAiWorker.messages.at(-1).requestId, ok: true, result: { probability: 1 } });
    assert.deepEqual(await aiPromise, { probability: 1 });

    client.terminate();
    assert.equal(resolverWorker.terminated, true);
    assert.equal(trainerAiWorker.terminated, true);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test("Trainer AI requests queue on the persistent AI Worker without reloading its documentation", async () => {
  const originalWorker = globalThis.Worker;
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker;
  try {
    const client = new ResolverWorkerClient(new URL("https://example.invalid/resolver_worker.js"));
    const [resolverWorker, firstAiWorker] = FakeWorker.instances;
    const initializing = client.initialize("dataset", "trainer-ai", "game");
    resolverWorker.emit("message", { requestId: resolverWorker.messages[0].requestId, ok: true, result: {} });
    firstAiWorker.emit("message", { requestId: firstAiWorker.messages[0].requestId, ok: true, result: {} });
    await initializing;

    const first = client.trainerAi({ state: "old" });
    const current = client.trainerAi({ state: "new" });
    assert.equal(FakeWorker.instances.length, 2);
    assert.equal(firstAiWorker.terminated, false);
    assert.equal(resolverWorker.terminated, false);
    assert.deepEqual(firstAiWorker.messages.slice(1).map(message => message.type), ["trainer-ai", "trainer-ai"]);
    firstAiWorker.emit("message", { requestId: firstAiWorker.messages[1].requestId, ok: true, result: { state: "old" } });
    firstAiWorker.emit("message", { requestId: firstAiWorker.messages[2].requestId, ok: true, result: { state: "new" } });
    assert.deepEqual(await first, { state: "old" });
    assert.deepEqual(await current, { state: "new" });
    client.terminate();
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test("a new planning context discards stale AI work without restarting the resolver lane", async () => {
  const originalWorker = globalThis.Worker;
  FakeWorker.instances = [];
  globalThis.Worker = FakeWorker;
  try {
    const client = new ResolverWorkerClient(new URL("https://example.invalid/resolver_worker.js"));
    const [resolverWorker, firstAiWorker] = FakeWorker.instances;
    const initializing = client.initialize("dataset", "trainer-ai", "game");
    resolverWorker.emit("message", { requestId: resolverWorker.messages[0].requestId, ok: true, result: {} });
    firstAiWorker.emit("message", { requestId: firstAiWorker.messages[0].requestId, ok: true, result: {} });
    await initializing;

    const stale = client.trainerAi({ state: "old-plan" });
    const staleRejection = assert.rejects(stale, error => error.name === "StaleTrainerAiError");
    assert.equal(client.resetTrainerAiLaneIfBusy(), true);
    await staleRejection;
    assert.equal(firstAiWorker.terminated, true);
    assert.equal(resolverWorker.terminated, false);
    assert.equal(FakeWorker.instances.length, 3);

    const replacementAiWorker = FakeWorker.instances[2];
    assert.equal(replacementAiWorker.messages[0].type, "initialize");
    const current = client.trainerAi({ state: "new-plan" });
    assert.equal(replacementAiWorker.messages.length, 1);
    replacementAiWorker.emit("message", { requestId: replacementAiWorker.messages[0].requestId, ok: true, result: {} });
    await Promise.resolve();
    assert.equal(replacementAiWorker.messages[1].type, "trainer-ai");
    replacementAiWorker.emit("message", { requestId: replacementAiWorker.messages[1].requestId, ok: true, result: { state: "new-plan" } });
    assert.deepEqual(await current, { state: "new-plan" });
    client.terminate();
  } finally {
    globalThis.Worker = originalWorker;
  }
});
