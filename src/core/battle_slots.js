export const SIDES = Object.freeze(["player", "enemy"]);

export function battleFormat(value) {
  const raw = typeof value === "string" ? value : value?.game?.battleFormat;
  return String(raw || "singles").toLowerCase() === "doubles" ? "doubles" : "singles";
}

export function slotsPerSide(value) {
  return battleFormat(value) === "doubles" ? 2 : 1;
}

export function activeSlotKeys(state, side) {
  const plural = state?.active?.[`${side}CombatantKeys`];
  if (Array.isArray(plural)) return [...plural];
  return [state?.active?.[`${side}CombatantKey`] || null];
}

export function activeKeys(state, side) {
  return activeSlotKeys(state, side).filter(Boolean);
}

export function activeKey(state, side, slot = 0) {
  return activeSlotKeys(state, side)[slot] || null;
}

export function setActiveKey(state, side, slot, combatantKey) {
  const pluralKey = `${side}CombatantKeys`;
  if (Array.isArray(state.active?.[pluralKey])) {
    state.active[pluralKey][slot] = combatantKey;
    if (slot === 0) state.active[`${side}CombatantKey`] = combatantKey;
  } else if (slot === 0) {
    state.active[`${side}CombatantKey`] = combatantKey;
  } else {
    throw new Error(`Schema-v1 state cannot set ${side} slot ${slot + 1}`);
  }
}

export function actionList(actions, side) {
  const value = actions?.[side];
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

export function replacementList(replacements, side) {
  return actionList(replacements, side);
}

export function pendingReplacementSlots(state) {
  if (Array.isArray(state?.pendingReplacementSlots)) {
    return state.pendingReplacementSlots.map(entry => ({ side: entry.side, slot: Number(entry.slot) }));
  }
  return (state?.pendingReplacementSides || []).map(side => ({ side, slot: 0 }));
}

export function setPendingReplacementSlots(state, entries) {
  if (Array.isArray(state.pendingReplacementSlots)) {
    state.pendingReplacementSlots = entries.map(entry => ({ side: entry.side, slot: Number(entry.slot) }));
    state.pendingReplacementSides = [...new Set(entries.map(entry => entry.side))];
  } else {
    state.pendingReplacementSides = [...new Set(entries.map(entry => entry.side))];
  }
}

export function actorSlot(state, side, actorKey) {
  return activeSlotKeys(state, side).indexOf(actorKey);
}

export function activeSlotEntries(state, side) {
  return activeSlotKeys(state, side).map((combatantKey, slot) => ({ side, slot, combatantKey })).filter(entry => entry.combatantKey);
}

export function actionEntries(state, actions) {
  return SIDES.flatMap(side => actionList(actions, side).map(action => ({
    side,
    slot: actorSlot(state, side, action.actorKey),
    action
  })));
}

export function activeEntries(state) {
  return SIDES.flatMap(side => activeSlotEntries(state, side));
}

export function normalizeActionsForPlan(plan, actions, state = null) {
  if (Number(plan?.schemaVersion) < 2) return actions;
  const slotCount = slotsPerSide(plan);
  return Object.fromEntries(SIDES.map(side => {
    const raw = actions?.[side];
    if (Array.isArray(raw) && raw.length === slotCount) return [side, [...raw]];
    const normalized = Array(slotCount).fill(null);
    for (const [index, action] of actionList(actions, side).entries()) {
      const slot = state ? actorSlot(state, side, action.actorKey) : index;
      if (slot >= 0 && slot < slotCount) normalized[slot] = action;
    }
    return [side, normalized];
  }));
}

export function normalizeReplacementsForPlan(plan, replacements) {
  if (Number(plan?.schemaVersion) < 2) return replacements;
  return Object.fromEntries(SIDES.map(side => [side, replacementList(replacements, side).map((action, index) => ({
    ...action,
    slot: Number(action.slot ?? index)
  }))]).filter(([, actions]) => actions.length));
}
