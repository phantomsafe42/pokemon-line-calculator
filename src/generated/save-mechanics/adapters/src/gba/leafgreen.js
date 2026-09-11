import { parseStandardGbaSave } from "./shared/standard-save.js";

export const POKEMON_LEAFGREEN_SAVE_CONFIG = Object.freeze({ gameId: "pokemon-leafgreen", formatId: "frlg", generation: 3 });

export function parsePokemonLeafGreenSave(value, options) {
  return parseStandardGbaSave(value, POKEMON_LEAFGREEN_SAVE_CONFIG, options);
}
