import { canonicalStats, clone, nowIso, toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { isHiddenPowerType } from "../core/hidden_power.js?v=20260909-consumer-readiness-v2";

export const BOX_LIBRARY_KIND = "pokemon-line-calculator-boxes";
export const BOX_LIBRARY_SCHEMA_VERSION = 1;

const STAT_KEYS = Object.freeze(["hp", "atk", "def", "spa", "spd", "spe"]);

function id(prefix) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function requireText(value, label, max = 240) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return text;
}

function requireInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}`);
  }
  return number;
}

function normalizeStats(value, label, min, max) {
  const stats = canonicalStats(value, NaN);
  for (const stat of STAT_KEYS) stats[stat] = requireInteger(stats[stat], `${label} ${stat}`, min, max);
  return stats;
}

export function normalizeBoxPokemon(record) {
  const speciesId = toId(record?.speciesId || record?.species || record?.displayName);
  if (!speciesId) throw new Error("Box Pokémon species is required");
  const moves = (record.moves || []).slice(0, 4).map((move, index) => ({
    moveId: toId(move?.moveId || move?.id || move?.name || move),
    name: requireText(move?.name || move?.displayName || move?.moveId || move?.id || move, `Move ${index + 1} name`),
    type: toId(move?.type),
    basePower: requireInteger(move?.basePower ?? move?.bp ?? 0, `Move ${index + 1} base power`, 0, 1000),
    pp: requireInteger(move?.pp ?? move?.maxPp ?? 0, `Move ${index + 1} PP`, 0, 99)
  }));
  if (moves.some(move => !move.moveId)) throw new Error("Every Box move requires a stable move ID");
  if (new Set(moves.map(move => move.moveId)).size !== moves.length) throw new Error("A Pokémon cannot store the same move twice");
  const hiddenPowerTypeOverride = toId(record.hiddenPowerTypeOverride);
  if (hiddenPowerTypeOverride && !isHiddenPowerType(hiddenPowerTypeOverride)) {
    throw new Error(`${record.hiddenPowerTypeOverride} is not a valid Hidden Power type`);
  }
  return {
    id: requireText(record.id || id("pokemon"), "Box Pokémon ID"),
    speciesId,
    formId: record.formId ? toId(record.formId) : null,
    displayName: requireText(record.displayName || record.species || speciesId, "Pokémon name"),
    nickname: String(record.nickname || "").trim().slice(0, 40),
    level: requireInteger(record.level, "Level", 1, 100),
    ...(record.experience === null || record.experience === undefined ? {} : { experience: requireInteger(record.experience, "Experience", 0, 10_000_000) }),
    gender: ["M", "F", "N", null].includes(record.gender ?? null) ? record.gender ?? null : null,
    ...(Number.isInteger(record.friendship) && record.friendship >= 0 && record.friendship <= 255 ? { friendship: record.friendship } : {}),
    natureId: toId(record.natureId || record.nature),
    abilityId: toId(record.abilityId || record.ability),
    itemId: toId(record.itemId || record.item) || null,
    majorStatus: ["brn", "par", "psn", "tox", "slp", "frz"].includes(record.majorStatus) ? record.majorStatus : null,
    ...(hiddenPowerTypeOverride ? { hiddenPowerTypeOverride } : {}),
    baseStats: normalizeStats(record.baseStats, "Base stat", 1, 255),
    ivs: normalizeStats(record.ivs, "IV", 0, 31),
    evs: normalizeStats(record.evs, "EV", 0, 255),
    moves,
    source: {
      kind: String(record.source?.kind || record.sourceKind || "manual"),
      pid: record.source?.pid ?? record.pid ?? null,
      storage: record.source?.storage ?? record.storage ?? null,
      sourceBox: record.source?.sourceBox ?? record.source?.box ?? record.box ?? null,
      sourceSlot: record.source?.sourceSlot ?? record.source?.slot ?? record.slot ?? null,
      importedAt: record.source?.importedAt || nowIso()
    },
    createdAt: record.createdAt || nowIso(),
    updatedAt: record.updatedAt || nowIso()
  };
}

function normalizeParty(party, pokemon) {
  const pokemonIds = [...new Set((party.pokemonIds || []).map(String))];
  if (pokemonIds.length > 6) throw new Error(`${party.name || "Party"} cannot contain more than six Pokémon`);
  for (const pokemonId of pokemonIds) {
    if (!pokemon[pokemonId]) throw new Error(`${party.name || "Party"} references missing Pokémon ${pokemonId}`);
  }
  return {
    id: requireText(party.id || id("party"), "Party ID"),
    name: requireText(party.name, "Party name"),
    pokemonIds,
    createdAt: party.createdAt || nowIso(),
    updatedAt: party.updatedAt || nowIso()
  };
}

function normalizeBox(box) {
  const pokemonEntries = Object.values(box.pokemon || {}).map(normalizeBoxPokemon);
  const pokemon = Object.fromEntries(pokemonEntries.map(record => [record.id, record]));
  const pokemonOrder = [...new Set([...(box.pokemonOrder || []).map(String), ...Object.keys(pokemon)])].filter(key => pokemon[key]);
  const partyEntries = Object.values(box.parties || {}).map(party => normalizeParty(party, pokemon));
  const parties = Object.fromEntries(partyEntries.map(party => [party.id, party]));
  const partyOrder = [...new Set([...(box.partyOrder || []).map(String), ...Object.keys(parties)])].filter(key => parties[key]);
  return {
    id: requireText(box.id || id("box"), "Box ID"),
    name: requireText(box.name, "Box name"),
    nextPartyNumber: Math.max(1, requireInteger(box.nextPartyNumber ?? partyEntries.length + 1, "Next party number", 1, 1_000_000)),
    pokemon,
    pokemonOrder,
    parties,
    partyOrder,
    source: clone(box.source || { kind: "manual" }),
    createdAt: box.createdAt || nowIso(),
    updatedAt: box.updatedAt || nowIso()
  };
}

function derivedNextImportNumber(rawGame, boxes) {
  let highest = 0;
  for (const box of Object.values(boxes || {})) {
    const sourceNumber = Number(box.source?.importNumber);
    if (Number.isInteger(sourceNumber) && sourceNumber > highest) highest = sourceNumber;
    const nameMatch = /^Import\s+(\d+)$/i.exec(String(box.name || "").trim());
    if (nameMatch) highest = Math.max(highest, Number(nameMatch[1]));
  }
  return Math.max(1, Number(rawGame?.nextImportNumber) || 1, highest + 1);
}

export function createEmptyBoxLibrary() {
  return {
    kind: BOX_LIBRARY_KIND,
    schemaVersion: BOX_LIBRARY_SCHEMA_VERSION,
    revision: 0,
    games: {},
    updatedAt: nowIso()
  };
}

export function normalizeBoxLibrary(value) {
  if (!value || typeof value !== "object") throw new Error("Boxes library must be an object");
  if (value.kind !== BOX_LIBRARY_KIND || Number(value.schemaVersion) !== BOX_LIBRARY_SCHEMA_VERSION) {
    throw new Error("Unsupported Boxes library format");
  }
  const games = {};
  for (const [rawGameId, rawGame] of Object.entries(value.games || {})) {
    const gameId = toId(rawGameId);
    if (!gameId) throw new Error("Boxes library contains an invalid game ID");
    const boxEntries = Object.values(rawGame.boxes || {}).map(normalizeBox);
    const boxes = Object.fromEntries(boxEntries.map(box => [box.id, box]));
    games[gameId] = {
      gameId,
      nextBoxNumber: Math.max(1, requireInteger(rawGame.nextBoxNumber ?? boxEntries.length + 1, "Next box number", 1, 1_000_000)),
      nextImportNumber: Math.max(1, requireInteger(derivedNextImportNumber(rawGame, boxes), "Next import number", 1, 1_000_000)),
      boxes,
      boxOrder: [...new Set([...(rawGame.boxOrder || []).map(String), ...Object.keys(boxes)])].filter(key => boxes[key])
    };
  }
  return {
    kind: BOX_LIBRARY_KIND,
    schemaVersion: BOX_LIBRARY_SCHEMA_VERSION,
    revision: Math.max(0, requireInteger(value.revision ?? 0, "Library revision", 0, Number.MAX_SAFE_INTEGER)),
    games,
    updatedAt: value.updatedAt || nowIso()
  };
}

function changed(library) {
  library.revision = Number(library.revision || 0) + 1;
  library.updatedAt = nowIso();
  return normalizeBoxLibrary(library);
}

function mutableGame(library, gameId) {
  const normalizedId = toId(gameId);
  if (!normalizedId) throw new Error("Game ID is required");
  library.games[normalizedId] ||= { gameId: normalizedId, nextBoxNumber: 1, nextImportNumber: 1, boxes: {}, boxOrder: [] };
  return library.games[normalizedId];
}

export function boxesForGame(library, gameId) {
  const game = library?.games?.[toId(gameId)];
  return game ? game.boxOrder.map(boxId => game.boxes[boxId]).filter(Boolean) : [];
}

export function addBox(libraryValue, gameId, { name = null, pokemon = [], partyPokemonIds = [], source = { kind: "manual" } } = {}) {
  const library = normalizeBoxLibrary(libraryValue || createEmptyBoxLibrary());
  const game = mutableGame(library, gameId);
  const boxNumber = game.nextBoxNumber++;
  const boxId = id("box");
  const pokemonRecords = pokemon.map(normalizeBoxPokemon);
  const pokemonMap = Object.fromEntries(pokemonRecords.map(record => [record.id, record]));
  const requestedPartyIds = partyPokemonIds.length ? partyPokemonIds.map(String) : [];
  const validPartyIds = requestedPartyIds.filter(recordId => pokemonMap[recordId]).slice(0, 6);
  const parties = {};
  const partyOrder = [];
  let nextPartyNumber = 1;
  let partyId = null;
  if (validPartyIds.length) {
    partyId = id("party");
    parties[partyId] = normalizeParty({ id: partyId, name: `Party ${nextPartyNumber++}`, pokemonIds: validPartyIds }, pokemonMap);
    partyOrder.push(partyId);
  }
  game.boxes[boxId] = normalizeBox({
    id: boxId,
    name: name || `Box ${boxNumber}`,
    nextPartyNumber,
    pokemon: pokemonMap,
    pokemonOrder: pokemonRecords.map(record => record.id),
    parties,
    partyOrder,
    source
  });
  game.boxOrder.push(boxId);
  return { library: changed(library), boxId, partyId };
}

export function renameBox(libraryValue, gameId, boxId, name) {
  const library = normalizeBoxLibrary(libraryValue);
  const box = mutableGame(library, gameId).boxes[boxId];
  if (!box) throw new Error(`Box ${boxId} is unavailable`);
  box.name = requireText(name, "Box name");
  box.updatedAt = nowIso();
  return changed(library);
}

export function addParty(libraryValue, gameId, boxId, pokemonIds = [], name = null) {
  const library = normalizeBoxLibrary(libraryValue);
  const box = mutableGame(library, gameId).boxes[boxId];
  if (!box) throw new Error(`Box ${boxId} is unavailable`);
  const partyNumber = box.nextPartyNumber++;
  const party = normalizeParty({ id: id("party"), name: name || `Party ${partyNumber}`, pokemonIds }, box.pokemon);
  box.parties[party.id] = party;
  box.partyOrder.push(party.id);
  box.updatedAt = nowIso();
  return { library: changed(library), partyId: party.id };
}

export function updateParty(libraryValue, gameId, boxId, partyId, { name, pokemonIds }) {
  const library = normalizeBoxLibrary(libraryValue);
  const box = mutableGame(library, gameId).boxes[boxId];
  const party = box?.parties?.[partyId];
  if (!party) throw new Error(`Party ${partyId} is unavailable`);
  box.parties[partyId] = normalizeParty({ ...party, name: name ?? party.name, pokemonIds: pokemonIds ?? party.pokemonIds, updatedAt: nowIso() }, box.pokemon);
  box.updatedAt = nowIso();
  return changed(library);
}

export function upsertPokemon(libraryValue, gameId, boxId, record) {
  const library = normalizeBoxLibrary(libraryValue);
  const box = mutableGame(library, gameId).boxes[boxId];
  if (!box) throw new Error(`Box ${boxId} is unavailable`);
  const existing = record.id ? box.pokemon[record.id] : null;
  const merged = { ...existing, ...record };
  const incomingSpeciesId = toId(record.speciesId || record.species || record.displayName);
  if (existing && incomingSpeciesId && incomingSpeciesId !== existing.speciesId && !Object.hasOwn(record, "formId")) {
    merged.formId = null;
  }
  const normalized = normalizeBoxPokemon({ ...merged, id: existing?.id || record.id || id("pokemon"), createdAt: existing?.createdAt, updatedAt: nowIso() });
  box.pokemon[normalized.id] = normalized;
  if (!box.pokemonOrder.includes(normalized.id)) box.pokemonOrder.push(normalized.id);
  box.updatedAt = nowIso();
  return { library: changed(library), pokemonId: normalized.id };
}

export function removePokemon(libraryValue, gameId, boxId, pokemonId) {
  const library = normalizeBoxLibrary(libraryValue);
  const box = mutableGame(library, gameId).boxes[boxId];
  if (!box?.pokemon?.[pokemonId]) throw new Error(`Pokémon ${pokemonId} is unavailable`);
  delete box.pokemon[pokemonId];
  box.pokemonOrder = box.pokemonOrder.filter(idValue => idValue !== pokemonId);
  for (const party of Object.values(box.parties)) party.pokemonIds = party.pokemonIds.filter(idValue => idValue !== pokemonId);
  box.updatedAt = nowIso();
  return changed(library);
}

export function removeParty(libraryValue, gameId, boxId, partyId) {
  const library = normalizeBoxLibrary(libraryValue);
  const box = mutableGame(library, gameId).boxes[boxId];
  if (!box?.parties?.[partyId]) throw new Error(`Party ${partyId} is unavailable`);
  delete box.parties[partyId];
  box.partyOrder = box.partyOrder.filter(idValue => idValue !== partyId);
  box.updatedAt = nowIso();
  return changed(library);
}

export function removeBox(libraryValue, gameId, boxId) {
  const library = normalizeBoxLibrary(libraryValue);
  const game = mutableGame(library, gameId);
  if (!game.boxes[boxId]) throw new Error(`Box ${boxId} is unavailable`);
  delete game.boxes[boxId];
  game.boxOrder = game.boxOrder.filter(idValue => idValue !== boxId);
  return changed(library);
}

export function exportBoxLibrary(libraryValue, gameId = null) {
  const library = normalizeBoxLibrary(libraryValue);
  if (!gameId) return JSON.stringify(library, null, 2);
  const selectedId = toId(gameId);
  return JSON.stringify({ ...library, games: library.games[selectedId] ? { [selectedId]: library.games[selectedId] } : {} }, null, 2);
}

export function parseBoxLibrary(text) {
  let value;
  try { value = JSON.parse(String(text)); }
  catch { throw new Error("Boxes library file is not valid JSON"); }
  return normalizeBoxLibrary(value);
}

export function mergeBoxLibrary(currentValue, importedValue) {
  const current = normalizeBoxLibrary(currentValue || createEmptyBoxLibrary());
  const imported = normalizeBoxLibrary(importedValue);
  for (const [gameId, importedGame] of Object.entries(imported.games)) {
    const game = mutableGame(current, gameId);
    for (const sourceBox of importedGame.boxOrder.map(boxId => importedGame.boxes[boxId]).filter(Boolean)) {
      let box = clone(sourceBox);
      if (game.boxes[box.id]) {
        const oldBoxId = box.id;
        box.id = id("box");
        box.name = `${box.name} (Imported)`;
        box.source = { ...box.source, importedFromBoxId: oldBoxId };
      }
      game.boxes[box.id] = normalizeBox(box);
      game.boxOrder.push(box.id);
    }
    game.nextBoxNumber = Math.max(game.nextBoxNumber, importedGame.nextBoxNumber);
    game.nextImportNumber = Math.max(game.nextImportNumber, importedGame.nextImportNumber);
  }
  return changed(current);
}

export class MemoryBoxLibraryStore {
  constructor(value = null) { this.value = value ? normalizeBoxLibrary(value) : null; }
  async load() { return this.value ? clone(this.value) : null; }
  async save(value) { this.value = normalizeBoxLibrary(value); return clone(this.value); }
  async clear() { this.value = null; }
}

export class IndexedDbBoxLibraryStore {
  constructor({ indexedDB = globalThis.indexedDB, databaseName = "pokemon-line-calculator-boxes", storeName = "library" } = {}) {
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.storeName = storeName;
  }
  open() {
    if (!this.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));
    return new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async transact(mode, operation) {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(this.storeName, mode);
        const request = operation(transaction.objectStore(this.storeName));
        request.onsuccess = () => resolve(clone(request.result));
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  }
  load() { return this.transact("readonly", store => store.get("active")); }
  save(value) { return this.transact("readwrite", store => store.put(normalizeBoxLibrary(value), "active")); }
  clear() { return this.transact("readwrite", store => store.delete("active")); }
}
