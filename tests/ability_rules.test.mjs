import assert from "node:assert/strict";
import test from "node:test";
import { createSharedDamageAdapter } from "../src/adapters/shared_damage_adapter.js";
import {
  abilityActionRule,
  abilityEndOfTurnEffect,
  abilityStatStageRule,
  abilityStatusImmunity,
  trappingAbilityBlocksSwitch
} from "../src/rulesets/ability_rules.js";

function state({ ability = "pressure", types = ["normal"], status = null, item = null, volatiles = {} } = {}) {
  return {
    currentAbilityId: ability,
    abilitySuppressed: false,
    currentTypeIds: types,
    currentItemId: item,
    itemState: item ? "held" : "none",
    majorStatus: status,
    hp: { min: 80, max: 80, maxHp: 100 },
    volatileConditions: volatiles
  };
}

test("ability stat-stage rules cover Gen 5 blockers, inversion, doubling, and drop reactions", () => {
  assert.equal(abilityStatStageRule({ targetState: state({ ability: "clearbody" }), sourceKey: "source", targetKey: "target", stat: "def", requestedDelta: -1, generation: 5 }).blockedBy, "clearbody");
  assert.equal(abilityStatStageRule({ targetState: state({ ability: "contrary" }), sourceKey: "source", targetKey: "target", stat: "atk", requestedDelta: -1, generation: 5 }).delta, 1);
  assert.equal(abilityStatStageRule({ targetState: state({ ability: "simple" }), sourceKey: "target", targetKey: "target", stat: "def", requestedDelta: 2, generation: 5 }).delta, 4);
  assert.deepEqual(abilityStatStageRule({ targetState: state({ ability: "defiant" }), sourceKey: "source", targetKey: "target", stat: "atk", requestedDelta: -1, generation: 5 }).reaction, { stat: "atk", delta: 2, cause: "defiant" });
  assert.deepEqual(abilityStatStageRule({ targetState: state({ ability: "competitive" }), sourceKey: "source", targetKey: "target", stat: "spe", requestedDelta: -1, generation: 5 }).reaction, { stat: "spa", delta: 2, cause: "competitive" });
});

test("ability status prevention and weather residual rules are state-derived", () => {
  assert.equal(abilityStatusImmunity({ state: state({ ability: "vitalspirit" }), statusId: "slp", fieldState: { global: {} } }), "vitalspirit");
  assert.equal(abilityStatusImmunity({ state: state({ ability: "leafguard" }), statusId: "brn", fieldState: { global: { weather: { id: "sun" } } } }), "leafguard");
  assert.deepEqual(abilityEndOfTurnEffect({ state: state({ ability: "solarpower" }), fieldState: { global: { weather: { id: "sun" } } } }), { kind: "damage", numerator: 1, denominator: 8, cause: "solarpower", residualOrder: 1 });
  assert.deepEqual(abilityEndOfTurnEffect({ state: state({ ability: "raindish" }), fieldState: { global: { weather: { id: "rain" } } } }), { kind: "heal", numerator: 1, denominator: 16, cause: "raindish", residualOrder: 1 });
  assert.equal(abilityEndOfTurnEffect({ state: state({ ability: "hydration", status: "brn" }), fieldState: { global: { weather: { id: "rain" } } } }).residualOrder, 5);
  assert.equal(abilityEndOfTurnEffect({ state: state({ ability: "speedboost" }), fieldState: { global: {} } }).residualOrder, 28);
  assert.equal(abilityEndOfTurnEffect({ state: state({ ability: "solarpower" }), fieldState: { global: { weather: { id: "rain" } } } }), null);
});

test("Truant and trapping abilities expose deterministic action constraints", () => {
  assert.deepEqual(abilityActionRule(state({ ability: "truant" })), { kind: "arm", cause: "truant" });
  assert.equal(abilityActionRule(state({ ability: "truant", volatiles: { truantLoafing: true } })).kind, "skip");
  assert.equal(trappingAbilityBlocksSwitch({ sourceState: state({ ability: "magnetpull" }), targetState: state({ types: ["steel"] }), fieldState: { global: {} } }), "magnetpull");
  assert.equal(trappingAbilityBlocksSwitch({ sourceState: state({ ability: "arenatrap" }), targetState: state({ types: ["flying"] }), fieldState: { global: {} } }), null);
});

test("the shared damage adapter activates a previously triggered Flash Fire boost", () => {
  let received = null;
  const adapter = createSharedDamageAdapter({
    ready: true,
    calculate(input) {
      received = input;
      return { status: "ok", damage: [10] };
    }
  });
  const combatant = side => ({
    side,
    speciesId: side === "player" ? "charmander" : "foongus",
    level: 25,
    natureId: "serious",
    gender: "M",
    ivs: {},
    evs: {},
    moves: []
  });
  const attackerState = { ...state({ ability: "flashfire", volatiles: { flashFire: true } }), currentSpeciesId: "charmeleon", statStages: {} };
  const defenderState = { ...state(), statStages: {} };
  adapter.calculate({
    attacker: combatant("player"),
    defender: combatant("enemy"),
    attackerState,
    defenderState,
    move: { id: "ember", name: "Ember", type: "fire" },
    fieldState: { global: {}, sides: { player: {}, enemy: {} } }
  });
  assert.equal(received.attacker.abilityOn, true);
  assert.equal(received.defender.abilityOn, false);
  assert.equal(received.attacker.species, "charmeleon");
});
