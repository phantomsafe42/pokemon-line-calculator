import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { PLATINUM_PROGRESS, SINNOH_BADGES } from "./shared.js";

export const POKEMON_PLATINUM_SAVE_CONFIG = Object.freeze({
  gameId: "pokemon-platinum", formatId: "platinum", generation: 4,
  datasetDirectory: "Pokemon Platinum", moveLookup: "numeric",
  progress: Object.freeze({ ...PLATINUM_PROGRESS, badges: SINNOH_BADGES }),
});

export function parsePokemonPlatinumSave(value, options) {
  return parseDsNeutralSave(value, POKEMON_PLATINUM_SAVE_CONFIG, options);
}
