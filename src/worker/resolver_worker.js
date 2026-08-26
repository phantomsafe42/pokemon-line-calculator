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
  new URL("shared_damage_calculator.js", battleMechanicsBase).href
);
if (previousRequire) self.require = previousRequire;
else delete self.require;

let dataset = null;
let damageAdapter = null;
let previewTurn = null;
let previewCombatantMove = null;

async function initialize(datasetBaseUrl) {
  const datasetModule = await import("../adapters/standardized_dataset.js");
  const damageModule = await import("../adapters/shared_damage_adapter.js?v=20260825-hidden-power");
  const plannerModule = await import("../core/planner.js?v=20260826-turn-nodes");
  const combatantMovesModule = await import("../core/combatant_moves.js?v=20260826-ability-immunity");
  dataset = await datasetModule.loadStandardizedDataset({ baseUrl: datasetBaseUrl });
  const runtime = self.SharedDamageCalculator.createFromDocuments(
    { gameId: dataset.gameId },
    self.calc,
    dataset.mechanics,
    dataset.documents
  );
  damageAdapter = damageModule.createSharedDamageAdapter(runtime);
  previewTurn = plannerModule.previewTurn;
  previewCombatantMove = combatantMovesModule.previewCombatantMove;
  return { gameId: dataset.gameId, resolverReady: runtime.ready };
}

self.addEventListener("message", async event => {
  const { requestId, type, payload } = event.data || {};
  try {
    if (type === "initialize") {
      const result = await initialize(payload.datasetBaseUrl);
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
    throw new Error(`Unknown Worker request ${type}`);
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: { name: error.name, message: error.message } });
  }
});
