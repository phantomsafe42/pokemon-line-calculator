import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { BW_PROGRESS, UNOVA_BADGES } from "./shared.js";

export const POKEMON_BLACK_SAVE_CONFIG = Object.freeze({
  gameId: "pokemon-black", formatId: "bw", generation: 5,
  datasetDirectory: "Pokemon Black", moveLookup: "numeric",
  progress: Object.freeze({ ...BW_PROGRESS, badges: UNOVA_BADGES }),
});

export function parsePokemonBlackSave(value, options) {
  return parseDsNeutralSave(value, POKEMON_BLACK_SAVE_CONFIG, options);
}
