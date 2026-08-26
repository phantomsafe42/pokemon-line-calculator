import { assertValidPlanDocument } from "../contracts/plan_contract.js";
import { clone, nowIso, stableStringify } from "./primitives.js";
import { commitForcedReplacement, commitPreview, previewForcedReplacement } from "./planner.js";
import { updateStateHash } from "./plan.js";

function branchSignature(plan, state) {
  const events = (state.resolutionEventIds || []).map(id => plan.resolutionEvents[id]).filter(Boolean).map(entry => ({
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
    events
  });
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
    mechanicsFingerprint: clone(dataset.fingerprint),
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
      if (child.kind === "action") {
        const oldGroup = original.actionGroups[child.id];
        const actions = currentActions(oldGroup.actions, currentParent.stateHash);
        const preview = await previewTurnFn({ plan: rebuilt, parentStateNodeId: newStateId, actions });
        const committed = commitPreview(rebuilt, preview, dataset);
        rebuilt = committed.plan;
        const newGroup = rebuilt.actionGroups[committed.actionGroupId];
        const mapping = matchOutcomes(original, oldGroup.outcomeStateNodeIds, rebuilt, newGroup.outcomeStateNodeIds);
        for (const oldOutcomeId of oldGroup.outcomeStateNodeIds) await replayState(oldOutcomeId, mapping.get(oldOutcomeId));
      } else {
        const oldTransition = original.replacementTransitions[child.id];
        const replacements = clone(oldTransition.actions);
        const preview = previewForcedReplacement({ plan: rebuilt, parentStateNodeId: newStateId, replacements, dataset });
        const committed = commitForcedReplacement(rebuilt, preview, dataset);
        rebuilt = committed.plan;
        const newTransition = rebuilt.replacementTransitions[committed.replacementTransitionId];
        const mapping = matchOutcomes(original, oldTransition.outcomeStateNodeIds, rebuilt, newTransition.outcomeStateNodeIds);
        for (const oldOutcomeId of oldTransition.outcomeStateNodeIds) await replayState(oldOutcomeId, mapping.get(oldOutcomeId));
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
