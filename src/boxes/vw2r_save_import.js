import {
  parseVw2rPlcSave,
  selectVw2rPlcSavePokemon,
} from "../generated/save-mechanics/adapters/src/gen45/plc-vw2r.js";
import { nowIso } from "../core/primitives.js";
import { normalizeBoxPokemon } from "./library.js";

export function parseVw2rSave(value, dataset, { sourceName = "Selected VW2R save" } = {}) {
  return parseVw2rPlcSave(value, dataset, {
    sourceName,
    importedAt: nowIso(),
    normalizePokemon: normalizeBoxPokemon,
  });
}

export const selectVw2rSavePokemon = selectVw2rPlcSavePokemon;
