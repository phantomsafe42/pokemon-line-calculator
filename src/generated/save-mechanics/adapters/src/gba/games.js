import { parseFireRedOmegaSave } from "./fire-red-omega.js";
import { parsePokemonUnboundSave } from "./pokemon-unbound.js";
import { POKEMON_RUBY_SAVE_CONFIG, parsePokemonRubySave } from "./ruby.js";
import { POKEMON_SAPPHIRE_SAVE_CONFIG, parsePokemonSapphireSave } from "./sapphire.js";
import { POKEMON_EMERALD_SAVE_CONFIG, parsePokemonEmeraldSave } from "./emerald.js";
import { POKEMON_FIRERED_SAVE_CONFIG, parsePokemonFireRedSave } from "./firered.js";
import { POKEMON_LEAFGREEN_SAVE_CONFIG, parsePokemonLeafGreenSave } from "./leafgreen.js";
import { EMERALD_SEAGLASS_SAVE_CONFIG, parseEmeraldSeaglassSave } from "./emerald-seaglass.js";

export const GBA_SAVE_GAME_CONFIGS = Object.freeze({
  "fire-red-omega": Object.freeze({ gameId: "fire-red-omega", formatId: "frlg" }),
  "pokemon-unbound": Object.freeze({ gameId: "pokemon-unbound", formatId: "unbound" }),
  [POKEMON_RUBY_SAVE_CONFIG.gameId]: POKEMON_RUBY_SAVE_CONFIG,
  [POKEMON_SAPPHIRE_SAVE_CONFIG.gameId]: POKEMON_SAPPHIRE_SAVE_CONFIG,
  [POKEMON_EMERALD_SAVE_CONFIG.gameId]: POKEMON_EMERALD_SAVE_CONFIG,
  [POKEMON_FIRERED_SAVE_CONFIG.gameId]: POKEMON_FIRERED_SAVE_CONFIG,
  [POKEMON_LEAFGREEN_SAVE_CONFIG.gameId]: POKEMON_LEAFGREEN_SAVE_CONFIG,
  [EMERALD_SEAGLASS_SAVE_CONFIG.gameId]: EMERALD_SEAGLASS_SAVE_CONFIG,
});

function parseFro(value, options) {
  return parseFireRedOmegaSave(value, {
    context: options.context,
    observedAt: options.observedAt,
    sourceName: options.sourceName,
    rejectInvalidSectionChecksums: options.rejectInvalidSectionChecksums,
    rejectInvalidPokemonChecksums: options.rejectInvalidPokemonChecksums,
  });
}

function parseUnbound(value, options) {
  return parsePokemonUnboundSave(value, {
    context: options.context,
    observedAt: options.observedAt,
    sourceName: options.sourceName,
  });
}

const PARSERS = Object.freeze({
  "fire-red-omega": parseFro,
  "pokemon-unbound": parseUnbound,
  [POKEMON_RUBY_SAVE_CONFIG.gameId]: parsePokemonRubySave,
  [POKEMON_SAPPHIRE_SAVE_CONFIG.gameId]: parsePokemonSapphireSave,
  [POKEMON_EMERALD_SAVE_CONFIG.gameId]: parsePokemonEmeraldSave,
  [POKEMON_FIRERED_SAVE_CONFIG.gameId]: parsePokemonFireRedSave,
  [POKEMON_LEAFGREEN_SAVE_CONFIG.gameId]: parsePokemonLeafGreenSave,
  [EMERALD_SEAGLASS_SAVE_CONFIG.gameId]: parseEmeraldSeaglassSave,
});

export function parseGbaGameSave(value, { gameId, ...options } = {}) {
  const parser = PARSERS[gameId];
  if (!parser) throw new Error(`Unsupported GBA save game: ${gameId}`);
  return parser(value, options);
}
