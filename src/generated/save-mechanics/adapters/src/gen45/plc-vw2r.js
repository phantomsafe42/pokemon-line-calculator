import { asBytes } from "../../../core/src/binary/little-endian.js";
import { decodeGen45Pokemon } from "../../../core/src/gen45/pokemon.js";
import { locateGen45PokemonRecords } from "../../../core/src/gen45/save-layout.js";
import { levelFromRunHistoryExperience } from "./experience.js";

const VW2R_GAME_ID = "volt-white-2r";
const PC_BOX_COUNT = 7;

function baseSpeciesByNumericId(dataset, numericId) {
  const candidates = [...dataset.indexes.species.values()]
    .filter(record => Number(record.num) === Number(numericId));
  return candidates.find(record => !record.baseSpecies) || candidates[0] || null;
}

function parsePokemon(record, dataset, {
  importedAt,
  normalizePokemon,
  rejectInvalidPokemonChecksums,
}) {
  const decoded = decodeGen45Pokemon(record.bytes, {
    generation: 5,
    storage: record.storage,
  });
  if (!decoded) return null;
  if (rejectInvalidPokemonChecksums && !decoded.checksumValid) {
    throw new Error(`VW2R ${record.storage} Pokémon at offset ${record.offset} has an invalid checksum`);
  }

  let species = baseSpeciesByNumericId(dataset, decoded.speciesNumericId);
  if (!species) return null;
  if (decoded.formIndex && species.formes?.[decoded.formIndex]) {
    species = dataset.get("species", species.formes[decoded.formIndex]) || species;
  }
  if (decoded.isEgg) return null;

  const item = dataset.getBySaveNumericId("items", decoded.heldItemNumericId);
  const ability = dataset.getBySaveNumericId("abilities", decoded.abilityNumericId);
  const nature = dataset.getBySaveNumericId("natures", decoded.natureNumericId);
  const level = decoded.partyLevel
    ?? levelFromRunHistoryExperience(decoded.experience, species.growthRate);
  const moves = decoded.moveNumericIds.map((numericId, index) => {
    const move = dataset.getBySaveNumericId("moves", numericId);
    if (!move || move.name === "(No Move)") return null;
    const storedPp = Number(decoded.movePp[index]);
    return {
      moveId: move.id,
      name: move.name,
      type: move.type,
      basePower: Number(move.basePower || 0),
      pp: storedPp || Number(move.pp || 0),
    };
  }).filter(Boolean);

  return normalizePokemon({
    id: `pokemon-save-${decoded.personalityValue.toString(16).padStart(8, "0")}-${record.storage}-${record.box || 0}-${record.slot}`,
    speciesId: species.id,
    formId: species.id,
    displayName: species.name,
    nickname: decoded.nickname,
    level,
    experience: decoded.experience,
    gender: decoded.genderCode,
    natureId: nature?.id || "serious",
    abilityId: ability?.id || species.abilities?.[0],
    itemId: item?.id || null,
    baseStats: species.baseStats,
    ivs: decoded.ivs,
    evs: decoded.evs,
    moves,
    source: {
      kind: "vw2r-save-import",
      pid: decoded.personalityValue,
      storage: record.storage,
      box: record.box,
      slot: record.slot,
      importedAt,
    },
  });
}

export function parseVw2rPlcSave(value, dataset, {
  sourceName = "Selected VW2R save",
  importedAt = new Date().toISOString(),
  normalizePokemon = record => record,
  rejectInvalidPokemonChecksums = false,
} = {}) {
  if (dataset?.gameId !== VW2R_GAME_ID) {
    throw new Error("This save adapter is available only for Volt White 2 Redux");
  }
  if (typeof normalizePokemon !== "function") throw new TypeError("normalizePokemon must be a function");
  const bytes = asBytes(value, { label: "VW2R save import" });
  if (bytes.byteLength !== 0x80000 && bytes.byteLength !== 0x80000 + 122) {
    throw new Error(`Expected a 524288-byte .sav or 524410-byte .dsv; received ${bytes.byteLength} bytes`);
  }
  const located = locateGen45PokemonRecords(bytes, "bw2", { requireReadableParty: true });
  const options = { importedAt, normalizePokemon, rejectInvalidPokemonChecksums };
  const party = located.party.map(record => parsePokemon(record, dataset, options)).filter(Boolean);
  const boxed = located.boxes.map(record => parsePokemon(record, dataset, options)).filter(Boolean);
  const pokemon = [...party, ...boxed];
  if (!pokemon.length) throw new Error("The selected save contained no readable Pokémon");
  const pcBoxes = Array.from({ length: PC_BOX_COUNT }, (_, index) => {
    const boxNumber = index + 1;
    return {
      boxNumber,
      pokemonCount: boxed.filter(record => Number(record.source?.sourceBox ?? record.source?.box) === boxNumber).length,
    };
  });

  return {
    gameId: dataset.gameId,
    sourceName: String(sourceName).slice(0, 240),
    pokemon,
    partyPokemonIds: party.map(record => record.id),
    partyCount: party.length,
    boxCount: boxed.length,
    pcBoxes,
    totalCount: pokemon.length,
    blockOffset: located.selection.blockOffset,
  };
}

export function selectVw2rPlcSavePokemon(imported, selectedPcBoxNumbers = []) {
  if (imported?.gameId !== VW2R_GAME_ID || !Array.isArray(imported?.pokemon) || !Array.isArray(imported?.partyPokemonIds)) {
    throw new Error("A parsed VW2R save import is required");
  }
  const available = new Set((imported.pcBoxes || []).map(entry => Number(entry.boxNumber)));
  const selected = [...new Set((selectedPcBoxNumbers || []).map(Number))].sort((left, right) => left - right);
  if (selected.some(boxNumber => !Number.isInteger(boxNumber) || !available.has(boxNumber))) {
    throw new Error("The PC Box selection contains a box that is unavailable in this save import");
  }
  const selectedSet = new Set(selected);
  const partyIds = new Set(imported.partyPokemonIds.map(String));
  const party = imported.pokemon.filter(record => partyIds.has(String(record.id)) || record.source?.storage === "party");
  const boxed = imported.pokemon.filter(record =>
    record.source?.storage === "box"
    && selectedSet.has(Number(record.source?.sourceBox ?? record.source?.box))
  );
  return {
    pokemon: [...party, ...boxed],
    partyPokemonIds: party.map(record => record.id),
    partyCount: party.length,
    boxCount: boxed.length,
    totalCount: party.length + boxed.length,
    selectedPcBoxNumbers: selected,
  };
}
