import { toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { abilityStatusImmunity } from "./ability_rules.js?v=20260905-drafts-freecalc-partners-v1";

const WEATHER_NAMES = Object.freeze({
  rain: "Rain",
  raindance: "Rain",
  sun: "Sun",
  sunnyday: "Sun",
  sand: "Sand",
  sandstorm: "Sand",
  hail: "Hail",
  snow: "Snow"
});

const TERRAIN_NAMES = Object.freeze({
  electric: "Electric",
  electricterrain: "Electric",
  grassy: "Grassy",
  grassyterrain: "Grassy",
  misty: "Misty",
  mistyterrain: "Misty",
  psychic: "Psychic",
  psychicterrain: "Psychic"
});

export function conditionId(value) {
  return toId(value && typeof value === "object" ? value.id : value);
}

export function calculatorFieldName(kind, value) {
  const id = conditionId(value);
  if (!id) return undefined;
  const names = kind === "weather" ? WEATHER_NAMES : TERRAIN_NAMES;
  const name = names[id];
  if (!name) throw new Error(`Unsupported ${kind} condition ${id}`);
  return name;
}

export function protectSuccessProbability(generation, streak) {
  const count = Math.max(0, Number(streak || 0));
  if (!count) return 1;
  const divisor = Number(generation) >= 6 ? 3 : 2;
  return 1 / (divisor ** count);
}

export function criticalHitProbability({ generation, descriptor, attacker, attackerState, defenderState, defenderSideState }) {
  const numericGeneration = Number(generation);
  if (!Number.isInteger(numericGeneration) || numericGeneration < 2) return null;
  if (descriptor?.critRatio === undefined && descriptor?.willCrit === undefined) return 0;
  if (["battlearmor", "shellarmor"].includes(abilityId(defenderState))) return 0;
  if (Number(defenderSideState?.luckyChantTurns || 0) > 0) return 0;
  if (descriptor?.willCrit === false) return 0;
  if (descriptor?.willCrit === true) return 1;

  let ratio = Math.max(1, Number(descriptor?.critRatio || 1));
  if (abilityId(attackerState) === "superluck") ratio += 1;
  const item = itemId(attackerState);
  if (["scopelens", "razorclaw"].includes(item)) ratio += 1;
  const species = toId(attacker?.speciesId || attacker?.species || attacker?.name);
  if (item === "stick" && species === "farfetchd" || item === "luckypunch" && species === "chansey") ratio += 2;
  if (attackerState?.volatileConditions?.focusenergy) ratio += 2;

  const denominators = numericGeneration <= 5
    ? [null, 16, 8, 4, 3, 2]
    : numericGeneration === 6
      ? [null, 16, 8, 2, 1]
      : [null, 24, 8, 2, 1];
  const stage = Math.min(denominators.length - 1, Math.floor(ratio));
  return 1 / denominators[stage];
}

function hasType(state, typeId) {
  return (state.currentTypeIds || []).map(toId).includes(toId(typeId));
}

function abilityId(state) {
  return state.abilitySuppressed ? "" : toId(state.currentAbilityId);
}

function itemId(state) {
  return state.itemState === "held" ? toId(state.currentItemId) : "";
}

export function effectiveAccuracy({ move, attackerState, defenderState, fieldState, generation }) {
  if (move.accuracy === true) return 100;
  if ([abilityId(attackerState), abilityId(defenderState)].includes("noguard")) return 100;
  if (attackerState.volatileConditions?.sureHitTargetKey === defenderState.combatantKey) return 100;
  if (Number(defenderState.volatileConditions?.telekinesisTurns || 0) > 0) return 100;
  if (toId(move.id || move.name) === "toxic" && Number(generation) >= 6 && hasType(attackerState, "poison")) return 100;
  let accuracy = Number(move.accuracy ?? 100);
  const stage = Math.max(-6, Math.min(6, Number(attackerState.statStages?.accuracy || 0) - Number(defenderState.statStages?.evasion || 0)));
  accuracy *= stage >= 0 ? (3 + stage) / 3 : 3 / (3 - stage);
  if (abilityId(attackerState) === "compoundeyes") accuracy *= 1.3;
  if (abilityId(attackerState) === "hustle" && String(move.category).toLowerCase() === "physical") accuracy *= 0.8;
  if (itemId(attackerState) === "widelens") accuracy *= 1.1;
  if (["brightpowder", "laxincense"].includes(itemId(defenderState))) accuracy *= 0.9;
  const weather = conditionId(fieldState?.global?.weather);
  const moveId = toId(move.id || move.name);
  if (weather === "rain" && ["thunder", "hurricane"].includes(moveId) || weather === "hail" && moveId === "blizzard") return 100;
  if (weather === "sun" && ["thunder", "hurricane"].includes(moveId)) accuracy = 50;
  if (Number(fieldState?.global?.gravityTurns || 0) > 0) accuracy *= 5 / 3;
  if (weather === "sand" && abilityId(defenderState) === "sandveil") accuracy *= 0.8;
  if (["hail", "snow"].includes(weather) && abilityId(defenderState) === "snowcloak") accuracy *= 0.8;
  if (abilityId(defenderState) === "wonderskin" && String(move.category).toLowerCase() === "status") accuracy = Math.min(accuracy, 50);
  return Math.max(0, Math.min(100, accuracy));
}

export function statusApplicationResult({ descriptor, attackerState, targetState, fieldState, generation }) {
  if (targetState.majorStatus) return { applies: false, reason: "target-already-has-major-status" };
  if (Number(targetState.volatileConditions?.substituteHp || 0) > 0) return { applies: false, reason: "blocked-by-substitute" };
  const ability = abilityId(targetState);
  const terrain = conditionId(fieldState?.global?.terrain);
  if (terrain && Number(generation) >= 6) {
    const grounded = !hasType(targetState, "flying") && ability !== "levitate" && itemId(targetState) !== "airballoon"
      || Number(fieldState?.global?.gravityTurns || 0) > 0;
    if (grounded && terrain === "electric" && descriptor.statusId === "slp") return { applies: false, reason: "electric-terrain-prevents-sleep" };
    if (grounded && terrain === "misty") return { applies: false, reason: "misty-terrain-prevents-status" };
  }
  const types = new Set((targetState.currentTypeIds || []).map(toId));
  const immuneTypes = new Set((descriptor.immuneTypes || []).map(toId));
  if (abilityId(attackerState || {}) === "corrosion" && ["psn", "tox"].includes(descriptor.statusId)) immuneTypes.clear();
  if (descriptor.statusId === "par" && Number(generation) >= 6) immuneTypes.add("electric");
  if ([...types].some(type => immuneTypes.has(type))) return { applies: false, reason: "target-type-is-immune" };
  if (itemId(targetState) !== "ringtarget" && (descriptor.moveImmuneTypes || []).map(toId).some(type => types.has(type))) {
    return { applies: false, reason: "target-is-immune-to-move-type" };
  }
  if ((descriptor.immuneAbilities || []).map(toId).includes(ability)) return { applies: false, reason: "target-ability-is-immune" };
  const immuneAbility = abilityStatusImmunity({ state: targetState, statusId: descriptor.statusId, fieldState });
  if (immuneAbility) return { applies: false, reason: `target-ability-${immuneAbility}-is-immune` };
  return { applies: true, reason: null };
}

export function weatherIsSuppressed(activeStates) {
  return activeStates.some(state => ["airlock", "cloudnine"].includes(abilityId(state)));
}

export function weatherResidualRule(weatherValue, state) {
  const weather = conditionId(weatherValue);
  const ability = abilityId(state);
  const item = itemId(state);
  if (ability === "magicguard" || ability === "overcoat" || item === "safetygoggles") return null;
  if (weather === "sand") {
    if (["sandforce", "sandrush", "sandveil"].includes(ability)) return null;
    if (["rock", "ground", "steel"].some(type => hasType(state, type))) return null;
    return { kind: "damage", numerator: 1, denominator: 16, cause: "sand" };
  }
  if (weather === "hail") {
    if (["icebody", "snowcloak"].includes(ability) || hasType(state, "ice")) return null;
    return { kind: "damage", numerator: 1, denominator: 16, cause: "hail" };
  }
  return null;
}

export function statusResidualRule(state, generation) {
  const status = toId(state.majorStatus);
  const ability = abilityId(state);
  if (!status || ["par", "slp", "frz"].includes(status)) return null;
  if (!["brn", "psn", "tox"].includes(status)) {
    return { unsupported: true, reason: `residual status ${status} is not enabled` };
  }
  if (ability === "magicguard") return null;
  if (["psn", "tox"].includes(status) && ability === "poisonheal") {
    return { kind: "heal", numerator: 1, denominator: 8, cause: "poison-heal", nextToxicCounter: status === "tox" ? Math.max(1, Number(state.toxicCounter || 1)) + 1 : null };
  }
  if (status === "brn") {
    const denominator = Number(generation) >= 7 ? 16 : 8;
    return { kind: "damage", numerator: 1, denominator: ability === "heatproof" ? denominator * 2 : denominator, cause: "burn" };
  }
  if (status === "psn") return { kind: "damage", numerator: 1, denominator: 8, cause: "poison" };
  const counter = Math.max(1, Number(state.toxicCounter || 1));
  return { kind: "damage", numerator: counter, denominator: 16, cause: "bad-poison", nextToxicCounter: counter + 1 };
}

export function itemResidualRule(state) {
  const item = itemId(state);
  if (item === "leftovers") return { kind: "heal", numerator: 1, denominator: 16, cause: "leftovers" };
  if (item === "blacksludge") {
    return hasType(state, "poison")
      ? { kind: "heal", numerator: 1, denominator: 16, cause: "black-sludge" }
      : abilityId(state) === "magicguard" ? null : { kind: "damage", numerator: 1, denominator: 8, cause: "black-sludge" };
  }
  return null;
}

export function endOfTurnSupportIssue(state, fieldState, opponentState) {
  const ability = abilityId(state);
  const item = itemId(state);
  if (["flameorb", "toxicorb"].includes(item) && !state.majorStatus) return `${item} status activation is not enabled`;
  if (item === "stickybarb" && ability !== "magicguard") return "Sticky Barb residual damage is not enabled";
  return null;
}
