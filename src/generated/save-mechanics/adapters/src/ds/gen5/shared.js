export const UNOVA_BADGES = Object.freeze([
  { id: "first", mask: 0x01 }, { id: "second", mask: 0x02 },
  { id: "third", mask: 0x04 }, { id: "fourth", mask: 0x08 },
  { id: "fifth", mask: 0x10 }, { id: "sixth", mask: 0x20 },
  { id: "seventh", mask: 0x40 }, { id: "eighth", mask: 0x80 },
]);

export const BW_PROGRESS = Object.freeze({ badgeByteOffset: 0x21204, playTimeOffset: 0x19424 });
export const BW2_PROGRESS = Object.freeze({ badgeByteOffset: 0x21104, playTimeOffset: 0x19424 });
