import { clone, nowIso, stableStringify } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";

export const CACHE_SCHEMA_VERSION = 1;

export function createDraftRecord(document, workingCursorStateNodeId = document.initialStateNodeId) {
  return {
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    draftRevision: Number(document.documentRevision || 0),
    lastExportedRevision: null,
    dirty: true,
    sourceFingerprint: {
      gameId: document.game.gameId,
      trainerId: document.game.trainerId,
      trainerVariantId: document.game.trainerVariantId,
      playerCollectionUpdatedAt: document.sourceSnapshot.playerCollectionUpdatedAt ?? null,
      playerRosterHash: document.sourceSnapshot.playerRosterHash,
      mechanicsHash: document.mechanicsFingerprint.battleMechanicsHash
    },
    document: clone(document),
    workingCursorStateNodeId,
    exportSelectionDraft: null,
    cachedAt: nowIso()
  };
}

export function updateDraftRecord(record, document, cursorStateNodeId) {
  const { document: previousDocument, ...metadata } = record;
  return {
    ...clone(metadata),
    draftRevision: Number(document.documentRevision),
    dirty: Number(record.lastExportedRevision) !== Number(document.documentRevision),
    document: clone(document),
    workingCursorStateNodeId: cursorStateNodeId,
    cachedAt: nowIso()
  };
}

export function markExported(record, { complete = true, selectedStateNodeIds = null } = {}) {
  return {
    ...clone(record),
    lastExportedRevision: complete ? record.draftRevision : record.lastExportedRevision,
    lastExportSelection: selectedStateNodeIds ? [...selectedStateNodeIds] : null,
    dirty: complete ? false : true,
    cachedAt: nowIso()
  };
}

export function destructiveTransitionNotice(record, actionLabel = "Changing context") {
  if (!record?.document || !Object.keys(record.document.actionGroups || {}).length) return null;
  const current = Number(record.lastExportedRevision) === Number(record.draftRevision);
  return {
    requiresConfirmation: true,
    currentExportExists: current,
    message: current
      ? `${actionLabel} will clear the active plan. Your latest output file matches the current draft.`
      : `${actionLabel} will erase this battle plan, including initial conditions, Pokémon modifications, turns, and branches. No up-to-date output file exists.`
  };
}

export function fingerprintsMatch(document, currentFingerprint) {
  const expected = {
    gameId: document.game.gameId,
    trainerId: document.game.trainerId,
    trainerVariantId: document.game.trainerVariantId,
    mechanicsFingerprint: document.mechanicsFingerprint
  };
  const actual = {
    gameId: currentFingerprint.gameId,
    trainerId: currentFingerprint.trainerId,
    trainerVariantId: currentFingerprint.trainerVariantId,
    mechanicsFingerprint: currentFingerprint.mechanicsFingerprint
  };
  return stableStringify(expected) === stableStringify(actual);
}

export class MemoryDraftStore {
  constructor() {
    this.value = null;
  }
  async load() { return clone(this.value); }
  async save(value) { this.value = clone(value); return clone(this.value); }
  async clear() { this.value = null; }
}

export class IndexedDbDraftStore {
  constructor({ indexedDB = globalThis.indexedDB, databaseName = "pokemon-line-calculator", storeName = "draft" } = {}) {
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.storeName = storeName;
    this.tail = Promise.resolve();
  }

  open() {
    if (!this.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));
    return new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  transact(mode, operation) {
    // Serialize reads, saves and clears in call order, including when opening
    // the database is delayed. A late old save must never resurrect a line.
    const next = this.tail.then(() => this.performTransaction(mode, operation));
    this.tail = next.catch(() => {});
    return next;
  }

  async performTransaction(mode, operation) {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(this.storeName, mode);
        const store = transaction.objectStore(this.storeName);
        const request = operation(store);
        let result;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error || new Error('Draft transaction aborted'));
        transaction.onerror = () => reject(transaction.error || new Error('Draft transaction failed'));
      });
    } finally {
      database.close();
    }
  }

  load() { return this.transact("readonly", store => store.get("active")); }
  save(value) {
    // Capture now, not after the asynchronous database open. IndexedDB makes
    // its own copy on put; no extra cloning is needed inside the transaction.
    const snapshot = clone(value);
    return this.transact("readwrite", store => store.put(snapshot, "active"));
  }
  clear() { return this.transact("readwrite", store => store.delete("active")); }
}
