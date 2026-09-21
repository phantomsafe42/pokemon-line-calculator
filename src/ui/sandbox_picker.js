import { activeKey, activeKeys } from '../core/battle_slots.js';
import { belongsToSlotParty } from '../core/party_ownership.js';
import { createCombatantState } from '../core/plan.js';

const boxIdentity = mon => mon.source?.boxId != null && mon.source?.uniqueKey != null
  ? JSON.stringify([mon.source.boxId, mon.source.uniqueKey]) : null;

// Order is presentation-only. Keep the existing branch combatant (including
// edits), but use the canonical Box roster's position, not admission recency.
export function orderSandboxCandidates(candidates, boxRoster) {
  const identityOrder = new Map(), keyOrder = new Map();
  boxRoster.forEach((mon, index) => {
    const identity = boxIdentity(mon);
    if (identity !== null && !identityOrder.has(identity)) identityOrder.set(identity, index);
    if (!keyOrder.has(mon.combatantKey)) keyOrder.set(mon.combatantKey, index);
  });
  const rank = mon => identityOrder.get(boxIdentity(mon)) ?? keyOrder.get(mon.combatantKey) ?? Infinity;
  return [...candidates].sort((a, b) => {
    const ar = rank(a), br = rank(b);
    return ar === br ? 0 : ar < br ? -1 : 1;
  });
}

// Rendering the Box library must not admit its records into the plan. Prefer
// branch state over Box defaults so used Pokémon retain damage and status.
export function sandboxPickerCandidates(plan, state, side, slot, candidates, { replace = false } = {}) {
  const current = activeKey(state, side, slot);
  const otherActive = new Set(activeKeys(state, side).filter(key => key !== current));
  return [...candidates].filter(mon => {
    if (!belongsToSlotParty(plan, mon, side, slot) || otherActive.has(mon.combatantKey)) return false;
    if (replace) return true;
    const currentState = state.combatantStates[mon.combatantKey]
      || createCombatantState(mon, mon.source?.boxInitialConditions);
    return Number(currentState.hp.max) > 0;
  });
}
