import { activeKeys } from './battle_slots.js?v=20260905-drafts-freecalc-partners-v1';

// Slot ownership is fixed for the encounter, not transferred on a switch or faint.
export function partyOwnerForSlot(plan, side, slot) {
  return plan.game?.partyOwnership?.[side]?.slotOwnerIds?.[slot] ?? null;
}

export function belongsToSlotParty(plan, combatant, side, slot) {
  if (!combatant || combatant.side !== side) return false;
  const owner = partyOwnerForSlot(plan, side, slot);
  return owner === null || combatant.source?.partyOwnerId === owner;
}

export function eligibleReserves(plan, state, side, slot, excludedKeys = []) {
  const excluded = new Set([...activeKeys(state, side), ...excludedKeys]);
  return Object.values(plan.combatants).filter(mon => belongsToSlotParty(plan, mon, side, slot)
    && !excluded.has(mon.combatantKey) && Number(state.combatantStates[mon.combatantKey]?.hp?.max) > 0);
}
