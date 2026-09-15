import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOSTED_DATASET_RELEASE,
  loadHostedDatasetProfile,
  readDatasetJsonFiles
} from "../src/adapters/hosted_dataset.js";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const jsonBytes = value => Buffer.from(JSON.stringify(value));
const treeSha256 = files => sha256(Buffer.from([...files]
  .sort((left, right) => left.path.localeCompare(right.path))
  .map(file => `${file.path}\0${file.bytes}\0${file.sha256}\n`)
  .join("")));

function fixtureRelease({ origin = "https://fixture.invalid", files = { "datasets/game/one.json": { source: "hosted-one" } } } = {}) {
  const releaseVersion = "1.2.3";
  const sourceCommit = "a".repeat(40);
  const sourceTag = "v1.2.3";
  const descriptors = Object.entries(files).map(([path, value]) => {
    const bytes = jsonBytes(value);
    return { path, bytes: bytes.length, sha256: sha256(bytes), contentType: "application/json; charset=utf-8", value, body: bytes };
  });
  const payloadTreeSha256 = treeSha256(descriptors);
  const manifest = {
    schemaVersion: "pokemon-dataset-hosted-profile/v1",
    profileId: "plc",
    profileSchemaVersion: "pokemon-line-calculator-dataset/v1alpha1",
    visibility: "public",
    intendedConsumer: "plc",
    deliveryModes: ["runtime"],
    publicationStatus: "published-on-completion-marker",
    dataset: { releaseVersion, sourceCommit, sourceTag },
    generator: { id: "fixture", version: releaseVersion, contract: "fixture" },
    filesRoot: "files",
    payloadTreeSha256,
    bundles: [{ consumer: "fixture", target: "datasets/game", manifestPath: "datasets/game/generated.json", sourceTreeSha256: "b".repeat(64) }],
    files: descriptors.map(({ path, bytes, sha256, contentType }) => ({ path, bytes, sha256, contentType }))
  };
  const manifestBytes = jsonBytes(manifest);
  const catalog = {
    schemaVersion: "pokemon-dataset-hosted-catalog/v1",
    publicationStatus: "published-on-completion-marker",
    dataset: { releaseVersion, sourceCommit, sourceTag },
    generator: { id: "fixture", version: releaseVersion, contract: "fixture" },
    releaseTreeSha256: "c".repeat(64),
    profiles: [{
      profileId: "plc",
      profileSchemaVersion: manifest.profileSchemaVersion,
      intendedConsumer: "plc",
      deliveryModes: ["runtime"],
      manifestPath: "profiles/plc/manifest.json",
      manifestSha256: sha256(manifestBytes),
      payloadTreeSha256,
      files: descriptors.length,
      bytes: descriptors.reduce((sum, file) => sum + file.bytes, 0)
    }]
  };
  const catalogBytes = jsonBytes(catalog);
  const release = {
    origin,
    releaseVersion,
    profileId: "plc",
    profileSchemaVersion: manifest.profileSchemaVersion,
    sourceCommit,
    sourceTag,
    catalog: { bytes: catalogBytes.length, sha256: sha256(catalogBytes) },
    manifest: { bytes: manifestBytes.length, sha256: sha256(manifestBytes) },
    payload: { files: descriptors.length, bytes: catalog.profiles[0].bytes, treeSha256: payloadTreeSha256 }
  };
  const routes = new Map([
    [`${origin}/v1/releases/${releaseVersion}/catalog`, catalogBytes],
    [`${origin}/v1/releases/${releaseVersion}/profiles/plc/manifest`, manifestBytes],
    ...descriptors.map(file => [`${origin}/v1/releases/${releaseVersion}/profiles/plc/files/${file.path}`, file.body])
  ]);
  return { release, routes, descriptors };
}

function response(bytes, { status = 200, corruptHeaders = false } = {}) {
  const body = Buffer.from(bytes);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-length": String(corruptHeaders ? body.length + 1 : body.length),
      "x-content-sha256": corruptHeaders ? "0".repeat(64) : sha256(body)
    }
  });
}

function fixtureFetch(routes, fallback = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (routes.has(String(url))) return response(routes.get(String(url)));
    const fallbackPath = Object.keys(fallback).find(path => String(url).endsWith(`/${path}`));
    if (fallbackPath) return response(jsonBytes(fallback[fallbackPath]));
    return response(jsonBytes({ error: "missing" }), { status: 404 });
  };
  return { fetchImpl, calls };
}

function memoryCacheStorage() {
  const entries = new Map();
  return {
    entries,
    async open(name) {
      return {
        async match(url) { return entries.get(`${name}|${url}`)?.clone() || undefined; },
        async put(url, value) { entries.set(`${name}|${url}`, value.clone()); },
        async delete(url) { return entries.delete(`${name}|${url}`); }
      };
    }
  };
}

test("runtime hosted Dataset identity matches the repository lock", () => {
  const lock = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../dataset-lock.json", import.meta.url)), "utf8"));
  assert.equal(lock.schemaVersion, "plc-dataset-lock/v2");
  assert.equal(lock.profile, "plc");
  assert.equal(HOSTED_DATASET_RELEASE.origin, lock.hosted.origin);
  assert.equal(HOSTED_DATASET_RELEASE.releaseVersion, lock.releaseVersion);
  assert.equal(HOSTED_DATASET_RELEASE.sourceCommit, lock.commit);
  assert.equal(HOSTED_DATASET_RELEASE.sourceTag, lock.tag);
  assert.deepEqual(HOSTED_DATASET_RELEASE.catalog, lock.hosted.catalog);
  assert.deepEqual(HOSTED_DATASET_RELEASE.manifest, lock.hosted.manifest);
  assert.deepEqual(HOSTED_DATASET_RELEASE.payload, lock.hosted.payload);
  assert.equal(lock.fallback.payloadTreeSha256, lock.hosted.payload.treeSha256);
});

test("runtime origin overrides accept only HTTPS or direct loopback HTTP", async () => {
  const loopback = fixtureRelease({ origin: "http://127.0.0.1:8041" });
  const localFetch = fixtureFetch(loopback.routes);
  const profile = await loadHostedDatasetProfile({ release: loopback.release, fetchImpl: localFetch.fetchImpl, cacheStorage: null });
  assert.equal(profile.release.origin, "http://127.0.0.1:8041");

  const insecure = fixtureRelease({ origin: "http://candidate.example" });
  await assert.rejects(
    loadHostedDatasetProfile({ release: insecure.release, fetchImpl: fixtureFetch(insecure.routes).fetchImpl, cacheStorage: null }),
    /HTTPS or direct HTTP loopback/u
  );
});

test("hosted Dataset profile and files are accepted only after complete integrity validation", async () => {
  const fixture = fixtureRelease({ files: {
    "datasets/game/one.json": { source: "hosted-one" },
    "datasets/game/two.json": { source: "hosted-two" }
  } });
  const { fetchImpl, calls } = fixtureFetch(fixture.routes);
  const profile = await loadHostedDatasetProfile({ release: fixture.release, fetchImpl, cacheStorage: null });
  assert.equal(profile.files.size, 2);
  const result = await readDatasetJsonFiles({
    fallbackBaseUrl: "https://fallback.invalid/datasets/game",
    hostedPrefix: "datasets/game",
    paths: ["one.json", "two.json"],
    release: fixture.release,
    fetchImpl,
    cacheStorage: null
  });
  assert.equal(result.delivery.mode, "hosted");
  assert.deepEqual(result.documents, { "one.json": { source: "hosted-one" }, "two.json": { source: "hosted-two" } });
  assert.equal(calls.filter(url => url.endsWith("/catalog")).length, 1);
  assert.equal(calls.filter(url => url.endsWith("/manifest")).length, 1);
});

test("one corrupt hosted file falls back for the entire requested document set", async () => {
  const fixture = fixtureRelease({ origin: "https://corrupt.invalid", files: {
    "datasets/game/one.json": { source: "hosted-one" },
    "datasets/game/two.json": { source: "hosted-two" }
  } });
  const secondUrl = [...fixture.routes.keys()].find(url => url.endsWith("/datasets/game/two.json"));
  fixture.routes.set(secondUrl, jsonBytes({ source: "corrupt" }));
  const fallback = { "one.json": { source: "fallback-one" }, "two.json": { source: "fallback-two" } };
  const { fetchImpl } = fixtureFetch(fixture.routes, fallback);
  const result = await readDatasetJsonFiles({
    fallbackBaseUrl: "https://fallback.invalid/datasets/game",
    hostedPrefix: "datasets/game",
    paths: ["one.json", "two.json"],
    release: fixture.release,
    fetchImpl,
    cacheStorage: null
  });
  assert.equal(result.delivery.mode, "checked-in-last-known-good");
  assert.deepEqual(result.documents, fallback);
});

test("offline first load uses the checked-in fallback without mixing releases", async () => {
  const fixture = fixtureRelease({ origin: "https://offline.invalid" });
  const fallback = { "one.json": { source: "offline-fallback" } };
  const { fetchImpl } = fixtureFetch(new Map(), fallback);
  const result = await readDatasetJsonFiles({
    fallbackBaseUrl: "https://fallback.invalid/datasets/game",
    hostedPrefix: "datasets/game",
    paths: ["one.json"],
    release: fixture.release,
    fetchImpl,
    cacheStorage: null
  });
  assert.equal(result.delivery.mode, "checked-in-offline");
  assert.deepEqual(result.documents, fallback);
});

test("release-scoped verified cache avoids repeated hosted downloads", async () => {
  const fixture = fixtureRelease({ origin: "https://cache.invalid" });
  const cacheStorage = memoryCacheStorage();
  const first = fixtureFetch(fixture.routes);
  await readDatasetJsonFiles({
    fallbackBaseUrl: "https://fallback.invalid/datasets/game",
    hostedPrefix: "datasets/game",
    paths: ["one.json"],
    release: fixture.release,
    fetchImpl: first.fetchImpl,
    cacheStorage
  });
  const second = fixtureFetch(new Map());
  const result = await readDatasetJsonFiles({
    fallbackBaseUrl: "https://fallback.invalid/datasets/game",
    hostedPrefix: "datasets/game",
    paths: ["one.json"],
    release: fixture.release,
    fetchImpl: second.fetchImpl,
    cacheStorage
  });
  assert.equal(result.delivery.mode, "hosted");
  assert.equal(second.calls.length, 0);
  assert.ok(cacheStorage.entries.size >= 3);
});

test("profile identity mismatch fails closed to the checked-in release", async () => {
  const fixture = fixtureRelease({ origin: "https://mixed.invalid" });
  const catalogUrl = [...fixture.routes.keys()].find(url => url.endsWith("/catalog"));
  const catalog = JSON.parse(fixture.routes.get(catalogUrl));
  catalog.dataset.releaseVersion = "1.2.4";
  const badCatalog = jsonBytes(catalog);
  fixture.routes.set(catalogUrl, badCatalog);
  fixture.release.catalog = { bytes: badCatalog.length, sha256: sha256(badCatalog) };
  const fallback = { "one.json": { source: "pinned-fallback" } };
  const { fetchImpl } = fixtureFetch(fixture.routes, fallback);
  const result = await readDatasetJsonFiles({
    fallbackBaseUrl: "https://fallback.invalid/datasets/game",
    hostedPrefix: "datasets/game",
    paths: ["one.json"],
    release: fixture.release,
    fetchImpl,
    cacheStorage: null
  });
  assert.equal(result.delivery.mode, "checked-in-offline");
  assert.deepEqual(result.documents, fallback);
});
