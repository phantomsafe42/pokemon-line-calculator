const SHOWDOWN_GEN5_ANIMATED_SPRITES = "https://play.pokemonshowdown.com/sprites/gen5ani";

function normalizeShowdownSpriteId(value) {
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
    .replace(/['’.\s]/g, "")
    .replace(/[^a-z0-9-]/g, "");
}

export function showdownSpriteId(record, dataset = null) {
  const declaredSpeciesId = record?.speciesId || record?.id;
  const declaredSpecies = dataset?.get?.("species", declaredSpeciesId) || null;
  const declaredForm = record?.formId ? dataset?.get?.("species", record.formId) || null : null;
  const declaredSpeciesKeys = new Set([
    normalizeShowdownSpriteId(declaredSpecies?.id || declaredSpeciesId),
    normalizeShowdownSpriteId(declaredSpecies?.name)
  ].filter(Boolean));
  const formBelongsToSpecies = declaredForm && (
    declaredForm.id === declaredSpecies?.id
    || declaredSpeciesKeys.has(normalizeShowdownSpriteId(declaredForm.baseSpecies))
  );
  const speciesId = dataset
    ? (formBelongsToSpecies ? declaredForm.id : declaredSpecies?.id || declaredSpeciesId)
    : record?.formId || declaredSpeciesId;
  const species = dataset?.get?.("species", speciesId) || null;
  const canonicalName = record?.spriteId
    || species?.spriteId
    || species?.showdownSpriteId
    || species?.mechanicsBase
    || species?.id
    || speciesId
    || record?.displayName
    || record?.name;
  return normalizeShowdownSpriteId(canonicalName);
}

export function showdownSpriteUrl(record, dataset = null) {
  return `${SHOWDOWN_GEN5_ANIMATED_SPRITES}/${showdownSpriteId(record, dataset)}.gif`;
}
