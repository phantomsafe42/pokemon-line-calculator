import test from "node:test";
import assert from "node:assert/strict";
import { createPlanDocument, INITIAL_ENTRY_EFFECTS_VERSION } from "../src/core/plan.js";
import { entryAbilityEffects, entryHazardEffects, isGrounded, outgoingSwitchEffects, typeEffectiveness } from "../src/rulesets/switch_rules.js";
import { fixtureDataset, fixtureDoublesPlan, fixturePlan } from "./helpers.mjs";

function state({ types = ["normal"], ability = "pressure", item = null, status = null, hp = 100, maxHp = 120, stats = { def: 100, spd: 100 }, stages = {} } = {}) {
  return {
    hp: { min: hp, max: hp, maxHp },
    hpDistribution: [{ value: hp, probability: 1 }],
    majorStatus: status,
    statStages: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...stages },
    currentStats: stats,
    currentAbilityId: ability,
    abilitySuppressed: false,
    currentItemId: item,
    itemState: item ? "held" : "none",
    currentTypeIds: types,
    volatileConditions: {}
  };
}

test("grounding and hazard rules are explicit and generation-aware", () => {
  const dataset = fixtureDataset();
  dataset.indexes.types.get("fire").weak = ["rock"];
  dataset.indexes.types.set("flying", { id: "flying", name: "Flying", weak: ["rock"], resist: [], immune: ["ground"] });
  const fieldState = {
    global: { gravityTurns: 0 },
    sides: { player: { hazards: { stealthRock: true, spikes: 3, toxicSpikes: 2, stickyWeb: true } } }
  };
  assert.equal(isGrounded(state({ types: ["flying"] }), fieldState), false);
  assert.equal(isGrounded(state({ ability: "levitate" }), fieldState), false);
  assert.equal(isGrounded(state({ ability: "levitate" }), { ...fieldState, global: { gravityTurns: 2 } }), true);
  assert.equal(typeEffectiveness(dataset, "rock", ["fire", "flying"]), 4);
  const effects = entryHazardEffects({ state: state({ types: ["fire", "flying"], maxHp: 160 }), fieldState, side: "player", dataset, generation: 5 });
  assert.deepEqual(effects.map(effect => effect.kind), ["damage"]);
  assert.equal(effects[0].amount, 80);
});

test("switch abilities expose only structured supported effects", () => {
  assert.deepEqual(outgoingSwitchEffects(state({ ability: "naturalcure", status: "brn" })), [{ kind: "clear-status", from: "brn", cause: "natural-cure" }]);
  assert.deepEqual(outgoingSwitchEffects(state({ ability: "regenerator", hp: 60, maxHp: 120 })), [{ kind: "heal", amount: 40, cause: "regenerator" }]);
  assert.deepEqual(entryAbilityEffects({ enteringState: state({ ability: "intimidate" }), opposingState: state(), generation: 5 })[0], { kind: "stat-stage", stat: "atk", delta: -1, target: "opponent", cause: "intimidate" });
  assert.equal(entryAbilityEffects({ enteringState: state({ ability: "drizzle" }), opposingState: state(), generation: 5 })[0].durationMode, "permanent");
  assert.deepEqual(
    entryAbilityEffects({ enteringState: state({ ability: "download" }), opposingState: state({ stats: { def: 80, spd: 120 } }), generation: 5 })[0],
    { kind: "stat-stage", stat: "atk", delta: 1, target: "self", cause: "download", comparison: { defense: 80, specialDefense: 120, complete: true } }
  );
});

test("Download compares modified defenses, breaks ties toward Sp. Atk, and combines Doubles opponents", () => {
  const enteringState = state({ ability: "download" });
  assert.equal(entryAbilityEffects({
    enteringState,
    opposingState: state({ stats: { def: 100, spd: 100 }, stages: { def: 1 } }),
    generation: 5
  })[0].stat, "spa");
  assert.equal(entryAbilityEffects({
    enteringState,
    opposingState: state({ stats: { def: 100, spd: 100 } }),
    generation: 5
  })[0].stat, "spa");
  const opponents = [
    state({ stats: { def: 60, spd: 100 } }),
    state({ stats: { def: 80, spd: 100 } })
  ];
  const [effect] = entryAbilityEffects({ enteringState, opposingState: opponents[0], opposingStates: opponents, generation: 5 });
  assert.equal(effect.stat, "atk");
  assert.deepEqual(effect.comparison, { defense: 140, specialDefense: 200, complete: true });
});

test("starting Intimidate applies to every opposing active slot and records root events", () => {
  const { dataset, players, enemies, plan: source } = fixtureDoublesPlan();
  players[0].originalAbilityId = "intimidate";
  const plan = createPlanDocument({
    dataset,
    trainerId: "doubles",
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: source.sourceSnapshot,
    battleFormat: "doubles",
    now: "2026-08-25T00:00:00.000Z"
  });
  const root = plan.stateNodes[plan.initialStateNodeId];
  assert.equal(plan.initialEntryEffectsVersion, INITIAL_ENTRY_EFFECTS_VERSION);
  for (const enemyKey of root.active.enemyCombatantKeys) assert.equal(root.combatantStates[enemyKey].statStages.atk, -1);
  const events = root.resolutionEventIds.map(eventId => plan.resolutionEvents[eventId]);
  assert.equal(events.filter(event => event.metadata?.cause === "intimidate" && event.eventType === "stat-stage-change").length, 2);
});

test("starting Intimidate applies in Singles before the first turn", () => {
  const { dataset, players, enemies, plan: source } = fixturePlan();
  players[0].originalAbilityId = "intimidate";
  const plan = createPlanDocument({
    dataset,
    trainerId: "trainer",
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: source.sourceSnapshot,
    now: "2026-08-25T00:00:00.000Z"
  });
  const root = plan.stateNodes[plan.initialStateNodeId];
  assert.equal(root.combatantStates[root.active.enemyCombatantKey].statStages.atk, -1);
});

test("starting Download applies once in Singles using the opposing active stats", () => {
  const { dataset, players, enemies, plan: source } = fixturePlan();
  players[0].originalAbilityId = "download";
  enemies[0].calculatedStats.def = 80;
  enemies[0].calculatedStats.spd = 120;
  const plan = createPlanDocument({
    dataset,
    trainerId: "trainer",
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: source.sourceSnapshot,
    now: "2026-08-25T00:00:00.000Z"
  });
  const root = plan.stateNodes[plan.initialStateNodeId];
  const playerKey = root.active.playerCombatantKey;
  assert.equal(root.combatantStates[playerKey].statStages.atk, 1);
  const events = root.resolutionEventIds.map(eventId => plan.resolutionEvents[eventId]);
  assert.equal(events.filter(event => event.metadata?.cause === "download").length, 1);
});

test("starting Download applies once in Doubles using both opposing active stats", () => {
  const { dataset, players, enemies, plan: source } = fixtureDoublesPlan();
  players[0].originalAbilityId = "download";
  enemies[0].calculatedStats.def = 60;
  enemies[0].calculatedStats.spd = 100;
  enemies[1].calculatedStats.def = 80;
  enemies[1].calculatedStats.spd = 100;
  const plan = createPlanDocument({
    dataset,
    trainerId: "doubles",
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: source.sourceSnapshot,
    battleFormat: "doubles",
    now: "2026-08-25T00:00:00.000Z"
  });
  const root = plan.stateNodes[plan.initialStateNodeId];
  const playerKey = root.active.playerCombatantKeys[0];
  assert.equal(root.combatantStates[playerKey].statStages.atk, 1);
  const events = root.resolutionEventIds.map(eventId => plan.resolutionEvents[eventId]);
  assert.equal(events.filter(event => event.actorKey === playerKey && event.metadata?.cause === "download").length, 1);
});
