import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from "../src/adapters/standardized_dataset.js";
import { normalizeTrainerRoster, normalizePlayerPartnerRoster } from "../src/adapters/combatant_ingest.js";

const root = new URL("../src/generated/datasets/platinum-kaizo/", import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL(name, root), "utf8"));
const documents = Object.fromEntries(REQUIRED_DATASET_SOURCES.map(name => [name, read(name)]));
const dataset = createDatasetContext({
  manifest: read("dataset_manifest.json"), mechanics: read("battle_mechanics.json"), documents
});
const id = suffix => `platinum-kaizo-trainer-${suffix}`;

test("PK released standalone encounters use mandatory Doubles, while later Cyrus stays Single", () => {
  const navigation = dataset.trainerGroups().flatMap(group => group.trainers.map(trainer => trainer.id));
  for (const suffix of ["0416", "0927", "0320", "0166", "0944", "0951", "0959", "0961"]) {
    assert.ok(navigation.includes(id(suffix)), suffix);
    assert.equal(dataset.trainerBattleFormat(id(suffix)), "doubles", suffix);
    const choices = dataset.trainerBattleChoices(id(suffix));
    assert.equal(choices.length, 1, suffix);
    assert.equal(choices[0].format, "doubles", suffix);
    assert.equal(choices[0].battleKind, "double", suffix);
    assert.equal(choices[0].locked, true, suffix);
  }
  assert.equal(dataset.trainerBattleFormat(id("0960")), "singles");
  assert.equal(dataset.trainerBattleChoices(id("0960"))[0].format, "singles");
});

test("PK occurrence optionality is separate from mandatory battle format", () => {
  const records = documents["trainer_order.json"].records;
  assert.equal(records.length, 389);
  assert.equal(records.filter(row => row.mandatory === true).length, 321);
  assert.equal(records.filter(row => row.mandatory === false).length, 68);
  const formats = records.map(row => dataset.trainerBattleFormat(row.trainerId));
  assert.equal(formats.filter(format => format === "singles").length, 278);
  assert.equal(formats.filter(format => format === "doubles").length, 111);
});

test("PK retains every Multi group and player partner with per-trainer roster ownership", () => {
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(new URL("trainer_battle_groups.json", root))).digest("hex"),
    "d702410915d11f42c624a225c44817f0b330c71139d5576f82beed02f0bc71bd",
    "The reviewed group/partner contract must remain byte-identical"
  );
  const groups = documents["trainer_battle_groups.json"];
  assert.equal(Object.keys(groups.records).length, 69);
  assert.equal(groups.playerPartners.bindings.length, 43);
  for (const group of Object.values(groups.records)) {
    assert.equal(dataset.trainerBattleFormat(group.id), "doubles");
    assert.equal(dataset.trainerBattleChoices(group.id)[0].battleKind, "multi");
    assert.ok(normalizeTrainerRoster(group.id, null, dataset).every(mon => mon.source.partyOwnerId));
  }
  for (const binding of groups.playerPartners.bindings) {
    const trainer = dataset.trainer(binding.enemyTrainerIds.length === 2 ? binding.id : binding.enemyTrainerIds[0]);
    assert.equal(trainer.playerPartnerBinding.id, binding.id);
    for (const option of binding.partnerOptions) {
      assert.ok(normalizePlayerPartnerRoster(option.trainerId, dataset).length);
    }
  }
});
