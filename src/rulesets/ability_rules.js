import { toId } from "../core/primitives.js";
import { isGrounded } from "./switch_rules.js";

const DROP_BLOCKERS = Object.freeze({
  atk: new Set(["clearbody", "whitesmoke", "hypercutter", "fullmetalbody"]),
  def: new Set(["clearbody", "whitesmoke", "bigpecks", "fullmetalbody"]),
  spa: new Set(["clearbody", "whitesmoke", "fullmetalbody"]),
  spd: new Set(["clearbody", "whitesmoke", "fullmetalbody"]),
  spe: new Set(["clearbody", "whitesmoke", "fullmetalbody"]),
  accuracy: new Set(["clearbody", "whitesmoke", "keeneye", "fullmetalbody"]),
  evasion: new Set(["clearbody", "whitesmoke", "fullmetalbody"])
});

const CONTACT_REACTIONS = Object.freeze({
  effectspore: { kind: "random-status", chance: 0.3, statuses: ["psn", "par", "slp"] },
  flamebody: { kind: "status", chance: 0.3, statusId: "brn" },
  poisonpoint: { kind: "status", chance: 0.3, statusId: "psn" },
  static: { kind: "status", chance: 0.3, statusId: "par" },
  cutecharm: { kind: "attract", chance: 0.3 },
  roughskin: { kind: "damage-source", numerator: 1, denominator: 8 },
  ironbarbs: { kind: "damage-source", numerator: 1, denominator: 8 },
  mummy: { kind: "replace-source-ability", abilityId: "mummy" }
});

export function activeAbilityId(state) {
  return state?.abilitySuppressed ? "" : toId(state?.currentAbilityId);
}

export function abilityStatStageRule({ targetState, sourceKey, targetKey, stat, requestedDelta, generation = 5 }) {
  const ability = activeAbilityId(targetState);
  const selfCaused = !sourceKey || sourceKey === targetKey;
  let delta = Number(requestedDelta || 0);
  if (ability === "contrary") delta *= -1;
  else if (ability === "simple") delta *= 2;

  if (delta < 0 && !selfCaused) {
    const blockers = DROP_BLOCKERS[stat] || new Set();
    if (blockers.has(ability)) return { delta: 0, blockedBy: ability, reaction: null };
    if (Number(generation) >= 8 && stat === "atk" && ["innerfocus", "oblivious", "owntempo", "scrappy"].includes(ability)) {
      return { delta: 0, blockedBy: ability, reaction: null };
    }
  }

  const reaction = delta < 0 && !selfCaused
    ? ability === "defiant" ? { stat: "atk", delta: 2, cause: "defiant" }
      : ability === "competitive" ? { stat: "spa", delta: 2, cause: "competitive" }
        : null
    : null;
  return { delta, blockedBy: null, reaction };
}

export function abilityStatusImmunity({ state, statusId, fieldState }) {
  const ability = activeAbilityId(state);
  const status = toId(statusId);
  const weather = toId(fieldState?.global?.weather?.id || fieldState?.global?.weather);
  if (status === "slp" && ["insomnia", "vitalspirit"].includes(ability)) return ability;
  if (status === "par" && ability === "limber") return ability;
  if (["psn", "tox"].includes(status) && ability === "immunity") return ability;
  if (status === "brn" && ability === "waterveil") return ability;
  if (status === "frz" && ability === "magmaarmor") return ability;
  if (weather === "sun" && ability === "leafguard") return ability;
  return null;
}

export function abilityEndOfTurnEffect({ state, fieldState, opposingStates = [] }) {
  const ability = activeAbilityId(state);
  const weather = toId(fieldState?.global?.weather?.id || fieldState?.global?.weather);
  if (ability === "speedboost") return { kind: "stat-stage", stat: "spe", delta: 1, cause: ability, residualOrder: 28 };
  if (ability === "moody") return { kind: "moody", cause: ability, residualOrder: 28 };
  if (ability === "shedskin" && state.majorStatus) return { kind: "chance-cure-status", chance: 1 / 3, cause: ability, residualOrder: 5 };
  if (ability === "hydration" && state.majorStatus && weather === "rain") return { kind: "cure-status", cause: ability, residualOrder: 5 };
  if (ability === "raindish" && weather === "rain") return { kind: "heal", numerator: 1, denominator: 16, cause: ability, residualOrder: 1 };
  if (ability === "dryskin" && weather === "rain") return { kind: "heal", numerator: 1, denominator: 8, cause: ability, residualOrder: 1 };
  if (ability === "dryskin" && weather === "sun") return { kind: "damage", numerator: 1, denominator: 8, cause: ability, residualOrder: 1 };
  if (ability === "icebody" && weather === "hail") return { kind: "heal", numerator: 1, denominator: 16, cause: ability, residualOrder: 1 };
  if (ability === "solarpower" && weather === "sun") return { kind: "damage", numerator: 1, denominator: 8, cause: ability, residualOrder: 1 };
  if (ability === "baddreams") {
    const targets = opposingStates.filter(entry => entry?.state?.majorStatus === "slp").map(entry => entry.combatantKey);
    return targets.length ? { kind: "damage-targets", targetKeys: targets, numerator: 1, denominator: 8, cause: ability, residualOrder: 28 } : null;
  }
  return null;
}

export function abilityActionRule(state) {
  const ability = activeAbilityId(state);
  if (ability !== "truant") return null;
  return state?.volatileConditions?.truantLoafing
    ? { kind: "skip", cause: "truant", resultLabel: "Loafed around" }
    : { kind: "arm", cause: "truant" };
}

export function abilityContactReaction({ targetState, move }) {
  if (!move?.flags?.contact) return null;
  return CONTACT_REACTIONS[activeAbilityId(targetState)] || null;
}

export function abilityAfterDamagingHit({ targetState, move, criticalHit = false, fainted = false, generation = 5 }) {
  const ability = activeAbilityId(targetState);
  const moveType = toId(move?.type);
  const category = toId(move?.category);
  const effects = [];
  if (ability === "angerpoint" && criticalHit && !fainted) effects.push({ kind: "set-stage", stat: "atk", value: 6, cause: ability });
  if (ability === "justified" && moveType === "dark" && !fainted) effects.push({ kind: "stat-stage", stat: "atk", delta: 1, cause: ability });
  if (ability === "rattled" && ["bug", "dark", "ghost"].includes(moveType) && !fainted) effects.push({ kind: "stat-stage", stat: "spe", delta: 1, cause: ability });
  if (ability === "weakarmor" && category === "physical" && !fainted) {
    effects.push({ kind: "stat-stage", stat: "def", delta: -1, cause: ability });
    effects.push({ kind: "stat-stage", stat: "spe", delta: 1, cause: ability });
  }
  if (ability === "cursedbody" && !fainted) effects.push({ kind: "disable-source-move", chance: 0.3, cause: ability });
  if (ability === "aftermath" && fainted && move?.flags?.contact) effects.push({ kind: "damage-source", numerator: 1, denominator: 4, cause: ability });
  const contactRule = abilityContactReaction({ targetState, move });
  const contact = contactRule ? { ...contactRule } : null;
  if (contact?.kind === "damage-source" && ability === "roughskin" && Number(generation) <= 3) {
    contact.numerator = 1;
    contact.denominator = 16;
  }
  if (contact && !(ability === "aftermath" && fainted)) effects.push({ ...contact, cause: ability });
  return effects;
}

export function abilityAfterFaintEffect(state) {
  const ability = activeAbilityId(state);
  if (ability === "moxie") return { kind: "stat-stage", stat: "atk", delta: 1, cause: ability };
  return null;
}

export function trappingAbilityBlocksSwitch({ sourceState, targetState, fieldState }) {
  const ability = activeAbilityId(sourceState);
  const targetTypes = (targetState?.currentTypeIds || []).map(toId);
  if (ability === "shadowtag" && activeAbilityId(targetState) !== "shadowtag") return ability;
  if (ability === "magnetpull" && targetTypes.includes("steel")) return ability;
  if (ability === "arenatrap") {
    if (isGrounded(targetState, fieldState)) return ability;
  }
  return null;
}
