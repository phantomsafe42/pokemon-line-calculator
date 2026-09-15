const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PATH_PART = /^[A-Za-z0-9._-]+$/u;

export const HOSTED_DATASET_RELEASE = Object.freeze({
  origin: "https://datasets.phantomsafe.tv",
  releaseVersion: "0.1.13",
  profileId: "plc",
  profileSchemaVersion: "pokemon-line-calculator-dataset/v1alpha1",
  sourceCommit: "e34dac2f52fef633c2009fe48ef8db7685d6d965",
  sourceTag: "v0.1.13",
  catalog: Object.freeze({
    bytes: 1633,
    sha256: "ab794f6ddc788ad2facf5b31735253a0a5029e1eac033bcf5a5c3da327094b65"
  }),
  manifest: Object.freeze({
    bytes: 85053,
    sha256: "05016b02e051779ebe4dde274d3efc2c6b5ead7dce7e5f40e5e18a6429c20ae9"
  }),
  payload: Object.freeze({
    files: 332,
    bytes: 313915484,
    treeSha256: "ea5d75ce1166107f0db37497b46a237ba73e3d6373ed6b427b07c5ef826d7fb9"
  })
});

export class DatasetDeliveryError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "DatasetDeliveryError";
  }
}

const promiseMaps = new WeakMap();

function promiseMap(fetchImpl) {
  let map = promiseMaps.get(fetchImpl);
  if (!map) {
    map = new Map();
    promiseMaps.set(fetchImpl, map);
  }
  return map;
}

function normalizeSha256(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!HEX_SHA256.test(normalized)) throw new DatasetDeliveryError(`${label} has an invalid SHA-256`);
  return normalized;
}

function normalizeRelativePath(value, label = "Dataset path") {
  const text = String(value || "");
  const parts = text.split("/");
  if (!text || text.startsWith("/") || text.includes("\\") || parts.some(part => !part || !SAFE_PATH_PART.test(part))) {
    throw new DatasetDeliveryError(`${label} is unsafe`);
  }
  return parts.join("/");
}

function normalizedRelease(release) {
  const value = release || HOSTED_DATASET_RELEASE;
  const origin = new URL(value.origin);
  const loopbackHttp = origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if ((!loopbackHttp && origin.protocol !== "https:") || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new DatasetDeliveryError("Hosted Dataset origin must be HTTPS or direct HTTP loopback");
  }
  const releaseVersion = String(value.releaseVersion || "");
  if (!/^\d+\.\d+\.\d+$/u.test(releaseVersion)) throw new DatasetDeliveryError("Hosted Dataset release is invalid");
  const profileId = normalizeRelativePath(value.profileId, "Hosted Dataset profile");
  if (profileId.includes("/") || profileId.endsWith("-local")) throw new DatasetDeliveryError("Hosted Dataset profile must be public");
  return {
    ...value,
    origin: origin.origin,
    releaseVersion,
    profileId,
    catalog: { bytes: Number(value.catalog?.bytes), sha256: normalizeSha256(value.catalog?.sha256, "Dataset catalog") },
    manifest: { bytes: Number(value.manifest?.bytes), sha256: normalizeSha256(value.manifest?.sha256, "Dataset manifest") },
    payload: {
      files: Number(value.payload?.files),
      bytes: Number(value.payload?.bytes),
      treeSha256: normalizeSha256(value.payload?.treeSha256, "Dataset payload tree")
    }
  };
}

function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) throw new DatasetDeliveryError("SHA-256 verification is unavailable in this browser");
  return globalThis.crypto.subtle.digest("SHA-256", bytes).then(digest =>
    [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("")
  );
}

function descriptor(value, label) {
  const bytes = Number(value?.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new DatasetDeliveryError(`${label} has an invalid byte length`);
  return { bytes, sha256: normalizeSha256(value?.sha256, label), contentType: value?.contentType || "application/json" };
}

async function verifiedResponseBytes(response, expected, label) {
  if (!response?.ok) throw new DatasetDeliveryError(`${label} returned HTTP ${response?.status ?? "unknown"}`);
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw new DatasetDeliveryError(`${label} returned an unsupported content type`);
  const declaredBytes = response.headers?.get?.("x-content-length");
  const declaredSha = response.headers?.get?.("x-content-sha256");
  if (declaredBytes && Number(declaredBytes) !== expected.bytes) throw new DatasetDeliveryError(`${label} length header does not match its lock`);
  if (declaredSha && String(declaredSha).toLowerCase() !== expected.sha256) throw new DatasetDeliveryError(`${label} digest header does not match its lock`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== expected.bytes) throw new DatasetDeliveryError(`${label} length does not match its lock`);
  if (await sha256Hex(bytes) !== expected.sha256) throw new DatasetDeliveryError(`${label} digest does not match its lock`);
  return bytes;
}

function cacheName(release) {
  return `plc-dataset-${release.releaseVersion}-${release.profileId}-${release.manifest.sha256.slice(0, 16)}`;
}

async function openCache(cacheStorage, release) {
  if (!cacheStorage?.open) return null;
  try { return await cacheStorage.open(cacheName(release)); }
  catch { return null; }
}

async function verifiedHostedBytes({ url, expected, label, release, fetchImpl, cacheStorage }) {
  const map = promiseMap(fetchImpl);
  const key = `${cacheName(release)}|${url}|${expected.sha256}`;
  if (map.has(key)) return map.get(key);
  const pending = (async () => {
    const cache = await openCache(cacheStorage, release);
    if (cache) {
      try {
        const cached = await cache.match(url);
        if (cached) return await verifiedResponseBytes(cached, expected, label);
      } catch {
        try { await cache.delete(url); } catch { /* cache repair is best-effort */ }
      }
    }
    const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
    const bytes = await verifiedResponseBytes(response, expected, label);
    if (cache) {
      try {
        const headers = new Headers(response.headers);
        await cache.put(url, new Response(bytes.slice(0), { status: 200, headers }));
      } catch { /* an unavailable browser cache must not invalidate verified bytes */ }
    }
    return bytes;
  })();
  map.set(key, pending);
  try { return await pending; }
  catch (error) {
    map.delete(key);
    throw error;
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch (error) { throw new DatasetDeliveryError(`${label} is not valid JSON`, { cause: error }); }
}

function assertReleaseIdentity(document, release, label) {
  if (document?.dataset?.releaseVersion !== release.releaseVersion
    || document?.dataset?.sourceCommit !== release.sourceCommit
    || document?.dataset?.sourceTag !== release.sourceTag) {
    throw new DatasetDeliveryError(`${label} does not match the pinned Dataset release`);
  }
  if (document.publicationStatus !== "published-on-completion-marker") {
    throw new DatasetDeliveryError(`${label} is not a completed hosted release`);
  }
}

async function treeSha256(files) {
  const rows = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(file => `${file.path}\0${file.bytes}\0${file.sha256}\n`)
    .join("");
  return sha256Hex(new TextEncoder().encode(rows));
}

export async function loadHostedDatasetProfile({
  release: configuredRelease = HOSTED_DATASET_RELEASE,
  fetchImpl = fetch,
  cacheStorage = globalThis.caches
} = {}) {
  const release = normalizedRelease(configuredRelease);
  const catalogUrl = `${release.origin}/v1/releases/${release.releaseVersion}/catalog`;
  const catalogBytes = await verifiedHostedBytes({
    url: catalogUrl,
    expected: descriptor(release.catalog, "Dataset catalog"),
    label: "Dataset catalog",
    release,
    fetchImpl,
    cacheStorage
  });
  const catalog = parseJson(catalogBytes, "Dataset catalog");
  if (catalog.schemaVersion !== "pokemon-dataset-hosted-catalog/v1") throw new DatasetDeliveryError("Unsupported Dataset catalog schema");
  assertReleaseIdentity(catalog, release, "Dataset catalog");
  const entry = catalog.profiles?.find(profile => profile.profileId === release.profileId);
  if (!entry || entry.profileSchemaVersion !== release.profileSchemaVersion || entry.intendedConsumer !== "plc") {
    throw new DatasetDeliveryError("Dataset catalog does not expose the pinned PLC profile");
  }
  if (String(entry.manifestSha256).toLowerCase() !== release.manifest.sha256
    || String(entry.payloadTreeSha256).toLowerCase() !== release.payload.treeSha256
    || Number(entry.files) !== release.payload.files
    || Number(entry.bytes) !== release.payload.bytes) {
    throw new DatasetDeliveryError("Dataset catalog PLC profile does not match its lock");
  }
  const manifestUrl = `${release.origin}/v1/releases/${release.releaseVersion}/profiles/${release.profileId}/manifest`;
  const manifestBytes = await verifiedHostedBytes({
    url: manifestUrl,
    expected: descriptor(release.manifest, "Dataset profile manifest"),
    label: "Dataset profile manifest",
    release,
    fetchImpl,
    cacheStorage
  });
  const manifest = parseJson(manifestBytes, "Dataset profile manifest");
  if (manifest.schemaVersion !== "pokemon-dataset-hosted-profile/v1"
    || manifest.profileId !== release.profileId
    || manifest.profileSchemaVersion !== release.profileSchemaVersion
    || manifest.visibility !== "public"
    || manifest.intendedConsumer !== "plc"
    || manifest.filesRoot !== "files") {
    throw new DatasetDeliveryError("Dataset profile manifest does not match the public PLC contract");
  }
  assertReleaseIdentity(manifest, release, "Dataset profile manifest");
  if (!Array.isArray(manifest.files) || manifest.files.length !== release.payload.files) throw new DatasetDeliveryError("Dataset profile file count does not match its lock");
  const files = new Map();
  let totalBytes = 0;
  for (const file of manifest.files) {
    const path = normalizeRelativePath(file.path, "Hosted Dataset file");
    if (files.has(path)) throw new DatasetDeliveryError(`Duplicate hosted Dataset file ${path}`);
    const expected = descriptor(file, `Hosted Dataset file ${path}`);
    if (!String(file.contentType || "").toLowerCase().startsWith("application/json")) throw new DatasetDeliveryError(`Hosted Dataset file ${path} is not JSON`);
    files.set(path, expected);
    totalBytes += expected.bytes;
  }
  if (totalBytes !== release.payload.bytes
    || String(manifest.payloadTreeSha256).toLowerCase() !== release.payload.treeSha256
    || await treeSha256([...files].map(([path, value]) => ({ path, ...value }))) !== release.payload.treeSha256) {
    throw new DatasetDeliveryError("Dataset profile payload tree does not match its lock");
  }
  return Object.freeze({ release, manifest, files });
}

async function readFallbackJsonFiles({ baseUrl, paths, fetchImpl }) {
  const root = String(baseUrl || "").replace(/\/$/u, "");
  const entries = await Promise.all(paths.map(async path => {
    const response = await fetchImpl(`${root}/${path}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new DatasetDeliveryError(`${path} fallback returned HTTP ${response.status}`);
    return [path, await response.json()];
  }));
  return Object.fromEntries(entries);
}

async function readHostedJsonFiles({ profile, prefix, paths, fetchImpl, cacheStorage }) {
  const safePrefix = normalizeRelativePath(prefix, "Hosted Dataset prefix");
  const entries = await Promise.all(paths.map(async path => {
    const safePath = normalizeRelativePath(path);
    const profilePath = `${safePrefix}/${safePath}`;
    const expected = profile.files.get(profilePath);
    if (!expected) throw new DatasetDeliveryError(`${profilePath} is absent from the pinned Dataset profile`);
    const url = `${profile.release.origin}/v1/releases/${profile.release.releaseVersion}/profiles/${profile.release.profileId}/files/${profilePath}`;
    const bytes = await verifiedHostedBytes({
      url,
      expected,
      label: profilePath,
      release: profile.release,
      fetchImpl,
      cacheStorage
    });
    return [path, parseJson(bytes, profilePath)];
  }));
  return Object.fromEntries(entries);
}

export async function readDatasetJsonFiles({
  fallbackBaseUrl,
  hostedPrefix,
  paths,
  release = HOSTED_DATASET_RELEASE,
  fetchImpl = fetch,
  cacheStorage = globalThis.caches
}) {
  let profile = null;
  let hostedError = null;
  try {
    profile = await loadHostedDatasetProfile({ release, fetchImpl, cacheStorage });
    const documents = await readHostedJsonFiles({ profile, prefix: hostedPrefix, paths, fetchImpl, cacheStorage });
    return {
      documents,
      delivery: Object.freeze({ mode: "hosted", releaseVersion: profile.release.releaseVersion, profileId: profile.release.profileId })
    };
  } catch (error) {
    hostedError = error;
  }
  try {
    const documents = await readFallbackJsonFiles({ baseUrl: fallbackBaseUrl, paths, fetchImpl });
    return {
      documents,
      delivery: Object.freeze({
        mode: profile ? "checked-in-last-known-good" : "checked-in-offline",
        releaseVersion: release.releaseVersion,
        profileId: release.profileId,
        hostedError: String(hostedError?.message || hostedError || "Hosted Dataset unavailable")
      })
    };
  } catch (fallbackError) {
    throw new DatasetDeliveryError(
      `Hosted Dataset failed (${hostedError?.message || hostedError}); checked-in fallback failed (${fallbackError?.message || fallbackError})`,
      { cause: fallbackError }
    );
  }
}
