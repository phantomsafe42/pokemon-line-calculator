import { addBox, normalizeBoxLibrary } from "./library.js";
import { toId } from "../core/primitives.js";

function playerCombatants(plan) {
  return Object.values(plan?.combatants || {})
    .filter(combatant => combatant.side === "player")
    .sort((left, right) => Number(left.source?.slot ?? Number.MAX_SAFE_INTEGER) - Number(right.source?.slot ?? Number.MAX_SAFE_INTEGER)
      || left.combatantKey.localeCompare(right.combatantKey))
    .slice(0, 6);
}

function boxMove(moveRecord, dataset) {
  const move = dataset.get("moves", moveRecord.moveId);
  if (!move) throw new Error(`Imported plan move ${moveRecord.moveId} is unavailable in the selected game`);
  return {
    moveId: moveRecord.moveId,
    name: move.name || moveRecord.moveId,
    type: toId(moveRecord.typeOverride || move.type),
    basePower: Number(moveRecord.basePowerOverride ?? move.basePower ?? 0),
    pp: Number(moveRecord.maxPp ?? move.pp ?? 0)
  };
}

export function planPlayerPartyRecords(plan, dataset) {
  const initialState = plan?.stateNodes?.[plan?.initialStateNodeId];
  return playerCombatants(plan).map((combatant, index) => {
    const initial = initialState?.combatantStates?.[combatant.combatantKey] || {};
    const species = dataset.get("species", combatant.speciesId);
    const moves = (combatant.moves || []).map(move => boxMove(move, dataset));
    const hiddenPower = (combatant.moves || []).find(move => toId(move.moveId) === "hiddenpower" && move.typeOverride);
    return {
      id: `plan-${plan.planId}-${index + 1}`,
      speciesId: combatant.speciesId,
      formId: combatant.formId || null,
      displayName: combatant.displayName || species?.name || combatant.speciesId,
      nickname: combatant.nickname || "",
      level: Number(initial.currentLevel ?? combatant.level),
      ...(Number.isInteger(initial.experience ?? combatant.experience) ? { experience: Number(initial.experience ?? combatant.experience) } : {}),
      gender: combatant.gender ?? null,
      natureId: combatant.natureId || "",
      abilityId: combatant.originalAbilityId || "",
      itemId: combatant.originalItemId || null,
      ...(hiddenPower ? { hiddenPowerTypeOverride: toId(hiddenPower.typeOverride) } : {}),
      baseStats: combatant.baseStats || species?.baseStats,
      ivs: combatant.ivs,
      evs: combatant.evs,
      moves,
      source: { kind: "plan-import", storage: combatant.source?.storage || null, sourceSlot: combatant.source?.slot ?? index + 1 }
    };
  });
}

export function addImportedPlanParty(libraryValue, plan, dataset) {
  const library = normalizeBoxLibrary(libraryValue);
  const gameId = toId(plan?.game?.gameId);
  if (!gameId || gameId !== toId(dataset?.gameId)) throw new Error("Imported plan and selected game do not match");
  const game = library.games[gameId];
  const importNumber = Number(game?.nextImportNumber || 1);
  const pokemon = planPlayerPartyRecords(plan, dataset);
  if (!pokemon.length) throw new Error("Imported plan has no player party to add to Boxes");
  const result = addBox(library, gameId, {
    name: `Import ${importNumber}`,
    pokemon,
    partyPokemonIds: pokemon.map(record => record.id),
    source: { kind: "plan-import", importNumber, planId: plan.planId, planName: plan.name }
  });
  result.library.games[gameId].nextImportNumber = importNumber + 1;
  return { ...result, library: normalizeBoxLibrary(result.library), importNumber };
}
