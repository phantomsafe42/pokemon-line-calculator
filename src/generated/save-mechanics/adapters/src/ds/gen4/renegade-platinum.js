import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { GEN4_PROGRESS, SINNOH_BADGES } from "./shared.js";

export const RENEGADE_PLATINUM_SAVE_CONFIG = Object.freeze({
  gameId: "renegade-platinum", formatId: "dppt", generation: 4,
  datasetDirectory: "Renegade Platinum", datasetPrefix: "RP", moveLookup: "numeric",
  progress: Object.freeze({ ...GEN4_PROGRESS, badges: SINNOH_BADGES }),
});

export function parseRenegadePlatinumSave(value, options) {
  return parseDsNeutralSave(value, RENEGADE_PLATINUM_SAVE_CONFIG, options);
}
