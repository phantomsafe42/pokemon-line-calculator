import { createDatasetContext } from "../src/adapters/standardized_dataset.js";
import { normalizePlayerCollection, normalizeTrainerRoster, snapshotFingerprint } from "../src/adapters/combatant_ingest.js";
import { createPlanDocument } from "../src/core/plan.js";

const stats = value => ({ hp: value, atk: value, def: value, spa: value, spd: value, spe: value });
const source = (kind, records) => ({ schemaVersion: 1, gameId: "fixture", kind, records });

export function fixtureDataset() {
  const documents = {
    "species.json": source("species", {
      fastmon: { id: "fastmon", name: "Fastmon", baseStats: { hp: 90, atk: 100, def: 90, spa: 80, spd: 90, spe: 120 }, types: ["water"] },
      benchmon: { id: "benchmon", name: "Benchmon", baseStats: { hp: 100, atk: 90, def: 100, spa: 80, spd: 100, spe: 80 }, types: ["normal"] },
      slowmon: { id: "slowmon", name: "Slowmon", baseStats: { hp: 90, atk: 100, def: 90, spa: 80, spd: 90, spe: 60 }, types: ["normal"] },
      keldeo: { id: "keldeo", name: "Keldeo", baseStats: { hp: 91, atk: 72, def: 90, spa: 129, spd: 90, spe: 108 }, types: ["water", "fighting"] }
    }),
    "moves.json": source("moves", {
      tackle: { id: "tackle", name: "Tackle", calcName: "Tackle", type: "normal", category: "physical", basePower: 50, accuracy: 100, pp: 35, priority: 0 },
      earthquake: { id: "earthquake", name: "Earthquake", calcName: "Earthquake", type: "ground", category: "physical", basePower: 100, accuracy: 100, pp: 10, priority: 0, target: "allAdjacent" },
      surf: { id: "surf", name: "Surf", calcName: "Surf", type: "water", category: "special", basePower: 95, accuracy: 100, pp: 15, priority: 0, target: "allAdjacentFoes" },
      aquajet: { id: "aquajet", name: "Aqua Jet", calcName: "Aqua Jet", type: "water", category: "physical", basePower: 40, accuracy: 100, pp: 20, priority: 1 },
      irondefense: { id: "irondefense", name: "Iron Defense", calcName: "Iron Defense", type: "steel", category: "status", basePower: 0, accuracy: true, pp: 15, priority: 0 },
      recover: { id: "recover", name: "Recover", calcName: "Recover", type: "normal", category: "status", basePower: 0, accuracy: true, pp: 10, priority: 0 },
      revenge: { id: "revenge", name: "Revenge", calcName: "Revenge", type: "fighting", category: "physical", basePower: 60, accuracy: 100, pp: 10, priority: -4 },
      protect: { id: "protect", name: "Protect", calcName: "Protect", type: "normal", category: "status", basePower: 0, accuracy: true, pp: 10, priority: 4 },
      willowisp: { id: "willowisp", name: "Will-O-Wisp", calcName: "Will-O-Wisp", type: "fire", category: "status", basePower: 0, accuracy: 85, pp: 15, priority: 0 },
      toxic: { id: "toxic", name: "Toxic", calcName: "Toxic", type: "poison", category: "status", basePower: 0, accuracy: 90, pp: 10, priority: 0 },
      thunderwave: { id: "thunderwave", name: "Thunder Wave", calcName: "Thunder Wave", type: "electric", category: "status", basePower: 0, accuracy: 90, pp: 20, priority: 0 },
      raindance: { id: "raindance", name: "Rain Dance", calcName: "Rain Dance", type: "water", category: "status", basePower: 0, accuracy: true, pp: 5, priority: 0 },
      sunnyday: { id: "sunnyday", name: "Sunny Day", calcName: "Sunny Day", type: "fire", category: "status", basePower: 0, accuracy: true, pp: 5, priority: 0 },
      sandstorm: { id: "sandstorm", name: "Sandstorm", calcName: "Sandstorm", type: "rock", category: "status", basePower: 0, accuracy: true, pp: 10, priority: 0 },
      hail: { id: "hail", name: "Hail", calcName: "Hail", type: "ice", category: "status", basePower: 0, accuracy: true, pp: 10, priority: 0 },
      crunch: { id: "crunch", name: "Crunch", calcName: "Crunch", type: "dark", category: "physical", basePower: 80, accuracy: 100, pp: 15, priority: 0 }
    }),
    "abilities.json": source("abilities", { pressure: { id: "pressure", name: "Pressure" } }),
    "items.json": source("items", {}),
    "natures.json": source("natures", {
      hardy: { id: "hardy", name: "Hardy", boostedStat: "atk", nerfedStat: "atk" },
      timid: { id: "timid", name: "Timid", boostedStat: "spe", nerfedStat: "atk" }
    }),
    "types.json": source("types", {
      normal: { id: "normal", name: "Normal", weak: [], resist: [], immune: [] },
      water: { id: "water", name: "Water", weak: [], resist: [], immune: [] },
      fighting: { id: "fighting", name: "Fighting", weak: [], resist: [], immune: [] },
      dark: { id: "dark", name: "Dark", weak: [], resist: [], immune: [] },
      steel: { id: "steel", name: "Steel", weak: [], resist: [], immune: [] },
      fire: { id: "fire", name: "Fire", weak: [], resist: [], immune: [] },
      poison: { id: "poison", name: "Poison", weak: [], resist: [], immune: [] },
      electric: { id: "electric", name: "Electric", weak: [], resist: [], immune: [] },
      rock: { id: "rock", name: "Rock", weak: [], resist: [], immune: [] },
      ice: { id: "ice", name: "Ice", weak: [], resist: [], immune: [] },
      grass: { id: "grass", name: "Grass", weak: [], resist: [], immune: [] }
      ,ground: { id: "ground", name: "Ground", weak: [], resist: [], immune: [] }
    }),
    "trainers.json": source("trainers", {
      trainer: {
        id: "trainer",
        consumerTrainerId: 7,
        displayName: "Fixture Trainer",
        team: [
          { slot: 1, speciesId: "slowmon", displaySpecies: "Slowmon", level: 50, abilityId: "pressure", itemId: null, natureId: "hardy", ivs: stats(31), evs: stats(0), moveIds: ["tackle"] },
          { slot: 2, speciesId: "benchmon", displaySpecies: "Benchmon", level: 50, abilityId: "pressure", itemId: null, natureId: "hardy", ivs: stats(31), evs: stats(0), moveIds: ["tackle"] }
        ]
      },
      doubles: {
        id: "doubles",
        consumerTrainerId: 9,
        displayName: "Fixture Doubles Trainer",
        battleProfiles: { challenge: { format: "double" } },
        team: [
          { slot: 1, speciesId: "slowmon", displaySpecies: "Slowmon A", level: 50, abilityId: "pressure", itemId: null, natureId: "hardy", ivs: stats(31), evs: stats(0), moveIds: ["tackle", "protect"] },
          { slot: 2, speciesId: "slowmon", displaySpecies: "Slowmon B", level: 50, abilityId: "pressure", itemId: null, natureId: "hardy", ivs: stats(31), evs: stats(0), moveIds: ["tackle", "protect"] },
          { slot: 3, speciesId: "benchmon", displaySpecies: "Enemy Bench A", level: 50, abilityId: "pressure", itemId: null, natureId: "hardy", ivs: stats(31), evs: stats(0), moveIds: ["tackle"] },
          { slot: 4, speciesId: "benchmon", displaySpecies: "Enemy Bench B", level: 50, abilityId: "pressure", itemId: null, natureId: "hardy", ivs: stats(31), evs: stats(0), moveIds: ["tackle"] }
        ]
      },
      combined: {
        id: "combined",
        consumerTrainerId: 8,
        displayName: "Combined Trainer",
        team: [{ slot: 1, speciesId: "slowmon", displaySpecies: "Slowmon", level: 50, abilityId: "pressure", itemId: null, natureId: null, ivs: stats(31), evs: stats(0), moveIds: ["tackle"] }],
        mechanicsVariants: [
          { id: "final-rom-trainer-10", finalRomTrainerId: 10, team: [{ slot: 1, natureId: "hardy", ivs: stats(30), evs: stats(0), moveIds: ["tackle"] }] },
          { id: "final-rom-trainer-11", finalRomTrainerId: 11, team: [{ slot: 1, natureId: "timid", ivs: stats(31), evs: stats(0), moveIds: ["tackle"] }] }
        ]
      }
    }),
    "trainer_order.json": source("trainer-order", [
      { order: 1, trainerId: "trainer", splitId: "first" },
      { order: 2, trainerId: "combined", splitId: "first" },
      { order: 3, trainerId: "doubles", splitId: "second" }
    ]),
    "progression.json": {
      schemaVersion: 1,
      gameId: "fixture",
      kind: "progression",
      consumerProfile: {
        splits: [
          { id: "first", label: "First", firstOrder: 1, lastOrder: 2, levelCap: 50 },
          { id: "second", label: "Second", firstOrder: 3, lastOrder: 3, levelCap: 60 }
        ]
      }
    },
    "save_id_maps.json": source("save-id-maps", {
      species: { byNumericId: {}, byCanonicalId: {} },
      moves: { byNumericId: {}, byCanonicalId: {} },
      abilities: { byNumericId: {}, byCanonicalId: {} },
      items: { byNumericId: {}, byCanonicalId: {} },
      natures: { byNumericId: {}, byCanonicalId: {} }
    })
  };
  const mechanics = {
    schemaVersion: 1,
    gameId: "fixture",
    kind: "battle-mechanics",
    engine: { id: "smogon-calc", version: "0.11.0" },
    damageGeneration: 5,
    canonicalDataGeneration: 9,
    mechanicsProfile: "fixture-v1",
    trainerBattleProfile: "challenge",
    features: { playerEvGainDisabled: true },
    validation: { status: "passed", unresolved: 0, sourceFiles: Object.keys(documents) }
  };
  return createDatasetContext({ manifest: { schemaVersion: 1, gameId: "fixture", displayName: "Fixture" }, mechanics, documents });
}

export function fixturePlan() {
  const dataset = fixtureDataset();
  const players = normalizePlayerCollection({
    collection: [
      { uniqueKey: "fast", speciesId: "fastmon", species: "Fastmon", displayName: "Fastmon", level: 50, nature: "Hardy", ability: "Pressure", item: null, ivs: { hp: 31, at: 31, df: 31, sa: 31, sd: 31, sp: 31 }, moves: ["aqua jet", "tackle", "iron defense", "revenge"], storage: "party", slot: 1 },
      { uniqueKey: "bench", speciesId: "benchmon", species: "Benchmon", displayName: "Benchmon", level: 50, nature: "Hardy", ability: "Pressure", item: null, ivs: stats(31), moves: ["tackle"], storage: "party", slot: 2 }
    ]
  }, dataset);
  const enemies = normalizeTrainerRoster("trainer", null, dataset);
  const sourceSnapshot = snapshotFingerprint(players, enemies, "2026-08-23T00:00:00.000Z");
  const plan = createPlanDocument({ dataset, trainerId: "trainer", playerCombatants: players, enemyCombatants: enemies, sourceSnapshot, now: "2026-08-23T00:00:00.000Z" });
  return { dataset, players, enemies, plan };
}

export function fixtureDoublesPlan() {
  const dataset = fixtureDataset();
  const players = normalizePlayerCollection({
    collection: [
      { uniqueKey: "fast-a", speciesId: "fastmon", species: "Fastmon", displayName: "Fast A", level: 50, nature: "Hardy", ability: "Pressure", item: null, ivs: stats(31), moves: ["aqua jet", "tackle", "earthquake", "protect"], storage: "party", slot: 1 },
      { uniqueKey: "fast-b", speciesId: "fastmon", species: "Fastmon", displayName: "Fast B", level: 50, nature: "Hardy", ability: "Pressure", item: null, ivs: stats(31), moves: ["surf", "tackle", "iron defense", "protect"], storage: "party", slot: 2 },
      { uniqueKey: "bench-a", speciesId: "benchmon", species: "Benchmon", displayName: "Bench A", level: 50, nature: "Hardy", ability: "Pressure", item: null, ivs: stats(31), moves: ["tackle"], storage: "party", slot: 3 },
      { uniqueKey: "bench-b", speciesId: "benchmon", species: "Benchmon", displayName: "Bench B", level: 50, nature: "Hardy", ability: "Pressure", item: null, ivs: stats(31), moves: ["tackle"], storage: "party", slot: 4 }
    ]
  }, dataset);
  const enemies = normalizeTrainerRoster("doubles", null, dataset);
  const sourceSnapshot = snapshotFingerprint(players, enemies, "2026-08-24T00:00:00.000Z");
  const plan = createPlanDocument({ dataset, trainerId: "doubles", playerCombatants: players, enemyCombatants: enemies, sourceSnapshot, now: "2026-08-24T00:00:00.000Z" });
  return { dataset, players, enemies, plan };
}

export function damageAdapter(fn) {
  return { calculate: input => ({ status: "ok", damage: fn(input) }) };
}
