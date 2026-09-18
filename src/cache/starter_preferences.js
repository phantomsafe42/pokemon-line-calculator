import { starterChoice } from '../adapters/starter_selection.js?v=20260918-starter-selection-v1';

// Separate from Boxes and the active draft: choosing a route must never create a
// roster or rewrite a battle snapshot. Each browser stores one choice per game.
const keyFor = gameId => `plc-starter-v1:${gameId}`;
export function readStarterPreference(storage, gameId, document) {
  try { return starterChoice(document, storage.getItem(keyFor(gameId)))?.id || null; }
  catch { return null; }
}
export function saveStarterPreference(storage, gameId, document, starterId) {
  if (!starterChoice(document, starterId)) throw new Error('Choose one of this game’s documented starters.');
  storage.setItem(keyFor(gameId), starterId);
  return starterId;
}
