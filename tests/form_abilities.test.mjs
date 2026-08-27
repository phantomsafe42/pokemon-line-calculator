import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizePlayerCollection, snapshotFingerprint } from "../src/adapters/combatant_ingest.js";
import { createSharedDamageAdapter } from "../src/adapters/shared_damage_adapter.js";
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from "../src/adapters/standardized_dataset.js";
import { createPlanDocument, upgradeInitialEntryEffects } from "../src/core/plan.js";
import { resolveTurn } from "../src/core/resolver.js";
import { createBranchEventModel } from "../src/core/branch_events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.join(here, "..", "src", "generated", "datasets", "volt-white-2r");
const all31 = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

function loadDataset() {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "dataset_manifest.json"), "utf8"));
  const mechanics = JSON.parse(fs.readFileSync(path.join(sourceDir, "battle_mechanics.json"), "utf8"));
  const documents = Object.fromEntries(REQUIRED_DATASET_SOURCES.map(file => [file, JSON.parse(fs.readFileSync(path.join(sourceDir, file), "utf8"))]));
  return createDatasetContext({ manifest, mechanics, documents });
}

function combatant(dataset, { side, key, speciesId, abilityId, moves, level = 50 }) {
  const [record] = normalizePlayerCollection({
    collection: [{
      uniqueKey: key,
      speciesId,
      displayName: dataset.get("species", speciesId).name,
      level,
      nature: "Hardy",
      ability: abilityId,
      item: null,
      ivs: all31,
      moves,
      storage: "party",
      slot: 1
    }]
  }, dataset);
  record.combatantKey = `${side}:${key}`;
  record.side = side;
  record.source = { kind: "manual", trainerId: null, trainerVariantId: null, trainerSlot: 1 };
  return record;
}

function createAbilityPlan({ dataset, players, enemies, battleFormat = "singles", initialConditions = {} }) {
  const sourceSnapshot = snapshotFingerprint(players, enemies, "2026-08-27T00:00:00.000Z");
  return createPlanDocument({
    dataset,
    trainerId: "ability-fixture",
    playerCombatants: players,
    enemyCombatants: enemies,
    playerActiveKeys: players.map(record => record.combatantKey),
    enemyActiveKeys: enemies.map(record => record.combatantKey),
    battleFormat,
    sourceSnapshot,
    initialConditions,
    now: "2026-08-27T00:00:00.000Z"
  });
}

function move(actorKey, moveId, stateHash, targetKeys = []) {
  return { actionType: "move", actorKey, moveId, targetKeys, mechanicActivations: [], declaredAtStateHash: stateHash };
}

const noDamage = { calculate: () => ({ status: "ok", damage: [1] }) };

test("multi-active Trace branches equally across eligible adjacent foes and activates the copied entry Ability", () => {
  const dataset = loadDataset();
  const players = [
    combatant(dataset, { side: "player", key: "trace", speciesId: "clefairy", abilityId: "trace", moves: ["protect"] }),
    combatant(dataset, { side: "player", key: "ally", speciesId: "golduck", abilityId: "cloudnine", moves: ["protect"] })
  ];
  const enemies = [
    combatant(dataset, { side: "enemy", key: "intimidate", speciesId: "mightyena", abilityId: "intimidate", moves: ["protect"] }),
    combatant(dataset, { side: "enemy", key: "pressure", speciesId: "dusclops", abilityId: "pressure", moves: ["protect"] })
  ];
  const plan = createAbilityPlan({ dataset, players, enemies, battleFormat: "doubles" });
  const root = plan.stateNodes[plan.initialStateNodeId];
  const actions = {
    player: players.map(record => move(record.combatantKey, "protect", root.stateHash)),
    enemy: enemies.map(record => move(record.combatantKey, "protect", root.stateHash))
  };
  const outcomes = resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions, dataset, damageAdapter: noDamage });
  const byAbility = new Map(outcomes.map(outcome => [outcome.state.combatantStates[players[0].combatantKey].currentAbilityId, outcome]));
  assert.deepEqual([...byAbility.keys()].sort(), ["intimidate", "pressure"]);
  assert.equal(byAbility.get("intimidate").outcome.probability, 0.5);
  assert.equal(byAbility.get("pressure").outcome.probability, 0.5);
  for (const enemy of enemies) {
    assert.equal(byAbility.get("intimidate").state.combatantStates[enemy.combatantKey].statStages.atk, -1);
    assert.equal(byAbility.get("pressure").state.combatantStates[enemy.combatantKey].statStages.atk, 0);
  }
  assert.equal(byAbility.get("intimidate").events.some(event => event.metadata?.cause === "trace" && event.metadata?.copiedFromKey === enemies[0].combatantKey), true);
  const branchEvents = createBranchEventModel({ outcomes, actions, defaultOutcomeId: outcomes[0].previewOutcomeId });
  const traceChoice = branchEvents.dimensions.find(dimension => dimension.kind === "trace");
  assert.deepEqual(traceChoice.options.map(option => option.label).sort(), ["Copied Intimidate", "Copied Pressure"]);
});

test("form-state upgrade preserves already-applied initial entry effects", () => {
  const dataset = loadDataset();
  const player = combatant(dataset, { side: "player", key: "player", speciesId: "clefairy", abilityId: "cutecharm", moves: ["protect"] });
  const enemy = combatant(dataset, { side: "enemy", key: "enemy", speciesId: "mightyena", abilityId: "intimidate", moves: ["protect"] });
  const plan = createAbilityPlan({ dataset, players: [player], enemies: [enemy] });
  const root = plan.stateNodes[plan.initialStateNodeId];
  assert.equal(root.combatantStates[player.combatantKey].statStages.atk, -1);
  delete plan.initialAbilityFormStateVersion;
  const upgraded = upgradeInitialEntryEffects(plan, dataset);
  const upgradedRoot = upgraded.plan.stateNodes[upgraded.plan.initialStateNodeId];
  assert.equal(upgraded.changed, true);
  assert.equal(upgradedRoot.combatantStates[player.combatantKey].statStages.atk, -1);
  assert.equal(upgradedRoot.resolutionEventIds.map(eventId => upgraded.plan.resolutionEvents[eventId]).filter(event => event.metadata?.cause === "intimidate").length, 1);
});

test("a Trace switch-in branches during the switch action and keeps the copied Ability on the incoming Pokemon", () => {
  const dataset = loadDataset();
  const players = [
    combatant(dataset, { side: "player", key: "lead", speciesId: "golduck", abilityId: "cloudnine", moves: ["protect"] }),
    combatant(dataset, { side: "player", key: "ally", speciesId: "bellossom", abilityId: "chlorophyll", moves: ["protect"] }),
    combatant(dataset, { side: "player", key: "trace-bench", speciesId: "clefairy", abilityId: "trace", moves: ["protect"] })
  ];
  const enemies = [
    combatant(dataset, { side: "enemy", key: "enemy-a", speciesId: "mightyena", abilityId: "intimidate", moves: ["protect"] }),
    combatant(dataset, { side: "enemy", key: "enemy-b", speciesId: "dusclops", abilityId: "pressure", moves: ["protect"] })
  ];
  const plan = createAbilityPlan({ dataset, players, enemies, battleFormat: "doubles" });
  const root = plan.stateNodes[plan.initialStateNodeId];
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: {
      player: [
        { actionType: "switch", actorKey: players[0].combatantKey, switchToKey: players[2].combatantKey, switchKind: "voluntary", declaredAtStateHash: root.stateHash },
        move(players[1].combatantKey, "protect", root.stateHash)
      ],
      enemy: enemies.map(record => move(record.combatantKey, "protect", root.stateHash))
    },
    dataset,
    damageAdapter: noDamage
  });
  assert.deepEqual([...new Set(outcomes.map(outcome => outcome.state.combatantStates[players[2].combatantKey].currentAbilityId))].sort(), ["intimidate", "pressure"]);
  assert.equal(outcomes.every(outcome => outcome.state.active.playerCombatantKeys.includes(players[2].combatantKey)), true);
});

test("Forecast changes Castform species, type, stats, and sprite as soon as a weather move resolves", () => {
  const dataset = loadDataset();
  const player = combatant(dataset, { side: "player", key: "castform", speciesId: "castform", abilityId: "forecast", moves: ["sunnyday"] });
  const enemy = combatant(dataset, { side: "enemy", key: "enemy", speciesId: "audino", abilityId: "regenerator", moves: ["protect"] });
  const plan = createAbilityPlan({ dataset, players: [player], enemies: [enemy] });
  const root = plan.stateNodes[plan.initialStateNodeId];
  assert.equal(root.combatantStates[player.combatantKey].currentSpeciesId, "castform");
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: {
      player: [move(player.combatantKey, "sunnyday", root.stateHash)],
      enemy: [move(enemy.combatantKey, "protect", root.stateHash)]
    },
    dataset,
    damageAdapter: noDamage
  });
  assert.equal(outcomes.length, 1);
  const state = outcomes[0].state.combatantStates[player.combatantKey];
  assert.equal(state.currentSpeciesId, "castformsunny");
  assert.equal(state.currentSpriteId, "castformsunny");
  assert.deepEqual(state.currentTypeIds, ["fire"]);
  assert.deepEqual(state.currentStats, state.calculatedStatOverrides);
  assert.equal(outcomes[0].events.some(event => event.eventType === "form-change" && event.metadata?.cause === "forecast"), true);
});

test("Flower Gift changes Cherrim's weather form and exposes its active side aura to the shared damage contract", () => {
  const dataset = loadDataset();
  const cherrim = combatant(dataset, { side: "player", key: "cherrim", speciesId: "cherrim", abilityId: "flowergift", moves: ["protect"] });
  const ally = combatant(dataset, { side: "player", key: "ally", speciesId: "bellossom", abilityId: "chlorophyll", moves: ["protect"] });
  const enemies = [
    combatant(dataset, { side: "enemy", key: "enemy-a", speciesId: "audino", abilityId: "regenerator", moves: ["protect"] }),
    combatant(dataset, { side: "enemy", key: "enemy-b", speciesId: "dusclops", abilityId: "pressure", moves: ["protect"] })
  ];
  const plan = createAbilityPlan({
    dataset,
    players: [cherrim, ally],
    enemies,
    battleFormat: "doubles",
    initialConditions: { weather: { id: "sun", source: "manual", durationMode: "permanent" } }
  });
  const root = plan.stateNodes[plan.initialStateNodeId];
  assert.equal(root.combatantStates[cherrim.combatantKey].currentSpriteId, "cherrim-sunshine");
  assert.equal(root.fieldState.sides.player.isFlowerGift, true);
  let received = null;
  const adapter = createSharedDamageAdapter({
    ready: true,
    calculate(input) {
      received = input;
      return { status: "ok", damage: [1] };
    }
  });
  adapter.calculate({
    attacker: ally,
    defender: enemies[0],
    attackerState: root.combatantStates[ally.combatantKey],
    defenderState: root.combatantStates[enemies[0].combatantKey],
    move: dataset.get("moves", "tackle"),
    fieldState: root.fieldState,
    battleFormat: "doubles"
  });
  assert.equal(received.attackerFieldState.isFlowerGift, true);
});

test("Zen Mode branches an uncertain half-HP distribution at residual order 29 and updates Darmanitan's full form state", () => {
  const dataset = loadDataset();
  const player = combatant(dataset, { side: "player", key: "darmanitan", speciesId: "darmanitan", abilityId: "zenmode", moves: ["protect"] });
  const enemy = combatant(dataset, { side: "enemy", key: "enemy", speciesId: "audino", abilityId: "regenerator", moves: ["protect"] });
  const plan = createAbilityPlan({ dataset, players: [player], enemies: [enemy] });
  const root = plan.stateNodes[plan.initialStateNodeId];
  const playerState = root.combatantStates[player.combatantKey];
  const lower = Math.floor(playerState.hp.maxHp / 2);
  const upper = lower + 1;
  playerState.hp = { min: lower, max: upper, maxHp: playerState.hp.maxHp };
  playerState.hpDistribution = [{ value: lower, probability: 0.4 }, { value: upper, probability: 0.6 }];
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: {
      player: [move(player.combatantKey, "protect", root.stateHash)],
      enemy: [move(enemy.combatantKey, "protect", root.stateHash)]
    },
    dataset,
    damageAdapter: noDamage
  });
  const bySpecies = new Map(outcomes.map(outcome => [outcome.state.combatantStates[player.combatantKey].currentSpeciesId, outcome]));
  assert.deepEqual([...bySpecies.keys()].sort(), ["darmanitan", "darmanitanzen"]);
  assert.equal(bySpecies.get("darmanitanzen").outcome.probability, 0.4);
  assert.equal(bySpecies.get("darmanitan").outcome.probability, 0.6);
  assert.deepEqual(bySpecies.get("darmanitanzen").state.combatantStates[player.combatantKey].currentTypeIds, ["fire", "psychic"]);
  assert.equal(bySpecies.get("darmanitanzen").events.some(event => event.eventType === "form-change" && event.metadata?.cause === "zenmode"), true);
});
