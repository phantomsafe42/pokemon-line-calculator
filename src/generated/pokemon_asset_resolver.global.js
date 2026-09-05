(function installPokemonAssetResolver(global) {
  "use strict";

  const API_VERSION = "pokemon-asset-resolver/v3";
  const ROOT_INDEX_PATH = "index.json";
  const PROFILE_BY_TYPE = Object.freeze({
    pixel: "pixel",
    icon: "pixel",
    "g5-static": "gen5-static",
    "gen5-static": "gen5-static",
    "g5-animated": "gen5-animated",
    "g5-anim": "gen5-animated",
    "gen5-animated": "gen5-animated",
    "gen5-anim": "gen5-animated",
    "3d": "3d",
    seaglass: "seaglass"
  });
  const pendingImageQueries = new Map();
  let nextImageToken = 1;

  function normalizeToken(value) {
    return String(value ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/♀/g, " female ")
      .replace(/♂/g, " male ")
      .replace(/\balolan\b/g, "alola")
      .replace(/\bgalarian\b/g, "galar")
      .replace(/\bhisuian\b/g, "hisui")
      .replace(/\bpaldean\b/g, "paldea")
      .replace(/\bforme?\b/g, "")
      .replace(/\bfemale\b/g, "female")
      .replace(/\bmale\b/g, "male")
      .replace(/[^a-z0-9]+/g, "");
  }

  function normalizeGender(value) {
    const token = normalizeToken(value);
    if (!token || token === "default" || token === "neutral" || token === "genderless" || token === "none" || token === "n") return "default";
    if (token === "female" || token === "f") return "female";
    if (token === "male" || token === "m") return "male";
    return token;
  }

  function normalizeSpriteType(value) {
    const token = String(value || "").toLowerCase().trim();
    if (!PROFILE_BY_TYPE[token]) return null;
    return token;
  }

  function variantKeyFor(query, spriteType) {
    const iconRequested = spriteType === "icon" || String(query.kind || "").toLowerCase() === "icon";
    if (iconRequested) {
      if (query.shiny) return null;
      return Number(query.iconFrame || query.frame || 1) === 2 ? "iconFrame2" : "iconFrame1";
    }
    const view = String(query.view || (query.back ? "back" : "front")).toLowerCase() === "back" ? "Back" : "Front";
    return `${query.shiny ? "shiny" : "normal"}${view}`;
  }

  function normalizeTypeIconQuery(query = {}) {
    const presentationToken = String(query.presentation || query.format || "symbol").toLowerCase().trim();
    const presentation = presentationToken === "name" || presentationToken === "label" ? "name" : presentationToken === "symbol" || presentationToken === "icon" ? "symbol" : null;
    if (!presentation) return null;
    const family = String(query.family || "").toLowerCase().trim();
    let style = String(query.style || "").toLowerCase().trim();
    let state = String(query.state || (query.tera ? "tera" : "standard")).toLowerCase().trim();
    if (!style && family) {
      if (family === "sv-tera") { style = "sv"; state = "tera"; }
      else style = family;
    }
    style ||= "sv";
    const styleToken = normalizeToken(style);
    if (style === "bdsp/la" || ["la", "legendsarceus", "bdspla"].includes(styleToken)) style = "bdsp-la";
    if (["pokemonhome", "home3", "home30"].includes(styleToken)) style = "home";
    if (!['bdsp-la', 'bdsp', 'home', 'sv'].includes(style) || !['standard', 'tera'].includes(state)) return null;
    const type = normalizeToken(query.type || query.typeId || query.name);
    if (!type) return null;
    const locale = presentation === "symbol" ? "und" : String(query.locale || "en").toLowerCase().trim();
    return { presentation, style, state, locale, type };
  }

  function normalizeItemSpriteQuery(query = {}) {
    const rawItem = query.item ?? query.itemId ?? query.name;
    if (rawItem === undefined || rawItem === null) return null;
    const item = normalizeToken(rawItem);
    if (!item || ["0", "none", "noitem", "empty", "null"].includes(item)) return { absent: true };
    const styleToken = normalizeToken(query.style || query.spriteStyle || "showdown");
    const style = ["showdown", "pokemonshowdown", "smogon"].includes(styleToken) ? "showdown" : null;
    if (!style) return null;
    return { style, item };
  }

  function normalizeStatusConditionIconQuery(query = {}) {
    const styleToken = normalizeToken(query.style || query.game || query.family);
    let style = null;
    if (["bdsp", "brilliantdiamond", "shiningpearl", "brilliantdiamondshiningpearl"].includes(styleToken)) style = "bdsp";
    if (["za", "legendsza", "pokemonlegendsza"].includes(styleToken)) style = "za";
    if (!style) return null;
    const conditionToken = normalizeToken(query.condition || query.status || query.conditionId || query.name);
    const conditionAliases = {
      fainted: "fainted", faint: "fainted", ko: "fainted", knockedout: "fainted",
      paralysis: "paralysis", paralyzed: "paralysis", paralysed: "paralysis", par: "paralysis",
      asleep: "asleep", sleep: "asleep", slp: "asleep",
      drowsy: "drowsy", drowsiness: "drowsy",
      frozen: "frozen", freeze: "frozen", frz: "frozen",
      burned: "burned", burnt: "burned", burn: "burned", brn: "burned",
      poisoned: "poisoned", poison: "poisoned", psn: "poisoned",
      badlypoisoned: "badly-poisoned", badpoison: "badly-poisoned", toxic: "badly-poisoned", tox: "badly-poisoned"
    };
    const condition = conditionAliases[conditionToken];
    if (!condition) return null;
    if ((style === "bdsp" && condition === "drowsy") || (style === "za" && condition === "asleep")) return null;
    return { style, condition };
  }

  function trimBaseUrl(value) {
    const result = String(value || "").trim().replace(/\/+$/, "");
    if (!result || /<owner>|<asset-repo>|<immutable-tag>|__POKEMON_ASSET_RELEASE_BASE__/i.test(result)) return null;
    return result;
  }

  function configuredReleaseBase(documentObject = global.document) {
    const explicit = trimBaseUrl(global.POKEMON_ASSET_RELEASE_BASE);
    if (explicit) return explicit;
    return trimBaseUrl(documentObject?.querySelector?.('meta[name="pokemon-asset-release-base"]')?.content);
  }

  function joinReleaseUrl(baseUrl, relativePath) {
    const base = trimBaseUrl(baseUrl);
    if (!base) return null;
    const path = String(relativePath || "").replace(/^\/+/, "");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) return new URL(path, `${base}/`).href;
    return `${base}/${path}`;
  }

  function bytesToHex(bytes) {
    return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  }

  async function sha256Hex(bytes) {
    if (!global.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable; asset indexes cannot be verified.");
    return bytesToHex(new Uint8Array(await global.crypto.subtle.digest("SHA-256", bytes)));
  }

  function jsonFromBytes(bytes, url) {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new Error(`Pokemon asset JSON is invalid at ${url}: ${error.message}`);
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function candidateDetails([appearanceId, record]) {
    return {
      appearanceId,
      record,
      key: normalizeToken(appearanceId),
      appearance: normalizeToken(record.appearanceId),
      species: normalizeToken(record.speciesId),
      baseSpecies: normalizeToken(record.baseSpeciesId),
      display: normalizeToken(record.displayName),
      form: normalizeToken(record.formId || "base"),
      isDefaultForm: record.isDefaultForm === true,
      nationalDex: Number(record.nationalDex || 0),
      gameSpeciesId: Number(record.gameSpeciesId || 0),
      romSha256: String(record.romSha256 || "").toLowerCase()
    };
  }

  function exactAppearance(index, requestedId) {
    if (!requestedId) return null;
    const raw = String(requestedId);
    const aliased = index.aliases?.[raw] || index.aliases?.[normalizeToken(raw)] || raw;
    if (index.appearances?.[aliased]) return [aliased, index.appearances[aliased]];
    const token = normalizeToken(aliased);
    const matches = Object.entries(index.appearances || {}).filter(([id, record]) =>
      normalizeToken(id) === token || normalizeToken(record.appearanceId) === token
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function scoreCandidate(candidate, query) {
    const requestedSpecies = normalizeToken(query.species || query.name || query.speciesId);
    const requestedForm = normalizeToken(query.form || query.formId);
    const requestedDex = Number(query.nationalDex || query.dexNo || 0);
    if (requestedDex && candidate.nationalDex !== requestedDex) return -1;
    if (!requestedSpecies && !requestedDex) return -1;

    let score = requestedDex ? 80 : 0;
    if (requestedSpecies) {
      if (candidate.key === requestedSpecies || candidate.appearance === requestedSpecies) score += 500;
      if (candidate.display === requestedSpecies) score += 480;
      if (candidate.species === requestedSpecies || candidate.baseSpecies === requestedSpecies) score += 260;
      const combined = [
        `${requestedSpecies}${requestedForm}`,
        `${requestedForm}${requestedSpecies}`
      ];
      if (requestedForm && combined.includes(candidate.key)) score += 520;
      if (requestedForm && combined.includes(candidate.appearance)) score += 510;
      if (!score && !requestedDex) return -1;
    }

    if (requestedForm) {
      if (candidate.form === requestedForm) score += 240;
      else if (candidate.key.includes(requestedForm) || candidate.appearance.includes(requestedForm) || candidate.display.includes(requestedForm)) score += 120;
      else return -1;
    } else if (candidate.isDefaultForm) {
      score += 220;
    } else if (candidate.form === "base" || !candidate.form) {
      score += 90;
    }
    return score;
  }

  function findAppearance(index, query) {
    const exact = exactAppearance(index, query.appearanceId || query.canonicalAppearanceId);
    if (exact) return { status: "ok", appearanceId: exact[0], record: exact[1] };

    const gameSpeciesId = Number(query.gameSpeciesId || query.gameAppearanceId || 0);
    if (gameSpeciesId) {
      const romSha256 = String(query.romSha256 || "").toLowerCase();
      const matches = Object.entries(index.appearances || {}).filter((entry) => {
        const candidate = candidateDetails(entry);
        return candidate.gameSpeciesId === gameSpeciesId && (!romSha256 || candidate.romSha256 === romSha256);
      });
      if (matches.length === 1) return { status: "ok", appearanceId: matches[0][0], record: matches[0][1] };
      return { status: "unavailable", reason: matches.length ? "ambiguous-game-species" : "appearance-not-found" };
    }

    const scored = Object.entries(index.appearances || {})
      .map(entry => ({ entry, score: scoreCandidate(candidateDetails(entry), query) }))
      .filter(item => item.score >= 0)
      .sort((left, right) => right.score - left.score || left.entry[0].localeCompare(right.entry[0]));
    if (!scored.length) return { status: "unavailable", reason: "appearance-not-found" };
    if (scored.length > 1 && scored[0].score === scored[1].score) {
      return { status: "unavailable", reason: "ambiguous-appearance", candidates: scored.filter(item => item.score === scored[0].score).map(item => item.entry[0]) };
    }
    return { status: "ok", appearanceId: scored[0].entry[0], record: scored[0].entry[1] };
  }

  function selectGenderVariant(record, requestedGender, variantKey) {
    const variants = record?.variants || {};
    const keys = Object.keys(variants).filter(key => variants[key]?.[variantKey]);
    if (!keys.length) return { status: "unavailable", reason: "gender-variants-missing" };
    const gender = normalizeGender(requestedGender);
    if (gender !== "default" && keys.includes(gender)) return { status: "ok", genderVariant: gender, variants: variants[gender], genderResolution: "requested" };
    if (keys.includes("default")) return { status: "ok", genderVariant: "default", variants: variants.default, genderResolution: gender === "default" ? "default" : "shared-default" };
    if (gender === "default") {
      const selected = keys.includes("male") ? "male" : keys.includes("female") ? "female" : [...keys].sort()[0];
      return { status: "ok", genderVariant: selected, variants: variants[selected], genderResolution: `defaulted-${selected}` };
    }
    if (keys.length === 1) return { status: "ok", genderVariant: keys[0], variants: variants[keys[0]], genderResolution: `fixed-${keys[0]}` };
    return { status: "unavailable", reason: "gender-variant-not-found", availableGenders: keys };
  }

  function createResolver(options = {}) {
    const fetcher = options.fetch || global.fetch?.bind(global);
    let baseUrl = trimBaseUrl(options.baseUrl) || configuredReleaseBase(options.document);
    let rootPromise = null;
    let catalogPromise = null;
    const profilePromises = new Map();
    const collectionPromises = new Map();
    const diagnostics = {
      apiVersion: API_VERSION,
      releaseBase: baseUrl,
      releaseVersion: null,
      loadedProfiles: [],
      loadedCollections: [],
      resolved: 0,
      fallbacks: 0,
      unavailable: 0,
      errors: []
    };

    async function loadJson(relativePath, expectedSha256 = null) {
      if (!fetcher) throw new Error("Fetch is unavailable; Pokemon assets cannot be loaded.");
      const url = joinReleaseUrl(baseUrl, relativePath);
      if (!url) throw new Error("Pokemon asset release base is not configured.");
      const response = await fetcher(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Pokemon asset request failed (${response.status}) at ${url}`);
      const bytes = await response.arrayBuffer();
      if (expectedSha256) {
        const actual = await sha256Hex(bytes);
        if (actual !== String(expectedSha256).toLowerCase()) throw new Error(`Pokemon asset index integrity failed at ${url}`);
      }
      return jsonFromBytes(bytes, url);
    }

    async function loadRoot() {
      if (!rootPromise) {
        rootPromise = loadJson(ROOT_INDEX_PATH).then(index => {
          if (index.datasetId !== "pokemon-assets" || !Array.isArray(index.profiles) || !index.assetCatalog?.path) throw new Error("Pokemon asset root index has an unsupported contract.");
          diagnostics.releaseVersion = index.releaseVersion;
          return index;
        }).catch(error => {
          rootPromise = null;
          diagnostics.errors.push(error.message);
          throw error;
        });
      }
      return rootPromise;
    }

    async function loadCatalog() {
      if (!catalogPromise) {
        catalogPromise = loadRoot().then(async root => {
          const catalog = await loadJson(root.assetCatalog.path, root.assetCatalog.sha256);
          if (catalog.datasetId !== "pokemon-assets" || catalog.releaseVersion !== root.releaseVersion || !Array.isArray(catalog.collections)) {
            throw new Error("Pokemon typed asset catalog has an unsupported contract.");
          }
          return catalog;
        }).catch(error => {
          catalogPromise = null;
          diagnostics.errors.push(error.message);
          throw error;
        });
      }
      return catalogPromise;
    }

    async function loadCollection(collectionId) {
      if (!collectionPromises.has(collectionId)) {
        collectionPromises.set(collectionId, loadCatalog().then(async catalog => {
          const descriptor = catalog.collections.find(collection => collection.collectionId === collectionId);
          if (!descriptor?.indexPath) throw new Error(`Pokemon asset collection is unavailable: ${collectionId}`);
          const index = await loadJson(descriptor.indexPath, descriptor.indexSha256);
          if (index.collectionId !== collectionId || index.releaseVersion !== catalog.releaseVersion || !Array.isArray(index.selectorFields)) {
            throw new Error(`Pokemon asset collection contract mismatch: ${collectionId}`);
          }
          if (!diagnostics.loadedCollections.includes(collectionId)) diagnostics.loadedCollections.push(collectionId);
          return index;
        }).catch(error => {
          collectionPromises.delete(collectionId);
          diagnostics.errors.push(error.message);
          throw error;
        }));
      }
      return collectionPromises.get(collectionId);
    }

    async function loadProfile(profileId) {
      if (!profilePromises.has(profileId)) {
        profilePromises.set(profileId, loadRoot().then(async root => {
          const descriptor = root.profiles.find(profile => profile.profileId === profileId);
          if (!descriptor) throw new Error(`Pokemon asset profile is unavailable: ${profileId}`);
          const index = await loadJson(descriptor.indexPath, descriptor.indexSha256);
          if (index.profileId !== profileId || index.releaseVersion !== root.releaseVersion) throw new Error(`Pokemon asset profile contract mismatch: ${profileId}`);
          if (!diagnostics.loadedProfiles.includes(profileId)) diagnostics.loadedProfiles.push(profileId);
          return index;
        }).catch(error => {
          profilePromises.delete(profileId);
          diagnostics.errors.push(error.message);
          throw error;
        }));
      }
      return profilePromises.get(profileId);
    }

    async function resolveSingle(query, spriteType) {
      const profileId = PROFILE_BY_TYPE[spriteType];
      const variantKey = variantKeyFor(query, spriteType);
      if (!variantKey) return { status: "unavailable", reason: "shiny-icon-not-supported", profileId, spriteType };
      const index = await loadProfile(profileId);
      const appearance = findAppearance(index, query);
      if (appearance.status !== "ok") return { ...appearance, profileId, spriteType, variantKey };
      const gender = selectGenderVariant(appearance.record, query.gender, variantKey);
      if (gender.status !== "ok") return { ...gender, profileId, spriteType, appearanceId: appearance.appearanceId, variantKey };
      const asset = gender.variants[variantKey];
      if (!asset) return {
        status: "unavailable",
        reason: "variant-not-found",
        profileId,
        spriteType,
        appearanceId: appearance.appearanceId,
        genderVariant: gender.genderVariant,
        variantKey
      };
      return {
        status: "ok",
        apiVersion: API_VERSION,
        releaseVersion: index.releaseVersion,
        profileId,
        spriteType,
        appearanceId: appearance.appearanceId,
        nationalDex: appearance.record.nationalDex ?? null,
        gameSpeciesId: appearance.record.gameSpeciesId ?? null,
        romSha256: appearance.record.romSha256 ?? null,
        genderVariant: gender.genderVariant,
        genderResolution: gender.genderResolution,
        variantKey,
        path: asset.path,
        url: joinReleaseUrl(baseUrl, asset.path),
        sha256: asset.sha256,
        mediaType: asset.mediaType,
        width: asset.width,
        height: asset.height,
        motion: asset.motion,
        fallback: null
      };
    }

    async function resolve(query = {}) {
      const requestedType = normalizeSpriteType(query.spriteType || query.profile || query.kind || "pixel");
      if (!baseUrl) {
        diagnostics.unavailable += 1;
        return { status: "unavailable", reason: "release-base-not-configured", requested: query };
      }
      if (!requestedType) {
        diagnostics.unavailable += 1;
        return { status: "unavailable", reason: "invalid-sprite-type", requested: query };
      }
      const fallbackTypes = Array.isArray(query.fallbackSpriteTypes || query.fallbackProfiles)
        ? (query.fallbackSpriteTypes || query.fallbackProfiles).map(normalizeSpriteType).filter(Boolean)
        : [];
      const attempts = [...new Set([requestedType, ...fallbackTypes])];
      let firstUnavailable = null;
      for (const spriteType of attempts) {
        try {
          const result = await resolveSingle(query, spriteType);
          if (result.status === "ok") {
            diagnostics.resolved += 1;
            if (spriteType !== requestedType) {
              diagnostics.fallbacks += 1;
              result.fallback = { used: true, requestedSpriteType: requestedType, resolvedSpriteType: spriteType, reason: firstUnavailable?.reason || "primary-unavailable" };
            }
            return result;
          }
          firstUnavailable ||= result;
        } catch (error) {
          diagnostics.unavailable += 1;
          return { status: "unavailable", reason: "profile-load-failed", error: error.message, requested: query, spriteType };
        }
      }
      diagnostics.unavailable += 1;
      return { ...(firstUnavailable || { status: "unavailable", reason: "asset-not-found" }), requested: query };
    }

    async function resolveCollectionAsset(collectionId, kind, selectors, query) {
      try {
        const index = await loadCollection(collectionId);
        const key = JSON.stringify(index.selectorFields.map(field => selectors[field]));
        const assetId = index.selectorIndex?.[key];
        const asset = assetId ? index.assets?.[assetId] : null;
        if (!asset) return {
          status: "unavailable",
          reason: "asset-not-found",
          kind,
          selectors,
          requested: query
        };
        const primaryKey = JSON.stringify(index.selectorFields.map(field => asset.selectors[field]));
        return {
          status: "ok",
          apiVersion: API_VERSION,
          releaseVersion: index.releaseVersion,
          kind,
          collectionId: index.collectionId,
          assetId,
          selectors: asset.selectors,
          requestedSelectors: selectors,
          selectorAliasUsed: key !== primaryKey,
          path: asset.path,
          url: joinReleaseUrl(baseUrl, asset.path),
          sha256: asset.sha256,
          mediaType: asset.mediaType,
          width: asset.width,
          height: asset.height,
          motion: asset.motion,
          mainColorHex: asset.mainColorHex || null,
          fallback: null
        };
      } catch (error) {
        return { status: "unavailable", reason: "collection-load-failed", error: error.message, kind, requested: query };
      }
    }

    async function resolveTypeIcon(query = {}) {
      if (!baseUrl) return { status: "unavailable", reason: "release-base-not-configured", requested: query };
      const selectors = normalizeTypeIconQuery(query);
      if (!selectors) return { status: "unavailable", reason: "invalid-type-icon-selectors", requested: query };
      return resolveCollectionAsset("type-icon", "type-icon", selectors, query);
    }

    async function resolveItemSprite(query = {}) {
      if (!baseUrl) return { status: "unavailable", reason: "release-base-not-configured", requested: query };
      const selectors = normalizeItemSpriteQuery(query);
      if (selectors?.absent) return { status: "unavailable", reason: "item-not-present", kind: "item-sprite", requested: query };
      if (!selectors) return { status: "unavailable", reason: "invalid-item-sprite-selectors", requested: query };
      return resolveCollectionAsset("item-sprite", "item-sprite", selectors, query);
    }

    async function resolveStatusConditionIcon(query = {}) {
      if (!baseUrl) return { status: "unavailable", reason: "release-base-not-configured", requested: query };
      const selectors = normalizeStatusConditionIconQuery(query);
      if (!selectors) return { status: "unavailable", reason: "invalid-status-condition-icon-selectors", requested: query };
      return resolveCollectionAsset("status-condition-icon", "status-condition-icon", selectors, query);
    }

    async function resolveAsset(query = {}) {
      const kind = normalizeToken(query.kind || query.assetKind || (query.spriteType ? "pokemon-sprite" : ""));
      let result;
      if (!kind || kind === "pokemonsprite" || kind === "sprite" || kind === "pokemon" || kind === "icon") {
        result = await resolve(query);
        result.kind ||= "pokemon-sprite";
        return result;
      }
      if (kind === "typeicon" || kind === "type") result = await resolveTypeIcon(query);
      else if (kind === "itemsprite" || kind === "itemicon" || kind === "item") result = await resolveItemSprite(query);
      else if (["statusconditionicon", "statusicon", "conditionicon", "statuscondition", "status"].includes(kind)) result = await resolveStatusConditionIcon(query);
      else result = { status: "unavailable", reason: "unknown-asset-kind", kind: query.kind, requested: query };
      if (result.status === "ok") diagnostics.resolved += 1;
      else diagnostics.unavailable += 1;
      return result;
    }

    function applyImageResult(image, result, callbacks = {}) {
      if (result.status === "ok") {
        image.src = result.url;
        image.hidden = false;
        image.style.removeProperty("display");
        image.style.removeProperty("visibility");
        image.dataset.pokemonAssetKind = result.kind || "pokemon-sprite";
        if (result.profileId) image.dataset.pokemonAssetProfile = result.profileId;
        if (result.appearanceId) image.dataset.pokemonAssetAppearance = result.appearanceId;
        if (result.genderVariant) image.dataset.pokemonAssetGender = result.genderVariant;
        if (result.variantKey) image.dataset.pokemonAssetVariant = result.variantKey;
        if (result.collectionId) image.dataset.pokemonAssetCollection = result.collectionId;
        if (result.assetId) image.dataset.pokemonAssetId = result.assetId;
        if (result.fallback) image.dataset.pokemonAssetFallback = `${result.fallback.requestedSpriteType}->${result.fallback.resolvedSpriteType}`;
        else delete image.dataset.pokemonAssetFallback;
        image.onerror = () => {
          image.hidden = true;
          image.dataset.pokemonAssetError = "image-load-failed";
          callbacks.onUnavailable?.({ ...result, status: "unavailable", reason: "image-load-failed" });
        };
        callbacks.onResolved?.(result);
      } else {
        image.removeAttribute("src");
        image.hidden = true;
        image.dataset.pokemonAssetError = result.reason;
        callbacks.onUnavailable?.(result);
      }
    }

    async function setImage(image, query, callbacks = {}) {
      if (!image) return { status: "unavailable", reason: "image-element-missing" };
      const requestId = String(Number(image.dataset.pokemonAssetRequestId || 0) + 1);
      image.dataset.pokemonAssetRequestId = requestId;
      const result = await resolve(query);
      if (image.dataset.pokemonAssetRequestId !== requestId) return { status: "unavailable", reason: "superseded-request" };
      applyImageResult(image, result, callbacks);
      return result;
    }

    async function setAssetImage(image, query, callbacks = {}) {
      if (!image) return { status: "unavailable", reason: "image-element-missing" };
      const requestId = String(Number(image.dataset.pokemonAssetRequestId || 0) + 1);
      image.dataset.pokemonAssetRequestId = requestId;
      const result = await resolveAsset(query);
      if (image.dataset.pokemonAssetRequestId !== requestId) return { status: "unavailable", reason: "superseded-request" };
      applyImageResult(image, result, callbacks);
      return result;
    }

    function bindPendingImage(image) {
      const token = image?.dataset?.pokemonAssetToken;
      if (!token || !pendingImageQueries.has(token)) return;
      const pending = pendingImageQueries.get(token);
      pendingImageQueries.delete(token);
      delete image.dataset.pokemonAssetToken;
      void (pending.generic ? setAssetImage(image, pending.query) : setImage(image, pending.query));
    }

    function observe(root = global.document) {
      if (!root?.querySelectorAll) return null;
      root.querySelectorAll("img[data-pokemon-asset-token]").forEach(bindPendingImage);
      if (!global.MutationObserver) return null;
      const observer = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.("img[data-pokemon-asset-token]")) bindPendingImage(node);
          node.querySelectorAll?.("img[data-pokemon-asset-token]").forEach(bindPendingImage);
        }
      });
      observer.observe(root.documentElement || root, { childList: true, subtree: true });
      return observer;
    }

    function imageHtml(query, attributes = {}) {
      const token = `pokemon-asset-${nextImageToken++}`;
      pendingImageQueries.set(token, { query, generic: false });
      const className = attributes.className ? ` class="${escapeHtml(attributes.className)}"` : "";
      const alt = ` alt="${escapeHtml(attributes.alt || "Pokemon sprite")}"`;
      const title = attributes.title ? ` title="${escapeHtml(attributes.title)}"` : "";
      return `<img${className}${alt}${title} data-pokemon-asset-token="${token}">`;
    }

    function assetHtml(query, attributes = {}) {
      const token = `pokemon-asset-${nextImageToken++}`;
      pendingImageQueries.set(token, { query, generic: true });
      const className = attributes.className ? ` class="${escapeHtml(attributes.className)}"` : "";
      const alt = ` alt="${escapeHtml(attributes.alt || "Pokemon asset")}"`;
      const title = attributes.title ? ` title="${escapeHtml(attributes.title)}"` : "";
      return `<img${className}${alt}${title} data-pokemon-asset-token="${token}">`;
    }

    function configure(nextBaseUrl) {
      const normalized = trimBaseUrl(nextBaseUrl);
      if (!normalized) throw new Error("Pokemon asset release base is invalid.");
      baseUrl = normalized;
      rootPromise = null;
      catalogPromise = null;
      profilePromises.clear();
      collectionPromises.clear();
      diagnostics.releaseBase = normalized;
      diagnostics.releaseVersion = null;
      diagnostics.loadedProfiles = [];
      diagnostics.loadedCollections = [];
    }

    return Object.freeze({
      apiVersion: API_VERSION,
      resolve,
      resolveAsset,
      setImage,
      setAssetImage,
      imageHtml,
      assetHtml,
      observe,
      preload: async spriteType => loadProfile(PROFILE_BY_TYPE[normalizeSpriteType(spriteType)]),
      preloadCollection: loadCollection,
      configure,
      diagnostics: () => JSON.parse(JSON.stringify(diagnostics))
    });
  }

  global.PokemonAssets = Object.freeze({
    apiVersion: API_VERSION,
    createResolver,
    configuredReleaseBase,
    joinReleaseUrl,
    normalizeToken,
    normalizeGender,
    normalizeSpriteType,
    variantKeyFor,
    normalizeTypeIconQuery,
    normalizeItemSpriteQuery,
    normalizeStatusConditionIconQuery
  });
})(globalThis);
