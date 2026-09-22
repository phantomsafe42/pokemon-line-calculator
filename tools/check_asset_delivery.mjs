import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'asset-lock.json')));
const commonGit = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true }).trim();
const authority = path.resolve(path.dirname(commonGit), '../../Datasets/Pokemon Assets');
const read = file => execFileSync('git', ['-C', authority, 'show', `${lock.release.commit}:release/${file}`], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
await import('../src/generated/pokemon_asset_resolver.global.js');
await import('../src/generated/pokemon_asset_gateway.global.js');
const resolver = globalThis.PokemonAssets.createResolver({ baseUrl: 'https://assets.invalid', fetch: async url => {
  const file = decodeURIComponent(new URL(url).pathname.slice(1));
  assert.ok(file && !file.includes('..'));
  return new Response(read(file));
} });
const gateway = globalThis.PokemonAssetGateway.createClient({ origin: lock.gateway.origin, releaseVersion: lock.release.version });
const queries = [
  ...['physical', 'special', 'status'].map(category => ({ kind: 'move-category-icon', category })),
  ...['Mirskle', 'Vega', 'Alice', 'Mel', 'Galavan', 'Big Mo', 'Tessy', 'Benjamin', 'Maxima', 'elite-four'].map(badge => ({ kind: 'badge-icon', game: 'pokemon-unbound', badge })),
  ...['Cilan', 'Lenora', 'Brycen', 'Iris'].map(badge => ({ kind: 'badge-icon', game: 'white', style: 'b2w2-unova', badge })),
  { kind: 'badge-icon', game: 'white-2', style: 'b2w2-unova', badge: 'Iris' },
  ...['master-ball', 'poke-ball'].map(item => ({ kind: 'item-sprite', style: 'showdown', item })),
];
const results = [];
for (const query of queries) {
  const local = await resolver.resolveAsset(query);
  assert.equal(local.status, 'ok', JSON.stringify({ query, local }));
  if (process.argv.includes('--live')) {
    const response = await fetch(gateway.assetUrl(query), { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, JSON.stringify(query));
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), local.sha256);
    assert.match(response.headers.get('content-type'), /^image\/png/);
  }
  results.push({ query, assetId: local.assetId, width: local.width, height: local.height });
}
const gymIris = results.find(row => row.query.game === 'white' && row.query.badge === 'Iris');
const championIris = results.find(row => row.query.game === 'white-2');
assert.notEqual(gymIris.assetId, championIris.assetId);
console.log(JSON.stringify({ status: 'asset-delivery-valid', live: process.argv.includes('--live'), release: lock.release.version, results }, null, 2));
