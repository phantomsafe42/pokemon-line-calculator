import { stableStringify, toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { currentMechanicsFingerprint } from "../rulesets/resolver_profile.js?v=20260911-ability-storage-reimp-v1";

export class PlanCompatibilityError extends Error {
  constructor(issues) {
    super(issues.join("\n"));
    this.name = "PlanCompatibilityError";
    this.issues = issues;
  }
}

export function validatePlanReferences(plan, dataset, { throwOnError = true } = {}) {
  const issues = [];
  if (plan.game.playerPartner) {
    const partner = dataset.trainer(plan.game.playerPartner.trainerId);
    if (!partner) issues.push('The saved player partner is unavailable in this Dataset');
    else {
      try { dataset.trainerTeam(partner.id, plan.game.playerPartner.trainerVariantId || null); }
      catch (error) { issues.push(`Player partner: ${error.message}`); }
    }
  }
  const trainerIds = plan.game.enemyTrainerIds?.length ? plan.game.enemyTrainerIds : [plan.game.trainerId];
  for (const [index, trainerId] of trainerIds.entries()) {
    const trainer = dataset.trainer(trainerId);
    if (!trainer) {
      issues.push(`Trainer ${trainerId} is unavailable in ${dataset.gameId}`);
      continue;
    }
    try {
      dataset.trainerTeam(trainerId, plan.game.enemyTrainerVariantIds?.[index] ?? (index === 0 ? plan.game.trainerVariantId : null));
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
