import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const mode = process.argv.includes("--sync") ? "sync" : process.argv.includes("--check") ? "check" : null;

if (!mode || process.argv.filter(argument => argument === "--sync" || argument === "--check").length !== 1) {
  throw new Error("Use exactly one mode: --sync or --check");
}

const profiles = [
  {
    consumer: "plc-vw2r-dataset",
    schemaVersion: "plc-generated-dataset/v1alpha1",
    source: "Datasets/Volt White 2R/source-data",
    target: "src/generated/datasets/volt-white-2r",
    manifest: "dataset.generated.json",
    files: [
      "dataset_manifest.json",
      "battle_mechanics.json",
      "species.json",
      "moves.json",
      "abilities.json",
      "items.json",
      "natures.json",
      "types.json",
      "trainers.json",
      "trainer_order.json",
      "progression.json",
      "save_id_maps.json"
    ]
  },
  {
    consumer: "plc-battle-mechanics",
    schemaVersion: "plc-generated-battle-mechanics/v1alpha1",
    source: "Battle Mechanics",
    target: "src/generated/battle-mechanics",
    manifest: "battle-mechanics.generated.json",
    files: [
      "shared_damage_calculator.js",
      "vendor/smogon-calc-0.11.0/data.production.min.js",
      "vendor/smogon-calc-0.11.0/engine.production.min.js",
      "vendor/smogon-calc-0.11.0/LICENSE",
      "vendor/smogon-calc-0.11.0/README.md"
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
  const files = profile.files.map(relativePath => {
    const sourceFile = path.resolve(sourceRoot, relativePath);
    if (!inside(sourceFile, sourceRoot) || !fs.existsSync(sourceFile)) throw new Error(`Missing authoritative file ${profile.source}/${relativePath}`);
    const bytes = fs.readFileSync(sourceFile);
    return { path: relativePath, bytes, size: bytes.byteLength, sha256: sha256(bytes) };
  });
  const sourceTreeSha256 = sha256(files.map(file => `${file.path}\0${file.sha256}\n`).join(""));
  const generatedManifest = {
    schemaVersion: profile.schemaVersion,
    consumer: profile.consumer,
    source: profile.source.replaceAll("\\", "/"),
    sourceTreeSha256,
    files: files.map(({ path: filePath, size, sha256: digest }) => ({ path: filePath, bytes: size, sha256: digest }))
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

console.log(JSON.stringify({ status: mode === "sync" ? "generated" : "current", profiles: results }, null, 2));
