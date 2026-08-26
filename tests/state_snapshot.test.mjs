import assert from "node:assert/strict";
import test from "node:test";
import { createTestingStateSnapshot, formatTestingStateSnapshot, TESTING_STATE_KIND } from "../src/testing/state_snapshot.js";
import { fixturePlan } from "./helpers.mjs";

test("testing state preserves incomplete per-slot selections without inventing a preview", () => {
  const { plan } = fixturePlan({ battleFormat: "doubles" });
  const actionDraft = {
    player: [
      { type: "move", moveId: "tackle", targetKey: "enemy:a", mechanicValue: null },
      {}
    ],
    enemy: [
      { type: "switch", actorKey: "enemy:a" },
      {}
    ]
  };
  const snapshot = createTestingStateSnapshot({
    capturedAt: "2026-08-25T12:00:00.000Z",
    selectedGameId: "volt-white-2r",
    activeTab: "plc",
    plan,
    cursorStateNodeId: plan.initialStateNodeId,
    actionDraft,
    currentPreview: null,
    selectedPreviewOutcomeId: "preview-crafted",
    reviewOutcomeStateNodeId: "state-reviewed",
    outcomesExpanded: true,
    exportSelection: new Set(["state-a", "state-a"]),
    liveEditActive: true
  });

  assert.equal(snapshot.kind, TESTING_STATE_KIND);
  assert.equal(snapshot.transientTurn.actionDraft.player[0].moveId, "tackle");
  assert.deepEqual(snapshot.transientTurn.actionDraft.player[1], {});
  assert.equal(snapshot.transientTurn.actionDraft.enemy[0].type, "switch");
  assert.equal(snapshot.transientTurn.currentPreview, null);
  assert.equal(snapshot.transientTurn.selectedPreviewOutcomeId, "preview-crafted");
  assert.equal(snapshot.app.reviewOutcomeStateNodeId, "state-reviewed");
  assert.deepEqual(snapshot.app.exportSelection, ["state-a"]);
  assert.equal(snapshot.app.liveEditActive, true);
  assert.equal("localLiveEdit" in snapshot, false);

  actionDraft.player[0].moveId = "mutated";
  plan.name = "mutated";
  assert.equal(snapshot.transientTurn.actionDraft.player[0].moveId, "tackle");
  assert.notEqual(snapshot.plan.name, "mutated");

  const parsed = JSON.parse(formatTestingStateSnapshot(snapshot));
  assert.equal(parsed.transientTurn.actionDraft.player[0].targetKey, "enemy:a");
  assert.match(parsed.purpose, /not a portable battle plan/i);
  assert.ok(parsed.exclusions.some(entry => /lease credentials/i.test(entry)));
});
