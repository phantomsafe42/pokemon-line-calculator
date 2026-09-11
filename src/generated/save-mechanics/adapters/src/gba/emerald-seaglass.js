import { parseStandardGbaSave } from "./shared/standard-save.js";
import { decodeSeaglassPokemonRecord } from "./seaglass.js";
export const EMERALD_SEAGLASS_SAVE_CONFIG = Object.freeze({ gameId: "emerald-seaglass", formatId: "emerald", generation: 3 });
export function parseEmeraldSeaglassSave(value, options = {}) {
  return parseStandardGbaSave(value, EMERALD_SEAGLASS_SAVE_CONFIG, { ...options, decodeRecord: decodeSeaglassPokemonRecord });
}
