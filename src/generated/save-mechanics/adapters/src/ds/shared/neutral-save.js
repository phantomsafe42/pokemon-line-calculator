import { readUint16LE } from "../../../../core/src/binary/little-endian.js";
import { createSaveSnapshot } from "../../../../core/src/contracts/save-snapshot.js";
import { decodeGen4Pokemon } from "../../../../core/src/ds/gen4/pokemon.js";
import { decodeGen5Pokemon } from "../../../../core/src/ds/gen5/pokemon.js";
import { openNintendoDsSaveContainer } from "../../../../core/src/ds/save-container.js";
import { locateDsPokemonRecords } from "../../../../core/src/ds/layouts/index.js";
import { readDsPlayerTrainerIdentity } from "../../../../core/src/ds/player-trainer-identity.js";
import { levelFromExperience } from "../../interpretation/experience.js";

const REQUIRED_CONTEXT_TABLES = Object.freeze(["SPECIES", "ITEMS", "ABILITIES", "MOVES", "NATURES", "LOCATIONS"]);

function requireContext(context) {
  for (const name of REQUIRED_CONTEXT_TABLES) {
    if (!context?.[name] || typeof context[name] !== "object") {
      throw new Error(`Save Mechanics Dataset context is missing ${name}`);
    }
  }
}

function findByNum(records, numericId) {
  return Object.values(records || {}).find(record => record && Number(record.num) === Number(numericId));
}

function findMove(records, numericId, lookupMode) {
  if (!Number.isInteger(numericId) || numericId <= 0) return undefined;
  if (lookupMode === "ordered-first") {
    const ordered = Object.values(records || {})[numericId - 1];
    if (ordered?.id && ordered?.name) return ordered;
  }
  return findByNum(records, numericId);
}

function findLocation(records, numericId) {
  return Object.values(records || {}).find(record => record && Number(record.metLocationId) === Number(numericId));
}

function resolveSpecies(context, decoded) {
  let species = findByNum(context.SPECIES, decoded.speciesNumericId);
  if (!species) return undefined;
  if (decoded.formIndex && species.formes?.[decoded.formIndex]) {
    species = context.SPECIES[species.formes[decoded.formIndex]] || species;
  }
  return species;
}

function isShiny(personalityValue, originalTrainerNumericId) {
  const tid = originalTrainerNumericId & 0xffff;
  const sid = originalTrainerNumericId >>> 16;
  const low = personalityValue & 0xffff;
  const high = personalityValue >>> 16;
  return ((tid ^ sid ^ low ^ high) & 0xffff) < 8;
}

function canonicalPokemon(record, config, context, options) {
  const decoded = config.generation === 4
    ? decodeGen4Pokemon(record.bytes, { storage: record.storage })
    : decodeGen5Pokemon(record.bytes, { storage: record.storage });
  if (!decoded) return undefined;
  if (options.rejectInvalidPokemonChecksums && !decoded.checksumValid) {
    throw new Error(`${config.gameId} ${record.storage} Pokémon at offset ${record.offset} has an invalid checksum`);
  }

  const species = resolveSpecies(context, decoded);
  if (!species) {
    throw new Error(`${config.gameId} ${record.storage} Pokémon at offset ${record.offset} has an unmapped species ID ${decoded.speciesNumericId}`);
  }
  const item = decoded.heldItemNumericId ? findByNum(context.ITEMS, decoded.heldItemNumericId) : undefined;
  const ability = findByNum(context.ABILITIES, decoded.abilityNumericId);
  const nature = findByNum(context.NATURES, decoded.natureNumericId);
  const level = decoded.partyLevel ?? levelFromExperience(decoded.experience, species.growthRate);
  const location = decoded.metLocationNumericId === 0x7d1
    ? { name: "Link Trade" }
    : findLocation(context.LOCATIONS, decoded.metLocationNumericId);
  const moves = decoded.moveNumericIds.map((numericId, index) => {
    const move = findMove(context.MOVES, numericId, config.moveLookup);
    const slot = { slot: index + 1, numericId, currentPp: decoded.movePp[index] };
    if (move && move.name !== "(No Move)") {
      slot.id = move.id;
      slot.name = move.calcName || move.name;
    }
    return slot;
  });

  const pokemon = {
    storage: record.storage,
    slot: record.slot,
    personalityValue: decoded.personalityValue,
    originalTrainerNumericId: decoded.originalTrainerNumericId,
    speciesNumericId: decoded.speciesNumericId,
    speciesId: species.id,
    speciesName: species.name,
    formIndex: decoded.formIndex,
    heldItemNumericId: decoded.heldItemNumericId,
    experience: decoded.experience,
    level,
    friendship: decoded.friendship,
    abilityNumericId: decoded.abilityNumericId,
    natureNumericId: decoded.natureNumericId,
    nickname: decoded.nickname,
    displayName: decoded.nickname || species.name,
    gender: decoded.genderCode,
    isEgg: decoded.isEgg,
    isShiny: isShiny(decoded.personalityValue, decoded.originalTrainerNumericId),
    moveNumericIds: decoded.moveNumericIds.slice(),
    movePp: decoded.movePp.slice(),
    moves,
    evs: { ...decoded.evs },
    ivs: { ...decoded.ivs },
    checksumValid: decoded.checksumValid,
  };
  if (record.storage === "box") pokemon.box = record.box;
  if (item) {
    pokemon.heldItemId = item.id;
    pokemon.heldItemName = item.calcName || item.name;
  }
  if (ability) {
    pokemon.abilityId = ability.id;
    pokemon.abilityName = ability.calcName || ability.name;
  }
  if (nature) {
    pokemon.natureId = nature.id;
    pokemon.natureName = nature.name;
  }
  if (decoded.metLocationNumericId !== null) {
    pokemon.metLocationNumericId = decoded.metLocationNumericId;
    if (location?.name) pokemon.metLocationName = location.name;
  }
  return pokemon;
}

function parseProgress(bytes, selection, config) {
  if (!config.progress) return undefined;
  const baseOffset = selection.smallBlockOffset ?? selection.blockOffset;
  if (!Number.isSafeInteger(baseOffset) || baseOffset < 0) {
    throw new Error(`${config.gameId} progress requires a selected save block`);
  }
  const badgeByte = bytes[baseOffset + config.progress.badgeByteOffset];
  const badges = Object.fromEntries(config.progress.badges.map(badge => [badge.id, (badgeByte & badge.mask) !== 0]));
  const progress = {
    badgeByte,
    badgeCount: Object.values(badges).filter(Boolean).length,
    badges,
  };
  if (Number.isInteger(config.progress.playTimeOffset)) {
    const offset = baseOffset + config.progress.playTimeOffset;
    const hours = readUint16LE(bytes, offset);
    const minutes = bytes[offset + 2];
    const seconds = bytes[offset + 3];
    progress.playTime = {
      hours,
      minutes,
      seconds,
      totalSeconds: (hours * 3600) + (minutes * 60) + seconds,
    };
  }
  return progress;
}

export function parseDsNeutralSave(value, config, {
  context,
  sourceName = "Selected save",
  observedAt,
  rejectInvalidPokemonChecksums = false,
  requireReadableParty = false,
} = {}) {
  requireContext(context);
  const container = openNintendoDsSaveContainer(value, { label: `${config.gameId} save` });
  const located = locateDsPokemonRecords(container.bytes, config.formatId, { requireReadableParty });
  const parse = record => canonicalPokemon(record, config, context, { rejectInvalidPokemonChecksums });
  const party = located.party.map(parse).filter(Boolean);
  const boxes = located.boxes.map(parse).filter(Boolean);
  return createSaveSnapshot({
    gameId: config.gameId,
    platformId: "ds",
    generation: config.generation,
    formatId: config.formatId,
    source: {
      name: String(sourceName).slice(0, 240),
      bytes: container.sourceByteLength,
      containerFormat: container.container === "desmume-dsv" ? "dsv" : "sav",
    },
    selection: located.selection,
    playerTrainerIdentity: readDsPlayerTrainerIdentity(container.bytes, config.formatId, located.selection),
    storage: { boxCount: located.boxes.length / 30, slotsPerBox: 30 },
    party,
    boxes,
    progress: parseProgress(container.bytes, located.selection, config),
    diagnostics: [],
    observedAt,
  });
}
