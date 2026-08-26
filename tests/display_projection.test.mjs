import test from "node:test";
import assert from "node:assert/strict";
import { createDisplayProjection, createDisplaySelection, createEmptyDisplayProjection, validateDisplayProjection } from "../src/contracts/display_projection.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/vw2r-branch-plan.json", import.meta.url)), "utf8"));

test("display selection derives branch columns without publishing an implicit default", () => {
  const selected = ["state-turn-1-main", "state-turn-2-ko", "state-turn-2-survive"];
  const draft = createDisplaySelection(fixture, selected);
  assert.equal(draft.derived.branchCount, 2);
  assert.equal(draft.derived.selectedTurnCount, 3);
  const projection = createDisplayProjection(fixture, selected, { projectionRevision: 7, sentAt: "2026-08-23T00:00:00.000Z" });
  assert.equal(projection.columns.length, 2);
  assert.deepEqual(projection.columns.map(column => column.turns.map(turn => turn.turnNumber)), [[1, 2], [1, 2]]);
  assert.equal(validateDisplayProjection(projection).valid, true);
});

test("empty projection is explicit and malformed projections fail validation", () => {
  const empty = createEmptyDisplayProjection("volt-white-2r", { projectionRevision: 8, sentAt: "2026-08-23T00:00:00.000Z" });
  assert.deepEqual(empty.columns, []);
  assert.equal(validateDisplayProjection(empty).valid, true);
  assert.equal(validateDisplayProjection({ ...empty, gameId: "../bad" }).valid, false);
});
