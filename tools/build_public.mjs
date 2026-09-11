import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const outputRoot = path.resolve(projectRoot, "dist");

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

if (!inside(outputRoot, projectRoot) || path.basename(outputRoot) !== "dist") throw new Error("Unsafe public-build output path");

function copyTree(source, destination) {
  const sourcePath = path.resolve(source);
  const stat = fs.statSync(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`Public build refuses symbolic link ${sourcePath}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) copyTree(path.join(sourcePath, entry), path.join(destination, entry));
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported public-build entry ${sourcePath}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(sourcePath, destination);
}

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

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

for (const entry of ["styles.css", "contracts", "src", "public-assets", "THIRD_PARTY_NOTICES.md", "third_party"]) {
  copyTree(path.join(projectRoot, entry), path.join(outputRoot, entry));
}

const sourceHtml = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const configuredPokemonAssetBase = String(process.env.POKEMON_ASSET_RELEASE_BASE || "").trim();
if (configuredPokemonAssetBase && (
  !/^https:\/\//i.test(configuredPokemonAssetBase)
  || /\/(?:main|master|latest)(?:\/|$)/i.test(configuredPokemonAssetBase)
  || /<owner>|<asset-repo>|<immutable-tag>/i.test(configuredPokemonAssetBase)
)) throw new Error("POKEMON_ASSET_RELEASE_BASE must be an HTTPS URL pinned to an immutable tag or commit");
const publicPokemonAssetBase = configuredPokemonAssetBase || "./public-assets";
const publicHtml = sourceHtml
  .replace('<meta name="pokemon-asset-release-base" content="./public-assets">', `<meta name="pokemon-asset-release-base" content="${publicPokemonAssetBase}">`);
if (publicHtml.includes("PLC_LOCAL_ONLY_") || !publicHtml.includes('<meta name="plc-build-profile" content="public">') || publicHtml.includes('/Datasets/Pokemon%20Assets/release')) throw new Error("Public source HTML is not release-safe");
fs.writeFileSync(path.join(outputRoot, "index.html"), publicHtml);
fs.writeFileSync(path.join(outputRoot, ".nojekyll"), "");

const files = listFiles(outputRoot).filter(relativePath => relativePath !== "public-build-manifest.json");
const manifest = {
  schemaVersion: "plc-public-build/v1alpha1",
  files: files.map(relativePath => {
    const bytes = fs.readFileSync(path.join(outputRoot, relativePath));
    return { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
  })
};
fs.writeFileSync(path.join(outputRoot, "public-build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({ status: "public-build-created", files: manifest.files.length + 1, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) }, null, 2));
