import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const outputRoot = path.resolve(projectRoot, "dist");

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

if (!inside(outputRoot, projectRoot) || path.basename(outputRoot) !== "dist") throw new Error("Unsafe public-build output path");

function copyTree(source, destination, { minifyJson = false } = {}) {
  const sourcePath = path.resolve(source);
  const stat = fs.statSync(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`Public build refuses symbolic link ${sourcePath}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyTree(path.join(sourcePath, entry), path.join(destination, entry), { minifyJson });
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported public-build entry ${sourcePath}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (minifyJson && path.extname(sourcePath).toLowerCase() === ".json") {
    const document = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    fs.writeFileSync(destination, JSON.stringify(document));
  } else fs.copyFileSync(sourcePath, destination);
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

for (const entry of ["contracts", "public-assets", "THIRD_PARTY_NOTICES.md", "third_party"]) {
  copyTree(path.join(projectRoot, entry), path.join(outputRoot, entry));
}
copyTree(path.join(projectRoot, "src", "generated"), path.join(outputRoot, "src", "generated"), { minifyJson: true });

function writeHashed(relativeDirectory, stem, extension, bytes) {
  const hash = sha256(bytes).slice(0, 12).toLowerCase();
  const fileName = `${stem}-${hash}.${extension}`;
  const destination = path.join(outputRoot, relativeDirectory, fileName);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return relativeDirectory === "."
    ? fileName
    : `${relativeDirectory.replaceAll("\\", "/")}/${fileName}`;
}

const target = ["chrome120", "edge120", "firefox121", "safari17"];
const workerBundle = await build({
  entryPoints: [path.join(projectRoot, "src", "worker", "resolver_worker.js")],
  bundle: true,
  format: "iife",
  legalComments: "none",
  minify: true,
  platform: "browser",
  target,
  write: false
});
const workerPath = writeHashed("src/worker", "resolver_worker", "js", workerBundle.outputFiles[0].contents);
const workerFileFromApp = `./worker/${path.basename(workerPath)}`;

const appBundle = await build({
  entryPoints: [path.join(projectRoot, "src", "app.js")],
  bundle: true,
  define: { __PLC_RESOLVER_WORKER_FILE__: JSON.stringify(workerFileFromApp) },
  format: "esm",
  legalComments: "none",
  minify: true,
  platform: "browser",
  target,
  write: false
});
const appPath = writeHashed("src", "app", "js", appBundle.outputFiles[0].contents);

const css = await transform(fs.readFileSync(path.join(projectRoot, "styles.css"), "utf8"), {
  loader: "css",
  legalComments: "none",
  minify: true,
  target
});
const cssPath = writeHashed(".", "styles", "css", Buffer.from(css.code));

const assetResolver = await transform(fs.readFileSync(path.join(projectRoot, "src", "generated", "pokemon_asset_resolver.global.js"), "utf8"), {
  loader: "js",
  legalComments: "none",
  minify: true,
  target
});
const assetResolverPath = writeHashed("src/generated", "pokemon_asset_resolver.global", "js", Buffer.from(assetResolver.code));

const sourceHtml = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const configuredPokemonAssetBase = String(process.env.POKEMON_ASSET_RELEASE_BASE || "").trim();
if (configuredPokemonAssetBase && (
  !/^https:\/\//i.test(configuredPokemonAssetBase)
  || /\/(?:main|master|latest)(?:\/|$)/i.test(configuredPokemonAssetBase)
  || /<owner>|<asset-repo>|<immutable-tag>/i.test(configuredPokemonAssetBase)
)) throw new Error("POKEMON_ASSET_RELEASE_BASE must be an HTTPS URL pinned to an immutable tag or commit");
const publicPokemonAssetBase = configuredPokemonAssetBase || "./public-assets";
const publicHtml = sourceHtml
  .replace('<meta name="pokemon-asset-release-base" content="./public-assets">', `<meta name="pokemon-asset-release-base" content="${publicPokemonAssetBase}">`)
  .replace(/<link rel="stylesheet" href="\.\/styles\.css\?v=[^"]+">/, `<link rel="stylesheet" href="./${cssPath}">`)
  .replace(/\s*<script src="\.\/src\/generated\/pokemon_asset_resolver\.global\.js\?v=[^"]+"><\/script>/, `\n  <script src="./${assetResolverPath}"></script>`)
  .replace(/\s*<script src="\.\/src\/generated\/battle-mechanics\/trainer_ai\/trainer_ai_evaluator\.js\?v=[^"]+"><\/script>/, "")
  .replace(/<script type="module" src="\.\/src\/app\.js\?v=[^"]+"><\/script>/, `<script type="module" src="./${appPath}"></script>`);
if (publicHtml.includes("PLC_LOCAL_ONLY_") || !publicHtml.includes('<meta name="plc-build-profile" content="public">') || publicHtml.includes('/Datasets/Pokemon%20Assets/release')) throw new Error("Public source HTML is not release-safe");
for (const requiredPath of [cssPath, assetResolverPath, appPath, workerPath]) {
  if (!publicHtml.includes(requiredPath) && requiredPath !== workerPath) throw new Error(`Public HTML does not reference ${requiredPath}`);
}
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
