import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pokemonAssetAppearanceId, pokemonAssetQuery } from "../src/adapters/pokemon_assets.js";
import { createCombatantState } from "../src/core/plan.js";

function dataset(records) {
  const species = new Map(Object.entries(records));
  return { get: (kind, id) => kind === "species" ? species.get(String(id)) || null : null };
}

const here = path.dirname(fileURLToPath(import.meta.url));

test("runtime species asset IDs inherit a standardized mechanics identity", () => {
  const context = dataset({
    ninetalesa: {
      id: "ninetalesa",
      name: "Ninetales A",
      mechanicsBase: "Ninetales-Alola",
    },
  });
  const record = { speciesId: "ninetalesa", formId: "ninetalesa", spriteId: "ninetalesa", gender: "female", shiny: true };
  assert.equal(pokemonAssetAppearanceId(record, context), "ninetales-alola");
  assert.deepEqual(pokemonAssetQuery(record, context), {
    appearanceId: "ninetales-alola",
    gender: "female",
    shiny: true,
    view: "front",
    spriteType: "g5-animated",
    fallbackSpriteTypes: ["g5-static", "pixel"]
  });
});

test("dynamic runtime asset IDs remain available when they are not Dataset species IDs", () => {
  const context = dataset({
    cherrim: { id: "cherrim", name: "Cherrim", mechanicsBase: "Cherrim" },
  });
  assert.equal(pokemonAssetAppearanceId({
    speciesId: "cherrim",
    formId: "cherrim",
    spriteId: "cherrim-sunshine",
  }, context), "cherrim-sunshine");
});

test("raw numeric form ordinals fall back to the canonical form species", () => {
  const context = dataset({
    rotomfrost: {
      id: "rotomfrost",
      name: "Rotom - Frost",
      mechanicsBase: "Rotom-Frost",
    },
  });
  assert.equal(pokemonAssetAppearanceId({
    speciesId: "rotomfrost",
    formId: "3",
    spriteId: "3",
  }, context), "rotom-frost");
});

test("new battle state keeps canonical species identity separate from a raw form ordinal", () => {
  const state = createCombatantState({
    combatantKey: "enemy:rotom-frost",
    speciesId: "rotomfrost",
    formId: "3",
    displayName: "Rotom-Frost",
    level: 50,
    calculatedStats: { hp: 100 },
    originalAbilityId: "levitate",
    originalItemId: null,
    originalTypeIds: ["electric", "ice"],
    moves: [],
  });
  assert.equal(state.currentSpeciesId, "rotomfrost");
  assert.equal(state.currentSpriteId, "rotomfrost");
});

test("numeric Dataset graphics slots do not replace canonical asset identities", () => {
  const context = dataset({
    charizardmegax: {
      id: "charizardmegax",
      name: "Charizard-Mega-X",
      spriteId: 1007,
      mechanicsBase: "Charizard-Mega-X",
    },
  });
  assert.equal(pokemonAssetAppearanceId({
    speciesId: "charizardmegax",
    spriteId: 1007,
  }, context), "charizard-mega-x");
});

test("every enabled Dataset species and form produces a named asset identity", () => {
  const generatedRoot = path.join(here, "..", "src", "generated", "datasets");
  let checked = 0;
  for (const gameId of fs.readdirSync(generatedRoot)) {
    const speciesPath = path.join(generatedRoot, gameId, "species.json");
    if (!fs.existsSync(speciesPath)) continue;
    const records = JSON.parse(fs.readFileSync(speciesPath, "utf8")).records;
    const context = dataset(records);
    for (const record of Object.values(records)) {
      const appearanceId = pokemonAssetAppearanceId({
        speciesId: record.id,
        formId: record.formId,
        spriteId: record.spriteId,
      }, context);
      assert.ok(appearanceId, `${gameId}:${record.id} has an asset identity`);
      assert.doesNotMatch(appearanceId, /^\d+$/, `${gameId}:${record.id} does not expose a ROM graphics slot as an asset identity`);
      checked += 1;
    }
  }
  assert.ok(checked > 3_000, `audited ${checked} generated species records`);
});
