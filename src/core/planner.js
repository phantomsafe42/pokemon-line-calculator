import { assertValidPlanDocument } from "../contracts/plan_contract.js";
import { actionSignature, nextCreatedOrder, touchPlan, updateStateHash } from "./plan.js?v=20260827-ability-form-events";
import { clone, shortHash, stableStringify } from "./primitives.js";
import { resolveForcedReplacement, resolveTurn } from "./resolver.js?v=20260827-ability-form-events";
import { actionList, activeKey, activeSlotEntries, normalizeActionsForPlan, normalizeReplacementsForPlan, pendingReplacementSlots, replacementList } from "./battle_slots.js";

function displayAction(action, events, plan, dataset) {
  if (!action) return null;
  if (action.actionType === "switch") {
    return {
      actionType: "switch",
      switchToKey: action.switchToKey,
      resultLabel: `Switch to ${plan.combatants[action.switchToKey].displayName}`
    };
  }
  if (action.actionType === "shift") {
    return {
      actionType: "shift",
      resultLabel: "Shifted position"
    };
  }
  const move = dataset.get("moves", action.moveId);
  const damages = events.filter(entry => entry.eventType === "damage" && entry.actorKey === action.actorKey);
  const skipped = events.find(entry => entry.eventType === "action-skipped" && entry.actorKey === action.actorKey);
  const miss = events.find(entry => entry.eventType === "miss" && entry.actorKey === action.actorKey);
  const structuredEffect = events.find(entry => ["stat-stage-change", "heal", "protect", "major-status", "status-failed", "field-change", "move-blocked", "move-immune"].includes(entry.eventType) && entry.actorKey === action.actorKey);
  const output = { actionType: "move", moveId: action.moveId, moveName: move?.name || action.moveId };
  const targetEvents = events.filter(entry => entry.actorKey === action.actorKey && entry.targetKey && ["damage", "move-blocked", "move-immune", "miss", "action-skipped", "major-status", "status-failed"].includes(entry.eventType));
  const multiTarget = new Set(targetEvents.map(entry => entry.targetKey)).size > 1;
  if (multiTarget) {
    const targetKeys = [...new Set(targetEvents.map(entry => entry.targetKey))];
    output.resultLabel = targetKeys.map(targetKey => {
      const target = plan.combatants[targetKey];
      const targetEvent = [...targetEvents].reverse().find(entry => entry.targetKey === targetKey);
      let result = targetEvent.metadata?.resultLabel || targetEvent.reason || targetEvent.eventType;
      if (targetEvent.damagePercent) {
        result = `${Number(targetEvent.damagePercent.min).toFixed(1)}–${Number(targetEvent.damagePercent.max).toFixed(1)}%`;
      } else if (targetEvent.eventType === "miss") {
        result = "Miss";
      }
      return `${target?.nickname || target?.displayName || "target"} ${result}`;
    }).join(" · ");
  } else if (damages.length === 1 && damages[0].damagePercent) {
    const damage = damages[0];
    const min = Number(damage.damagePercent.min);
    const max = Number(damage.damagePercent.max);
    output.damagePercent = { min, max, label: `${min.toFixed(1)}–${max.toFixed(1)}%` };
  }
  if (!multiTarget && skipped) output.resultLabel = skipped.metadata?.resultLabel || (skipped.reason === "actor-fainted-before-moving" ? "Fainted before moving" : skipped.reason);
  if (!multiTarget && miss) output.resultLabel = "Miss";
  if (!multiTarget && structuredEffect?.metadata?.resultLabel) output.resultLabel = structuredEffect.metadata.resultLabel;
  return output;
}

function displaySide(side, slot, state, actions, events, plan, dataset) {
  const key = activeKey(state, side, slot);
  const mon = plan.combatants[key];
  const monState = state.combatantStates[key];
  const action = actionList(actions, side).find(entry => entry.actorKey === key || (entry.actionType === "switch" && entry.switchToKey === key));
  return {
    combatantKey: key,
    speciesId: monState?.currentSpeciesId || mon.speciesId,
    displayName: mon.nickname || mon.displayName,
    spriteId: monState?.currentSpriteId || mon.formId || mon.speciesId,
    slot,
    action: displayAction(action, events, plan, dataset)
  };
}

function replacementDisplaySide(side, slot, state, replacements, plan) {
  const key = activeKey(state, side, slot);
  const mon = plan.combatants[key];
  const monState = state.combatantStates[key];
  const action = replacementList(replacements, side).find(entry => Number(entry.slot ?? 0) === slot);
  return {
    combatantKey: key,
    speciesId: monState?.currentSpeciesId || mon.speciesId,
    displayName: mon.nickname || mon.displayName,
    spriteId: monState?.currentSpriteId || mon.formId || mon.speciesId,
    slot,
    action: action ? {
      actionType: "replacement",
      switchToKey: action.switchToKey,
      resultLabel: `Send out ${mon.nickname || mon.displayName}`
    } : null
  };
}

function chooseDefault(outcomes) {
  const known = outcomes.filter(outcome => Number.isFinite(outcome.outcome.probability));
  if (!known.length) return outcomes[0];
  return [...known].sort((left, right) => right.outcome.probability - left.outcome.probability || left.state.stateHash.localeCompare(right.state.stateHash))[0];
}

function outcomeIdentity(entry, suppliedEvents = null) {
  const state = entry?.state || entry;
  const outcome = entry?.outcome || state?.outcome || {};
  const events = suppliedEvents || entry?.events || [];
  const conditions = (outcome.conditions || []).map(condition => condition?.expression || condition).filter(Boolean).sort();
  const branchEvents = events.filter(event => [
    "ability-change", "action-skipped", "confusion-check", "confusion-self-hit", "damage", "form-change", "major-status", "miss", "move-blocked", "move-immune",
    "order-modifier", "secondary-effect-missed", "status-cleared", "volatile-status", "volatile-status-cleared"
  ].includes(event.eventType)).map(event => ({
    eventType: event.eventType,
    actorKey: event.actorKey || null,
    targetKey: event.targetKey || null,
    moveId: event.moveId || null,
    reason: event.reason || null,
    criticalHit: event.metadata?.criticalHit ?? null,
    thresholdOutcome: event.metadata?.thresholdOutcome || null,
    statusId: event.metadata?.statusId || event.metadata?.volatileStatusId || null,
    outcome: event.metadata?.outcome || null,
    orderModifierId: event.metadata?.modifierId || null,
    orderModifierActivated: event.metadata?.activated ?? null
  }));
  return stableStringify({ stateHash: state?.stateHash || null, conditions, branchEvents });
}

function savedOutcomeIdentity(plan, stateId) {
  const state = plan.stateNodes[stateId];
  const events = (state?.resolutionEventIds || []).map(eventId => plan.resolutionEvents[eventId]).filter(Boolean);
  return outcomeIdentity(state, events);
}

function criticalOutcomeSignature(events = []) {
  return events
    .filter(entry => entry?.metadata?.criticalHit === true)
    .map(entry => `${entry.eventType}:${entry.actorKey || ""}:${entry.targetKey || ""}:${entry.moveId || ""}:${entry.metadata?.criticalHits || 1}`)
    .join("|");
}

function resolverOutcomeKey(entry, suppliedEvents = null) {
  const state = entry?.state || entry;
  const events = suppliedEvents || entry?.events || [];
  return `${state?.stateHash || ""}::${criticalOutcomeSignature(events)}`;
}

function savedResolverOutcomeKey(plan, stateId) {
  const state = plan.stateNodes[stateId];
  const events = (state?.resolutionEventIds || []).map(eventId => plan.resolutionEvents[eventId]).filter(Boolean);
  return resolverOutcomeKey(state, events);
}

function unknownOutcomeProbability(outcome) {
  const probability = outcome?.probability;
  return outcome?.probabilityStatus === "unknown"
    || probability === null
    || probability === undefined
    || probability === ""
    || !Number.isFinite(Number(probability));
}

export function refreshUnknownCommittedProbabilities(plan, preview) {
  if (preview?.previewStatus !== "existing-expanded") return { plan, changed: false, refreshedStateNodeIds: [] };
  const group = plan.actionGroups?.[preview.existingActionGroupId];
  if (!group) return { plan, changed: false, refreshedStateNodeIds: [] };

  const freshByIdentity = new Map();
  const freshByResolverKey = new Map();
  for (const fresh of preview.outcomes || []) {
    freshByIdentity.set(outcomeIdentity(fresh), fresh);
    const key = resolverOutcomeKey(fresh);
    const matches = freshByResolverKey.get(key) || [];
    matches.push(fresh);
    freshByResolverKey.set(key, matches);
  }

  const updates = [];
  for (const stateId of group.outcomeStateNodeIds || []) {
    const saved = plan.stateNodes[stateId];
    if (!saved || !unknownOutcomeProbability(saved.outcome)) continue;
    let fresh = freshByIdentity.get(savedOutcomeIdentity(plan, stateId));
    if (!fresh) {
      const stateMatches = freshByResolverKey.get(savedResolverOutcomeKey(plan, stateId)) || [];
      if (stateMatches.length === 1) fresh = stateMatches[0];
    }
    if (!fresh || unknownOutcomeProbability(fresh.outcome)) continue;
    updates.push({
      stateId,
      probability: Number(fresh.outcome.probability),
      probabilityStatus: fresh.outcome.probabilityStatus || "known"
    });
  }
  if (!updates.length) return { plan, changed: false, refreshedStateNodeIds: [] };

  const next = clone(plan);
  for (const update of updates) {
    next.stateNodes[update.stateId].outcome.probability = update.probability;
    next.stateNodes[update.stateId].outcome.probabilityStatus = update.probabilityStatus;
  }
  touchPlan(next);
  assertValidPlanDocument(next);
  return { plan: next, changed: true, refreshedStateNodeIds: updates.map(update => update.stateId) };
}

function leadingReplacementEvents(plan, stateNodeId) {
  const segments = [];
  let state = plan.stateNodes[stateNodeId];
  while (state?.parentReplacementTransitionId) {
    segments.unshift((state.resolutionEventIds || []).map(eventId => plan.resolutionEvents[eventId]).filter(Boolean));
    const transition = plan.replacementTransitions?.[state.parentReplacementTransitionId];
    state = transition ? plan.stateNodes[transition.parentStateNodeId] : null;
  }
  return segments.flat().map(entry => ({
    ...clone(entry),
    metadata: { ...(entry.metadata || {}), phase: "start-of-turn-replacement" }
  }));
}

function leadingInitialEntryEvents(plan, stateNodeId) {
  if (stateNodeId !== plan.initialStateNodeId) return [];
  const root = plan.stateNodes[stateNodeId];
  return (root?.resolutionEventIds || []).map(eventId => plan.resolutionEvents[eventId]).filter(Boolean).map(entry => ({
    ...clone(entry),
    metadata: { ...(entry.metadata || {}), phase: "initial-entry" }
  }));
}

function leadingTurnEvents(plan, stateNodeId) {
  return [
    ...leadingInitialEntryEvents(plan, stateNodeId),
    ...leadingReplacementEvents(plan, stateNodeId)
  ];
}

function committedEvent(rawEvent, eventId, turnNumber, step) {
  const saved = clone(rawEvent);
  delete saved.eventId;
  delete saved.turnNumber;
  delete saved.step;
  return { ...saved, eventId, source: "planned", turnNumber, step };
}

export function previewTurn({ plan, parentStateNodeId, actions, dataset, damageAdapter, moveSupport, expandExisting = false }) {
  actions = normalizeActionsForPlan(plan, actions, plan.stateNodes[parentStateNodeId]);
  const signature = actionSignature(parentStateNodeId, actions);
  const existing = Object.values(plan.actionGroups).find(group => group.parentStateNodeId === parentStateNodeId && group.actionSignature === signature);
  if (existing && !expandExisting) {
    const leadingEvents = leadingTurnEvents(plan, parentStateNodeId);
    return {
      baseStateNodeId: parentStateNodeId,
      proposedTurnNumber: existing.turnNumber,
      actions: clone(actions),
      actionSignature: signature,
      previewRevision: Number(plan.documentRevision) + 1,
      previewStatus: "existing",
      existingActionGroupId: existing.actionGroupId,
      outcomes: existing.outcomeStateNodeIds.map(id => {
        const state = clone(plan.stateNodes[id]);
        state.events = (state.resolutionEventIds || []).map(eventId => clone(plan.resolutionEvents[eventId])).filter(Boolean);
        if (leadingEvents.length && !state.events.some(event => ["initial-entry", "start-of-turn-replacement"].includes(event.metadata?.phase))) {
          state.events = [...clone(leadingEvents), ...state.events];
        }
        return state;
      }),
      defaultPreviewOutcomeId: existing.defaultOutcomeStateNodeId
    };
  }
  const leadingEvents = leadingTurnEvents(plan, parentStateNodeId);
  const outcomes = resolveTurn({ plan, parentStateNodeId, actions, dataset, damageAdapter, moveSupport }).map(outcome => ({
    ...outcome,
    events: [...clone(leadingEvents), ...outcome.events]
  }));
  const savedStateByIdentity = existing ? new Map(existing.outcomeStateNodeIds.map(stateId => [savedOutcomeIdentity(plan, stateId), stateId])) : null;
  const savedIdentities = savedStateByIdentity ? new Set(savedStateByIdentity.keys()) : null;
  const selected = existing
    ? outcomes.find(outcome => outcomeIdentity(outcome) === savedOutcomeIdentity(plan, existing.defaultOutcomeStateNodeId)) || chooseDefault(outcomes)
    : chooseDefault(outcomes);
  return {
    baseStateNodeId: parentStateNodeId,
    proposedTurnNumber: Number(plan.stateNodes[parentStateNodeId].turnNumber) + 1,
    actions: clone(actions),
    actionSignature: signature,
    previewRevision: Number(plan.documentRevision) + 1,
    previewStatus: existing ? "existing-expanded" : "ready",
    ...(existing ? {
      existingActionGroupId: existing.actionGroupId,
      savedPreviewOutcomeIds: outcomes.filter(outcome => savedIdentities.has(outcomeIdentity(outcome))).map(outcome => outcome.previewOutcomeId),
      savedOutcomeStateNodeIdByPreviewOutcomeId: Object.fromEntries(outcomes.map(outcome => [
        outcome.previewOutcomeId,
        savedStateByIdentity.get(outcomeIdentity(outcome)) || null
      ]).filter(([, stateId]) => stateId))
    } : {}),
    outcomes,
    defaultPreviewOutcomeId: selected.previewOutcomeId
  };
}

function appendCommittedOutcome(next, group, preview, outcome, outcomeIndex, order, dataset) {
  const groupId = group.actionGroupId;
  const stateId = `state-turn-${preview.proposedTurnNumber}-${shortHash(stableStringify({ groupId, outcomeIndex, hash: outcome.state.stateHash, outcome: outcome.outcome }))}`;
  const eventIds = [];
  outcome.events.forEach((rawEvent, eventIndex) => {
    const eventId = `event-${shortHash(stableStringify({ stateId, eventIndex, rawEvent }))}`;
    next.resolutionEvents[eventId] = committedEvent(rawEvent, eventId, preview.proposedTurnNumber, eventIndex + 1);
    eventIds.push(eventId);
  });
  const state = clone(outcome.state);
  state.notes = String(next.stateNodes[preview.baseStateNodeId]?.draftNote || "");
  state.draftNote = "";
  state.stateNodeId = stateId;
  state.parentActionGroupId = groupId;
  state.parentReplacementTransitionId = null;
  state.turnNumber = preview.proposedTurnNumber;
  state.createdOrder = order;
  state.outcome = clone(outcome.outcome);
  state.resolutionEventIds = eventIds;
  state.childActionGroupIds = [];
  state.childReplacementTransitionIds = [];
  state.status = "resolved";
  delete state.transitionKind;
  state.displaySnapshot = {
    turnNumber: preview.proposedTurnNumber,
    outcomeLabel: outcome.outcome.label,
    players: activeSlotEntries(state, "player").map(({ slot }) => displaySide("player", slot, state, preview.actions, outcome.events, next, dataset)),
    enemies: activeSlotEntries(state, "enemy").map(({ slot }) => displaySide("enemy", slot, state, preview.actions, outcome.events, next, dataset))
  };
  if (state.displaySnapshot.players.length === 1) state.displaySnapshot.player = state.displaySnapshot.players[0];
  if (state.displaySnapshot.enemies.length === 1) state.displaySnapshot.enemy = state.displaySnapshot.enemies[0];
  next.stateNodes[stateId] = state;
  group.outcomeStateNodeIds.push(stateId);
  return stateId;
}

export function commitPreview(plan, preview, dataset, { selectedPreviewOutcomeId = null, commitSelectedOnly = false } = {}) {
  if (preview.previewStatus === "existing") {
    const group = plan.actionGroups[preview.existingActionGroupId];
    const selectedStateId = selectedPreviewOutcomeId && group?.outcomeStateNodeIds?.includes(selectedPreviewOutcomeId)
      ? selectedPreviewOutcomeId
      : preview.defaultPreviewOutcomeId;
    return { plan, actionGroupId: preview.existingActionGroupId, cursorStateNodeId: selectedStateId, created: false };
  }
  if (preview.previewStatus === "existing-expanded") {
    const selectedId = selectedPreviewOutcomeId || preview.defaultPreviewOutcomeId;
    const selected = preview.outcomes?.find(outcome => outcome.previewOutcomeId === selectedId);
    if (!selected) throw new Error("The selected crafted outcome is no longer available");
    const existingGroup = plan.actionGroups[preview.existingActionGroupId];
    const identity = outcomeIdentity(selected);
    const savedStateId = existingGroup.outcomeStateNodeIds.find(stateId => savedOutcomeIdentity(plan, stateId) === identity);
    if (savedStateId) return { plan, actionGroupId: existingGroup.actionGroupId, cursorStateNodeId: savedStateId, created: false };
    if (!commitSelectedOnly) return { plan, actionGroupId: existingGroup.actionGroupId, cursorStateNodeId: existingGroup.defaultOutcomeStateNodeId, created: false };
    const next = clone(plan);
    const group = next.actionGroups[preview.existingActionGroupId];
    const stateId = appendCommittedOutcome(next, group, preview, selected, group.outcomeStateNodeIds.length, nextCreatedOrder(next), dataset);
    next.stateNodes[preview.baseStateNodeId].draftNote = "";
    next.workingDraft = null;
    touchPlan(next);
    assertValidPlanDocument(next);
    return { plan: next, actionGroupId: group.actionGroupId, cursorStateNodeId: stateId, created: true, outcomeAdded: true };
  }
  if (preview.previewStatus !== "ready" || !preview.outcomes?.length) throw new Error("Only a ready preview can be committed");
  const selectedId = selectedPreviewOutcomeId || preview.defaultPreviewOutcomeId;
  const committedOutcomes = commitSelectedOnly
    ? preview.outcomes.filter(outcome => outcome.previewOutcomeId === selectedId)
    : preview.outcomes;
  if (!committedOutcomes.length) throw new Error("The selected crafted outcome is no longer available");
  const next = clone(plan);
  const parent = next.stateNodes[preview.baseStateNodeId];
  const groupId = preview.actionSignature;
  if (next.actionGroups[groupId]) throw new Error(`Action group ${groupId} already exists`);
  let order = nextCreatedOrder(next);
  const group = {
    actionGroupId: groupId,
    parentStateNodeId: preview.baseStateNodeId,
    turnNumber: preview.proposedTurnNumber,
    createdOrder: order++,
    actions: clone(preview.actions),
    actionSignature: preview.actionSignature,
    outcomeSelectionMode: commitSelectedOnly ? "crafted" : "complete",
    outcomeStateNodeIds: [],
    defaultOutcomeStateNodeId: null,
    status: "resolved"
  };
  const previewToState = new Map();
  committedOutcomes.forEach((outcome, outcomeIndex) => {
    const stateId = appendCommittedOutcome(next, group, preview, outcome, outcomeIndex, order++, dataset);
    previewToState.set(outcome.previewOutcomeId, stateId);
  });
  group.defaultOutcomeStateNodeId = previewToState.get(selectedId) || previewToState.get(preview.defaultPreviewOutcomeId) || group.outcomeStateNodeIds[0];
  next.actionGroups[groupId] = group;
  parent.childActionGroupIds.push(groupId);
  parent.draftNote = "";
  next.workingDraft = null;
  touchPlan(next);
  assertValidPlanDocument(next);
  return { plan: next, actionGroupId: groupId, cursorStateNodeId: group.defaultOutcomeStateNodeId, created: true };
}

export function commitLabel(plan, parentStateNodeId, actions) {
  actions = normalizeActionsForPlan(plan, actions, plan.stateNodes[parentStateNodeId]);
  const signature = actionSignature(parentStateNodeId, actions);
  const children = plan.stateNodes[parentStateNodeId]?.childActionGroupIds || [];
  if (children.some(id => plan.actionGroups[id]?.actionSignature === signature)) return "Open Branch";
  return children.length ? "New Branch" : "Next Turn";
}

export function repairStaleLeafBattleEnd(plan, stateNodeId) {
  const state = plan?.stateNodes?.[stateNodeId];
  if (!state || !state.battleEnded) return { plan, changed: false, removedEventIds: [] };
  if ((state.childActionGroupIds || []).length || (state.childReplacementTransitionIds || []).length) {
    return { plan, changed: false, removedEventIds: [] };
  }
  const actuallyEnded = ["player", "enemy"].some(side => !Object.values(plan.combatants || {}).some(combatant =>
    combatant.side === side && Number(state.combatantStates?.[combatant.combatantKey]?.hp?.max) > 0
  ));
  if (actuallyEnded) return { plan, changed: false, removedEventIds: [] };

  const next = clone(plan);
  const repaired = next.stateNodes[stateNodeId];
  const removedEventIds = (repaired.resolutionEventIds || []).filter(eventId => next.resolutionEvents[eventId]?.eventType === "battle-ended");
  repaired.resolutionEventIds = (repaired.resolutionEventIds || []).filter(eventId => !removedEventIds.includes(eventId));
  repaired.battleEnded = false;
  updateStateHash(repaired);
  for (const eventId of removedEventIds) {
    const referencedElsewhere = Object.values(next.stateNodes).some(candidate => candidate.stateNodeId !== stateNodeId && (candidate.resolutionEventIds || []).includes(eventId));
    if (!referencedElsewhere) delete next.resolutionEvents[eventId];
  }
  touchPlan(next);
  assertValidPlanDocument(next);
  return { plan: next, changed: true, removedEventIds };
}

export function previewForcedReplacement({ plan, parentStateNodeId, replacements, dataset }) {
  replacements = normalizeReplacementsForPlan(plan, replacements);
  const outcomes = resolveForcedReplacement({ plan, parentStateNodeId, replacements, dataset });
  const signature = replacementTransitionSignature(parentStateNodeId, replacements);
  const existing = plan.replacementTransitions?.[signature] || null;
  const savedOutcomeStateNodeIdByPreviewOutcomeId = {};
  if (existing) {
    for (const outcome of outcomes) {
      const savedStateId = (existing.outcomeStateNodeIds || []).find(stateId =>
        plan.stateNodes?.[stateId]?.stateHash === outcome.state?.stateHash
      );
      if (savedStateId) savedOutcomeStateNodeIdByPreviewOutcomeId[outcome.previewOutcomeId] = savedStateId;
    }
  }
  return {
    baseStateNodeId: parentStateNodeId,
    replacements: clone(replacements),
    replacementTransitionId: signature,
    existingReplacementTransitionId: existing ? signature : null,
    savedPreviewOutcomeIds: Object.keys(savedOutcomeStateNodeIdByPreviewOutcomeId),
    savedOutcomeStateNodeIdByPreviewOutcomeId,
    previewRevision: Number(plan.documentRevision) + 1,
    previewStatus: "ready",
    outcomes,
    defaultPreviewOutcomeId: chooseDefault(outcomes).previewOutcomeId
  };
}

function replacementTransitionSignature(parentStateNodeId, replacements) {
  return `replacement-${shortHash(stableStringify({ parentStateNodeId, replacements }))}`;
}

export function replacementCommitLabel(plan, parentStateNodeId, replacements) {
  replacements = normalizeReplacementsForPlan(plan, replacements);
  const signature = replacementTransitionSignature(parentStateNodeId, replacements);
  const children = plan.stateNodes[parentStateNodeId]?.childReplacementTransitionIds || [];
  if (children.includes(signature)) return "Open Branch";
  return children.length ? "New Branch" : "Next Turn";
}

export function commitForcedReplacement(plan, preview, dataset) {
  if (preview.previewStatus !== "ready" || !preview.outcomes?.length) throw new Error("Only a ready replacement preview can be committed");
  const next = clone(plan);
  next.replacementTransitions ||= {};
  const parent = next.stateNodes[preview.baseStateNodeId];
  parent.childReplacementTransitionIds ||= [];
  const signature = replacementTransitionSignature(preview.baseStateNodeId, preview.replacements);
  const existing = next.replacementTransitions[signature];
  if (existing) return { plan, replacementTransitionId: signature, cursorStateNodeId: existing.defaultOutcomeStateNodeId, created: false };
  let order = nextCreatedOrder(next);
  const transition = {
    replacementTransitionId: signature,
    parentStateNodeId: preview.baseStateNodeId,
    turnNumber: Number(parent.turnNumber),
    createdOrder: order++,
    actions: clone(preview.replacements),
    outcomeStateNodeIds: [],
    defaultOutcomeStateNodeId: null,
    status: "resolved"
  };
  const previewToState = new Map();
  preview.outcomes.forEach((outcome, index) => {
    const stateId = `state-replacement-${parent.turnNumber}-${shortHash(stableStringify({ signature, index, hash: outcome.state.stateHash }))}`;
    previewToState.set(outcome.previewOutcomeId, stateId);
    const eventIds = [];
    outcome.events.forEach((rawEvent, eventIndex) => {
      const eventId = `event-${shortHash(stableStringify({ stateId, eventIndex, rawEvent }))}`;
      next.resolutionEvents[eventId] = committedEvent(rawEvent, eventId, Number(parent.turnNumber), eventIndex + 1);
      eventIds.push(eventId);
    });
    const state = clone(outcome.state);
    state.draftNote = String(parent.draftNote || "");
    state.stateNodeId = stateId;
    state.parentActionGroupId = null;
    state.parentReplacementTransitionId = signature;
    state.turnNumber = Number(parent.turnNumber);
    state.createdOrder = order++;
    state.outcome = clone(outcome.outcome);
    state.resolutionEventIds = eventIds;
    state.childActionGroupIds = [];
    state.childReplacementTransitionIds = [];
    state.status = pendingReplacementSlots(state).length ? "incomplete" : "resolved";
    state.transitionKind = "replacement";
    state.displaySnapshot = {
      kind: "replacement",
      turnNumber: Number(parent.turnNumber),
      outcomeLabel: outcome.outcome.label,
      players: activeSlotEntries(state, "player").map(({ slot }) => replacementDisplaySide("player", slot, state, preview.replacements, next)),
      enemies: activeSlotEntries(state, "enemy").map(({ slot }) => replacementDisplaySide("enemy", slot, state, preview.replacements, next))
    };
    if (state.displaySnapshot.players.length === 1) state.displaySnapshot.player = state.displaySnapshot.players[0];
    if (state.displaySnapshot.enemies.length === 1) state.displaySnapshot.enemy = state.displaySnapshot.enemies[0];
    next.stateNodes[stateId] = state;
    transition.outcomeStateNodeIds.push(stateId);
  });
  transition.defaultOutcomeStateNodeId = previewToState.get(preview.defaultPreviewOutcomeId) || transition.outcomeStateNodeIds[0];
  next.replacementTransitions[signature] = transition;
  parent.childReplacementTransitionIds.push(signature);
  parent.draftNote = "";
  next.workingDraft = null;
  touchPlan(next);
  assertValidPlanDocument(next);
  return { plan: next, replacementTransitionId: signature, cursorStateNodeId: transition.defaultOutcomeStateNodeId, created: true };
}
