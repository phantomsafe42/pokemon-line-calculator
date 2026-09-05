import { activeEntries, activeKey, activeSlotEntries, actorSlot, battleFormat } from "../core/battle_slots.js";

export function isRotationBattle(value) {
  return battleFormat(value) === "rotation";
}

export function rotationFrontSlot(state, side) {
  const value = Number(state?.rotation?.frontSlots?.[side] ?? 0);
  return Number.isInteger(value) && value >= 0 && value < 3 ? value : 0;
}

export function rotationFrontKey(state, side) {
  return activeKey(state, side, rotationFrontSlot(state, side));
}

export function participatingActiveEntries(state) {
  if (!state?.rotation) return activeEntries(state);
  return ["player", "enemy"].map(side => {
    const slot = rotationFrontSlot(state, side);
    return { side, slot, combatantKey: activeKey(state, side, slot) };
  }).filter(entry => entry.combatantKey && Number(state.combatantStates?.[entry.combatantKey]?.hp?.max) > 0);
}

export function participatingActiveKeys(state, side) {
  if (!state?.rotation) return activeSlotEntries(state, side).map(entry => entry.combatantKey);
  const key = rotationFrontKey(state, side);
  return key ? [key] : [];
}

export function rotateToActor(state, side, actorKey) {
  if (!state?.rotation) return null;
  const toSlot = actorSlot(state, side, actorKey);
  if (toSlot < 0) return null;
  const fromSlot = rotationFrontSlot(state, side);
  state.rotation.frontSlots[side] = toSlot;
  return { side, actorKey, fromSlot, toSlot, changed: fromSlot !== toSlot };
}
