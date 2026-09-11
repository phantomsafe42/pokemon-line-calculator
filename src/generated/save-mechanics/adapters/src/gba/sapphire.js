import { parseStandardGbaSave } from "./shared/standard-save.js";
export const POKEMON_SAPPHIRE_SAVE_CONFIG = Object.freeze({ gameId: "pokemon-sapphire", formatId: "rs", generation: 3 });
export function parsePokemonSapphireSave(value, options) { return parseStandardGbaSave(value, POKEMON_SAPPHIRE_SAVE_CONFIG, options); }
