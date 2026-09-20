import { activeKey, activeKeys } from '../core/battle_slots.js';
import { belongsToSlotParty } from '../core/party_ownership.js';
import { createCombatantState } from '../core/plan.js';

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
