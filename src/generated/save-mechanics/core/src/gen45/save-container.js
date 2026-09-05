import { asBytes } from "../binary/little-endian.js";

export const NINTENDO_DS_RAW_SAVE_BYTES = 0x80000;
export const DESMUME_DSV_FOOTER_BYTES = 122;

const DESMUME_FOOTER_PREFIX = "|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:";
const DESMUME_FOOTER_SUFFIX = "|-DESMUME SAVE-|";

function hasAsciiAt(bytes, offset, expected) {
  if (offset < 0 || offset + expected.length > bytes.byteLength) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

export function openNintendoDsSaveContainer(value, { label = "Nintendo DS save" } = {}) {
  const source = asBytes(value, { label });
  if (source.byteLength === NINTENDO_DS_RAW_SAVE_BYTES) {
    return Object.freeze({
      container: "raw-sav",
      bytes: source,
      sourceByteLength: source.byteLength,
      rawByteLength: source.byteLength,
      footerByteLength: 0,
    });
  }

  const dsvBytes = NINTENDO_DS_RAW_SAVE_BYTES + DESMUME_DSV_FOOTER_BYTES;
  if (source.byteLength !== dsvBytes) {
    throw new RangeError(
      `${label} must be exactly ${NINTENDO_DS_RAW_SAVE_BYTES} bytes (raw .sav) `
      + `or ${dsvBytes} bytes (DeSmuME .dsv); received ${source.byteLength}`,
    );
  }

  const footerOffset = NINTENDO_DS_RAW_SAVE_BYTES;
  const suffixOffset = source.byteLength - DESMUME_FOOTER_SUFFIX.length;
  if (!hasAsciiAt(source, footerOffset, DESMUME_FOOTER_PREFIX)
      || !hasAsciiAt(source, suffixOffset, DESMUME_FOOTER_SUFFIX)) {
    throw new Error(`${label} has an invalid DeSmuME .dsv footer`);
  }

  return Object.freeze({
    container: "desmume-dsv",
    bytes: source.subarray(0, NINTENDO_DS_RAW_SAVE_BYTES),
    sourceByteLength: source.byteLength,
    rawByteLength: NINTENDO_DS_RAW_SAVE_BYTES,
    footerByteLength: DESMUME_DSV_FOOTER_BYTES,
  });
}
