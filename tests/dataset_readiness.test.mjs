import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDatasetContext,
  DatasetReadinessError,
  REQUIRED_DATASET_SOURCES
} from "../src/adapters/standardized_dataset.js";
import { projectExperience } from "../src/rulesets/vw2r_experience.js";

const GENERATED_DATASETS_ROOT = fileURLToPath(new URL("../src/generated/datasets/", import.meta.url));
const RETAIL_GAME_IDS = [
  "pokemon-ruby", "pokemon-sapphire", "pokemon-emerald", "pokemon-firered", "pokemon-leafgreen",
  "pokemon-diamond", "pokemon-pearl", "pokemon-platinum", "pokemon-heartgold", "pokemon-soulsilver",
  "pokemon-black", "pokemon-white", "pokemon-black-2", "pokemon-white-2"
];

function readGenerated(gameId, file) {
  return JSON.parse(fs.readFileSync(path.join(GENERATED_DATASETS_ROOT, gameId, file), "utf8"));
}

function generatedInputs(gameId = "pokemon-black") {
  return {
    manifest: readGenerated(gameId, "dataset_manifest.json"),
    mechanics: readGenerated(gameId, "battle_mechanics.json"),
    documents: Object.fromEntries(REQUIRED_DATASET_SOURCES.map(file => [file, readGenerated(gameId, file)]))
  };
}

test("all retail Gen 3 through 5 datasets load with battle and EXP consumer readiness", () => {
  for (const gameId of RETAIL_GAME_IDS) {
    const context = createDatasetContext(generatedInputs(gameId));
    assert.equal(context.capabilities.battleSourceReady, true, gameId);
    assert.equal(context.capabilities.calculationReady, true, gameId);
    assert.equal(context.capabilities.experienceProjectionReady, true, gameId);
    if (context.mechanics.damageGeneration === 5) assert.equal(context.experienceMechanics.schemaVersion, 2, gameId);
  }
});

test("retail trainer navigation uses canonical progression names instead of split IDs", () => {
  for (const gameId of RETAIL_GAME_IDS) {
    const context = createDatasetContext(generatedInputs(gameId));
    const progression = readGenerated(gameId, "progression.json");
    const records = Array.isArray(progression.records) ? progression.records : Object.values(progression.records || {});
    const namesById = new Map(records.filter(record => record?.id && record?.name).map(record => [String(record.id), String(record.name)]));
    for (const group of context.trainerGroups()) {
      assert.doesNotMatch(group.label, /^[a-z]/, `${gameId}:${group.id}`);
      assert.doesNotMatch(group.label, /\bSplit Split$/i, `${gameId}:${group.id}`);
      const name = namesById.get(group.id);
      if (!name) continue;
      const expected = /\s+split$/i.test(name) ? name : `${name} Split`;
      assert.equal(group.label, expected, `${gameId}:${group.id}`);
    }
  }
});

test("each retail Dataset EXP contract executes the generation-correct equal-level trainer projection", () => {
  const plan = {
    combatants: {
      player: { combatantKey: "player", side: "player", level: 50, growthRate: "Medium Fast", experience: 125000 },
      enemy: { combatantKey: "enemy", side: "enemy", level: 50, baseExperienceYield: 100 }
    }
  };
  const state = {
    combatantStates: {
      player: { hp: { min: 100, max: 100, maxHp: 100 }, currentLevel: 50, currentItemId: null, experience: 125000 },
      enemy: { hp: { min: 0, max: 0, maxHp: 100 }, currentLevel: 50, currentItemId: null }
    },
    experienceState: { participantsByEnemyKey: { enemy: ["player"] }, rewardedEnemyKeys: [] }
  };
  for (const gameId of RETAIL_GAME_IDS) {
    const context = createDatasetContext(generatedInputs(gameId));
    const projection = projectExperience(plan, state, "enemy", context);
    const expected = context.experienceMechanics.experienceGeneration === 5 ? 1501 : 1071;
    assert.equal(projection.available, true, gameId);
    assert.equal(projection.rewards[0]?.amount, expected, gameId);
  }
});

test("a narrow consumer gate does not disable otherwise source-ready game data", () => {
  const inputs = structuredClone(generatedInputs());
  inputs.mechanics.validation.status = "blocked";
  inputs.mechanics.validation.unresolved = 1;
  inputs.mechanics.gateOwnership.consumer.unresolved = 1;
  inputs.mechanics.gateOwnership.consumer.records = [{ category: "consumer-runtime", recordId: "one-edge-path" }];
  inputs.mechanics.consumerActivation.calculationReady = false;
  const context = createDatasetContext(inputs);
  assert.equal(context.capabilities.battleSourceReady, true);
  assert.equal(context.capabilities.calculationReady, false);
  assert.equal(context.capabilities.consumerGates.length, 1);
});

test("an inactive EXP projection remains available as source data but advertises its own gate", () => {
  const inputs = structuredClone(generatedInputs());
  inputs.documents["experience_mechanics.json"].consumerActivation.experienceProjectionReady = false;
  const context = createDatasetContext(inputs);
  assert.equal(context.capabilities.battleSourceReady, true);
  assert.equal(context.capabilities.experienceProjectionReady, false);
});

test("unresolved Dataset-owned battle source fields still fail closed", () => {
  const inputs = structuredClone(generatedInputs());
  inputs.mechanics.validation.status = "blocked";
  inputs.mechanics.validation.unresolved = 1;
  inputs.mechanics.sourceReadiness.unresolved = 1;
  inputs.mechanics.gateOwnership.dataset.unresolved = 1;
  assert.throws(() => createDatasetContext(inputs), DatasetReadinessError);
});
