import {
  asBytes,
  assertByteRange,
  readUint32LE,
} from "../binary/little-endian.js";

const DS_SAVE_COPY_OFFSET = 0x40000;

export const GEN45_SAVE_LAYOUTS = Object.freeze({
  dppt: Object.freeze({
    id: "dppt",
    generation: 4,
    minimumBytes: 0x80000,
    smallBlockSize: 0x0cf2c,
    largeBlockStart: 0x0cf2c,
    largeBlockEnd: 0x1f110,
    partyCountOffset: 0x9c,
    partyDataOffset: 0xa0,
    partyRecordSize: 236,
    boxDataRelativeOffset: 4,
    boxRecordSize: 136,
    boxSlotCount: 540,
    boxPadding: 0,
  }),
  hgss: Object.freeze({
    id: "hgss",
    generation: 4,
    minimumBytes: 0x80000,
    smallBlockSize: 0x0f628,
    largeBlockStart: 0x0f700,
    largeBlockSize: 0x12310,
    partyCountOffset: 0x94,
    partyDataOffset: 0x98,
    partyRecordSize: 236,
    boxDataRelativeOffset: 0,
    boxRecordSize: 136,
    boxSlotCount: 540,
    boxPadding: 16,
  }),
  bw2: Object.freeze({
    id: "bw2",
    generation: 5,
    minimumBytes: 0x80000,
    partyCountOffset: 0x18e04,
    partyDataOffset: 0x18e08,
    partyRecordSize: 220,
    boxDataRelativeOffset: 0x400,
    boxRecordSize: 136,
    boxSlotCount: 720,
    boxPadding: 16,
  }),
});

function requireSaveSize(bytes, layout) {
  if (bytes.byteLength < layout.minimumBytes) {
    throw new RangeError(`${layout.id} save requires at least ${layout.minimumBytes} bytes; received ${bytes.byteLength}`);
  }
}

function validatePartyCount(count, layoutId, { requireReadableParty = false } = {}) {
  if (!Number.isInteger(count) || count < 0 || count > 6) {
    throw new Error(`${layoutId} save has invalid party count ${count}`);
  }
  if (requireReadableParty && count === 0) {
    throw new Error(`${layoutId} save does not contain a readable party`);
  }
}

function recordAt(bytes, offset, size, provenance) {
  assertByteRange(bytes, offset, size, `${provenance.storage} Pokémon record`);
  return { ...provenance, offset, bytes: bytes.slice(offset, offset + size) };
}

function recordsFromOffsets(bytes, layout, selection, {
  partyBaseOffset,
  boxBaseOffset,
  requireReadableParty,
}) {
  const partyCount = bytes[partyBaseOffset + layout.partyCountOffset];
  validatePartyCount(partyCount, layout.id, { requireReadableParty });

  const party = [];
  for (let index = 0; index < partyCount; index += 1) {
    party.push(recordAt(
      bytes,
      partyBaseOffset + layout.partyDataOffset + (index * layout.partyRecordSize),
      layout.partyRecordSize,
      { storage: "party", box: null, slot: index + 1 },
    ));
  }

  const boxes = [];
  let offset = boxBaseOffset + layout.boxDataRelativeOffset;
  for (let index = 0; index < layout.boxSlotCount; index += 1) {
    if (index > 0 && index % 30 === 0) offset += layout.boxPadding;
    boxes.push(recordAt(
      bytes,
      offset,
      layout.boxRecordSize,
      { storage: "box", box: Math.floor(index / 30) + 1, slot: (index % 30) + 1 },
    ));
    offset += layout.boxRecordSize;
  }

  return {
    formatId: layout.id,
    generation: layout.generation,
    selection,
    partyCount,
    party,
    boxes,
  };
}

function locateDpptRecords(bytes, layout, options) {
  const firstSmallOffset = 0;
  const secondSmallOffset = DS_SAVE_COPY_OFFSET;
  const magic = 0x20060623;
  const firstMagic = readUint32LE(bytes, firstSmallOffset + layout.smallBlockSize - 8);
  const secondMagic = readUint32LE(bytes, secondSmallOffset + layout.smallBlockSize - 8);
  if (firstMagic !== magic && secondMagic !== magic) {
    throw new Error("DPPt save was not initialized");
  }

  const firstCounter = readUint32LE(bytes, firstSmallOffset + layout.smallBlockSize - 16);
  const secondCounter = readUint32LE(bytes, secondSmallOffset + layout.smallBlockSize - 16);
  const smallBlockOffset = firstMagic !== magic || (secondMagic === magic && secondCounter > firstCounter)
    ? secondSmallOffset
    : firstSmallOffset;

  const largeBlockSize = layout.largeBlockEnd - layout.largeBlockStart;
  const firstLargeOffset = layout.largeBlockStart;
  const secondLargeOffset = layout.largeBlockStart + DS_SAVE_COPY_OFFSET;
  const selectedLargeId = readUint32LE(bytes, smallBlockOffset + layout.smallBlockSize - 20);
  const firstLargeId = readUint32LE(bytes, firstLargeOffset + largeBlockSize - 20);
  const largeBlockOffset = selectedLargeId === firstLargeId ? firstLargeOffset : secondLargeOffset;

  return recordsFromOffsets(bytes, layout, {
    smallBlockOffset,
    largeBlockOffset,
    smallBlockCounter: smallBlockOffset === secondSmallOffset ? secondCounter : firstCounter,
    linkedLargeBlockId: selectedLargeId,
  }, {
    partyBaseOffset: smallBlockOffset,
    boxBaseOffset: largeBlockOffset,
    requireReadableParty: options.requireReadableParty,
  });
}

function isEmptyDsCounter(value) {
  return value === 0 || value === 0xffffffff;
}

function choosePairedBlockOffset(preferredCounter, firstCounter, secondCounter) {
  const firstInvalid = isEmptyDsCounter(firstCounter);
  const secondInvalid = isEmptyDsCounter(secondCounter);
  if (!firstInvalid && firstCounter === preferredCounter) return 0;
  if (!secondInvalid && secondCounter === preferredCounter) return DS_SAVE_COPY_OFFSET;
  if (firstInvalid && !secondInvalid) return DS_SAVE_COPY_OFFSET;
  if (!firstInvalid && secondInvalid) return 0;
  if (!firstInvalid && !secondInvalid && secondCounter > firstCounter) return DS_SAVE_COPY_OFFSET;
  return 0;
}

function locateHgssRecords(bytes, layout, options) {
  const firstSmallCounter = readUint32LE(bytes, layout.smallBlockSize - 16);
  const secondSmallCounter = readUint32LE(bytes, DS_SAVE_COPY_OFFSET + layout.smallBlockSize - 16);
  if (isEmptyDsCounter(firstSmallCounter) && isEmptyDsCounter(secondSmallCounter)) {
    throw new Error("HGSS save was not initialized");
  }

  const smallBlockOffset = isEmptyDsCounter(firstSmallCounter)
    || (!isEmptyDsCounter(secondSmallCounter) && secondSmallCounter > firstSmallCounter)
    ? DS_SAVE_COPY_OFFSET
    : 0;
  const selectedCounter = smallBlockOffset === DS_SAVE_COPY_OFFSET ? secondSmallCounter : firstSmallCounter;

  const firstLargeCounter = readUint32LE(bytes, layout.largeBlockStart + layout.largeBlockSize - 16);
  const secondLargeCounter = readUint32LE(bytes, layout.largeBlockStart + DS_SAVE_COPY_OFFSET + layout.largeBlockSize - 16);
  const largeCopyOffset = choosePairedBlockOffset(selectedCounter, firstLargeCounter, secondLargeCounter);

  return recordsFromOffsets(bytes, layout, {
    smallBlockOffset,
    largeBlockOffset: layout.largeBlockStart + largeCopyOffset,
    selectedCounter,
    firstLargeCounter,
    secondLargeCounter,
  }, {
    partyBaseOffset: smallBlockOffset,
    boxBaseOffset: layout.largeBlockStart + largeCopyOffset,
    requireReadableParty: options.requireReadableParty,
  });
}

function locateBw2Records(bytes, layout, options) {
  const candidates = [0, DS_SAVE_COPY_OFFSET].filter(offset => {
    const count = bytes[offset + layout.partyCountOffset];
    return count >= 1 && count <= 6;
  });
  if (!candidates.length && options.requireReadableParty) {
    throw new Error("BW2 save does not contain a readable party in either save copy");
  }
  const blockOffset = candidates[0] ?? 0;
  return recordsFromOffsets(bytes, layout, {
    blockOffset,
    candidateBlockOffsets: candidates,
    selectionMethod: "readable-party-count",
  }, {
    partyBaseOffset: blockOffset,
    boxBaseOffset: blockOffset,
    requireReadableParty: options.requireReadableParty,
  });
}

export function locateGen45PokemonRecords(value, formatId, {
  requireReadableParty = false,
} = {}) {
  const bytes = asBytes(value, { label: `${formatId} save` });
  const layout = GEN45_SAVE_LAYOUTS[formatId];
  if (!layout) throw new Error(`Unsupported Gen 4/5 save layout: ${formatId}`);
  requireSaveSize(bytes, layout);

  if (formatId === "dppt") return locateDpptRecords(bytes, layout, { requireReadableParty });
  if (formatId === "hgss") return locateHgssRecords(bytes, layout, { requireReadableParty });
  return locateBw2Records(bytes, layout, { requireReadableParty });
}
