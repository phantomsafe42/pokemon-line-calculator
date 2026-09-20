import { clone } from './primitives.js';
import { addFreeCalcBranch, editFreeCalcCombatant, replaceFreeCalcSlot, refreshFreeCalcBoundary } from './free_calc.js?v=20260920-held-item-activation-v2';
import { createCombatantState, touchPlan, updateStateHash } from './plan.js';
import { belongsToSlotParty } from './party_ownership.js';
import { assertValidPlanDocument } from '../contracts/plan_contract.js';

export const isSandbox = plan => plan?.game?.planningMode === 'sandbox';

// Copy-on-edit is a transaction: invalid controls cannot create an empty branch
// or partially mutate a previously committed turn. Uncommitted edits share one
// snapshot boundary, which also survives cache/export/import and replay.
function editBoundary(original, stateId, operation) {
  if (!isSandbox(original)) throw new Error('This line is not a Sandbox');
  const state = original.stateNodes[stateId];
  if (!state) throw new Error('Select an existing Sandbox node');
  const reusable = state.sandboxEdit && state.parentManualTransitionId
    && ![...(state.childActionGroupIds || []), ...(state.childReplacementTransitionIds || []), ...(state.childManualTransitionIds || [])].length;
  // Validate the finished transaction below, not an intermediate unedited copy
  // of the entire history as well. Keep independent snapshots for all nodes.
  const result = reusable ? { plan: clone(original), stateId } : addFreeCalcBranch(original, stateId, { validate: false });
  operation(result.plan, result.stateId);
  const edited = result.plan.stateNodes[result.stateId];
  delete edited.trainerAiForecast;
  result.plan.workingDraft = null;
  refreshFreeCalcBoundary(result.plan, edited);
  touchPlan(result.plan); updateStateHash(edited);
  assertValidPlanDocument(result.plan);
  return result;
}

export function editSandboxCombatant(plan, stateId, key, changes, dataset) {
  return editBoundary(plan, stateId, (next, id) => editFreeCalcCombatant(next, id, key, changes, dataset));
}

export function placeSandboxCombatant(plan, stateId, side, slot, combatant) {
  return editBoundary(plan, stateId, (next, id) => replaceFreeCalcSlot(next, id, side, slot, combatant));
}

// Admission only copies a selected Box record into this branch's roster. The
// ordinary resolver still owns the actual Switch and its entry effects.
export function admitSandboxReserve(plan, stateId, side, slot, combatant) {
  return editBoundary(plan, stateId, (next, id) => {
    if (side !== 'player' || combatant?.source?.isPlayerPartner || !belongsToSlotParty(next, combatant, side, slot)) throw new Error('Only player Box Pokémon can join this slot');
    const key = combatant.combatantKey;
    next.combatants[key] ||= clone(combatant);
    next.stateNodes[id].combatantStates[key] ||= createCombatantState(next.combatants[key], combatant.source?.boxInitialConditions);
  });
}
