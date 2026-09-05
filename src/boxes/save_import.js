import {
  parsePlcSave,
  selectPlcSavePokemon,
} from "../generated/save-mechanics/adapters/src/plc/save-import.js";
import { nowIso } from "../core/primitives.js";
import { normalizeBoxPokemon } from "./library.js";

export function parseSave(value, dataset, { sourceName = "Selected save" } = {}) {
  return parsePlcSave(value, dataset, {
    sourceName,
    importedAt: nowIso(),
    normalizePokemon: normalizeBoxPokemon,
  });
}

export const selectSavePokemon = selectPlcSavePokemon;
