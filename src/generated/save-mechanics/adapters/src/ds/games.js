import { PLATINUM_KAIZO_SAVE_CONFIG, parsePlatinumKaizoSave } from "./gen4/platinum-kaizo.js";
import { RENEGADE_PLATINUM_SAVE_CONFIG, parseRenegadePlatinumSave } from "./gen4/renegade-platinum.js";
import { STORM_SILVER_SAVE_CONFIG, parseStormSilverSave } from "./gen4/storm-silver.js";
import { POKEMON_DIAMOND_SAVE_CONFIG, parsePokemonDiamondSave } from "./gen4/diamond.js";
import { POKEMON_PEARL_SAVE_CONFIG, parsePokemonPearlSave } from "./gen4/pearl.js";
import { POKEMON_PLATINUM_SAVE_CONFIG, parsePokemonPlatinumSave } from "./gen4/platinum.js";
import { POKEMON_HEARTGOLD_SAVE_CONFIG, parsePokemonHeartGoldSave } from "./gen4/heartgold.js";
import { POKEMON_SOULSILVER_SAVE_CONFIG, parsePokemonSoulSilverSave } from "./gen4/soulsilver.js";
import { POKEMON_BLACK_SAVE_CONFIG, parsePokemonBlackSave } from "./gen5/black.js";
import { POKEMON_WHITE_SAVE_CONFIG, parsePokemonWhiteSave } from "./gen5/white.js";
import { POKEMON_BLACK_2_SAVE_CONFIG, parsePokemonBlack2Save } from "./gen5/black-2.js";
import { POKEMON_WHITE_2_SAVE_CONFIG, parsePokemonWhite2Save } from "./gen5/white-2.js";
import { VOLT_WHITE_2R_SAVE_CONFIG, parseVoltWhite2RSave } from "./gen5/volt-white-2r.js";

export const DS_SAVE_GAME_CONFIGS = Object.freeze({
  [PLATINUM_KAIZO_SAVE_CONFIG.gameId]: PLATINUM_KAIZO_SAVE_CONFIG,
  [RENEGADE_PLATINUM_SAVE_CONFIG.gameId]: RENEGADE_PLATINUM_SAVE_CONFIG,
  [STORM_SILVER_SAVE_CONFIG.gameId]: STORM_SILVER_SAVE_CONFIG,
  [POKEMON_DIAMOND_SAVE_CONFIG.gameId]: POKEMON_DIAMOND_SAVE_CONFIG,
  [POKEMON_PEARL_SAVE_CONFIG.gameId]: POKEMON_PEARL_SAVE_CONFIG,
  [POKEMON_PLATINUM_SAVE_CONFIG.gameId]: POKEMON_PLATINUM_SAVE_CONFIG,
  [POKEMON_HEARTGOLD_SAVE_CONFIG.gameId]: POKEMON_HEARTGOLD_SAVE_CONFIG,
  [POKEMON_SOULSILVER_SAVE_CONFIG.gameId]: POKEMON_SOULSILVER_SAVE_CONFIG,
  [POKEMON_BLACK_SAVE_CONFIG.gameId]: POKEMON_BLACK_SAVE_CONFIG,
  [POKEMON_WHITE_SAVE_CONFIG.gameId]: POKEMON_WHITE_SAVE_CONFIG,
  [POKEMON_BLACK_2_SAVE_CONFIG.gameId]: POKEMON_BLACK_2_SAVE_CONFIG,
  [POKEMON_WHITE_2_SAVE_CONFIG.gameId]: POKEMON_WHITE_2_SAVE_CONFIG,
  [VOLT_WHITE_2R_SAVE_CONFIG.gameId]: VOLT_WHITE_2R_SAVE_CONFIG,
});

const PARSERS = Object.freeze({
  "platinum-kaizo": parsePlatinumKaizoSave,
  "renegade-platinum": parseRenegadePlatinumSave,
  "storm-silver": parseStormSilverSave,
  "pokemon-diamond": parsePokemonDiamondSave,
  "pokemon-pearl": parsePokemonPearlSave,
  "pokemon-platinum": parsePokemonPlatinumSave,
  "pokemon-heartgold": parsePokemonHeartGoldSave,
  "pokemon-soulsilver": parsePokemonSoulSilverSave,
  "pokemon-black": parsePokemonBlackSave,
  "pokemon-white": parsePokemonWhiteSave,
  "pokemon-black-2": parsePokemonBlack2Save,
  "pokemon-white-2": parsePokemonWhite2Save,
  "volt-white-2r": parseVoltWhite2RSave,
});

export function parseDsGameSave(value, { gameId, ...options } = {}) {
  const parser = PARSERS[gameId];
  if (!parser) throw new Error(`Unsupported DS save game: ${gameId}`);
  return parser(value, options);
}
