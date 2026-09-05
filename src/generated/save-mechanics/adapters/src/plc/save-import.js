import { decodeGen45Pokemon } from "../../../core/src/gen45/pokemon.js";
import { openNintendoDsSaveContainer } from "../../../core/src/gen45/save-container.js";
import { GEN45_SAVE_LAYOUTS, locateGen45PokemonRecords } from "../../../core/src/gen45/save-layout.js";
import { FRO_BOX_COUNT, parseFireRedOmegaSave } from "../gen3/fire-red-omega.js";
import { UNBOUND_BOX_COUNT, parsePokemonUnboundSave } from "../gen3/pokemon-unbound.js";
import { levelFromRunHistoryExperience } from "../gen45/experience.js";
import { createStandardizedSaveIdentityResolver } from "../identity/standardized-save-identity.js";

const PLC_SAVE_GAMES = Object.freeze({
  "fire-red-omega": Object.freeze({ generation: 3, formatId: "frlg" }),
  "pokemon-unbound": Object.freeze({ generation: 3, formatId: "unbound" }),
  "platinum-kaizo": Object.freeze({ generation: 4, formatId: "dppt" }),
  "renegade-platinum": Object.freeze({ generation: 4, formatId: "dppt" }),
  "storm-silver": Object.freeze({ generation: 4, formatId: "hgss" }),
  "volt-white-2r": Object.freeze({ generation: 5, formatId: "bw2" }),
});

function canonicalStats(values = {}) {
  return {
    hp: Number(values.hp ?? 0),
    atk: Number(values.atk ?? values.at ?? 0),
    def: Number(values.def ?? values.df ?? 0),
    spa: Number(values.spa ?? values.sa ?? 0),
    spd: Number(values.spd ?? values.sd ?? 0),
    spe: Number(values.spe ?? values.sp ?? 0),
  };
}

function requireDataset(dataset, gameId) {
  if (!dataset || dataset.gameId !== gameId || typeof dataset.get !== "function" || typeof dataset.getBySaveNumericId !== "function") {
    throw new Error(`A standardized ${gameId} Dataset context is required`);
  }
}

function resolveSaveIdentity(dataset, kind, numericId, record, { allowZero = true } = {}) {
  const normalizedId = Number(numericId);
  if (!Number.isInteger(normalizedId) || normalizedId < 0) {
    throw new Error(`${dataset.gameId} ${record.storage} Pokémon at offset ${record.offset ?? "unknown"} has an invalid ${kind} ID ${numericId}`);
  }
  if (allowZero && normalizedId === 0) return null;
  const resolved = dataset.getBySaveNumericId(kind, normalizedId)
    || [...(dataset.indexes?.[kind]?.values?.() || [])].find(entry => Number(entry?.num) === normalizedId)
    || null;
  if (!resolved) {
    throw new Error(`${dataset.gameId} ${record.storage} Pokémon at offset ${record.offset ?? "unknown"} has an unmapped ${kind} ID ${normalizedId}`);
  }
  return resolved;
}

function baseSpeciesByNumericId(dataset, numericId) {
  const mapped = dataset.getBySaveNumericId("species", numericId);
  if (mapped) return mapped;
  const candidates = [...dataset.indexes.species.values()].filter(record => Number(record.num) === Number(numericId));
  return candidates.find(record => !record.baseSpecies) || candidates[0] || null;
}

function normalizeRecord({
  decoded,
  record,
  species,
  ability,
  item,
  nature,
  moves,
  level,
  gameId,
  importedAt,
  normalizePokemon,
}) {
  return normalizePokemon({
    id: `pokemon-save-${decoded.personalityValue.toString(16).padStart(8, "0")}-${record.storage}-${record.box || 0}-${record.slot}`,
    speciesId: species.id,
    formId: species.id,
    displayName: species.name,
    nickname: decoded.nickname,
    level,
    experience: decoded.experience,
    gender: decoded.genderCode,
    friendship: decoded.friendship,
    natureId: nature?.id || "serious",
    abilityId: ability?.id || species.abilities?.[0],
    itemId: item?.id || null,
    baseStats: species.baseStats,
    ivs: canonicalStats(decoded.ivs),
    evs: canonicalStats(decoded.evs),
    moves,
    source: {
      kind: `${gameId}-save-import`,
      pid: decoded.personalityValue,
      storage: record.storage,
      box: record.box,
      slot: record.slot,
      importedAt,
    },
  });
}

function parseGen45Pokemon(record, dataset, config, options) {
  const decoded = decodeGen45Pokemon(record.bytes, { generation: config.generation, storage: record.storage });
  if (!decoded || decoded.isEgg) return null;
  if (options.rejectInvalidPokemonChecksums && !decoded.checksumValid) {
    throw new Error(`${dataset.gameId} ${record.storage} Pokémon at offset ${record.offset} has an invalid checksum`);
  }
  let species = baseSpeciesByNumericId(dataset, decoded.speciesNumericId);
  if (!species) {
    throw new Error(`${dataset.gameId} ${record.storage} Pokémon at offset ${record.offset} has an unmapped species ID ${decoded.speciesNumericId}`);
  }
  if (decoded.formIndex && species.formes?.[decoded.formIndex]) {
    species = dataset.get("species", species.formes[decoded.formIndex]) || species;
  }
  const item = resolveSaveIdentity(dataset, "items", decoded.heldItemNumericId, record);
  const ability = resolveSaveIdentity(dataset, "abilities", decoded.abilityNumericId, record, { allowZero: false });
  const nature = resolveSaveIdentity(dataset, "natures", decoded.natureNumericId, record, { allowZero: false });
  const level = decoded.partyLevel ?? levelFromRunHistoryExperience(decoded.experience, species.growthRate);
  const moves = decoded.moveNumericIds.map((numericId, index) => {
    const move = resolveSaveIdentity(dataset, "moves", numericId, record);
    if (!move || move.name === "(No Move)") return null;
    return {
      moveId: move.id,
      name: move.name,
      type: move.type,
      basePower: Number(move.basePower || 0),
      pp: Number(decoded.movePp[index]) || Number(move.pp || 0),
    };
  }).filter(Boolean);
  return normalizeRecord({ decoded, record, species, ability, item, nature, moves, level, gameId: dataset.gameId, ...options });
}

function gen3Context(dataset, identity) {
  const byNumeric = kind => numericId => dataset.getBySaveNumericId(kind, numericId);
  return {
    resolveSpeciesIdentity: numericId => identity.resolveSpecies(numericId),
    resolveSpecies: numericId => identity.resolveSpecies(numericId),
    resolveMove: byNumeric("moves"),
    resolveItem: byNumeric("items"),
    resolveNature: numericId => dataset.getBySaveNumericId("natures", numericId)
      || [...(dataset.indexes?.natures?.values?.() || [])].find(entry => Number(entry?.num) === Number(numericId))
      || null,
    resolveLocation: () => null,
    resolveAbilityIdentity({ speciesNumericId, abilityBit }) {
      return identity.resolveAbility({ speciesNumericId, abilitySlot: abilityBit }).ability;
    },
    resolveAbility({ speciesNumericId, abilityBit }) {
      return identity.resolveAbility({ speciesNumericId, abilitySlot: abilityBit }).ability;
    },
    levelFromExperience({ speciesNumericId, experience }) {
      const species = dataset.getBySaveNumericId("species", speciesNumericId);
      return levelFromRunHistoryExperience(experience, species?.growthRate);
    },
  };
}

function recordFromFro(mon, dataset, identity, options) {
  const species = identity.resolveSpecies(mon.speciesId);
  const abilityResolution = identity.resolveAbility({ speciesNumericId: mon.speciesId, abilitySlot: mon.abilityBit });
  const ability = abilityResolution.ability;
  if (mon.speciesCanonicalId && mon.speciesCanonicalId !== species.id) {
    throw new Error(`fire-red-omega ${mon.storage} Pokémon species identity changed between parse and PLC projection`);
  }
  if (mon.abilityId && mon.abilityId !== ability.id) {
    throw new Error(`fire-red-omega ${mon.storage} Pokémon ability identity changed between parse and PLC projection`);
  }
  const item = mon.itemId ? dataset.getBySaveNumericId("items", mon.itemId) : null;
  if (mon.itemId && !item) throw new Error(`fire-red-omega ${mon.storage} Pokémon has an unmapped items ID ${mon.itemId}`);
  const nature = dataset.getBySaveNumericId("natures", mon.natureId)
    || [...(dataset.indexes?.natures?.values?.() || [])].find(entry => Number(entry?.num) === Number(mon.natureId))
    || null;
  const moves = mon.moveIds.map(numericId => {
    const move = dataset.getBySaveNumericId("moves", numericId);
    if (!move) throw new Error(`fire-red-omega ${mon.storage} Pokémon has an unmapped moves ID ${numericId}`);
    return { moveId: move.id, name: move.name, type: move.type, basePower: Number(move.basePower || 0), pp: Number(move.pp || 0) };
  });
  return options.normalizePokemon({
    id: `pokemon-save-${mon.pid.toString(16).padStart(8, "0")}-${mon.storage}-${mon.box || 0}-${mon.slot}`,
    speciesId: species.id,
    formId: species.id,
    displayName: species.name,
    nickname: mon.nickname,
    level: mon.level,
    experience: mon.experience,
    gender: mon.gender || null,
    natureId: nature?.id || "serious",
    abilityId: ability.id,
    itemId: item?.id || null,
    baseStats: species.baseStats,
    ivs: canonicalStats(mon.ivs),
    evs: canonicalStats(mon.evs),
    moves,
    source: { kind: "fire-red-omega-save-import", pid: mon.pid, storage: mon.storage, box: mon.box, slot: mon.slot, importedAt: options.importedAt },
  });
}

function normalizedIdentity(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function unboundContext(dataset) {
  const byNum = kind => new Map([...dataset.indexes[kind].values()].map(record => [Number(record.num), record]));
  const speciesByNum = byNum("species");
  return {
    speciesByNum,
    rawSpeciesByNum: speciesByNum,
    movesByNum: byNum("moves"),
    itemsByNum: byNum("items"),
    naturesByNum: byNum("natures"),
    abilitiesById: Object.fromEntries([...dataset.indexes.abilities.values()].map(record => [record.id, record])),
  };
}

function recordFromUnbound(mon, dataset, options) {
  const species = dataset.getBySaveNumericId("species", mon.speciesId)
    || [...dataset.indexes.species.values()].find(entry => Number(entry.num) === Number(mon.speciesId));
  if (!species) throw new Error(`pokemon-unbound ${mon.storage} Pokémon has an unmapped species ID ${mon.speciesId}`);
  const ability = [...dataset.indexes.abilities.values()].find(entry => normalizedIdentity(entry.id || entry.name) === normalizedIdentity(mon.ability));
  const item = mon.itemId ? dataset.getBySaveNumericId("items", mon.itemId)
    || [...dataset.indexes.items.values()].find(entry => Number(entry.num) === Number(mon.itemId)) : null;
  if (mon.itemId && !item) throw new Error(`pokemon-unbound ${mon.storage} Pokémon has an unmapped items ID ${mon.itemId}`);
  const nature = dataset.getBySaveNumericId("natures", mon.natureId)
    || [...dataset.indexes.natures.values()].find(entry => Number(entry.num) === Number(mon.natureId));
  const moves = mon.moveIds.filter(Boolean).map((numericId, index) => {
    const move = dataset.getBySaveNumericId("moves", numericId)
      || [...dataset.indexes.moves.values()].find(entry => Number(entry.num) === Number(numericId));
    if (!move) throw new Error(`pokemon-unbound ${mon.storage} Pokémon has an unmapped moves ID ${numericId}`);
    return { moveId: move.id, name: move.name, type: move.type, basePower: Number(move.basePower || 0), pp: Number(mon.movePp?.[index]) || Number(move.pp || 0) };
  });
  return options.normalizePokemon({
    id: `pokemon-save-${mon.pid.toString(16).padStart(8, "0")}-${mon.storage}-${mon.box || 0}-${mon.slot}`,
    speciesId: species.id,
    formId: species.id,
    displayName: species.name,
    nickname: mon.nickname,
    level: mon.level,
    experience: mon.exp,
    gender: mon.gender === "male" ? "M" : mon.gender === "female" ? "F" : mon.gender === "genderless" ? "N" : null,
    natureId: nature?.id || "serious",
    abilityId: ability?.id || species.abilities?.[Number(mon.abilitySlot) || 0],
    itemId: item?.id || null,
    baseStats: species.baseStats,
    ivs: canonicalStats(mon.ivs),
    evs: canonicalStats(mon.evs),
    moves,
    source: { kind: "pokemon-unbound-save-import", pid: mon.pid, storage: mon.storage, box: mon.box, slot: mon.slot, importedAt: options.importedAt },
  });
}

function finalizeImport({ dataset, sourceName, pokemon, party, boxCount, blockOffset = null }) {
  const pcBoxes = Array.from({ length: boxCount }, (_, index) => {
    const boxNumber = index + 1;
    return { boxNumber, pokemonCount: pokemon.filter(record => record.source?.storage === "box" && Number(record.source?.sourceBox ?? record.source?.box) === boxNumber).length };
  });
  return {
    gameId: dataset.gameId,
    sourceName: String(sourceName).slice(0, 240),
    pokemon,
    partyPokemonIds: party.map(record => record.id),
    partyCount: party.length,
    boxCount: pokemon.length - party.length,
    pcBoxes,
    totalCount: pokemon.length,
    blockOffset,
  };
}

function parseFireRedOmegaPlcSave(value, dataset, options) {
  const identity = createStandardizedSaveIdentityResolver(dataset, { expectedGameId: "fire-red-omega" });
  const parsed = parseFireRedOmegaSave(value, {
    context: gen3Context(dataset, identity),
    updatedAt: options.importedAt,
    saveFile: options.sourceName,
    rejectInvalidPokemonChecksums: options.rejectInvalidPokemonChecksums,
    legacyCompactBoxLocations: false,
  });
  const party = parsed.collectionPayload.party.map(mon => recordFromFro(mon, dataset, identity, options));
  const boxes = parsed.collectionPayload.boxes.map(mon => recordFromFro(mon, dataset, identity, options));
  return finalizeImport({ dataset, sourceName: options.sourceName, pokemon: [...party, ...boxes], party, boxCount: FRO_BOX_COUNT, blockOffset: parsed.parserMeta.activeSlot });
}

function parsePokemonUnboundPlcSave(value, dataset, options) {
  const parsed = parsePokemonUnboundSave(value, { context: unboundContext(dataset), updatedAt: options.importedAt, saveFile: options.sourceName });
  const party = parsed.party.map(mon => recordFromUnbound(mon, dataset, options));
  const boxes = parsed.boxes.map(mon => recordFromUnbound(mon, dataset, options));
  return finalizeImport({ dataset, sourceName: options.sourceName, pokemon: [...party, ...boxes], party, boxCount: UNBOUND_BOX_COUNT, blockOffset: parsed.saveIndex });
}

function parseDsPlcSave(value, dataset, config, options) {
  const { bytes } = openNintendoDsSaveContainer(value, { label: `${dataset.gameId} save import` });
  const located = locateGen45PokemonRecords(bytes, config.formatId, { requireReadableParty: true });
  const parse = record => parseGen45Pokemon(record, dataset, config, options);
  const party = located.party.map(parse).filter(Boolean);
  const boxes = located.boxes.map(parse).filter(Boolean);
  return finalizeImport({
    dataset,
    sourceName: options.sourceName,
    pokemon: [...party, ...boxes],
    party,
    boxCount: Math.ceil(GEN45_SAVE_LAYOUTS[config.formatId].boxSlotCount / 30),
    blockOffset: located.selection.blockOffset ?? located.selection.smallBlockOffset,
  });
}

export function parsePlcSave(value, dataset, {
  sourceName = "Selected save",
  importedAt = new Date().toISOString(),
  normalizePokemon = record => record,
  rejectInvalidPokemonChecksums = false,
} = {}) {
  const config = PLC_SAVE_GAMES[dataset?.gameId];
  if (!config) throw new Error(`PLC save import is unavailable for ${dataset?.gameId || "the selected game"}`);
  requireDataset(dataset, dataset.gameId);
  if (typeof normalizePokemon !== "function") throw new TypeError("normalizePokemon must be a function");
  const options = { sourceName, importedAt, normalizePokemon, rejectInvalidPokemonChecksums };
  const imported = config.formatId === "unbound"
    ? parsePokemonUnboundPlcSave(value, dataset, options)
    : config.generation === 3
      ? parseFireRedOmegaPlcSave(value, dataset, options)
    : parseDsPlcSave(value, dataset, config, options);
  if (!imported.pokemon.length) throw new Error("The selected save contained no readable Pokémon");
  return imported;
}

export function selectPlcSavePokemon(imported, selectedPcBoxNumbers = []) {
  if (!PLC_SAVE_GAMES[imported?.gameId] || !Array.isArray(imported?.pokemon) || !Array.isArray(imported?.partyPokemonIds)) {
    throw new Error("A parsed PLC save import is required");
  }
  const available = new Set((imported.pcBoxes || []).map(entry => Number(entry.boxNumber)));
  const selected = [...new Set((selectedPcBoxNumbers || []).map(Number))].sort((left, right) => left - right);
  if (selected.some(boxNumber => !Number.isInteger(boxNumber) || !available.has(boxNumber))) {
    throw new Error("The PC Box selection contains a box that is unavailable in this save import");
  }
  const selectedSet = new Set(selected);
  const partyIds = new Set(imported.partyPokemonIds.map(String));
  const party = imported.pokemon.filter(record => partyIds.has(String(record.id)) || record.source?.storage === "party");
  const boxed = imported.pokemon.filter(record => record.source?.storage === "box" && selectedSet.has(Number(record.source?.sourceBox ?? record.source?.box)));
  return {
    pokemon: [...party, ...boxed],
    partyPokemonIds: party.map(record => record.id),
    partyCount: party.length,
    boxCount: boxed.length,
    totalCount: party.length + boxed.length,
    selectedPcBoxNumbers: selected,
  };
}

export const PLC_SAVE_GAME_CONFIGS = PLC_SAVE_GAMES;
