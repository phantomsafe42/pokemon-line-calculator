export const STAT_KEYS = Object.freeze(["hp", "atk", "def", "spa", "spd", "spe"]);
export const STAGE_KEYS = Object.freeze(["atk", "def", "spa", "spd", "spe", "accuracy", "evasion"]);

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function toId(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[♀]/g, "f")
    .replace(/[♂]/g, "m")
    .replace(/[^a-z0-9]+/g, "");
}

export function canonicalStats(input = {}, fallback = 0) {
  const aliases = {
    hp: "hp",
    at: "atk",
    atk: "atk",
    df: "def",
    def: "def",
    sa: "spa",
    spa: "spa",
    sd: "spd",
    spd: "spd",
    sp: "spe",
    spe: "spe"
  };
  const output = {};
  for (const [key, value] of Object.entries(input || {})) {
    const normalized = aliases[key];
    if (normalized && Number.isFinite(Number(value))) output[normalized] = Number(value);
  }
  for (const key of STAT_KEYS) {
    if (!Number.isFinite(output[key])) output[key] = Number(fallback);
  }
  return output;
}

export function exactRange(value, maxHp) {
  const numeric = Number(value);
  return {
    min: numeric,
    max: numeric,
    ...(Number.isFinite(Number(maxHp)) ? { maxHp: Number(maxHp) } : {})
  };
}

export function normalizeRange(value, fallback = 0) {
  if (Number.isFinite(Number(value))) return exactRange(Number(value));
  const min = Number(value?.min ?? fallback);
  const max = Number(value?.max ?? min);
  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
    ...(Number.isFinite(Number(value?.maxHp)) ? { maxHp: Number(value.maxHp) } : {})
  };
}

export function stableStringify(value, spacing = 0) {
  const seen = new WeakSet();
  const normalize = current => {
    if (Array.isArray(current)) return current.map(normalize);
    if (!isPlainObject(current)) return current;
    if (seen.has(current)) throw new TypeError("Cannot stringify a cyclic value");
    seen.add(current);
    const result = {};
    for (const key of Object.keys(current).sort()) result[key] = normalize(current[key]);
    seen.delete(current);
    return result;
  };
  return JSON.stringify(normalize(value), null, spacing);
}

export function shortHash(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function makeStableId(prefix, value) {
  const safePrefix = String(prefix || "id").replace(/[^A-Za-z0-9_-]/g, "-");
  return `${safePrefix}-${shortHash(value)}`;
}

export function nowIso() {
  return new Date().toISOString();
}
