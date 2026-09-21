// Synthetic inputs only. Record construction follows the Save Mechanics
// owner's encrypted-record regression fixture; this is not a save importer.
import { readUint16LE, writeUint16LE, writeUint32LE } from '../src/generated/save-mechanics/core/src/binary/little-endian.js';
import { calculateGen45PokemonChecksum } from '../src/generated/save-mechanics/core/src/ds/pokemon.js';
import { DS_SAVE_LAYOUTS } from '../src/generated/save-mechanics/core/src/ds/layouts/index.js';
import { NINTENDO_DS_RAW_SAVE_BYTES, DESMUME_DSV_FOOTER_BYTES } from '../src/generated/save-mechanics/core/src/ds/save-container.js';

function encryptedRecord(generation, [species, form = 0]) {
  const record = new Uint8Array(generation === 4 ? 236 : 220);
  writeUint16LE(record, 0x08, species);
  writeUint32LE(record, 0x0c, 0x12345678);
  writeUint32LE(record, 0x10, 1000);
  record[0x14] = 120; record[0x15] = 17;
  record.set([1,2,3,4,5,6], 0x18);
  [1,2,3,4].forEach((move, index) => writeUint16LE(record, 0x28 + index * 2, move));
  record.set([5,6,7,8], 0x30);
  writeUint32LE(record, 0x38, (31 | 30 << 5 | 29 << 10 | 28 << 15 | 27 << 20 | 26 << 25) >>> 0);
  record[0x40] = form << 3;
  const checksum = calculateGen45PokemonChecksum(record);
  writeUint16LE(record, 6, checksum);
  const next = seed => (seed * 0x41c64e6dn + 0x6073n) & 0xffffffffn;
  let seed = BigInt(checksum);
  for (let offset = 8; offset < 136; offset += 2) {
    seed = next(seed);
    writeUint16LE(record, offset, readUint16LE(record, offset) ^ Number(seed >> 16n));
  }
  if (generation === 5) {
    seed = 0n;
    for (let offset = 136; offset < 142; offset += 2) {
      seed = next(seed);
      writeUint16LE(record, offset, (offset === 140 ? 42 : 0) ^ Number(seed >> 16n));
    }
  }
  return record;
}

export function syntheticDsSave(format, party, { dsv = false, boxed = [] } = {}) {
  const layout = DS_SAVE_LAYOUTS[format];
  const raw = new Uint8Array(NINTENDO_DS_RAW_SAVE_BYTES);
  if (layout.generation === 4) writeUint32LE(raw, layout.generalBlockSize - 8, 0x20060623);
  raw[layout.partyCountOffset] = party.length;
  party.forEach((identity, index) => raw.set(encryptedRecord(layout.generation, identity), layout.partyDataOffset + index * layout.partyRecordSize));
  boxed.forEach(({ identity, box = 1, slot = 1 }) => {
    const index = (box - 1) * 30 + slot - 1;
    const offset = (layout.generation === 4 ? layout.storageBlockStart : 0) + layout.boxDataRelativeOffset
      + index * layout.boxRecordSize + (box - 1) * layout.boxPadding;
    raw.set(encryptedRecord(layout.generation, identity).slice(0, layout.boxRecordSize), offset);
  });
  if (!dsv) return raw;
  const container = new Uint8Array(raw.length + DESMUME_DSV_FOOTER_BYTES);
  container.set(raw);
  const encode = text => Uint8Array.from(text, character => character.charCodeAt(0));
  container.set(encode('|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:'), raw.length);
  const suffix = encode('|-DESMUME SAVE-|');
  container.set(suffix, container.length - suffix.length);
  return container;
}
