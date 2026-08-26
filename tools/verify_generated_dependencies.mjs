import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const targets = [
  { root: "src/generated/datasets/volt-white-2r", manifest: "dataset.generated.json" },
  { root: "src/generated/battle-mechanics", manifest: "battle-mechanics.generated.json" },
  { root: "src/generated/save-mechanics", manifest: "save-mechanics.generated.json" }
];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function listFiles(root) {
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

const results = [];
for (const target of targets) {
  const root = path.resolve(projectRoot, target.root);
  const manifestPath = path.join(root, target.manifest);
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing generated manifest ${target.root}/${target.manifest}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const expectedPaths = new Set([target.manifest, ...(manifest.files || []).map(file => file.path)]);
  const actualPaths = listFiles(root);
  const extras = actualPaths.filter(relativePath => !expectedPaths.has(relativePath));
  const missing = [...expectedPaths].filter(relativePath => !actualPaths.includes(relativePath));
  if (extras.length || missing.length) {
    throw new Error(`${target.root} differs from its manifest (missing: ${missing.join(", ") || "none"}; extras: ${extras.join(", ") || "none"})`);
  }
  for (const file of manifest.files || []) {
    const bytes = fs.readFileSync(path.join(root, file.path));
    if (bytes.byteLength !== Number(file.bytes) || sha256(bytes) !== String(file.sha256).toUpperCase()) {
      throw new Error(`${target.root}/${file.path} does not match its generated manifest`);
    }
  }
  results.push({ root: target.root, files: manifest.files.length, sourceTreeSha256: manifest.sourceTreeSha256 });
}

console.log(JSON.stringify({ status: "generated-dependencies-valid", targets: results }, null, 2));
