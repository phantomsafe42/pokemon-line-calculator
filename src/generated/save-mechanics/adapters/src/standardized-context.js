import { levelFromExperience } from "./interpretation/experience.js";
import { createStandardizedSaveIdentityResolver } from "./identity/standardized-save-identity.js";

function requireDataset(dataset, gameId) {
  if (!dataset || dataset.gameId !== gameId || typeof dataset.get !== "function" || typeof dataset.getBySaveNumericId !== "function") {
    throw new Error(`A standardized ${gameId} Dataset context is required`);
  }
  return dataset;
}

function values(dataset, kind) {
  const indexed = [...(dataset.indexes?.[kind]?.values?.() || [])];
  if (indexed.length) return indexed;
  return Object.values(dataset.documents?.[`${kind}.json`]?.records || {});
}

function recordsObject(dataset, kind) {
  return Object.fromEntries(values(dataset, kind).map(record => [record.id, record]));
}

function byNumeric(dataset, kind, numericId) {
  const mapped = dataset.getBySaveNumericId(kind, numericId);
  if (mapped) return mapped;
  const canonicalId = dataset.documents?.["save_id_maps.json"]?.records?.[kind]?.byNumericId?.[String(numericId)];
  if (canonicalId) {
    const canonical = dataset.get(kind, canonicalId)
      || values(dataset, kind).find(record => record.id === canonicalId);
    if (canonical) return canonical;
  }
  return values(dataset, kind).find(record => Number(record.num) === Number(numericId));
}

function dsContext(dataset) {
  return {
    SPECIES: recordsObject(dataset, "species"),
    ITEMS: recordsObject(dataset, "items"),
    ABILITIES: recordsObject(dataset, "abilities"),
    MOVES: recordsObject(dataset, "moves"),
    NATURES: recordsObject(dataset, "natures"),
    LOCATIONS: recordsObject(dataset, "locations"),
  };
}

function firstSpeciesAbility(dataset, species, slot) {
  const ids = [...(species?.abilitySlots || []), ...(species?.abilities || [])].filter(Boolean);
  const abilityId = Number(slot) === 2 ? species?.hiddenAbility : ids[Number(slot) || 0];
  return (abilityId && dataset.get("abilities", abilityId))
    || ids.map(id => dataset.get("abilities", id)).find(Boolean);
}

function froContext(dataset) {
  const identity = createStandardizedSaveIdentityResolver(dataset, { expectedGameId: dataset.gameId });
  return {
    resolveSpeciesIdentity: numericId => identity.resolveSpecies(numericId),
    resolveSpecies: numericId => identity.resolveSpecies(numericId),
    resolveMove: numericId => byNumeric(dataset, "moves", numericId),
    resolveItem: numericId => byNumeric(dataset, "items", numericId),
    resolveNature: numericId => byNumeric(dataset, "natures", numericId),
    resolveLocation: numericId => byNumeric(dataset, "locations", numericId),
    resolveAbilityIdentity: ({ speciesNumericId, abilityBit }) => identity.resolveAbility({ speciesNumericId, abilitySlot: abilityBit }).ability,
    resolveAbility: ({ speciesNumericId, abilityBit }) => identity.resolveAbility({ speciesNumericId, abilitySlot: abilityBit }).ability,
    levelFromExperience: ({ speciesNumericId, experience }) => levelFromExperience(experience, byNumeric(dataset, "species", speciesNumericId)?.growthRate),
  };
}

function unboundContext(dataset) {
  const makeMap = kind => new Map(values(dataset, kind).map(record => [Number(record.num), record]));
  const speciesByNum = makeMap("species");
  return {
    speciesByNum,
    rawSpeciesByNum: speciesByNum,
    movesByNum: makeMap("moves"),
    itemsByNum: makeMap("items"),
    naturesByNum: makeMap("natures"),
    abilitiesById: Object.fromEntries(values(dataset, "abilities").map(record => [record.id, record])),
  };
}

function standardGbaContext(dataset) {
  return {
    resolveSpecies: numericId => byNumeric(dataset, "species", numericId),
    resolveMove: numericId => byNumeric(dataset, "moves", numericId),
    resolveItem: numericId => byNumeric(dataset, "items", numericId),
    resolveNature: numericId => byNumeric(dataset, "natures", numericId),
    resolveLocation: numericId => byNumeric(dataset, "locations", numericId),
    resolveAbility: ({ species, abilitySlot }) => firstSpeciesAbility(dataset, species, abilitySlot),
    levelFromExperience: ({ species, experience }) => levelFromExperience(experience, species?.growthRate),
  };
}

export function createStandardizedSaveContext(dataset, gameId = dataset?.gameId) {
  requireDataset(dataset, gameId);
  if (gameId.startsWith("pokemon-diamond")
      || gameId.startsWith("pokemon-pearl")
      || gameId.startsWith("pokemon-platinum")
      || gameId.startsWith("pokemon-heartgold")
      || gameId.startsWith("pokemon-soulsilver")
      || gameId.startsWith("pokemon-black")
      || gameId.startsWith("pokemon-white")
      || ["platinum-kaizo", "renegade-platinum", "storm-silver", "volt-white-2r"].includes(gameId)) return dsContext(dataset);
  if (gameId === "fire-red-omega") return froContext(dataset);
  if (gameId === "pokemon-unbound") return unboundContext(dataset);
  return standardGbaContext(dataset);
}
