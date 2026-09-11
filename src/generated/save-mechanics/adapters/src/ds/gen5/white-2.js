import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { BW2_PROGRESS, UNOVA_BADGES } from "./shared.js";

export const POKEMON_WHITE_2_SAVE_CONFIG = Object.freeze({
  gameId: "pokemon-white-2", formatId: "bw2", generation: 5,
  datasetDirectory: "Pokemon White 2", moveLookup: "numeric",
  progress: Object.freeze({ ...BW2_PROGRESS, badges: UNOVA_BADGES }),
});

export function parsePokemonWhite2Save(value, options) {
  return parseDsNeutralSave(value, POKEMON_WHITE_2_SAVE_CONFIG, options);
}
