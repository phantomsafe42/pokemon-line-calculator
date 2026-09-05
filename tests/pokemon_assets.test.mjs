import assert from "node:assert/strict";
import test from "node:test";

import { pokemonAssetAppearanceId, pokemonAssetQuery } from "../src/adapters/pokemon_assets.js";

function dataset(records) {
  const species = new Map(Object.entries(records));
  return { get: (kind, id) => kind === "species" ? species.get(String(id)) || null : null };
}

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
