import {
  asBytes,
  assertByteRange,
  readUint16LE,
  readUint32LE,
  writeUint16LE,
} from "../binary/little-endian.js";

export const GEN3_SECTOR_SIZE = 0x1000;
export const GEN3_SECTOR_DATA_SIZE = 0x0f80;
export const GEN3_SECTION_COUNT = 14;
export const GEN3_SLOT_SIZE = GEN3_SECTOR_SIZE * GEN3_SECTION_COUNT;
export const GEN3_FOOTER_OFFSET = 0x0ff4;
export const GEN3_SIGNATURE = 0x08012025;

export function calculateGen3SectionChecksum(value, length = undefined) {
  const bytes = asBytes(value);
  const checksumLength = length ?? bytes.byteLength;
  if (!Number.isSafeInteger(checksumLength) || checksumLength < 0 || checksumLength > bytes.byteLength) {
    throw new RangeError(`Invalid Gen 3 checksum length ${checksumLength}`);
  }
  if (checksumLength % 4 !== 0) {
    throw new RangeError("Gen 3 section checksum length must be divisible by 4");
  }

  let total = 0;
  for (let offset = 0; offset < checksumLength; offset += 4) {
    total = (total + readUint32LE(bytes, offset)) >>> 0;
  }
  return ((total >>> 16) + (total & 0xffff)) & 0xffff;
}

export function compareGen3SaveCounters(first, second) {
  const a = Number(first) >>> 0;
  const b = Number(second) >>> 0;
  if (a === 0xffffffff && b !== 0xfffffffe) return -1;
  if (b === 0xffffffff && a !== 0xfffffffe) return 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

export function readGen3SaveSlot(value, slotIndex, {
  requireSignature = true,
  signature = GEN3_SIGNATURE,
  counterPolicy = "section0",
} = {}) {
  const bytes = asBytes(value, { label: "Gen 3 save" });
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0) {
    throw new RangeError("Gen 3 slot index must be a non-negative safe integer");
  }
  if (counterPolicy !== "section0" && counterPolicy !== "max") {
    throw new Error(`Unsupported Gen 3 counter policy: ${counterPolicy}`);
  }

  const slotBase = slotIndex * GEN3_SLOT_SIZE;
  if (slotBase + GEN3_SLOT_SIZE > bytes.byteLength) return null;

  const sectionOffsets = new Array(GEN3_SECTION_COUNT);
  const counters = [];
  for (let physicalIndex = 0; physicalIndex < GEN3_SECTION_COUNT; physicalIndex += 1) {
    const offset = slotBase + (physicalIndex * GEN3_SECTOR_SIZE);
    const sectionId = readUint16LE(bytes, offset + GEN3_FOOTER_OFFSET);
    if (sectionId < 0 || sectionId >= GEN3_SECTION_COUNT || sectionOffsets[sectionId] !== undefined) {
      return { slotIndex, slotBase, valid: false, reason: "invalid-or-duplicate-section-id" };
    }
    if (requireSignature && readUint32LE(bytes, offset + GEN3_FOOTER_OFFSET + 4) !== (signature >>> 0)) {
      return { slotIndex, slotBase, valid: false, reason: "invalid-signature" };
    }
    sectionOffsets[sectionId] = offset;
    counters.push(readUint32LE(bytes, offset + GEN3_FOOTER_OFFSET + 8));
  }

  if (sectionOffsets.some(offset => !Number.isSafeInteger(offset))) {
    return { slotIndex, slotBase, valid: false, reason: "incomplete-section-set" };
  }
  const sectionZeroPhysicalIndex = (sectionOffsets[0] - slotBase) / GEN3_SECTOR_SIZE;
  const counter = counterPolicy === "max"
    ? counters.reduce((maximum, value) => compareGen3SaveCounters(value, maximum) > 0 ? value : maximum, counters[0])
    : counters[sectionZeroPhysicalIndex];

  return { slotIndex, slotBase, sectionOffsets, counter, counters, valid: true };
}

export function selectGen3SaveSlot(value, options = {}) {
  const bytes = asBytes(value, { label: "Gen 3 save" });
  const availableSlots = Math.min(2, Math.floor(bytes.byteLength / GEN3_SLOT_SIZE));
  const candidates = [];
  for (let slotIndex = 0; slotIndex < availableSlots; slotIndex += 1) {
    const candidate = readGen3SaveSlot(bytes, slotIndex, options);
    if (candidate?.valid) candidates.push(candidate);
  }
  if (!candidates.length) throw new Error("No complete valid Gen 3 save slot was found");

  return candidates.slice(1).reduce(
    (active, candidate) => compareGen3SaveCounters(candidate.counter, active.counter) > 0 ? candidate : active,
    candidates[0],
  );
}

export function reassembleGen3Sections(value, slot, sectionIds, {
  dataSize = GEN3_SECTOR_DATA_SIZE,
} = {}) {
  const bytes = asBytes(value, { label: "Gen 3 save" });
  if (!slot?.valid || !Array.isArray(slot.sectionOffsets)) {
    throw new Error("A valid Gen 3 slot is required for section reassembly");
  }
  if (!Array.isArray(sectionIds) || !sectionIds.length) {
    throw new Error("At least one Gen 3 section ID is required");
  }

  const output = new Uint8Array(sectionIds.length * dataSize);
  sectionIds.forEach((sectionId, index) => {
    const offset = slot.sectionOffsets[sectionId];
    if (!Number.isSafeInteger(offset)) throw new Error(`Missing Gen 3 section ${sectionId}`);
    assertByteRange(bytes, offset, dataSize, `Gen 3 section ${sectionId}`);
    output.set(bytes.subarray(offset, offset + dataSize), index * dataSize);
  });
  return output;
}

function sectionChecksumLength(sectionId, lengths, fallback) {
  if (typeof lengths === "function") return lengths(sectionId);
  if (Array.isArray(lengths)) return lengths[sectionId] ?? fallback;
  if (lengths && typeof lengths === "object") return lengths[sectionId] ?? fallback;
  return fallback;
}

export function verifyGen3SectionChecksums(value, slot, {
  checksumLengths = null,
  dataSize = GEN3_SECTOR_DATA_SIZE,
} = {}) {
  const bytes = asBytes(value, { label: "Gen 3 save" });
  if (!slot?.valid) throw new Error("A valid Gen 3 slot is required for checksum verification");

  const results = [];
  for (let sectionId = 0; sectionId < GEN3_SECTION_COUNT; sectionId += 1) {
    const offset = slot.sectionOffsets[sectionId];
    const length = sectionChecksumLength(sectionId, checksumLengths, dataSize);
    assertByteRange(bytes, offset, Math.max(dataSize, GEN3_FOOTER_OFFSET + 4), `Gen 3 section ${sectionId}`);
    const stored = readUint16LE(bytes, offset + GEN3_FOOTER_OFFSET + 2);
    const calculated = calculateGen3SectionChecksum(bytes.subarray(offset, offset + dataSize), length);
    results.push({ sectionId, stored, calculated, valid: stored === calculated });
  }
  return results;
}

export function writeGen3LogicalBytes(value, slot, sectionIds, logicalOffset, payload, {
  checksumLengths = null,
  dataSize = GEN3_SECTOR_DATA_SIZE,
} = {}) {
  const output = asBytes(value, { copy: true, label: "Gen 3 save" });
  const update = asBytes(payload, { label: "Gen 3 logical payload" });
  if (!slot?.valid) throw new Error("A valid Gen 3 slot is required for logical writes");
  if (!Number.isSafeInteger(logicalOffset) || logicalOffset < 0) {
    throw new RangeError("Gen 3 logical offset must be a non-negative safe integer");
  }
  if (logicalOffset + update.byteLength > sectionIds.length * dataSize) {
    throw new RangeError("Gen 3 logical write exceeds the selected section stream");
  }

  const touched = new Set();
  for (let index = 0; index < update.byteLength; index += 1) {
    const logical = logicalOffset + index;
    const sectionStreamIndex = Math.floor(logical / dataSize);
    const sectionId = sectionIds[sectionStreamIndex];
    const physicalOffset = slot.sectionOffsets[sectionId];
    if (!Number.isSafeInteger(physicalOffset)) throw new Error(`Missing Gen 3 section ${sectionId}`);
    output[physicalOffset + (logical % dataSize)] = update[index];
    touched.add(sectionId);
  }

  for (const sectionId of touched) {
    const physicalOffset = slot.sectionOffsets[sectionId];
    const length = sectionChecksumLength(sectionId, checksumLengths, dataSize);
    const checksum = calculateGen3SectionChecksum(output.subarray(physicalOffset, physicalOffset + dataSize), length);
    writeUint16LE(output, physicalOffset + GEN3_FOOTER_OFFSET + 2, checksum);
  }
  return { bytes: output, touchedSectionIds: [...touched].sort((a, b) => a - b) };
}
