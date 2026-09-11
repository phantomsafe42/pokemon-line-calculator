import { parseDsNeutralSave } from "../shared/neutral-save.js";
import { GEN4_PROGRESS, JOHTO_BADGES } from "./shared.js";

export const STORM_SILVER_SAVE_CONFIG = Object.freeze({
  gameId: "storm-silver", formatId: "hgss", generation: 4,
  datasetDirectory: "Storm Silver", datasetPrefix: "SS", moveLookup: "ordered-first",
  progress: Object.freeze({ ...GEN4_PROGRESS, badges: JOHTO_BADGES }),
});

export function parseStormSilverSave(value, options) {
  return parseDsNeutralSave(value, STORM_SILVER_SAVE_CONFIG, options);
}
