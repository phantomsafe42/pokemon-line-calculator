import { createSaveSnapshot } from "../../../../core/src/contracts/save-snapshot.js";

function canonicalStats(values) {
  if (!values || typeof values !== "object") return undefined;
  return {
    hp: Number(values.hp ?? 0),
    atk: Number(values.atk ?? values.at ?? 0),
    def: Number(values.def ?? values.df ?? 0),
    spe: Number(values.spe ?? values.sp ?? 0),
    spa: Number(values.spa ?? values.sa ?? 0),
    spd: Number(values.spd ?? values.sd ?? 0),
  };
}

function resolvedRecord(context, kind, numericId) {
  if (!Number.isInteger(Number(numericId)) || Number(numericId) <= 0) return undefined;
  const resolver = {
    species: context?.resolveSpeciesIdentity || context?.resolveSpecies,
    moves: context?.resolveMoveIdentity || context?.resolveMove,
    items: context?.resolveItemIdentity || context?.resolveItem,
    natures: context?.resolveNatureIdentity || context?.resolveNature,
    locations: context?.resolveLocationIdentity || context?.resolveLocation,
  }[kind];
  const fromResolver = typeof resolver === "function" ? resolver(Number(numericId)) : undefined;
  if (fromResolver && typeof fromResolver === "object") return fromResolver;
  const map = {
    species: context?.speciesByNum,
    moves: context?.movesByNum,
    items: context?.itemsByNum,
    natures: context?.naturesByNum,
    locations: context?.locationsByNum,
  }[kind];
  return map?.get?.(Number(numericId));
}

function shinyFromIds(originalTrainerNumericId, personalityValue) {
  return (((originalTrainerNumericId & 0xffff) ^ (originalTrainerNumericId >>> 16)
    ^ (personalityValue & 0xffff) ^ (personalityValue >>> 16)) & 0xffff) < 8;
}

export function projectLegacyGbaPokemon(mon, context) {
  const rawSpeciesNumericId = Number(mon.speciesInternalId ?? mon.speciesId);
  const speciesNumericId = Number(mon.speciesId);
  const speciesRecord = resolvedRecord(context, "species", speciesNumericId);
  const moveIds = Array.from({ length: 4 }, (_, index) => Number(mon.moveIds?.[index] ?? 0));
  const moves = moveIds.map((numericId, index) => {
    const record = resolvedRecord(context, "moves", numericId);
    const slot = { slot: index + 1, numericId };
    if (Array.isArray(mon.movePp) && index < mon.movePp.length) slot.currentPp = Number(mon.movePp[index]);
    if (record?.id) slot.id = record.id;
    const name = record?.calcName || record?.name || (numericId ? mon.moves?.[moveIds.slice(0, index + 1).filter(Boolean).length - 1] : "");
    if (name) slot.name = name;
    return slot;
  });
  const pokemon = {
    storage: mon.storage,
    slot: Number(mon.slot),
    personalityValue: Number(mon.pid) >>> 0,
    originalTrainerNumericId: Number(mon.otId) >>> 0,
    speciesNumericId,
    speciesId: mon.speciesCanonicalId || speciesRecord?.id,
    speciesName: mon.species,
    nickname: mon.nickname || "",
    displayName: mon.displayName || mon.nickname || mon.species,
    experience: Number(mon.experience ?? mon.exp ?? 0),
    level: Number(mon.level),
    isEgg: Boolean(mon.isEgg),
    isShiny: typeof mon.shiny === "boolean" ? mon.shiny : shinyFromIds(Number(mon.otId) >>> 0, Number(mon.pid) >>> 0),
    heldItemNumericId: Number(mon.itemId ?? 0),
    natureNumericId: Number(mon.natureId),
    abilitySlot: Number(mon.abilitySlot ?? mon.abilityBit ?? 0),
    moveNumericIds: moveIds,
    moves,
  };
  if (rawSpeciesNumericId !== speciesNumericId) pokemon.rawSpeciesNumericId = rawSpeciesNumericId;
  if (mon.storage === "box") pokemon.box = Number(mon.box);
  if (Array.isArray(mon.movePp) && mon.movePp.length === 4) pokemon.movePp = mon.movePp.map(Number);
  if (Array.isArray(mon.movePpUps) && mon.movePpUps.length === 4) pokemon.movePpUps = mon.movePpUps.map(Number);
  if (mon.friendship !== null && mon.friendship !== undefined) pokemon.friendship = Number(mon.friendship);
  if (mon.gender && mon.gender !== "unknown") pokemon.gender = mon.gender === "male" ? "M" : mon.gender === "female" ? "F" : mon.gender === "genderless" ? "N" : mon.gender;
  if (mon.abilityId) pokemon.abilityId = mon.abilityId;
  if (mon.ability) pokemon.abilityName = mon.ability;
  const item = resolvedRecord(context, "items", pokemon.heldItemNumericId);
  if (item?.id) pokemon.heldItemId = item.id;
  if (mon.item) pokemon.heldItemName = typeof mon.item === "string" ? mon.item : mon.item.name;
  const nature = resolvedRecord(context, "natures", pokemon.natureNumericId);
  if (nature?.id) pokemon.natureId = nature.id;
  if (mon.nature) pokemon.natureName = typeof mon.nature === "string" ? mon.nature : mon.nature.name;
  const ivs = canonicalStats(mon.ivs);
  const evs = canonicalStats(mon.evs);
  if (ivs) pokemon.ivs = ivs;
  if (evs) pokemon.evs = evs;
  if (mon.currentHp !== null && mon.currentHp !== undefined) pokemon.currentHp = Number(mon.currentHp);
  if (mon.maxHp !== null && mon.maxHp !== undefined) pokemon.maxHp = Number(mon.maxHp);
  if (mon.locationId !== null && mon.locationId !== undefined) pokemon.metLocationNumericId = Number(mon.locationId);
  if (mon.metLocationId !== null && mon.metLocationId !== undefined) pokemon.metLocationNumericId = Number(mon.metLocationId);
  const location = resolvedRecord(context, "locations", pokemon.metLocationNumericId);
  if (location?.id) pokemon.metLocationId = location.id;
  if (mon.location || location?.name) pokemon.metLocationName = mon.location || location.name;
  if (mon.ballId !== null && mon.ballId !== undefined) pokemon.ballNumericId = Number(mon.ballId);
  if (typeof mon.checksumValid === "boolean") pokemon.checksumValid = mon.checksumValid;
  return pokemon;
}

export function createGbaNeutralSnapshot({
  gameId,
  formatId,
  sourceName,
  sourceBytes,
  observedAt,
  selection,
  playerTrainerIdentity,
  boxCount,
  party,
  boxes,
  progress,
  diagnostics = [],
  context,
}) {
  return createSaveSnapshot({
    gameId,
    platformId: "gba",
    generation: 3,
    formatId,
    source: { name: String(sourceName || "Selected save").slice(0, 240), bytes: sourceBytes, containerFormat: "sav" },
    selection,
    playerTrainerIdentity,
    storage: { boxCount, slotsPerBox: 30 },
    party: party.map(mon => projectLegacyGbaPokemon(mon, context)),
    boxes: boxes.map(mon => projectLegacyGbaPokemon(mon, context)),
    progress,
    diagnostics,
    observedAt,
  });
}
