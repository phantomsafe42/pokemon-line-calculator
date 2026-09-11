import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { BW_PROGRESS, UNOVA_BADGES } from "./shared.js";

export const POKEMON_WHITE_SAVE_CONFIG = Object.freeze({
  gameId: "pokemon-white", formatId: "bw", generation: 5,
  datasetDirectory: "Pokemon White", moveLookup: "numeric",
  progress: Object.freeze({ ...BW_PROGRESS, badges: UNOVA_BADGES }),
});

export function parsePokemonWhiteSave(value, options) {
  return parseDsNeutralSave(value, POKEMON_WHITE_SAVE_CONFIG, options);
}
