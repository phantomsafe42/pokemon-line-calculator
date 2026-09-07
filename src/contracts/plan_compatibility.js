import { stableStringify, toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { currentMechanicsFingerprint } from "../rulesets/resolver_profile.js?v=20260907-two-turn-immunity-v1";

export class PlanCompatibilityError extends Error {
  constructor(issues) {
    super(issues.join("\n"));
    this.name = "PlanCompatibilityError";
    this.issues = issues;
  }
}

export function validatePlanReferences(plan, dataset, { throwOnError = true } = {}) {
  const issues = [];
  const trainer = dataset.trainer(plan.game.trainerId);
  if (!trainer) issues.push(`Trainer ${plan.game.trainerId} is unavailable in ${dataset.gameId}`);
  else {
    try {
      dataset.trainerTeam(plan.game.trainerId, plan.game.trainerVariantId);
    } catch (error) {
      issues.push(error.message);
    }
  }
  for (const combatant of Object.values(plan.combatants || {})) {
    if (!dataset.get("species", combatant.speciesId)) issues.push(`${combatant.combatantKey} references missing species ${combatant.speciesId}`);
    if (combatant.natureId && !dataset.get("natures", combatant.natureId)) issues.push(`${combatant.combatantKey} references missing nature ${combatant.natureId}`);
    if (combatant.originalAbilityId && !dataset.get("abilities", combatant.originalAbilityId)) issues.push(`${combatant.combatantKey} references missing ability ${combatant.originalAbilityId}`);
    if (combatant.originalItemId && !dataset.get("items", combatant.originalItemId)) issues.push(`${combatant.combatantKey} references missing item ${combatant.originalItemId}`);
    for (const move of combatant.moves || []) {
      if (!dataset.get("moves", move.moveId)) issues.push(`${combatant.combatantKey} references missing move ${move.moveId}`);
    }
  }
  const result = { valid: issues.length === 0, issues };
  if (!result.valid && throwOnError) throw new PlanCompatibilityError(issues);
  return result;
}

export function mechanicsCompatibility(plan, dataset) {
  const expected = plan.mechanicsFingerprint || {};
  const actual = currentMechanicsFingerprint(dataset);
  const fields = [
    "engineId",
    "engineVersion",
    "damageGeneration",
    "canonicalDataGeneration",
    "mechanicsProfile",
    "experienceMechanicsProfile",
    "datasetManifestHash",
    "battleMechanicsHash",
    "experienceMechanicsHash",
    "plcResolverRulesetVersion"
  ];
  const differences = fields.filter(field => stableStringify(expected[field]) !== stableStringify(actual[field]));
  return {
    editable: differences.length === 0,
    needsRecalculation: differences.length > 0,
    differences,
    message: differences.length
      ? `Needs Recalculation: mechanics fingerprint differs in ${differences.join(", ")}`
      : "Mechanics fingerprint matches"
  };
}

export function combatantIdentitySnapshot(plan) {
  return Object.values(plan.combatants || {}).map(combatant => ({
    combatantKey: combatant.combatantKey,
    side: combatant.side,
    speciesId: toId(combatant.speciesId),
    level: Number(combatant.level),
    natureId: toId(combatant.natureId),
    abilityId: toId(combatant.originalAbilityId),
    itemId: toId(combatant.originalItemId),
    moves: (combatant.moves || []).map(move => toId(move.moveId))
  })).sort((a, b) => a.combatantKey.localeCompare(b.combatantKey));
}
