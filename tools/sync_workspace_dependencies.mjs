import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const datasetRoot = path.resolve(workspaceRoot, "Datasets");
const battleRoot = path.resolve(workspaceRoot, "Battle Mechanics");
const generatedRoot = path.resolve(projectRoot, "src", "generated");
const datasetLockPath = path.resolve(projectRoot, "dataset-lock.json");
const mode = process.argv.includes("--sync") ? "sync" : process.argv.includes("--check") ? "check" : null;
const workspaceDataset = process.argv.includes("--workspace-dataset");

if (!mode || process.argv.filter(argument => argument === "--sync" || argument === "--check").length !== 1) {
  throw new Error("Use exactly one mode: --sync or --check");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function git(args, options = {}) {
  return execFileSync("git", ["-C", datasetRoot, ...args], { encoding: "utf8", windowsHide: true, ...options }).trim();
}

function resolveProfile(config, profileId, resolving = new Set()) {
  const profile = config.profiles?.[profileId];
  if (!profile) throw new Error(`Dataset export profile ${profileId} is unavailable`);
  if (resolving.has(profileId)) throw new Error(`Cyclic Dataset export profile inheritance at ${profileId}`);
  resolving.add(profileId);
  let bundles = profile.extends ? resolveProfile(config, profile.extends, resolving) : [];
  const excluded = new Set(profile.excludeConsumers || []);
  bundles = bundles.filter(bundle => !excluded.has(bundle.consumer));
  for (const bundle of profile.bundles || []) {
    const index = bundles.findIndex(candidate => candidate.consumer === bundle.consumer);
    if (index >= 0) bundles[index] = bundle;
    else bundles.push(bundle);
  }
  resolving.delete(profileId);
  if (!bundles.length) throw new Error(`Dataset export profile ${profileId} is empty`);
  return bundles;
}

function datasetExportInputs(profileId) {
  const config = readJson(path.join(datasetRoot, "consumer_exports.json"));
  return [
    "consumer_exports.json",
    "tools/export_consumer_bundle.js",
    ...resolveProfile(config, profileId).flatMap(bundle => bundle.files.map(entry => {
      const sourcePath = typeof entry === "string" ? entry : entry.source;
      return path.posix.join(String(bundle.source).replaceAll("\\", "/"), sourcePath).replace(/^\.\//u, "");
    }))
  ];
}

function verifyDatasetSource() {
  if (!fs.existsSync(datasetLockPath)) throw new Error("Missing dataset-lock.json");
  if (!fs.existsSync(path.join(datasetRoot, ".git"))) throw new Error("Datasets must be an independent Git checkout");
  const lock = readJson(datasetLockPath);
  if (lock.schemaVersion !== "plc-dataset-lock/v1") throw new Error("Unsupported Dataset lock schema");
  if (lock.repository !== "phantomsafe42/pokemon-datasets" || !["plc", "plc-public"].includes(lock.profile)) throw new Error("Unexpected Dataset release lock");
  const release = readJson(path.join(datasetRoot, "dataset_release.json"));
  if (release.version !== lock.releaseVersion) throw new Error("Dataset release version differs from dataset-lock.json");
  const commit = git(["rev-parse", "HEAD"]);
  const tagCommit = git(["rev-parse", `${lock.tag}^{commit}`]);
  if (!workspaceDataset && tagCommit !== lock.commit) throw new Error(`Dataset tag ${lock.tag} does not resolve to its locked commit`);
  if (!workspaceDataset) {
    const ancestor = spawnSync("git", ["-C", datasetRoot, "merge-base", "--is-ancestor", lock.commit, "HEAD"], { windowsHide: true });
    if (ancestor.status !== 0) throw new Error(`Dataset checkout ${commit} does not descend from pinned commit ${lock.commit}`);
    const postReleaseChanges = git(["diff", "--name-only", lock.commit, "HEAD", "--", "."]);
    const unsafeChanges = postReleaseChanges.split(/\r?\n/u).filter(Boolean).filter(file => file !== "SETTLED_HISTORY.md");
    if (unsafeChanges.length) throw new Error(`Dataset checkout has post-tag source changes: ${unsafeChanges.join(", ")}`);
  }
  const modifiedExportInputs = git(["status", "--porcelain=v1", "--", ...datasetExportInputs(lock.profile)]);
  if (!workspaceDataset && modifiedExportInputs) {
    throw new Error("Allowlisted Dataset export inputs differ from the pinned release. Use --workspace-dataset only for an explicit local authority cutover.");
  }
  const artifactPath = path.join(datasetRoot, "release-artifacts", lock.tag, lock.artifact.name);
  if (!workspaceDataset && (!fs.existsSync(artifactPath) || sha256(fs.readFileSync(artifactPath)).toLowerCase() !== lock.artifact.sha256.toLowerCase())) {
    throw new Error(`Dataset artifact is missing or does not match its lock: ${lock.artifact.name}`);
  }
  return { lock, sourceMode: workspaceDataset ? "local-workspace" : "immutable-release", baseCommit: commit, modifiedExportInputs: modifiedExportInputs ? modifiedExportInputs.split(/\r?\n/u) : [] };
}

function runExporter(script, profile, output) {
  const result = spawnSync(process.execPath, [script, "--profile", profile, mode === "sync" ? "--write" : "--check", "--output", output], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Exporter failed: ${script}`);
  return JSON.parse(result.stdout);
}

function removeExcludedDatasetTargets(expectedBundles) {
  const datasetsRoot = path.join(generatedRoot, "datasets");
  const expected = new Set(expectedBundles.filter(bundle => bundle.target.startsWith("datasets/")).map(bundle => path.basename(bundle.target)));
  if (!fs.existsSync(datasetsRoot)) return [];
  const extras = fs.readdirSync(datasetsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && !expected.has(entry.name));
  if (!extras.length) return [];
  for (const extra of extras) {
    const target = path.join(datasetsRoot, extra.name);
    const manifestPath = path.join(target, "dataset.generated.json");
    if (!fs.existsSync(manifestPath)) throw new Error(`Refusing to remove unmanifested generated directory: datasets/${extra.name}`);
    const manifest = readJson(manifestPath);
    if (!String(manifest.consumer || "").startsWith("plc-") || !String(manifest.consumer || "").endsWith("-dataset")) {
      throw new Error(`Refusing to remove unrecognized generated directory: datasets/${extra.name}`);
    }
    if (mode === "check") throw new Error(`Excluded generated Dataset remains: datasets/${extra.name}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  return extras.map(entry => `datasets/${entry.name}`);
}

const datasetSource = verifyDatasetSource();
const datasetConfig = readJson(path.join(datasetRoot, "consumer_exports.json"));
const datasetBundles = resolveProfile(datasetConfig, datasetSource.lock.profile);
const removedTargets = removeExcludedDatasetTargets(datasetBundles);
const datasetResult = runExporter(path.join(datasetRoot, "tools", "export_consumer_bundle.js"), datasetSource.lock.profile, generatedRoot);
const battleResult = runExporter(path.join(battleRoot, "tools", "export_plc_bundle.js"), datasetSource.lock.profile, path.join(generatedRoot, "battle-mechanics"));

console.log(JSON.stringify({
  status: mode === "sync" ? "generated" : "current",
  datasetRelease: {
    sourceMode: datasetSource.sourceMode,
    repository: datasetSource.lock.repository,
    tag: datasetSource.lock.tag,
    commit: datasetSource.lock.commit,
    checkoutCommit: datasetSource.baseCommit,
    releaseVersion: datasetSource.lock.releaseVersion,
    profile: datasetSource.lock.profile,
    synchronizedBundles: datasetResult.bundles.length,
    removedTargets,
    modifiedExportInputs: datasetSource.modifiedExportInputs
  },
  profiles: [
    ...datasetResult.bundles.map(bundle => ({ consumer: "dataset-owned", files: bundle.files, target: bundle.target, sourceTreeSha256: bundle.sourceTreeSha256 })),
    { consumer: battleResult.profile, files: battleResult.files, target: "battle-mechanics", sourceTreeSha256: battleResult.sourceTreeSha256 }
  ],
  pendingDatasets: []
}, null, 2));
