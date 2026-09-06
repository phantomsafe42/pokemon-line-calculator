import { clone } from '../core/primitives.js?v=20260905-drafts-freecalc-partners-v1';
import { assertValidPlanDocument } from '../contracts/plan_contract.js?v=20260905-drafts-freecalc-partners-v1';

export function savedDraftSnapshot(plan, editor = {}, id = `${plan.planId}:${plan.createdAt}`) {
  assertValidPlanDocument(plan);
  const document = clone(plan);
  return { id: String(id || crypto.randomUUID()), gameId: document.game.gameId,
    name: document.name || document.planName || 'Untitled Line', document,
    editor: clone(editor), savedAt: new Date().toISOString() };
}

// Separate database preserves the existing single-active-draft recovery store.
export class SavedDraftStore {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; }
  async transact(mode, operation) {
    const database = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open('plc-saved-lines', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('lines', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('lines', mode);
        const request = operation(transaction.objectStore('lines'));
        transaction.oncomplete = () => resolve(clone(request.result));
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Draft write cancelled'));
      });
    } finally { database.close(); }
  }
  async list(gameId) { return (await this.transact('readonly', store => store.getAll())).filter(row => !gameId || row.gameId === gameId).sort((a, b) => b.savedAt.localeCompare(a.savedAt)); }
  save(record) { return this.transact('readwrite', store => store.put(clone(record))); }
  delete(id) { return this.transact('readwrite', store => store.delete(id)); }
}
