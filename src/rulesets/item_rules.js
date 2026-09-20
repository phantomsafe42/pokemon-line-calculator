import { toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { activeAbilityId } from "./ability_rules.js?v=20260905-drafts-freecalc-partners-v1";

const STATE_CONDITIONS = new Set(['battleGenerations', 'hpThreshold', 'gluttonyHpThreshold', 'requiresHealingAllowed', 'blockedByOpponentAbilityIds', 'anyStatusIds', 'requiresDepletedMovePp']);
const STATE_EFFECTS = new Set(['heal', 'cure-status', 'restore-pp', 'stat-stages']);

function validEffect(effect) {
  if (!STATE_EFFECTS.has(effect.kind)) return false;
  const fields = {
    heal: ['kind', 'amount', 'numerator', 'denominator'],
    'cure-status': ['kind', 'statusIds'],
    'restore-pp': ['kind', 'amount', 'selection'],
    'stat-stages': ['kind', 'stages']
  }[effect.kind];
  if (Object.keys(effect).some(key => !fields.includes(key))) return false;
  if (effect.kind === 'heal') return Number.isInteger(effect.amount) && effect.amount > 0
    || effect.amount === undefined && Number.isInteger(effect.numerator) && effect.numerator > 0 && Number.isInteger(effect.denominator) && effect.denominator > 0;
  if (effect.kind === 'restore-pp') return Number.isInteger(effect.amount) && effect.amount > 0 && effect.selection === 'first-depleted-move';
  if (effect.kind === 'cure-status') return Array.isArray(effect.statusIds) && effect.statusIds.length > 0
    && effect.statusIds.every(id => ['brn', 'par', 'psn', 'tox', 'slp', 'frz', 'confusion'].includes(id));
  return effect.stages && Object.keys(effect.stages).length > 0 && Object.entries(effect.stages).every(([stat, value]) =>
    ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'].includes(stat) && Number.isInteger(value) && value > 0 && value <= 6);
}

// This is an interpreter for Dataset rules, not an item-name registry. Unknown
// executable conditions/effects must never silently turn into an unconditional
// consumption. The resolver partitions HP probability mass at hpThreshold.
export function heldStateItemActivation({ dataset, state, activeItemId, generation, timing = 'state-update', opposingStates = [], moves = [] }) {
  if (!state || state.itemState !== 'held' || Number(state.hp?.max) <= 0 || !activeItemId) return null;
  const itemId = toId(state.currentItemId);
  if (itemId !== toId(activeItemId)) return null;
  const item = dataset?.get('items', itemId);
  const mechanics = item?.heldItemMechanics;
  if (mechanics?.schemaVersion !== 'held-item-mechanics/v1' || mechanics.activationStatus !== 'modeled') return null;
  const rules = (mechanics.activations || []).filter(rule => rule.trigger === 'holder-state' && rule.timing === timing);
  for (const rule of rules) {
    if (rule.consumeOnActivation !== true || !rule.effects?.length
      || !Array.isArray(rule.conditions?.battleGenerations) || !rule.conditions.battleGenerations.length
      || rule.conditions.battleGenerations.some(value => !Number.isInteger(value) || value < 1 || value > 9)
      || Object.keys(rule.conditions).some(key => !STATE_CONDITIONS.has(key))
      || rule.effects.some(effect => !validEffect(effect))) throw new Error(`${item.name}: unsupported held-item activation contract`);
    if (!rule.conditions.battleGenerations.includes(generation)) continue;
    const conditions = rule.conditions;
    if (opposingStates.some(mon => Number(mon?.hp?.max) > 0 && conditions.blockedByOpponentAbilityIds?.includes(activeAbilityId(mon)))) continue;
    if (conditions.requiresHealingAllowed && Number(state.volatileConditions?.healBlockTurns || 0) > 0) continue;
    const confused = Number(state.volatileConditions?.confusionTurns || 0) > 0
      || state.volatileConditions?.confusionCounterDistribution?.some(entry => entry.value > 0);
    if (conditions.anyStatusIds && !conditions.anyStatusIds.some(id => id === 'confusion' ? confused : state.majorStatus === id)) continue;
    const depletedMove = moves.find(move => Number(state.movePp?.[move.moveId]) === 0 && Number(move.maxPp) > 0);
    if (conditions.requiresDepletedMovePp && !depletedMove) continue;
    const threshold = activeAbilityId(state) === 'gluttony' && conditions.gluttonyHpThreshold
      ? conditions.gluttonyHpThreshold : conditions.hpThreshold;
    const hpThreshold = threshold ? Number(state.hp.maxHp) * threshold.numerator / threshold.denominator : null;
    if (threshold && (!Number.isFinite(hpThreshold) || threshold.denominator <= 0)) throw new Error(`${item.name}: invalid HP threshold`);
    if (hpThreshold !== null && Number(state.hp.min) > hpThreshold) continue;
    return { itemId, itemName: item.name || itemId, activationId: rule.id, consumptionMethod: mechanics.consumptionMethod,
      effects: rule.effects, hpThreshold, depletedMove };
  }
  return null;
}

function appliedIds(value) {
  return new Set((Array.isArray(value) ? value : [value]).map(toId).filter(Boolean));
}

export function damageReductionItemActivation({ dataset, defenderState, appliedDefenderItemIds }) {
  if (!dataset || defenderState?.itemState !== "held") return null;
  const itemId = toId(defenderState.currentItemId);
  if (!itemId || !appliedIds(appliedDefenderItemIds).has(itemId)) return null;
  const item = dataset.get("items", itemId);
  const mechanics = item?.heldItemMechanics;
  if (mechanics?.schemaVersion !== "held-item-mechanics/v1"
    || mechanics.lifecycle !== "consumable"
    || mechanics.activationStatus !== "modeled") return null;
  const activation = mechanics.activations?.find(entry => entry.trigger === "incoming-damaging-move"
    && entry.consumeOnActivation === true
    && entry.effects?.some(effect => effect.kind === "damage-multiplier"));
  if (!activation) return null;
  return {
    itemId,
    itemName: item.name || item.calcName || itemId,
    activationId: activation.id,
    consumptionMethod: mechanics.consumptionMethod,
  };
}

export function afterDamagingMoveItemActivation({ dataset, defenderState, activeItemId, damage, throughSubstitute = false }) {
  if (!dataset || defenderState?.itemState !== "held" || Number(damage) <= 0) return null;
  const itemId = toId(defenderState.currentItemId);
  if (!itemId || itemId !== toId(activeItemId)) return null;
  const item = dataset.get("items", itemId);
  const mechanics = item?.heldItemMechanics;
  if (mechanics?.schemaVersion !== "held-item-mechanics/v1"
    || !["consumable", "breakable"].includes(mechanics.lifecycle)
    || mechanics.activationStatus !== "modeled") return null;
  const activation = mechanics.activations?.find(entry => entry.trigger === "after-damaging-move"
    && entry.consumeOnActivation === true
    && entry.effects?.some(effect => effect.kind === "remove-held-item")
    && (!throughSubstitute || entry.conditions?.blockedBySubstitute !== true));
  if (!activation) return null;
  return {
    itemId,
    itemName: item.name || item.calcName || itemId,
    activationId: activation.id,
    consumptionMethod: mechanics.consumptionMethod,
  };
}
