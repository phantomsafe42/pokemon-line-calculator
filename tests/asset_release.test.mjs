import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const lock = JSON.parse(fs.readFileSync(new URL('../asset-lock.json', import.meta.url)));
const sandbox = { URL, URLSearchParams };
vm.runInNewContext(fs.readFileSync(new URL('../src/generated/pokemon_asset_gateway.global.js', import.meta.url), 'utf8'), sandbox);
const client = sandbox.PokemonAssetGateway.createClient({ origin: lock.gateway.origin, releaseVersion: lock.release.version });

test('the generated gateway default and the immutable PLC release agree', () => {
  assert.equal(sandbox.PokemonAssetGateway.createClient().releaseVersion, lock.release.version);
  assert.equal(lock.gateway.releaseVersion, lock.release.version);
  assert.equal(lock.release.tag, `v${lock.release.version}`);
});

test('new collections use typed single-asset requests and retain game context', () => {
  for (const query of [
    ...['physical', 'special', 'status'].map(category => ({ kind: 'move-category-icon', category })),
    { kind: 'badge-icon', game: 'pokemon-unbound', badge: 'Maxima' },
    { kind: 'badge-icon', game: 'pokemon-white', badge: 'Iris' },
    { kind: 'badge-icon', game: 'pokemon-white-2', badge: 'Iris' },
    { kind: 'item-sprite', style: 'showdown', item: 'master-ball' },
    { kind: 'item-sprite', style: 'showdown', item: 'poke-ball' },
    { kind: 'pokemon-sprite', species: 'Hippowdon', gender: 'female', shiny: true, view: 'back', spriteType: 'pixel' },
  ]) {
    const url = new URL(client.assetUrl(query));
    assert.equal(url.origin, lock.gateway.origin);
    assert.equal(url.pathname, `/v1/releases/${lock.release.version}/asset`);
    assert.deepEqual(Object.fromEntries(url.searchParams), Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])));
  }
  assert.throws(() => client.assetUrl({ kind: 'item-sprite', path: 'private/index.json' }));
});
