// Display-only starter-trio colors requested for the selector. These do not
// override species typing or feed any battle calculation.
const TRIO_COLORS = Object.freeze({
  'fire-red-omega': { elekid: 'electric', smoochum: 'ice', magby: 'fire' },
  'pokemon-unbound': { beldum: 'steel', gible: 'ground', larvitar: 'dark' }
});

export function starterPresentationType(gameId, choice, species) {
  if (!choice) return null;
  return TRIO_COLORS[gameId]?.[choice.speciesId] || choice.type?.toLowerCase() || species?.types?.[0]?.toLowerCase() || null;
}
