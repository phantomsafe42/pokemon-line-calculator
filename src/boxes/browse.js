import { calculateStats } from '../adapters/combatant_ingest.js';

export const BOX_SORTS = Object.freeze([
  ['order', 'Box order'], ['name', 'Name'], ['dex', 'Pokédex number'], ['level', 'Level'],
  ['hp', 'HP'], ['atk', 'Attack'], ['def', 'Defense'], ['spa', 'Sp. Atk'], ['spd', 'Sp. Def'], ['spe', 'Speed']
]);
export const emptyBoxQuery = () => ({ search: '', type1: '', type2: '', ability: '', move: '', gender: '', item: '', status: '', sort: 'order', direction: 'asc' });
const text = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

// Presentation only: never reorder canonical Box records or Party references.
export function browseBox(box, dataset, query = emptyBoxQuery()) {
  const terms = text(query.search).trim().split(/\s+/u).filter(Boolean);
  const records = box.pokemonOrder.map(id => box.pokemon[id]).filter(Boolean).filter(record => {
    const species = dataset.get('species', record.speciesId);
    if ([query.type1, query.type2].filter(Boolean).some(type => !species?.types?.includes(type))) return false;
    if (query.ability && record.abilityId !== query.ability) return false;
    if (query.move && !record.moves.some(move => move.moveId === query.move)) return false;
    if (query.gender && (record.gender || 'unknown') !== query.gender) return false;
    if (query.item && (record.itemId || 'none') !== query.item) return false;
    if (query.status && (record.majorStatus || 'healthy') !== query.status) return false;
    if (!terms.length) return true;
    const haystack = text([record.nickname, record.displayName, species?.name, species?.num,
      dataset.get('abilities', record.abilityId)?.name, dataset.get('items', record.itemId)?.name,
      ...record.moves.map(move => move.name)].filter(value => value != null).join(' '));
    return terms.every(term => haystack.includes(term));
  });
  if (!query.sort || query.sort === 'order') return query.direction === 'desc' ? records.reverse() : records;
  const stat = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].includes(query.sort);
  const values = new Map(records.map(record => {
    let value = null;
    if (stat) { try { value = calculateStats(record, dataset)[query.sort]; } catch { /* Unavailable sorts last, never invented. */ } }
    else if (query.sort === 'level') value = record.level;
    else if (query.sort === 'name') value = text(record.nickname || record.displayName);
    else if (query.sort === 'dex') { const num = Number(dataset.get('species', record.speciesId)?.num); if (num > 0) value = num; }
    return [record.id, typeof value === 'number' && !Number.isFinite(value) ? null : value];
  }));
  return records.sort((a, b) => {
    const av = values.get(a.id), bv = values.get(b.id);
    if (av == null || bv == null) return av == null ? bv == null ? 0 : 1 : -1;
    const comparison = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return query.direction === 'desc' ? -comparison : comparison;
  });
}
