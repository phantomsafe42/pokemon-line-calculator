import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
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
const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--write") ? "write" : null;

if (!mode || process.argv.filter(argument => argument === "--check" || argument === "--write").length !== 1) {
  throw new Error("Use exactly one mode: --check or --write");
}

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function gitBytes(commit, file) {
  const result = spawnSync("git", ["-C", assetRepository, "show", `${commit}:${file}`], {
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout).trim());
  return result.stdout;
}

function gitText(...arguments_) {
  const result = spawnSync("git", ["-C", assetRepository, ...arguments_], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout).trim());
  return result.stdout.trim();
}

function verifyHash(bytes, expected, label) {
  if (hash(bytes) !== String(expected).toLowerCase()) throw new Error(`${label} digest mismatch`);
}

function syncFile(relativePath, bytes) {
  const destination = path.join(root, relativePath);
  if (mode === "write") {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(bytes)) {
    throw new Error(`${relativePath} differs from asset-lock.json`);
  }
}

const lock = readJson(lockPath);
if (lock.schemaVersion !== "plc-asset-lock/v2" || lock.repository !== "phantomsafe42/pokemon-assets") {
  throw new Error("Unsupported PLC asset lock");
}

for (const commit of [lock.release.commit, lock.clients.sourceCommit]) {
  const check = spawnSync("git", ["-C", assetRepository, "cat-file", "-e", `${commit}^{commit}`], { windowsHide: true });
  if (check.status !== 0) throw new Error(`Locked Assets commit is unavailable: ${commit}`);
}
if (gitText("rev-list", "-n", "1", lock.release.tag) !== lock.release.commit) {
  throw new Error("Locked Assets tag does not resolve to the declared release commit");
}

const indexBytes = gitBytes(lock.release.commit, "release/index.json");
const manifestBytes = gitBytes(lock.release.commit, "release/manifest.json");
const creditsBytes = gitBytes(lock.release.commit, "release/credits.json");
verifyHash(indexBytes, lock.release.indexSha256, "Locked asset index");
verifyHash(manifestBytes, lock.release.manifestSha256, "Locked asset manifest");
verifyHash(creditsBytes, lock.release.creditsSha256, "Locked asset credits");
const index = JSON.parse(indexBytes);
if (index.releaseVersion !== lock.release.version
  || index.manifest?.sha256 !== lock.release.manifestSha256
  || index.credits?.sha256 !== lock.release.creditsSha256) {
  throw new Error("Locked asset release metadata is inconsistent");
}

const gatewayConfigBytes = gitBytes(lock.clients.sourceCommit, "config/asset-gateway.json");
verifyHash(gatewayConfigBytes, lock.gateway.configSha256, "Locked asset gateway config");
const gatewayConfig = JSON.parse(gatewayConfigBytes);
if (gatewayConfig.contract !== lock.gateway.contract
  || gatewayConfig.publicOrigin !== lock.gateway.origin
  || gatewayConfig.releaseVersion !== lock.gateway.releaseVersion
  || gatewayConfig.rootIndexSha256 !== lock.release.indexSha256
  || gatewayConfig.creditsSha256 !== lock.release.creditsSha256
  || gatewayConfig.completionPlanSha256 !== lock.gateway.completionPlanSha256
  || gatewayConfig.exposurePolicy?.rawObjectPaths !== false
  || gatewayConfig.exposurePolicy?.typedSingleAssetResponses !== true) {
  throw new Error("Locked asset gateway contract is inconsistent");
}

const clients = [
  {
    name: "resolver",
    source: "consumer/pokemon_asset_resolver.global.js",
    target: "src/generated/pokemon_asset_resolver.global.js",
    sha256: lock.clients.resolverSha256,
  },
  {
    name: "gateway",
    source: "consumer/pokemon_asset_gateway.global.js",
    target: "src/generated/pokemon_asset_gateway.global.js",
    sha256: lock.clients.gatewaySha256,
  },
];

for (const client of clients) {
  const bytes = gitBytes(lock.clients.sourceCommit, client.source);
  verifyHash(bytes, client.sha256, `Locked asset ${client.name} client`);
  syncFile(client.target, bytes);
  syncFile(`src/generated/pokemon_asset_${client.name}.provenance.json`, json({
    schemaVersion: 3,
    generated: true,
    source: `Datasets/Pokemon Assets/${client.source}`,
    sourceCommit: lock.clients.sourceCommit,
    sourceSha256: client.sha256,
    releaseVersion: lock.release.version,
    releaseTag: lock.release.tag,
    releaseCommit: lock.release.commit,
    releaseIndexSha256: lock.release.indexSha256,
    releaseManifestSha256: lock.release.manifestSha256,
    releaseCreditsSha256: lock.release.creditsSha256,
    ...(client.name === "gateway" ? {
      gatewayContract: lock.gateway.contract,
      gatewayOrigin: lock.gateway.origin,
      gatewayConfigSha256: lock.gateway.configSha256,
      gatewayDeploymentVersion: lock.gateway.deploymentVersion,
    } : {}),
  }));
}

console.log(JSON.stringify({
  status: mode === "write" ? "asset-clients-synchronized" : "asset-clients-current",
  sourceCommit: lock.clients.sourceCommit,
  releaseCommit: lock.release.commit,
  sourceRelease: lock.release.version,
  gatewayOrigin: lock.gateway.origin,
  files: clients.length * 2,
}, null, 2));
