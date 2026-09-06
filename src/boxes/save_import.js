import {
  parsePlcSave,
  selectPlcSavePokemon,
} from "../generated/save-mechanics/adapters/src/plc/save-import.js?v=20260905-drafts-freecalc-partners-v1";
import { nowIso } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { normalizeBoxPokemon } from "./library.js?v=20260905-drafts-freecalc-partners-v1";

export function parseSave(value, dataset, { sourceName = "Selected save" } = {}) {
  return parsePlcSave(value, dataset, {
    sourceName,
    importedAt: nowIso(),
    normalizePokemon: normalizeBoxPokemon,
  });
}

export const selectSavePokemon = selectPlcSavePokemon;
