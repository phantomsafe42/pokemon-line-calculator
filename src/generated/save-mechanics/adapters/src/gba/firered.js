import { parseStandardGbaSave } from "./shared/standard-save.js";

export const POKEMON_FIRERED_SAVE_CONFIG = Object.freeze({ gameId: "pokemon-firered", formatId: "frlg", generation: 3 });

export function parsePokemonFireRedSave(value, options) {
  return parseStandardGbaSave(value, POKEMON_FIRERED_SAVE_CONFIG, options);
}
