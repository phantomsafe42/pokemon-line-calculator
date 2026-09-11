import { asBytes, readUint16LE, readUint32LE, readUint8 } from "../../../core/src/binary/little-endian.js";
import { compareGen3SaveCounters } from "../../../core/src/gba/sectors.js";
import { decodeGen3Text } from "../../../core/src/gba/text.js";
import { createPlayerTrainerIdentity } from "../../../core/src/contracts/player-trainer-identity.js";
import { createGbaNeutralSnapshot } from "./shared/neutral-projection.js";

export const UNBOUND_CORE_SAVE_SIZE = 0x20000;
export const UNBOUND_MINIMUM_SAVE_SIZE = 0x1c000;
export const UNBOUND_SECTION_SIZE = 0x1000;
export const UNBOUND_SECTION_ID_OFFSET = 0x0ff4;
export const UNBOUND_SECTION_SAVE_INDEX_OFFSET = 0x0ffc;
export const UNBOUND_PARTY_RECORD_SIZE = 100;
export const UNBOUND_PC_RECORD_SIZE = 58;
export const UNBOUND_BOX_COUNT = 25;

const TRAINER_SECTION_ID = 1;
const PARTY_COUNT_OFFSET = 0x34;
const PARTY_START_OFFSET = 0x38;
const PC_STREAM_SECTION_IDS = Object.freeze([5, 6, 7, 8, 9, 10, 11, 12]);
const PC_RELEVANT_SECTION_IDS = new Set([0, ...PC_STREAM_SECTION_IDS, 13]);
const PC_SECTION_HEADER_SIZE = 4;
const PC_SECTION_PAYLOAD_SIZE = 0x0ff0;
const PC_BOX_SIZE = 30;
const FINAL_BOX_OFFSET = 0x0b0;

const FALLBACK_BOX_LAYOUTS = Object.freeze({
  20: [["absolute", 1, 21, 0x1eb0c]],
  21: [["absolute", 1, 30, 0x1f1e8]],
  22: [["absolute", 1, 30, 0x1f8b4]],
  23: [
    ["section", 2, 1, 4, 0x0f18],
    ["section", 3, 5, 30, 0x0010],
  ],
  24: [["section", 3, 1, 30, 0x05f4]],
});

const NATURE_FALLBACKS = Object.freeze([
  "Hardy", "Lonely", "Brave", "Adamant", "Naughty",
  "Bold", "Docile", "Relaxed", "Impish", "Lax",
  "Timid", "Hasty", "Serious", "Jolly", "Naive",
  "Modest", "Mild", "Quiet", "Bashful", "Rash",
  "Calm", "Gentle", "Sassy", "Careful", "Quirky",
]);

const BADGE_FLAG_FIRST = 0x820;
const BADGE_FLAG_LAST = 0x827;
const CHAMPION_FLAG = 0x82c;
const SAVE_BLOCK1_FLAGS_OFFSET = 0x0ee0;
const SAVE_BLOCK1_SECTION_IDS = Object.freeze([1, 2, 3, 4]);
const SAVE_BLOCK1_CHUNK_SIZES = Object.freeze([0x0ff0, 0x0ff0, 0x0ff0, 0x0d98]);

const PARTY_CHARACTER_MAP = {
  0x00: " ", 0xab: "!", 0xac: "?", 0xad: ".", 0xae: "-",
  0xb0: "0", 0xb1: "1", 0xb2: "2", 0xb3: "3", 0xb4: "4",
  0xb5: "5", 0xb6: "6", 0xb7: "7", 0xb8: "8", 0xb9: "9",
};

const PC_CHARACTER_MAP = {
  0x00: " ", 0x01: "A", 0x02: "A", 0x03: "A", 0x04: "C", 0x05: "E",
  0x06: "E", 0x07: "E", 0x08: "E", 0x09: "I", 0x0b: "I", 0x0c: "I",
  0x0d: "O", 0x0e: "O", 0x0f: "O", 0x10: "OE", 0x11: "U", 0x12: "U",
  0x13: "U", 0x14: "N", 0x15: "B", 0x16: "a", 0x17: "a", 0x19: "c",
  0x1a: "e", 0x1b: "e", 0x1c: "e", 0x1d: "e", 0x1e: "i", 0x20: "i",
  0x21: "i", 0x22: "o", 0x23: "o", 0x24: "o", 0x25: "oe", 0x26: "u",
  0x27: "u", 0x28: "u", 0x29: "n", 0x2a: "o", 0x2b: "a", 0x2d: "&",
  0x2e: "+", 0x34: "Lv", 0x35: "=", 0x36: ";", 0x51: "?", 0x52: "!",
  0x53: "PK", 0x54: "MN", 0x55: "PO", 0x56: "Ke", 0x57: "Bl", 0x58: "oc",
  0x59: "k", 0x5a: "I", 0x5b: "%", 0x5c: "(", 0x5d: ")", 0x68: "a",
  0x6f: "i", 0x79: "^", 0x7a: "v", 0x7b: "<", 0x7c: ">", 0x85: "<",
  0x86: ">", 0xab: "!", 0xac: "?", 0xad: ".", 0xae: "-", 0xaf: ".",
  0xb0: "...", 0xb1: "\"", 0xb2: "\"", 0xb3: "'", 0xb4: "'", 0xb5: "M",
  0xb6: "F", 0xb7: "$", 0xb8: ",", 0xb9: "x", 0xba: "/", 0xef: ">",
  0xf0: ":", 0xf1: "A", 0xf2: "O", 0xf3: "U", 0xf4: "a", 0xf5: "o",
  0xf6: "u",
};

for (let index = 0; index < 26; index += 1) {
  const upper = String.fromCharCode(65 + index);
  const lower = String.fromCharCode(97 + index);
  PARTY_CHARACTER_MAP[0xbb + index] = upper;
  PARTY_CHARACTER_MAP[0xd5 + index] = lower;
  PC_CHARACTER_MAP[0xbb + index] = upper;
  PC_CHARACTER_MAP[0xd5 + index] = lower;
}
for (let index = 0; index < 10; index += 1) PC_CHARACTER_MAP[0xa1 + index] = String(index);

function requiredContext(context) {
  if (!context || !(context.speciesByNum instanceof Map) || !(context.movesByNum instanceof Map)) {
    throw new Error("Pokémon Unbound Dataset context is required");
  }
  return context;
}

function coreSaveBytes(value) {
  const source = asBytes(value, { label: "Pokémon Unbound save" });
  if (source.byteLength < UNBOUND_MINIMUM_SAVE_SIZE) {
    throw new Error(`Pokémon Unbound save is too small: 0x${source.byteLength.toString(16)}`);
  }
  return { source, bytes: source.slice(0, Math.min(source.byteLength, UNBOUND_CORE_SAVE_SIZE)) };
}

export function listUnboundSections(value) {
  const bytes = asBytes(value, { label: "Pokémon Unbound core save" });
  const sections = [];
  for (let offset = 0; offset + UNBOUND_SECTION_SIZE <= bytes.byteLength; offset += UNBOUND_SECTION_SIZE) {
    sections.push({
      physicalIndex: offset / UNBOUND_SECTION_SIZE,
      offset,
      id: readUint16LE(bytes, offset + UNBOUND_SECTION_ID_OFFSET),
      saveIndex: readUint32LE(bytes, offset + UNBOUND_SECTION_SAVE_INDEX_OFFSET),
    });
  }
  return sections;
}

function newerSection(best, current) {
  return compareGen3SaveCounters(current.saveIndex, best.saveIndex) > 0 ? current : best;
}

function activeSection(sections, sectionId) {
  const matches = sections.filter(section => section.id === sectionId);
  return matches.length ? matches.slice(1).reduce(newerSection, matches[0]) : null;
}

function resolveActiveSectionOffsets(sections, sectionIds = null) {
  const wanted = sectionIds ? new Set(sectionIds) : null;
  const best = new Map();
  for (const section of sections) {
    if (wanted && !wanted.has(section.id)) continue;
    const previous = best.get(section.id);
    if (!previous || compareGen3SaveCounters(section.saveIndex, previous.saveIndex) > 0) best.set(section.id, section);
  }
  return best;
}

function displaySpecies(context, speciesId) {
  const name = context.speciesByNum.get(speciesId)?.name;
  if (!name) throw new Error(`Unresolved Pokémon Unbound species identity ${speciesId}`);
  return name;
}

function displayMove(context, moveId) {
  const move = context.movesByNum.get(moveId);
  const name = move?.calcName || move?.name;
  if (!name) throw new Error(`Unresolved Pokémon Unbound move identity ${moveId}`);
  return name;
}

function displayItem(context, itemId) {
  if (!itemId) return "";
  const item = context.itemsByNum?.get(itemId);
  const name = item?.calcName || item?.name;
  if (!name) throw new Error(`Unresolved Pokémon Unbound item identity ${itemId}`);
  return name;
}

function displayNature(context, natureId) {
  return context.naturesByNum?.get(natureId)?.name || NATURE_FALLBACKS[natureId] || "Unknown";
}

function normalizeConstant(value, prefix) {
  return String(value || "")
    .replace(new RegExp(`^${prefix}_`, "i"), "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function displayAbilityConstant(context, constant) {
  const id = normalizeConstant(constant, "ABILITY");
  if (!id || id === "none") return "";
  const ability = context.abilitiesById?.[id];
  return ability?.name || id.replace(/(^|\s)\w/g, value => value.toUpperCase());
}

function abilityInfo(context, speciesId, personalityValue, hiddenAbility) {
  const slots = context.rawSpeciesByNum?.get(speciesId)?.abilities || [];
  const names = slots.map(slot => displayAbilityConstant(context, slot));
  const currentIndex = hiddenAbility ? 2 : (personalityValue & 1);
  const ability = currentIndex === 0
    ? names[0] || names[1] || ""
    : currentIndex === 1
      ? names[1] || names[0] || ""
      : names[2] || "";
  return { ability, abilitySlot: currentIndex, hiddenAbility, abilitySlots: names };
}

function genderFromPersonality(personalityValue, thresholdValue) {
  const threshold = Number(thresholdValue);
  if (!Number.isFinite(threshold)) return "unknown";
  if (threshold === 255) return "genderless";
  if (threshold === 0) return "male";
  if (threshold === 254) return "female";
  return (personalityValue & 0xff) < threshold ? "female" : "male";
}

function isShiny(originalTrainerNumericId, personalityValue) {
  const trainerId = originalTrainerNumericId & 0xffff;
  const secretId = (originalTrainerNumericId >>> 16) & 0xffff;
  return (trainerId ^ secretId ^ (personalityValue & 0xffff) ^ ((personalityValue >>> 16) & 0xffff)) < 16;
}

function statObject(values) {
  return { hp: values[0], at: values[1], df: values[2], sp: values[3], sa: values[4], sd: values[5] };
}

function normalizeMon(context, values) {
  const species = displaySpecies(context, values.speciesId);
  const nickname = values.nickname || "";
  return {
    pid: values.pid >>> 0,
    otId: values.otId >>> 0,
    species,
    speciesId: values.speciesId,
    nickname,
    displayName: nickname || species,
    level: values.level,
    exp: values.exp,
    ability: values.ability,
    abilitySlot: values.abilitySlot,
    hiddenAbility: values.hiddenAbility,
    abilitySlots: values.abilitySlots,
    itemId: values.itemId,
    item: displayItem(context, values.itemId),
    nature: displayNature(context, values.natureId),
    natureId: values.natureId,
    gender: values.gender,
    shiny: values.shiny,
    ivs: values.ivs,
    evs: values.evs,
    moveIds: values.moveIds,
    moves: values.moveIds.filter(Boolean).map(moveId => displayMove(context, moveId)),
    movePp: values.movePp || [],
    movePpUps: values.movePpUps || [],
    currentHp: values.currentHp ?? null,
    maxHp: values.maxHp ?? null,
    location: "",
    locationId: null,
    source: "save_file",
    storage: values.storage,
    box: values.box,
    slot: values.slot,
    ballId: values.ballId,
  };
}

function decodeUnboundText(bytes, characterMap) {
  return decodeGen3Text(bytes, { characterMap, stopBytes: [0xff], unknownCharacter: "?", trim: "right" });
}

function parsePartyMon(raw, slot, context) {
  if (raw.byteLength < UNBOUND_PARTY_RECORD_SIZE) throw new Error(`Truncated Pokémon Unbound party record ${slot}`);
  const pid = readUint32LE(raw, 0);
  const otId = readUint32LE(raw, 4);
  const growth = raw.subarray(0x20, 0x2c);
  const attacks = raw.subarray(0x2c, 0x38);
  const evData = raw.subarray(0x38, 0x44);
  const misc = raw.subarray(0x44, 0x50);
  const speciesId = readUint16LE(growth, 0);
  const itemId = readUint16LE(growth, 2);
  const exp = readUint32LE(growth, 4);
  const ppUps = readUint8(growth, 8);
  const ivWord = readUint32LE(misc, 4);
  const hiddenAbility = Boolean((ivWord >>> 31) & 1);
  const ability = abilityInfo(context, speciesId, pid, hiddenAbility);
  const species = context.speciesByNum.get(speciesId);
  const moveIds = [0, 1, 2, 3].map(index => readUint16LE(attacks, index * 2));
  return normalizeMon(context, {
    pid,
    otId,
    speciesId,
    nickname: decodeUnboundText(raw.subarray(0x08, 0x12), PARTY_CHARACTER_MAP),
    level: readUint8(raw, 0x54),
    exp,
    itemId,
    natureId: pid % 25,
    gender: genderFromPersonality(pid, species?.genderRatio),
    shiny: isShiny(otId, pid),
    ivs: statObject([
      ivWord & 0x1f, (ivWord >>> 5) & 0x1f, (ivWord >>> 10) & 0x1f,
      (ivWord >>> 15) & 0x1f, (ivWord >>> 20) & 0x1f, (ivWord >>> 25) & 0x1f,
    ]),
    evs: statObject(Array.from(evData.subarray(0, 6))),
    moveIds,
    movePp: Array.from(attacks.subarray(8, 12)),
    movePpUps: [ppUps & 3, (ppUps >>> 2) & 3, (ppUps >>> 4) & 3, (ppUps >>> 6) & 3],
    currentHp: readUint16LE(raw, 0x56),
    maxHp: readUint16LE(raw, 0x58),
    ballId: growth[10],
    storage: "party",
    box: null,
    slot,
    ...ability,
  });
}

function parseParty(bytes, sections, context) {
  const trainer = activeSection(sections, TRAINER_SECTION_ID);
  if (!trainer) throw new Error("Active Pokémon Unbound trainer section not found");
  const count = Math.min(6, readUint32LE(bytes, trainer.offset + PARTY_COUNT_OFFSET));
  const party = [];
  for (let index = 0; index < count; index += 1) {
    const offset = trainer.offset + PARTY_START_OFFSET + (index * UNBOUND_PARTY_RECORD_SIZE);
    party.push(parsePartyMon(bytes.subarray(offset, offset + UNBOUND_PARTY_RECORD_SIZE), index + 1, context));
  }
  return { party, trainerSection: trainer };
}

export function unboundExperienceAtLevel(growthRate, level) {
  const n = Math.max(1, Math.min(100, Number(level) || 1));
  if (n <= 1) return 0;
  switch (String(growthRate || "Medium Fast").toLowerCase()) {
  case "erratic":
    if (n <= 50) return Math.floor((n ** 3 * (100 - n)) / 50);
    if (n <= 68) return Math.floor((n ** 3 * (150 - n)) / 100);
    if (n <= 98) return Math.floor((n ** 3 * Math.floor((1911 - 10 * n) / 3)) / 500);
    return Math.floor((n ** 3 * (160 - n)) / 100);
  case "fluctuating":
    if (n <= 15) return Math.floor(n ** 3 * (Math.floor((n + 1) / 3) + 24) / 50);
    if (n <= 36) return Math.floor(n ** 3 * (n + 14) / 50);
    return Math.floor(n ** 3 * (Math.floor(n / 2) + 32) / 50);
  case "medium slow": return Math.floor(1.2 * n ** 3 - 15 * n ** 2 + 100 * n - 140);
  case "fast": return Math.floor(4 * n ** 3 / 5);
  case "slow": return Math.floor(5 * n ** 3 / 4);
  default: return n ** 3;
  }
}

export function unboundLevelFromExperience(growthRate, experience) {
  const value = Number(experience) || 0;
  for (let level = 1; level < 100; level += 1) {
    if (value < unboundExperienceAtLevel(growthRate, level + 1)) return level;
  }
  return 100;
}

function isValidPcMon(raw) {
  if (!raw || raw.byteLength < UNBOUND_PC_RECORD_SIZE) return false;
  const speciesId = readUint16LE(raw, 0x1c);
  const experience = readUint32LE(raw, 0x20);
  return speciesId > 0 && speciesId <= 2500 && experience > 0 && experience <= 2_000_000;
}

function packedPcMoves(raw) {
  let packed = 0n;
  for (let index = 0; index < 5; index += 1) packed |= BigInt(raw[0x27 + index]) << BigInt(index * 8);
  return [0, 10, 20, 30].map(shift => Number((packed >> BigInt(shift)) & 0x3ffn));
}

function parsePcMon(raw, box, slot, context) {
  if (!isValidPcMon(raw)) return null;
  const pid = readUint32LE(raw, 0);
  const otId = readUint32LE(raw, 4);
  const speciesId = readUint16LE(raw, 0x1c);
  const itemId = readUint16LE(raw, 0x1e);
  const experience = readUint32LE(raw, 0x20);
  const ppUps = raw[0x24];
  const ivWord = readUint32LE(raw, 0x36);
  const hiddenAbility = Boolean((ivWord >>> 31) & 1);
  const ability = abilityInfo(context, speciesId, pid, hiddenAbility);
  const species = context.speciesByNum.get(speciesId);
  const moveIds = packedPcMoves(raw);
  return normalizeMon(context, {
    pid,
    otId,
    speciesId,
    nickname: decodeUnboundText(raw.subarray(0x08, 0x12), PC_CHARACTER_MAP),
    level: unboundLevelFromExperience(species?.growthRate, experience),
    exp: experience,
    itemId,
    natureId: pid % 25,
    gender: genderFromPersonality(pid, species?.genderRatio),
    shiny: isShiny(otId, pid),
    ivs: statObject([
      ivWord & 0x1f, (ivWord >>> 5) & 0x1f, (ivWord >>> 10) & 0x1f,
      (ivWord >>> 15) & 0x1f, (ivWord >>> 20) & 0x1f, (ivWord >>> 25) & 0x1f,
    ]),
    evs: statObject(Array.from(raw.subarray(0x2c, 0x32))),
    moveIds,
    movePpUps: [ppUps & 3, (ppUps >>> 2) & 3, (ppUps >>> 4) & 3, (ppUps >>> 6) & 3],
    ballId: raw[0x26],
    storage: "box",
    box,
    slot,
    ...ability,
  });
}

function activePcSectors(sections) {
  const candidates = sections.filter(section => PC_RELEVANT_SECTION_IDS.has(section.id));
  if (!candidates.length) return [];
  const newest = candidates.slice(1).reduce(newerSection, candidates[0]);
  return candidates
    .filter(section => section.saveIndex === newest.saveIndex)
    .sort((first, second) => first.id - second.id);
}

function fallbackSlotOffset(box, slot, activeOffsets) {
  for (const segment of FALLBACK_BOX_LAYOUTS[box] || []) {
    const [kind] = segment;
    if (kind === "absolute") {
      const [, start, end, base] = segment;
      if (slot >= start && slot <= end) return base + ((slot - start) * UNBOUND_PC_RECORD_SIZE);
    } else {
      const [, sectionId, start, end, relative] = segment;
      if (slot < start || slot > end) continue;
      const section = activeOffsets.get(sectionId);
      return section ? section.offset + relative + ((slot - start) * UNBOUND_PC_RECORD_SIZE) : null;
    }
  }
  return null;
}

function isEmptySlot(raw) {
  return raw.every(value => value === 0);
}

function validFallbackBox(bytes, box, activeOffsets) {
  for (const segment of FALLBACK_BOX_LAYOUTS[box] || []) {
    const start = segment[2];
    const end = segment[3];
    for (let slot = start; slot <= end; slot += 1) {
      const offset = fallbackSlotOffset(box, slot, activeOffsets);
      if (!Number.isInteger(offset) || offset < 0 || offset + UNBOUND_PC_RECORD_SIZE > bytes.byteLength) return false;
      const raw = bytes.subarray(offset, offset + UNBOUND_PC_RECORD_SIZE);
      if (isEmptySlot(raw) || isValidPcMon(raw)) continue;
      if (box === 23 && slot === 4) continue;
      return false;
    }
  }
  return true;
}

function parsePc(bytes, sections, context) {
  const sectors = activePcSectors(sections);
  if (!sectors.length) throw new Error("Active Pokémon Unbound PC sections not found");
  const pcChunks = [];
  let finalBoxSector = null;
  for (const sector of sectors) {
    if (PC_STREAM_SECTION_IDS.includes(sector.id)) {
      pcChunks.push(bytes.subarray(
        sector.offset + PC_SECTION_HEADER_SIZE,
        sector.offset + PC_SECTION_HEADER_SIZE + PC_SECTION_PAYLOAD_SIZE,
      ));
    } else if (sector.id === 0) {
      finalBoxSector = bytes.subarray(sector.offset, sector.offset + UNBOUND_SECTION_SIZE);
    }
  }
  const pcBuffer = new Uint8Array(pcChunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let cursor = 0;
  for (const chunk of pcChunks) { pcBuffer.set(chunk, cursor); cursor += chunk.byteLength; }
  const activeOffsets = resolveActiveSectionOffsets(sections, [2, 3]);
  const boxes = [];

  for (let box = 1; box <= UNBOUND_BOX_COUNT; box += 1) {
    const boxMons = [];
    for (let slot = 1; slot <= PC_BOX_SIZE; slot += 1) {
      const offset = ((((box - 1) * PC_BOX_SIZE) + (slot - 1)) * UNBOUND_PC_RECORD_SIZE);
      if (offset + UNBOUND_PC_RECORD_SIZE > pcBuffer.byteLength) break;
      const mon = parsePcMon(pcBuffer.subarray(offset, offset + UNBOUND_PC_RECORD_SIZE), box, slot, context);
      if (mon) boxMons.push(mon);
    }
    if (!boxMons.length && FALLBACK_BOX_LAYOUTS[box] && validFallbackBox(bytes, box, activeOffsets)) {
      for (let slot = 1; slot <= PC_BOX_SIZE; slot += 1) {
        const offset = fallbackSlotOffset(box, slot, activeOffsets);
        if (!Number.isInteger(offset) || offset + UNBOUND_PC_RECORD_SIZE > bytes.byteLength) continue;
        const mon = parsePcMon(bytes.subarray(offset, offset + UNBOUND_PC_RECORD_SIZE), box, slot, context);
        if (mon) boxMons.push(mon);
      }
    }
    boxes.push(...boxMons);
  }

  if (finalBoxSector) {
    for (let slot = 1; slot <= PC_BOX_SIZE; slot += 1) {
      const offset = FINAL_BOX_OFFSET + ((slot - 1) * UNBOUND_PC_RECORD_SIZE);
      const mon = parsePcMon(finalBoxSector.subarray(offset, offset + UNBOUND_PC_RECORD_SIZE), UNBOUND_BOX_COUNT, slot, context);
      if (mon) boxes.push(mon);
    }
  }
  return {
    boxes,
    pcSaveIndex: sectors[0].saveIndex,
    pcBufferBytes: pcBuffer.byteLength,
    activePcSectionIds: sectors.map(section => section.id),
  };
}

function saveBlock1OffsetToSection(offset) {
  let remaining = offset;
  for (let index = 0; index < SAVE_BLOCK1_CHUNK_SIZES.length; index += 1) {
    if (remaining < SAVE_BLOCK1_CHUNK_SIZES[index]) {
      return { sectionId: SAVE_BLOCK1_SECTION_IDS[index], relativeOffset: remaining };
    }
    remaining -= SAVE_BLOCK1_CHUNK_SIZES[index];
  }
  return null;
}

function readEventFlag(bytes, sections, flagId) {
  const byteOffset = SAVE_BLOCK1_FLAGS_OFFSET + Math.floor(flagId / 8);
  const mapped = saveBlock1OffsetToSection(byteOffset);
  if (!mapped) return false;
  const section = activeSection(sections, mapped.sectionId);
  if (!section) return false;
  const value = bytes[section.offset + mapped.relativeOffset];
  return Boolean((value >>> (flagId % 8)) & 1);
}

function parseProgress(bytes, sections) {
  const badges = {};
  let badgeByte = 0;
  let badgeCount = 0;
  for (let flag = BADGE_FLAG_FIRST; flag <= BADGE_FLAG_LAST; flag += 1) {
    const number = flag - BADGE_FLAG_FIRST + 1;
    const earned = readEventFlag(bytes, sections, flag);
    badges[`badge${number}`] = earned;
    if (earned) { badgeByte |= 1 << (number - 1); badgeCount += 1; }
  }
  const champion = readEventFlag(bytes, sections, CHAMPION_FLAG);
  const trainer = activeSection(sections, TRAINER_SECTION_ID);
  const section4 = activeSection(sections, 4);
  const money = trainer ? readUint32LE(bytes, trainer.offset + 0x290) : null;
  const battlePoints = section4 ? readUint16LE(bytes, section4.offset + 0x0f34) : null;
  const progress = {
    badgeByte,
    badgeCount,
    badges,
    champion,
  };
  if (money !== null) progress.money = money;
  if (battlePoints !== null) progress.battlePoints = battlePoints;
  return progress;
}

export function parsePokemonUnboundSave(value, {
  context,
  observedAt,
  sourceName = "",
} = {}) {
  const dataset = requiredContext(context);
  const { source, bytes } = coreSaveBytes(value);
  const sections = listUnboundSections(bytes);
  const partyResult = parseParty(bytes, sections, dataset);
  const pcResult = parsePc(bytes, sections, dataset);
  const progress = parseProgress(bytes, sections);
  const identitySection = activeSection(sections, 0);
  if (!identitySection) throw new Error("Active Pokémon Unbound player identity section not found");
  const playerId32 = readUint32LE(bytes, identitySection.offset + 0x0a);
  const playerTrainerIdentity = createPlayerTrainerIdentity({
    trainerId: playerId32 & 0xffff,
    secretId: playerId32 >>> 16,
  });
  return createGbaNeutralSnapshot({
    gameId: "pokemon-unbound",
    formatId: "unbound",
    context: dataset,
    sourceName,
    sourceBytes: source.byteLength,
    observedAt,
    selection: {
      saveIndex: partyResult.trainerSection.saveIndex,
      trainerSectionPhysicalIndex: partyResult.trainerSection.physicalIndex,
      activePcSectionIds: pcResult.activePcSectionIds,
      pcSaveIndex: pcResult.pcSaveIndex,
      pcBufferBytes: pcResult.pcBufferBytes,
      coreSaveBytes: bytes.byteLength,
      rtcTrailerBytes: Math.max(0, source.byteLength - bytes.byteLength),
    },
    playerTrainerIdentity,
    boxCount: UNBOUND_BOX_COUNT,
    party: partyResult.party,
    boxes: pcResult.boxes,
    progress,
  });
}
