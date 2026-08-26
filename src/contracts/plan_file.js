import { assertValidPlanDocument, MAX_PLAN_BYTES, validatePlanDocument } from "./plan_contract.js";
import { createPlanSubset } from "../core/graph.js";
import { stableStringify } from "../core/primitives.js";

export function migratePlanDocument(plan) {
  if (Number(plan?.schemaVersion) !== 1) return plan;
  const next = structuredClone(plan);
  next.schemaVersion = 2;
  for (const state of Object.values(next.stateNodes || {})) {
    state.active ||= {};
    state.active.playerCombatantKeys = [state.active.playerCombatantKey];
    state.active.enemyCombatantKeys = [state.active.enemyCombatantKey];
    state.pendingReplacementSlots = (state.pendingReplacementSides || []).map(side => ({ side, slot: 0 }));
    if (state.displaySnapshot) {
      state.displaySnapshot.players = state.displaySnapshot.player ? [state.displaySnapshot.player] : [];
      state.displaySnapshot.enemies = state.displaySnapshot.enemy ? [state.displaySnapshot.enemy] : [];
    }
  }
  for (const group of Object.values(next.actionGroups || {})) {
    group.actions = {
      player: Array.isArray(group.actions?.player) ? group.actions.player : [group.actions.player],
      enemy: Array.isArray(group.actions?.enemy) ? group.actions.enemy : [group.actions.enemy]
    };
  }
  for (const transition of Object.values(next.replacementTransitions || {})) {
    transition.actions = Object.fromEntries(Object.entries(transition.actions || {}).map(([side, raw]) => [side,
      (Array.isArray(raw) ? raw : [raw]).map(action => ({ ...action, slot: Number(action.slot ?? 0) }))
    ]));
  }
  return next;
}

export function serializePlan(plan, options = {}) {
  assertValidPlanDocument(plan);
  return stableStringify(plan, options.spacing ?? 2) + "\n";
}

export function parsePlan(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("Plan input must be text");
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > (options.maxBytes || MAX_PLAN_BYTES)) throw new Error("Plan file exceeds the size limit");
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (error) {
    throw new Error(`Plan file is not valid JSON: ${error.message}`);
  }
  const result = validatePlanDocument(plan, options);
  if (!result.valid) {
    const error = new Error(result.issues.map(issue => `${issue.path}: ${issue.message}`).join("\n"));
    error.name = "PlanValidationError";
    error.issues = result.issues;
    throw error;
  }
  const migrated = options.migrate === false ? plan : migratePlanDocument(plan);
  assertValidPlanDocument(migrated, options);
  return migrated;
}

export function exportSelectedPlan(plan, selectedStateNodeIds, options = {}) {
  const subset = createPlanSubset(plan, selectedStateNodeIds, options);
  return {
    plan: subset,
    text: serializePlan(subset, options)
  };
}

export function suggestedPlanFilename(plan) {
  const clean = value => String(value || "plan")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "plan";
  return `${clean(plan.game?.gameId)}-${clean(plan.name)}.plc-plan.json`;
}

export function downloadPlan(plan, filename = suggestedPlanFilename(plan)) {
  const blob = new Blob([serializePlan(plan)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
