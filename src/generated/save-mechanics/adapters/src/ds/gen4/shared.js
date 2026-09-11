export const SINNOH_BADGES = Object.freeze([
  { id: "coal", mask: 0x01 }, { id: "forest", mask: 0x02 },
  { id: "cobble", mask: 0x04 }, { id: "fen", mask: 0x08 },
  { id: "relic", mask: 0x10 }, { id: "mine", mask: 0x20 },
  { id: "icicle", mask: 0x40 }, { id: "beacon", mask: 0x80 },
]);

export const JOHTO_BADGES = Object.freeze([
  { id: "zephyr", mask: 0x01 }, { id: "hive", mask: 0x02 },
  { id: "plain", mask: 0x04 }, { id: "fog", mask: 0x08 },
  { id: "storm", mask: 0x10 }, { id: "mineral", mask: 0x20 },
  { id: "glacier", mask: 0x40 }, { id: "rising", mask: 0x80 },
]);

export const DP_PROGRESS = Object.freeze({ badgeByteOffset: 0x7e, playTimeOffset: 0x86 });
export const PLATINUM_PROGRESS = Object.freeze({ badgeByteOffset: 0x82, playTimeOffset: 0x8a });
export const HGSS_PROGRESS = Object.freeze({ badgeByteOffset: 0x7e, playTimeOffset: 0x86 });

// Compatibility alias for the existing Platinum-derived adapters.
export const GEN4_PROGRESS = PLATINUM_PROGRESS;
