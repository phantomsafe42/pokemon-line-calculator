import assert from "node:assert/strict";
import test from "node:test";
import { calculatorMoveName } from "../src/adapters/shared_damage_adapter.js";
import { hiddenPowerPowerFromIvs, hiddenPowerTypeFromIvs, resolvedHiddenPowerType } from "../src/core/hidden_power.js";

test("Gen 3 through 7 Hidden Power type follows IV parity", () => {
  assert.equal(hiddenPowerTypeFromIvs({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }), "dark");
  assert.equal(hiddenPowerTypeFromIvs({ hp: 30, atk: 30, def: 30, spa: 30, spd: 30, spe: 30 }), "fighting");
  assert.equal(hiddenPowerTypeFromIvs({ hp: 30, atk: 31, def: 30, spa: 30, spd: 31, spe: 30 }), "fire");
});

test("Gen 3 through 5 Hidden Power power follows the second IV bits without a default", () => {
  assert.equal(hiddenPowerPowerFromIvs({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }), 70);
  assert.equal(hiddenPowerPowerFromIvs({ hp: 30, atk: 30, def: 30, spa: 30, spd: 30, spe: 30 }), 70);
  assert.equal(hiddenPowerPowerFromIvs({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }), 30);
  assert.throws(() => hiddenPowerPowerFromIvs({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31 }), /spe IV/i);
  assert.throws(() => hiddenPowerPowerFromIvs({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, { generation: 6 }), /unavailable/i);
});

test("an explicit Hidden Power type does not alter or depend on IVs", () => {
  const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  const before = structuredClone(ivs);
  assert.equal(resolvedHiddenPowerType(ivs, "fire"), "fire");
  assert.deepEqual(ivs, before);
  assert.throws(() => resolvedHiddenPowerType(ivs, "fairy"), /not a valid Hidden Power type/i);
});

test("the PLC selects the shared calculator's typed Hidden Power variant", () => {
  assert.equal(calculatorMoveName({ id: "hiddenpower", name: "Hidden Power", type: "fire" }), "Hidden Power Fire");
  assert.equal(calculatorMoveName({ id: "hiddenpower", name: "Hidden Power", type: "ice" }), "Hidden Power Ice");
  assert.equal(calculatorMoveName({ id: "surf", name: "Surf", type: "water" }), "Surf");
});
