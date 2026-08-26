import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deriveDisplayColumns, createPlanSubset, exportBranchGroups, planTurnTreeOrder, preferredImportedReviewStateId, stateLineage, turnNodeVisuals } from "../src/core/graph.js";
import { parsePlan, serializePlan } from "../src/contracts/plan_file.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const plan = parsePlan(fs.readFileSync(path.join(here, "fixtures", "vw2r-branch-plan.json"), "utf8"));

test("lineage follows state and action-group ancestry", () => {
  assert.deepEqual(stateLineage(plan, "state-turn-2-ko"), ["state-root", "state-turn-1-main", "state-turn-2-ko"]);
});

test("shared parent plus two outcomes derives two display columns", () => {
  const selection = deriveDisplayColumns(plan, ["state-turn-1-main", "state-turn-2-ko", "state-turn-2-survive"]);
  assert.equal(selection.selectedTurnCount, 3);
  assert.equal(selection.branchCount, 2);
  assert.deepEqual(selection.columns.map(column => column.stateNodeIds), [
    ["state-turn-1-main", "state-turn-2-ko"],
    ["state-turn-1-main", "state-turn-2-survive"]
  ]);
});

test("save selection groups every leaf lineage into a numbered branch", () => {
  assert.deepEqual(exportBranchGroups(plan), [
    { branchNumber: 1, leafStateNodeId: "state-turn-2-ko", stateNodeIds: ["state-turn-1-main", "state-turn-2-ko"] },
    { branchNumber: 2, leafStateNodeId: "state-turn-2-survive", stateNodeIds: ["state-turn-1-main", "state-turn-2-survive"] },
    { branchNumber: 3, leafStateNodeId: "state-turn-2-switch", stateNodeIds: ["state-turn-1-main", "state-turn-2-switch"] }
  ]);
});

test("an imported terminal export reopens its final saved action group", () => {
  const terminal = structuredClone(plan);
  terminal.stateNodes["state-turn-2-ko"].battleEnded = true;
  terminal.exportSelection = {
    selectedStateNodeIds: ["state-turn-1-main", "state-turn-2-ko", "state-turn-2-survive"],
    includedStateNodeIds: [],
    includedActionGroupIds: [],
    includedReplacementTransitionIds: []
  };
  assert.equal(preferredImportedReviewStateId(terminal), "state-turn-2-ko");
});

test("selected export closes over ancestry and omits sibling branches", () => {
  const subset = createPlanSubset(plan, ["state-turn-2-ko"] , { updatedAt: plan.updatedAt });
  assert.deepEqual(Object.keys(subset.stateNodes), ["state-root", "state-turn-1-main", "state-turn-2-ko"]);
  assert.deepEqual(Object.keys(subset.actionGroups), ["actions-turn-1-main", "actions-turn-2-revenge"]);
  assert.equal(subset.actionGroups["actions-turn-2-revenge"].defaultOutcomeStateNodeId, "state-turn-2-ko");
  assert.equal(subset.stateNodes["state-turn-1-main"].childActionGroupIds.includes("actions-turn-2-switch"), false);
  assert.deepEqual(parsePlan(serializePlan(subset)), subset);
});

test("turn-tree projection omits the pre-battle root and attaches drafts after committed outcomes", () => {
  const entries = planTurnTreeOrder(plan);
  assert.equal(entries.some(entry => entry.turnNumber === 0), false);
  assert.deepEqual(entries.filter(entry => entry.kind === "committed").map(entry => [entry.turnNumber, entry.outcomeStateNodeId, entry.decisionStateNodeId]), [
    [1, "state-turn-1-main", "state-root"],
    [2, "state-turn-2-ko", "state-turn-1-main"],
    [2, "state-turn-2-survive", "state-turn-1-main"],
    [2, "state-turn-2-switch", "state-turn-1-main"]
  ]);
  assert.deepEqual(entries.filter(entry => entry.kind === "draft").map(entry => [entry.turnNumber, entry.decisionStateNodeId]), [
    [3, "state-turn-2-ko"],
    [3, "state-turn-2-survive"],
    [3, "state-turn-2-switch"]
  ]);

  const terminal = structuredClone(plan);
  terminal.stateNodes["state-turn-2-ko"].battleEnded = true;
  assert.equal(planTurnTreeOrder(terminal).some(entry => entry.kind === "draft" && entry.decisionStateNodeId === "state-turn-2-ko"), false);
});

test("turn-tree lanes preserve branch rows when an earlier branch ends", () => {
  const lanePlan = {
    initialStateNodeId: "root",
    stateNodes: {
      root: { stateNodeId: "root", turnNumber: 0, createdOrder: 0, childActionGroupIds: ["start"], childReplacementTransitionIds: [] },
      t1: { stateNodeId: "t1", turnNumber: 1, createdOrder: 2, parentActionGroupId: "start", childActionGroupIds: ["branch-1", "branch-2", "branch-3"], childReplacementTransitionIds: [] },
      "b1-t2": { stateNodeId: "b1-t2", turnNumber: 2, createdOrder: 4, parentActionGroupId: "branch-1", childActionGroupIds: ["branch-1-next", "branch-1-late"], childReplacementTransitionIds: [] },
      "b1-t3": { stateNodeId: "b1-t3", turnNumber: 3, createdOrder: 6, parentActionGroupId: "branch-1-next", childActionGroupIds: [], childReplacementTransitionIds: [] },
      "b2-t2": { stateNodeId: "b2-t2", turnNumber: 2, createdOrder: 8, parentActionGroupId: "branch-2", childActionGroupIds: [], childReplacementTransitionIds: [] },
      "b3-t2": { stateNodeId: "b3-t2", turnNumber: 2, createdOrder: 10, parentActionGroupId: "branch-3", childActionGroupIds: ["branch-3-next"], childReplacementTransitionIds: [] },
      "b3-t3": { stateNodeId: "b3-t3", turnNumber: 3, createdOrder: 12, parentActionGroupId: "branch-3-next", childActionGroupIds: [], childReplacementTransitionIds: [] },
      "b1-late-t3": { stateNodeId: "b1-late-t3", turnNumber: 3, createdOrder: 14, parentActionGroupId: "branch-1-late", childActionGroupIds: [], childReplacementTransitionIds: [] }
    },
    actionGroups: {
      start: { parentStateNodeId: "root", outcomeStateNodeIds: ["t1"], createdOrder: 1 },
      "branch-1": { parentStateNodeId: "t1", outcomeStateNodeIds: ["b1-t2"], createdOrder: 3 },
      "branch-1-next": { parentStateNodeId: "b1-t2", outcomeStateNodeIds: ["b1-t3"], createdOrder: 5 },
      "branch-2": { parentStateNodeId: "t1", outcomeStateNodeIds: ["b2-t2"], createdOrder: 7 },
      "branch-3": { parentStateNodeId: "t1", outcomeStateNodeIds: ["b3-t2"], createdOrder: 9 },
      "branch-3-next": { parentStateNodeId: "b3-t2", outcomeStateNodeIds: ["b3-t3"], createdOrder: 11 },
      "branch-1-late": { parentStateNodeId: "b1-t2", outcomeStateNodeIds: ["b1-late-t3"], createdOrder: 13 }
    },
    replacementTransitions: {}
  };
  const entries = planTurnTreeOrder(lanePlan);
  const committedLanes = Object.fromEntries(entries.filter(entry => entry.kind === "committed").map(entry => [entry.outcomeStateNodeId, entry.lane]));
  const draftLanes = Object.fromEntries(entries.filter(entry => entry.kind === "draft").map(entry => [entry.decisionStateNodeId, entry.lane]));
  assert.deepEqual(committedLanes, { t1: 0, "b1-t2": 0, "b2-t2": 1, "b3-t2": 2, "b1-t3": 0, "b3-t3": 2, "b1-late-t3": 3 });
  assert.deepEqual(draftLanes, { "b2-t2": 1, "b1-t3": 0, "b3-t3": 2, "b1-late-t3": 3 });
  const newBranchDraft = planTurnTreeOrder(lanePlan, { additionalDraftStateNodeIds: ["t1"] })
    .find(entry => entry.kind === "draft" && entry.decisionStateNodeId === "t1");
  assert.equal(newBranchDraft.lane, 4);
});

test("turn-node visuals use action combatants and identify newly fainted Pokemon", () => {
  const koState = plan.stateNodes["state-turn-2-ko"];
  const koGroup = plan.actionGroups[koState.parentActionGroupId];
  const ko = turnNodeVisuals(plan, koGroup.parentStateNodeId, koState, koGroup.actions);
  assert.deepEqual(ko.combatantKeys, [
    "player:unique:samurott-fixture",
    "enemy:trainer:fixture-trainer:slot:1"
  ]);
  assert.equal(ko.hasFaint, true);
  assert.deepEqual([...ko.faintedCombatantKeys], ["enemy:trainer:fixture-trainer:slot:1"]);

  const switchState = plan.stateNodes["state-turn-2-switch"];
  const switchGroup = plan.actionGroups[switchState.parentActionGroupId];
  const switched = turnNodeVisuals(plan, switchGroup.parentStateNodeId, switchState, switchGroup.actions);
  assert.deepEqual(switched.combatantKeys, [
    "player:unique:lucario-fixture",
    "enemy:trainer:fixture-trainer:slot:1"
  ]);
  assert.equal(switched.hasFaint, false);
  assert.deepEqual([...switched.switchedInCombatantKeys], ["player:unique:lucario-fixture"]);

  const forced = turnNodeVisuals(plan, switchGroup.parentStateNodeId, { ...switchState, resolutionEventIds: [] }, {
    player: [{ actionType: "replacement", switchToKey: "player:unique:lucario-fixture", switchKind: "forced" }],
    enemy: []
  });
  assert.deepEqual([...forced.switchedInCombatantKeys], []);
});
