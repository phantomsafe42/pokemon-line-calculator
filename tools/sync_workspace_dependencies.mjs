import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const commonGitDirectory = execFileSync("git", ["-C", projectRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
const primaryProjectRoot = path.dirname(commonGitDirectory);
const workspaceRoot = path.resolve(primaryProjectRoot, "..", "..");
const datasetRoot = path.resolve(workspaceRoot, "Datasets");
const battleRoot = path.resolve(workspaceRoot, "Battle Mechanics");
const saveMechanicsRoot = path.resolve(workspaceRoot, "Save Mechanics");
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

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelative(value, label = "path") {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return normalized;
}

function datasetGit(args, options = {}) {
  return execFileSync("git", ["-C", datasetRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

function tryDatasetGit(args) {
  const result = spawnSync("git", ["-C", datasetRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function verifyTag(lock) {
  const local = tryDatasetGit(["rev-parse", `${lock.tag}^{commit}`]);
  if (local) {
    if (local !== lock.commit) throw new Error(`Dataset tag ${lock.tag} resolves to ${local}, not ${lock.commit}`);
    return "local-tag";
  }
  const remoteRows = datasetGit(["ls-remote", "--tags", "origin", `refs/tags/${lock.tag}`, `refs/tags/${lock.tag}^{}`])
    .split(/\r?\n/u).filter(Boolean);
  const peeled = remoteRows.find(row => row.endsWith(`refs/tags/${lock.tag}^{}`)) || remoteRows[0];
  const remoteCommit = peeled?.split(/\s+/u)[0];
  if (remoteCommit !== lock.commit) throw new Error(`Remote Dataset tag ${lock.tag} does not resolve to ${lock.commit}`);
  return "remote-tag";
}

function artifactCandidates(lock) {
  const candidates = [];
  if (process.env.PLC_DATASET_ARTIFACT) candidates.push(path.resolve(process.env.PLC_DATASET_ARTIFACT));
  for (const line of datasetGit(["worktree", "list", "--porcelain"]).split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      const worktree = line.slice("worktree ".length);
      candidates.push(path.join(worktree, "release-artifacts", lock.tag, lock.artifact.name));
    }
  }
  candidates.push(path.join(datasetRoot, "release-artifacts", lock.tag, lock.artifact.name));
  return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

function downloadArtifact(lock) {
  const cacheRoot = path.join(projectRoot, ".codex-tmp", "dataset-release-artifacts", lock.tag);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const target = path.join(cacheRoot, lock.artifact.name);
  const result = spawnSync("gh", [
    "release", "download", lock.tag,
    "--repo", lock.repository,
    "--pattern", lock.artifact.name,
    "--dir", cacheRoot,
    "--clobber",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || !fs.existsSync(target)) {
    throw new Error(`Dataset artifact is unavailable locally and could not be downloaded: ${String(result.stderr || result.stdout).trim()}`);
  }
  return target;
}

function findArtifact(lock) {
  const candidate = artifactCandidates(lock).find(file => fs.existsSync(file));
  const artifactPath = candidate || downloadArtifact(lock);
  const digest = sha256(fs.readFileSync(artifactPath));
  if (digest !== String(lock.artifact.sha256).toUpperCase()) {
    throw new Error(`Dataset artifact digest mismatch: ${artifactPath}`);
  }
  return artifactPath;
}

function archiveEntries(artifactPath) {
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  const result = spawnSync(tar, ["-tf", artifactPath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Unable to inspect Dataset artifact: ${String(result.stderr || result.stdout).trim()}`);
  const entries = result.stdout.split(/\r?\n/u).filter(Boolean).map(entry => normalizeRelative(entry, "archive entry"));
  if (new Set(entries).size !== entries.length) throw new Error("Dataset artifact contains duplicate paths");
  if (entries.some(entry => !entry.startsWith("datasets/") && !entry.startsWith("trainer-ai/"))) {
    throw new Error("Dataset artifact contains a path outside its public PLC projections");
  }
  return { tar, entries };
}

function extractArtifact(artifactPath) {
  const { tar, entries } = archiveEntries(artifactPath);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plc-dataset-artifact-"));
  const result = spawnSync(tar, ["-xf", artifactPath, "-C", temporaryRoot], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw new Error(`Unable to extract Dataset artifact: ${String(result.stderr || result.stdout).trim()}`);
  }
  return { temporaryRoot, entries };
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(normalizeRelative(path.relative(root, absolute), "generated path"));
      else throw new Error(`Unsupported generated entry: ${absolute}`);
    }
  };
  visit(root);
  return files.sort();
}

function ownedDatasetFiles(root) {
  const owned = new Set();
  if (!fs.existsSync(root)) return owned;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, "dataset.generated.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (!String(manifest.consumer || "").startsWith("plc-") || !String(manifest.consumer || "").endsWith("-dataset")) continue;
    owned.add(`${entry.name}/dataset.generated.json`);
    for (const file of manifest.files || []) owned.add(`${entry.name}/${normalizeRelative(file.path, "Dataset manifest path")}`);
  }
  return owned;
}

function ownedTrainerAiFiles(root) {
  const owned = new Set();
  const manifestPath = path.join(root, "trainer-ai.generated.json");
  if (!fs.existsSync(manifestPath)) return owned;
  const manifest = readJson(manifestPath);
  if (manifest.consumer !== "plc-trainer-ai") return owned;
  owned.add("trainer-ai.generated.json");
  for (const file of manifest.files || []) owned.add(normalizeRelative(file.path, "Trainer AI manifest path"));
  return owned;
}

function pruneEmptyDirectories(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(root, entry.name);
    pruneEmptyDirectories(child);
    if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
  }
}

function synchronizeTree(source, target, ownedBefore) {
  const expectedPaths = listFiles(source);
  const expectedSet = new Set(expectedPaths);
  const actualPaths = listFiles(target);
  const extras = actualPaths.filter(file => !expectedSet.has(file));
  const unsafeExtras = extras.filter(file => !ownedBefore.has(file));
  if (unsafeExtras.length) throw new Error(`Refusing to remove unmanifested generated files from ${path.relative(projectRoot, target)}: ${unsafeExtras.join(", ")}`);
  if (mode === "check" && extras.length) throw new Error(`${path.relative(projectRoot, target)} contains excluded generated files: ${extras.join(", ")}`);
  if (mode === "sync") {
    for (const relative of extras) {
      const absolute = path.resolve(target, relative);
      if (!inside(absolute, target) || !fs.statSync(absolute).isFile()) throw new Error(`Unsafe obsolete generated file: ${relative}`);
      fs.unlinkSync(absolute);
    }
    pruneEmptyDirectories(target);
    for (const relative of expectedPaths) {
      const sourceFile = path.resolve(source, relative);
      const targetFile = path.resolve(target, relative);
      if (!inside(sourceFile, source) || !inside(targetFile, target)) throw new Error(`Unsafe generated path: ${relative}`);
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
    }
  }
  const missing = [];
  const changed = [];
  for (const relative of expectedPaths) {
    const sourceBytes = fs.readFileSync(path.join(source, relative));
    const targetFile = path.join(target, relative);
    if (!fs.existsSync(targetFile)) missing.push(relative);
    else if (!fs.readFileSync(targetFile).equals(sourceBytes)) changed.push(relative);
  }
  if (missing.length || changed.length) {
    throw new Error(`${path.relative(projectRoot, target)} differs from the locked artifact (missing: ${missing.join(", ") || "none"}; changed: ${changed.join(", ") || "none"})`);
  }
  const material = expectedPaths.map(relative => {
    const bytes = fs.readFileSync(path.join(source, relative));
    return `${relative}\0${bytes.byteLength}\0${sha256(bytes)}\n`;
  }).join("");
  return { files: expectedPaths.length, sourceTreeSha256: sha256(material) };
}

function runExporter(script, profile, output) {
  const result = spawnSync(process.execPath, [script, "--profile", profile, mode === "sync" ? "--write" : "--check", "--output", output], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Exporter failed: ${script}`);
  return JSON.parse(result.stdout);
}

function runSaveMechanics(profile) {
  const generator = path.join(saveMechanicsRoot, "distribution", "generate-copy.mjs");
  const argumentsList = [
    generator,
    "--consumer", profile,
    "--parity-validated",
    "--external",
    "--allow-external",
    "--external-root", projectRoot,
  ];
  if (mode === "check") argumentsList.push("--check");
  else argumentsList.push("--regenerate");
  const result = spawnSync(process.execPath, argumentsList, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Save Mechanics projection failed");
  return JSON.parse(result.stdout);
}

function runAssetProjection() {
  const result = spawnSync(process.execPath, [
    path.join(here, "project_public_assets.mjs"),
    mode === "sync" ? "--write" : "--check",
  ], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Public asset projection failed");
  return JSON.parse(result.stdout);
}

function verifyDatasetLock() {
  if (!fs.existsSync(datasetLockPath)) throw new Error("Missing dataset-lock.json");
  if (!fs.existsSync(path.join(datasetRoot, ".git"))) throw new Error("Datasets must be an independent Git checkout");
  const lock = readJson(datasetLockPath);
  if (lock.schemaVersion !== "plc-dataset-lock/v1") throw new Error("Unsupported Dataset lock schema");
  if (lock.repository !== "phantomsafe42/pokemon-datasets" || !["plc", "plc-public"].includes(lock.profile)) {
    throw new Error("Unexpected Dataset release lock");
  }
  const tagSource = verifyTag(lock);
  return { lock, tagSource };
}

const { lock, tagSource } = verifyDatasetLock();
const profiles = [];
let artifact = null;
let datasetResult;

if (workspaceDataset) {
  datasetResult = runExporter(path.join(datasetRoot, "tools", "export_consumer_bundle.js"), lock.profile, generatedRoot);
  profiles.push(...datasetResult.bundles.map(bundle => ({
    consumer: "dataset-owned",
    files: bundle.files,
    target: bundle.target,
    sourceTreeSha256: bundle.sourceTreeSha256,
  })));
} else {
  const artifactPath = findArtifact(lock);
  const extracted = extractArtifact(artifactPath);
  try {
    const datasets = synchronizeTree(
      path.join(extracted.temporaryRoot, "datasets"),
      path.join(generatedRoot, "datasets"),
      ownedDatasetFiles(path.join(generatedRoot, "datasets")),
    );
    const trainerAi = synchronizeTree(
      path.join(extracted.temporaryRoot, "trainer-ai"),
      path.join(generatedRoot, "trainer-ai"),
      ownedTrainerAiFiles(path.join(generatedRoot, "trainer-ai")),
    );
    profiles.push(
      { consumer: "dataset-artifact", target: "datasets", ...datasets },
      { consumer: "dataset-artifact", target: "trainer-ai", ...trainerAi },
    );
    artifact = { path: artifactPath, files: extracted.entries.length, sha256: sha256(fs.readFileSync(artifactPath)) };
  } finally {
    fs.rmSync(extracted.temporaryRoot, { recursive: true, force: true });
  }
}

const battleResult = runExporter(
  path.join(battleRoot, "tools", "export_plc_bundle.js"),
  lock.profile,
  path.join(generatedRoot, "battle-mechanics"),
);
profiles.push({
  consumer: battleResult.profile,
  files: battleResult.files,
  target: "battle-mechanics",
  sourceTreeSha256: battleResult.sourceTreeSha256,
});

const assets = runAssetProjection();
profiles.push({
  consumer: "pokemon-assets",
  files: assets.files,
  target: "public-assets",
  sourceCommit: assets.sourceCommit,
});

const saveMechanics = runSaveMechanics(lock.profile === "plc-public" ? "plc-public" : "plc-private");
profiles.push({
  consumer: saveMechanics.consumer,
  files: saveMechanics.fileCount,
  target: "save-mechanics",
  sourceTreeSha256: saveMechanics.sourceTreeSha256,
});

console.log(JSON.stringify({
  status: mode === "sync" ? "generated" : "current",
  datasetRelease: {
    sourceMode: workspaceDataset ? "local-workspace" : "immutable-release-artifact",
    repository: lock.repository,
    tag: lock.tag,
    tagSource,
    commit: lock.commit,
    releaseVersion: lock.releaseVersion,
    profile: lock.profile,
    artifact,
  },
  profiles,
  pendingDatasets: [],
}, null, 2));
