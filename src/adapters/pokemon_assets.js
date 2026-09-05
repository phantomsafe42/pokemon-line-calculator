function normalizeAppearanceId(value) {
  const canonicalKey = String(value || "").toLowerCase().trim();
  const punctuationCases = {
    "farfetch’d": "farfetchd",
    "farfetch'd": "farfetchd",
    "mime jr.": "mimejr",
    "mr. mime": "mrmime",
    "nidoran-f": "nidoranf",
    "nidoran-m": "nidoranm",
    "nidoran♀": "nidoranf",
    "nidoran♂": "nidoranm"
  };
  if (punctuationCases[canonicalKey]) return punctuationCases[canonicalKey];
  return canonicalKey
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace("♀", "f")
    .replace("♂", "m")
    .replace(/['’.]|\s/g, "")
    .replace(/[^a-z0-9-]/g, "");
}

export function pokemonAssetAppearanceId(record, dataset = null) {
  const declaredSpeciesId = record?.speciesId || record?.id;
  const declaredSpecies = dataset?.get?.("species", declaredSpeciesId) || null;
  const declaredForm = record?.formId ? dataset?.get?.("species", record.formId) || null : null;
  const declaredSpeciesKeys = new Set([
    normalizeAppearanceId(declaredSpecies?.id || declaredSpeciesId),
    normalizeAppearanceId(declaredSpecies?.name)
  ].filter(Boolean));
  const formBelongsToSpecies = declaredForm && (
    declaredForm.id === declaredSpecies?.id
    || declaredSpeciesKeys.has(normalizeAppearanceId(declaredForm.baseSpecies))
  );
  const speciesId = dataset
    ? (formBelongsToSpecies ? declaredForm.id : declaredSpecies?.id || declaredSpeciesId)
    : record?.formId || declaredSpeciesId;
  const species = dataset?.get?.("species", speciesId) || null;
  const spriteSpecies = record?.spriteId ? dataset?.get?.("species", record.spriteId) || null : null;
  const canonicalName = spriteSpecies?.spriteId
    || spriteSpecies?.showdownSpriteId
    || spriteSpecies?.mechanicsBase
    || record?.spriteId
    || species?.spriteId
    || species?.showdownSpriteId
    || species?.mechanicsBase
    || species?.id
    || speciesId
    || record?.displayName
    || record?.name;
  return normalizeAppearanceId(canonicalName);
}

export function pokemonAssetQuery(record, dataset = null, overrides = {}) {
  return {
    appearanceId: pokemonAssetAppearanceId(record, dataset),
    gender: record?.gender || overrides.gender,
    shiny: Boolean(record?.shiny ?? overrides.shiny),
    view: overrides.view || "front",
    spriteType: overrides.spriteType || "g5-animated",
    fallbackSpriteTypes: overrides.fallbackSpriteTypes || ["g5-static", "pixel"]
  };
}

export function setPokemonAssetImage(resolver, image, record, dataset = null, overrides = {}) {
  if (!resolver?.setImage) throw new Error("Pokemon asset resolver is unavailable.");
  return resolver.setImage(image, pokemonAssetQuery(record, dataset, overrides));
}
