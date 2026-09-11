import {
  asBytes,
  assertByteRange,
  readUint16LE,
  readUint32LE,
  writeUint16LE,
} from "../binary/little-endian.js";

const LCG_MULTIPLIER = 0x41c64e6dn;
const LCG_INCREMENT = 0x6073n;
const UINT32_MASK = 0xffffffffn;

export const GEN45_BOX_RECORD_SIZE = 136;

export const GEN45_SUBSTRUCT_OFFSETS = Object.freeze([
  [0x08, 0x28, 0x48, 0x68], [0x08, 0x28, 0x68, 0x48], [0x08, 0x48, 0x28, 0x68],
  [0x08, 0x68, 0x28, 0x48], [0x08, 0x48, 0x68, 0x28], [0x08, 0x68, 0x48, 0x28],
  [0x28, 0x08, 0x48, 0x68], [0x28, 0x08, 0x68, 0x48], [0x48, 0x08, 0x28, 0x68],
  [0x68, 0x08, 0x28, 0x48], [0x48, 0x08, 0x68, 0x28], [0x68, 0x08, 0x48, 0x28],
  [0x28, 0x48, 0x08, 0x68], [0x28, 0x68, 0x08, 0x48], [0x48, 0x28, 0x08, 0x68],
  [0x68, 0x28, 0x08, 0x48], [0x48, 0x68, 0x08, 0x28], [0x68, 0x48, 0x08, 0x28],
  [0x28, 0x48, 0x68, 0x08], [0x28, 0x68, 0x48, 0x08], [0x48, 0x28, 0x68, 0x08],
  [0x68, 0x28, 0x48, 0x08], [0x48, 0x68, 0x28, 0x08], [0x68, 0x48, 0x28, 0x08],
].map(order => Object.freeze(order)));

export const DS_NICKNAME_CHARACTERS = Object.freeze({
  0x0121:"0", 0x0122:"1", 0x0123:"2", 0x0124:"3", 0x0125:"4", 0x0126:"5", 0x0127:"6", 0x0128:"7", 0x0129:"8", 0x012a:"9",
  0x012b:"A", 0x012c:"B", 0x012d:"C", 0x012e:"D", 0x012f:"E", 0x0130:"F", 0x0131:"G", 0x0132:"H", 0x0133:"I", 0x0134:"J",
  0x0135:"K", 0x0136:"L", 0x0137:"M", 0x0138:"N", 0x0139:"O", 0x013a:"P", 0x013b:"Q", 0x013c:"R", 0x013d:"S", 0x013e:"T",
  0x013f:"U", 0x0140:"V", 0x0141:"W", 0x0142:"X", 0x0143:"Y", 0x0144:"Z",
  0x0145:"a", 0x0146:"b", 0x0147:"c", 0x0148:"d", 0x0149:"e", 0x014a:"f", 0x014b:"g", 0x014c:"h", 0x014d:"i", 0x014e:"j",
  0x014f:"k", 0x0150:"l", 0x0151:"m", 0x0152:"n", 0x0153:"o", 0x0154:"p", 0x0155:"q", 0x0156:"r", 0x0157:"s", 0x0158:"t",
  0x0159:"u", 0x015a:"v", 0x015b:"w", 0x015c:"x", 0x015d:"y", 0x015e:"z",
  0x01ab:"!", 0x01ac:"?", 0x01ad:",", 0x01ae:".", 0x01af:"…", 0x01b1:"/", 0x01b2:"‘", 0x01b3:"'", 0x01b4:"“", 0x01b5:"”",
  0x01b9:"(", 0x01ba:")", 0x01bb:"♂", 0x01bc:"♀", 0x01bd:"+", 0x01be:"-", 0x01bf:"*", 0x01c0:"#", 0x01c1:":", 0x01c2:"&", 0x01c5:";", 0x01de:" ",
});

function nextLcg(seed) {
  return ((seed * LCG_MULTIPLIER) + LCG_INCREMENT) & UINT32_MASK;
}

export function calculateGen45PokemonChecksum(decryptedRecord) {
  const bytes = asBytes(decryptedRecord);
  assertByteRange(bytes, 8, 128, "Gen 4/5 decrypted Pokémon payload");
  let sum = 0;
  for (let offset = 8; offset < GEN45_BOX_RECORD_SIZE; offset += 2) {
    sum = (sum + readUint16LE(bytes, offset)) & 0xffff;
  }
  return sum;
}

export function decryptGen45PokemonRecord(value) {
  const bytes = asBytes(value, { copy: true, label: "Gen 4/5 Pokémon record" });
  assertByteRange(bytes, 0, GEN45_BOX_RECORD_SIZE, "Gen 4/5 Pokémon record");

  const storedChecksum = readUint16LE(bytes, 0x06);
  let seed = BigInt(storedChecksum);
  for (let offset = 8; offset < GEN45_BOX_RECORD_SIZE; offset += 2) {
    seed = nextLcg(seed);
    const key = Number((seed >> 16n) & 0xffffn);
    writeUint16LE(bytes, offset, readUint16LE(bytes, offset) ^ key);
  }

  const personalityValue = readUint32LE(bytes, 0);
  const shuffleIndex = ((personalityValue & 0x3e000) >>> 13) % 24;
  const order = GEN45_SUBSTRUCT_OFFSETS[shuffleIndex];
  const calculatedChecksum = calculateGen45PokemonChecksum(bytes);

  return {
    bytes,
    personalityValue,
    storedChecksum,
    calculatedChecksum,
    checksumValid: storedChecksum === calculatedChecksum,
    shuffleIndex,
    blocks: {
      growth: bytes.subarray(order[0], order[0] + 32),
      attacks: bytes.subarray(order[1], order[1] + 32),
      identity: bytes.subarray(order[2], order[2] + 32),
      misc: bytes.subarray(order[3], order[3] + 32),
    },
  };
}

export function decodeDsString(value, {
  maxBytes = 0x16,
  preserveUnknownCodePoints = false,
  characters = DS_NICKNAME_CHARACTERS,
} = {}) {
  const bytes = asBytes(value);
  const end = Math.min(bytes.byteLength, maxBytes);
  let result = "";
  for (let offset = 0; offset + 1 < end; offset += 2) {
    const word = readUint16LE(bytes, offset);
    if (word === 0xffff) break;
    result += characters[word] || (preserveUnknownCodePoints ? String.fromCharCode(word) : "");
  }
  return result.trim();
}

export function decodeGen5PartyLevel(value, personalityValue) {
  const bytes = asBytes(value);
  if (bytes.byteLength < 142) return null;

  let seed = BigInt(personalityValue >>> 0);
  let word = 0;
  for (let offset = 136; offset < 142; offset += 2) {
    seed = nextLcg(seed);
    word = readUint16LE(bytes, offset) ^ Number((seed >> 16n) & 0xffffn);
  }
  const level = word & 0xff;
  return level >= 1 && level <= 100 ? level : null;
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

export function decodeGen45Pokemon(value, {
  generation,
  storage = "box",
  preserveUnknownNicknameCodePoints = generation === 5,
} = {}) {
  if (generation !== 4 && generation !== 5) {
    throw new RangeError("Gen 4/5 Pokémon decoding requires generation 4 or 5");
  }

  const encryptedBytes = asBytes(value, { label: "Gen 4/5 Pokémon record" });
  const decoded = decryptGen45PokemonRecord(encryptedBytes);
  const { growth, attacks, identity, misc } = decoded.blocks;
  const speciesNumericId = readUint16LE(growth, 0);
  if (speciesNumericId === 0) return null;

  const genderForm = attacks[0x18];
  const ivWord = readUint32LE(attacks, 0x10);
  const hasNickname = Boolean((ivWord >>> 31) & 1);
  const isEgg = Boolean((ivWord >>> 30) & 1);
  const natureNumericId = generation === 5
    ? readUint16LE(attacks, 0x18) >>> 8
    : decoded.personalityValue % 25;
  const metLocationNumericId = isEgg
    ? null
    : readUint16LE(generation === 5 ? misc : attacks, generation === 5 ? 0x18 : 0x1e);

  return {
    personalityValue: decoded.personalityValue,
    originalTrainerNumericId: readUint32LE(growth, 0x04),
    speciesNumericId,
    heldItemNumericId: readUint16LE(growth, 0x02),
    experience: readUint32LE(growth, 0x08),
    friendship: growth[0x0c],
    abilityNumericId: growth[0x0d],
    formIndex: genderForm >>> 3,
    genderCode: (genderForm >>> 1) & 1 ? "F" : (genderForm >>> 2) & 1 ? "N" : "M",
    natureNumericId,
    nickname: hasNickname ? decodeDsString(identity, {
      preserveUnknownCodePoints: preserveUnknownNicknameCodePoints,
    }) : "",
    hasNickname,
    isEgg,
    metLocationNumericId,
    moveNumericIds: [0, 2, 4, 6].map(offset => readUint16LE(attacks, offset)),
    movePp: Array.from(attacks.subarray(8, 12)),
    evs: {
      hp: growth[0x10], atk: growth[0x11], def: growth[0x12],
      spe: growth[0x13], spa: growth[0x14], spd: growth[0x15],
    },
    ivs: decodeIvs(ivWord),
    partyLevel: generation === 5 && storage === "party"
      ? decodeGen5PartyLevel(encryptedBytes, decoded.personalityValue)
      : null,
    storedChecksum: decoded.storedChecksum,
    calculatedChecksum: decoded.calculatedChecksum,
    checksumValid: decoded.checksumValid,
  };
}
