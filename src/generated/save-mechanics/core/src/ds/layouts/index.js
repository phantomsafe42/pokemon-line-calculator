import {
  asBytes,
  assertByteRange,
  readUint32LE,
} from "../../binary/little-endian.js";
import { DP_SAVE_LAYOUT } from "./dp.js";
import { PLATINUM_SAVE_LAYOUT } from "./platinum.js";
import { DPPT_SAVE_LAYOUT } from "./dppt.js";
import { HGSS_SAVE_LAYOUT } from "./hgss.js";
import { BW_SAVE_LAYOUT } from "./bw.js";
import { BW2_SAVE_LAYOUT } from "./bw2.js";

export { DP_SAVE_LAYOUT } from "./dp.js";
export { PLATINUM_SAVE_LAYOUT } from "./platinum.js";
export { DPPT_SAVE_LAYOUT } from "./dppt.js";
export { HGSS_SAVE_LAYOUT } from "./hgss.js";
export { BW_SAVE_LAYOUT } from "./bw.js";
export { BW2_SAVE_LAYOUT } from "./bw2.js";

const DS_SAVE_COPY_OFFSET = 0x40000;

export const DS_SAVE_LAYOUTS = Object.freeze({
  dp: DP_SAVE_LAYOUT,
  platinum: PLATINUM_SAVE_LAYOUT,
  dppt: DPPT_SAVE_LAYOUT,
  hgss: HGSS_SAVE_LAYOUT,
  bw: BW_SAVE_LAYOUT,
  bw2: BW2_SAVE_LAYOUT,
});

export const GEN45_SAVE_LAYOUTS = DS_SAVE_LAYOUTS;

function requireSaveSize(bytes, layout) {
  const minimumBytes = layout.minimumBytes || 0x80000;
  if (bytes.byteLength < minimumBytes) {
    throw new RangeError(`${layout.id} save requires at least ${minimumBytes} bytes; received ${bytes.byteLength}`);
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

function compareGen4FooterCopies(bytes, blockStart, blockSize) {
  const footer = blockStart + blockSize - 0x14;
  const firstMajor = readUint32LE(bytes, footer);
  const secondMajor = readUint32LE(bytes, footer + DS_SAVE_COPY_OFFSET);
  if (firstMajor !== secondMajor) {
    if (firstMajor === 0xffffffff && secondMajor !== 0xfffffffe) return DS_SAVE_COPY_OFFSET;
    if (secondMajor === 0xffffffff && firstMajor !== 0xfffffffe) return 0;
    return secondMajor > firstMajor ? DS_SAVE_COPY_OFFSET : 0;
  }
  const firstMinor = readUint32LE(bytes, footer + 4);
  const secondMinor = readUint32LE(bytes, footer + DS_SAVE_COPY_OFFSET + 4);
  if (firstMinor === 0xffffffff && secondMinor !== 0xfffffffe) return DS_SAVE_COPY_OFFSET;
  if (secondMinor === 0xffffffff && firstMinor !== 0xfffffffe) return 0;
  return secondMinor > firstMinor ? DS_SAVE_COPY_OFFSET : 0;
}

function locateGen4Records(bytes, layout, options) {
  const magic = 0x20060623;
  const firstGeneralMagic = readUint32LE(bytes, layout.generalBlockSize - 8);
  const secondGeneralMagic = readUint32LE(bytes, DS_SAVE_COPY_OFFSET + layout.generalBlockSize - 8);
  if (firstGeneralMagic !== magic && secondGeneralMagic !== magic) {
    throw new Error(`${layout.id} save was not initialized`);
  }

  const generalCopyOffset = firstGeneralMagic !== magic
    ? DS_SAVE_COPY_OFFSET
    : secondGeneralMagic !== magic
      ? 0
      : compareGen4FooterCopies(bytes, 0, layout.generalBlockSize);
  const storageCopyOffset = compareGen4FooterCopies(bytes, layout.storageBlockStart, layout.storageBlockSize);
  const smallBlockOffset = generalCopyOffset;
  const largeBlockOffset = layout.storageBlockStart + storageCopyOffset;

  return recordsFromOffsets(bytes, layout, {
    smallBlockOffset,
    largeBlockOffset,
    generalCopyOffset,
    storageCopyOffset,
    selectionMethod: "gen4-footer-counters",
  }, {
    partyBaseOffset: smallBlockOffset,
    boxBaseOffset: largeBlockOffset,
    requireReadableParty: options.requireReadableParty,
  });
}

function locateGen5Records(bytes, layout, options) {
  const candidates = [0, DS_SAVE_COPY_OFFSET].filter(offset => {
    const count = bytes[offset + layout.partyCountOffset];
    return count >= 1 && count <= 6;
  });
  if (!candidates.length && options.requireReadableParty) {
    throw new Error(`${layout.id} save does not contain a readable party in either candidate block`);
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

export function locateDsPokemonRecords(value, formatId, {
  requireReadableParty = false,
} = {}) {
  const bytes = asBytes(value, { label: `${formatId} save` });
  const layout = DS_SAVE_LAYOUTS[formatId];
  if (!layout) throw new Error(`Unsupported Gen 4/5 save layout: ${formatId}`);
  requireSaveSize(bytes, layout);

  if (layout.generation === 4) return locateGen4Records(bytes, layout, { requireReadableParty });
  return locateGen5Records(bytes, layout, { requireReadableParty });
}

export const locateGen45PokemonRecords = locateDsPokemonRecords;
