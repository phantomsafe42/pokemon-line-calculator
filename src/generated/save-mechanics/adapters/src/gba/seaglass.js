import { asBytes, readUint16LE, readUint32LE } from "../../../core/src/binary/little-endian.js";
import { decodeGen3PokemonRecord, encodeGen3PokemonRecord } from "../../../core/src/gba/pokemon.js";
import { reassembleGen3Sections, selectGen3SaveSlot, verifyGen3SectionChecksums, writeGen3LogicalBytes } from "../../../core/src/gba/sectors.js";
import { decodeGen3Text } from "../../../core/src/gba/text.js";

export const SEAGLASS_MINIMUM_SAVE_SIZE = 0x20000;
export const SEAGLASS_SAVE_BLOCK1_SECTION_IDS = Object.freeze([1, 2, 3, 4]);
export const SEAGLASS_STORAGE_SECTION_IDS = Object.freeze([5, 6, 7, 8, 9, 10, 11, 12, 13]);
export const SEAGLASS_PARTY_COUNT_OFFSET = 0x234;
export const SEAGLASS_PARTY_OFFSET = 0x238;
export const SEAGLASS_PARTY_RECORD_SIZE = 100;
export const SEAGLASS_BOX_RECORD_SIZE = 80;
export const SEAGLASS_BOX_COUNT = 14;
export const SEAGLASS_BOX_SLOTS = 30;
export const SEAGLASS_STORAGE_RECORDS_OFFSET = 4;
export const SEAGLASS_EXPERIENCE_MASK = 0x001fffff;
export const SEAGLASS_ABILITY_SLOT_SHIFT = 29;
export const SEAGLASS_ABILITY_SLOT_MASK = 0x60000000;

function requireSaveLength(bytes) {
  if (bytes.byteLength < SEAGLASS_MINIMUM_SAVE_SIZE) {
    throw new Error(`Seaglass save is too small: 0x${bytes.byteLength.toString(16)}`);
  }
}

function normalizeOpenedSave(value) {
  if (value?.bytes instanceof Uint8Array && value?.slot?.valid) return value;
  return openSeaglassSave(value);
}

export function openSeaglassSave(value, {
  rejectInvalidSectionChecksums = false,
} = {}) {
  const bytes = asBytes(value, { copy: true, label: "Seaglass save" });
  requireSaveLength(bytes);
  const slot = selectGen3SaveSlot(bytes, {
    requireSignature: true,
    counterPolicy: "max",
  });
  const sectionChecksums = verifyGen3SectionChecksums(bytes, slot);
  const invalidSectionIds = sectionChecksums.filter(result => !result.valid).map(result => result.sectionId);
  if (rejectInvalidSectionChecksums && invalidSectionIds.length) {
    throw new Error(`Seaglass save has invalid section checksums: ${invalidSectionIds.join(", ")}`);
  }
  return {
    bytes,
    slot,
    activeSlot: slot.slotIndex,
    saveCounter: slot.counter,
    sectionChecksums,
    invalidSectionIds,
  };
}

export function reassembleSeaglassBlock(value, block) {
  const opened = normalizeOpenedSave(value);
  if (block === "save-block-1") {
    return reassembleGen3Sections(opened.bytes, opened.slot, SEAGLASS_SAVE_BLOCK1_SECTION_IDS);
  }
  if (block === "storage") {
    return reassembleGen3Sections(opened.bytes, opened.slot, SEAGLASS_STORAGE_SECTION_IDS);
  }
  throw new Error(`Unsupported Seaglass logical block: ${block}`);
}

export function verifySeaglassSectionChecksums(value) {
  const opened = normalizeOpenedSave(value);
  return verifyGen3SectionChecksums(opened.bytes, opened.slot);
}

export function writeSeaglassLogicalBytes(value, block, logicalOffset, payload) {
  const opened = normalizeOpenedSave(value);
  const sectionIds = block === "save-block-1"
    ? SEAGLASS_SAVE_BLOCK1_SECTION_IDS
    : block === "storage"
      ? SEAGLASS_STORAGE_SECTION_IDS
      : null;
  if (!sectionIds) throw new Error(`Unsupported Seaglass logical block: ${block}`);
  const written = writeGen3LogicalBytes(opened.bytes, opened.slot, sectionIds, logicalOffset, payload);
  return {
    ...openSeaglassSave(written.bytes),
    touchedSectionIds: written.touchedSectionIds,
  };
}

export function decodeSeaglassPokemonRecord(value, {
  location = null,
} = {}) {
  const record = asBytes(value, { label: "Seaglass Pokémon record" });
  const decoded = decodeGen3PokemonRecord(record);
  const growth = decoded.blocks.growth;
  const attacks = decoded.blocks.attacks;
  const evs = decoded.blocks.evs;
  const ribbonWord = decoded.ribbonWord >>> 0;
  const storedAbilitySlot = (ribbonWord >>> SEAGLASS_ABILITY_SLOT_SHIFT) & 0x03;
  const experienceWord = readUint32LE(growth, 4);
  const moveNumericIds = [0, 2, 4, 6].map(offset => readUint16LE(attacks, offset) & 0x07ff);

  return {
    ...decoded,
    location,
    speciesNumericId: readUint16LE(growth, 0),
    nickname: decodeGen3Text(record.subarray(0x08, 0x12)),
    originalTrainerName: decodeGen3Text(record.subarray(0x14, 0x1b)),
    experience: experienceWord & SEAGLASS_EXPERIENCE_MASK,
    experienceUpperBits: (experienceWord & (~SEAGLASS_EXPERIENCE_MASK >>> 0)) >>> 0,
    abilitySlot: storedAbilitySlot <= 2 ? storedAbilitySlot : 0,
    storedAbilitySlot,
    ballNumericId: readUint16LE(growth, 10) & 0x3f,
    moveNumericIds,
    movePp: Array.from(attacks.subarray(8, 12), value => value & 0x7f),
    movePpHighBits: Array.from(attacks.subarray(8, 12), value => value & 0x80),
    ppUps: [0, 2, 4, 6].map(shift => (decoded.packedPpUps >>> shift) & 0x03),
    contest: Array.from(evs.subarray(6, 11)),
    sheen: evs[11],
    valid: decoded.checksumValid && decoded.speciesNumericId >= 1 && decoded.speciesNumericId <= 1300,
  };
}

export function encodeSeaglassPokemonRecord(originalValue, decryptedPayloadValue, options = {}) {
  return encodeGen3PokemonRecord(originalValue, decryptedPayloadValue, options);
}

export function readSeaglassPokemon(value, {
  includeInvalid = false,
} = {}) {
  const opened = normalizeOpenedSave(value);
  const saveBlock1 = reassembleSeaglassBlock(opened, "save-block-1");
  const storage = reassembleSeaglassBlock(opened, "storage");
  const partyCount = Math.min(readUint32LE(saveBlock1, SEAGLASS_PARTY_COUNT_OFFSET), 6);
  const party = [];
  const boxes = [];

  for (let index = 0; index < partyCount; index += 1) {
    const offset = SEAGLASS_PARTY_OFFSET + (index * SEAGLASS_PARTY_RECORD_SIZE);
    const record = decodeSeaglassPokemonRecord(
      saveBlock1.subarray(offset, offset + SEAGLASS_PARTY_RECORD_SIZE),
      { location: { kind: "party", index } },
    );
    if (record.valid || includeInvalid) party.push(record);
  }

  for (let index = 0; index < SEAGLASS_BOX_COUNT * SEAGLASS_BOX_SLOTS; index += 1) {
    const offset = SEAGLASS_STORAGE_RECORDS_OFFSET + (index * SEAGLASS_BOX_RECORD_SIZE);
    const record = decodeSeaglassPokemonRecord(
      storage.subarray(offset, offset + SEAGLASS_BOX_RECORD_SIZE),
      { location: { kind: "box", index } },
    );
    if (record.valid || includeInvalid) boxes.push(record);
  }

  return { opened, partyCount, party, boxes };
}

export function writeSeaglassPokemonRecord(value, location, encodedRecord) {
  if (!location || (location.kind !== "party" && location.kind !== "box")) {
    throw new Error("A Seaglass party or box location is required");
  }
  const record = asBytes(encodedRecord, { label: "encoded Seaglass Pokémon record" });
  if (!Number.isSafeInteger(location.index) || location.index < 0) {
    throw new RangeError("Seaglass Pokémon location index must be a non-negative safe integer");
  }
  if (location.kind === "party") {
    if (location.index >= 6 || record.byteLength < SEAGLASS_PARTY_RECORD_SIZE) {
      throw new RangeError("Invalid Seaglass party record location or size");
    }
    return writeSeaglassLogicalBytes(
      value,
      "save-block-1",
      SEAGLASS_PARTY_OFFSET + (location.index * SEAGLASS_PARTY_RECORD_SIZE),
      record.subarray(0, SEAGLASS_PARTY_RECORD_SIZE),
    );
  }
  if (location.index >= SEAGLASS_BOX_COUNT * SEAGLASS_BOX_SLOTS || record.byteLength < SEAGLASS_BOX_RECORD_SIZE) {
    throw new RangeError("Invalid Seaglass box record location or size");
  }
  return writeSeaglassLogicalBytes(
    value,
    "storage",
    SEAGLASS_STORAGE_RECORDS_OFFSET + (location.index * SEAGLASS_BOX_RECORD_SIZE),
    record.subarray(0, SEAGLASS_BOX_RECORD_SIZE),
  );
}
