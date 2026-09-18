"use strict";

self.window = self;
const previousRequire = self.require;
self.require = moduleName => {
  if (moduleName === "./desc") return { display: () => "" };
  throw new Error(`Unexpected browser module ${moduleName}`);
};
const battleMechanicsBase = new URL("../generated/battle-mechanics/", self.location.href);
importScripts(
  new URL("vendor/smogon-calc-0.11.0/data.production.min.js?v=20260909-public-release-v2", battleMechanicsBase).href,
  new URL("vendor/smogon-calc-0.11.0/engine.production.min.js?v=20260909-public-release-v2", battleMechanicsBase).href,
  new URL("shared_damage_calculator.js?v=20260909-public-release-v2", battleMechanicsBase).href
);
if (previousRequire) self.require = previousRequire;
else delete self.require;

let dataset = null;
let damageAdapter = null;
let previewTurn = null;
let previewCombatantMove = null;
let trainerAi = null;
let analyzeTrainerAi = null;
let workerRole = null;

function trainerAiMetadata(documentation) {
  if (!documentation) return null;
  return {
    binding: {
      consumerActivation: {
        enabled: documentation.binding?.consumerActivation?.enabled === true
      }
    },
    generation: documentation.generation,
    profile: {
      scripts: (documentation.profile?.scripts || []).map(script => ({
        id: script.id,
        name: script.name,
        summary: script.summary
      }))
    },
    evaluatorProfile: {
      constants: {
        abilityKnowledge: documentation.evaluatorProfile?.constants?.abilityKnowledge || null
      }
    }
  };
}

async function initialize(datasetBaseUrl, datasetHostedPrefix, trainerAiBaseUrl, trainerAiHostedPrefix, trainerAiLazyResources, hostedRelease, gameId, role) {
  if (!["resolver", "trainer-ai"].includes(role)) throw new Error(`Unknown Worker role ${role || "missing"}`);
  workerRole = role;
  if (role === "trainer-ai" && !trainerAiBaseUrl) {
    return { gameId, resolverReady: false, trainerAiProfileId: null, trainerAiMetadata: null };
  }
  const datasetModule = await import("../adapters/standardized_dataset.js?v=20260917-partners-release-v1");
  const damageModule = await import("../adapters/shared_damage_adapter.js?v=20260909-public-release-v2");
  dataset = await datasetModule.loadStandardizedDataset({ baseUrl: datasetBaseUrl, hostedPrefix: datasetHostedPrefix, hostedRelease });
  const runtime = self.SharedDamageCalculator.createFromDocuments(
    { gameId: dataset.gameId },
    self.calc,
    dataset.mechanics,
    dataset.documents
  );
  damageAdapter = damageModule.createSharedDamageAdapter(runtime);
  if (role === "resolver") {
    const [plannerModule, combatantMovesModule] = await Promise.all([
      import("../core/planner.js?v=20260917-partners-release-v1"),
      import("../core/combatant_moves.js?v=20260909-public-release-v2")
    ]);
    previewTurn = plannerModule.previewTurn;
    previewCombatantMove = combatantMovesModule.previewCombatantMove;
  } else {
    importScripts(new URL("trainer_ai/trainer_ai_evaluator.js?v=20260909-public-release-v2", battleMechanicsBase).href);
    const trainerAiModule = await import("../adapters/trainer_ai.js?v=20260917-ai-target-slots-v1");
    trainerAi = await trainerAiModule.loadTrainerAiDocumentation({
      baseUrl: trainerAiBaseUrl,
      hostedPrefix: trainerAiHostedPrefix,
      hostedRelease,
      gameId,
      resourcePaths: trainerAiLazyResources
    });
    dataset.abilityKnowledgePolicy = trainerAi?.evaluatorProfile?.constants?.abilityKnowledge || null;
    analyzeTrainerAi = trainerAiModule.analyzeTrainerAi;
  }
  return {
    gameId: dataset.gameId,
    resolverReady: runtime.ready,
    trainerAiProfileId: trainerAi?.evaluatorProfile?.profileId || null,
    trainerAiMetadata: trainerAiMetadata(trainerAi)
  };
}

self.addEventListener("message", async event => {
  const { requestId, type, payload } = event.data || {};
  try {
    if (type === "initialize") {
      const result = await initialize(payload.datasetBaseUrl, payload.datasetHostedPrefix, payload.trainerAiBaseUrl, payload.trainerAiHostedPrefix, payload.trainerAiLazyResources, payload.hostedRelease, payload.gameId, payload.role);
      self.postMessage({ requestId, ok: true, result });
      return;
    }
    if (type === "preview") {
      if (workerRole !== "resolver" || !dataset || !damageAdapter || !previewTurn) throw new Error("Resolver Worker has not been initialized");
      const result = previewTurn({
        plan: payload.plan,
        parentStateNodeId: payload.parentStateNodeId,
        actions: payload.actions,
        expandExisting: payload.expandExisting === true,
        dataset,
        damageAdapter
      });
      self.postMessage({ requestId, ok: true, result });
      return;
    }
    if (type === "damage-preview") {
      if (workerRole !== "resolver" || !dataset || !damageAdapter || !previewCombatantMove) throw new Error("Resolver Worker has not been initialized");
      const result = previewCombatantMove({ ...payload, dataset, damageAdapter });
      self.postMessage({ requestId, ok: true, result });
      return;
    }
    if (type === "trainer-ai") {
      if (workerRole !== "trainer-ai" || !dataset || !damageAdapter || !trainerAi || !analyzeTrainerAi) throw new Error("Trainer AI Worker has not been initialized");
      const result = analyzeTrainerAi({
        plan: payload.plan,
        state: payload.state,
        dataset,
        ai: trainerAi,
        evaluator: self.TrainerAiEvaluator,
        damageAdapter
      });
      self.postMessage({ requestId, ok: true, result });
      return;
    }
    throw new Error(`Unknown Worker request ${type}`);
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: { name: error.name, message: error.message } });
  }
});
