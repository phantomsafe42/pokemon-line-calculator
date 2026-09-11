function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function copyArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.slice();
}

export const SAVE_SNAPSHOT_SCHEMA_VERSION = "save-mechanics-snapshot/v1alpha2";

export function createSaveSnapshot({
  gameId,
  platformId,
  generation,
  formatId,
  source,
  selection,
  playerTrainerIdentity,
  storage,
  party = [],
  boxes = [],
  progress,
  diagnostics = [],
  observedAt,
}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("save snapshot source must be an object");
  }
  if (observedAt !== undefined && typeof observedAt !== "string") {
    throw new TypeError("save snapshot observedAt must be a caller-supplied ISO string or omitted");
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw new RangeError("save snapshot generation must be a positive integer");
  }

  const snapshot = {
    schemaVersion: SAVE_SNAPSHOT_SCHEMA_VERSION,
    gameId: requiredText(gameId, "gameId"),
    platformId: requiredText(platformId, "platformId"),
    generation,
    formatId: requiredText(formatId, "formatId"),
    source: { ...source },
    party: copyArray(party, "party"),
    boxes: copyArray(boxes, "boxes"),
    diagnostics: copyArray(diagnostics, "diagnostics"),
  };
  if (selection && typeof selection === "object") snapshot.selection = { ...selection };
  if (playerTrainerIdentity && typeof playerTrainerIdentity === "object") {
    snapshot.playerTrainerIdentity = { ...playerTrainerIdentity };
  }
  if (storage && typeof storage === "object") snapshot.storage = { ...storage };
  if (progress && typeof progress === "object") snapshot.progress = { ...progress };
  if (observedAt !== undefined) snapshot.observedAt = observedAt;
  return snapshot;
}
