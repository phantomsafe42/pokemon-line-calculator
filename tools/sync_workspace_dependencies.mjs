import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const datasetRoot = path.resolve(workspaceRoot, "Datasets");
const datasetLockPath = path.resolve(projectRoot, "dataset-lock.json");
const mode = process.argv.includes("--sync") ? "sync" : process.argv.includes("--check") ? "check" : null;
const workspaceDataset = process.argv.includes("--workspace-dataset");

if (!mode || process.argv.filter(argument => argument === "--sync" || argument === "--check").length !== 1) {
  throw new Error("Use exactly one mode: --sync or --check");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function gitRevision(revision) {
  return execFileSync("git", ["-C", datasetRoot, "rev-parse", revision], {
    encoding: "utf8",
    windowsHide: true
  }).trim();
}

function gitStatus(paths) {
  return execFileSync("git", ["-C", datasetRoot, "status", "--porcelain=v1", "--", ...paths], {
    encoding: "utf8",
    windowsHide: true
  }).trim();
}

function datasetExportInputs(profileId) {
  const config = readJson(path.join(datasetRoot, "consumer_exports.json"));
  const profile = config.profiles?.[profileId];
  if (!profile || !Array.isArray(profile.bundles) || !profile.bundles.length) {
    throw new Error(`Dataset export profile ${profileId} is unavailable`);
  }
  return ["consumer_exports.json", ...profile.bundles.flatMap(bundle => bundle.files.map(entry => {
    const sourcePath = typeof entry === "string" ? entry : entry.source;
    return path.posix.join(String(bundle.source).replaceAll("\\", "/"), sourcePath).replace(/^\.\//u, "");
  }))];
}

function verifyDatasetSource() {
  if (!fs.existsSync(datasetLockPath)) throw new Error("Missing dataset-lock.json");
  if (!fs.existsSync(path.join(datasetRoot, ".git"))) throw new Error("Datasets must be an independent Git checkout");
  const lock = readJson(datasetLockPath);
  if (lock.schemaVersion !== "plc-dataset-lock/v1") throw new Error("Unsupported Dataset lock schema");
  if (lock.repository !== "phantomsafe42/pokemon-datasets" || lock.profile !== "plc") throw new Error("Unexpected Dataset release lock");
  const release = readJson(path.join(datasetRoot, "dataset_release.json"));
  if (release.version !== lock.releaseVersion) throw new Error("Dataset release version differs from dataset-lock.json");
  const commit = gitRevision("HEAD");
  if (!workspaceDataset && commit !== lock.commit) throw new Error(`Dataset checkout is ${commit}; PLC is pinned to ${lock.commit}`);
  if (!workspaceDataset && gitRevision(`${lock.tag}^{commit}`) !== lock.commit) throw new Error(`Dataset tag ${lock.tag} does not resolve to its locked commit`);
  const modifiedExportInputs = gitStatus(datasetExportInputs(lock.profile));
  if (!workspaceDataset && modifiedExportInputs) {
    throw new Error("Allowlisted Dataset export inputs differ from the pinned release. Use --workspace-dataset only for an explicit local authority cutover.");
  }
  return {
    lock,
    sourceMode: workspaceDataset ? "local-workspace" : "immutable-release",
    baseCommit: commit,
    modifiedExportInputs: modifiedExportInputs ? modifiedExportInputs.split(/\r?\n/u) : []
  };
}

const datasetFiles = Object.freeze([
  "dataset_manifest.json",
  "battle_mechanics.json",
  "experience_mechanics.json",
  "species.json",
  "moves.json",
  "abilities.json",
  "items.json",
  "natures.json",
  "types.json",
  "trainers.json",
  "trainer_order.json",
  "trainer_battle_groups.json",
  "progression.json",
  "evolutions.json",
  "save_id_maps.json"
]);

const datasetCandidates = Object.freeze([
  { consumer: "plc-fro-dataset", gameId: "fire-red-omega", sourceName: "Fire Red Omega" },
  { consumer: "plc-unbound-dataset", gameId: "pokemon-unbound", sourceName: "Pokemon Unbound" },
  { consumer: "plc-pk-dataset", gameId: "platinum-kaizo", sourceName: "Platinum Kaizo" },
  { consumer: "plc-rp-dataset", gameId: "renegade-platinum", sourceName: "Renegade Platinum" },
  { consumer: "plc-ss-dataset", gameId: "storm-silver", sourceName: "Storm Silver" },
  { consumer: "plc-vw2r-dataset", gameId: "volt-white-2r", sourceName: "Volt White 2R" },
  { consumer: "plc-ruby-dataset", gameId: "pokemon-ruby", sourceName: "Pokemon Ruby" },
  { consumer: "plc-sapphire-dataset", gameId: "pokemon-sapphire", sourceName: "Pokemon Sapphire" },
  { consumer: "plc-emerald-dataset", gameId: "pokemon-emerald", sourceName: "Pokemon Emerald" },
  { consumer: "plc-firered-dataset", gameId: "pokemon-firered", sourceName: "Pokemon FireRed" },
  { consumer: "plc-leafgreen-dataset", gameId: "pokemon-leafgreen", sourceName: "Pokemon LeafGreen" },
  { consumer: "plc-diamond-dataset", gameId: "pokemon-diamond", sourceName: "Pokemon Diamond" },
  { consumer: "plc-pearl-dataset", gameId: "pokemon-pearl", sourceName: "Pokemon Pearl" },
  { consumer: "plc-platinum-dataset", gameId: "pokemon-platinum", sourceName: "Pokemon Platinum" },
  { consumer: "plc-heartgold-dataset", gameId: "pokemon-heartgold", sourceName: "Pokemon HeartGold" },
  { consumer: "plc-soulsilver-dataset", gameId: "pokemon-soulsilver", sourceName: "Pokemon SoulSilver" },
  { consumer: "plc-black-dataset", gameId: "pokemon-black", sourceName: "Pokemon Black" },
  { consumer: "plc-white-dataset", gameId: "pokemon-white", sourceName: "Pokemon White" },
  { consumer: "plc-black-2-dataset", gameId: "pokemon-black-2", sourceName: "Pokemon Black 2" },
  { consumer: "plc-white-2-dataset", gameId: "pokemon-white-2", sourceName: "Pokemon White 2" }
]);

function datasetCandidateReady(candidate) {
  const sourceRoot = path.resolve(workspaceRoot, "Datasets", candidate.sourceName, "source-data");
  return datasetFiles.every(file => fs.existsSync(path.join(sourceRoot, file)));
}

const pendingDatasetCandidates = datasetCandidates.filter(candidate => !datasetCandidateReady(candidate));
const datasetProfiles = datasetCandidates.filter(datasetCandidateReady).map(candidate => ({
  consumer: candidate.consumer,
  schemaVersion: "plc-generated-dataset/v1alpha1",
  source: `Datasets/${candidate.sourceName}/source-data`,
  target: `src/generated/datasets/${candidate.gameId}`,
  manifest: "dataset.generated.json",
  files: datasetFiles
}));
const datasetSource = verifyDatasetSource();

const profiles = [
  ...datasetProfiles,
  {
    consumer: "plc-battle-mechanics",
    schemaVersion: "plc-generated-battle-mechanics/v1alpha1",
    source: "Battle Mechanics",
    target: "src/generated/battle-mechanics",
    manifest: "battle-mechanics.generated.json",
    files: [
      "shared_damage_calculator.js",
      "trainer_ai/trainer_ai_evaluator.js",
      "vendor/smogon-calc-0.11.0/data.production.min.js",
      "vendor/smogon-calc-0.11.0/engine.production.min.js",
      "vendor/smogon-calc-0.11.0/LICENSE",
      "vendor/smogon-calc-0.11.0/README.md"
    ]
  },
  {
    consumer: "plc-trainer-ai",
    schemaVersion: "plc-generated-trainer-ai/v1alpha1",
    source: "Datasets",
    target: "src/generated/trainer-ai",
    manifest: "trainer-ai.generated.json",
    files: [
      { source: "Volt White 2R/source-data/trainer_ai.json", path: "volt-white-2r/trainer_ai.json" },
      { source: "Gen 5/source-data/trainer_ai.json", path: "gen5/trainer_ai.json" },
      { source: "Gen 5/source-data/trainer_ai_engine_semantics.json", path: "gen5/trainer_ai_engine_semantics.json" },
      { source: "Fire Red Omega/source-data/trainer_ai.json", path: "fire-red-omega/trainer_ai.json" },
      { source: "Pokemon Unbound/source-data/trainer_ai.json", path: "pokemon-unbound/trainer_ai.json" },
      { source: "Storm Silver/source-data/trainer_ai.json", path: "storm-silver/trainer_ai.json" },
      { source: "Renegade Platinum/source-data/trainer_ai.json", path: "renegade-platinum/trainer_ai.json" },
      { source: "Platinum Kaizo/source-data/trainer_ai.json", path: "platinum-kaizo/trainer_ai.json" },
      { source: "Gen 3/source-data/trainer_ai.json", path: "gen3/trainer_ai.json" },
      { source: "Gen 4/source-data/trainer_ai.json", path: "gen4/trainer_ai.json" }
    ]
  }
];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
      else throw new Error(`Unsupported generated entry ${absolute}`);
    }
  };
  visit(root);
  return files.sort();
}

function expectedProfile(profile) {
  const sourceRoot = path.resolve(workspaceRoot, profile.source);
  const targetRoot = path.resolve(projectRoot, profile.target);
  if (!inside(sourceRoot, workspaceRoot) || !inside(targetRoot, projectRoot)) throw new Error(`Unsafe profile ${profile.consumer}`);
  const files = profile.files.map(entry => {
    const sourcePath = typeof entry === "string" ? entry : entry.source;
    const relativePath = typeof entry === "string" ? entry : entry.path;
    const sourceFile = path.resolve(sourceRoot, sourcePath);
    if (!inside(sourceFile, sourceRoot) || !fs.existsSync(sourceFile)) throw new Error(`Missing authoritative file ${profile.source}/${sourcePath}`);
    const bytes = fs.readFileSync(sourceFile);
    return { path: relativePath, sourcePath, bytes, size: bytes.byteLength, sha256: sha256(bytes) };
  });
  const sourceTreeSha256 = sha256(files.map(file => {
    const identity = file.sourcePath === file.path
      ? file.path
      : `${file.sourcePath}\0${file.path}`;
    return `${identity}\0${file.sha256}\n`;
  }).join(""));
  const generatedManifest = {
    schemaVersion: profile.schemaVersion,
    consumer: profile.consumer,
    source: profile.source.replaceAll("\\", "/"),
    sourceTreeSha256,
    files: files.map(({ path: filePath, sourcePath, size, sha256: digest }) => ({
      path: filePath,
      ...(sourcePath !== filePath ? { sourcePath } : {}),
      bytes: size,
      sha256: digest
    }))
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(generatedManifest, null, 2)}\n`);
  return { ...profile, sourceRoot, targetRoot, files, generatedManifest, manifestBytes };
}

function verify(expected) {
  const allowed = new Set([...expected.files.map(file => file.path), expected.manifest]);
  const actual = listFiles(expected.targetRoot);
  const extras = actual.filter(relativePath => !allowed.has(relativePath));
  const missing = [...allowed].filter(relativePath => !actual.includes(relativePath));
  if (extras.length || missing.length) {
    throw new Error(`${expected.consumer} generated tree differs (missing: ${missing.join(", ") || "none"}; extras: ${extras.join(", ") || "none"})`);
  }
  for (const file of expected.files) {
    const actualBytes = fs.readFileSync(path.join(expected.targetRoot, file.path));
    if (!actualBytes.equals(file.bytes)) throw new Error(`${expected.consumer} copy is stale or edited: ${file.path}`);
  }
  const actualManifest = fs.readFileSync(path.join(expected.targetRoot, expected.manifest));
  if (!actualManifest.equals(expected.manifestBytes)) throw new Error(`${expected.consumer} manifest is stale or edited`);
}

function sync(expected) {
  const allowed = new Set([...expected.files.map(file => file.path), expected.manifest]);
  const extras = listFiles(expected.targetRoot).filter(relativePath => !allowed.has(relativePath));
  if (extras.length) throw new Error(`Refusing to overwrite unexpected ${expected.consumer} files: ${extras.join(", ")}`);
  fs.mkdirSync(expected.targetRoot, { recursive: true });
  for (const file of expected.files) {
    const destination = path.resolve(expected.targetRoot, file.path);
    if (!inside(destination, expected.targetRoot)) throw new Error(`Unsafe output ${file.path}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.bytes);
  }
  fs.writeFileSync(path.join(expected.targetRoot, expected.manifest), expected.manifestBytes);
  verify(expected);
}

const results = [];
for (const profile of profiles) {
  const expected = expectedProfile(profile);
  if (mode === "sync") sync(expected);
  else verify(expected);
  results.push({ consumer: profile.consumer, files: profile.files.length, sourceTreeSha256: expected.generatedManifest.sourceTreeSha256 });
}

console.log(JSON.stringify({
  status: mode === "sync" ? "generated" : "current",
  datasetRelease: {
    sourceMode: datasetSource.sourceMode,
    repository: datasetSource.lock.repository,
    tag: datasetSource.lock.tag,
    commit: datasetSource.baseCommit,
    releaseVersion: datasetSource.lock.releaseVersion,
    profile: datasetSource.lock.profile,
    synchronizedBundles: datasetProfiles.length + 1,
    intentionallyExcludedBundles: ["datasets/radical-red"],
    modifiedExportInputs: datasetSource.modifiedExportInputs
  },
  profiles: results,
  pendingDatasets: pendingDatasetCandidates.map(candidate => candidate.gameId)
}, null, 2));
