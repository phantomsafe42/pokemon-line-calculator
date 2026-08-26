function valueType(value) {
  return value === null ? "null" : value?.constructor?.name || typeof value;
}

export function asBytes(value, { copy = false, label = "binary value" } = {}) {
  let bytes;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError(`${label} must be an ArrayBuffer or typed-array view; received ${valueType(value)}`);
  }
  return copy ? new Uint8Array(bytes) : bytes;
}

export function assertByteRange(bytes, offset, length, label = "byte range") {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`${label} offset must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`${label} length must be a non-negative safe integer`);
  }
  if (offset + length > bytes.byteLength) {
    throw new RangeError(`${label} [${offset}, ${offset + length}) exceeds ${bytes.byteLength} bytes`);
  }
}

export function readUint8(bytes, offset = 0) {
  assertByteRange(bytes, offset, 1, "uint8 read");
  return bytes[offset];
}

export function readUint16LE(bytes, offset = 0) {
  assertByteRange(bytes, offset, 2, "uint16 read");
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function readUint32LE(bytes, offset = 0) {
  assertByteRange(bytes, offset, 4, "uint32 read");
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

export function writeUint16LE(bytes, offset, value) {
  assertByteRange(bytes, offset, 2, "uint16 write");
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

export function writeUint32LE(bytes, offset, value) {
  assertByteRange(bytes, offset, 4, "uint32 write");
  const normalized = Number(value) >>> 0;
  bytes[offset] = normalized & 0xff;
  bytes[offset + 1] = (normalized >>> 8) & 0xff;
  bytes[offset + 2] = (normalized >>> 16) & 0xff;
  bytes[offset + 3] = (normalized >>> 24) & 0xff;
}
