import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { normalizePlayerCollection } from "../src/adapters/combatant_ingest.js";
import { createSharedDamageAdapter } from "../src/adapters/shared_damage_adapter.js";
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from "../src/adapters/standardized_dataset.js";
import { resolveTurn } from "../src/core/resolver.js";
import { afterDamagingMoveItemActivation, damageReductionItemActivation } from "../src/rulesets/item_rules.js";
import { fixturePlan } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadVw2rRuntime() {
  const sourceDir = path.join(here, "..", "src", "generated", "datasets", "volt-white-2r");
  const calculatorDir = path.join(here, "..", "src", "generated", "battle-mechanics");
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "dataset_manifest.json"), "utf8"));
  const mechanics = JSON.parse(fs.readFileSync(path.join(sourceDir, "battle_mechanics.json"), "utf8"));
  const documents = Object.fromEntries(REQUIRED_DATASET_SOURCES.map(file => [file, JSON.parse(fs.readFileSync(path.join(sourceDir, file), "utf8"))]));
  const dataset = createDatasetContext({ manifest, mechanics, documents });
  const sharedSandbox = {};
  vm.createContext(sharedSandbox);
  vm.runInContext(fs.readFileSync(path.join(calculatorDir, "shared_damage_calculator.js"), "utf8"), sharedSandbox);
  const window = {};
  const calcSandbox = { window, console, require: moduleName => {
    if (moduleName === "./desc") return { display: () => "" };
    throw new Error(`Unexpected browser module ${moduleName}`);
  } };
  vm.createContext(calcSandbox);
  for (const file of ["data.production.min.js", "engine.production.min.js"]) {
    vm.runInContext(fs.readFileSync(path.join(calculatorDir, "vendor", "smogon-calc-0.11.0", file), "utf8"), calcSandbox);
  }
  const runtime = sharedSandbox.SharedDamageCalculator.createFromDocuments({ gameId: dataset.gameId }, window.calc, dataset.mechanics, dataset.documents);
  assert.equal(runtime.ready, true, runtime.reason);
  return { dataset, adapter: createSharedDamageAdapter(runtime) };
}

const RESIST_MECHANICS = {
  schemaVersion: "held-item-mechanics/v1",
  sourceProfile: "fixture",
  lifecycle: "consumable",
  consumptionMethod: "eat",
  activationStatus: "modeled",
  activations: [{
    id: "reduce-super-effective-fire-damage",
    trigger: "incoming-damaging-move",
    timing: "before-damage",
    conditions: { moveTypeId: "fire", requiresSuperEffective: true, requiresHpDamage: true, blockedBySubstitute: true },
    effects: [{ kind: "damage-multiplier", numerator: 1, denominator: 2 }],
    consumeOnActivation: true
  }]
};

const AIR_BALLOON_MECHANICS = {
  schemaVersion: "held-item-mechanics/v1",
  sourceProfile: "fixture",
  lifecycle: "breakable",
  consumptionMethod: "burst",
  activationStatus: "modeled",
  activations: [{
    id: "burst-after-damaging-move",
    trigger: "after-damaging-move",
    timing: "after-damage",
    conditions: { requiresMoveDamage: true, blockedBySubstitute: false, triggersOnSubstituteDamage: true },
    effects: [{ kind: "remove-held-item" }],
    consumeOnActivation: true
  }]
};

function fixture() {
  const result = fixturePlan();
  const playerKey = result.players[0].combatantKey;
  const enemyKey = result.enemies[0].combatantKey;
  result.dataset.indexes.items.set("occaberry", { id: "occaberry", name: "Occa Berry", heldItemMechanics: RESIST_MECHANICS });
  result.dataset.indexes.moves.set("tackle", { ...result.dataset.get("moves", "tackle"), type: "fire" });
  result.plan.combatants[playerKey].moves = [{ moveId: "tackle", maxPp: 35 }];
  const root = result.plan.stateNodes[result.plan.initialStateNodeId];
  root.combatantStates[playerKey].movePp = { tackle: 35 };
  root.combatantStates[enemyKey].currentItemId = "occaberry";
  root.combatantStates[enemyKey].itemState = "held";
  return { ...result, playerKey, enemyKey };
}

function actions(playerKey, enemyKey) {
  return {
    player: { actionType: "move", actorKey: playerKey, moveId: "tackle", targetKeys: [enemyKey], mechanicActivations: [], declaredAtStateHash: "fixture" },
    enemy: { actionType: "move", actorKey: enemyKey, moveId: "tackle", targetKeys: [playerKey], mechanicActivations: [], declaredAtStateHash: "fixture" }
  };
}

test("damage-reduction item activation fails closed without modeled Dataset metadata", () => {
  const dataset = { get: () => ({ id: "occaberry", name: "Occa Berry" }) };
  assert.equal(damageReductionItemActivation({
    dataset,
    defenderState: { itemState: "held", currentItemId: "occaberry" },
    appliedDefenderItemIds: ["Occa Berry"]
  }), null);
});

test("an applied resist berry is consumed and later hits use the itemless damage range", () => {
  const { dataset, plan, playerKey, enemyKey } = fixture();
  const adapter = {
    supportsCriticalHits: false,
    calculate({ defenderState, move }) {
      const active = defenderState.itemState === "held" && defenderState.currentItemId === "occaberry";
      return active
        ? { status: "ok", damage: [20], appliedDefenderItemIds: ["occaberry"] }
        : { status: "ok", damage: [40], appliedDefenderItemIds: [] };
    }
  };
  const first = resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions: actions(playerKey, enemyKey), dataset, damageAdapter: adapter });
  assert.ok(first.length);
  for (const outcome of first) {
    const state = outcome.state.combatantStates[enemyKey];
    assert.equal(state.currentItemId, "");
    assert.equal(state.lastItemId, "occaberry");
    assert.equal(state.itemState, "consumed");
    assert.ok(outcome.events.some(event => event.eventType === "item-consumed" && event.metadata.itemId === "occaberry"));
  }
  const committed = first[0].state;
  plan.stateNodes[committed.stateNodeId] = committed;
  const second = resolveTurn({ plan, parentStateNodeId: committed.stateNodeId, actions: actions(playerKey, enemyKey), dataset, damageAdapter: adapter });
  const damage = second[0].events.find(event => event.eventType === "damage" && event.actorKey === playerKey);
  assert.deepEqual(damage.damageHp, { min: 40, max: 40 });
  assert.equal(second[0].events.some(event => event.eventType === "item-consumed" && event.metadata.itemId === "occaberry"), false);
});

test("a resist berry is retained when the calculator did not apply it", () => {
  const { dataset, plan, playerKey, enemyKey } = fixture();
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: actions(playerKey, enemyKey),
    dataset,
    damageAdapter: { supportsCriticalHits: false, calculate: () => ({ status: "ok", damage: [20], appliedDefenderItemIds: [] }) }
  });
  assert.ok(outcomes.every(outcome => outcome.state.combatantStates[enemyKey].currentItemId === "occaberry"));
});

test("Substitute absorbs the hit without consuming a resist berry", () => {
  const { dataset, plan, playerKey, enemyKey } = fixture();
  plan.stateNodes[plan.initialStateNodeId].combatantStates[enemyKey].volatileConditions.substituteHp = 25;
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: actions(playerKey, enemyKey),
    dataset,
    damageAdapter: { supportsCriticalHits: false, calculate: ({ defenderState }) => ({ status: "ok", damage: [20], appliedDefenderItemIds: defenderState.currentItemId === "occaberry" ? ["occaberry"] : [] }) }
  });
  assert.ok(outcomes.every(outcome => outcome.state.combatantStates[enemyKey].currentItemId === "occaberry"));
  assert.ok(outcomes.every(outcome => outcome.events.some(event => event.eventType === "substitute-damage" || event.eventType === "substitute-broken")));
});

test("a modeled Air Balloon bursts after direct HP damage", () => {
  const { dataset, plan, playerKey, enemyKey } = fixture();
  dataset.indexes.items.set("airballoon", { id: "airballoon", name: "Air Balloon", heldItemMechanics: AIR_BALLOON_MECHANICS });
  const target = plan.stateNodes[plan.initialStateNodeId].combatantStates[enemyKey];
  target.currentItemId = "airballoon";
  target.itemState = "held";
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: actions(playerKey, enemyKey),
    dataset,
    damageAdapter: { supportsCriticalHits: false, calculate: () => ({ status: "ok", damage: [20], appliedDefenderItemIds: [] }) }
  });
  for (const outcome of outcomes) {
    const damageIndex = outcome.events.findIndex(event => event.eventType === "damage" && event.targetKey === enemyKey);
    const balloonIndex = outcome.events.findIndex(event => event.eventType === "item-consumed" && event.metadata?.itemId === "airballoon");
    assert.ok(damageIndex >= 0 && balloonIndex > damageIndex);
    assert.equal(outcome.state.combatantStates[enemyKey].itemState, "consumed");
  }
});

test("a modeled Air Balloon bursts when a move damages its Substitute", () => {
  const { dataset, plan, playerKey, enemyKey } = fixture();
  dataset.indexes.items.set("airballoon", { id: "airballoon", name: "Air Balloon", heldItemMechanics: AIR_BALLOON_MECHANICS });
  const target = plan.stateNodes[plan.initialStateNodeId].combatantStates[enemyKey];
  target.currentItemId = "airballoon";
  target.itemState = "held";
  target.volatileConditions.substituteHp = 25;
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: actions(playerKey, enemyKey),
    dataset,
    damageAdapter: { supportsCriticalHits: false, calculate: () => ({ status: "ok", damage: [20], appliedDefenderItemIds: [] }) }
  });
  assert.ok(outcomes.every(outcome => outcome.state.combatantStates[enemyKey].itemState === "consumed"));
  assert.ok(outcomes.every(outcome => outcome.events.some(event => event.eventType === "item-consumed" && event.metadata?.itemId === "airballoon")));
});

test("after-damage removal fails closed for an unmodeled consumable", () => {
  const dataset = { get: () => ({ id: "ejectbutton", name: "Eject Button", heldItemMechanics: { ...AIR_BALLOON_MECHANICS, lifecycle: "consumable", activationStatus: "unmodeled", activations: [] } }) };
  assert.equal(afterDamagingMoveItemActivation({
    dataset,
    defenderState: { itemState: "held", currentItemId: "ejectbutton" },
    activeItemId: "ejectbutton",
    damage: 20
  }), null);
});

test("the shared Gen 5 calculator reports resist-berry application and respects Unnerve", () => {
  const { dataset, adapter } = loadVw2rRuntime();
  const buildPair = ability => normalizePlayerCollection({ collection: [
    {
      uniqueKey: `attacker-${ability || "ordinary"}`,
      speciesId: "magmar",
      species: "Magmar",
      displayName: "Magmar",
      level: 50,
      nature: "Modest",
      ability: ability || "Flame Body",
      item: null,
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      moves: ["Flamethrower"]
    },
    {
      uniqueKey: `defender-${ability || "ordinary"}`,
      speciesId: "leafeon",
      species: "Leafeon",
      displayName: "Leafeon",
      level: 50,
      nature: "Careful",
      ability: "Leaf Guard",
      item: "Occa Berry",
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      moves: ["Tackle"]
    }
  ] }, dataset);
  const calculate = (ability, removeItem = false) => {
    const [attacker, defender] = buildPair(ability);
    const attackerState = {
      currentSpeciesId: attacker.speciesId, currentLevel: attacker.level, currentAbilityId: attacker.originalAbilityId,
      currentItemId: "", itemState: "none", currentTypeIds: attacker.originalTypeIds, majorStatus: null, toxicCounter: 0,
      hp: { min: attacker.calculatedStats.hp, max: attacker.calculatedStats.hp, maxHp: attacker.calculatedStats.hp }, statStages: {}, volatileConditions: {}, calculatedStatOverrides: attacker.calculatedStats
    };
    const defenderState = {
      currentSpeciesId: defender.speciesId, currentLevel: defender.level, currentAbilityId: defender.originalAbilityId,
      currentItemId: removeItem ? "" : "occaberry", itemState: removeItem ? "consumed" : "held", currentTypeIds: defender.originalTypeIds,
      majorStatus: null, toxicCounter: 0, hp: { min: defender.calculatedStats.hp, max: defender.calculatedStats.hp, maxHp: defender.calculatedStats.hp },
      statStages: {}, volatileConditions: {}, calculatedStatOverrides: defender.calculatedStats
    };
    return adapter.calculate({ attacker, defender, attackerState, defenderState, move: dataset.get("moves", "flamethrower"), fieldState: { global: {}, sides: { player: {}, enemy: {} } } });
  };
  const resisted = calculate("");
  const itemless = calculate("", true);
  const unnerve = calculate("Unnerve");
  assert.equal(resisted.status, "ok", resisted.reason);
  assert.deepEqual(resisted.appliedDefenderItemIds, ["occaberry"]);
  assert.ok(Math.max(...resisted.damage) < Math.min(...itemless.damage));
  assert.deepEqual(unnerve.appliedDefenderItemIds, []);
  assert.deepEqual(unnerve.damage, itemless.damage);
});
