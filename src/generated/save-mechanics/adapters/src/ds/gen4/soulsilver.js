import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { HGSS_PROGRESS, JOHTO_BADGES } from "./shared.js";

export const POKEMON_SOULSILVER_SAVE_CONFIG = Object.freeze({
  gameId: "pokemon-soulsilver", formatId: "hgss", generation: 4,
  datasetDirectory: "Pokemon SoulSilver", moveLookup: "numeric",
  progress: Object.freeze({ ...HGSS_PROGRESS, badges: JOHTO_BADGES }),
});

export function parsePokemonSoulSilverSave(value, options) {
  return parseDsNeutralSave(value, POKEMON_SOULSILVER_SAVE_CONFIG, options);
}
