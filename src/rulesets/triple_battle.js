import { activeKey, activeSlotEntries, actorSlot, battleFormat } from "../core/battle_slots.js?v=20260905-drafts-freecalc-partners-v1";

export const TRIPLE_POSITIONS = Object.freeze({ left: 0, center: 1, right: 2 });
const PLAYER_SLOT_BY_POSITION = Object.freeze([0, 1, 2]);
const ENEMY_SLOT_BY_POSITION = Object.freeze([1, 2, 0]);
const PLAYER_POSITION_BY_SLOT = Object.freeze([0, 1, 2]);
const ENEMY_POSITION_BY_SLOT = Object.freeze([2, 0, 1]);

export function isTripleBattle(value) {
  return battleFormat(value) === "triples";
}

export function triplePositionForSlot(value, side, slot) {
  const normalized = Number(slot);
  if (!isTripleBattle(value) || !Number.isInteger(normalized)) return normalized;
  return (side === "enemy" ? ENEMY_POSITION_BY_SLOT : PLAYER_POSITION_BY_SLOT)[normalized] ?? normalized;
}

export function tripleSlotForPosition(value, side, position) {
  const normalized = Number(position);
  if (!isTripleBattle(value) || !Number.isInteger(normalized)) return normalized;
  return (side === "enemy" ? ENEMY_SLOT_BY_POSITION : PLAYER_SLOT_BY_POSITION)[normalized] ?? normalized;
}

export function areSlotsAdjacent(value, sourceSide, sourceSlot, targetSide, targetSlot) {
  const from = triplePositionForSlot(value, sourceSide, sourceSlot);
  const to = triplePositionForSlot(value, targetSide, targetSlot);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) return false;
  if (!isTripleBattle(value)) return sourceSide !== targetSide || from !== to;
  if (sourceSide === targetSide) return Math.abs(from - to) === 1;
  // Both rows resolve through the player's shared top-down left/center/right positions.
  return Math.abs(from - to) <= 1;
}

export function combatantsAreAdjacent(state, sourceSide, sourceKey, targetSide, targetKey, value = "triples") {
  const sourceSlot = actorSlot(state, sourceSide, sourceKey);
  const targetSlot = actorSlot(state, targetSide, targetKey);
  return areSlotsAdjacent(value, sourceSide, sourceSlot, targetSide, targetSlot);
}

export function adjacentActiveEntries(state, sourceSide, sourceKey, targetSide, value = "triples") {
  const sourceSlot = actorSlot(state, sourceSide, sourceKey);
  return activeSlotEntries(state, targetSide).filter(entry => areSlotsAdjacent(value, sourceSide, sourceSlot, targetSide, entry.slot));
}

export function canSelectShift(value, state, side, actorKey) {
  if (!isTripleBattle(value)) return false;
  const slot = actorSlot(state, side, actorKey);
  const position = triplePositionForSlot(value, side, slot);
  return position === TRIPLE_POSITIONS.left || position === TRIPLE_POSITIONS.right;
}

export function shiftWithCenter(state, side, actorKey) {
  const fromSlot = actorSlot(state, side, actorKey);
  const fromPosition = triplePositionForSlot("triples", side, fromSlot);
  if (fromPosition !== TRIPLE_POSITIONS.left && fromPosition !== TRIPLE_POSITIONS.right) return null;
  const centerSlot = tripleSlotForPosition("triples", side, TRIPLE_POSITIONS.center);
  const centerKey = activeKey(state, side, centerSlot);
  return { fromSlot, centerSlot, centerKey };
}
