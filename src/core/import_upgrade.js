import { assertValidPlanDocument } from "../contracts/plan_contract.js?v=20260905-drafts-freecalc-partners-v1";
import { mechanicsCompatibility, validatePlanReferences } from "../contracts/plan_compatibility.js?v=20260907-import-upgrade-v1";
import { upgradeInitialEntryEffects } from "./plan.js?v=20260907-form-sprites-v1";
import { recalculatePlanDocument } from "./recalculation.js?v=20260907-two-turn-immunity-v1";

function hasResolvedBranches(plan) {
  return Object.keys(plan.actionGroups || {}).length > 0
    || Object.keys(plan.replacementTransitions || {}).length > 0
    || Object.keys(plan.manualTransitions || {}).length > 0;
}

export async function upgradeImportedPlanForEditing(sourcePlan, { dataset, previewTurnFn, now } = {}) {
  assertValidPlanDocument(sourcePlan);
  validatePlanReferences(sourcePlan, dataset);

  const initialUpgrade = upgradeInitialEntryEffects(sourcePlan, dataset);
  let upgraded = initialUpgrade.plan;
  const previousCompatibility = mechanicsCompatibility(upgraded, dataset);
  const requiresReplay = previousCompatibility.needsRecalculation
    || (initialUpgrade.changed && hasResolvedBranches(upgraded));

  if (requiresReplay) {
    if (typeof previewTurnFn !== "function") {
      throw new Error("This older line requires the current battle resolver before it can be imported for editing");
    }
    upgraded = await recalculatePlanDocument(upgraded, { dataset, previewTurnFn, now });
  }

  assertValidPlanDocument(upgraded);
  validatePlanReferences(upgraded, dataset);
  const currentCompatibility = mechanicsCompatibility(upgraded, dataset);
  if (!currentCompatibility.editable) {
    throw new Error(`Imported line could not be updated to the current mechanics: ${currentCompatibility.message}`);
  }

  return {
    plan: upgraded,
    replayed: requiresReplay,
    initialEntryEffectsUpgraded: initialUpgrade.changed,
    previousFingerprintDifferences: previousCompatibility.differences
  };
}
