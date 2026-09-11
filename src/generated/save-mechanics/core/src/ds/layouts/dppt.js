import { PLATINUM_SAVE_LAYOUT } from "./platinum.js";

// Backward-compatible identity for existing hack consumers. New adapters name
// the actual physical layout ("dp" or "platinum") explicitly.
export const DPPT_SAVE_LAYOUT = Object.freeze({ ...PLATINUM_SAVE_LAYOUT, id: "dppt" });
