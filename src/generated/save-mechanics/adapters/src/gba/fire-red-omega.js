import { asBytes, readUint8 } from "../../../core/src/binary/little-endian.js";
import { decodeGen3PokemonRecord } from "../../../core/src/gba/pokemon.js";
import { reassembleGen3Sections, selectGen3SaveSlot, verifyGen3SectionChecksums } from "../../../core/src/gba/sectors.js";
import { decodeGen3Text } from "../../../core/src/gba/text.js";
import { readGbaPlayerTrainerIdentity } from "../../../core/src/gba/player-trainer-identity.js";
import { createGbaNeutralSnapshot } from "./shared/neutral-projection.js";

export const FRO_SAVE_BLOCK2_SECTION_IDS = Object.freeze([0]);
export const FRO_SAVE_BLOCK1_SECTION_IDS = Object.freeze([1, 2, 3, 4]);
export const FRO_STORAGE_SECTION_IDS = Object.freeze([5, 6, 7, 8, 9, 10, 11, 12, 13]);
export const FRO_PARTY_COUNT_OFFSET = 0x34;
export const FRO_PARTY_OFFSET = 0x38;
export const FRO_PARTY_RECORD_SIZE = 100;
export const FRO_BOX_RECORD_SIZE = 80;
export const FRO_BOX_COUNT = 14;
export const FRO_SLOTS_PER_BOX = 30;

const FIRST_UNALIGNED_NATIONAL_SPECIES = 252;
const FIRST_UNALIGNED_INTERNAL_SPECIES = 277;
const INTERNAL_TO_NATIONAL_OFFSETS = Object.freeze([
  -25, -25, -25, -25, -25, -25, -25, -25, -25, -25, -25, -25, -25,
  -25, -25, -25, -25, -25, -25, -25, -25, -25, -25, -25, -11, -11,
  -11, -28, -28, -21, -21, 19, -31, -31, -28, -28, 7, 7, -15, -15,
  35, 25, 25, -21, 3, -20, 16, 16, 45, 15, 15, 21, 21, -12, -12,
  -4, -4, -4, -39, -39, -28, -28, -17, -17, 22, 22, 22, -13, -13,
  15, 15, -11, -11, -52, -26, -26, -42, -42, -52, -49, -49, -25,
  -25, 0, -6, -6, -48, -77, -77, -77, -51, -51, -12, -77, -77,
  -77, -7, -7, -7, -17, -24, -24, -43, -45, -12, -78, -78, -78,
  -34, -73, -73, -43, -43, -43, -43, -112, -112, -112, -24, -24,
  -24, -24, -24, -24, -24, -24, -24, -22, -22, -22, -27, -27,
  -24, -24, -53,
]);

const NATURE_NAMES = Object.freeze([
  "Hardy", "Lonely", "Brave", "Adamant", "Naughty",
  "Bold", "Docile", "Relaxed", "Impish", "Lax",
  "Timid", "Hasty", "Serious", "Jolly", "Naive",
  "Modest", "Mild", "Quiet", "Bashful", "Rash",
  "Calm", "Gentle", "Sassy", "Careful", "Quirky",
]);

export function fireRedInternalSpeciesToNational(internalSpeciesId) {
  const numeric = Number(internalSpeciesId);
  if (!Number.isSafeInteger(numeric) || numeric < 0) return 0;
  if (numeric < FIRST_UNALIGNED_NATIONAL_SPECIES) return numeric;
  const offsetIndex = numeric - FIRST_UNALIGNED_INTERNAL_SPECIES;
  if (offsetIndex < 0 || offsetIndex >= INTERNAL_TO_NATIONAL_OFFSETS.length) return 0;
  return numeric + INTERNAL_TO_NATIONAL_OFFSETS[offsetIndex];
}

function resolvedName(value, preferredFields = ["name"]) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  for (const field of preferredFields) {
    if (typeof value[field] === "string" && value[field]) return value[field];
  }
  return "";
}

function resolveContextValue(context, resolverName, mapName, numericId, extra) {
  const resolver = context?.[resolverName];
  if (typeof resolver === "function") return resolver(numericId, extra);
  const collection = context?.[mapName];
  if (collection instanceof Map) return collection.get(numericId) || null;
  if (collection && typeof collection === "object") return collection[numericId] || null;
  return null;
}

function resolveContext(context, resolverName, mapName, numericId, extra, preferredFields) {
  return resolvedName(resolveContextValue(context, resolverName, mapName, numericId, extra), preferredFields);
}

function resolveSpeciesIdentity(context, speciesNumericId) {
  if (typeof context?.resolveSpeciesIdentity === "function") return context.resolveSpeciesIdentity(speciesNumericId);
  return resolveContextValue(context, "resolveSpecies", "speciesByNumericId", speciesNumericId, null);
}

function resolveMove(context, moveNumericId) {
  return resolveContext(context, "resolveMove", "movesByNumericId", moveNumericId, null, ["calcName", "name"]);
}

function resolveItem(context, heldItemNumericId) {
  if (!heldItemNumericId) return "";
  return resolveContext(context, "resolveItem", "itemsByNumericId", heldItemNumericId, null, ["calcName", "name"]);
}

function resolveLocation(context, locationNumericId) {
  return resolveContext(context, "resolveLocation", "locationsByNumericId", locationNumericId, null, ["name", "displayName"]);
}

function resolveNature(context, natureNumericId) {
  return resolveContext(context, "resolveNature", "naturesByNumericId", natureNumericId, null, ["name"])
    || NATURE_NAMES[natureNumericId]
    || "";
}

function resolveAbilityIdentity(context, speciesName, speciesNumericId, abilityBit) {
  if (typeof context?.resolveAbilityIdentity === "function") {
    return context.resolveAbilityIdentity({ speciesName, speciesNumericId, abilityBit });
  }
  if (typeof context?.resolveAbility === "function") {
    return context.resolveAbility({ speciesName, speciesNumericId, abilityBit });
  }
  return null;
}

function resolveLevel(context, speciesName, speciesNumericId, experience) {
  if (typeof context?.levelFromExperience !== "function") return null;
  const level = Number(context.levelFromExperience({ speciesName, speciesNumericId, experience }));
  return Number.isSafeInteger(level) && level >= 1 && level <= 100 ? level : null;
}

function decodeNickname(context, record) {
  if (typeof context?.decodeText === "function") return String(context.decodeText(record.subarray(0x08, 0x12)) || "").trim();
  return decodeGen3Text(record.subarray(0x08, 0x12), {
    stopBytes: [0x00, 0xff],
    trim: "both",
  });
}

function statCompatibility(values) {
  return {
    hp: values.hp,
    at: values.atk,
    df: values.def,
    sp: values.spe,
    sa: values.spa,
    sd: values.spd,
  };
}

function parseFroRecord(recordValue, {
  context,
  storage,
  box,
  slot,
  rejectInvalidPokemonChecksums,
}) {
  const record = asBytes(recordValue, { label: "Fire Red Omega Pokémon record" });
  const decoded = decodeGen3PokemonRecord(record);
  if (!decoded.personalityValue || ((readUint8(record, 0x13) >>> 1) & 1) !== 1 || decoded.isEgg) return null;
  if (!decoded.checksumValid && rejectInvalidPokemonChecksums) {
    throw new Error(`Fire Red Omega Pokémon checksum failed at ${storage} ${box ?? ""}:${slot}`);
  }

  const speciesNumericId = fireRedInternalSpeciesToNational(decoded.speciesNumericId);
  const speciesIdentity = resolveSpeciesIdentity(context, speciesNumericId);
  const species = resolvedName(speciesIdentity, ["name", "displayName"]);
  if (!species) throw new Error(`Unresolved Fire Red Omega species identity ${speciesNumericId}`);
  const nickname = decodeNickname(context, record);
  const natureNumericId = decoded.personalityValue % 25;
  const locationNumericId = decoded.blocks.misc[1];
  const moveIds = decoded.moveNumericIds.slice();
  const moves = moveIds.filter(moveNumericId => moveNumericId > 0).map(moveNumericId => {
    const move = resolveMove(context, moveNumericId);
    if (!move) throw new Error(`Unresolved Fire Red Omega move identity ${moveNumericId}`);
    return move;
  });
  const level = storage === "party" && decoded.partyLevel >= 1 && decoded.partyLevel <= 100
    ? decoded.partyLevel
    : resolveLevel(context, species, speciesNumericId, decoded.experienceRaw);
  const abilityIdentity = resolveAbilityIdentity(context, species, speciesNumericId, decoded.abilityBit);

  return {
    pid: decoded.personalityValue,
    otId: decoded.originalTrainerNumericId,
    species,
    speciesId: speciesNumericId,
    speciesInternalId: decoded.speciesNumericId,
    speciesCanonicalId: speciesIdentity && typeof speciesIdentity === "object" ? speciesIdentity.id || null : null,
    nickname,
    displayName: nickname || species,
    level,
    experience: decoded.experienceRaw,
    friendship: decoded.friendship,
    ability: resolvedName(abilityIdentity, ["name"]),
    abilityId: abilityIdentity && typeof abilityIdentity === "object" ? abilityIdentity.id || null : null,
    abilityBit: decoded.abilityBit,
    abilitySlot: decoded.abilityBit,
    itemId: decoded.heldItemNumericId,
    item: resolveItem(context, decoded.heldItemNumericId),
    nature: resolveNature(context, natureNumericId),
    natureId: natureNumericId,
    gender: "",
    location: resolveLocation(context, locationNumericId),
    locationId: locationNumericId,
    ivs: statCompatibility(decoded.ivs),
    evs: statCompatibility(decoded.evs),
    moveIds,
    movePp: decoded.movePp.slice(),
    movePpUps: [decoded.packedPpUps & 3, (decoded.packedPpUps >>> 2) & 3, (decoded.packedPpUps >>> 4) & 3, (decoded.packedPpUps >>> 6) & 3],
    moves,
    checksumValid: decoded.checksumValid,
    storedChecksum: decoded.storedChecksum,
    calculatedChecksum: decoded.calculatedChecksum,
    source: "save_file",
    storage,
    box,
    slot,
  };
}

export function parseFireRedOmegaSave(value, {
  context,
  observedAt,
  sourceName = "",
  rejectInvalidSectionChecksums = false,
  rejectInvalidPokemonChecksums = false,
} = {}) {
  if (!context || typeof context !== "object") throw new Error("Fire Red Omega Dataset context is required");
  const bytes = asBytes(value, { copy: true, label: "Fire Red Omega save" });
  const slot = selectGen3SaveSlot(bytes, { requireSignature: true, counterPolicy: "section0" });
  const sectionChecksums = verifyGen3SectionChecksums(bytes, slot);
  const invalidSectionIds = sectionChecksums.filter(result => !result.valid).map(result => result.sectionId);
  if (rejectInvalidSectionChecksums && invalidSectionIds.length) {
    throw new Error(`Fire Red Omega save has invalid section checksums: ${invalidSectionIds.join(", ")}`);
  }

  const saveBlock1 = reassembleGen3Sections(bytes, slot, FRO_SAVE_BLOCK1_SECTION_IDS);
  const saveBlock2 = reassembleGen3Sections(bytes, slot, FRO_SAVE_BLOCK2_SECTION_IDS);
  const storageBlock = reassembleGen3Sections(bytes, slot, FRO_STORAGE_SECTION_IDS);
  const partyCount = Math.min(readUint8(saveBlock1, FRO_PARTY_COUNT_OFFSET), 6);
  const party = [];
  const rawBoxes = [];

  for (let index = 0; index < partyCount; index += 1) {
    const offset = FRO_PARTY_OFFSET + (index * FRO_PARTY_RECORD_SIZE);
    const mon = parseFroRecord(saveBlock1.subarray(offset, offset + FRO_PARTY_RECORD_SIZE), {
      context,
      storage: "party",
      box: null,
      slot: index + 1,
      rejectInvalidPokemonChecksums,
    });
    if (mon) party.push(mon);
  }

  for (let index = 0; index < FRO_BOX_COUNT * FRO_SLOTS_PER_BOX; index += 1) {
    const offset = 4 + (index * FRO_BOX_RECORD_SIZE);
    const physicalBox = Math.floor(index / FRO_SLOTS_PER_BOX) + 1;
    const physicalSlot = (index % FRO_SLOTS_PER_BOX) + 1;
    const mon = parseFroRecord(storageBlock.subarray(offset, offset + FRO_BOX_RECORD_SIZE), {
      context,
      storage: "box",
      box: physicalBox,
      slot: physicalSlot,
      rejectInvalidPokemonChecksums,
    });
    if (mon) rawBoxes.push(mon);
  }

  return createGbaNeutralSnapshot({
    gameId: "fire-red-omega",
    formatId: "frlg",
    context,
    sourceName,
    sourceBytes: bytes.byteLength,
    observedAt,
    selection: { activeSlot: slot.slotIndex, saveCounter: slot.counter, rawBoxCount: rawBoxes.length },
    playerTrainerIdentity: readGbaPlayerTrainerIdentity(saveBlock2),
    boxCount: FRO_BOX_COUNT,
    party,
    boxes: rawBoxes,
    diagnostics: invalidSectionIds.map(sectionId => ({
      code: "invalid-section-checksum",
      severity: "warning",
      message: `Section ${sectionId}`,
    })),
  });
}
