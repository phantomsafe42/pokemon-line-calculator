import { deriveDisplayColumns } from "../core/graph.js?v=20260905-drafts-freecalc-partners-v1";
import { clone, nowIso } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";

export const DISPLAY_KIND = "battle-plan-display";
export const DISPLAY_SCHEMA_VERSION = 2;
export const SUPPORTED_DISPLAY_SCHEMA_VERSIONS = Object.freeze([1, 2]);
export const MAX_DISPLAY_BYTES = 1_000_000;
export const MAX_DISPLAY_COLUMNS = 8;
export const MAX_DISPLAY_TURNS = 40;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;

function boundedText(value, length = 240) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, length);
}

function displayAction(action) {
  if (!action) return null;
  const output = {
    actionType: boundedText(action.actionType, 32),
    moveId: action.moveId ? boundedText(action.moveId, 160) : null,
    moveName: action.moveName ? boundedText(action.moveName, 120) : null,
    switchToKey: action.switchToKey ? boundedText(action.switchToKey, 160) : null,
    resultLabel: action.resultLabel ? boundedText(action.resultLabel, 160) : null
  };
  if (action.damagePercent && Number.isFinite(Number(action.damagePercent.min)) && Number.isFinite(Number(action.damagePercent.max))) {
    output.damagePercent = {
      min: Number(action.damagePercent.min),
      max: Number(action.damagePercent.max),
      label: boundedText(action.damagePercent.label || `${Number(action.damagePercent.min).toFixed(1)}–${Number(action.damagePercent.max).toFixed(1)}%`, 64)
    };
  }
  return output;
}

function displaySide(side) {
  if (!side) return null;
  return {
    combatantKey: boundedText(side.combatantKey, 160),
    speciesId: boundedText(side.speciesId, 160),
    displayName: boundedText(side.displayName, 120),
    spriteId: boundedText(side.spriteId || side.speciesId, 160),
    ...(Number.isInteger(Number(side.slot)) ? { slot: Number(side.slot) } : {}),
    action: displayAction(side.action)
  };
}

function displayTurn(plan, stateNodeId) {
  const state = plan.stateNodes[stateNodeId];
  const snapshot = state.displaySnapshot || {};
  return {
    stateNodeId,
    turnNumber: Number(state.turnNumber),
    outcomeLabel: boundedText(snapshot.outcomeLabel || state.outcome?.label, 180),
    probability: Number.isFinite(Number(state.outcome?.probability)) ? Number(state.outcome.probability) : null,
    probabilityStatus: boundedText(state.outcome?.probabilityStatus || "unknown", 24),
    players: (snapshot.players || (snapshot.player ? [snapshot.player] : [])).map(displaySide),
    enemies: (snapshot.enemies || (snapshot.enemy ? [snapshot.enemy] : [])).map(displaySide)
  };
}

export function createDisplaySelection(plan, selectedStateNodeIds) {
  const selected = [...new Set(selectedStateNodeIds || [])];
  const derived = deriveDisplayColumns(plan, selected);
  if (!derived.columns.length) throw new Error("Select at least one resolved turn instance");
  if (derived.columns.length > MAX_DISPLAY_COLUMNS) throw new Error(`Display selection exceeds ${MAX_DISPLAY_COLUMNS} columns`);
  if (derived.selectedTurnCount > MAX_DISPLAY_TURNS) throw new Error(`Display selection exceeds ${MAX_DISPLAY_TURNS} turn instances`);
  return {
    sourcePlanId: plan.planId,
    sourcePlanRevision: Number(plan.documentRevision),
    selectedStateNodeIds: selected,
    derived: {
      selectedTurnCount: derived.selectedTurnCount,
      branchCount: derived.branchCount,
      columns: derived.columns.map(column => ({
        columnId: column.columnId,
        stateNodeIds: [...column.stateNodeIds]
      }))
    }
  };
}

export function createDisplayProjection(plan, selectedStateNodeIds, { projectionRevision = 0, sentAt = nowIso() } = {}) {
  const selection = createDisplaySelection(plan, selectedStateNodeIds);
  const projection = {
    kind: DISPLAY_KIND,
    schemaVersion: DISPLAY_SCHEMA_VERSION,
    gameId: plan.game.gameId,
    projectionRevision: Number(projectionRevision),
    sourcePlanId: plan.planId,
    sourcePlanRevision: Number(plan.documentRevision),
    sentAt,
    selection: {
      selectedStateNodeIds: [...selection.selectedStateNodeIds],
      selectedTurnCount: selection.derived.selectedTurnCount,
      branchCount: selection.derived.branchCount
    },
    columns: selection.derived.columns.map(column => ({
      columnId: column.columnId,
      turns: column.stateNodeIds.map(stateNodeId => displayTurn(plan, stateNodeId))
    }))
  };
  assertValidDisplayProjection(projection);
  return projection;
}

export function createEmptyDisplayProjection(gameId, { projectionRevision = 0, sentAt = nowIso() } = {}) {
  return {
    kind: DISPLAY_KIND,
    schemaVersion: DISPLAY_SCHEMA_VERSION,
    gameId,
    projectionRevision: Number(projectionRevision),
    sourcePlanId: null,
    sourcePlanRevision: null,
    sentAt,
    selection: { selectedStateNodeIds: [], selectedTurnCount: 0, branchCount: 0 },
    columns: []
  };
}

export function validateDisplayProjection(value, { maxBytes = MAX_DISPLAY_BYTES } = {}) {
  const issues = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, issues: ["projection must be an object"] };
  let bytes = Infinity;
  try { bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch {}
  if (bytes > maxBytes) issues.push("projection exceeds the size limit");
  if (value.kind !== DISPLAY_KIND) issues.push(`kind must equal ${DISPLAY_KIND}`);
  if (!SUPPORTED_DISPLAY_SCHEMA_VERSIONS.includes(Number(value.schemaVersion))) issues.push(`schemaVersion must be one of ${SUPPORTED_DISPLAY_SCHEMA_VERSIONS.join(", ")}`);
  if (typeof value.gameId !== "string" || !/^[a-z0-9-]{1,80}$/.test(value.gameId)) issues.push("gameId is invalid");
  if (!Number.isInteger(Number(value.projectionRevision)) || Number(value.projectionRevision) < 0) issues.push("projectionRevision is invalid");
  if (value.sourcePlanId !== null && (typeof value.sourcePlanId !== "string" || !ID_PATTERN.test(value.sourcePlanId))) issues.push("sourcePlanId is invalid");
  if (!Array.isArray(value.columns) || value.columns.length > MAX_DISPLAY_COLUMNS) issues.push("columns are invalid");
  let turnCount = 0;
  for (const [columnIndex, column] of (value.columns || []).entries()) {
    if (!column || typeof column !== "object" || !ID_PATTERN.test(String(column.columnId || ""))) issues.push(`columns[${columnIndex}].columnId is invalid`);
    if (!Array.isArray(column?.turns)) issues.push(`columns[${columnIndex}].turns is invalid`);
    for (const [turnIndex, turn] of (column?.turns || []).entries()) {
      turnCount += 1;
      if (!turn || !ID_PATTERN.test(String(turn.stateNodeId || ""))) issues.push(`columns[${columnIndex}].turns[${turnIndex}].stateNodeId is invalid`);
      if (!Number.isInteger(Number(turn?.turnNumber)) || Number(turn.turnNumber) < 1) issues.push(`columns[${columnIndex}].turns[${turnIndex}].turnNumber is invalid`);
      if (Number(value.schemaVersion) >= 2) {
        if (!Array.isArray(turn?.players) || ![1, 2].includes(turn.players.length)) issues.push(`columns[${columnIndex}].turns[${turnIndex}].players is invalid`);
        if (!Array.isArray(turn?.enemies) || ![1, 2].includes(turn.enemies.length)) issues.push(`columns[${columnIndex}].turns[${turnIndex}].enemies is invalid`);
        for (const side of ["players", "enemies"]) {
          const slots = (turn?.[side] || []).map(entry => entry?.slot).filter(slot => slot !== undefined);
          if (slots.some(slot => !Number.isInteger(Number(slot)) || Number(slot) < 0 || Number(slot) > 1) || new Set(slots.map(Number)).size !== slots.length) {
            issues.push(`columns[${columnIndex}].turns[${turnIndex}].${side} slots are invalid`);
          }
        }
      }
    }
  }
  if (turnCount > MAX_DISPLAY_TURNS * MAX_DISPLAY_COLUMNS) issues.push("projection contains too many rendered turn cells");
  return { valid: issues.length === 0, issues, projection: clone(value) };
}

export function assertValidDisplayProjection(value, options) {
  const result = validateDisplayProjection(value, options);
  if (!result.valid) throw new Error(result.issues.join("\n"));
  return value;
}
