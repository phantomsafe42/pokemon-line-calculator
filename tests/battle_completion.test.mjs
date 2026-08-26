import test from "node:test";
import assert from "node:assert/strict";

import { battleCompletionState } from "../src/core/battle_completion.js";

function fixture(playerHp, enemyHp) {
  return {
    plan: {
      combatants: {
        player: { combatantKey: "player", side: "player" },
        enemy: { combatantKey: "enemy", side: "enemy" }
      }
    },
    state: {
      combatantStates: {
        player: { hp: { min: playerHp, max: playerHp, maxHp: 100 } },
        enemy: { hp: { min: enemyHp, max: enemyHp, maxHp: 100 } }
      }
    }
  };
}

test("battle completion presentation locks a winning branch", () => {
  const { plan, state } = fixture(25, 0);
  assert.deepEqual(battleCompletionState(plan, state), {
    ended: true,
    victory: true,
    commitLabel: "Lock Branch"
  });
});

test("battle completion presentation distinguishes losses and continuing turns", () => {
  const loss = fixture(0, 25);
  assert.deepEqual(battleCompletionState(loss.plan, loss.state), {
    ended: true,
    victory: false,
    commitLabel: "Lock Branch"
  });
  const continuing = fixture(25, 25);
  assert.deepEqual(battleCompletionState(continuing.plan, continuing.state), {
    ended: false,
    victory: false,
    commitLabel: "Next Turn"
  });
  assert.deepEqual(battleCompletionState(null, null), {
    ended: false,
    victory: false,
    commitLabel: "Next Turn"
  });
});
