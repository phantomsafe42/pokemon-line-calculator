import { clone, stableStringify } from "../core/primitives.js";

export const TESTING_STATE_KIND = "pokemon-line-calculator-testing-state";
export const TESTING_STATE_SCHEMA_VERSION = 1;

function stringArray(values = []) {
  return [...new Set(Array.from(values || [], value => String(value)).filter(Boolean))];
}

export function createTestingStateSnapshot({
  capturedAt = new Date().toISOString(),
  selectedGameId = null,
  activeTab = "plc",
  plan = null,
  boxLibrary = null,
  cursorStateNodeId = null,
  actionDraft = null,
  currentPreview = null,
  selectedPreviewOutcomeId = null,
  reviewOutcomeStateNodeId = null,
  outcomesExpanded = false,
  needsRecalculation = false,
  exportSelection = [],
  contextSelection = null,
  view = {},
  controls = {},
  openDialogIds = [],
  focusedElement = null,
  liveEditActive = false
} = {}) {
  return {
    kind: TESTING_STATE_KIND,
    schemaVersion: TESTING_STATE_SCHEMA_VERSION,
    capturedAt,
    purpose: "PLC testing and deterministic UI reproduction; not a portable battle plan",
    app: {
      selectedGameId: selectedGameId || null,
      activeTab: activeTab === "boxes" ? "boxes" : "plc",
      cursorStateNodeId: cursorStateNodeId || null,
      reviewOutcomeStateNodeId: reviewOutcomeStateNodeId || null,
      outcomesExpanded: Boolean(outcomesExpanded),
      needsRecalculation: Boolean(needsRecalculation),
      exportSelection: stringArray(exportSelection),
      contextSelection: clone(contextSelection),
      openDialogIds: stringArray(openDialogIds),
      focusedElement: clone(focusedElement),
      liveEditActive: Boolean(liveEditActive)
    },
    transientTurn: {
      actionDraft: clone(actionDraft),
      currentPreview: clone(currentPreview),
      selectedPreviewOutcomeId: selectedPreviewOutcomeId || null
    },
    view: clone(view) || {},
    controls: clone(controls) || {},
    plan: clone(plan),
    boxLibrary: clone(boxLibrary),
    exclusions: [
      "raw save bytes",
      "browser credentials and cookies",
      "live-edit session IDs and lease credentials",
      "Overlay and OBS operational state"
    ]
  };
}

export function formatTestingStateSnapshot(snapshot) {
  if (snapshot?.kind !== TESTING_STATE_KIND || snapshot?.schemaVersion !== TESTING_STATE_SCHEMA_VERSION) {
    throw new Error("A current PLC testing-state snapshot is required");
  }
  return `${stableStringify(snapshot, 2)}\n`;
}
