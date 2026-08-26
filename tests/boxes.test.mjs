import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from "../src/adapters/standardized_dataset.js";
import {
  addBox,
  addParty,
  boxesForGame,
  createEmptyBoxLibrary,
  exportBoxLibrary,
  mergeBoxLibrary,
  parseBoxLibrary,
  updateParty,
  upsertPokemon
} from "../src/boxes/library.js";
import { addImportedPlanParty } from "../src/boxes/plan_import.js";
import { exportShowdown, parseShowdown } from "../src/boxes/showdown.js";
import { parseVw2rSave, selectVw2rSavePokemon } from "../src/boxes/vw2r_save_import.js";
import { fixturePlan } from "./helpers.mjs";

function vw2rDataset() {
  const root = fileURLToPath(new URL("../src/generated/datasets/volt-white-2r/", import.meta.url));
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  return createDatasetContext({
    manifest: read("dataset_manifest.json"),
    mechanics: read("battle_mechanics.json"),
    documents: Object.fromEntries(REQUIRED_DATASET_SOURCES.map(file => [file, read(file)]))
  });
}

const dataset = vw2rDataset();
const sampleShowdown = `angel (Clefairy) (F) @ Eviolite
Ability: Magic Guard
Level: 26
EVs: 4 HP / 252 Def / 252 SpD
IVs: 0 Atk
Calm Nature
- Moonlight
- Nasty Plot
- Dazzling Gleam
- Protect`;

test("Showdown import/export preserves the editable Box calculation fields", () => {
  const [record] = parseShowdown(sampleShowdown, dataset);
  assert.equal(record.speciesId, "clefairy");
  assert.equal(record.nickname, "angel");
  assert.equal(record.level, 26);
  assert.equal(record.ivs.atk, 0);
  assert.equal(record.evs.def, 252);
  assert.equal(record.moves[0].moveId, "moonlight");
  assert.equal(record.moves[0].pp, dataset.get("moves", "moonlight").pp);
  const [roundTrip] = parseShowdown(exportShowdown([record], dataset), dataset);
  assert.equal(roundTrip.speciesId, record.speciesId);
  assert.equal(roundTrip.nickname, record.nickname);
  assert.deepEqual(roundTrip.ivs, record.ivs);
  assert.deepEqual(roundTrip.evs, record.evs);
  assert.deepEqual(roundTrip.moves.map(move => move.moveId), record.moves.map(move => move.moveId));
});

test("Showdown Hidden Power types round-trip as an explicit Box override", () => {
  const [record] = parseShowdown(`Clefairy
Ability: Magic Guard
Level: 26
IVs: 30 HP / 31 Atk / 30 Def / 30 SpA / 31 SpD / 30 Spe
Serious Nature
- Hidden Power [Fire]`, dataset);
  assert.equal(record.hiddenPowerTypeOverride, "fire");
  assert.equal(record.moves[0].moveId, "hiddenpower");
  assert.equal(record.moves[0].type, "fire");
  assert.match(exportShowdown([record], dataset), /- Hidden Power \[Fire\]/);
});

test("one Box Pokémon record can belong to several parties and edits propagate by reference", () => {
  const [record] = parseShowdown(sampleShowdown, dataset);
  let result = addBox(createEmptyBoxLibrary(), dataset.gameId, { pokemon: [record], partyPokemonIds: [record.id], source: { kind: "test" } });
  let library = result.library;
  const box = boxesForGame(library, dataset.gameId)[0];
  const second = addParty(library, dataset.gameId, box.id, [record.id]);
  library = second.library;
  library = upsertPokemon(library, dataset.gameId, box.id, { ...record, level: 27 }).library;
  const updated = boxesForGame(library, dataset.gameId)[0];
  assert.equal(updated.pokemon[record.id].level, 27);
  assert.equal(updated.parties[result.partyId].pokemonIds[0], record.id);
  assert.equal(updated.parties[second.partyId].pokemonIds[0], record.id);
  assert.throws(() => updateParty(library, dataset.gameId, box.id, second.partyId, { pokemonIds: Array(7).fill(record.id).map((id, index) => `${id}-${index}`) }), /missing Pokémon|six Pokémon/);
});

test("changing species clears stale imported form identity while preserving ordinary edits", () => {
  const [record] = parseShowdown(sampleShowdown, dataset);
  record.speciesId = "charmander";
  record.formId = "charmander";
  record.displayName = "Charmander";
  let result = addBox(createEmptyBoxLibrary(), dataset.gameId, { pokemon: [record] });
  let library = result.library;
  const box = boxesForGame(library, dataset.gameId)[0];

  library = upsertPokemon(library, dataset.gameId, box.id, { id: record.id, level: 27 }).library;
  assert.equal(boxesForGame(library, dataset.gameId)[0].pokemon[record.id].formId, "charmander");

  library = upsertPokemon(library, dataset.gameId, box.id, {
    id: record.id,
    speciesId: "charmeleon",
    displayName: "Charmeleon"
  }).library;
  const updated = boxesForGame(library, dataset.gameId)[0].pokemon[record.id];
  assert.equal(updated.speciesId, "charmeleon");
  assert.equal(updated.formId, null);
});

test("Boxes JSON is versioned, portable, mergeable, and game scoped", () => {
  const records = parseShowdown(sampleShowdown, dataset);
  records[0].hiddenPowerTypeOverride = "ice";
  const library = addBox(createEmptyBoxLibrary(), dataset.gameId, { pokemon: records }).library;
  const parsed = parseBoxLibrary(exportBoxLibrary(library, dataset.gameId));
  assert.equal(boxesForGame(parsed, dataset.gameId).length, 1);
  assert.equal(boxesForGame(parsed, dataset.gameId)[0].pokemon[records[0].id].hiddenPowerTypeOverride, "ice");
  assert.equal(boxesForGame(parsed, "another-game").length, 0);
  const merged = mergeBoxLibrary(library, parsed);
  assert.equal(boxesForGame(merged, dataset.gameId).length, 2);
});

test("plan imports create incrementing Import boxes with a referenced player party", () => {
  const fixture = fixturePlan();
  const first = addImportedPlanParty(createEmptyBoxLibrary(), fixture.plan, fixture.dataset);
  const second = addImportedPlanParty(first.library, fixture.plan, fixture.dataset);
  const boxes = boxesForGame(second.library, fixture.dataset.gameId);
  assert.deepEqual(boxes.map(box => box.name), ["Import 1", "Import 2"]);
  assert.equal(second.importNumber, 2);
  for (const box of boxes) {
    assert.equal(box.pokemonOrder.length, 2);
    assert.equal(box.partyOrder.length, 1);
    assert.deepEqual(box.parties[box.partyOrder[0]].pokemonIds, box.pokemonOrder);
    assert.equal(box.pokemon[box.pokemonOrder[0]].abilityId, "pressure");
    assert.equal(box.pokemon[box.pokemonOrder[0]].moves[0].name, "Aqua Jet");
  }
  const parsed = parseBoxLibrary(exportBoxLibrary(second.library));
  const third = addImportedPlanParty(parsed, fixture.plan, fixture.dataset);
  assert.equal(boxesForGame(third.library, fixture.dataset.gameId).at(-1).name, "Import 3");
});

test("VW2R save identity keeps the empty held-item sentinel unmapped", () => {
  assert.equal(dataset.getBySaveNumericId("items", 0), null);
  const miracleSeedSaveId = dataset.documents["save_id_maps.json"].records.items.byCanonicalId.miracleseed;
  assert.equal(dataset.getBySaveNumericId("items", miracleSeedSaveId)?.id, "miracleseed");
});

test("VW2R save import is read-only and matches the approved parser fixture", { skip: !process.env.PLC_VW2R_SAVE_FIXTURE }, () => {
  const fixture = path.resolve(process.env.PLC_VW2R_SAVE_FIXTURE);
  const before = fs.readFileSync(fixture);
  const result = parseVw2rSave(before, dataset, { sourceName: path.basename(fixture) });
  const after = fs.readFileSync(fixture);
  assert.deepEqual(after, before);
  assert.equal(result.partyCount, 6);
  assert.ok(result.boxCount > 0);
  assert.equal(result.totalCount, result.partyCount + result.boxCount);
  assert.equal(result.pcBoxes.length, 7);
  assert.equal(result.pcBoxes.reduce((sum, box) => sum + box.pokemonCount, 0), result.boxCount);
  assert.deepEqual(result.partyPokemonIds, result.pokemon.slice(0, 6).map(record => record.id));
  assert.ok(result.pokemon.every(record => record.baseStats.hp >= 1 && record.moves.length <= 4));
  assert.ok(result.pokemon.every(record => Number.isInteger(record.experience) && record.experience >= 0));
  assert.equal(result.pokemon.find(record => record.nickname === "dukdukgoat")?.itemId, null);
  assert.equal(result.pokemon.find(record => record.nickname === "fonky")?.itemId, "miracleseed");
  const honse = result.pokemon.find(record => record.nickname === "HONSE");
  assert.equal(honse?.speciesId, "keldeo");
  assert.equal(honse?.formId, "keldeo");
  assert.equal(honse?.displayName, "Keldeo - Ordinary");

  const partyOnly = selectVw2rSavePokemon(result, []);
  assert.equal(partyOnly.partyCount, 6);
  assert.equal(partyOnly.boxCount, 0);
  assert.deepEqual(partyOnly.partyPokemonIds, result.partyPokemonIds);

  const populated = result.pcBoxes.find(box => box.pokemonCount > 0);
  const selected = selectVw2rSavePokemon(result, [populated.boxNumber]);
  assert.equal(selected.partyCount, 6);
  assert.equal(selected.boxCount, populated.pokemonCount);
  assert.ok(selected.pokemon.slice(6).every(record => Number(record.source.sourceBox) === populated.boxNumber));
  assert.throws(() => selectVw2rSavePokemon(result, [8]), /unavailable/i);
});
