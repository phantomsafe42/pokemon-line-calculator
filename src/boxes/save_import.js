import { parseSave as parseNeutralSave } from "../generated/save-mechanics/adapters/src/parse-save.js?v=20260911-public-save-mechanics-v1";
import { nowIso } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { normalizeBoxPokemon } from "./library.js?v=20260905-drafts-freecalc-partners-v1";

export const PLC_SAVE_GAME_CONFIGS = Object.freeze({
  "fire-red-omega": true,
  "pokemon-unbound": true,
  "platinum-kaizo": true,
  "renegade-platinum": true,
  "storm-silver": true,
  "volt-white-2r": true,
  "pokemon-ruby": true,
  "pokemon-sapphire": true,
  "pokemon-emerald": true,
  "pokemon-firered": true,
  "pokemon-leafgreen": true,
  "pokemon-diamond": true,
  "pokemon-pearl": true,
  "pokemon-platinum": true,
  "pokemon-heartgold": true,
  "pokemon-soulsilver": true,
  "pokemon-black": true,
  "pokemon-white": true,
  "pokemon-black-2": true,
  "pokemon-white-2": true,
});

function recordById(dataset, kind, id) {
  return id ? dataset.get(kind, id) : null;
}

function plcPokemon(mon, dataset, importedAt) {
  const species = recordById(dataset, "species", mon.speciesId);
  if (!species) throw new Error(`Save import has an unresolved species ${mon.speciesId || mon.speciesNumericId}`);
  const moves = mon.moves.filter(slot => slot.id).map(slot => {
    const move = recordById(dataset, "moves", slot.id);
    if (!move) throw new Error(`Save import has an unresolved move ${slot.id || slot.numericId}`);
    return {
      moveId: move.id,
      name: move.name,
      type: move.type,
      basePower: Number(move.basePower || 0),
      pp: Number.isInteger(slot.currentPp) ? slot.currentPp : Number(move.pp || 0),
    };
  });
  return normalizeBoxPokemon({
    id: `pokemon-save-${mon.personalityValue.toString(16).padStart(8, "0")}-${mon.storage}-${mon.box || 0}-${mon.slot}`,
    speciesId: species.id,
    formId: species.id,
    displayName: species.name,
    nickname: mon.nickname,
    level: mon.level,
    experience: mon.experience,
    gender: mon.gender,
    friendship: mon.friendship,
    natureId: mon.natureId || mon.natureName || "serious",
    abilityId: mon.abilityId || mon.abilityName || species.abilities?.[0],
    itemId: mon.heldItemId || mon.heldItemName || null,
    baseStats: species.baseStats,
    ivs: mon.ivs,
    evs: mon.evs,
    moves,
    source: {
      kind: `${dataset.gameId}-save-import`,
      pid: mon.personalityValue,
      storage: mon.storage,
      box: mon.box,
      slot: mon.slot,
      importedAt,
    },
  });
}

export function parseSave(value, dataset, { sourceName = "Selected save" } = {}) {
  if (!PLC_SAVE_GAME_CONFIGS[dataset?.gameId]) {
    throw new Error(`PLC save import is unavailable for ${dataset?.gameId || "the selected game"}`);
  }
  const importedAt = nowIso();
  const snapshot = parseNeutralSave(value, {
    gameId: dataset.gameId,
    dataset,
    sourceName,
    observedAt: importedAt,
    requireReadableParty: true,
  });
  const party = snapshot.party.filter(mon => !mon.isEgg).map(mon => plcPokemon(mon, dataset, importedAt));
  const boxes = snapshot.boxes.filter(mon => !mon.isEgg).map(mon => plcPokemon(mon, dataset, importedAt));
  const pokemon = [...party, ...boxes];
  if (!pokemon.length) throw new Error("The selected save contained no readable Pokémon");
  const physicalBoxCount = Number(snapshot.storage?.boxCount || 0);
  return {
    gameId: dataset.gameId,
    sourceName: String(sourceName).slice(0, 240),
    pokemon,
    partyPokemonIds: party.map(record => record.id),
    partyCount: party.length,
    boxCount: boxes.length,
    pcBoxes: Array.from({ length: physicalBoxCount }, (_, index) => {
      const boxNumber = index + 1;
      return { boxNumber, pokemonCount: boxes.filter(record => Number(record.source?.sourceBox) === boxNumber).length };
    }),
    totalCount: pokemon.length,
    blockOffset: snapshot.selection?.blockOffset ?? snapshot.selection?.smallBlockOffset ?? snapshot.selection?.slotIndex,
    playerTrainerIdentity: snapshot.playerTrainerIdentity,
  };
}

export function selectSavePokemon(imported, selectedPcBoxNumbers = []) {
  if (!PLC_SAVE_GAME_CONFIGS[imported?.gameId] || !Array.isArray(imported?.pokemon) || !Array.isArray(imported?.partyPokemonIds)) {
    throw new Error("A parsed PLC save import is required");
  }
  const available = new Set((imported.pcBoxes || []).map(entry => Number(entry.boxNumber)));
  const selected = [...new Set((selectedPcBoxNumbers || []).map(Number))].sort((left, right) => left - right);
  if (selected.some(boxNumber => !Number.isInteger(boxNumber) || !available.has(boxNumber))) {
    throw new Error("The PC Box selection contains a box that is unavailable in this save import");
  }
  const selectedSet = new Set(selected);
  const partyIds = new Set(imported.partyPokemonIds.map(String));
  const party = imported.pokemon.filter(record => partyIds.has(String(record.id)) || record.source?.storage === "party");
  const boxed = imported.pokemon.filter(record => record.source?.storage === "box" && selectedSet.has(Number(record.source?.sourceBox)));
  return {
    pokemon: [...party, ...boxed],
    partyPokemonIds: party.map(record => record.id),
    partyCount: party.length,
    boxCount: boxed.length,
    totalCount: party.length + boxed.length,
    selectedPcBoxNumbers: selected,
  };
}
