import { normalizeRange, toId } from "../core/primitives.js";

function abilityId(state) {
  return state?.abilitySuppressed ? "" : toId(state?.currentAbilityId);
}

function itemId(state) {
  return state?.itemState === "held" ? toId(state?.currentItemId) : "";
}

function hasType(state, typeId) {
  return (state?.currentTypeIds || []).map(toId).includes(toId(typeId));
}

export function isGrounded(state, fieldState) {
  if (Number(fieldState?.global?.gravityTurns || 0) > 0) return true;
  if (state?.volatileConditions?.smackdown || state?.volatileConditions?.smackDown || state?.volatileConditions?.ingrain) return true;
  const activeItem = abilityId(state) !== "klutz" && !(state?.volatileConditions?.embargoTurns > 0)
    && !(fieldState?.global?.magicRoomTurns > 0) ? itemId(state) : "";
  if (activeItem === "ironball") return true;
  if (hasType(state, "flying")) return false;
  if (abilityId(state) === "levitate") return false;
  if (activeItem === "airballoon") return false;
  if (state?.volatileConditions?.magnetRiseTurns > 0 || state?.volatileConditions?.telekinesisTurns > 0) return false;
  return true;
}

export function typeEffectiveness(dataset, attackingTypeId, defendingTypeIds) {
  const attacking = toId(attackingTypeId);
  let multiplier = 1;
  for (const rawType of defendingTypeIds || []) {
    const defending = dataset.get("types", rawType);
    if (!defending) throw new Error(`Type ${rawType} is unavailable`);
    if ((defending.immune || []).map(toId).includes(attacking)) return 0;
    if ((defending.weak || []).map(toId).includes(attacking)) multiplier *= 2;
    if ((defending.resist || []).map(toId).includes(attacking)) multiplier *= 0.5;
  }
  return multiplier;
}

export function damagingMoveTypeImmunity({ dataset, move, attackerState, defenderState }) {
  if (!move || String(move.category || "").toLowerCase() === "status" || Number(move.basePower || 0) <= 0) return null;
  if (itemId(defenderState) === "ringtarget") return null;
  const moveType = toId(move.type);
  const defenderTypes = (defenderState?.currentTypeIds || []).map(toId);
  if (!moveType || typeEffectiveness(dataset, moveType, defenderTypes) !== 0) return null;

  const moveId = toId(move.id || move.name);
  const attackerAbility = abilityId(attackerState);
  const volatiles = defenderState?.volatileConditions || {};
  if (moveType === "psychic" && defenderTypes.includes("dark") && volatiles.miracleeye) return null;
  if (["normal", "fighting"].includes(moveType) && defenderTypes.includes("ghost")
      && (attackerAbility === "scrappy" || volatiles.foresight)) return null;
  if (moveType === "ground" && defenderTypes.includes("flying") && moveId === "thousandarrows") return null;
  return { immune: true, reason: "type-immunity", moveType };
}

export function damagingMoveAbilityImmunity({ dataset, move, attackerState, defenderState, fieldState, attackerSide = null, defenderSide = null }) {
  if (!move || String(move.category || "").toLowerCase() === "status" || Number(move.basePower || 0) <= 0) return null;
  const attackerAbility = abilityId(attackerState);
  if (["moldbreaker", "teravolt", "turboblaze"].includes(attackerAbility)) return null;
  const defenderAbility = abilityId(defenderState);
  const moveType = toId(move.type);
  const flags = new Set(Object.entries(move.flags || {}).filter(([, enabled]) => Boolean(enabled)).map(([flag]) => toId(flag)));
  const pureFlagImmunity = {
    soundproof: "sound",
    bulletproof: "bullet"
  }[defenderAbility];
  if (pureFlagImmunity && flags.has(pureFlagImmunity)) {
    return { immune: true, reason: "ability-immunity", abilityId: defenderAbility, moveType };
  }
  if (defenderAbility === "levitate" && moveType === "ground" && !isGrounded(defenderState, fieldState)) {
    return { immune: true, reason: "ability-immunity", abilityId: defenderAbility, moveType };
  }
  if (defenderAbility === "telepathy" && attackerSide && attackerSide === defenderSide) {
    return { immune: true, reason: "ability-immunity", abilityId: defenderAbility, moveType };
  }
  if (defenderAbility === "wonderguard") {
    const effectiveness = typeEffectiveness(dataset, moveType, defenderState?.currentTypeIds || []);
    if (effectiveness > 0 && effectiveness <= 1) return { immune: true, reason: "ability-immunity", abilityId: defenderAbility, moveType };
  }
  const absorbedType = {
    waterabsorb: "water",
    dryskin: "water",
    stormdrain: "water",
    voltabsorb: "electric",
    lightningrod: "electric",
    motordrive: "electric",
    flashfire: "fire",
    sapsipper: "grass"
  }[defenderAbility];
  const generation = Number(dataset?.mechanics?.damageGeneration || 5);
  if (["lightningrod", "stormdrain"].includes(defenderAbility) && generation < 5) return null;
  if (absorbedType === moveType) {
    const effect = {
      waterabsorb: { kind: "heal", numerator: 1, denominator: 4 },
      dryskin: { kind: "heal", numerator: 1, denominator: 4 },
      stormdrain: { kind: "stat-stage", stat: "spa", delta: 1 },
      voltabsorb: { kind: "heal", numerator: 1, denominator: 4 },
      lightningrod: { kind: "stat-stage", stat: "spa", delta: 1 },
      motordrive: { kind: "stat-stage", stat: "spe", delta: 1 },
      flashfire: { kind: "volatile", volatileId: "flashFire" },
      sapsipper: { kind: "stat-stage", stat: "atk", delta: 1 }
    }[defenderAbility];
    return { immune: true, reason: "ability-immunity", abilityId: defenderAbility, moveType, effect };
  }
  return null;
}

export function damagingMoveImmunity(context) {
  return damagingMoveTypeImmunity(context) || damagingMoveAbilityImmunity(context);
}

export function outgoingSwitchEffects(state) {
  const effects = [];
  const ability = abilityId(state);
  if (ability === "naturalcure" && state.majorStatus) {
    effects.push({ kind: "clear-status", from: state.majorStatus, cause: "natural-cure" });
  }
  if (ability === "regenerator" && Number(state.hp?.max) > 0 && Number(state.hp?.max) < Number(state.hp?.maxHp)) {
    effects.push({ kind: "heal", amount: Math.floor(Number(state.hp.maxHp) / 3), cause: "regenerator" });
  }
  return effects;
}

export function entryHazardEffects({ state, fieldState, side, dataset, generation }) {
  const sideState = fieldState?.sides?.[side] || {};
  const hazards = sideState?.hazards || {};
  const effects = [];
  if (Number(generation) >= 8 && itemId(state) === "heavydutyboots") return effects;
  const maxHp = Number(state.hp?.maxHp || 0);
  const grounded = isGrounded(state, fieldState);
  if (hazards.stealthRock) {
    const multiplier = typeEffectiveness(dataset, "rock", state.currentTypeIds);
    effects.push({ kind: "damage", amount: Math.max(1, Math.floor(maxHp * multiplier / 8)), cause: "stealth-rock", multiplier });
  }
  const spikes = Math.max(0, Math.min(3, Number(hazards.spikes || 0)));
  if (spikes && grounded) {
    const denominator = [0, 8, 6, 4][spikes];
    effects.push({ kind: "damage", amount: Math.max(1, Math.floor(maxHp / denominator)), cause: "spikes", layers: spikes });
  }
  const toxicSpikes = Math.max(0, Math.min(2, Number(hazards.toxicSpikes || 0)));
  if (toxicSpikes && grounded) {
    if (hasType(state, "poison")) effects.push({ kind: "absorb-toxic-spikes", cause: "toxic-spikes" });
    else if (!hasType(state, "steel") && !state.majorStatus) {
      effects.push({ kind: "status", statusId: toxicSpikes >= 2 ? "tox" : "psn", cause: "toxic-spikes", layers: toxicSpikes });
    }
  }
  if (hazards.stickyWeb && grounded && Number(generation) >= 6) {
    effects.push({ kind: "stat-stage", stat: "spe", delta: -1, cause: "sticky-web" });
  }
  return effects;
}

function modifiedEntryStat(state, stat) {
  const base = Number(state?.currentStats?.[stat] ?? state?.calculatedStats?.[stat]);
  if (!Number.isFinite(base) || base < 1) return null;
  const stage = Math.max(-6, Math.min(6, Number(state?.statStages?.[stat] || 0)));
  const multiplier = stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
  return Math.floor(base * multiplier);
}

export function entryAbilityEffects({ enteringState, opposingState, opposingStates = null, generation }) {
  const ability = abilityId(enteringState);
  if (ability === "intimidate") {
    return [{ kind: "stat-stage", stat: "atk", delta: -1, target: "opponent", cause: "intimidate" }];
  }
  const weather = {
    drizzle: "rain",
    drought: "sun",
    sandstream: "sand",
    snowwarning: Number(generation) >= 6 ? "snow" : "hail"
  }[ability];
  if (weather) {
    return [{
      kind: "weather",
      weatherId: weather,
      durationMode: Number(generation) >= 6 ? "turns" : "permanent",
      remainingTurns: Number(generation) >= 6 ? 5 : null,
      cause: ability
    }];
  }
  if (ability === "download") {
    const opponents = (Array.isArray(opposingStates) && opposingStates.length ? opposingStates : [opposingState]).filter(Boolean);
    const totals = opponents.reduce((result, state) => {
      const defense = modifiedEntryStat(state, "def");
      const specialDefense = modifiedEntryStat(state, "spd");
      if (defense === null || specialDefense === null) result.complete = false;
      else {
        result.defense += defense;
        result.specialDefense += specialDefense;
      }
      return result;
    }, { defense: 0, specialDefense: 0, complete: opponents.length > 0 });
    if (!totals.complete) return [{ kind: "unsupported", reason: "Download needs every opposing active Pokémon's Defense and Sp. Def" }];
    return [{
      kind: "stat-stage",
      stat: totals.specialDefense > totals.defense ? "atk" : "spa",
      delta: 1,
      target: "self",
      cause: "download",
      comparison: totals
    }];
  }
  if (ability === "trace") {
    return [{ kind: "copy-opponent-ability", cause: ability, randomEligibleTarget: true }];
  }
  if (ability === "imposter") return [{ kind: "transform-opponent", cause: ability }];
  return [];
}

export function applyExactHpChange(state, delta) {
  const range = normalizeRange(state.hp);
  const maxHp = Number(range.maxHp);
  state.hp = {
    min: Math.max(0, Math.min(maxHp, range.min + Number(delta))),
    max: Math.max(0, Math.min(maxHp, range.max + Number(delta))),
    maxHp
  };
  if (Array.isArray(state.hpDistribution)) {
    const grouped = new Map();
    for (const entry of state.hpDistribution) {
      const value = Math.max(0, Math.min(maxHp, Number(entry.value) + Number(delta)));
      grouped.set(value, (grouped.get(value) || 0) + Number(entry.probability || 0));
    }
    state.hpDistribution = [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([value, probability]) => ({ value, probability }));
  }
}
