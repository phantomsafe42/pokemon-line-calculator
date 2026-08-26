import assert from "node:assert/strict";
import test from "node:test";
import { mechanicsCompatibility, validatePlanReferences } from "../src/contracts/plan_compatibility.js";
import { parsePlan } from "../src/contracts/plan_file.js";
import { commitPreview, previewTurn } from "../src/core/planner.js";
import { recalculatePlanDocument } from "../src/core/recalculation.js";
import { damageAdapter, fixturePlan } from "./helpers.mjs";

function declaredMove(state, actorKey, moveId, targetKey) {
  return {
    actionType: "move",
    actorKey,
    moveId,
    targetKeys: [targetKey],
    mechanicActivations: [],
    declaredAtStateHash: state.stateHash
  };
}

test("recalculation replays the saved graph under the current mechanics fingerprint", async () => {
  const { dataset, players, enemies, plan: initial } = fixturePlan();
  const state = initial.stateNodes[initial.initialStateNodeId];
  const actions = {
    player: declaredMove(state, players[0].combatantKey, "tackle", enemies[0].combatantKey),
    enemy: declaredMove(state, enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const adapter = damageAdapter(({ attacker }) => attacker.side === "player" ? [12, 14] : [9, 11]);
  const committed = commitPreview(initial, previewTurn({
    plan: initial,
    parentStateNodeId: initial.initialStateNodeId,
    actions,
    dataset,
    damageAdapter: adapter
  }), dataset).plan;
  committed.mechanicsFingerprint = { ...committed.mechanicsFingerprint, battleMechanicsHash: "obsolete" };

  assert.equal(mechanicsCompatibility(committed, dataset).needsRecalculation, true);
  const rebuilt = await recalculatePlanDocument(committed, {
    dataset,
    now: "2026-08-23T12:00:00.000Z",
    previewTurnFn: request => previewTurn({ ...request, dataset, damageAdapter: adapter })
  });
  assert.deepEqual(rebuilt.mechanicsFingerprint, dataset.fingerprint);
  assert.equal(Object.keys(rebuilt.actionGroups).length, 1);
  assert.equal(Object.keys(rebuilt.stateNodes).length, Object.keys(committed.stateNodes).length);
  assert.equal(mechanicsCompatibility(rebuilt, dataset).editable, true);
  assert.equal(validatePlanReferences(rebuilt, dataset).valid, true);
});

test("reference validation rejects missing standardized records", () => {
  const { dataset, plan } = fixturePlan();
  plan.combatants[Object.keys(plan.combatants)[0]].speciesId = "missing-form";
  assert.throws(() => validatePlanReferences(plan, dataset), /missing species missing-form/);
});

test("plan parsing rejects an oversized file before JSON parsing", () => {
  assert.throws(() => parsePlan("x".repeat(129), { maxBytes: 128 }), /exceeds the size limit/);
});
