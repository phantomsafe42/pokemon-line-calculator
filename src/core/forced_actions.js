import { toId } from "./primitives.js?v=20260907-two-turn-immunity-v1";

export function forcedTurnAction(combatantState) {
  const volatile = combatantState?.volatileConditions || {};
  if (volatile.rechargeRequired) {
    return {
      kind: "recharge",
      moveId: toId(combatantState?.lastMoveId) || null,
      reason: "must-recharge"
    };
  }
  const chargingMoveId = toId(volatile.chargingMoveId);
  if (chargingMoveId) {
    return {
      kind: "charge",
      moveId: chargingMoveId,
      reason: "two-turn-move"
    };
  }
  return null;
}

export function forcedTurnActionAllows(action, forcedAction) {
  if (!forcedAction) return true;
  return action?.actionType === "move"
    && Boolean(forcedAction.moveId)
    && toId(action.moveId) === forcedAction.moveId;
}
