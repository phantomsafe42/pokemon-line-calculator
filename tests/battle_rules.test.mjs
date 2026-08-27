import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatorFieldName,
  criticalHitProbability,
  endOfTurnSupportIssue,
  protectSuccessProbability,
  statusApplicationResult,
  statusResidualRule,
  weatherResidualRule
} from "../src/rulesets/battle_rules.js";

function state({ types = ["normal"], ability = "pressure", item = null, status = null, toxicCounter = 0 } = {}) {
  return {
    hp: { min: 100, max: 100, maxHp: 100 },
    majorStatus: status,
    toxicCounter,
    currentTypeIds: types,
    currentAbilityId: ability,
    abilitySuppressed: false,
    currentItemId: item,
    itemState: item ? "held" : "none",
    volatileConditions: { substituteHp: 0 }
  };
}

test("field IDs map to bounded shared-calculator names", () => {
  assert.equal(calculatorFieldName("weather", { id: "rain" }), "Rain");
  assert.equal(calculatorFieldName("terrain", "Grassy Terrain"), "Grassy");
  assert.equal(calculatorFieldName("weather", null), undefined);
  assert.throws(() => calculatorFieldName("weather", "monsoon"), /unsupported weather/i);
});

test("Protect chance uses the declared formula generation", () => {
  assert.equal(protectSuccessProbability(5, 0), 1);
  assert.equal(protectSuccessProbability(5, 1), 0.5);
  assert.equal(protectSuccessProbability(5, 2), 0.25);
  assert.equal(protectSuccessProbability(6, 1), 1 / 3);
});

test("critical-hit rates are generation-aware and respect Gen 5 modifiers and blockers", () => {
  const base = {
    generation: 5,
    descriptor: { critRatio: 1 },
    attacker: { speciesId: "golduck" },
    attackerState: state(),
    defenderState: state(),
    defenderSideState: {}
  };
  assert.equal(criticalHitProbability(base), 1 / 16);
  assert.equal(criticalHitProbability({ ...base, descriptor: { critRatio: 2 } }), 1 / 8);
  assert.equal(criticalHitProbability({ ...base, attackerState: state({ ability: "Super Luck" }) }), 1 / 8);
  assert.equal(criticalHitProbability({ ...base, attackerState: state({ item: "Scope Lens" }) }), 1 / 8);
  const focused = state();
  focused.volatileConditions.focusenergy = true;
  assert.equal(criticalHitProbability({ ...base, attackerState: focused }), 1 / 4);
  assert.equal(criticalHitProbability({ ...base, descriptor: { willCrit: true } }), 1);
  assert.equal(criticalHitProbability({ ...base, defenderState: state({ ability: "Shell Armor" }), descriptor: { willCrit: true } }), 0);
  assert.equal(criticalHitProbability({ ...base, defenderSideState: { luckyChantTurns: 3 }, descriptor: { willCrit: true } }), 0);
  assert.equal(criticalHitProbability({ ...base, generation: 7 }), 1 / 24);
  assert.equal(criticalHitProbability({ ...base, generation: 1 }), null);
});

test("major-status immunities are canonical and generation-aware", () => {
  const emptyField = { global: { terrain: null } };
  const toxic = { statusId: "tox", immuneTypes: ["poison", "steel"], immuneAbilities: ["immunity"] };
  const thunderWave = { statusId: "par", moveImmuneTypes: ["ground"], immuneAbilities: ["limber"] };
  const stunSpore = { statusId: "par", immuneAbilities: ["limber"] };
  assert.equal(statusApplicationResult({ descriptor: toxic, targetState: state({ types: ["steel"] }), fieldState: emptyField, generation: 5 }).reason, "target-type-is-immune");
  assert.equal(statusApplicationResult({ descriptor: toxic, targetState: state({ ability: "Immunity" }), fieldState: emptyField, generation: 5 }).reason, "target-ability-is-immune");
  assert.equal(statusApplicationResult({ descriptor: thunderWave, targetState: state({ types: ["ground"] }), fieldState: emptyField, generation: 5 }).reason, "target-is-immune-to-move-type");
  assert.equal(statusApplicationResult({ descriptor: stunSpore, targetState: state({ types: ["electric"] }), fieldState: emptyField, generation: 5 }).applies, true);
  assert.equal(statusApplicationResult({ descriptor: stunSpore, targetState: state({ types: ["electric"] }), fieldState: emptyField, generation: 6 }).reason, "target-type-is-immune");
  assert.equal(statusApplicationResult({ descriptor: toxic, targetState: state({ ability: "Magic Bounce" }), fieldState: emptyField, generation: 5 }).applies, true, "reflection is resolved by the move engine after immunity checks");
});

test("deterministic Gen 5 residual rules cover poison, burn, and damaging weather", () => {
  assert.deepEqual(statusResidualRule(state({ status: "brn" }), 5), { kind: "damage", numerator: 1, denominator: 8, cause: "burn" });
  assert.deepEqual(statusResidualRule(state({ status: "tox", toxicCounter: 3 }), 5), { kind: "damage", numerator: 3, denominator: 16, cause: "bad-poison", nextToxicCounter: 4 });
  assert.equal(weatherResidualRule({ id: "sand" }, state({ types: ["rock"] })), null);
  assert.deepEqual(weatherResidualRule({ id: "sand" }, state()), { kind: "damage", numerator: 1, denominator: 16, cause: "sand" });
  assert.equal(weatherResidualRule({ id: "snow" }, state()), null, "snow does not reuse hail chip damage");
});

test("implemented ability residuals no longer fail closed while unsupported item activation still does", () => {
  const field = { global: { weather: { id: "rain" } } };
  const rainDish = state({ ability: "Rain Dish" });
  rainDish.hp.max = 80;
  assert.equal(endOfTurnSupportIssue(rainDish, field, state()), null);
  assert.match(endOfTurnSupportIssue(state({ item: "Toxic Orb" }), { global: { weather: null } }, state()), /toxicorb/i);
});
