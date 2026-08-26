import assert from "node:assert/strict";
import test from "node:test";
import { createBranchEventModel, selectBranchEventOutcome, selectedBranchChoices } from "../src/core/branch_events.js";

const actorKey = "player:a";
const targetKey = "enemy:b";
const actions = {
  player: [{ actionType: "move", actorKey, moveId: "hurricane", targetKeys: [targetKey] }],
  enemy: []
};

function damage(criticalHit, thresholdOutcome = "survive") {
  return { eventType: "damage", actorKey, targetKey, moveId: "hurricane", metadata: { criticalHit, thresholdOutcome } };
}

const outcomes = [
  {
    previewOutcomeId: "normal",
    outcome: { probability: 0.6 },
    events: [damage(false), { eventType: "secondary-effect-missed", actorKey, targetKey, moveId: "hurricane", metadata: {} }]
  },
  {
    previewOutcomeId: "confused",
    outcome: { probability: 0.2 },
    events: [damage(false), { eventType: "volatile-status", actorKey, targetKey, moveId: "hurricane", metadata: { volatileStatusId: "confusion" } }]
  },
  {
    previewOutcomeId: "critical-ko",
    outcome: { probability: 0.1 },
    events: [damage(true, "ko")]
  },
  {
    previewOutcomeId: "miss",
    outcome: { probability: 0.1 },
    events: [{ eventType: "miss", actorKey, targetKey, moveId: "hurricane", metadata: {} }]
  }
];

test("branch-event model condenses resolver outcomes into selectable move events", () => {
  const model = createBranchEventModel({ outcomes, actions, defaultOutcomeId: "normal" });
  assert.equal(model.selectedOutcomeId, "normal");
  assert.ok(model.dimensions.some(entry => entry.kind === "accuracy"));
  assert.ok(model.dimensions.some(entry => entry.kind === "critical"));
  assert.ok(model.dimensions.some(entry => entry.kind === "damage-result"));
  assert.ok(model.dimensions.some(entry => entry.kind === "secondary" && entry.effectLabel === "Confusion"));

  const critical = model.dimensions.find(entry => entry.kind === "critical");
  const selectedCritical = selectBranchEventOutcome(model, "normal", critical.id, "critical", outcomes);
  assert.equal(selectedCritical, "critical-ko");
  assert.equal(selectedBranchChoices(model, selectedCritical)[critical.id].id, "critical");

  const secondary = model.dimensions.find(entry => entry.kind === "secondary");
  assert.equal(selectBranchEventOutcome(model, "normal", secondary.id, "applied", outcomes), "confused");

  const accuracy = model.dimensions.find(entry => entry.kind === "accuracy");
  assert.equal(selectBranchEventOutcome(model, "normal", accuracy.id, "miss", outcomes), "miss");
});
