"use strict";

self.window = self;
const previousRequire = self.require;
self.require = moduleName => {
  if (moduleName === "./desc") return { display: () => "" };
  throw new Error(`Unexpected browser module ${moduleName}`);
};
const battleMechanicsBase = new URL("../generated/battle-mechanics/", self.location.href);
importScripts(
  new URL("vendor/smogon-calc-0.11.0/data.production.min.js", battleMechanicsBase).href,
  new URL("vendor/smogon-calc-0.11.0/engine.production.min.js", battleMechanicsBase).href,
  new URL("shared_damage_calculator.js", battleMechanicsBase).href,
  new URL("trainer_ai/trainer_ai_evaluator.js?v=20260906-preselection-scores", battleMechanicsBase).href
);
if (previousRequire) self.require = previousRequire;
else delete self.require;

let dataset = null;
let damageAdapter = null;
let previewTurn = null;
let previewCombatantMove = null;
let trainerAi = null;
let analyzeTrainerAi = null;

async function initialize(datasetBaseUrl, trainerAiBaseUrl, gameId) {
  const datasetModule = await import("../adapters/standardized_dataset.js?v=20260905-drafts-freecalc-partners-v1");
  const damageModule = await import("../adapters/shared_damage_adapter.js?v=20260905-drafts-freecalc-partners-v1");
  const trainerAiModule = await import("../adapters/trainer_ai.js?v=20260905-drafts-freecalc-partners-v1");
  const plannerModule = await import("../core/planner.js?v=20260907-form-sprites-v1");
  const combatantMovesModule = await import("../core/combatant_moves.js?v=20260905-drafts-freecalc-partners-v1");
  dataset = await datasetModule.loadStandardizedDataset({ baseUrl: datasetBaseUrl });
  const runtime = self.SharedDamageCalculator.createFromDocuments(
    { gameId: dataset.gameId },
    self.calc,
    dataset.mechanics,
    dataset.documents
  );
  damageAdapter = damageModule.createSharedDamageAdapter(runtime);
  trainerAi = await trainerAiModule.loadTrainerAiDocumentation({ baseUrl: trainerAiBaseUrl, gameId });
  analyzeTrainerAi = trainerAiModule.analyzeTrainerAi;
  previewTurn = plannerModule.previewTurn;
  previewCombatantMove = combatantMovesModule.previewCombatantMove;
  return { gameId: dataset.gameId, resolverReady: runtime.ready, trainerAiProfileId: trainerAi.evaluatorProfile?.profileId || null };
}

self.addEventListener("message", async event => {
  const { requestId, type, payload } = event.data || {};
  try {
    if (type === "initialize") {
      const result = await initialize(payload.datasetBaseUrl, payload.trainerAiBaseUrl, payload.gameId);
      self.postMessage({ requestId, ok: true, result });
      return;
    }
    if (type === "preview") {
      if (!dataset || !damageAdapter || !previewTurn) throw new Error("Resolver Worker has not been initialized");
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
      if (!dataset || !damageAdapter || !previewCombatantMove) throw new Error("Resolver Worker has not been initialized");
      const result = previewCombatantMove({ ...payload, dataset, damageAdapter });
      self.postMessage({ requestId, ok: true, result });
      return;
    }
    if (type === "trainer-ai") {
      if (!dataset || !damageAdapter || !trainerAi || !analyzeTrainerAi) throw new Error("Resolver Worker has not been initialized");
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
