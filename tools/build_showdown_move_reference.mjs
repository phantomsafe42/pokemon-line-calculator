import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const generatedDatasetsRoot = path.join(projectRoot, "src", "generated", "datasets");
const outputFile = path.join(projectRoot, "src", "rulesets", "generated", "showdown_move_reference.js");
const expectedVersion = "0.11.11";
const packageIntegrity = "sha512-FdW7gt3TkG4AdXmpMTPYX2kx42VEfY8tQApjW9wEHOGzwH6Kn97wD0o5uIzAc4xpO1W+Tim70Ti9+FNkMNCA2w==";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toId(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function mergeInherited(base, override) {
  if (!override) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "inherit") continue;
    if (value === undefined) delete result[key];
    else if (isObject(value) && isObject(base?.[key])) result[key] = mergeInherited(base[key], value);
    else result[key] = value;
  }
  return result;
}

function callbackPaths(value, prefix = "", output = []) {
  if (typeof value === "function") {
    output.push(prefix);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    callbackPaths(child, prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function jsonSafe(value) {
  if (typeof value === "function" || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(jsonSafe).filter(entry => entry !== undefined);
  if (!isObject(value)) return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = jsonSafe(child);
    if (normalized !== undefined) output[key] = normalized;
  }
  return output;
}

const retainedFields = Object.freeze([
  "status",
  "volatileStatus",
  "sideCondition",
  "slotCondition",
  "pseudoWeather",
  "weather",
  "terrain",
  "boosts",
  "self",
  "secondary",
  "secondaries",
  "drain",
  "recoil",
  "multihit",
  "multiaccuracy",
  "selfSwitch",
  "forceSwitch",
  "heal",
  "willCrit",
  "critRatio",
  "breaksProtect",
  "flags",
  "target",
  "condition"
]);

function extractMove(move) {
  const output = {};
  for (const field of retainedFields) {
    const value = jsonSafe(move[field]);
    if (value !== undefined && (!isObject(value) || Object.keys(value).length)) output[field] = value;
  }
  const callbacks = [...new Set(callbackPaths(move))].sort();
  if (callbacks.length) output.callbacks = callbacks;
  return output;
}

const packageRoot = path.resolve(argument(
  "--showdown-package-root",
  path.join(projectRoot, ".codex-tmp", "showdown-npm", "package")
));
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
if (packageJson.name !== "pokemon-showdown" || packageJson.version !== expectedVersion) {
  throw new Error(`Expected pokemon-showdown ${expectedVersion}, found ${packageJson.name} ${packageJson.version}`);
}

const baseMoves = require(path.join(packageRoot, "dist", "data", "moves.js")).Moves;
const historicalMoveLayers = ["gen8", "gen7", "gen6", "gen5", "gen4", "gen3"].map(mod => ({
  mod,
  generation: Number(mod.slice(3)),
  moves: require(path.join(packageRoot, "dist", "data", "mods", mod, "moves.js")).Moves
}));

const lastMoveNumberByGeneration = Object.freeze({
  1: 165,
  2: 251,
  3: 354,
  4: 467,
  5: 559,
  6: 621,
  7: 728,
  8: 826
});

function canonicalMoveGeneration(move) {
  const moveNumber = Number(move?.num);
  for (let generation = 1; generation <= 8; generation += 1) {
    if (moveNumber <= lastMoveNumberByGeneration[generation]) return generation;
  }
  return 9;
}
const datasetProfiles = fs.existsSync(generatedDatasetsRoot)
  ? fs.readdirSync(generatedDatasetsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const root = path.join(generatedDatasetsRoot, entry.name);
      const movesFile = path.join(root, "moves.json");
      const mechanicsFile = path.join(root, "battle_mechanics.json");
      if (!fs.existsSync(movesFile) || !fs.existsSync(mechanicsFile)) return null;
      const moves = JSON.parse(fs.readFileSync(movesFile, "utf8")).records || {};
      const mechanics = JSON.parse(fs.readFileSync(mechanicsFile, "utf8"));
      return { gameId: mechanics.gameId, generation: Number(mechanics.damageGeneration), moves };
    })
    .filter(Boolean)
  : [];
if (!datasetProfiles.length) throw new Error("No generated PLC Dataset profiles are available for the Showdown move reference");

function resolveMoveForGeneration(id, canonical, generation) {
  if (canonicalMoveGeneration(canonical) > generation) return canonical;
  return historicalMoveLayers
    .filter(layer => layer.generation >= generation)
    .reduce((move, layer) => layer.moves[id] ? mergeInherited(move, layer.moves[id]) : move, canonical);
}

const recordsByGame = {};
const recordsByGeneration = {};
for (const profile of datasetProfiles) {
  if (![3, 4, 5].includes(profile.generation)) throw new Error(`${profile.gameId} declares unsupported damage generation ${profile.generation}`);
  const gameRecords = recordsByGame[profile.gameId] ||= {};
  const generationRecords = recordsByGeneration[profile.generation] ||= {};
  for (const [id, datasetMove] of Object.entries(profile.moves).sort(([left], [right]) => left.localeCompare(right))) {
    if (datasetMove.calculationApplicability === "inapplicable-unused-engine-slot") continue;
    const mechanicsBaseId = toId(datasetMove.mechanicsBase || id);
    const canonical = baseMoves[mechanicsBaseId];
    if (!canonical) throw new Error(`Showdown has no canonical move definition for ${profile.gameId}:${id} (mechanicsBase ${mechanicsBaseId || "missing"})`);
    const resolved = resolveMoveForGeneration(mechanicsBaseId, canonical, profile.generation);
    const introducedGeneration = canonicalMoveGeneration(canonical);
    const record = {
      canonicalMoveNumber: Number(canonical.num),
      mechanicsGeneration: introducedGeneration <= profile.generation ? profile.generation : introducedGeneration,
      ...extractMove(resolved)
    };
    gameRecords[id] = record;
    generationRecords[id] ||= record;
  }
}

const header = `// Generated by tools/build_showdown_move_reference.mjs. Do not edit by hand.\n`;
const body = `${header}export const SHOWDOWN_MOVE_REFERENCE_BY_GAME = Object.freeze(${JSON.stringify(recordsByGame, null, 2)});\n\nexport const SHOWDOWN_MOVE_REFERENCE_BY_GENERATION = Object.freeze(${JSON.stringify(recordsByGeneration, null, 2)});\n\nexport const SHOWDOWN_MOVE_REFERENCE = SHOWDOWN_MOVE_REFERENCE_BY_GAME["volt-white-2r"] || Object.freeze({});\n\nexport const SHOWDOWN_REFERENCE_SOURCE = Object.freeze(${JSON.stringify({
  package: `pokemon-showdown@${expectedVersion}`,
  integrity: packageIntegrity,
  games: datasetProfiles.map(profile => profile.gameId).sort(),
  moveCount: Object.keys(recordsByGeneration[5] || {}).length,
  moveCountsByGame: Object.fromEntries(Object.entries(recordsByGame).map(([gameId, records]) => [gameId, Object.keys(records).length])),
  moveCountsByGeneration: Object.fromEntries(Object.entries(recordsByGeneration).map(([generation, records]) => [generation, Object.keys(records).length])),
  policy: "Each standardized Dataset move resolves through its explicit mechanicsBase into the pinned Showdown historical mod stack at the game's declared damage generation. Game-scoped records prevent same-generation ROM hacks from overwriting one another; later backported moves retain their canonical structured definition while the selected Dataset remains authoritative for displayed move facts."
}, null, 2)});\n`;

if (process.argv.includes("--check")) {
  if (!fs.existsSync(outputFile) || fs.readFileSync(outputFile, "utf8") !== body) {
    throw new Error("Generated Showdown move reference is stale");
  }
  console.log(`Showdown move reference is current (${Object.values(recordsByGeneration).reduce((sum, records) => sum + Object.keys(records).length, 0)} generation-scoped definitions)`);
} else {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, body, "utf8");
  console.log(`Wrote ${path.relative(projectRoot, outputFile)} (${Object.values(recordsByGeneration).reduce((sum, records) => sum + Object.keys(records).length, 0)} generation-scoped definitions)`);
}
