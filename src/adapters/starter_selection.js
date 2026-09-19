// Navigation only. Never mutate the full Dataset index or an existing plan.
export function starterChoice(document, starterId) {
  return document?.choices?.find(choice => choice.id === starterId) || null;
}

export function starterAllows(document, starterId, trainerId, variantId = null) {
  if (!starterChoice(document, starterId)) return true;
  const trainer = document.trainerBindings.find(row => row.trainerId === trainerId);
  if (trainer && !trainer.starterIds.includes(starterId)) return false;
  const variant = variantId && document.variantBindings.find(row => row.trainerId === trainerId && row.variantId === variantId);
  return !variant || variant.starterIds.includes(starterId);
}

export function starterNavigationInputs(trainers, order, document, starterId) {
  if (!starterChoice(document, starterId)) return { trainers, order };
  const filtered = new Map([...trainers].filter(([trainerId]) => starterAllows(document, starterId, trainerId)));
  const alternatives = new Map(document.occurrenceAlternatives.map(row => [row.occurrenceId, row.trainerIds]));
  const records = (order.records || []).map(row => {
    const ids = alternatives.get(row.occurrenceId);
    return ids ? { ...row, participantTrainerIds: ids } : row;
  });
  return { trainers: filtered, order: { ...order, records } };
}

export function validateStarterSelection(document, gameId, trainers, species) {
  if (document?.schemaVersion !== 1 || document.kind !== 'starter-selection' || document.gameId !== gameId
    || document.unknownPolicy !== 'preserve-unmapped-options'
    || !Array.isArray(document.choices) || !document.choices.length
    || !Array.isArray(document.trainerBindings) || !Array.isArray(document.variantBindings)
    || !Array.isArray(document.occurrenceAlternatives)) throw new Error('Starter selection contract is unavailable or unsupported');
  const choices = new Set();
  for (const choice of document.choices) {
    if (!choice.id || choices.has(choice.id) || !species.has(choice.speciesId) || !choice.label || !choice.speciesName) throw new Error('Invalid starter choice');
    choices.add(choice.id);
  }
  const seen = new Set();
  for (const row of [...document.trainerBindings, ...document.variantBindings]) {
    const key = `${row.trainerId}:${row.variantId || ''}`;
    if (seen.has(key) || !trainers.has(row.trainerId) || !row.starterIds?.length || row.starterIds.some(id => !choices.has(id))) throw new Error('Invalid starter trainer binding');
    if (row.variantId && !trainers.get(row.trainerId).mechanicsVariants?.some(v => v.id === row.variantId)) throw new Error('Invalid starter variant binding');
    seen.add(key);
  }
  for (const row of document.occurrenceAlternatives) {
    if (!row.occurrenceId || !trainers.has(row.trainerId) || !row.trainerIds?.length || row.trainerIds.some(id => !trainers.has(id))) throw new Error('Invalid starter occurrence binding');
  }
  return document;
}
