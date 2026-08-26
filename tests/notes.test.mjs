import assert from "node:assert/strict";
import test from "node:test";
import { exportSelectedPlan, parsePlan, serializePlan } from "../src/contracts/plan_file.js";
import { setStateNodeNote } from "../src/core/plan.js";
import { commitPreview, previewTurn } from "../src/core/planner.js";
import { recalculatePlanDocument } from "../src/core/recalculation.js";
import { damageAdapter, fixturePlan } from "./helpers.mjs";

function move(actorKey, moveId, targetKey) {
  return { actionType: "move", actorKey, moveId, targetKeys: [targetKey], mechanicActivations: [], declaredAtStateHash: "fixture" };
}

test("draft notes commit to a node and survive portable export and import", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  setStateNodeNote(plan, plan.initialStateNodeId, "draftNote", "Preserve this Turn 1 line.", "2026-08-26T00:00:00.000Z");
  const actions = { player: move(players[0].combatantKey, "tackle", enemies[0].combatantKey), enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey) };
  const preview = previewTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [10]) });
  const committed = commitPreview(plan, preview, dataset, { selectedPreviewOutcomeId: preview.defaultPreviewOutcomeId, commitSelectedOnly: true });
  assert.equal(committed.plan.stateNodes[committed.cursorStateNodeId].notes, "Preserve this Turn 1 line.");
  assert.equal(committed.plan.stateNodes[plan.initialStateNodeId].draftNote, "");
  setStateNodeNote(committed.plan, committed.cursorStateNodeId, "notes", "Updated committed note.", "2026-08-26T00:01:00.000Z");
  setStateNodeNote(committed.plan, committed.cursorStateNodeId, "draftNote", "Do not export this Turn 2 draft.", "2026-08-26T00:02:00.000Z");
  const exported = exportSelectedPlan(committed.plan, [committed.cursorStateNodeId]).plan;
  const imported = parsePlan(serializePlan(exported));
  assert.equal(imported.stateNodes[committed.cursorStateNodeId].notes, "Updated committed note.");
  assert.equal(imported.stateNodes[committed.cursorStateNodeId].draftNote, undefined);
});

test("recalculation preserves committed and pending node notes", async () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = { player: move(players[0].combatantKey, "tackle", enemies[0].combatantKey), enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey) };
  const adapter = damageAdapter(() => [10]);
  const preview = previewTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions, dataset, damageAdapter: adapter });
  const committed = commitPreview(plan, preview, dataset, { selectedPreviewOutcomeId: preview.defaultPreviewOutcomeId, commitSelectedOnly: true });
  setStateNodeNote(committed.plan, committed.cursorStateNodeId, "notes", "Committed annotation");
  setStateNodeNote(committed.plan, committed.cursorStateNodeId, "draftNote", "Pending next-turn annotation");
  const rebuilt = await recalculatePlanDocument(committed.plan, { dataset, previewTurnFn: request => previewTurn({ ...request, dataset, damageAdapter: adapter }) });
  const rebuiltGroup = Object.values(rebuilt.actionGroups)[0];
  const rebuiltState = rebuilt.stateNodes[rebuiltGroup.defaultOutcomeStateNodeId];
  assert.equal(rebuiltState.notes, "Committed annotation");
  assert.equal(rebuiltState.draftNote, "Pending next-turn annotation");
});
