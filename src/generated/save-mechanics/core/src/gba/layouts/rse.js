const SHARED_RSE = Object.freeze({
  platformId: "gba",
  generation: 3,
  minimumBytes: 0x10000,
  saveBlock2SectionIds: Object.freeze([0]),
  saveBlock1SectionIds: Object.freeze([1, 2, 3, 4]),
  storageSectionIds: Object.freeze([5, 6, 7, 8, 9, 10, 11, 12, 13]),
  partyCountOffset: 0x234,
  partyDataOffset: 0x238,
  partyRecordSize: 100,
  storageDataOffset: 4,
  boxRecordSize: 80,
  boxSlotCount: 420,
  playerTrainerIdentityOffset: 0x0a,
});

export const RS_SAVE_LAYOUT = Object.freeze({
  ...SHARED_RSE,
  id: "rs",
  saveBlock1LogicalSize: 0x3ac0,
});

export const EMERALD_SAVE_LAYOUT = Object.freeze({
  ...SHARED_RSE,
  id: "emerald",
  saveBlock1LogicalSize: 0x3d88,
});
