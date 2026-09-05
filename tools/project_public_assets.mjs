import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, '../../Datasets/Pokemon Assets/release');
const target = path.join(root, 'public-assets');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = name => fs.readFileSync(path.join(source, name));
const sourceIndexBytes = read('index.json');
const sourceIndex = JSON.parse(sourceIndexBytes);
const sourceCatalogBytes = read(sourceIndex.assetCatalog.path);
if (hash(sourceCatalogBytes) !== sourceIndex.assetCatalog.sha256) throw new Error('Asset catalog digest mismatch');
const catalog = JSON.parse(sourceCatalogBytes);
const profiles = sourceIndex.profiles.filter(row => ['gen5-animated', 'gen5-static', 'pixel'].includes(row.profileId));
const files = new Map();
function add(name, expectedHash) {
  if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('Unsafe asset path');
  const bytes = read(name);
  if (expectedHash && hash(bytes) !== expectedHash) throw new Error(`Asset digest mismatch: ${name}`);
  files.set(name, bytes);
  return bytes;
}
function collect(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.path === 'string' && value.sha256) add(value.path, value.sha256);
  for (const child of Object.values(value)) collect(child);
}
for (const profile of profiles) collect(JSON.parse(add(profile.indexPath, profile.indexSha256)));
for (const collection of catalog.collections.filter(row => row.indexPath)) {
  collect(JSON.parse(add(collection.indexPath, collection.indexSha256)));
  collect(collection.metadataFiles);
}
const spriteCollection = catalog.collections.find(row => row.kind === 'pokemon-sprite');
Object.assign(spriteCollection, { profiles: profiles.length, assets: profiles.reduce((sum, row) => sum + row.assets, 0), assetBytes: profiles.reduce((sum, row) => sum + row.assetBytes, 0) });
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const catalogBytes = json(catalog);
files.set('asset-index.json', catalogBytes);
files.set('index.json', json({ schemaVersion: sourceIndex.schemaVersion, datasetId: sourceIndex.datasetId, releaseVersion: sourceIndex.releaseVersion, generated: true,
  assetCatalog: { path: 'asset-index.json', sha256: hash(catalogBytes), bytes: catalogBytes.length }, profiles }));
files.set('projection.json', json({ schemaVersion: 1, generated: true, sourceRelease: sourceIndex.releaseVersion,
  sourceIndexSha256: hash(sourceIndexBytes), sourceManifestSha256: sourceIndex.manifest.sha256,
  excludedProfiles: ['3d', 'seaglass'],
  files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({ path: name, sha256: hash(bytes), bytes: bytes.length })) }));
// Only generated files under this exact component-owned output directory are written.
for (const [name, bytes] of files) {
  const destination = path.join(target, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
}
console.log(JSON.stringify({ status: 'public-assets-projected', files: files.size, bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) }));
