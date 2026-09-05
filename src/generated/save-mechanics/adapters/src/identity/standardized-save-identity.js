export class SaveIdentityResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SaveIdentityResolutionError";
  }
}

function requireDocument(document, kind, gameId) {
  if (!document || document.schemaVersion !== 1 || document.gameId !== gameId || document.kind !== kind || !document.records) {
    throw new SaveIdentityResolutionError(`${kind} Dataset document is missing or does not match ${gameId}`);
  }
  return document;
}

function recordIndex(document) {
  return new Map(Object.entries(document.records || {}).map(([key, value]) => [String(key), value]));
}

function canonicalRecord(index, canonicalId) {
  if (canonicalId === null || canonicalId === undefined || canonicalId === "") return null;
  const direct = index.get(String(canonicalId));
  if (direct) return direct;
  return [...index.values()].find(record => String(record?.id) === String(canonicalId)) || null;
}

function numericIdentity(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new SaveIdentityResolutionError(`${label} must be a non-negative integer; received ${value}`);
  }
  return numeric;
}

function formIdentity(value) {
  return numericIdentity(value ?? 0, "Save form identity");
}

function explicitCompoundSpeciesId(saveMaps, numericId, form) {
  const speciesMaps = saveMaps?.records?.species;
  const nested = speciesMaps?.byNumericIdAndForm?.[String(numericId)];
  if (nested && Object.prototype.hasOwnProperty.call(nested, String(form))) return nested[String(form)];
  return speciesMaps?.byCompoundId?.[`${numericId}:${form}`] || null;
}

export function createDocumentSaveIdentityDataset({
  manifest,
  species,
  abilities,
  saveIdMaps,
  expectedGameId = null,
} = {}) {
  const gameId = String(expectedGameId || manifest?.gameId || species?.gameId || "");
  if (!gameId) throw new SaveIdentityResolutionError("A Dataset game ID is required for save identity resolution");
  if (!manifest || manifest.schemaVersion !== 1 || manifest.gameId !== gameId) {
    throw new SaveIdentityResolutionError(`Dataset manifest is missing or does not match ${gameId}`);
  }
  const speciesDocument = requireDocument(species, "species", gameId);
  const abilitiesDocument = requireDocument(abilities, "abilities", gameId);
  const saveMapDocument = requireDocument(saveIdMaps, "save-id-maps", gameId);
  const indexes = Object.freeze({
    species: recordIndex(speciesDocument),
    abilities: recordIndex(abilitiesDocument),
  });

  return Object.freeze({
    gameId,
    manifest,
    documents: Object.freeze({
      "species.json": speciesDocument,
      "abilities.json": abilitiesDocument,
      "save_id_maps.json": saveMapDocument,
    }),
    indexes,
    get(kind, canonicalId) {
      return canonicalRecord(indexes[kind], canonicalId);
    },
    getBySaveNumericId(kind, numericId) {
      const numeric = numericIdentity(numericId, `${kind} save identity`);
      const canonicalId = saveMapDocument.records?.[kind]?.byNumericId?.[String(numeric)];
      return canonicalId ? this.get(kind, canonicalId) : null;
    },
    getSpeciesBySaveIdentity(numericId, form = 0) {
      const numeric = numericIdentity(numericId, "Species save identity");
      const normalizedForm = formIdentity(form);
      const compoundId = explicitCompoundSpeciesId(saveMapDocument, numeric, normalizedForm);
      if (compoundId) return this.get("species", compoundId);
      return this.getBySaveNumericId("species", numeric);
    },
  });
}

function abilityReferenceAtSlot(species, slot) {
  const explicitSlots = species?.saveIdentity?.abilitySlots ?? species?.abilitySlots;
  if (Array.isArray(explicitSlots)) return explicitSlots[slot];
  if (explicitSlots && typeof explicitSlots === "object") {
    const namedKey = slot === 0 ? "primary" : "secondary";
    const fieldKey = slot === 0 ? "ability1" : "ability2";
    if (Object.prototype.hasOwnProperty.call(explicitSlots, String(slot))) return explicitSlots[String(slot)];
    if (Object.prototype.hasOwnProperty.call(explicitSlots, namedKey)) return explicitSlots[namedKey];
    if (Object.prototype.hasOwnProperty.call(explicitSlots, fieldKey)) return explicitSlots[fieldKey];
  }
  return Array.isArray(species?.abilities) ? species.abilities[slot] : null;
}

function abilityCanonicalId(reference) {
  if (typeof reference === "string") return reference;
  if (reference && typeof reference === "object") return reference.id || reference.abilityId || null;
  return null;
}

function isEmptyAbilityReference(reference) {
  const canonicalId = abilityCanonicalId(reference);
  return canonicalId === null || canonicalId === "" || canonicalId === "none" || canonicalId === "-";
}

export function createStandardizedSaveIdentityResolver(dataset, {
  expectedGameId = null,
  fallbackMissingSecondaryToPrimary = true,
} = {}) {
  const gameId = String(expectedGameId || dataset?.gameId || "");
  if (!gameId || dataset?.gameId !== gameId || typeof dataset.get !== "function" || typeof dataset.getBySaveNumericId !== "function") {
    throw new SaveIdentityResolutionError(`A standardized ${gameId || "game"} Dataset identity context is required`);
  }

  const resolveSpecies = (numericId, { form = 0 } = {}) => {
    const numeric = numericIdentity(numericId, `${gameId} species save identity`);
    const normalizedForm = formIdentity(form);
    const species = typeof dataset.getSpeciesBySaveIdentity === "function"
      ? dataset.getSpeciesBySaveIdentity(numeric, normalizedForm)
      : dataset.getBySaveNumericId("species", numeric);
    if (!species) {
      throw new SaveIdentityResolutionError(`${gameId} has no species identity for save ID ${numeric} form ${normalizedForm}`);
    }
    return species;
  };

  const resolveAbility = ({ speciesNumericId, form = 0, abilitySlot }) => {
    const slot = numericIdentity(abilitySlot, `${gameId} ability slot`);
    if (slot > 1) throw new SaveIdentityResolutionError(`${gameId} ability slot ${slot} is outside the supported Gen 3 save domain`);
    const species = resolveSpecies(speciesNumericId, { form });
    let resolvedSlot = slot;
    let reference = abilityReferenceAtSlot(species, slot);
    let usedPrimaryFallback = false;
    if (slot === 1 && isEmptyAbilityReference(reference) && fallbackMissingSecondaryToPrimary) {
      resolvedSlot = 0;
      reference = abilityReferenceAtSlot(species, 0);
      usedPrimaryFallback = true;
    }
    const abilityId = abilityCanonicalId(reference);
    if (!abilityId) {
      throw new SaveIdentityResolutionError(`${gameId} species ${species.id || species.name || speciesNumericId} has no ability identity for slot ${slot}`);
    }
    const ability = dataset.get("abilities", abilityId);
    if (!ability) {
      throw new SaveIdentityResolutionError(`${gameId} species ${species.id || species.name || speciesNumericId} references missing ability ${abilityId} in slot ${resolvedSlot}`);
    }
    return Object.freeze({
      species,
      ability,
      speciesNumericId: Number(speciesNumericId),
      form: Number(form || 0),
      requestedSlot: slot,
      resolvedSlot,
      usedPrimaryFallback,
    });
  };

  return Object.freeze({
    gameId,
    manifest: dataset.manifest || null,
    resolveSpecies,
    resolveAbility,
  });
}
