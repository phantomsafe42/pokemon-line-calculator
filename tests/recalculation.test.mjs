import assert from "node:assert/strict";
import test from "node:test";
import { mechanicsCompatibility, validatePlanReferences } from "../src/contracts/plan_compatibility.js";
import { parsePlan } from "../src/contracts/plan_file.js";
import { commitPreview, previewTurn } from "../src/core/planner.js";
import { recalculatePlanDocument } from "../src/core/recalculation.js";
import { upgradeImportedPlanForEditing } from "../src/core/import_upgrade.js";
import { currentMechanicsFingerprint } from "../src/rulesets/resolver_profile.js";
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
  assert.deepEqual(rebuilt.mechanicsFingerprint, currentMechanicsFingerprint(dataset));
  assert.equal(Object.keys(rebuilt.actionGroups).length, 1);
  assert.equal(Object.keys(rebuilt.stateNodes).length, Object.keys(committed.stateNodes).length);
  assert.equal(mechanicsCompatibility(rebuilt, dataset).editable, true);
  assert.equal(validatePlanReferences(rebuilt, dataset).valid, true);
});

test("recalculation refreshes Dataset-derived trainer stat levels and root HP without changing displayed level", async () => {
  const { dataset, plan } = fixturePlan();
  const enemy = Object.values(plan.combatants).find(combatant => combatant.side === "enemy");
  const root = plan.stateNodes[plan.initialStateNodeId];
  const oldMaximum = root.combatantStates[enemy.combatantKey].hp.maxHp;
  dataset.mechanics.features.challengeModeDisplayedLevelStatBug = {
    enabled: true,
    statLevelDeltaMemberField: "damageFormulaLevelDelta",
    displayedLevelField: "level"
  };
  for (const member of dataset.trainer("trainer").team) member.damageFormulaLevelDelta = -5;

  const rebuilt = await recalculatePlanDocument(plan, {
    dataset,
    previewTurnFn: () => { throw new Error("a root-only line should not replay actions"); }
  });
  const refreshed = rebuilt.combatants[enemy.combatantKey];
  const refreshedState = rebuilt.stateNodes[rebuilt.initialStateNodeId].combatantStates[enemy.combatantKey];
  assert.equal(refreshed.level, 50);
  assert.equal(refreshed.statCalculationLevelDelta, -5);
  assert.ok(refreshed.calculatedStats.hp < oldMaximum);
  assert.equal(refreshedState.currentLevel, 50);
  assert.equal(refreshedState.hp.max, refreshed.calculatedStats.hp);
  assert.equal(refreshedState.hp.maxHp, refreshed.calculatedStats.hp);
});

test("resolver-version recalculation preserves a selected crafted outcome", async () => {
  const { dataset, players, enemies, plan: initial } = fixturePlan();
  const state = initial.stateNodes[initial.initialStateNodeId];
  initial.combatants[players[0].combatantKey].moves[0] = { moveId: "toxic", maxPp: 10 };
  state.combatantStates[players[0].combatantKey].movePp.toxic = 10;
  const actions = {
    player: declaredMove(state, players[0].combatantKey, "toxic", enemies[0].combatantKey),
    enemy: declaredMove(state, enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const adapter = damageAdapter(() => [10]);
  const preview = previewTurn({ plan: initial, parentStateNodeId: initial.initialStateNodeId, actions, dataset, damageAdapter: adapter });
  const selected = preview.outcomes.find(outcome => outcome.events.some(event => event.eventType === "miss" && event.actorKey === players[0].combatantKey));
  assert.ok(selected);
  const committed = commitPreview(initial, preview, dataset, {
    selectedPreviewOutcomeId: selected.previewOutcomeId,
    commitSelectedOnly: true
  }).plan;
  delete committed.mechanicsFingerprint.plcResolverRulesetVersion;
  assert.deepEqual(mechanicsCompatibility(committed, dataset).differences, ["plcResolverRulesetVersion"]);

  const rebuilt = await recalculatePlanDocument(committed, {
    dataset,
    previewTurnFn: request => previewTurn({ ...request, dataset, damageAdapter: adapter })
  });
  const group = Object.values(rebuilt.actionGroups)[0];
  assert.equal(group.outcomeStateNodeIds.length, 1);
  const outcome = rebuilt.stateNodes[group.defaultOutcomeStateNodeId];
  const events = outcome.resolutionEventIds.map(id => rebuilt.resolutionEvents[id]);
  assert.ok(events.some(event => event.eventType === "miss" && event.actorKey === players[0].combatantKey));
  assert.ok(!events.some(event => event.eventType === "major-status" && event.actorKey === players[0].combatantKey));
  assert.equal(mechanicsCompatibility(rebuilt, dataset).editable, true);
});

test("Import Line automatically upgrades an older mechanics fingerprint into an editable plan", async () => {
  const { dataset, players, enemies, plan: initial } = fixturePlan();
  const state = initial.stateNodes[initial.initialStateNodeId];
  const actions = {
    player: declaredMove(state, players[0].combatantKey, "tackle", enemies[0].combatantKey),
    enemy: declaredMove(state, enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const adapter = damageAdapter(({ attacker }) => attacker.side === "player" ? [12, 14] : [9, 11]);
  const older = commitPreview(initial, previewTurn({
    plan: initial,
    parentStateNodeId: initial.initialStateNodeId,
    actions,
    dataset,
    damageAdapter: adapter
  }), dataset).plan;
  older.mechanicsFingerprint = { ...older.mechanicsFingerprint, battleMechanicsHash: "older-export" };

  const upgraded = await upgradeImportedPlanForEditing(older, {
    dataset,
    now: "2026-09-07T22:00:00.000Z",
    previewTurnFn: request => previewTurn({ ...request, dataset, damageAdapter: adapter })
  });

  assert.equal(upgraded.replayed, true);
  assert.deepEqual(upgraded.previousFingerprintDifferences, ["battleMechanicsHash"]);
  assert.equal(mechanicsCompatibility(upgraded.plan, dataset).editable, true);
  assert.equal(Object.keys(upgraded.plan.actionGroups).length, 1);
  assert.equal(Object.keys(upgraded.plan.stateNodes).length, Object.keys(older.stateNodes).length);
});

test("reference validation rejects missing standardized records", () => {
  const { dataset, plan } = fixturePlan();
  plan.combatants[Object.keys(plan.combatants)[0]].speciesId = "missing-form";
  assert.throws(() => validatePlanReferences(plan, dataset), /missing species missing-form/);
});

test("plan parsing rejects an oversized file before JSON parsing", () => {
  assert.throws(() => parsePlan("x".repeat(129), { maxBytes: 128 }), /exceeds the size limit/);
});
