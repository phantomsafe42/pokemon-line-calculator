import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { HGSS_PROGRESS, JOHTO_BADGES } from "./shared.js";

export const POKEMON_HEARTGOLD_SAVE_CONFIG = Object.freeze({
  gameId: "pokemon-heartgold", formatId: "hgss", generation: 4,
  datasetDirectory: "Pokemon HeartGold", moveLookup: "numeric",
  progress: Object.freeze({ ...HGSS_PROGRESS, badges: JOHTO_BADGES }),
});

export function parsePokemonHeartGoldSave(value, options) {
  return parseDsNeutralSave(value, POKEMON_HEARTGOLD_SAVE_CONFIG, options);
}
