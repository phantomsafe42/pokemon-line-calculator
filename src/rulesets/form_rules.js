import { calculateStats } from "../adapters/combatant_ingest.js?v=20260909-level-drift-v1";
import { clone, toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";

export const ABILITY_FORM_STATE_VERSION = 1;

function originalSpeciesId(combatant) {
  return toId(combatant?.speciesId);
}

function belongsToFamily(combatant, familyId) {
  const speciesId = originalSpeciesId(combatant);
  return speciesId === familyId || speciesId.startsWith(familyId);
}

function effectiveWeatherId(fieldState, weatherSuppressed) {
  return weatherSuppressed ? "" : toId(fieldState?.global?.weather?.id || fieldState?.global?.weather);
}

export function desiredWeatherAbilityForm({ combatant, state, fieldState, weatherSuppressed = false }) {
  const abilityId = state?.abilitySuppressed ? "" : toId(state?.currentAbilityId);
  const weatherId = effectiveWeatherId(fieldState, weatherSuppressed);
  if (abilityId === "forecast" && belongsToFamily(combatant, "castform")) {
    const speciesId = weatherId === "sun" ? "castformsunny"
      : weatherId === "rain" ? "castformrainy"
        : ["hail", "snow"].includes(weatherId) ? "castformsnowy"
          : "castform";
    return { speciesId, spriteId: speciesId, cause: "forecast" };
  }
  if (belongsToFamily(combatant, "castform")) {
    return { speciesId: "castform", spriteId: "castform", cause: "forecast" };
  }
  if (abilityId === "flowergift" && belongsToFamily(combatant, "cherrim")) {
    return {
      speciesId: "cherrim",
      spriteId: weatherId === "sun" ? "cherrim-sunshine" : "cherrim",
      cause: "flowergift"
    };
  }
  if (belongsToFamily(combatant, "cherrim")) {
    return { speciesId: "cherrim", spriteId: "cherrim", cause: "flowergift" };
  }
  return null;
}

export function desiredZenModeForm({ combatant, state }) {
  if (!belongsToFamily(combatant, "darmanitan")) return null;
  const abilityId = state?.abilitySuppressed ? "" : toId(state?.currentAbilityId);
  const currentHp = Number(state?.hp?.max);
  const maxHp = Number(state?.hp?.maxHp);
  const zen = abilityId === "zenmode" && Number.isFinite(currentHp) && Number.isFinite(maxHp) && currentHp > 0 && currentHp <= maxHp / 2;
  return {
    speciesId: zen ? "darmanitanzen" : "darmanitan",
    spriteId: zen ? "darmanitanzen" : "darmanitan",
    cause: "zenmode"
  };
}

function formStats(combatant, state, dataset, speciesId) {
  const baseSpeciesId = originalSpeciesId(combatant);
  const species = dataset.get("species", speciesId);
  if (!species?.baseStats) throw new Error(`Species form ${speciesId} is unavailable`);
  return calculateStats({
    ...combatant,
    speciesId,
    level: Number(state.currentLevel ?? combatant.level),
    baseStats: speciesId === baseSpeciesId ? combatant.baseStats : species.baseStats
  }, dataset);
}

function replaceHpMaximum(state, nextMaximum) {
  const previousMaximum = Number(state.hp?.maxHp);
  if (!Number.isFinite(previousMaximum) || previousMaximum === nextMaximum) return null;
  const missingMin = Math.max(0, previousMaximum - Number(state.hp.max));
  const missingMax = Math.max(0, previousMaximum - Number(state.hp.min));
  const from = clone(state.hp);
  state.hp = {
    min: Math.max(0, nextMaximum - missingMax),
    max: Math.max(0, nextMaximum - missingMin),
    maxHp: nextMaximum
  };
  if (Array.isArray(state.hpDistribution)) {
    state.hpDistribution = state.hpDistribution.map(entry => ({
      ...entry,
      value: Math.max(0, Math.min(nextMaximum, nextMaximum - Math.max(0, previousMaximum - Number(entry.value))))
    }));
  }
  return { from, to: clone(state.hp) };
}

export function applyCombatantFormState({ combatant, state, dataset, form }) {
  if (!form || !combatant || !state) return [];
  const species = dataset.get("species", form.speciesId);
  if (!species) throw new Error(`Species form ${form.speciesId} is unavailable`);
  const nextTypes = (toId(form.speciesId) === originalSpeciesId(combatant)
    ? combatant.originalTypeIds || species.types
    : species.types || combatant.originalTypeIds || []).map(toId);
  const currentSpeciesId = toId(state.currentSpeciesId || combatant.speciesId);
  const currentSpriteId = toId(state.currentSpriteId || combatant.formId || combatant.speciesId);
  if (currentSpeciesId === toId(form.speciesId)
    && currentSpriteId === toId(form.spriteId || form.speciesId)
    && JSON.stringify((state.currentTypeIds || []).map(toId)) === JSON.stringify(nextTypes)) return [];
  const nextStats = formStats(combatant, state, dataset, form.speciesId);
  const changes = [];
  const assign = (field, value) => {
    const from = clone(state[field]);
    if (JSON.stringify(from) === JSON.stringify(value)) return;
    state[field] = clone(value);
    changes.push({ field, from, to: clone(value) });
  };
  assign("currentSpeciesId", form.speciesId);
  assign("currentSpriteId", form.spriteId || form.speciesId);
  assign("currentTypeIds", nextTypes);
  assign("currentStats", nextStats);
  assign("calculatedStatOverrides", nextStats);
  const hpChange = replaceHpMaximum(state, Number(nextStats.hp));
  if (hpChange) changes.push({ field: "hp", ...hpChange });
  return changes;
}

export function restoreCombatantIdentityState({ combatant, state, dataset }) {
  return applyCombatantFormState({
    combatant,
    state,
    dataset,
    form: {
      speciesId: originalSpeciesId(combatant),
      spriteId: toId(combatant.formId) || originalSpeciesId(combatant),
      cause: "switch"
    }
  });
}
