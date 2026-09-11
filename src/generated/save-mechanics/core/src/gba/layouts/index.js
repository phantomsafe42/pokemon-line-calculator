import { asBytes, readUint32LE } from "../../binary/little-endian.js";
import { reassembleGen3Sections, selectGen3SaveSlot } from "../sectors.js";
import { FRLG_SAVE_LAYOUT } from "./frlg.js";
import { RS_SAVE_LAYOUT, EMERALD_SAVE_LAYOUT } from "./rse.js";

export { FRLG_SAVE_LAYOUT } from "./frlg.js";
export { RS_SAVE_LAYOUT, EMERALD_SAVE_LAYOUT } from "./rse.js";

export const GBA_SAVE_LAYOUTS = Object.freeze({
  frlg: FRLG_SAVE_LAYOUT,
  rs: RS_SAVE_LAYOUT,
  emerald: EMERALD_SAVE_LAYOUT,
});

function recordAt(bytes, offset, size, provenance) {
  if (offset < 0 || offset + size > bytes.byteLength) {
    throw new RangeError(`${provenance.storage} Pokémon record exceeds its logical save block`);
  }
  return { ...provenance, offset, bytes: bytes.slice(offset, offset + size) };
}

export function locateGbaPokemonRecords(value, formatId, {
  requireReadableParty = false,
  counterPolicy = "section0",
} = {}) {
  const bytes = asBytes(value, { label: `${formatId} save` });
  const layout = GBA_SAVE_LAYOUTS[formatId];
  if (!layout) throw new Error(`Unsupported GBA save layout: ${formatId}`);
  if (bytes.byteLength < layout.minimumBytes) {
    throw new RangeError(`${formatId} save requires at least ${layout.minimumBytes} bytes; received ${bytes.byteLength}`);
  }
  const slot = selectGen3SaveSlot(bytes, { counterPolicy });
  const saveBlock1 = reassembleGen3Sections(bytes, slot, layout.saveBlock1SectionIds);
  const saveBlock2 = reassembleGen3Sections(bytes, slot, layout.saveBlock2SectionIds);
  const storage = reassembleGen3Sections(bytes, slot, layout.storageSectionIds);
  const partyCount = readUint32LE(saveBlock1, layout.partyCountOffset);
  if (partyCount > 6 || (requireReadableParty && partyCount === 0)) {
    throw new Error(`${formatId} save has invalid party count ${partyCount}`);
  }

  const party = Array.from({ length: partyCount }, (_, index) => recordAt(
    saveBlock1,
    layout.partyDataOffset + (index * layout.partyRecordSize),
    layout.partyRecordSize,
    { storage: "party", box: null, slot: index + 1 },
  ));
  const boxes = Array.from({ length: layout.boxSlotCount }, (_, index) => recordAt(
    storage,
    layout.storageDataOffset + (index * layout.boxRecordSize),
    layout.boxRecordSize,
    { storage: "box", box: Math.floor(index / 30) + 1, slot: (index % 30) + 1 },
  ));

  return {
    formatId: layout.id,
    platformId: layout.platformId,
    generation: layout.generation,
    selection: {
      slotIndex: slot.slotIndex,
      saveCounter: slot.counter,
    },
    slot,
    saveBlock1,
    saveBlock2,
    storageBlock: storage,
    partyCount,
    party,
    boxes,
  };
}
