import assert from "node:assert/strict";
import test from "node:test";
import { forcedTurnAction, forcedTurnActionAllows } from "../src/core/forced_actions.js";

test("two-turn moves force their continuation and block moves, switches, and shifts", () => {
  const forced = forcedTurnAction({ volatileConditions: { chargingMoveId: "Solar Beam" } });
  assert.deepEqual(forced, { kind: "charge", moveId: "solarbeam", reason: "two-turn-move" });
  assert.equal(forcedTurnActionAllows({ actionType: "move", moveId: "solarbeam" }, forced), true);
  assert.equal(forcedTurnActionAllows({ actionType: "move", moveId: "tackle" }, forced), false);
  assert.equal(forcedTurnActionAllows({ actionType: "switch", switchToKey: "bench" }, forced), false);
  assert.equal(forcedTurnActionAllows({ actionType: "shift" }, forced), false);
});

test("recharge turns accept only a synthetic continuation of the prior move", () => {
  const forced = forcedTurnAction({ lastMoveId: "Roar of Time", volatileConditions: { rechargeRequired: true } });
  assert.deepEqual(forced, { kind: "recharge", moveId: "roaroftime", reason: "must-recharge" });
  assert.equal(forcedTurnActionAllows({ actionType: "move", moveId: "roaroftime", targetKeys: [] }, forced), true);
  assert.equal(forcedTurnActionAllows({ actionType: "move", moveId: "tackle" }, forced), false);
  assert.equal(forcedTurnActionAllows({ actionType: "switch", switchToKey: "bench" }, forced), false);
});
