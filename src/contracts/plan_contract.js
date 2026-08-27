import { isPlainObject, stableStringify } from "../core/primitives.js";

export const PLAN_KIND = "pokemon-battle-plan";
export const PLAN_SCHEMA_VERSION = 3;
export const SUPPORTED_PLAN_SCHEMA_VERSIONS = Object.freeze([1, 2, 3]);
export const MAX_PLAN_BYTES = 5_000_000;
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const STATE_STATUSES = new Set(["resolved", "preview", "stale", "invalid", "incomplete"]);
const SIDES = new Set(["player", "enemy"]);
const PROHIBITED_KEYS = new Set([
  "credentials",
  "password",
  "saveFile",
  "savePath",
  "overlayState",
  "displaySelection",
  "obsCommand"
]);

export class PlanValidationError extends Error {
  constructor(issues) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "PlanValidationError";
    this.issues = issues;
  }
}

function issue(list, path, message) {
  list.push({ path, message });
}

function validateId(value, path, issues) {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    issue(issues, path, "must be a stable ID using letters, numbers, colon, period, underscore, or hyphen");
    return false;
  }
  return true;
}

function validateDate(value, path, issues) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) issue(issues, path, "must be an ISO date-time string");
}

function validateTextAndKeys(value, path, issues, seen = new WeakSet()) {
  if (typeof value === "string") {
    if (value.length > 4096) issue(issues, path, "string exceeds 4096 characters");
    if (/\u0000/.test(value)) issue(issues, path, "contains a null character");
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) {
    issue(issues, path, "contains a cycle");
    return;
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (PROHIBITED_KEYS.has(key)) issue(issues, `${path}.${key}`, "field is prohibited in a portable plan");
    validateTextAndKeys(child, `${path}.${key}`, issues, seen);
  }
  seen.delete(value);
}

function validateStatTable(value, path, issues) {
  const keys = ["hp", "atk", "def", "spa", "spd", "spe"];
  if (!isPlainObject(value)) {
    issue(issues, path, "must be a stat table");
    return;
  }
  for (const key of keys) {
    if (!Number.isFinite(Number(value[key]))) issue(issues, `${path}.${key}`, "must be finite");
  }
}

function validateCombatants(plan, issues) {
  if (!isPlainObject(plan.combatants)) {
    issue(issues, "$.combatants", "must be an object map");
    return;
  }
  for (const [key, mon] of Object.entries(plan.combatants)) {
    const path = `$.combatants.${key}`;
    if (!isPlainObject(mon)) {
      issue(issues, path, "must be an object");
      continue;
    }
    if (mon.combatantKey !== key) issue(issues, `${path}.combatantKey`, "must match its map key");
    validateId(key, path, issues);
    if (!SIDES.has(mon.side)) issue(issues, `${path}.side`, "must be player or enemy");
    validateId(mon.speciesId, `${path}.speciesId`, issues);
    if (!Number.isInteger(Number(mon.level)) || Number(mon.level) < 1 || Number(mon.level) > 100) issue(issues, `${path}.level`, "must be an integer from 1 through 100");
    if (mon.experience !== undefined && (!Number.isInteger(Number(mon.experience)) || Number(mon.experience) < 0)) issue(issues, `${path}.experience`, "must be a non-negative integer");
    if (mon.growthRate !== undefined && mon.growthRate !== null && !["Medium Fast", "Erratic", "Fluctuating", "Medium Slow", "Fast", "Slow"].includes(mon.growthRate)) issue(issues, `${path}.growthRate`, "must be a supported growth rate");
    if (mon.baseExperienceYield !== undefined && mon.baseExperienceYield !== null && (!Number.isInteger(Number(mon.baseExperienceYield)) || Number(mon.baseExperienceYield) < 1 || Number(mon.baseExperienceYield) > 0xffff)) issue(issues, `${path}.baseExperienceYield`, "must be an integer from 1 through 65535");
    validateStatTable(mon.ivs, `${path}.ivs`, issues);
    validateStatTable(mon.evs, `${path}.evs`, issues);
    if (mon.baseStats !== undefined) validateStatTable(mon.baseStats, `${path}.baseStats`, issues);
    if (!Array.isArray(mon.moves) || mon.moves.length > 4) issue(issues, `${path}.moves`, "must contain at most four moves");
    for (const [index, move] of (mon.moves || []).entries()) {
      validateId(move?.moveId, `${path}.moves[${index}].moveId`, issues);
      if (!Number.isInteger(Number(move?.maxPp)) || Number(move.maxPp) < 0) issue(issues, `${path}.moves[${index}].maxPp`, "must be a non-negative integer");
      if (move?.basePowerOverride !== undefined && (!Number.isInteger(Number(move.basePowerOverride)) || Number(move.basePowerOverride) < 0 || Number(move.basePowerOverride) > 1000)) issue(issues, `${path}.moves[${index}].basePowerOverride`, "must be an integer from 0 through 1000");
      if (move?.typeOverride !== undefined) validateId(move.typeOverride, `${path}.moves[${index}].typeOverride`, issues);
    }
  }
}

function validateGraph(plan, issues) {
  const schemaVersion = Number(plan.schemaVersion);
  const slotCount = plan.game?.battleFormat === "triples" ? 3 : plan.game?.battleFormat === "doubles" ? 2 : 1;
  const states = isPlainObject(plan.stateNodes) ? plan.stateNodes : {};
  const groups = isPlainObject(plan.actionGroups) ? plan.actionGroups : {};
  const replacements = isPlainObject(plan.replacementTransitions) ? plan.replacementTransitions : {};
  const events = isPlainObject(plan.resolutionEvents) ? plan.resolutionEvents : {};

  if (!Object.keys(states).length) issue(issues, "$.stateNodes", "must contain at least one state node");
  if (!states[plan.initialStateNodeId]) issue(issues, "$.initialStateNodeId", "must reference an existing state node");

  for (const [key, state] of Object.entries(states)) {
    const path = `$.stateNodes.${key}`;
    if (!isPlainObject(state)) {
      issue(issues, path, "must be an object");
      continue;
    }
    if (state.stateNodeId !== key) issue(issues, `${path}.stateNodeId`, "must match its map key");
    validateId(key, path, issues);
    if (!Number.isInteger(Number(state.turnNumber)) || Number(state.turnNumber) < 0) issue(issues, `${path}.turnNumber`, "must be a non-negative integer");
    if (!STATE_STATUSES.has(state.status)) issue(issues, `${path}.status`, "is not a supported state status");
    for (const field of ["notes", "draftNote"]) {
      if (state[field] !== undefined && typeof state[field] !== "string") issue(issues, `${path}.${field}`, "must be text");
    }
    for (const side of ["player", "enemy"]) {
      const active = schemaVersion >= 2 ? state.active?.[`${side}CombatantKeys`] : [state.active?.[`${side}CombatantKey`]];
      if (!Array.isArray(active) || active.length !== slotCount) issue(issues, `${path}.active.${side}CombatantKeys`, `must contain ${slotCount} active combatant keys`);
      const occupied = (active || []).filter(Boolean);
      if (new Set(occupied).size !== occupied.length) issue(issues, `${path}.active.${side}CombatantKeys`, "must contain distinct combatants");
      for (const [slot, combatantKey] of (active || []).entries()) {
        if (combatantKey === null && schemaVersion >= 2 && slotCount > 1) continue;
        if (!plan.combatants?.[combatantKey] || plan.combatants?.[combatantKey]?.side !== side) issue(issues, `${path}.active.${side}CombatantKeys[${slot}]`, "must reference an existing combatant on this side");
      }
    }
    if (schemaVersion >= 2 && !Array.isArray(state.pendingReplacementSlots)) issue(issues, `${path}.pendingReplacementSlots`, "must be an array");
    for (const [index, entry] of (state.pendingReplacementSlots || []).entries()) {
      if (!SIDES.has(entry?.side) || !Number.isInteger(Number(entry?.slot)) || Number(entry.slot) < 0 || Number(entry.slot) >= slotCount) issue(issues, `${path}.pendingReplacementSlots[${index}]`, "must identify a valid active slot");
    }
    for (const [combatantKey, combatantState] of Object.entries(state.combatantStates || {})) {
      const combatantPath = `${path}.combatantStates.${combatantKey}`;
      if (!plan.combatants?.[combatantKey]) issue(issues, combatantPath, "must reference an existing combatant");
      if (combatantState?.currentLevel !== undefined && (!Number.isInteger(Number(combatantState.currentLevel)) || Number(combatantState.currentLevel) < 1 || Number(combatantState.currentLevel) > 100)) {
        issue(issues, `${combatantPath}.currentLevel`, "must be an integer from 1 through 100");
      }
      if (combatantState?.experience !== undefined && combatantState?.experience !== null
        && (!Number.isInteger(Number(combatantState.experience)) || Number(combatantState.experience) < 0)) {
        issue(issues, `${combatantPath}.experience`, "must be null or a non-negative integer");
      }
      if (combatantState?.currentStats !== undefined) validateStatTable(combatantState.currentStats, `${combatantPath}.currentStats`, issues);
    }
    if (state.experienceState !== undefined) {
      if (!isPlainObject(state.experienceState) || !isPlainObject(state.experienceState.participantsByEnemyKey) || !Array.isArray(state.experienceState.rewardedEnemyKeys)) {
        issue(issues, `${path}.experienceState`, "must contain participant and rewarded-enemy collections");
      } else {
        for (const [enemyKey, participantKeys] of Object.entries(state.experienceState.participantsByEnemyKey)) {
          if (plan.combatants?.[enemyKey]?.side !== "enemy") issue(issues, `${path}.experienceState.participantsByEnemyKey.${enemyKey}`, "must identify an enemy combatant");
          if (!Array.isArray(participantKeys) || new Set(participantKeys).size !== participantKeys.length
            || participantKeys.some(playerKey => plan.combatants?.[playerKey]?.side !== "player")) {
            issue(issues, `${path}.experienceState.participantsByEnemyKey.${enemyKey}`, "must contain distinct player combatants");
          }
        }
        if (new Set(state.experienceState.rewardedEnemyKeys).size !== state.experienceState.rewardedEnemyKeys.length
          || state.experienceState.rewardedEnemyKeys.some(enemyKey => plan.combatants?.[enemyKey]?.side !== "enemy")) {
          issue(issues, `${path}.experienceState.rewardedEnemyKeys`, "must contain distinct enemy combatants");
        }
      }
    }
    for (const eventId of state.resolutionEventIds || []) {
      if (!events[eventId]) issue(issues, `${path}.resolutionEventIds`, `references missing event ${eventId}`);
    }
    for (const groupId of state.childActionGroupIds || []) {
      const group = groups[groupId];
      if (!group) issue(issues, `${path}.childActionGroupIds`, `references missing action group ${groupId}`);
      else if (group.parentStateNodeId !== key) issue(issues, `${path}.childActionGroupIds`, `${groupId} belongs to another parent state`);
    }
    for (const replacementId of state.childReplacementTransitionIds || []) {
      const replacement = replacements[replacementId];
      if (!replacement) issue(issues, `${path}.childReplacementTransitionIds`, `references missing replacement transition ${replacementId}`);
      else if (replacement.parentStateNodeId !== key) issue(issues, `${path}.childReplacementTransitionIds`, `${replacementId} belongs to another parent state`);
    }
    if (key === plan.initialStateNodeId) {
      if (state.parentActionGroupId !== null) issue(issues, `${path}.parentActionGroupId`, "root state must have no parent action group");
      if (state.parentReplacementTransitionId !== null && state.parentReplacementTransitionId !== undefined) issue(issues, `${path}.parentReplacementTransitionId`, "root state must have no parent replacement transition");
      if (Number(state.turnNumber) !== 0) issue(issues, `${path}.turnNumber`, "root state must be turn 0");
    } else {
      const hasActionParent = Boolean(state.parentActionGroupId);
      const hasReplacementParent = Boolean(state.parentReplacementTransitionId);
      if (hasActionParent === hasReplacementParent) issue(issues, path, "must have exactly one action-group or replacement-transition parent");
      if (hasActionParent) {
        const parent = groups[state.parentActionGroupId];
        if (!parent) issue(issues, `${path}.parentActionGroupId`, "must reference an existing action group");
        else {
          if (!(parent.outcomeStateNodeIds || []).includes(key)) issue(issues, `${path}.parentActionGroupId`, "parent action group does not list this outcome");
          if (Number(state.turnNumber) !== Number(parent.turnNumber)) issue(issues, `${path}.turnNumber`, "must match its parent action-group turn");
        }
      }
      if (hasReplacementParent) {
        const parent = replacements[state.parentReplacementTransitionId];
        if (!parent) issue(issues, `${path}.parentReplacementTransitionId`, "must reference an existing replacement transition");
        else {
          if (!(parent.outcomeStateNodeIds || []).includes(key)) issue(issues, `${path}.parentReplacementTransitionId`, "parent replacement transition does not list this outcome");
          if (Number(state.turnNumber) !== Number(parent.turnNumber)) issue(issues, `${path}.turnNumber`, "must match its parent replacement transition turn");
        }
      }
    }
  }

  for (const [key, replacement] of Object.entries(replacements)) {
    const path = `$.replacementTransitions.${key}`;
    if (!isPlainObject(replacement)) {
      issue(issues, path, "must be an object");
      continue;
    }
    if (replacement.replacementTransitionId !== key) issue(issues, `${path}.replacementTransitionId`, "must match its map key");
    validateId(key, path, issues);
    const parent = states[replacement.parentStateNodeId];
    if (!parent) issue(issues, `${path}.parentStateNodeId`, "must reference an existing state node");
    else {
      if (Number(replacement.turnNumber) !== Number(parent.turnNumber)) issue(issues, `${path}.turnNumber`, "must match its parent state turn");
      if (!(parent.childReplacementTransitionIds || []).includes(key)) issue(issues, `${path}.parentStateNodeId`, "parent state does not list this replacement transition");
    }
    if (!isPlainObject(replacement.actions) || !Object.keys(replacement.actions).length) issue(issues, `${path}.actions`, "must contain at least one side replacement");
    for (const [side, rawActions] of Object.entries(replacement.actions || {})) {
      if (!SIDES.has(side)) issue(issues, `${path}.actions.${side}`, "is not a supported side");
      const actions = Array.isArray(rawActions) ? rawActions : [rawActions];
      for (const [index, action] of actions.entries()) {
        if (action?.actionType !== "replacement" || action?.side !== side || action?.consumesTurn !== false) issue(issues, `${path}.actions.${side}[${index}]`, "must be a non-turn forced replacement for its side");
        if (schemaVersion >= 2 && (!Number.isInteger(Number(action?.slot)) || Number(action.slot) < 0 || Number(action.slot) >= slotCount)) issue(issues, `${path}.actions.${side}[${index}].slot`, "must identify a valid active slot");
        if (!plan.combatants?.[action?.switchToKey]) issue(issues, `${path}.actions.${side}[${index}].switchToKey`, "must reference an existing combatant");
      }
    }
    if (!Array.isArray(replacement.outcomeStateNodeIds) || !replacement.outcomeStateNodeIds.length) issue(issues, `${path}.outcomeStateNodeIds`, "must contain at least one outcome");
    for (const stateId of replacement.outcomeStateNodeIds || []) {
      const state = states[stateId];
      if (!state) issue(issues, `${path}.outcomeStateNodeIds`, `references missing state ${stateId}`);
      else if (state.parentReplacementTransitionId !== key) issue(issues, `${path}.outcomeStateNodeIds`, `${stateId} belongs to another replacement transition`);
    }
    if (replacement.defaultOutcomeStateNodeId !== null && !(replacement.outcomeStateNodeIds || []).includes(replacement.defaultOutcomeStateNodeId)) {
      issue(issues, `${path}.defaultOutcomeStateNodeId`, "must be one of the replacement transition outcomes");
    }
  }

  for (const [key, group] of Object.entries(groups)) {
    const path = `$.actionGroups.${key}`;
    if (!isPlainObject(group)) {
      issue(issues, path, "must be an object");
      continue;
    }
    if (group.actionGroupId !== key) issue(issues, `${path}.actionGroupId`, "must match its map key");
    validateId(key, path, issues);
    const parent = states[group.parentStateNodeId];
    if (!parent) issue(issues, `${path}.parentStateNodeId`, "must reference an existing state node");
    else if (Number(group.turnNumber) !== Number(parent.turnNumber) + 1) issue(issues, `${path}.turnNumber`, "must be one greater than its parent state turn");
    if (!isPlainObject(group.actions) || !group.actions.player || !group.actions.enemy) issue(issues, `${path}.actions`, "must contain player and enemy actions");
    if (group.outcomeSelectionMode !== undefined && !["complete", "crafted"].includes(group.outcomeSelectionMode)) issue(issues, `${path}.outcomeSelectionMode`, "must be complete or crafted");
    if (schemaVersion >= 2) {
      for (const side of ["player", "enemy"]) {
        if (!Array.isArray(group.actions?.[side]) || group.actions[side].length !== slotCount) issue(issues, `${path}.actions.${side}`, `must contain ${slotCount} slot actions`);
        const sideActions = Array.isArray(group.actions?.[side]) ? group.actions[side] : [];
        for (const [index, action] of sideActions.entries()) {
          if (action !== null && !["move", "switch", "shift"].includes(action?.actionType)) issue(issues, `${path}.actions.${side}[${index}].actionType`, "must be move, switch, or shift");
          if (action?.actionType === "shift" && plan.game?.battleFormat !== "triples") issue(issues, `${path}.actions.${side}[${index}].actionType`, "Shift is available only in Triple Battles");
        }
      }
    }
    if (!Array.isArray(group.outcomeStateNodeIds) || !group.outcomeStateNodeIds.length) issue(issues, `${path}.outcomeStateNodeIds`, "must contain at least one outcome");
    for (const stateId of group.outcomeStateNodeIds || []) {
      const state = states[stateId];
      if (!state) issue(issues, `${path}.outcomeStateNodeIds`, `references missing state ${stateId}`);
      else if (state.parentActionGroupId !== key) issue(issues, `${path}.outcomeStateNodeIds`, `${stateId} belongs to another action group`);
    }
    if (group.defaultOutcomeStateNodeId !== null && !(group.outcomeStateNodeIds || []).includes(group.defaultOutcomeStateNodeId)) {
      issue(issues, `${path}.defaultOutcomeStateNodeId`, "must be one of the action group's outcomes");
    }
    const outcomes = (group.outcomeStateNodeIds || []).map(id => states[id]?.outcome).filter(Boolean);
    if (group.outcomeSelectionMode !== "crafted" && outcomes.length > 1 && outcomes.every(outcome => outcome.probabilityStatus === "known" && Number.isFinite(Number(outcome.probability)))) {
      const sum = outcomes.reduce((total, outcome) => total + Number(outcome.probability), 0);
      if (Math.abs(sum - 1) > 1e-9) issue(issues, `${path}.outcomeStateNodeIds`, "known sibling probabilities must sum to 1");
    }
  }

  for (const [key, event] of Object.entries(events)) {
    const path = `$.resolutionEvents.${key}`;
    if (event?.eventId !== key) issue(issues, `${path}.eventId`, "must match its map key");
    validateId(key, path, issues);
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(stateId) {
    if (visiting.has(stateId)) {
      issue(issues, `$.stateNodes.${stateId}`, "graph contains a cycle");
      return;
    }
    if (visited.has(stateId) || !states[stateId]) return;
    visiting.add(stateId);
    for (const groupId of states[stateId].childActionGroupIds || []) {
      for (const outcomeId of groups[groupId]?.outcomeStateNodeIds || []) visit(outcomeId);
    }
    for (const replacementId of states[stateId].childReplacementTransitionIds || []) {
      for (const outcomeId of replacements[replacementId]?.outcomeStateNodeIds || []) visit(outcomeId);
    }
    visiting.delete(stateId);
    visited.add(stateId);
  }
  visit(plan.initialStateNodeId);
  for (const stateId of Object.keys(states)) {
    if (!visited.has(stateId)) issue(issues, `$.stateNodes.${stateId}`, "is unreachable from the initial state");
  }
}

export function validatePlanDocument(plan, options = {}) {
  const issues = [];
  if (!isPlainObject(plan)) return { valid: false, issues: [{ path: "$", message: "must be an object" }] };

  let serialized = "";
  try {
    serialized = stableStringify(plan);
  } catch (error) {
    return { valid: false, issues: [{ path: "$", message: error.message }] };
  }
  if (new TextEncoder().encode(serialized).byteLength > (options.maxBytes || MAX_PLAN_BYTES)) issue(issues, "$", "plan exceeds the size limit");
  if (plan.kind !== PLAN_KIND) issue(issues, "$.kind", `must equal ${PLAN_KIND}`);
  if (!SUPPORTED_PLAN_SCHEMA_VERSIONS.includes(Number(plan.schemaVersion))) issue(issues, "$.schemaVersion", `must be one of ${SUPPORTED_PLAN_SCHEMA_VERSIONS.join(", ")}`);
  validateId(plan.planId, "$.planId", issues);
  if (typeof plan.name !== "string" || !plan.name.trim() || plan.name.length > 240) issue(issues, "$.name", "must be a non-empty label of at most 240 characters");
  validateDate(plan.createdAt, "$.createdAt", issues);
  validateDate(plan.updatedAt, "$.updatedAt", issues);
  if (!Number.isInteger(Number(plan.documentRevision)) || Number(plan.documentRevision) < 0) issue(issues, "$.documentRevision", "must be a non-negative integer");
  if (!isPlainObject(plan.game)) issue(issues, "$.game", "must be an object");
  else {
    validateId(plan.game.gameId, "$.game.gameId", issues);
    if (!["singles", "doubles", "triples"].includes(plan.game.battleFormat)) issue(issues, "$.game.battleFormat", "must be singles, doubles, or triples");
    if (Number(plan.schemaVersion) === 1 && plan.game.battleFormat !== "singles") issue(issues, "$.game.battleFormat", "schema version 1 supports singles only");
    if (Number(plan.schemaVersion) < 3 && plan.game.battleFormat === "triples") issue(issues, "$.game.battleFormat", "Triple Battles require schema version 3");
    if (!["string", "number"].includes(typeof plan.game.trainerId)) issue(issues, "$.game.trainerId", "must be a trainer ID");
  }
  if (!isPlainObject(plan.mechanicsFingerprint)) issue(issues, "$.mechanicsFingerprint", "must be an object");
  if (!isPlainObject(plan.sourceSnapshot)) issue(issues, "$.sourceSnapshot", "must be an object");
  validateTextAndKeys(plan, "$", issues);
  validateCombatants(plan, issues);
  validateGraph(plan, issues);

  const result = { valid: issues.length === 0, issues };
  if (!result.valid && options.throwOnError) throw new PlanValidationError(issues);
  return result;
}

export function assertValidPlanDocument(plan, options = {}) {
  validatePlanDocument(plan, { ...options, throwOnError: true });
  return plan;
}
