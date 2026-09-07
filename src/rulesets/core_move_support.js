import { toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { hasShowdownMoveReference, vw2rMoveSupport, vw2rReferenceMoveIds } from "./vw2r_move_support.js?v=20260907-two-turn-immunity-v1";

// The core registry intentionally enables only canonical moves whose complete turn effect
// is represented here. A move is never treated as simple damage just because its
// human-readable description looks simple.
const EFFECTS = Object.freeze({
  tackle: { effectId: "direct-damage", flags: { contact: true } },
  pound: { effectId: "direct-damage", flags: { contact: true } },
  scratch: { effectId: "direct-damage", flags: { contact: true } },
  aquajet: { effectId: "direct-damage", flags: { contact: true } },
  quickattack: { effectId: "direct-damage", flags: { contact: true } },
  extremespeed: { effectId: "direct-damage", flags: { contact: true } },
  earthquake: { effectId: "direct-damage" },
  surf: { effectId: "direct-damage" },
  strength: { effectId: "direct-damage", flags: { contact: true } },
  return: { effectId: "direct-damage", flags: { contact: true } },
  frustration: { effectId: "direct-damage", flags: { contact: true } },
  seismictoss: { effectId: "direct-damage" },
  nightshade: { effectId: "direct-damage" },
  doubleedge: { effectId: "damage-with-recoil", recoil: [33, 100], flags: { contact: true } },
  revenge: {
    effectId: "conditional-damage",
    powerCondition: "damaged-by-target-this-turn",
    basePower: 60,
    conditionBasePower: 120,
    flags: { contact: true }
  },
  swordsdance: { effectId: "self-stat-stages", target: "self", statStages: { atk: 2 } },
  irondefense: { effectId: "self-stat-stages", target: "self", statStages: { def: 2 } },
  calmmind: { effectId: "self-stat-stages", target: "self", statStages: { spa: 1, spd: 1 } },
  bulkup: { effectId: "self-stat-stages", target: "self", statStages: { atk: 1, def: 1 } },
  agility: { effectId: "self-stat-stages", target: "self", statStages: { spe: 2 } },
  rockpolish: { effectId: "self-stat-stages", target: "self", statStages: { spe: 2 } },
  nastyplot: { effectId: "self-stat-stages", target: "self", statStages: { spa: 2 } },
  recover: { effectId: "self-heal", target: "self", heal: [1, 2] },
  softboiled: { effectId: "self-heal", target: "self", heal: [1, 2] },
  slackoff: { effectId: "self-heal", target: "self", heal: [1, 2] },
  milkdrink: { effectId: "self-heal", target: "self", heal: [1, 2] },
  protect: { effectId: "protect", target: "self", failsIfLastAction: true },
  detect: { effectId: "protect", target: "self", failsIfLastAction: true },
  willowisp: { effectId: "major-status", statusId: "brn", immuneTypes: ["fire"], immuneAbilities: ["waterveil", "waterbubble"] },
  toxic: { effectId: "major-status", statusId: "tox", immuneTypes: ["poison", "steel"], immuneAbilities: ["immunity", "pastelveil"] },
  poisonpowder: { effectId: "major-status", statusId: "psn", immuneTypes: ["poison", "steel"], immuneAbilities: ["immunity", "pastelveil"] },
  thunderwave: { effectId: "major-status", statusId: "par", ignoreImmunity: false, moveImmuneTypes: ["ground"], immuneAbilities: ["limber"] },
  stunspore: { effectId: "major-status", statusId: "par", immuneAbilities: ["limber"] },
  glare: { effectId: "major-status", statusId: "par", immuneAbilities: ["limber"] },
  raindance: { effectId: "set-field", target: "field", fieldKind: "weather", fieldId: "rain", durationTurns: 5 },
  sunnyday: { effectId: "set-field", target: "field", fieldKind: "weather", fieldId: "sun", durationTurns: 5 },
  sandstorm: { effectId: "set-field", target: "field", fieldKind: "weather", fieldId: "sand", durationTurns: 5 },
  hail: { effectId: "set-field", target: "field", fieldKind: "weather", fieldId: "hail", durationTurns: 5 }
});

export const RESOLVER_RULESET = Object.freeze({
  id: "plc-core-v3",
  battleFormats: ["singles", "doubles", "triples"],
  actionTypes: ["move", "switch", "shift"],
  battleItemsEnabled: false
});

export function moveSupport(move, dataset = null) {
  if (!move) return { supported: false, reason: "Move data is unavailable" };
  if (hasShowdownMoveReference(dataset)) return vw2rMoveSupport(move, dataset);
  const descriptor = EFFECTS[toId(move.id || move.name)];
  if (!descriptor) {
    return {
      supported: false,
      reason: `${move.name || move.id} has no structured PLC resolver effect yet`
    };
  }
  if (Array.isArray(move.multihit)) {
    return { supported: false, reason: `${move.name || move.id} multi-hit branching is not enabled yet` };
  }
  return { supported: true, ...descriptor };
}

export function supportedMoveIds(dataset = null) {
  return hasShowdownMoveReference(dataset) ? vw2rReferenceMoveIds(dataset) : Object.keys(EFFECTS);
}
