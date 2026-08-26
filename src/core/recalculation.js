import { assertValidPlanDocument } from "../contracts/plan_contract.js";
import { clone, nowIso, stableStringify } from "./primitives.js";
import { commitForcedReplacement, commitPreview, previewForcedReplacement } from "./planner.js?v=20260826-order-notes-import";
import { updateStateHash } from "./plan.js?v=20260826-plan-compat-recalc";
import { currentMechanicsFingerprint } from "../rulesets/resolver_profile.js";

function branchSignatureFromEvents(state, events) {
  const normalizedEvents = events.map(entry => ({
    eventType: entry.eventType,
    actorKey: entry.actorKey || null,
    targetKey: entry.targetKey || null,
    reason: entry.reason || null,
    thresholdOutcome: entry.metadata?.thresholdOutcome || null,
    success: entry.metadata?.success ?? null,
    statusId: entry.metadata?.statusId || null,
    cause: entry.metadata?.cause || null
  }));
  return stableStringify({
    label: state.outcome?.label || null,
    conditions: state.outcome?.conditions || [],
    events: normalizedEvents
  });
}

function savedEvents(plan, state) {
  return (state.resolutionEventIds || []).map(id => plan.resolutionEvents[id]).filter(Boolean);
}

function branchSignature(plan, state) {
  return branchSignatureFromEvents(state, savedEvents(plan, state));
}

const CRAFT_EVENT_TYPES = new Set([
  "action-skipped", "confusion-check", "confusion-self-hit", "damage", "major-status", "miss", "move-blocked", "move-immune",
  "order-modifier", "secondary-effect-missed", "status-cleared", "volatile-status", "volatile-status-cleared"
]);

function craftedChoiceSignature(events) {
  const choices = events
    .filter(event => CRAFT_EVENT_TYPES.has(event.eventType))
    // This was historical presentation metadata, not a user-selected branch event.
    .filter(event => !(event.eventType === "action-skipped" && event.reason === "actor-fainted-before-moving"))
    .map(event => ({
      eventType: event.eventType,
      actorKey: event.actorKey || null,
      // Older self-secondary events stored the damage target here. The acting move and
      // its damage event already preserve the selected target unambiguously.
      targetKey: event.eventType === "secondary-effect-missed" ? null : event.targetKey || null,
      moveId: event.moveId || null,
      reason: event.reason || null,
      criticalHit: event.metadata?.criticalHit ?? null,
      thresholdOutcome: event.metadata?.thresholdOutcome || null,
      statusId: event.metadata?.statusId || event.metadata?.volatileStatusId || null,
      outcome: event.metadata?.outcome || null,
      orderModifierId: event.metadata?.modifierId || null,
      orderModifierActivated: event.metadata?.activated ?? null
    }))
    .map(entry => stableStringify(entry))
    .sort();
  return stableStringify(choices);
}

function matchPreviewOutcome(oldPlan, oldStateId, preview) {
  const oldState = oldPlan.stateNodes[oldStateId];
  const oldEvents = savedEvents(oldPlan, oldState);
  const craftedSignature = craftedChoiceSignature(oldEvents);
  const crafted = (preview.outcomes || []).filter(outcome => craftedChoiceSignature(outcome.events || []) === craftedSignature);
  if (crafted.length === 1) return crafted[0];

  const strictSignature = branchSignatureFromEvents(oldState, oldEvents);
  const strict = (preview.outcomes || []).filter(outcome => branchSignatureFromEvents(outcome.state, outcome.events || []) === strictSignature);
  if (strict.length === 1) return strict[0];

  const label = oldState.outcome?.label;
  const labelled = (preview.outcomes || []).filter(outcome => outcome.outcome?.label === label);
  if (labelled.length === 1) return labelled[0];
  throw new Error(`Recalculation could not map saved crafted outcome ${oldStateId} unambiguously; the original plan remains preserved`);
}

function matchOutcomes(oldPlan, oldStateIds, newPlan, newStateIds) {
  if (oldStateIds.length !== newStateIds.length) throw new Error("Recalculation changed branch topology; the original plan remains preserved and requires manual branch review");
  const unmatched = new Set(newStateIds);
  const mapping = new Map();
  for (const oldId of oldStateIds) {
    const signature = branchSignature(oldPlan, oldPlan.stateNodes[oldId]);
    const exact = [...unmatched].find(newId => branchSignature(newPlan, newPlan.stateNodes[newId]) === signature);
    if (exact) {
      mapping.set(oldId, exact);
      unmatched.delete(exact);
    }
  }
  for (const oldId of oldStateIds) {
    if (mapping.has(oldId)) continue;
    const label = oldPlan.stateNodes[oldId].outcome?.label;
    const byLabel = [...unmatched].filter(newId => newPlan.stateNodes[newId].outcome?.label === label);
    if (byLabel.length !== 1) throw new Error("Recalculation could not map a saved branch unambiguously; the original plan remains preserved");
    mapping.set(oldId, byLabel[0]);
    unmatched.delete(byLabel[0]);
  }
  return mapping;
}

function currentActions(actions, parentStateHash) {
  return Object.fromEntries(Object.entries(actions || {}).map(([side, raw]) => {
    const update = action => ({
      ...(action ? clone(action) : {}),
      ...(action && (action.actionType === "move" || action.actionType === "switch") ? { declaredAtStateHash: parentStateHash } : {})
    });
    const preserveEmptySlot = action => action ? update(action) : null;
    return [side, Array.isArray(raw) ? raw.map(preserveEmptySlot) : update(raw)];
  }));
}

function copyNodeAnnotations(oldPlan, oldStateId, newPlan, newStateId) {
  const oldState = oldPlan.stateNodes[oldStateId];
  const newState = newPlan.stateNodes[newStateId];
  if (!oldState || !newState) return;
  if (oldState.notes !== undefined) newState.notes = String(oldState.notes);
  if (oldState.draftNote !== undefined) newState.draftNote = String(oldState.draftNote);
}

export async function recalculatePlanDocument(original, { dataset, previewTurnFn, now = nowIso() }) {
  assertValidPlanDocument(original);
  if (typeof previewTurnFn !== "function") throw new Error("A resolver preview function is required for recalculation");
  const root = clone(original.stateNodes[original.initialStateNodeId]);
  root.parentActionGroupId = null;
  root.parentReplacementTransitionId = null;
  root.childActionGroupIds = [];
  root.childReplacementTransitionIds = [];
  root.status = "resolved";
  updateStateHash(root);
  const rootEvents = Object.fromEntries((root.resolutionEventIds || []).map(eventId => [eventId, clone(original.resolutionEvents[eventId])]).filter(([, event]) => event));
  let rebuilt = {
    ...clone(original),
    updatedAt: now,
    documentRevision: 0,
    mechanicsFingerprint: currentMechanicsFingerprint(dataset),
    stateNodes: { [root.stateNodeId]: root },
    actionGroups: {},
    replacementTransitions: {},
    resolutionEvents: rootEvents,
    workingDraft: null
  };

  async function replayState(oldStateId, newStateId) {
    const oldState = original.stateNodes[oldStateId];
    const children = [
      ...(oldState.childActionGroupIds || []).map(id => ({ kind: "action", id, order: Number(original.actionGroups[id]?.createdOrder || 0) })),
      ...(oldState.childReplacementTransitionIds || []).map(id => ({ kind: "replacement", id, order: Number(original.replacementTransitions?.[id]?.createdOrder || 0) }))
    ].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    for (const child of children) {
      const currentParent = rebuilt.stateNodes[newStateId];
      const parentDraftNote = String(currentParent.draftNote || "");
      currentParent.draftNote = "";
      if (child.kind === "action") {
        const oldGroup = original.actionGroups[child.id];
        const oldOutcomeIds = [
          oldGroup.defaultOutcomeStateNodeId,
          ...oldGroup.outcomeStateNodeIds.filter(id => id !== oldGroup.defaultOutcomeStateNodeId)
        ].filter(Boolean);
        const mapping = new Map();
        for (const oldOutcomeId of oldOutcomeIds) {
          const parent = rebuilt.stateNodes[newStateId];
          const actions = currentActions(oldGroup.actions, parent.stateHash);
          const preview = await previewTurnFn({ plan: rebuilt, parentStateNodeId: newStateId, actions, expandExisting: true });
          const selected = matchPreviewOutcome(original, oldOutcomeId, preview);
          const committed = commitPreview(rebuilt, preview, dataset, {
            selectedPreviewOutcomeId: selected.previewOutcomeId,
            commitSelectedOnly: true
          });
          rebuilt = committed.plan;
          mapping.set(oldOutcomeId, committed.cursorStateNodeId);
          copyNodeAnnotations(original, oldOutcomeId, rebuilt, committed.cursorStateNodeId);
        }
        rebuilt.stateNodes[newStateId].draftNote = parentDraftNote;
        for (const oldOutcomeId of oldGroup.outcomeStateNodeIds) {
          await replayState(oldOutcomeId, mapping.get(oldOutcomeId));
        }
      } else {
        const oldTransition = original.replacementTransitions[child.id];
        const replacements = clone(oldTransition.actions);
        const preview = previewForcedReplacement({ plan: rebuilt, parentStateNodeId: newStateId, replacements, dataset });
        const committed = commitForcedReplacement(rebuilt, preview, dataset);
        rebuilt = committed.plan;
        rebuilt.stateNodes[newStateId].draftNote = parentDraftNote;
        const newTransition = rebuilt.replacementTransitions[committed.replacementTransitionId];
        const mapping = matchOutcomes(original, oldTransition.outcomeStateNodeIds, rebuilt, newTransition.outcomeStateNodeIds);
        for (const oldOutcomeId of oldTransition.outcomeStateNodeIds) {
          copyNodeAnnotations(original, oldOutcomeId, rebuilt, mapping.get(oldOutcomeId));
          await replayState(oldOutcomeId, mapping.get(oldOutcomeId));
        }
      }
    }
  }

  await replayState(original.initialStateNodeId, root.stateNodeId);
  rebuilt.createdAt = original.createdAt;
  rebuilt.updatedAt = now;
  rebuilt.name = original.name;
  assertValidPlanDocument(rebuilt);
  return rebuilt;
}
