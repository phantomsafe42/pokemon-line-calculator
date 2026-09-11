import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { DP_PROGRESS, SINNOH_BADGES } from "./shared.js";

export const POKEMON_PEARL_SAVE_CONFIG = Object.freeze({
  gameId: "pokemon-pearl", formatId: "dp", generation: 4,
  datasetDirectory: "Pokemon Pearl", moveLookup: "numeric",
  progress: Object.freeze({ ...DP_PROGRESS, badges: SINNOH_BADGES }),
});

export function parsePokemonPearlSave(value, options) {
  return parseDsNeutralSave(value, POKEMON_PEARL_SAVE_CONFIG, options);
}
