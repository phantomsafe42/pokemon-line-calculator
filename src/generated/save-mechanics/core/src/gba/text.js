import { asBytes } from "../binary/little-endian.js";

const baseCharacters = new Map([
  [0x00, " "], [0x01, "À"], [0x02, "Á"], [0x03, "Â"], [0x04, "Ç"],
  [0x05, "È"], [0x06, "É"], [0x07, "Ê"], [0x08, "Ë"], [0x09, "Ì"],
  [0x0b, "Î"], [0x0c, "Ï"], [0x0d, "Ò"], [0x0e, "Ó"], [0x0f, "Ô"],
  [0x10, "Œ"], [0x11, "Ù"], [0x12, "Ú"], [0x13, "Û"], [0x14, "Ñ"],
  [0x15, "ß"], [0x16, "à"], [0x17, "á"], [0x19, "ç"], [0x1a, "è"],
  [0x1b, "é"], [0x1c, "ê"], [0x1d, "ë"], [0x1e, "ì"], [0x20, "î"],
  [0x21, "ï"], [0x22, "ò"], [0x23, "ó"], [0x24, "ô"], [0x25, "œ"],
  [0x26, "ù"], [0x27, "ú"], [0x28, "û"], [0x29, "ñ"], [0x2a, "º"],
  [0x2b, "ª"], [0x2d, "&"], [0x2e, "+"], [0x34, "Lv"], [0x35, "="],
  [0x36, ";"], [0x51, "¿"], [0x52, "¡"], [0x53, "PK"], [0x54, "MN"],
  [0x55, "PO"], [0x56, "Ké"], [0x57, "BL"], [0x58, "OC"], [0x59, "K"],
  [0x5a, "Í"], [0x5b, "%"], [0x5c, "("], [0x5d, ")"], [0x68, "â"],
  [0x6f, "í"], [0x79, "↑"], [0x7a, "↓"], [0x7b, "←"], [0x7c, "→"],
  [0x85, "<"], [0x86, ">"], [0xab, "!"], [0xac, "?"], [0xad, "."],
  [0xae, "-"], [0xaf, "·"], [0xb0, "…"], [0xb1, "“"], [0xb2, "”"],
  [0xb3, "‘"], [0xb4, "'"], [0xb5, "♂"], [0xb6, "♀"], [0xb7, "$"],
  [0xb8, ","], [0xb9, "×"], [0xba, "/"], [0xef, ">"], [0xf0, ":"],
  [0xf1, "Ä"], [0xf2, "Ö"], [0xf3, "Ü"], [0xf4, "ä"], [0xf5, "ö"],
  [0xf6, "ü"],
]);

for (let index = 0; index < 10; index += 1) baseCharacters.set(0xa1 + index, String(index));
for (let index = 0; index < 26; index += 1) {
  baseCharacters.set(0xbb + index, String.fromCharCode(65 + index));
  baseCharacters.set(0xd5 + index, String.fromCharCode(97 + index));
}

export const GEN3_ENGLISH_CHARACTER_MAP = Object.freeze(Object.fromEntries(baseCharacters));

function characterLookup(characterMap) {
  if (characterMap instanceof Map) return value => characterMap.get(value);
  if (Array.isArray(characterMap)) return value => characterMap[value];
  if (characterMap && typeof characterMap === "object") return value => characterMap[value];
  return value => GEN3_ENGLISH_CHARACTER_MAP[value];
}

export function decodeGen3Text(value, {
  characterMap = GEN3_ENGLISH_CHARACTER_MAP,
  stopBytes = [0xff],
  unknownCharacter = "",
  trim = "right",
} = {}) {
  const bytes = asBytes(value, { label: "Gen 3 text" });
  const stops = new Set(stopBytes.map(byte => Number(byte) & 0xff));
  const lookup = characterLookup(characterMap);
  let output = "";
  for (const byte of bytes) {
    if (stops.has(byte)) break;
    output += lookup(byte) ?? unknownCharacter;
  }
  if (trim === "both") return output.trim();
  if (trim === "right") return output.trimEnd();
  if (trim !== "none") throw new Error(`Unsupported Gen 3 text trim policy: ${trim}`);
  return output;
}

function reverseCharacterMap(characterMap) {
  const reverse = new Map();
  const entries = characterMap instanceof Map
    ? characterMap.entries()
    : Object.entries(characterMap || GEN3_ENGLISH_CHARACTER_MAP).map(([key, character]) => [Number(key), character]);
  for (const [byte, character] of entries) {
    if (typeof character === "string" && character.length === 1 && !reverse.has(character)) {
      reverse.set(character, Number(byte) & 0xff);
    }
  }
  return reverse;
}

export function encodeGen3Text(text, length, {
  characterMap = GEN3_ENGLISH_CHARACTER_MAP,
  fillByte = 0xff,
  unknownByte = 0x00,
} = {}) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("Gen 3 text length must be a non-negative safe integer");
  }
  const output = new Uint8Array(length);
  output.fill(Number(fillByte) & 0xff);
  const reverse = reverseCharacterMap(characterMap);
  let index = 0;
  for (const character of String(text ?? "")) {
    if (index >= length) break;
    output[index] = reverse.get(character) ?? (Number(unknownByte) & 0xff);
    index += 1;
  }
  return output;
}
