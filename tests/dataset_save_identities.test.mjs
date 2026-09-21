import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createDatasetContext, REQUIRED_DATASET_SOURCES } from "../src/adapters/standardized_dataset.js";
import { normalizePlayerCollection } from "../src/adapters/combatant_ingest.js";
import { fireRedInternalSpeciesToNational } from "../src/generated/save-mechanics/adapters/src/gba/fire-red-omega.js";
import { createStandardizedSaveContext } from "../src/generated/save-mechanics/adapters/src/standardized-context.js";
import {
  createDocumentSaveIdentityDataset,
  createStandardizedSaveIdentityResolver,
} from "../src/generated/save-mechanics/adapters/src/identity/standardized-save-identity.js";

function loadDataset(gameId) {
  const read = file => JSON.parse(fs.readFileSync(new URL(`../src/generated/datasets/${gameId}/${file}`, import.meta.url), "utf8"));
  return createDatasetContext({
    manifest: read("dataset_manifest.json"),
    mechanics: read("battle_mechanics.json"),
    documents: Object.fromEntries(REQUIRED_DATASET_SOURCES.map(file => [file, read(file)])),
  });
}

const fro = loadDataset("fire-red-omega");
const froSave = createStandardizedSaveContext(fro);

test("FRO raw save IDs pass through the pinned parser's National Dex conversion before Dataset lookup", () => {
  // Independent known answers: neither calculator ordering nor raw IDs are
  // interchangeable with the normalized namespace supplied by this adapter.
  for (const [raw, national, id] of [
    [301, 290, "nincada"], [302, 291, "ninjask"], [303, 292, "shedinja"],
    [304, 276, "taillow"], [305, 277, "swellow"], [306, 285, "shroomish"],
  ]) {
    assert.equal(fireRedInternalSpeciesToNational(raw), national);
    const species = froSave.resolveSpeciesIdentity(national);
    assert.equal(species.id, id, `raw ${raw}`);
    assert.equal(species.nationalDex, national);
    assert.equal(species.saveIdentity.speciesNum, national);
    assert.equal(species.romId, raw);
  }
});

test("every declared FRO raw identity agrees with the actual pinned parser and normalized resolver", () => {
  const maps = fro.documents["save_id_maps.json"].records.species;
  assert.equal(maps.numericNamespace, "national-dex-after-save-adapter-decoding");
  const entries = Object.entries(maps.byRawInternalId);
  assert.equal(entries.length, 386);
  for (const [raw, id] of entries) {
    const national = fireRedInternalSpeciesToNational(Number(raw));
    const species = froSave.resolveSpeciesIdentity(national);
    assert.equal(species.id, id, `raw ${raw} -> national ${national}`);
    assert.equal(species.nationalDex, national);
    assert.equal(maps.byNumericId[String(national)], id);
  }
});

const vw2r = loadDataset("volt-white-2r");
const identity = createStandardizedSaveIdentityResolver(createDocumentSaveIdentityDataset({
  manifest: vw2r.manifest,
  species: vw2r.documents["species.json"],
  abilities: vw2r.documents["abilities.json"],
  saveIdMaps: vw2r.documents["save_id_maps.json"],
}));
const addedForms = [
  ...Array.from("bcdefghijklmnopqrstuvwxyz", (letter, index) => [201, index + 1, `unown${letter}`]),
  [201, 26, "unownexclamation"], [201, 27, "unownquestion"],
  [421, 1, "cherrimsunshine"], [422, 1, "shelloseast"], [423, 1, "gastrodoneast"],
  [585, 1, "deerlingsummer"], [585, 2, "deerlingautumn"], [585, 3, "deerlingwinter"],
  [586, 1, "sawsbucksummer"], [586, 2, "sawsbuckautumn"], [586, 3, "sawsbuckwinter"],
];

test("all 36 released VW2R form identities resolve and remain distinct in PLC combatant ingestion", () => {
  // This exercises the shared compound resolver and PLC collection ingestion,
  // not DS byte decoding or the DS adapter's separate legacy form selection.
  assert.equal(addedForms.length, 36);
  const maps = vw2r.documents["save_id_maps.json"].records.species;
  const ivs = Object.fromEntries(["hp", "atk", "def", "spa", "spd", "spe"].map(stat => [stat, 31]));
  const evs = Object.fromEntries(Object.keys(ivs).map(stat => [stat, 0]));
  for (const [numericId, form, id] of addedForms) {
    assert.equal(maps.byNumericIdAndForm[numericId][form], id);
    const species = identity.resolveSpecies(numericId, { form });
    assert.equal(species.id, id);
    const [combatant] = normalizePlayerCollection([{
      speciesId: species.id, level: 30, nature: "Hardy", abilityId: species.abilities[0],
      ivs, evs, moves: ["tackle"],
    }], vw2r);
    assert.equal(combatant.speciesId, id);
    assert.equal(combatant.displayName, species.name);
    assert.ok(combatant.calculatedStats.hp > 0);
  }
});

test("VW2R compound lookup retains base form zero and falls back for unsupported raw forms", () => {
  const maps = vw2r.documents["save_id_maps.json"].records.species;
  for (const numericId of new Set(addedForms.map(([id]) => id))) {
    const base = maps.byNumericId[numericId];
    assert.equal(maps.byNumericIdAndForm[numericId][0], base);
    assert.equal(identity.resolveSpecies(numericId).id, base);
    assert.equal(identity.resolveSpecies(numericId, { form: 0 }).id, base);
    assert.equal(identity.resolveSpecies(numericId, { form: 255 }).id, base);
  }
});
