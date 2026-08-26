import { assertValidPlanDocument } from "../contracts/plan_contract.js";
import { actionList } from "./battle_slots.js";
import { clone, nowIso } from "./primitives.js";

export function parentStateId(plan, stateNodeId) {
  const state = plan.stateNodes?.[stateNodeId];
  if (state?.parentActionGroupId) return plan.actionGroups?.[state.parentActionGroupId]?.parentStateNodeId || null;
  if (state?.parentReplacementTransitionId) return plan.replacementTransitions?.[state.parentReplacementTransitionId]?.parentStateNodeId || null;
  return null;
}

export function stateLineage(plan, stateNodeId) {
  if (!plan.stateNodes?.[stateNodeId]) throw new Error(`Unknown state node ${stateNodeId}`);
  const lineage = [];
  const seen = new Set();
  let current = stateNodeId;
  while (current) {
    if (seen.has(current)) throw new Error(`Cycle detected while reading lineage for ${stateNodeId}`);
    seen.add(current);
    lineage.push(current);
    current = parentStateId(plan, current);
  }
  return lineage.reverse();
}

export function ancestorClosure(plan, selectedStateNodeIds) {
  const selected = [...new Set(selectedStateNodeIds || [])];
  if (!selected.length) throw new Error("Select at least one state node");
  const stateIds = new Set([plan.initialStateNodeId]);
  const actionGroupIds = new Set();
  const replacementTransitionIds = new Set();
  for (const stateId of selected) {
    for (const lineageId of stateLineage(plan, stateId)) stateIds.add(lineageId);
  }
  for (const stateId of stateIds) {
    const parentGroupId = plan.stateNodes[stateId]?.parentActionGroupId;
    if (parentGroupId) actionGroupIds.add(parentGroupId);
    const parentReplacementId = plan.stateNodes[stateId]?.parentReplacementTransitionId;
    if (parentReplacementId) replacementTransitionIds.add(parentReplacementId);
  }
  return {
    selectedStateNodeIds: selected,
    includedStateNodeIds: [...stateIds].sort((a, b) => {
      const left = plan.stateNodes[a];
      const right = plan.stateNodes[b];
      return Number(left?.createdOrder || 0) - Number(right?.createdOrder || 0) || a.localeCompare(b);
    }),
    includedActionGroupIds: [...actionGroupIds].sort((a, b) => {
      const left = plan.actionGroups[a];
      const right = plan.actionGroups[b];
      return Number(left?.createdOrder || 0) - Number(right?.createdOrder || 0) || a.localeCompare(b);
    }),
    includedReplacementTransitionIds: [...replacementTransitionIds].sort((a, b) => {
      const left = plan.replacementTransitions?.[a];
      const right = plan.replacementTransitions?.[b];
      return Number(left?.createdOrder || 0) - Number(right?.createdOrder || 0) || a.localeCompare(b);
    })
  };
}

export function selectedLeafStateIds(plan, selectedStateNodeIds) {
  const selected = new Set(selectedStateNodeIds || []);
  return [...selected].filter(candidate => ![...selected].some(other => {
    if (candidate === other) return false;
    return stateLineage(plan, other).includes(candidate);
  }));
}

export function deriveDisplayColumns(plan, selectedStateNodeIds) {
  const selected = [...new Set(selectedStateNodeIds || [])];
  for (const stateId of selected) {
    if (!plan.stateNodes?.[stateId]) throw new Error(`Unknown selected state node ${stateId}`);
  }
  const selectedSet = new Set(selected);
  const leaves = selectedLeafStateIds(plan, selected);
  const columns = leaves.map((leafId, index) => {
    const stateNodeIds = stateLineage(plan, leafId).filter(id => selectedSet.has(id) && Number(plan.stateNodes[id].turnNumber) > 0 && !plan.stateNodes[id].parentReplacementTransitionId);
    return {
      columnId: `column-${index + 1}-${leafId}`,
      leafStateNodeId: leafId,
      stateNodeIds,
      turns: stateNodeIds.map(id => clone(plan.stateNodes[id].displaySnapshot))
    };
  }).filter(column => column.stateNodeIds.length);
  return {
    selectedTurnCount: selected.filter(id => Number(plan.stateNodes[id]?.turnNumber) > 0 && !plan.stateNodes[id]?.parentReplacementTransitionId).length,
    branchCount: columns.length,
    columns
  };
}

export function createPlanSubset(plan, selectedStateNodeIds, options = {}) {
  assertValidPlanDocument(plan);
  const selection = ancestorClosure(plan, selectedStateNodeIds);
  const includedStates = new Set(selection.includedStateNodeIds);
  const includedGroups = new Set(selection.includedActionGroupIds);
  const includedReplacements = new Set(selection.includedReplacementTransitionIds);
  const stateNodes = {};
  const actionGroups = {};
  const replacementTransitions = {};
  const eventIds = new Set();

  for (const stateId of selection.includedStateNodeIds) {
    const state = clone(plan.stateNodes[stateId]);
    state.childActionGroupIds = (state.childActionGroupIds || []).filter(id => includedGroups.has(id));
    state.childReplacementTransitionIds = (state.childReplacementTransitionIds || []).filter(id => includedReplacements.has(id));
    state.resolutionEventIds = [...(state.resolutionEventIds || [])];
    for (const eventId of state.resolutionEventIds) eventIds.add(eventId);
    stateNodes[stateId] = state;
  }
  for (const transitionId of selection.includedReplacementTransitionIds) {
    const transition = clone(plan.replacementTransitions[transitionId]);
    transition.outcomeStateNodeIds = (transition.outcomeStateNodeIds || []).filter(id => includedStates.has(id));
    if (!transition.outcomeStateNodeIds.includes(transition.defaultOutcomeStateNodeId)) {
      transition.defaultOutcomeStateNodeId = transition.outcomeStateNodeIds[0] || null;
    }
    replacementTransitions[transitionId] = transition;
  }
  for (const groupId of selection.includedActionGroupIds) {
    const group = clone(plan.actionGroups[groupId]);
    group.outcomeStateNodeIds = (group.outcomeStateNodeIds || []).filter(id => includedStates.has(id));
    if (!group.outcomeStateNodeIds.includes(group.defaultOutcomeStateNodeId)) {
      group.defaultOutcomeStateNodeId = group.outcomeStateNodeIds[0] || null;
    }
    actionGroups[groupId] = group;
  }
  const resolutionEvents = {};
  for (const eventId of eventIds) {
    if (plan.resolutionEvents[eventId]) resolutionEvents[eventId] = clone(plan.resolutionEvents[eventId]);
  }

  const subset = {
    ...clone(plan),
    updatedAt: options.updatedAt || nowIso(),
    exportSelection: selection,
    stateNodes,
    actionGroups,
    replacementTransitions,
    resolutionEvents,
    workingDraft: null
  };
  assertValidPlanDocument(subset);
  return subset;
}

export function planTreeOrder(plan, { includeReplacementStates = true } = {}) {
  const output = [];
  const walk = (stateId, depth) => {
    const state = plan.stateNodes[stateId];
    if (!state) return;
    const visible = includeReplacementStates || !state.parentReplacementTransitionId;
    if (visible) output.push({ state, depth });
    const children = [
      ...(state.childActionGroupIds || []).map(id => ({ kind: "action", id, order: Number(plan.actionGroups[id]?.createdOrder || 0) })),
      ...(state.childReplacementTransitionIds || []).map(id => ({ kind: "replacement", id, order: Number(plan.replacementTransitions?.[id]?.createdOrder || 0) }))
    ].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    for (const child of children) {
      const record = child.kind === "action" ? plan.actionGroups[child.id] : plan.replacementTransitions?.[child.id];
      for (const outcomeId of [...(record?.outcomeStateNodeIds || [])].sort((a, b) => Number(plan.stateNodes[a]?.createdOrder || 0) - Number(plan.stateNodes[b]?.createdOrder || 0))) {
        walk(outcomeId, depth + (visible ? 1 : 0));
      }
    }
  };
  walk(plan.initialStateNodeId, 0);
  return output;
}

function orderedChildStateIds(plan, state) {
  const transitions = [
    ...(state?.childActionGroupIds || []).map(id => ({ kind: "action", id, order: Number(plan.actionGroups[id]?.createdOrder || 0) })),
    ...(state?.childReplacementTransitionIds || []).map(id => ({ kind: "replacement", id, order: Number(plan.replacementTransitions?.[id]?.createdOrder || 0) }))
  ].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return transitions.flatMap(transition => {
    const record = transition.kind === "action" ? plan.actionGroups[transition.id] : plan.replacementTransitions?.[transition.id];
    return [...(record?.outcomeStateNodeIds || [])].sort((left, right) =>
      Number(plan.stateNodes[left]?.createdOrder || 0) - Number(plan.stateNodes[right]?.createdOrder || 0)
      || left.localeCompare(right)
    );
  });
}

function planStateLanes(plan) {
  const childrenByStateId = new Map();
  const branchStarts = [];
  for (const state of Object.values(plan.stateNodes || {})) {
    const children = orderedChildStateIds(plan, state);
    childrenByStateId.set(state.stateNodeId, children);
    for (const childStateId of children.slice(1)) branchStarts.push(childStateId);
  }
  branchStarts.sort((left, right) =>
    Number(plan.stateNodes[left]?.createdOrder || 0) - Number(plan.stateNodes[right]?.createdOrder || 0)
    || left.localeCompare(right)
  );
  const branchLaneByStateId = new Map(branchStarts.map((stateId, index) => [stateId, index + 1]));
  const laneByStateId = new Map();
  const visiting = new Set();
  const walk = (stateId, lane) => {
    const state = plan.stateNodes?.[stateId];
    if (!state || visiting.has(stateId)) return;
    visiting.add(stateId);
    laneByStateId.set(stateId, lane);
    (childrenByStateId.get(stateId) || []).forEach((childStateId, index) => {
      walk(childStateId, index === 0 ? lane : branchLaneByStateId.get(childStateId));
    });
    visiting.delete(stateId);
  };
  walk(plan.initialStateNodeId, 0);
  return laneByStateId;
}

export function planTurnTreeOrder(plan, { additionalDraftStateNodeIds = [] } = {}) {
  const laneByStateId = planStateLanes(plan);
  let nextDraftLane = Math.max(0, ...laneByStateId.values()) + 1;
  const entries = [];
  for (const { state, depth } of planTreeOrder(plan, { includeReplacementStates: false })) {
    if (!state.parentActionGroupId) continue;
    const group = plan.actionGroups[state.parentActionGroupId];
    if (!group) continue;
    entries.push({
      kind: "committed",
      turnNumber: Number(state.turnNumber),
      outcomeStateNodeId: state.stateNodeId,
      decisionStateNodeId: group.parentStateNodeId,
      createdOrder: Number(state.createdOrder || 0),
      depth,
      lane: Number(laneByStateId.get(state.stateNodeId) || 0)
    });
  }

  const draftStateNodeIds = new Set(additionalDraftStateNodeIds || []);
  for (const { state } of planTreeOrder(plan, { includeReplacementStates: true })) {
    const hasChildren = (state.childActionGroupIds || []).length || (state.childReplacementTransitionIds || []).length;
    if (!hasChildren && !state.battleEnded) draftStateNodeIds.add(state.stateNodeId);
  }
  for (const stateNodeId of draftStateNodeIds) {
    const state = plan.stateNodes[stateNodeId];
    if (!state || state.battleEnded) continue;
    const hasChildren = (state.childActionGroupIds || []).length || (state.childReplacementTransitionIds || []).length;
    const visibleDepth = stateLineage(plan, stateNodeId).filter(id => id !== plan.initialStateNodeId && !plan.stateNodes[id]?.parentReplacementTransitionId).length;
    entries.push({
      kind: "draft",
      turnNumber: Number(state.turnNumber) + 1,
      decisionStateNodeId: stateNodeId,
      outcomeStateNodeId: null,
      createdOrder: Number(state.createdOrder || 0) + 0.5,
      depth: visibleDepth,
      lane: hasChildren ? nextDraftLane++ : Number(laneByStateId.get(stateNodeId) || 0)
    });
  }

  return entries.sort((left, right) =>
    left.turnNumber - right.turnNumber
    || left.lane - right.lane
    || left.createdOrder - right.createdOrder
    || (left.kind === right.kind ? 0 : left.kind === "committed" ? -1 : 1)
    || String(left.outcomeStateNodeId || left.decisionStateNodeId).localeCompare(String(right.outcomeStateNodeId || right.decisionStateNodeId))
  );
}

export function turnNodeVisuals(plan, decisionStateNodeId, outcomeState, actions) {
  const decisionState = plan?.stateNodes?.[decisionStateNodeId];
  const faintedCombatantKeys = new Set();
  if (decisionState && outcomeState) {
    for (const combatantKey of Object.keys(plan.combatants || {})) {
      const before = Number(decisionState.combatantStates?.[combatantKey]?.hp?.max || 0);
      const after = Number(outcomeState.combatantStates?.[combatantKey]?.hp?.max || 0);
      if (before > 0 && after <= 0) faintedCombatantKeys.add(combatantKey);
    }
  }
  const combatantKeys = [];
  for (const side of ["player", "enemy"]) {
    for (const action of actionList(actions, side)) {
      const combatantKey = ["switch", "replacement"].includes(action?.actionType)
        ? action.switchToKey
        : action?.actorKey || action?.switchToKey;
      if (combatantKey && plan.combatants?.[combatantKey] && !combatantKeys.includes(combatantKey)) combatantKeys.push(combatantKey);
    }
  }
  for (const combatantKey of faintedCombatantKeys) {
    if (!combatantKeys.includes(combatantKey)) combatantKeys.push(combatantKey);
  }
  return {
    combatantKeys: combatantKeys.slice(0, 4),
    faintedCombatantKeys,
    hasFaint: faintedCombatantKeys.size > 0
  };
}
