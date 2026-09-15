import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadTrainerAiBootstrap, loadTrainerAiDocumentation, TrainerAiReadinessError } from "../src/adapters/trainer_ai.js";

const generatedTrainerAiRoot = fileURLToPath(new URL("../src/generated/trainer-ai/", import.meta.url));

async function generatedTrainerAiFetch(url) {
  const relative = new URL(url).pathname.replace(/^.*\/trainer-ai\//u, "");
  const file = path.join(generatedTrainerAiRoot, ...relative.split("/"));
  return {
    ok: fs.existsSync(file),
    status: fs.existsSync(file) ? 200 : 404,
    json: async () => JSON.parse(fs.readFileSync(file, "utf8"))
  };
}

function bootstrapDocument(overrides = {}) {
  return {
    schemaVersion: "plc-trainer-ai-bootstrap/v1",
    consumerProfileId: "plc",
    abilityKnowledgeProfiles: {
      "gen5-test": { modelId: "gen5-test", generation: 5, storage: { onSwitch: "retain" } }
    },
    games: [{
      gameId: "volt-white-2r",
      generation: 5,
      consumerActivation: { enabled: true, failClosed: true },
      profiles: {
        gameProfileId: "vw2r-test",
        inheritedProfileId: "gen5-test-profile",
        sharedProfileId: "gen5-test-profile",
        evaluatorProfileId: "gen5-test-evaluator"
      },
      evaluatorReadiness: { status: "exact", exactActionProbabilities: true },
      abilityKnowledgeModelId: "gen5-test",
      activeAiFlags: [{ id: "flag1", title: "Evaluate", summary: "Scores moves.", order: 1, readiness: "exact" }],
      lazyResources: {
        gameTrainerAiPath: "trainer-ai/volt-white-2r/trainer_ai.json",
        sharedTrainerAiPath: "trainer-ai/gen5/trainer_ai.json",
        evaluatorJsonPointer: "#/evaluator",
        engineSemanticsPath: "trainer-ai/gen5/trainer_ai_engine_semantics.json"
      }
    }],
    sourceFiles: [],
    ...overrides
  };
}

function directFetch(document) {
  return async url => ({
    ok: String(url).endsWith("/bootstrap.json"),
    status: String(url).endsWith("/bootstrap.json") ? 200 : 404,
    json: async () => structuredClone(document)
  });
}

test("Trainer AI bootstrap exposes activation, display flags, lazy resources, and ability knowledge without loading evaluator documents", async () => {
  const result = await loadTrainerAiBootstrap({
    baseUrl: "https://example.invalid/trainer-ai",
    hostedPrefix: null,
    gameId: "volt-white-2r",
    fetchImpl: directFetch(bootstrapDocument())
  });

  assert.equal(result.delivery.mode, "direct");
  assert.equal(result.metadata.binding.consumerActivation.enabled, true);
  assert.equal(result.metadata.generation, 5);
  assert.equal(result.metadata.profile.scripts[0].id, "flag1");
  assert.equal(result.metadata.profile.scripts[0].name, "Evaluate");
  assert.equal(result.metadata.evaluatorProfile.profileId, "gen5-test-evaluator");
  assert.equal(result.metadata.evaluatorProfile.constants.abilityKnowledge.modelId, "gen5-test");
  assert.equal(result.metadata.lazyResources.sharedTrainerAiPath, "trainer-ai/gen5/trainer_ai.json");
});

test("Trainer AI bootstrap fails closed for a missing game or ability-knowledge profile", async () => {
  await assert.rejects(
    loadTrainerAiBootstrap({
      baseUrl: "https://example.invalid/trainer-ai",
      hostedPrefix: null,
      gameId: "renegade-platinum",
      fetchImpl: directFetch(bootstrapDocument())
    }),
    error => error instanceof TrainerAiReadinessError && /absent/u.test(error.message)
  );

  const missingPolicy = bootstrapDocument();
  missingPolicy.abilityKnowledgeProfiles = {};
  await assert.rejects(
    loadTrainerAiBootstrap({
      baseUrl: "https://example.invalid/trainer-ai",
      hostedPrefix: null,
      gameId: "volt-white-2r",
      fetchImpl: directFetch(missingPolicy)
    }),
    error => error instanceof TrainerAiReadinessError && /ability-knowledge/u.test(error.message)
  );
});

test("checked-in bootstrap covers every public game while full evaluator documents remain separately lazy", async () => {
  const projected = JSON.parse(fs.readFileSync(path.join(generatedTrainerAiRoot, "bootstrap.json"), "utf8"));
  assert.ok(fs.statSync(path.join(generatedTrainerAiRoot, "bootstrap.json")).size < 64 * 1024);
  assert.equal(projected.games.length, 20);
  assert.deepEqual(
    projected.games.filter(game => game.consumerActivation.enabled).map(game => game.gameId).sort(),
    ["platinum-kaizo", "renegade-platinum", "storm-silver", "volt-white-2r"]
  );

  const bootstrap = await loadTrainerAiBootstrap({
    baseUrl: "http://fixture/trainer-ai",
    hostedPrefix: null,
    gameId: "volt-white-2r",
    fetchImpl: generatedTrainerAiFetch
  });
  const full = await loadTrainerAiDocumentation({
    baseUrl: "http://fixture/trainer-ai",
    hostedPrefix: null,
    gameId: "volt-white-2r",
    generation: bootstrap.metadata.generation,
    resourcePaths: bootstrap.metadata.lazyResources,
    fetchImpl: generatedTrainerAiFetch
  });
  assert.equal(full.binding.gameId, "volt-white-2r");
  assert.equal(full.profile.profileId, bootstrap.metadata.profiles.sharedProfileId);
  assert.equal(full.evaluatorProfile.profileId, bootstrap.metadata.profiles.evaluatorProfileId);
});

test("Trainer AI bootstrap uses the checked-in release when immutable hosting is offline", async () => {
  const result = await loadTrainerAiBootstrap({
    baseUrl: "http://fixture/trainer-ai",
    hostedPrefix: "trainer-ai",
    gameId: "volt-white-2r",
    fetchImpl: async url => {
      if (String(url).startsWith("http://fixture/")) return generatedTrainerAiFetch(url);
      throw new Error("offline");
    },
    cacheStorage: null
  });
  assert.equal(result.delivery.mode, "checked-in-offline");
  assert.equal(result.metadata.binding.consumerActivation.enabled, true);
  assert.equal(result.metadata.evaluatorProfile.constants.abilityKnowledge.modelId, "gen5-field-position-ability-memory-v1");
});
