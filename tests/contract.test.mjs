import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePlan, serializePlan } from "../src/contracts/plan_file.js";
import { validatePlanDocument } from "../src/contracts/plan_contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureText = fs.readFileSync(path.join(here, "fixtures", "vw2r-branch-plan.json"), "utf8");

test("VW2R branch fixture validates and round-trips without semantic loss", () => {
  const plan = parsePlan(fixtureText);
  assert.equal(plan.game.gameId, "volt-white-2r");
  assert.equal(Object.keys(plan.stateNodes).length, 5);
  assert.equal(Object.keys(plan.actionGroups).length, 3);
  assert.deepEqual(parsePlan(serializePlan(plan)), plan);
});

test("contract rejects unsupported schema versions", () => {
  const plan = JSON.parse(fixtureText);
  plan.schemaVersion = 4;
  const result = validatePlanDocument(plan);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(entry => entry.path === "$.schemaVersion"));
});

test("schema-v1 plans migrate explicitly to the schema-v2 Singles shape", () => {
  const original = JSON.parse(fixtureText);
  const migrated = parsePlan(fixtureText);
  assert.equal(original.schemaVersion, 1);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.game.battleFormat, "singles");
  const root = migrated.stateNodes[migrated.initialStateNodeId];
  assert.deepEqual(root.active.playerCombatantKeys, [root.active.playerCombatantKey]);
  assert.deepEqual(root.active.enemyCombatantKeys, [root.active.enemyCombatantKey]);
  assert.ok(Object.values(migrated.actionGroups).every(group => Array.isArray(group.actions.player) && Array.isArray(group.actions.enemy)));
  assert.deepEqual(parsePlan(fixtureText, { migrate: false }), original);
});

test("contract rejects missing links, cycles, and invalid sibling probability", () => {
  const missing = JSON.parse(fixtureText);
  missing.stateNodes["state-turn-2-ko"].parentActionGroupId = "missing-actions";
  assert.equal(validatePlanDocument(missing).valid, false);

  const cycle = JSON.parse(fixtureText);
  cycle.stateNodes["state-turn-2-ko"].childActionGroupIds = ["actions-turn-1-main"];
  cycle.actionGroups["actions-turn-1-main"].parentStateNodeId = "state-turn-2-ko";
  assert.ok(validatePlanDocument(cycle).issues.some(entry => /cycle|belongs to another parent/.test(entry.message)));

  const probability = JSON.parse(fixtureText);
  probability.stateNodes["state-turn-2-ko"].outcome.probability = 0.5;
  assert.ok(validatePlanDocument(probability).issues.some(entry => /probabilities must sum to 1/.test(entry.message)));
});

test("portable contract rejects runtime and machine-local fields", () => {
  const plan = JSON.parse(fixtureText);
  plan.sourceSnapshot.saveFile = "machine-local.sav";
  const result = validatePlanDocument(plan);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(entry => entry.path.endsWith("saveFile")));
});

test("portable contract accepts the Dataset UInt16 base EXP-yield range", () => {
  const plan = JSON.parse(fixtureText);
  const combatant = Object.values(plan.combatants)[0];
  combatant.baseExperienceYield = 608;
  assert.equal(validatePlanDocument(plan).valid, true);
  combatant.baseExperienceYield = 65536;
  assert.ok(validatePlanDocument(plan).issues.some(entry => entry.path.endsWith("baseExperienceYield")));
});
