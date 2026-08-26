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

test("self stat secondaries become move selectors and keep their self target", () => {
  const fieryActions = {
    player: [{ actionType: "move", actorKey, moveId: "fierydance", targetKeys: [targetKey] }],
    enemy: []
  };
  const fieryOutcomes = [
    {
      previewOutcomeId: "boosted",
      outcome: { probability: 0.5 },
      events: [
        { eventType: "damage", actorKey, targetKey, moveId: "fierydance", metadata: { criticalHit: false, thresholdOutcome: "survive" } },
        {
          eventType: "stat-stage-change",
          actorKey,
          targetKey: actorKey,
          moveId: "fierydance",
          changes: [{ stat: "spa", from: 0, to: 1, requestedDelta: 1, appliedDelta: 1 }],
          metadata: { target: "self", resultLabel: "Sp. Atk +1" }
        }
      ]
    },
    {
      previewOutcomeId: "not-boosted",
      outcome: { probability: 0.5 },
      events: [
        { eventType: "damage", actorKey, targetKey, moveId: "fierydance", metadata: { criticalHit: false, thresholdOutcome: "survive" } },
        { eventType: "secondary-effect-missed", actorKey, targetKey: actorKey, moveId: "fierydance", metadata: { secondaryTargetKeys: [actorKey] } }
      ]
    }
  ];
  const model = createBranchEventModel({ outcomes: fieryOutcomes, actions: fieryActions, defaultOutcomeId: "not-boosted" });
  const secondary = model.dimensions.find(entry => entry.kind === "secondary");
  assert.equal(secondary?.targetKey, actorKey);
  assert.equal(secondary?.effectLabel, "Sp. Atk +1");
  assert.deepEqual(new Map(secondary.options.map(entry => [entry.id, entry.label])), new Map([["applied", "Sp. Atk +1"], ["not-applied", "No Sp. Atk +1"]]));
  assert.equal(selectBranchEventOutcome(model, "not-boosted", secondary.id, "applied", fieryOutcomes), "boosted");
});

test("one Doubles Crit choice selects all-target critical outcomes and hides mixed rolls", () => {
  const secondTargetKey = "enemy:c";
  const spreadActions = {
    player: [{ actionType: "move", actorKey, moveId: "surf", targetKeys: [targetKey, secondTargetKey] }],
    enemy: []
  };
  const spreadDamage = (target, criticalHit) => ({
    eventType: "damage",
    actorKey,
    targetKey: target,
    moveId: "surf",
    metadata: { criticalHit, thresholdOutcome: "survive" }
  });
  const spreadOutcomes = [
    { previewOutcomeId: "normal-normal", outcome: { probability: 0.7 }, events: [spreadDamage(targetKey, false), spreadDamage(secondTargetKey, false)] },
    { previewOutcomeId: "crit-normal", outcome: { probability: 0.1 }, events: [spreadDamage(targetKey, true), spreadDamage(secondTargetKey, false)] },
    { previewOutcomeId: "normal-crit", outcome: { probability: 0.1 }, events: [spreadDamage(targetKey, false), spreadDamage(secondTargetKey, true)] },
    { previewOutcomeId: "crit-crit", outcome: { probability: 0.1 }, events: [spreadDamage(targetKey, true), spreadDamage(secondTargetKey, true)] }
  ];
  const model = createBranchEventModel({ outcomes: spreadOutcomes, actions: spreadActions, defaultOutcomeId: "normal-normal" });
  const critical = model.dimensions.find(entry => entry.kind === "critical");
  assert.deepEqual(critical.options.map(entry => entry.id), ["normal", "critical"]);
  assert.equal(selectBranchEventOutcome(model, "normal-normal", critical.id, "critical", spreadOutcomes), "crit-crit");
  assert.equal(selectBranchEventOutcome(model, "crit-crit", critical.id, "normal", spreadOutcomes), "normal-normal");
});
