import {
  parseVw2rPlcSave,
  selectVw2rPlcSavePokemon,
} from "../generated/save-mechanics/adapters/src/gen45/plc-vw2r.js?v=20260905-drafts-freecalc-partners-v1";
import { nowIso } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { normalizeBoxPokemon } from "./library.js?v=20260905-drafts-freecalc-partners-v1";

export function parseVw2rSave(value, dataset, { sourceName = "Selected VW2R save" } = {}) {
  return parseVw2rPlcSave(value, dataset, {
    sourceName,
    importedAt: nowIso(),
    normalizePokemon: normalizeBoxPokemon,
  });
}

export const selectVw2rSavePokemon = selectVw2rPlcSavePokemon;
