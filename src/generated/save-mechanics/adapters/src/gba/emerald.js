import { parseStandardGbaSave } from "./shared/standard-save.js";
export const POKEMON_EMERALD_SAVE_CONFIG = Object.freeze({ gameId: "pokemon-emerald", formatId: "emerald", generation: 3 });
export function parsePokemonEmeraldSave(value, options) { return parseStandardGbaSave(value, POKEMON_EMERALD_SAVE_CONFIG, options); }
