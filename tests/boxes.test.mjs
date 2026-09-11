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
import { addImportedPlanParty, bindPlanPlayerPartyToImportedBox } from "../src/boxes/plan_import.js";
import { applyBranchProgressionToLibrary, branchProgressionSnapshot } from "../src/boxes/progression.js";
import { parseSave, PLC_SAVE_GAME_CONFIGS, selectSavePokemon } from "../src/boxes/save_import.js";
import { exportShowdown, parseShowdown } from "../src/boxes/showdown.js";
import { parseVw2rSave, selectVw2rSavePokemon } from "../src/boxes/vw2r_save_import.js";
import {
  DESMUME_DSV_FOOTER_BYTES,
  NINTENDO_DS_RAW_SAVE_BYTES,
} from "../src/generated/save-mechanics/core/src/ds/save-container.js";
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

test("shared save import registers every public vanilla Generation 3 through 5 game", () => {
  const vanilla = [
    "pokemon-ruby", "pokemon-sapphire", "pokemon-emerald", "pokemon-firered", "pokemon-leafgreen",
    "pokemon-diamond", "pokemon-pearl", "pokemon-platinum", "pokemon-heartgold", "pokemon-soulsilver",
    "pokemon-black", "pokemon-white", "pokemon-black-2", "pokemon-white-2",
  ];
  for (const gameId of vanilla) assert.equal(PLC_SAVE_GAME_CONFIGS[gameId], true, `${gameId} save import is not registered`);
  assert.equal(PLC_SAVE_GAME_CONFIGS["radical-red"], undefined);
});

test('Box JSON retains observed friendship endpoints and does not invent an unknown value', () => {
  for (const friendship of [0, 255, undefined]) {
    const [record] = parseShowdown('Clefairy\nLevel: 26\n- Pound', dataset);
    if (friendship !== undefined) record.friendship = friendship;
    const result = addBox(createEmptyBoxLibrary(), dataset.gameId, { pokemon: [record] });
    const restored = parseBoxLibrary(exportBoxLibrary(result.library));
    const mon = boxesForGame(restored, dataset.gameId)[0].pokemon[record.id];
    assert.equal(mon.friendship, friendship);
  }
});

function asTestDsv(raw) {
  const bytes = new Uint8Array(NINTENDO_DS_RAW_SAVE_BYTES + DESMUME_DSV_FOOTER_BYTES);
  bytes.set(raw);
  const prefix = "|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:";
  const suffix = "|-DESMUME SAVE-|";
  for (let index = 0; index < prefix.length; index += 1) bytes[NINTENDO_DS_RAW_SAVE_BYTES + index] = prefix.charCodeAt(index);
  for (let index = 0; index < suffix.length; index += 1) bytes[bytes.byteLength - suffix.length + index] = suffix.charCodeAt(index);
  return bytes;
}

function stableSavePokemon(records) {
  return records.map(record => ({
    id: record.id,
    speciesId: record.speciesId,
    nickname: record.nickname,
    level: record.level,
    experience: record.experience,
    abilityId: record.abilityId,
    itemId: record.itemId,
    moves: record.moves,
    ivs: record.ivs,
    evs: record.evs,
    storage: record.source?.storage,
    box: record.source?.sourceBox ?? record.source?.box,
    slot: record.source?.slot,
  }));
}
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
  bindPlanPlayerPartyToImportedBox(fixture.plan, first);
  for (const combatant of Object.values(fixture.plan.combatants).filter(entry => entry.side === "player")) {
    assert.equal(combatant.source.boxId, first.boxId);
    assert.ok(first.library.games[fixture.dataset.gameId].boxes[first.boxId].pokemon[combatant.source.uniqueKey]);
  }
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

test("locked branch progression writes absolute totals and a later branch overwrites instead of compounding", () => {
  const fixture = fixturePlan();
  const [record] = parseShowdown(sampleShowdown, dataset);
  record.level = 26;
  record.experience = 15_000;
  const added = addBox(createEmptyBoxLibrary(), fixture.dataset.gameId, { pokemon: [record], partyPokemonIds: [record.id] });
  const player = fixture.players[0];
  const plannedPlayer = fixture.plan.combatants[player.combatantKey];
  plannedPlayer.source = { ...plannedPlayer.source, kind: "boxes-library", uniqueKey: record.id, boxId: added.boxId };
  plannedPlayer.level = 26;
  plannedPlayer.experience = 15_000;
  const root = fixture.plan.stateNodes[fixture.plan.initialStateNodeId];
  root.combatantStates[player.combatantKey].currentLevel = 26;
  root.combatantStates[player.combatantKey].experience = 15_000;

  const firstBranch = structuredClone(root);
  firstBranch.stateNodeId = "state-exp-first";
  firstBranch.turnNumber = 1;
  firstBranch.combatantStates[player.combatantKey].currentLevel = 27;
  firstBranch.combatantStates[player.combatantKey].experience = 17_100;
  fixture.plan.stateNodes[firstBranch.stateNodeId] = firstBranch;

  const secondBranch = structuredClone(root);
  secondBranch.stateNodeId = "state-exp-second";
  secondBranch.turnNumber = 1;
  secondBranch.combatantStates[player.combatantKey].currentLevel = 26;
  secondBranch.combatantStates[player.combatantKey].experience = 15_000;
  fixture.plan.stateNodes[secondBranch.stateNodeId] = secondBranch;

  const snapshot = branchProgressionSnapshot(fixture.plan, firstBranch.stateNodeId).find(entry => entry.combatantKey === player.combatantKey);
  assert.deepEqual({ initialExperience: snapshot.initialExperience, experience: snapshot.experience, initialLevel: snapshot.initialLevel, level: snapshot.level }, {
    initialExperience: 15_000,
    experience: 17_100,
    initialLevel: 26,
    level: 27
  });

  const firstSave = applyBranchProgressionToLibrary(added.library, fixture.plan, firstBranch.stateNodeId);
  let savedRecord = boxesForGame(firstSave.library, fixture.dataset.gameId)[0].pokemon[record.id];
  assert.equal(savedRecord.experience, 17_100);
  assert.equal(savedRecord.level, 27);

  const secondSave = applyBranchProgressionToLibrary(firstSave.library, fixture.plan, secondBranch.stateNodeId);
  savedRecord = boxesForGame(secondSave.library, fixture.dataset.gameId)[0].pokemon[record.id];
  assert.equal(savedRecord.experience, 15_000);
  assert.equal(savedRecord.level, 26);
  assert.equal(root.combatantStates[player.combatantKey].experience, 15_000);
  assert.equal(root.combatantStates[player.combatantKey].currentLevel, 26);
});

test("VW2R save identity keeps the empty held-item sentinel unmapped", () => {
  assert.equal(dataset.getBySaveNumericId("items", 0), null);
  const miracleSeedSaveId = dataset.documents["save_id_maps.json"].records.items.byCanonicalId.miracleseed;
  assert.equal(dataset.getBySaveNumericId("items", miracleSeedSaveId)?.id, "miracleseed");
});

test("VW2R save item identities exactly cover the standardized item records", () => {
  const items = dataset.documents["items.json"].records;
  const itemMap = dataset.documents["save_id_maps.json"].records.items;
  assert.equal(Object.keys(itemMap.byCanonicalId).length, Object.keys(items).length);
  assert.equal(Object.keys(itemMap.byNumericId).length, Object.keys(items).length);
  for (const item of Object.values(items)) {
    assert.equal(itemMap.byCanonicalId[item.id], item.num);
    assert.equal(itemMap.byNumericId[String(item.num)], item.id);
    assert.equal(dataset.getBySaveNumericId("items", item.num)?.id, item.id);
  }
  assert.equal(dataset.getBySaveNumericId("items", 538)?.id, "eviolite");
  assert.equal(dataset.getBySaveNumericId("items", 540)?.id, "rockyhelmet");
  assert.equal(dataset.getBySaveNumericId("items", 541)?.id, "airballoon");
  assert.equal(dataset.getBySaveNumericId("items", 547)?.id, "ejectbutton");
});

test("VW2R save import is read-only and matches the approved parser fixture", { skip: !process.env.PLC_VW2R_SAVE_FIXTURE }, () => {
  const fixture = path.resolve(process.env.PLC_VW2R_SAVE_FIXTURE);
  const before = fs.readFileSync(fixture);
  const result = parseVw2rSave(before, dataset, { sourceName: path.basename(fixture) });
  const after = fs.readFileSync(fixture);
  assert.deepEqual(after, before);
  assert.ok(result.partyCount >= 1 && result.partyCount <= 6);
  assert.ok(result.boxCount > 0);
  assert.equal(result.totalCount, result.partyCount + result.boxCount);
  assert.equal(result.pcBoxes.length, 24);
  assert.equal(result.pcBoxes.reduce((sum, box) => sum + box.pokemonCount, 0), result.boxCount);
  assert.deepEqual(result.partyPokemonIds, result.pokemon.slice(0, result.partyCount).map(record => record.id));
  assert.ok(result.pokemon.every(record => record.baseStats.hp >= 1 && record.moves.length <= 4));
  assert.ok(result.pokemon.every(record => Number.isInteger(record.experience) && record.experience >= 0));
  const partyOnly = selectVw2rSavePokemon(result, []);
  assert.equal(partyOnly.partyCount, result.partyCount);
  assert.equal(partyOnly.boxCount, 0);
  assert.deepEqual(partyOnly.partyPokemonIds, result.partyPokemonIds);

  const populated = result.pcBoxes.find(box => box.pokemonCount > 0);
  const selected = selectVw2rSavePokemon(result, [populated.boxNumber]);
  assert.equal(selected.partyCount, result.partyCount);
  assert.equal(selected.boxCount, populated.pokemonCount);
  assert.ok(selected.pokemon.slice(result.partyCount).every(record => Number(record.source.sourceBox) === populated.boxNumber));
  assert.throws(() => selectVw2rSavePokemon(result, [25]), /unavailable/i);

  const sharedRaw = parseSave(before, dataset, { sourceName: "fixture.sav" });
  const dsvBytes = asTestDsv(before);
  const dsvBefore = dsvBytes.slice();
  const sharedDsv = parseSave(dsvBytes, dataset, { sourceName: "fixture.dsv" });
  assert.deepEqual(dsvBytes, dsvBefore);
  assert.equal(sharedRaw.partyCount, sharedDsv.partyCount);
  assert.equal(sharedRaw.boxCount, sharedDsv.boxCount);
  assert.deepEqual(sharedRaw.pcBoxes, sharedDsv.pcBoxes);
  assert.deepEqual(stableSavePokemon(sharedRaw.pokemon), stableSavePokemon(sharedDsv.pokemon));
  const rawParty = selectSavePokemon(sharedRaw, []);
  const dsvParty = selectSavePokemon(sharedDsv, []);
  assert.deepEqual(rawParty.partyPokemonIds, dsvParty.partyPokemonIds);
  assert.deepEqual(stableSavePokemon(rawParty.pokemon), stableSavePokemon(dsvParty.pokemon));
});
