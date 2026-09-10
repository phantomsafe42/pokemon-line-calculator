import { toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";

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
