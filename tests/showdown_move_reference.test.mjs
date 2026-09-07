import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SHOWDOWN_MOVE_REFERENCE,
  SHOWDOWN_MOVE_REFERENCE_BY_GAME,
  SHOWDOWN_REFERENCE_SOURCE
} from "../src/rulesets/generated/showdown_move_reference.js";
import { vw2rMoveSupport } from "../src/rulesets/vw2r_move_support.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vw2rMoves = JSON.parse(fs.readFileSync(
  path.join(here, "..", "src", "generated", "datasets", "volt-white-2r", "moves.json"),
  "utf8"
)).records;

test("the pinned Showdown reference covers every standardized VW2R move", () => {
  assert.equal(SHOWDOWN_REFERENCE_SOURCE.package, "pokemon-showdown@0.11.11");
  assert.equal(SHOWDOWN_REFERENCE_SOURCE.moveCount, 559);
  assert.deepEqual(Object.keys(SHOWDOWN_MOVE_REFERENCE).sort(), Object.keys(vw2rMoves).sort());
});

test("every calculation-applicable standardized game move has a game-scoped reference", () => {
  const datasetsRoot = path.join(here, "..", "src", "generated", "datasets");
  for (const gameId of fs.readdirSync(datasetsRoot).sort()) {
    const moves = JSON.parse(fs.readFileSync(path.join(datasetsRoot, gameId, "moves.json"), "utf8")).records;
    const expected = Object.values(moves)
      .filter(move => move.calculationApplicability !== "inapplicable-unused-engine-slot")
      .map(move => move.id)
      .sort();
    assert.deepEqual(Object.keys(SHOWDOWN_MOVE_REFERENCE_BY_GAME[gameId] || {}).sort(), expected, gameId);
  }
});

test("ROM-specific storage IDs resolve through their explicit mechanics bases", () => {
  assert.equal(SHOWDOWN_MOVE_REFERENCE_BY_GAME["platinum-kaizo"].faintattack.canonicalMoveNumber, 185);
  assert.equal(SHOWDOWN_MOVE_REFERENCE_BY_GAME["platinum-kaizo"].weatherballwater.canonicalMoveNumber, 311);
  assert.equal(SHOWDOWN_MOVE_REFERENCE_BY_GAME["pokemon-unbound"].vicegrip.canonicalMoveNumber, 11);
});

test("representative move mechanics remain structured instead of inferred from prose", () => {
  assert.deepEqual(SHOWDOWN_MOVE_REFERENCE.megadrain.drain, [1, 2]);
  assert.deepEqual(SHOWDOWN_MOVE_REFERENCE.drainingkiss.drain, [3, 4]);
  assert.deepEqual(SHOWDOWN_MOVE_REFERENCE.sludgebomb.secondary, { chance: 30, status: "psn" });
  assert.deepEqual(SHOWDOWN_MOVE_REFERENCE.snarl.secondary, { chance: 100, boosts: { spa: -1 } });
  assert.equal(SHOWDOWN_MOVE_REFERENCE.spore.status, "slp");
  assert.equal(SHOWDOWN_MOVE_REFERENCE.fakeout.secondary.volatileStatus, "flinch");
  assert.equal(SHOWDOWN_MOVE_REFERENCE.toxicspikes.sideCondition, "toxicspikes");
  assert.equal(SHOWDOWN_MOVE_REFERENCE.helpinghand.volatileStatus, "helpinghand");
  assert.equal(SHOWDOWN_MOVE_REFERENCE.thunderwave.ignoreImmunity, false);
});

test("callback-dependent mechanics remain explicitly inventoried", () => {
  assert.ok(SHOWDOWN_MOVE_REFERENCE.storedpower.callbacks.includes("basePowerCallback"));
  assert.ok(SHOWDOWN_MOVE_REFERENCE.moonlight.callbacks.includes("onHit"));
  assert.ok(SHOWDOWN_MOVE_REFERENCE.fakeout.callbacks.includes("onTry"));
});

test("every VW2R move compiles to a structured PLC resolver descriptor", () => {
  const unsupported = Object.values(vw2rMoves)
    .map(move => ({ moveId: move.id, support: vw2rMoveSupport(move) }))
    .filter(entry => !entry.support.supported);
  assert.deepEqual(unsupported, []);
});
