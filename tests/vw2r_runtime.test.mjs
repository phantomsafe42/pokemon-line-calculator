import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { normalizePlayerCollection, normalizeTrainerRoster, snapshotFingerprint } from "../src/adapters/combatant_ingest.js";
import { createSharedDamageAdapter } from "../src/adapters/shared_damage_adapter.js";
import { pokemonAssetAppearanceId, pokemonAssetQuery } from "../src/adapters/pokemon_assets.js";
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from "../src/adapters/standardized_dataset.js";
import { createPlanDocument } from "../src/core/plan.js";
import { previewTurn } from "../src/core/planner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.join(here, "..", "src", "generated", "datasets", "volt-white-2r");
const calculatorDir = path.join(here, "..", "src", "generated", "battle-mechanics");

function loadSharedDamageCalculator() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(calculatorDir, "shared_damage_calculator.js"), "utf8"),
    sandbox,
    { filename: "shared_damage_calculator.js" }
  );
  return sandbox.SharedDamageCalculator;
}

const SharedDamageCalculator = loadSharedDamageCalculator();

function loadCalcEngine() {
  const window = {};
  const sandbox = {
    window,
    console,
    require(moduleName) {
      if (moduleName === "./desc") return { display: () => "" };
      throw new Error(`Unexpected browser module ${moduleName}`);
    }
  };
  vm.createContext(sandbox);
  for (const file of ["data.production.min.js", "engine.production.min.js"]) {
    vm.runInContext(fs.readFileSync(path.join(calculatorDir, "vendor", "smogon-calc-0.11.0", file), "utf8"), sandbox, { filename: file });
  }
  return window.calc;
}

function loadVw2rDataset() {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "dataset_manifest.json"), "utf8"));
  const mechanics = JSON.parse(fs.readFileSync(path.join(sourceDir, "battle_mechanics.json"), "utf8"));
  const documents = Object.fromEntries(REQUIRED_DATASET_SOURCES.map(file => [file, JSON.parse(fs.readFileSync(path.join(sourceDir, file), "utf8"))]));
  return createDatasetContext({ manifest, mechanics, documents });
}

test("VW2R form sprites use the centralized asset resolver's canonical appearance IDs", () => {
  const dataset = loadVw2rDataset();
  const record = { speciesId: "keldeoresolute", formId: "keldeoresolute", displayName: "Keldeo - Resolute" };
  assert.equal(pokemonAssetAppearanceId(record, dataset), "keldeo-resolute");
  assert.equal(pokemonAssetQuery(record, dataset).spriteType, "g5-animated");
  assert.equal(pokemonAssetAppearanceId({ speciesId: "keldeo", formId: "keldeoresolute" }, dataset), "keldeo-resolute");
  assert.equal(pokemonAssetAppearanceId({ speciesId: "charmeleon", formId: "charmander" }, dataset), "charmeleon");
  assert.equal(pokemonAssetAppearanceId({ speciesId: "nidoranf" }, dataset), "nidoranf");
  assert.equal(pokemonAssetAppearanceId({ speciesId: "mrmime" }, dataset), "mrmime");
});

test("VW2R Dataset baseExp values normalize for every School Kid Neil combatant", () => {
  const dataset = loadVw2rDataset();
  const enemies = normalizeTrainerRoster("vw2r-trainer-0050", null, dataset);
  assert.equal(dataset.trainer("vw2r-trainer-0050").displayName, "School Kid Neil");
  assert.deepEqual(enemies.map(mon => [mon.speciesId, mon.level, mon.baseExperienceYield]), [
    ["swellow", 25, 151],
    ["onix", 25, 77],
    ["quagsire", 25, 151],
    ["mrmime", 25, 161]
  ]);
  assert.ok(enemies.every(mon => mon.baseExperienceYield === dataset.get("species", mon.speciesId).baseExp));
});

test("VW2R trainer navigation matches the ten canonical progression splits", () => {
  const groups = loadVw2rDataset().trainerGroups();
  assert.equal(groups.length, 10);
  assert.equal(groups.flatMap(group => group.trainers).length, 426);
  assert.deepEqual(groups.map(group => group.label), [
    "Cheren Split", "Roxie Split", "Burgh Split", "Elesa Split", "Clay Split",
    "Skyla Split", "Drayden Split", "Marlon Split", "Ghetsis Split", "Champion Split"
  ]);
  const burgh = groups.find(group => group.id === "burgh");
  assert.equal(burgh.trainers.find(trainer => trainer.id === "vw2r-trainer-0050")?.displayName, "School Kid Neil");
  assert.deepEqual(burgh.trainers.slice(0, 3).map(trainer => trainer.id), ["vw2r-trainer-0039", "vw2r-trainer-0040", "vw2r-trainer-0041"]);
});

test("temporary Lenora and Hawes pairing preserves source records and leads", () => {
  const dataset = loadVw2rDataset();
  const id = "vw2r-lenora-hawes-double";
  assert.equal(dataset.trainerBattleFormat(id), "doubles");
  assert.deepEqual(normalizeTrainerRoster(id, null, dataset).map(mon => mon.speciesId), ["stoutland", "gigalith", "unfezant", "machamp"]);
  assert.equal(dataset.documents["trainers.json"].records["vw2r-trainer-0095"].battleProfiles.challenge.format, "single");
  assert.equal(dataset.trainerGroups().find(group => group.id === "elesa").trainers.filter(trainer => trainer.id === id).length, 1);
});

test("VW2R standardized sources drive a complete PLC move preview through the shared calculator", () => {
  const dataset = loadVw2rDataset();
  const runtime = SharedDamageCalculator.createFromDocuments({ gameId: dataset.gameId }, loadCalcEngine(), dataset.mechanics, dataset.documents);
  assert.equal(runtime.ready, true, runtime.reason);

  const players = normalizePlayerCollection({ party: [{
    uniqueKey: "portable-keldeo-fixture",
    speciesId: "keldeo",
    species: "Keldeo - Ordinary",
    displayName: "Keldeo - Ordinary",
    level: 5,
    nature: "Hardy",
    ability: "Justified",
    item: null,
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    moves: ["Tackle"]
  }, {
    uniqueKey: "hidden-power-target",
    speciesId: "onix",
    species: "Onix",
    displayName: "Onix",
    level: 25,
    nature: "Hardy",
    ability: "Sturdy",
    item: null,
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    moves: ["Tackle"]
  }] }, dataset);
  const enemies = normalizeTrainerRoster("vw2r-trainer-0001", null, dataset);
  const plan = createPlanDocument({
    dataset,
    trainerId: "vw2r-trainer-0001",
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: snapshotFingerprint(players, enemies, "fixture")
  });
  const actions = {
    player: { actionType: "move", actorKey: players[0].combatantKey, moveId: "tackle", targetKeys: [enemies[0].combatantKey], mechanicActivations: [], declaredAtStateHash: plan.stateNodes[plan.initialStateNodeId].stateHash },
    enemy: { actionType: "move", actorKey: enemies[0].combatantKey, moveId: "tackle", targetKeys: [players[0].combatantKey], mechanicActivations: [], declaredAtStateHash: plan.stateNodes[plan.initialStateNodeId].stateHash }
  };
  const damageAdapter = createSharedDamageAdapter(runtime);
  const root = plan.stateNodes[plan.initialStateNodeId];
  const direct = damageAdapter.calculate({
    attacker: players[0],
    defender: enemies[0],
    attackerState: root.combatantStates[players[0].combatantKey],
    defenderState: root.combatantStates[enemies[0].combatantKey],
    move: dataset.get("moves", "tackle"),
    fieldState: root.fieldState
  });
  assert.equal(direct.status, "ok", direct.error?.stack || direct.reason);
  const hiddenPower = dataset.get("moves", "hiddenpower");
  const hiddenPowerFire = damageAdapter.calculate({
    attacker: players[0], defender: players[1],
    attackerState: root.combatantStates[players[0].combatantKey],
    defenderState: root.combatantStates[players[1].combatantKey],
    move: { ...hiddenPower, type: "fire" }, fieldState: root.fieldState
  });
  const hiddenPowerWater = damageAdapter.calculate({
    attacker: players[0], defender: players[1],
    attackerState: root.combatantStates[players[0].combatantKey],
    defenderState: root.combatantStates[players[1].combatantKey],
    move: { ...hiddenPower, type: "water" }, fieldState: root.fieldState
  });
  assert.equal(hiddenPowerFire.status, "ok", hiddenPowerFire.reason);
  assert.equal(hiddenPowerWater.status, "ok", hiddenPowerWater.reason);
  assert.ok(hiddenPowerWater.minPercent > hiddenPowerFire.maxPercent, "typed Hidden Power selects the matching shared-calculator variant");
  const revengeMove = dataset.get("moves", "revenge");
  const revengeBase = damageAdapter.calculate({
    attacker: players[0], defender: enemies[0],
    attackerState: root.combatantStates[players[0].combatantKey],
    defenderState: root.combatantStates[enemies[0].combatantKey],
    move: revengeMove, fieldState: root.fieldState, moveOverrides: { basePower: 60 }
  });
  const revengeDoubled = damageAdapter.calculate({
    attacker: players[0], defender: enemies[0],
    attackerState: root.combatantStates[players[0].combatantKey],
    defenderState: root.combatantStates[enemies[0].combatantKey],
    move: revengeMove, fieldState: root.fieldState, moveOverrides: { basePower: 120 }
  });
  assert.equal(revengeBase.status, "ok", revengeBase.reason);
  assert.equal(revengeDoubled.status, "ok", revengeDoubled.reason);
  assert.ok(revengeDoubled.minPercent > revengeBase.minPercent, "VW2R Revenge uses the resolver-selected effective power");
  const surfMove = dataset.get("moves", "surf");
  const clearSurf = damageAdapter.calculate({
    attacker: players[0], defender: enemies[0],
    attackerState: root.combatantStates[players[0].combatantKey],
    defenderState: root.combatantStates[enemies[0].combatantKey],
    move: surfMove, fieldState: root.fieldState
  });
  const rainField = structuredClone(root.fieldState);
  rainField.global.weather = { id: "rain", source: "fixture", durationMode: "turns", remainingTurns: 4 };
  const rainSurf = damageAdapter.calculate({
    attacker: players[0], defender: enemies[0],
    attackerState: root.combatantStates[players[0].combatantKey],
    defenderState: root.combatantStates[enemies[0].combatantKey],
    move: surfMove, fieldState: rainField
  });
  assert.equal(clearSurf.status, "ok", clearSurf.reason);
  assert.equal(rainSurf.status, "ok", rainSurf.reason);
  assert.ok(rainSurf.minPercent > clearSurf.minPercent, "normalized PLC rain reaches the real VW2R damage calculation");
  const doublesSurf = damageAdapter.calculate({
    attacker: players[0], defender: enemies[0],
    attackerState: root.combatantStates[players[0].combatantKey],
    defenderState: root.combatantStates[enemies[0].combatantKey],
    move: surfMove, fieldState: root.fieldState, battleFormat: "doubles"
  });
  assert.equal(doublesSurf.status, "ok", doublesSurf.reason);
  assert.ok(doublesSurf.maxPercent < clearSurf.maxPercent, "VW2R Doubles Surf receives the shared calculator spread modifier");
  const preview = previewTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions, dataset, damageAdapter });
  assert.equal(preview.previewStatus, "ready");
  assert.ok(preview.outcomes.length >= 1);
  assert.ok(preview.outcomes.every(outcome => outcome.events.some(event => event.eventType === "damage")));
});

test("VW2R Burgh Hurricane has distinct exact normal and critical damage", () => {
  const dataset = loadVw2rDataset();
  const runtime = SharedDamageCalculator.createFromDocuments({ gameId: dataset.gameId }, loadCalcEngine(), dataset.mechanics, dataset.documents);
  const damageAdapter = createSharedDamageAdapter(runtime);
  const players = normalizePlayerCollection({ party: [
    {
      uniqueKey: "critical-fixture-clefable",
      speciesId: "clefable",
      species: "Clefable",
      displayName: "Clefable",
      level: 25,
      nature: "Hardy",
      ability: "Cute Charm",
      item: null,
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      moves: ["Moonlight"]
    },
    {
      uniqueKey: "critical-fixture-golduck",
      speciesId: "golduck",
      species: "Golduck",
      displayName: "dukdukgoat",
      level: 25,
      nature: "Timid",
      ability: "Drizzle",
      item: null,
      ivs: { hp: 15, atk: 0, def: 23, spa: 29, spd: 26, spe: 8 },
      evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      moves: ["Weather Ball", "Hurricane", "Thunder", "Bubble Beam"]
    }
  ] }, dataset);
  const enemies = normalizeTrainerRoster("vw2r-trainer-0073", null, dataset);
  const plan = createPlanDocument({
    dataset,
    trainerId: "vw2r-trainer-0073",
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: snapshotFingerprint(players, enemies, "critical-fixture")
  });
  const golduck = players.find(mon => mon.speciesId === "golduck");
  const mothim = enemies.find(mon => mon.speciesId === "mothim");
  const root = plan.stateNodes[plan.initialStateNodeId];
  const request = {
    attacker: golduck,
    defender: mothim,
    attackerState: root.combatantStates[golduck.combatantKey],
    defenderState: root.combatantStates[mothim.combatantKey],
    move: dataset.get("moves", "hurricane"),
    fieldState: root.fieldState,
    battleFormat: "doubles"
  };
  const normal = damageAdapter.calculate({ ...request, criticalHit: false });
  const critical = damageAdapter.calculate({ ...request, criticalHit: true });
  assert.equal(normal.status, "ok", normal.reason);
  assert.equal(critical.status, "ok", critical.reason);
  assert.equal(normal.criticalHit, false);
  assert.equal(critical.criticalHit, true);
  assert.deepEqual([Math.min(...normal.damage), Math.max(...normal.damage)], [66, 78]);
  assert.ok(Math.min(...critical.damage) >= root.combatantStates[mothim.combatantKey].hp.max, "every critical Hurricane roll KOs Burgh's full-HP Mothim");
});
