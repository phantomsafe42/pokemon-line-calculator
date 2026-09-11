import { parseGbaGameSave, GBA_SAVE_GAME_CONFIGS } from "./gba/games.js";
import { parseDsGameSave, DS_SAVE_GAME_CONFIGS } from "./ds/games.js";
import { createStandardizedSaveContext } from "./standardized-context.js";

export const SAVE_GAME_CONFIGS = Object.freeze({
  ...GBA_SAVE_GAME_CONFIGS,
  ...DS_SAVE_GAME_CONFIGS,
});

export function parseSave(value, { gameId, ...options } = {}) {
  const context = options.context || (options.dataset ? createStandardizedSaveContext(options.dataset, gameId) : undefined);
  const normalizedOptions = { ...options, context };
  delete normalizedOptions.dataset;
  if (GBA_SAVE_GAME_CONFIGS[gameId]) return parseGbaGameSave(value, { gameId, ...normalizedOptions });
  if (DS_SAVE_GAME_CONFIGS[gameId]) return parseDsGameSave(value, { gameId, ...normalizedOptions });
  throw new Error(`Save import is unavailable for ${gameId || "the selected game"}`);
}
