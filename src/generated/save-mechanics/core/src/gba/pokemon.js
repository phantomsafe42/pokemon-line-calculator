import {
  asBytes,
  assertByteRange,
  readUint16LE,
  readUint32LE,
  writeUint16LE,
  writeUint32LE,
} from "../binary/little-endian.js";

export const GEN3_BOX_RECORD_SIZE = 80;
export const GEN3_PARTY_RECORD_SIZE = 100;

export const GEN3_SUBSTRUCT_ORDER = Object.freeze([
  "GAEM", "GAME", "GEAM", "GEMA", "GMAE", "GMEA",
  "AGEM", "AGME", "AEGM", "AEMG", "AMGE", "AMEG",
  "EGAM", "EGMA", "EAGM", "EAMG", "EMGA", "EMAG",
  "MGAE", "MGEA", "MAGE", "MAEG", "MEGA", "MEAG",
]);

export function calculateGen3PokemonChecksum(value) {
  const payload = asBytes(value, { label: "decrypted Gen 3 Pokémon payload" });
  assertByteRange(payload, 0, 48, "decrypted Gen 3 Pokémon payload");
  let sum = 0;
  for (let offset = 0; offset < 48; offset += 2) {
    sum = (sum + readUint16LE(payload, offset)) & 0xffff;
  }
  return sum;
}

function decryptPayload(record, key) {
  const payload = record.slice(0x20, 0x50);
  for (let offset = 0; offset < 48; offset += 4) {
    writeUint32LE(payload, offset, readUint32LE(payload, offset) ^ key);
  }
  return payload;
}

function blockOffsets(personalityValue) {
  const order = GEN3_SUBSTRUCT_ORDER[personalityValue % 24];
  return {
    order,
    growth: order.indexOf("G") * 12,
    attacks: order.indexOf("A") * 12,
    evs: order.indexOf("E") * 12,
    misc: order.indexOf("M") * 12,
  };
}

function decodeIvs(ivWord) {
  return {
    hp: ivWord & 0x1f,
    atk: (ivWord >>> 5) & 0x1f,
    def: (ivWord >>> 10) & 0x1f,
    spe: (ivWord >>> 15) & 0x1f,
    spa: (ivWord >>> 20) & 0x1f,
    spd: (ivWord >>> 25) & 0x1f,
  };
}

export function decodeGen3PokemonRecord(value) {
  const record = asBytes(value, { label: "Gen 3 Pokémon record" });
  assertByteRange(record, 0, GEN3_BOX_RECORD_SIZE, "Gen 3 Pokémon record");

  const personalityValue = readUint32LE(record, 0);
  const originalTrainerNumericId = readUint32LE(record, 4);
  const key = (personalityValue ^ originalTrainerNumericId) >>> 0;
  const payload = decryptPayload(record, key);
  const offsets = blockOffsets(personalityValue);
  const growth = payload.subarray(offsets.growth, offsets.growth + 12);
  const attacks = payload.subarray(offsets.attacks, offsets.attacks + 12);
  const evsBlock = payload.subarray(offsets.evs, offsets.evs + 12);
  const misc = payload.subarray(offsets.misc, offsets.misc + 12);
  const storedChecksum = readUint16LE(record, 0x1c);
  const calculatedChecksum = calculateGen3PokemonChecksum(payload);
  const ivWord = readUint32LE(misc, 4);
  const ribbonWord = readUint32LE(misc, 8);

  return {
    personalityValue,
    originalTrainerNumericId,
    encryptionKey: key,
    order: offsets.order,
    decryptedPayload: payload,
    blocks: { growth, attacks, evs: evsBlock, misc },
    speciesNumericId: readUint16LE(growth, 0),
    heldItemNumericId: readUint16LE(growth, 2),
    experienceRaw: readUint32LE(growth, 4),
    packedPpUps: growth[8],
    friendship: growth[9],
    moveNumericIds: [0, 2, 4, 6].map(offset => readUint16LE(attacks, offset)),
    movePp: Array.from(attacks.subarray(8, 12)),
    evs: {
      hp: evsBlock[0], atk: evsBlock[1], def: evsBlock[2],
      spe: evsBlock[3], spa: evsBlock[4], spd: evsBlock[5],
    },
    contest: Array.from(evsBlock.subarray(6, 11)),
    sheen: evsBlock[11],
    ivs: decodeIvs(ivWord),
    isEgg: Boolean((ivWord >>> 30) & 1),
    abilityBit: (ivWord >>> 31) & 1,
    ivWord,
    ribbonWord,
    partyLevel: record.byteLength >= GEN3_PARTY_RECORD_SIZE ? record[0x54] : null,
    storedChecksum,
    calculatedChecksum,
    checksumValid: storedChecksum === calculatedChecksum,
  };
}

export function encodeGen3PokemonRecord(originalValue, decryptedPayloadValue, {
  personalityValue = undefined,
  originalTrainerNumericId = undefined,
} = {}) {
  const output = asBytes(originalValue, { copy: true, label: "Gen 3 Pokémon record" });
  assertByteRange(output, 0, GEN3_BOX_RECORD_SIZE, "Gen 3 Pokémon record");
  const payload = asBytes(decryptedPayloadValue, { copy: true, label: "decrypted Gen 3 Pokémon payload" });
  assertByteRange(payload, 0, 48, "decrypted Gen 3 Pokémon payload");

  const pv = personalityValue === undefined ? readUint32LE(output, 0) : Number(personalityValue) >>> 0;
  const otid = originalTrainerNumericId === undefined
    ? readUint32LE(output, 4)
    : Number(originalTrainerNumericId) >>> 0;
  writeUint32LE(output, 0, pv);
  writeUint32LE(output, 4, otid);
  writeUint16LE(output, 0x1c, calculateGen3PokemonChecksum(payload));

  const encrypted = payload.slice(0, 48);
  const key = (pv ^ otid) >>> 0;
  for (let offset = 0; offset < 48; offset += 4) {
    writeUint32LE(encrypted, offset, readUint32LE(encrypted, offset) ^ key);
  }
  output.set(encrypted, 0x20);
  return output;
}
