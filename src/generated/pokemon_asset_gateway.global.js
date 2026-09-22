(function installPokemonAssetGatewayClient(global) {
  "use strict";

  const API_VERSION = "pokemon-asset-gateway-client/v1";
  const DEFAULT_ORIGIN = "https://assets.phantomsafe.tv";
  const DEFAULT_RELEASE_VERSION = "0.8.0-dev.1";
  const ALLOWED_QUERY_FIELDS = new Set([
    "kind", "assetKind", "species", "nationalDex", "form", "gender", "shiny",
    "view", "back", "spriteType", "profile", "iconFrame", "frame", "appearanceId",
    "gameSpeciesId", "romSha256", "type", "typeId", "name", "presentation", "format",
    "style", "family", "state", "tera", "locale", "item", "itemId", "spriteStyle",
    "condition", "status", "conditionId", "badge", "badgeId", "split", "leader", "game",
    "region", "titleId", "gameId", "title", "size", "logoSize", "extension", "mediaType",
    "trainer", "character", "trainerClass", "category", "gameStyle", "subjectKind",
    "trainerKind", "special", "subject", "spriteSet", "variant", "palette", "edition"
  ]);
  const SLASH_VALUE_FIELDS = new Set(["style", "family", "game", "mediaType"]);
  const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function trimOrigin(value) {
    const result = String(value || "").trim().replace(/\/+$/, "");
    let url;
    try { url = new URL(result); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  }

  function normalizeReleaseVersion(value) {
    const result = String(value || "").trim();
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(result) ? result : null;
  }

  function configuredOrigin(documentObject = global.document) {
    if (owns(global, "POKEMON_ASSET_GATEWAY_ORIGIN")) return trimOrigin(global.POKEMON_ASSET_GATEWAY_ORIGIN);
    const element = documentObject?.querySelector?.('meta[name="pokemon-asset-gateway-origin"]');
    return element ? trimOrigin(element.content) : DEFAULT_ORIGIN;
  }

  function configuredReleaseVersion(documentObject = global.document) {
    if (owns(global, "POKEMON_ASSET_RELEASE_VERSION")) return normalizeReleaseVersion(global.POKEMON_ASSET_RELEASE_VERSION);
    const element = documentObject?.querySelector?.('meta[name="pokemon-asset-release-version"]');
    return element ? normalizeReleaseVersion(element.content) : DEFAULT_RELEASE_VERSION;
  }

  function validatedQuery(query = {}) {
    const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== "");
    if (!entries.length || entries.length > 32) throw new Error("Pokemon asset gateway query is invalid.");
    const result = {};
    for (const [name, value] of entries) {
      if (!ALLOWED_QUERY_FIELDS.has(name) || Array.isArray(value) || (typeof value === "object" && value !== null)) {
        throw new Error(`Pokemon asset gateway field is unsupported: ${name}`);
      }
      const text = String(value);
      if (!text || text.length > 160 || text.normalize("NFC") !== text || /[\\\u0000-\u001f\u007f*]/u.test(text) || text.includes("..")) {
        throw new Error(`Pokemon asset gateway value is invalid: ${name}`);
      }
      if (text.includes("/")) {
        if (!SLASH_VALUE_FIELDS.has(name) || text.includes("//") || !/^[\p{L}\p{N} .:+&'/-]+$/u.test(text)) {
          throw new Error(`Pokemon asset gateway value is invalid: ${name}`);
        }
        if (name === "mediaType" && !/^image\/(?:gif|png|webp)$/iu.test(text)) {
          throw new Error(`Pokemon asset gateway media type is invalid: ${name}`);
        }
      }
      result[name] = typeof value === "boolean" ? (value ? "true" : "false") : text;
    }
    if (result.kind && result.assetKind) throw new Error("Pokemon asset gateway query has two asset kinds.");
    result.kind ||= result.assetKind;
    delete result.assetKind;
    if (!result.kind) throw new Error("Pokemon asset gateway query requires kind.");
    return result;
  }

  function buildAssetUrl(query, options = {}) {
    const origin = owns(options, "origin") ? trimOrigin(options.origin) : configuredOrigin(options.document);
    const releaseVersion = owns(options, "releaseVersion") ? normalizeReleaseVersion(options.releaseVersion) : configuredReleaseVersion(options.document);
    if (!origin || !releaseVersion) throw new Error("Pokemon asset gateway configuration is invalid.");
    const url = new URL(`/v1/releases/${encodeURIComponent(releaseVersion)}/asset`, origin);
    for (const [name, value] of Object.entries(validatedQuery(query))) url.searchParams.set(name, value);
    return url.href;
  }

  function buildCreditsUrl(options = {}) {
    const origin = owns(options, "origin") ? trimOrigin(options.origin) : configuredOrigin(options.document);
    const releaseVersion = owns(options, "releaseVersion") ? normalizeReleaseVersion(options.releaseVersion) : configuredReleaseVersion(options.document);
    if (!origin || !releaseVersion) throw new Error("Pokemon asset gateway configuration is invalid.");
    return new URL(`/v1/releases/${encodeURIComponent(releaseVersion)}/credits`, origin).href;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function createClient(options = {}) {
    const origin = owns(options, "origin") ? trimOrigin(options.origin) : configuredOrigin(options.document);
    const releaseVersion = owns(options, "releaseVersion") ? normalizeReleaseVersion(options.releaseVersion) : configuredReleaseVersion(options.document);
    if (!origin || !releaseVersion) throw new Error("Pokemon asset gateway configuration is invalid.");

    function assetUrl(query) {
      return buildAssetUrl(query, { origin, releaseVersion });
    }

    function creditsUrl() {
      return buildCreditsUrl({ origin, releaseVersion });
    }

    function setAssetImage(image, query, callbacks = {}) {
      if (!image) return { status: "unavailable", reason: "image-element-missing" };
      let url;
      try { url = assetUrl(query); }
      catch (error) {
        const result = { status: "unavailable", reason: "invalid-gateway-query", error: error.message, requested: query };
        callbacks.onUnavailable?.(result);
        return result;
      }
      const result = { status: "ok", apiVersion: API_VERSION, resolution: "gateway-deferred", kind: query.kind || query.assetKind, url, releaseVersion };
      image.src = url;
      image.hidden = false;
      image.onerror = () => {
        image.hidden = true;
        image.dataset && (image.dataset.pokemonAssetError = "image-load-failed");
        callbacks.onUnavailable?.({ ...result, status: "unavailable", reason: "image-load-failed" });
      };
      callbacks.onResolved?.(result);
      return result;
    }

    function assetHtml(query, attributes = {}) {
      const className = attributes.className ? ` class="${escapeHtml(attributes.className)}"` : "";
      const alt = ` alt="${escapeHtml(attributes.alt || "Pokemon asset")}"`;
      const title = attributes.title ? ` title="${escapeHtml(attributes.title)}"` : "";
      return `<img${className}${alt}${title} src="${escapeHtml(assetUrl(query))}">`;
    }

    return Object.freeze({
      apiVersion: API_VERSION,
      origin,
      releaseVersion,
      assetUrl,
      creditsUrl,
      resolve: query => ({ status: "ok", apiVersion: API_VERSION, resolution: "gateway-deferred", kind: "pokemon-sprite", url: assetUrl({ ...query, kind: "pokemon-sprite" }), releaseVersion }),
      resolveAsset: query => ({ status: "ok", apiVersion: API_VERSION, resolution: "gateway-deferred", kind: query.kind || query.assetKind, url: assetUrl(query), releaseVersion }),
      setImage: (image, query, callbacks) => setAssetImage(image, { ...query, kind: "pokemon-sprite" }, callbacks),
      setAssetImage,
      imageHtml: (query, attributes) => assetHtml({ ...query, kind: "pokemon-sprite" }, { alt: "Pokemon sprite", ...attributes }),
      assetHtml,
    });
  }

  global.PokemonAssetGateway = Object.freeze({
    apiVersion: API_VERSION,
    defaultOrigin: DEFAULT_ORIGIN,
    defaultReleaseVersion: DEFAULT_RELEASE_VERSION,
    configuredOrigin,
    configuredReleaseVersion,
    buildAssetUrl,
    buildCreditsUrl,
    createClient,
  });
})(globalThis);
