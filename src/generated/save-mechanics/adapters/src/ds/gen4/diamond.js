import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { DP_PROGRESS, SINNOH_BADGES } from "./shared.js";

export const POKEMON_DIAMOND_SAVE_CONFIG = Object.freeze({
  gameId: "pokemon-diamond", formatId: "dp", generation: 4,
  datasetDirectory: "Pokemon Diamond", moveLookup: "numeric",
  progress: Object.freeze({ ...DP_PROGRESS, badges: SINNOH_BADGES }),
});

export function parsePokemonDiamondSave(value, options) {
  return parseDsNeutralSave(value, POKEMON_DIAMOND_SAVE_CONFIG, options);
}
