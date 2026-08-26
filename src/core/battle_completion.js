function sideHasLivingCombatant(plan, state, side) {
  if (!plan || !state) return false;
  return Object.values(plan.combatants || {}).some(combatant =>
    combatant.side === side
      && Number(state.combatantStates?.[combatant.combatantKey]?.hp?.max) > 0
  );
}

export function battleCompletionState(plan, state) {
  if (!plan || !state) return { ended: false, victory: false, commitLabel: "Next Turn" };
  const playerAlive = sideHasLivingCombatant(plan, state, "player");
  const enemyAlive = sideHasLivingCombatant(plan, state, "enemy");
  const ended = !playerAlive || !enemyAlive;
  return {
    ended,
    victory: playerAlive && !enemyAlive,
    commitLabel: ended ? "Lock Branch" : "Next Turn"
  };
}
