import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const outputRoot = path.join(projectRoot, "dist");
const manifestPath = path.join(outputRoot, "public-build-manifest.json");

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
      else throw new Error(`Unsupported public-build entry ${absolute}`);
    }
  };
  visit(root);
  return files.sort();
}

if (!fs.existsSync(manifestPath)) throw new Error("Public build is missing; run npm run build:public");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== "plc-public-build/v1alpha1") throw new Error("Unsupported public-build manifest");
const expected = new Set(["public-build-manifest.json", ...manifest.files.map(file => file.path)]);
const actual = listFiles(outputRoot);
const extras = actual.filter(relativePath => !expected.has(relativePath));
const missing = [...expected].filter(relativePath => !actual.includes(relativePath));
if (extras.length || missing.length) throw new Error(`Public build differs from its manifest (missing: ${missing.join(", ") || "none"}; extras: ${extras.join(", ") || "none"})`);

for (const file of manifest.files) {
  const bytes = fs.readFileSync(path.join(outputRoot, file.path));
  if (bytes.byteLength !== Number(file.bytes) || sha256(bytes) !== String(file.sha256).toUpperCase()) {
    throw new Error(`Public-build digest mismatch: ${file.path}`);
  }
}

const forbiddenPaths = [
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)SETTLED_HISTORY\.md$/i,
  /(^|\/)\.codex(?:-|\/|$)/i,
  /(^|\/)src\/integrations\//i,
  /(^|\/)src\/testing\//i,
  /\.(?:sav|srm|dsv|nds|gba|gbc|gb|3ds|cia)$/i
];
for (const relativePath of actual) {
  if (forbiddenPaths.some(pattern => pattern.test(relativePath))) throw new Error(`Forbidden public file: ${relativePath}`);
}

const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".txt"]);
const forbiddenText = [
  { label: "Stream Tools control endpoint", pattern: /__stream-tools/i },
  { label: "workspace Dataset route", pattern: /\/Datasets\// },
  { label: "workspace Battle Mechanics route", pattern: /\/Battle%20Mechanics\//i },
  { label: "Windows user path", pattern: /[A-Za-z]:[\\/]Users[\\/]/i },
  { label: "Codex instruction marker", pattern: /PLC_LOCAL_ONLY_|Codex working|AGENTS\.md/i }
];
for (const relativePath of actual) {
  if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue;
  const content = fs.readFileSync(path.join(outputRoot, relativePath), "utf8");
  for (const rule of forbiddenText) {
    if (rule.pattern.test(content)) throw new Error(`${rule.label} remains in public file ${relativePath}`);
  }
}

const html = fs.readFileSync(path.join(outputRoot, "index.html"), "utf8");
for (const forbiddenId of ["output-state", "output-state-anchor", "live-edit-anchor", "live-stop-dialog"]) {
  if (new RegExp(`id=["']${forbiddenId}["']`, "i").test(html)) throw new Error(`Public HTML still exposes ${forbiddenId}`);
}
if (!html.includes('<meta name="plc-build-profile" content="public">')) throw new Error("Public HTML does not declare the public profile");

console.log(JSON.stringify({ status: "public-build-valid", files: actual.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) }, null, 2));
