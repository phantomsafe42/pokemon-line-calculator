import { parseSave, selectSavePokemon } from "./save_import.js?v=20260911-public-save-mechanics-v1";

export function parseVw2rSave(value, dataset, { sourceName = "Selected VW2R save" } = {}) {
  if (dataset?.gameId !== "volt-white-2r") throw new Error("This save adapter is available only for Volt White 2 Redux");
  return parseSave(value, dataset, { sourceName });
}

export const selectVw2rSavePokemon = selectSavePokemon;
