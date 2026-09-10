const STAT_ORDER = Object.freeze(["hp", "atk", "def", "spe", "spa", "spd"]);

export const HIDDEN_POWER_TYPES = Object.freeze([
  "fighting", "flying", "poison", "ground", "rock", "bug", "ghost", "steel",
  "fire", "water", "grass", "electric", "psychic", "ice", "dragon", "dark"
]);

export function isHiddenPowerType(value) {
  return HIDDEN_POWER_TYPES.includes(String(value || "").toLowerCase());
}

export function hiddenPowerTypeFromIvs(ivs, { generation = 5 } = {}) {
  if (!Number.isInteger(Number(generation)) || Number(generation) < 3 || Number(generation) > 7) {
    throw new Error(`Automatic Hidden Power typing is unavailable for generation ${generation}`);
  }
  const parityValue = STAT_ORDER.reduce((sum, stat, index) => {
    const iv = Number(ivs?.[stat]);
    if (!Number.isInteger(iv) || iv < 0 || iv > 31) throw new Error(`Hidden Power requires a valid ${stat} IV`);
    return sum + (iv % 2) * (2 ** index);
  }, 0);
  return HIDDEN_POWER_TYPES[Math.floor(parityValue * 15 / 63)];
}

export function hiddenPowerPowerFromIvs(ivs, { generation = 5 } = {}) {
  if (!Number.isInteger(Number(generation)) || Number(generation) < 3 || Number(generation) > 5) {
    throw new Error(`Automatic Hidden Power power is unavailable for generation ${generation}`);
  }
  const powerValue = STAT_ORDER.reduce((sum, stat, index) => {
    const iv = Number(ivs?.[stat]);
    if (!Number.isInteger(iv) || iv < 0 || iv > 31) throw new Error(`Hidden Power requires a valid ${stat} IV`);
    return sum + ((iv >> 1) & 1) * (2 ** index);
  }, 0);
  return 30 + Math.floor(powerValue * 40 / 63);
}

export function resolvedHiddenPowerType(ivs, override = null, options = {}) {
  const normalizedOverride = String(override || "").toLowerCase();
  if (normalizedOverride) {
    if (!isHiddenPowerType(normalizedOverride)) throw new Error(`${override} is not a valid Hidden Power type`);
    return normalizedOverride;
  }
  return hiddenPowerTypeFromIvs(ivs, options);
}
