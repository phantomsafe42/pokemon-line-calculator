import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commonGitDirectory = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
const primaryProjectRoot = path.dirname(commonGitDirectory);
const workspaceRoot = path.resolve(primaryProjectRoot, "..", "..");
const assetRepository = path.resolve(workspaceRoot, "Datasets", "Pokemon Assets");
const lockPath = path.join(root, "asset-lock.json");
const target = path.join(root, "public-assets");
const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--write") ? "write" : null;

if (!mode || process.argv.filter(argument => argument === "--check" || argument === "--write").length !== 1) {
  throw new Error("Use exactly one mode: --check or --write");
}

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function safeRelative(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe asset path: ${value}`);
  }
  return normalized;
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(safeRelative(path.relative(directory, absolute)));
      else throw new Error(`Unsupported asset projection entry: ${absolute}`);
    }
  };
  visit(directory);
  return files.sort();
}

function materializeRelease(commit) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plc-assets-"));
  const archive = path.join(temporaryRoot, "release.tar");
  const archiveResult = spawnSync("git", ["-C", assetRepository, "archive", "--format=tar", "-o", archive, commit, "release"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (archiveResult.status !== 0) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw new Error(`Unable to materialize the locked Assets release: ${String(archiveResult.stderr || archiveResult.stdout).trim()}`);
  }
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  const extractResult = spawnSync(tar, ["-xf", archive, "-C", temporaryRoot], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (extractResult.status !== 0) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw new Error(`Unable to extract the locked Assets release: ${String(extractResult.stderr || extractResult.stdout).trim()}`);
  }
  return temporaryRoot;
}

function verifyResolver(lock) {
  const sourceResult = spawnSync("git", ["-C", assetRepository, "show", `${lock.source.commit}:consumer/pokemon_asset_resolver.global.js`], {
    encoding: null,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (sourceResult.status !== 0) throw new Error(String(sourceResult.stderr || sourceResult.stdout).trim());
  const sourceBytes = sourceResult.stdout;
  if (hash(sourceBytes) !== lock.source.resolverSha256.toLowerCase()) throw new Error("Locked asset resolver digest mismatch");
  const generatedRoot = path.join(root, "src", "generated");
  if (!fs.readFileSync(path.join(generatedRoot, "pokemon_asset_resolver.global.js")).equals(sourceBytes)) {
    throw new Error("PLC asset resolver differs from its locked commit");
  }
  const provenance = readJson(path.join(generatedRoot, "pokemon_asset_resolver.provenance.json"));
  if (provenance.schemaVersion !== 2
    || provenance.sourceCommit !== lock.source.commit
    || provenance.sourceSha256 !== lock.source.resolverSha256
    || provenance.releaseVersion !== lock.source.releaseVersion
    || provenance.releaseIndexSha256 !== lock.source.indexSha256
    || provenance.releaseManifestSha256 !== lock.source.manifestSha256) {
    throw new Error("PLC asset resolver provenance differs from asset-lock.json");
  }
}

function expectedProjection(source, lock) {
  const read = name => fs.readFileSync(path.join(source, safeRelative(name)));
  const sourceIndexBytes = read("index.json");
  if (hash(sourceIndexBytes) !== lock.source.indexSha256.toLowerCase()) throw new Error("Locked asset index digest mismatch");
  const sourceIndex = JSON.parse(sourceIndexBytes);
  if (sourceIndex.releaseVersion !== lock.source.releaseVersion) throw new Error("Locked asset release version mismatch");
  const sourceManifestBytes = read(sourceIndex.manifest.path);
  if (hash(sourceManifestBytes) !== lock.source.manifestSha256.toLowerCase()) throw new Error("Locked asset manifest digest mismatch");
  const sourceCatalogBytes = read(sourceIndex.assetCatalog.path);
  if (hash(sourceCatalogBytes) !== sourceIndex.assetCatalog.sha256) throw new Error("Asset catalog digest mismatch");
  const catalog = JSON.parse(sourceCatalogBytes);
  const requestedProfiles = new Set(lock.projection.profileIds);
  const profiles = sourceIndex.profiles.filter(row => requestedProfiles.has(row.profileId));
  if (profiles.length !== requestedProfiles.size) throw new Error("The locked Assets release is missing a requested public profile");
  if (lock.projection.collectionMode !== "all") throw new Error("Unsupported asset collection selection");
  const files = new Map();
  function add(name, expectedHash) {
    const normalized = safeRelative(name);
    const bytes = read(normalized);
    if (expectedHash && hash(bytes) !== String(expectedHash).toLowerCase()) throw new Error(`Asset digest mismatch: ${normalized}`);
    files.set(normalized, bytes);
    return bytes;
  }
  function collect(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.path === "string" && value.sha256) add(value.path, value.sha256);
    for (const child of Object.values(value)) collect(child);
  }
  for (const profile of profiles) collect(JSON.parse(add(profile.indexPath, profile.indexSha256)));
  for (const collection of catalog.collections.filter(row => row.indexPath)) {
    collect(JSON.parse(add(collection.indexPath, collection.indexSha256)));
    collect(collection.metadataFiles);
  }
  const spriteCollection = catalog.collections.find(row => row.kind === "pokemon-sprite");
  Object.assign(spriteCollection, {
    profiles: profiles.length,
    assets: profiles.reduce((sum, row) => sum + row.assets, 0),
    assetBytes: profiles.reduce((sum, row) => sum + row.assetBytes, 0),
  });
  const catalogBytes = json(catalog);
  files.set("asset-index.json", catalogBytes);
  files.set("index.json", json({
    schemaVersion: sourceIndex.schemaVersion,
    datasetId: sourceIndex.datasetId,
    releaseVersion: sourceIndex.releaseVersion,
    generated: true,
    assetCatalog: { path: "asset-index.json", sha256: hash(catalogBytes), bytes: catalogBytes.length },
    profiles,
  }));
  files.set("projection.json", json({
    schemaVersion: 2,
    generated: true,
    sourceRepository: lock.source.repository,
    sourceCommit: lock.source.commit,
    sourceRelease: sourceIndex.releaseVersion,
    sourceIndexSha256: hash(sourceIndexBytes),
    sourceManifestSha256: hash(sourceManifestBytes),
    includedProfiles: lock.projection.profileIds,
    excludedProfiles: lock.projection.excludedProfileIds,
    collectionMode: lock.projection.collectionMode,
    files: [...files].sort(([left], [right]) => left.localeCompare(right)).map(([name, bytes]) => ({
      path: name,
      sha256: hash(bytes),
      bytes: bytes.length,
    })),
  }));
  return files;
}

function synchronize(expected) {
  const expectedPaths = [...expected.keys()].sort();
  const expectedSet = new Set(expectedPaths);
  const actualPaths = listFiles(target);
  const extras = actualPaths.filter(file => !expectedSet.has(file));
  if (extras.length) {
    const priorProjectionPath = path.join(target, "projection.json");
    if (!fs.existsSync(priorProjectionPath)) throw new Error(`Refusing to remove unmanifested public assets: ${extras.join(", ")}`);
    const prior = readJson(priorProjectionPath);
    const priorOwned = new Set(["projection.json", ...(prior.files || []).map(file => safeRelative(file.path))]);
    const unsafe = extras.filter(file => !priorOwned.has(file));
    if (unsafe.length) throw new Error(`Refusing to remove unmanifested public assets: ${unsafe.join(", ")}`);
    if (mode === "check") throw new Error(`Public asset projection contains obsolete files: ${extras.join(", ")}`);
    for (const relative of extras) fs.unlinkSync(path.join(target, relative));
  }
  if (mode === "write") {
    for (const [name, bytes] of expected) {
      const destination = path.join(target, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
    }
  }
  const missing = [];
  const changed = [];
  for (const [name, bytes] of expected) {
    const destination = path.join(target, name);
    if (!fs.existsSync(destination)) missing.push(name);
    else if (!fs.readFileSync(destination).equals(bytes)) changed.push(name);
  }
  if (missing.length || changed.length) {
    throw new Error(`Public asset projection differs from its lock (missing: ${missing.join(", ") || "none"}; changed: ${changed.join(", ") || "none"})`);
  }
  return { files: expectedPaths.length, bytes: [...expected.values()].reduce((sum, bytes) => sum + bytes.length, 0) };
}

const lock = readJson(lockPath);
if (lock.schemaVersion !== "plc-asset-lock/v1" || lock.source.repository !== "phantomsafe42/pokemon-assets") {
  throw new Error("Unsupported PLC asset lock");
}
const objectCheck = spawnSync("git", ["-C", assetRepository, "cat-file", "-e", `${lock.source.commit}^{commit}`], { windowsHide: true });
if (objectCheck.status !== 0) throw new Error(`Locked Assets commit is unavailable: ${lock.source.commit}`);
verifyResolver(lock);
const temporaryRoot = materializeRelease(lock.source.commit);
try {
  const result = synchronize(expectedProjection(path.join(temporaryRoot, "release"), lock));
  console.log(JSON.stringify({
    status: mode === "write" ? "public-assets-projected" : "public-assets-current",
    sourceCommit: lock.source.commit,
    sourceRelease: lock.source.releaseVersion,
    ...result,
  }, null, 2));
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
