import assert from "node:assert/strict";
import test from "node:test";
import { TrainerAiForecastCache } from "../src/cache/trainer_ai_forecast.js";

test("completed Trainer AI forecasts remain static across cloned instances of the same node", async () => {
  const cache = new TrainerAiForecastCache();
  const plan = { planId: "plan-1" };
  const state = { stateNodeId: "state-1", stateHash: "hash-1" };
  let evaluations = 0;
  const first = await cache.resolve(plan, state, () => ({ evaluation: ++evaluations }));
  const clone = structuredClone(state);
  const second = await cache.resolve(plan, clone, () => ({ evaluation: ++evaluations }));

  assert.equal(evaluations, 1);
  assert.equal(cache.get(plan, clone), first);
  assert.equal(second, first);
});

test("concurrent requests share one evaluation and changed state hashes receive a new forecast", async () => {
  const cache = new TrainerAiForecastCache();
  const plan = { planId: "plan-1" };
  const state = { stateNodeId: "state-1", stateHash: "hash-1" };
  let evaluations = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const factory = async () => {
    evaluations += 1;
    await gate;
    return { evaluation: evaluations };
  };
  const first = cache.resolve(plan, state, factory);
  const second = cache.resolve(plan, structuredClone(state), factory);
  release();

  assert.equal(await first, await second);
  assert.equal(evaluations, 1);

  const changed = { ...state, stateHash: "hash-2" };
  await cache.resolve(plan, changed, () => ({ evaluation: ++evaluations }));
  assert.equal(evaluations, 2);
});

test("failed evaluations are retryable instead of becoming static node results", async () => {
  const cache = new TrainerAiForecastCache();
  const plan = { planId: "plan-1" };
  const state = { stateNodeId: "state-1", stateHash: "hash-1" };
  let evaluations = 0;

  await assert.rejects(cache.resolve(plan, state, () => {
    evaluations += 1;
    throw new Error("interrupted");
  }), /interrupted/);
  const result = await cache.resolve(plan, state, () => ({ evaluation: ++evaluations }));

  assert.equal(evaluations, 2);
  assert.deepEqual(result, { evaluation: 2 });
});
