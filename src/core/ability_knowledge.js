import { activeEntries, activeSlotKeys } from "./battle_slots.js?v=20260905-drafts-freecalc-partners-v1";
import { toId } from "./primitives.js?v=20260905-drafts-freecalc-partners-v1";

// This is observation bookkeeping, not an ability mechanics table. The selected
// Dataset profile supplies the storage and revelation policy.
export function initializeAbilityKnowledge(state, policy) {
  if (!policy) return;
  if (policy.storage?.key !== "side-and-field-slot") throw new Error("Unsupported AI ability memory policy");
  if (state.trainerAiBelief?.modelId === policy.modelId) return;
  state.trainerAiBelief = {
    modelId: policy.modelId,
    abilityByPosition: {
      player: activeSlotKeys(state, "player").map(() => null),
      enemy: activeSlotKeys(state, "enemy").map(() => null)
    }
  };
}

export function clearFaintedAbilityKnowledge(state, policy) {
  if (!policy || policy.storage.onFaint !== "clear-current-slot") return;
  initializeAbilityKnowledge(state, policy);
  for (const entry of activeEntries(state)) {
    if (Number(state.combatantStates[entry.combatantKey]?.hp?.max) <= 0) {
      state.trainerAiBelief.abilityByPosition[entry.side][entry.slot] = null;
    }
  }
}

export function observeAbilityEvent(state, event, policy) {
  if (!policy) return;
  initializeAbilityKnowledge(state, policy);
  let abilityId;
  let ownerKey;
  if (event.eventType === policy.revelation.immunityEventType) {
    abilityId = toId(event.metadata?.abilityId);
    ownerKey = event.targetKey;
  } else if (policy.revelation.causeEventTypes?.includes(event.eventType)) {
    abilityId = toId(event.metadata?.cause);
    // A move/item cause is not an ability revelation. Resolve the ability owner
    // from the actual event participants, never from mere presence in the party.
    ownerKey = [event.actorKey, event.targetKey].find(key => key
      && !state.combatantStates[key]?.abilitySuppressed
      && toId(state.combatantStates[key]?.currentAbilityId) === abilityId);
  }
  if (abilityId && ownerKey) {
    const entry = activeEntries(state).find(row => row.combatantKey === ownerKey);
    if (entry) {
      state.trainerAiBelief.abilityByPosition[entry.side][entry.slot] = abilityId;
      event.metadata ||= {};
      event.metadata.abilityObservation = { side: entry.side, slot: entry.slot, abilityId };
    }
  }
  // Fainting wins over a final contact/Aftermath revelation. Position changes do
  // not move this table; actual abilities remain attached to combatants.
  clearFaintedAbilityKnowledge(state, policy);
}

export function entryAbilityAnnouncement(state, combatantKey, policy) {
  const mon = state.combatantStates[combatantKey];
  const abilityId = mon?.abilitySuppressed ? "" : toId(mon?.currentAbilityId);
  return policy?.revelation.entryAnnouncementAbilityIds?.includes(abilityId)
    ? { eventType: "ability-announced", actorKey: combatantKey, targetKey: combatantKey,
      metadata: { cause: abilityId, resultLabel: `${abilityId} revealed on entry` } }
    : null;
}
