import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlayerCollection, normalizeTrainerRoster } from "../src/adapters/combatant_ingest.js";
import { canonicalTrainerMember, DatasetReadinessError } from "../src/adapters/standardized_dataset.js";
import { effectiveCombatantMove } from "../src/core/combatant_moves.js";
import { fixtureDataset } from "./helpers.mjs";

test("trainer gender labels normalize without treating unknown gender as genderless", () => {
  for (const [input, expected] of [["Male", "M"], ["Female", "F"], ["M", "M"], ["F", "F"], ["N", "N"], [null, null], [undefined, null]]) {
    assert.equal(canonicalTrainerMember({ gender: input }).gender, expected);
  }
});

test("Save Tracker stat aliases normalize and explicit speciesId wins over display text", () => {
  const dataset = fixtureDataset();
  const [keldeo] = normalizePlayerCollection({ collection: [{
    uniqueKey: "keldeo-instance",
    speciesId: "keldeo",
    species: "Keldeo - Ordinary",
    displayName: "Keldeo - Ordinary",
    level: 50,
    experience: 125123,
    nature: "Timid",
    ability: "Pressure",
    ivs: { hp: 31, at: 1, df: 2, sa: 3, sd: 4, sp: 5 },
    moves: ["Tackle"]
  }] }, dataset);
  assert.equal(keldeo.speciesId, "keldeo");
  assert.deepEqual(keldeo.ivs, { hp: 31, atk: 1, def: 2, spa: 3, spd: 4, spe: 5 });
  assert.equal(keldeo.level, 50);
  assert.equal(keldeo.experience, 125123);
  assert.ok(keldeo.calculatedStats.hp > 0);
});

test("standardized baseExp normalizes to the portable EXP-yield field without changing Dataset facts", () => {
  const dataset = fixtureDataset();
  const species = dataset.get("species", "slowmon");
  species.baseExp = 608;
  const [enemy] = normalizeTrainerRoster("trainer", null, dataset);
  assert.equal(enemy.baseExperienceYield, 608);
  assert.equal(species.baseExp, 608);
  assert.equal(species.baseExperienceYield, undefined);
});

test("trainer navigation follows standardized split and within-split order", () => {
  const groups = fixtureDataset().trainerGroups();
  assert.deepEqual(groups.map(group => [group.id, group.label, group.trainers.map(trainer => trainer.id)]), [
    ["first", "First Split", ["trainer", "combined"]],
    ["second", "Second Split", ["doubles"]]
  ]);
});

test("trainer navigation preserves full-game order without inventing unresolved splits", () => {
  const groups = fixtureDataset({ flatProgression: true }).trainerGroups();
  assert.deepEqual(groups.map(group => [group.id, group.label, group.levelCap, group.trainers.map(trainer => trainer.id)]), [
    ["full-game", "Full Game", null, ["trainer", "combined", "doubles"]]
  ]);
});

test("combined trainers fail closed until an exact mechanics variant is selected", () => {
  const dataset = fixtureDataset();
  assert.throws(() => normalizeTrainerRoster("combined", null, dataset), DatasetReadinessError);
  const [selected] = normalizeTrainerRoster("combined", "final-rom-trainer-11", dataset);
  assert.equal(selected.natureId, "timid");
  assert.equal(selected.ivs.hp, 31);
  assert.equal(selected.source.trainerVariantId, "final-rom-trainer-11");
});

test("games without the declared zero-EV rule require explicit player EVs", () => {
  const dataset = fixtureDataset();
  dataset.mechanics.features.playerEvGainDisabled = false;
  assert.throws(() => normalizePlayerCollection({ collection: [{
    uniqueKey: "missing-evs", speciesId: "fastmon", level: 50, nature: "Hardy", ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: ["Tackle"]
  }] }, dataset), /EV hp is unavailable/i);
});

test("Box calculation overrides stay on the combatant and never rewrite dataset display facts", () => {
  const dataset = fixtureDataset();
  const sourceMove = structuredClone(dataset.get("moves", "tackle"));
  const [combatant] = normalizePlayerCollection({ party: [{
    uniqueKey: "box-record",
    speciesId: "fastmon",
    displayName: "Fastmon",
    level: 50,
    natureId: "hardy",
    abilityId: "pressure",
    baseStats: { hp: 80, atk: 70, def: 60, spa: 50, spd: 40, spe: 30 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    moves: [{ moveId: "tackle", basePower: 60, type: "water", pp: 12 }],
    source: { kind: "boxes-library" }
  }] }, dataset);
  assert.equal(combatant.moves[0].basePowerOverride, 60);
  assert.equal(combatant.moves[0].typeOverride, "water");
  assert.equal(combatant.moves[0].maxPp, 12);
  assert.equal(combatant.baseStats.atk, 70);
  assert.equal(effectiveCombatantMove(dataset, combatant, null, "tackle").basePower, 60);
  assert.equal(effectiveCombatantMove(dataset, combatant, null, "tackle").type, "water");
  assert.deepEqual(dataset.get("moves", "tackle"), sourceMove);
});
