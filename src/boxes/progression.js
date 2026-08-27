import { boxesForGame, normalizeBoxLibrary, upsertPokemon } from "./library.js";

function integerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function playerCombatants(plan) {
  return Object.values(plan?.combatants || {})
    .filter(combatant => combatant.side === "player")
    .sort((left, right) => Number(left.source?.slot ?? Number.MAX_SAFE_INTEGER) - Number(right.source?.slot ?? Number.MAX_SAFE_INTEGER)
      || left.combatantKey.localeCompare(right.combatantKey));
}

export function branchProgressionSnapshot(plan, stateNodeId) {
  const initial = plan?.stateNodes?.[plan?.initialStateNodeId];
  const locked = plan?.stateNodes?.[stateNodeId];
  if (!initial || !locked) throw new Error("Locked branch progression references an unavailable state");
  return playerCombatants(plan).map(combatant => {
    const initialState = initial.combatantStates?.[combatant.combatantKey] || {};
    const lockedState = locked.combatantStates?.[combatant.combatantKey] || {};
    const initialLevel = integerOrNull(initialState.currentLevel ?? combatant.level);
    const level = integerOrNull(lockedState.currentLevel ?? initialLevel);
    const initialExperience = integerOrNull(initialState.experience ?? combatant.experience);
    const experience = integerOrNull(lockedState.experience ?? initialExperience);
    return {
      combatantKey: combatant.combatantKey,
      displayName: combatant.nickname || combatant.displayName || combatant.speciesId,
      recordId: combatant.source?.uniqueKey || null,
      boxId: combatant.source?.boxId || null,
      initialLevel,
      level,
      initialExperience,
      experience,
      changed: level !== initialLevel || experience !== initialExperience
    };
  }).filter(entry => entry.recordId && entry.level !== null);
}

function locateBox(library, gameId, entry) {
  const boxes = boxesForGame(library, gameId);
  if (entry.boxId) {
    const explicit = boxes.find(box => box.id === entry.boxId && box.pokemon?.[entry.recordId]);
    if (explicit) return { box: explicit, reason: null };
  }
  const matches = boxes.filter(box => box.pokemon?.[entry.recordId]);
  if (matches.length === 1) return { box: matches[0], reason: null };
  return {
    box: null,
    reason: matches.length > 1 ? "record ID is ambiguous across Boxes" : "record is no longer present in Boxes"
  };
}

export function applyBranchProgressionToLibrary(libraryValue, plan, stateNodeId) {
  let library = normalizeBoxLibrary(libraryValue);
  const gameId = plan?.game?.gameId;
  const snapshot = branchProgressionSnapshot(plan, stateNodeId);
  const updated = [];
  const skipped = [];
  for (const entry of snapshot) {
    const located = locateBox(library, gameId, entry);
    if (!located.box) {
      skipped.push({ ...entry, reason: located.reason });
      continue;
    }
    const patch = { id: entry.recordId, level: entry.level };
    if (entry.experience !== null) patch.experience = entry.experience;
    library = upsertPokemon(library, gameId, located.box.id, patch).library;
    updated.push({ ...entry, boxId: located.box.id });
  }
  return { library, snapshot, updated, skipped };
}
