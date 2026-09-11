import { parseStandardGbaSave } from "./shared/standard-save.js";
export const POKEMON_RUBY_SAVE_CONFIG = Object.freeze({ gameId: "pokemon-ruby", formatId: "rs", generation: 3 });
export function parsePokemonRubySave(value, options) { return parseStandardGbaSave(value, POKEMON_RUBY_SAVE_CONFIG, options); }
