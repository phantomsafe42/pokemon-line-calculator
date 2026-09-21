import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createGen5QueryProvider } from "../src/adapters/trainer_ai.js";

const profile = JSON.parse(fs.readFileSync(new URL("../src/generated/trainer-ai/gen5/trainer_ai.json", import.meta.url))).evaluator;
test("Gen 5 power, ranking, KO and partner queries share the source-bound static simulation", () => {
  const moves = { finalgambit: { id: "finalgambit", num: 515, type: "fighting", category: "special", basePower: 0 },
    bugbuzz: { id: "bugbuzz", num: 405, type: "bug", category: "special", basePower: 90 } };
  const mon = side => ({ side, moves: [{ moveId: "finalgambit" }, { moveId: "bugbuzz" }] });
  const plan = { game: { battleFormat: "doubles" }, combatants: { e: mon("enemy"), p: mon("enemy"), t: mon("player") } };
  const state = { active: { enemyCombatantKeys: ["e", "p"], playerCombatantKeys: ["t", null] },
    combatantStates: Object.fromEntries(["e", "p", "t"].map(key => [key, { hp: { min: 100, max: 100 }, currentAbilityId: "none" }])) };
  const calls = [];
  const provider = createGen5QueryProvider({ plan, state, dataset: { get: (_, id) => moves[id], abilityKnowledgePolicy: profile.constants.abilityKnowledge },
    actorEntry: { side: "enemy", slot: 0, combatantKey: "e" },
    damageAdapter: { calculate(request) { calls.push(request); return { status: "ok", damage: [request.moveSimulation.basePower, 120] }; } } });
  const metadata = { profile, context: { candidate: { action: { canonicalMoveId: "finalgambit", targetCombatantKey: "t", targetSlot: 0 } } } };
  assert.equal(provider["gen5.command.0x21"](metadata), 1, "ROM sentinel, not display zero");
  assert.equal(provider["gen5.command.0x36"]("target", metadata), false);
  assert.equal(provider["gen5.command.0x22"]("target", metadata), "not_strongest");
  assert.equal(provider["gen5.command.0x69"]("target", metadata), "not_strongest");
  assert.ok(calls.length >= 4);
  assert.ok(calls.every(row => row.moveSimulation.kind === "static-move-data/v1" && row.criticalHit === false));
  assert.ok(calls.some(row => row.attacker === plan.combatants.p), "partner comparison uses the same path");
  assert.throws(() => provider["gen5.command.0x21"]({ ...metadata, profile: { constants: {} } }), /source-bound/);
  assert.equal(moves.finalgambit.basePower, 0, "display/battle source stays untouched");
});
