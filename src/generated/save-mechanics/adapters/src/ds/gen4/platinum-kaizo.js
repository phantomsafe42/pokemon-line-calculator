import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { GEN4_PROGRESS, SINNOH_BADGES } from "./shared.js";

export const PLATINUM_KAIZO_SAVE_CONFIG = Object.freeze({
  gameId: "platinum-kaizo", formatId: "dppt", generation: 4,
  datasetDirectory: "Platinum Kaizo", datasetPrefix: "PK", moveLookup: "numeric",
  progress: Object.freeze({ ...GEN4_PROGRESS, badges: SINNOH_BADGES }),
});

export function parsePlatinumKaizoSave(value, options) {
  return parseDsNeutralSave(value, PLATINUM_KAIZO_SAVE_CONFIG, options);
}
