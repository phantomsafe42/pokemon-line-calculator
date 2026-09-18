import assert from "node:assert/strict";
import test from "node:test";
import { hasManualStartingHp } from "../src/ui/editor_hp.js";

test("untouched full HP follows calculated stats; explicit HP and pre-damage do not", () => {
  assert.equal(hasManualStartingHp({}, 80), false);
  assert.equal(hasManualStartingHp({ currentHp: 80 }, 80), false);
  assert.equal(hasManualStartingHp({ currentHp: 50 }, 80), true);
  assert.equal(hasManualStartingHp({ currentHp: 0 }, 80), true);
  assert.equal(hasManualStartingHp({ currentHp: 80, currentHpEdited: true }, 80), true);
});
