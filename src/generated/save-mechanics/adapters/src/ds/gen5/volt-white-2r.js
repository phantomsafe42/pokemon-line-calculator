import { parseDsNeutralSave } from "../shared/neutral-save.js";

export const VOLT_WHITE_2R_SAVE_CONFIG = Object.freeze({
  gameId: "volt-white-2r", formatId: "bw2", generation: 5,
  datasetDirectory: "Volt White 2R", datasetPrefix: "VW2R", moveLookup: "numeric",
});

export function parseVoltWhite2RSave(value, options) {
  return parseDsNeutralSave(value, VOLT_WHITE_2R_SAVE_CONFIG, options);
}
