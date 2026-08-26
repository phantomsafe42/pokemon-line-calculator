(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.SharedDamageCalculator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ENGINE_ID = "smogon-calc";
    const ENGINE_VERSION = "0.11.0";
    const REQUIRED_SOURCES = [
        "species.json",
        "moves.json",
        "abilities.json",
        "items.json",
        "natures.json",
        "types.json",
        "trainers.json"
    ];
    const STATS = ["hp", "atk", "def", "spa", "spd", "spe"];
    const STATUS_NAMES = new Set(["slp", "psn", "brn", "frz", "par", "tox"]);

    function toId(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/[♀]/g, "f")
            .replace(/[♂]/g, "m")
            .replace(/[^a-z0-9]+/g, "");
    }

    function title(value) {
        const text = String(value || "");
        return text ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : text;
    }

    function finiteNumber(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function statTable(value, fallback) {
        const input = value || {};
        const aliases = { hp: "hp", at: "atk", atk: "atk", df: "def", def: "def", sa: "spa", spa: "spa", sd: "spd", spd: "spd", sp: "spe", spe: "spe" };
        const output = {};
        for (const [key, normalized] of Object.entries(aliases)) {
            if (input[key] !== undefined && output[normalized] === undefined) output[normalized] = finiteNumber(input[key], fallback);
        }
        for (const stat of STATS) {
            if (output[stat] === undefined && fallback !== undefined) output[stat] = fallback;
        }
        return output;
    }

    function completeStatTable(value) {
        const normalized = statTable(value);
        return STATS.every(stat => Number.isFinite(normalized[stat]));
    }

    function clone(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    function normalizeFraction(value) {
        if (!Array.isArray(value) || value.length !== 2) return value;
        return [finiteNumber(value[0], 0), finiteNumber(value[1], 1)];
    }

    function createCollection(baseCollection, overrides) {
        const map = new Map();
        if (baseCollection && typeof baseCollection[Symbol.iterator] === "function") {
            for (const entry of baseCollection) map.set(toId(entry.id || entry.name), entry);
        }
        for (const entry of overrides) map.set(toId(entry.id || entry.name), Object.freeze(entry));
        return Object.freeze({
            get(id) { return map.get(toId(id)); },
            *[Symbol.iterator]() { yield* map.values(); }
        });
    }

    function sourceRecords(document, kind, gameId) {
        if (!document || Number(document.schemaVersion) !== 1 || document.kind !== kind || document.gameId !== gameId || !document.records || typeof document.records !== "object") {
            throw new Error(`${kind}.json does not match the active dataset contract`);
        }
        return Object.values(document.records);
    }

    function findBase(collection, record) {
        if (!collection) return undefined;
        const candidates = [record.mechanicsBase, record.calcName, record.name, record.id].filter(Boolean);
        for (const candidate of candidates) {
            const found = collection.get(toId(candidate));
            if (found) return found;
        }
        return undefined;
    }

    function recordName(record, fallback) {
        return String(record.calcName || record.name || fallback || record.id || "");
    }

    function buildGeneration(calc, mechanics, documents) {
        const canonical = calc.Generations.get(Number(mechanics.canonicalDataGeneration));
        if (!canonical) throw new Error(`Canonical generation ${mechanics.canonicalDataGeneration} is unavailable`);

        const gameId = mechanics.gameId;
        const abilityRecords = sourceRecords(documents["abilities.json"], "abilities", gameId);
        const itemRecords = sourceRecords(documents["items.json"], "items", gameId);
        const natureRecords = sourceRecords(documents["natures.json"], "natures", gameId);
        const typeRecords = sourceRecords(documents["types.json"], "types", gameId);
        const moveRecords = sourceRecords(documents["moves.json"], "moves", gameId);
        const speciesRecords = sourceRecords(documents["species.json"], "species", gameId);

        const abilities = createCollection(canonical.abilities, abilityRecords.map(record => {
            const base = findBase(canonical.abilities, record) || {};
            return { ...base, kind: "Ability", id: toId(record.id || base.id), name: recordName(record, base.name) };
        }));

        const items = createCollection(canonical.items, itemRecords.map(record => {
            const base = findBase(canonical.items, record) || {};
            return {
                ...base,
                kind: "Item",
                id: toId(record.id || base.id),
                name: recordName(record, base.name),
                ...(record.isBerry !== undefined ? { isBerry: Boolean(record.isBerry) } : {}),
                ...(record.naturalGift ? { naturalGift: { basePower: Number(record.naturalGift.basePower), type: title(record.naturalGift.type) } } : {}),
                ...(record.megaStone ? { megaStone: clone(record.megaStone) } : {})
            };
        }));

        const natures = createCollection(canonical.natures, natureRecords.map(record => {
            const base = findBase(canonical.natures, record) || {};
            return {
                ...base,
                kind: "Nature",
                id: toId(record.id || base.id),
                name: recordName(record, base.name),
                plus: record.boostedStat || record.plus || base.plus,
                minus: record.nerfedStat || record.minus || base.minus
            };
        }));

        const typeById = new Map(typeRecords.map(record => [toId(record.id || record.name), record]));
        const types = createCollection(canonical.types, typeRecords.map(attacking => {
            const base = findBase(canonical.types, attacking) || {};
            const attackId = toId(attacking.id || attacking.name);
            const effectiveness = {};
            for (const defending of typeRecords) {
                const defenderName = recordName(defending);
                const weak = (defending.weak || []).map(toId);
                const resist = (defending.resist || []).map(toId);
                const immune = (defending.immune || []).map(toId);
                effectiveness[defenderName] = immune.includes(attackId) ? 0 : weak.includes(attackId) ? 2 : resist.includes(attackId) ? 0.5 : 1;
            }
            return {
                ...base,
                kind: "Type",
                id: attackId,
                name: recordName(attacking, base.name),
                effectiveness
            };
        }));

        function typeName(value) {
            const record = typeById.get(toId(value));
            return record ? recordName(record) : title(value);
        }

        const moves = createCollection(canonical.moves, moveRecords.map(record => {
            const base = findBase(canonical.moves, record) || {};
            const flags = { ...(base.flags || {}) };
            for (const [flag, enabled] of Object.entries(record.flags || {})) flags[flag] = enabled ? 1 : 0;
            return {
                ...base,
                kind: "Move",
                id: toId(record.id || base.id),
                name: recordName(record, base.name),
                basePower: finiteNumber(record.basePower, finiteNumber(base.basePower, 0)),
                type: typeName(record.type || base.type),
                category: title(record.category || base.category),
                flags,
                target: record.target || base.target,
                priority: finiteNumber(record.priority, finiteNumber(base.priority, 0)),
                ...(record.multihit !== undefined ? { multihit: clone(record.multihit) } : {}),
                ...(record.multiAccuracy !== undefined || record.multiaccuracy !== undefined ? { multiaccuracy: Boolean(record.multiAccuracy ?? record.multiaccuracy) } : {}),
                ...(record.recoil !== undefined ? { recoil: normalizeFraction(record.recoil) } : {}),
                ...(record.drain !== undefined ? { drain: normalizeFraction(record.drain) } : {}),
                ...(record.secondaries !== undefined ? { secondaries: clone(record.secondaries) } : {}),
                ...(record.self !== undefined ? { self: clone(record.self) } : {}),
                ...(record.willCrit !== undefined ? { willCrit: Boolean(record.willCrit) } : {}),
                ...(record.hasCrashDamage !== undefined ? { hasCrashDamage: Boolean(record.hasCrashDamage) } : {}),
                ...(record.overrideOffensiveStat ? { overrideOffensiveStat: record.overrideOffensiveStat } : {}),
                ...(record.overrideDefensiveStat ? { overrideDefensiveStat: record.overrideDefensiveStat } : {}),
                ...(record.overrideOffensivePokemon ? { overrideOffensivePokemon: record.overrideOffensivePokemon } : {}),
                ...(record.overrideDefensivePokemon ? { overrideDefensivePokemon: record.overrideDefensivePokemon } : {}),
                ...(record.breaksProtect !== undefined ? { breaksProtect: Boolean(record.breaksProtect) } : {})
            };
        }));

        const abilityName = value => abilities.get(toId(value))?.name || String(value || "");
        const species = createCollection(canonical.species, speciesRecords.map(record => {
            const base = findBase(canonical.species, record) || {};
            const recordAbilities = Array.isArray(record.abilities) ? record.abilities : Object.values(record.abilities || {});
            const primaryAbility = recordAbilities.length ? abilityName(recordAbilities[0]) : base.abilities?.[0];
            return {
                ...base,
                kind: "Species",
                id: toId(record.id || base.id),
                name: recordName(record, base.name),
                mechanicsName: String(record.mechanicsBase || base.name || recordName(record, base.name)),
                types: (record.types || base.types || []).map(typeName),
                baseStats: statTable(record.baseStats || base.baseStats, 0),
                weightkg: finiteNumber(record.weightKg ?? record.weightkg, base.weightkg),
                ...(record.nfe !== undefined ? { nfe: Boolean(record.nfe) } : {}),
                ...(record.gender ? { gender: record.gender } : {}),
                ...(record.baseSpecies ? { baseSpecies: record.baseSpecies } : {}),
                ...(record.otherFormes ? { otherFormes: clone(record.otherFormes) } : {}),
                ...(primaryAbility ? { abilities: { 0: primaryAbility } } : {})
            };
        }));

        return Object.freeze({
            num: Number(mechanics.damageGeneration),
            abilities,
            items,
            moves,
            species,
            types,
            natures
        });
    }

    function validateMechanics(mechanics, context) {
        if (!mechanics || Number(mechanics.schemaVersion) !== 1 || mechanics.kind !== "battle-mechanics") throw new Error("battle_mechanics.json is missing or has the wrong schema/kind");
        if (mechanics.gameId !== context.gameId) throw new Error("battle_mechanics.json belongs to another game");
        if (mechanics.engine?.id !== ENGINE_ID || mechanics.engine?.version !== ENGINE_VERSION) {
            throw new Error(`Calculator contract must target ${ENGINE_ID} ${ENGINE_VERSION}`);
        }
        if (!Number.isInteger(Number(mechanics.damageGeneration)) || !Number.isInteger(Number(mechanics.canonicalDataGeneration))) {
            throw new Error("Calculator generations are not declared");
        }
        if (!mechanics.mechanicsProfile || mechanics.typeChartSource !== "types.json") {
            throw new Error("Calculator mechanics profile or type chart source is not declared");
        }
        if (mechanics.validation?.status !== "passed" || Number(mechanics.validation?.unresolved || 0) !== 0) {
            throw new Error("Calculator source validation has not passed");
        }
        const validated = new Set(mechanics.validation?.sourceFiles || []);
        const missing = REQUIRED_SOURCES.filter(file => !validated.has(file));
        if (missing.length) throw new Error(`Calculator validation does not cover: ${missing.join(", ")}`);
        const displayedLevelStatBug = mechanics.features?.challengeModeDisplayedLevelStatBug;
        if (displayedLevelStatBug?.enabled === true) {
            for (const field of ["displayedLevelField", "statLevelDeltaMemberField", "suppressionMemberField"]) {
                if (!String(displayedLevelStatBug[field] || "").trim()) {
                    throw new Error(`Challenge displayed-level/stat bug configuration is missing ${field}`);
                }
            }
        }
    }

    function indexTrainers(document, gameId) {
        const records = sourceRecords(document, "trainers", gameId);
        const map = new Map();
        for (const trainer of records) {
            map.set(String(trainer.consumerTrainerId ?? trainer.id), trainer);
        }
        return map;
    }

    function mergeCombatant(displayMon, sourceMon, side, mechanics, runtimeInput) {
        const runtimeDefaults = mechanics.runtimeDefaults?.[side] || {};
        const source = sourceMon || {};
        const display = displayMon || {};
        const observed = runtimeInput || {};
        const hasSource = Boolean(sourceMon);
        const displayedLevelStatBug = mechanics.features?.challengeModeDisplayedLevelStatBug;
        const usesDisplayedLevelStatBug = hasSource && displayedLevelStatBug?.enabled === true;
        const displayedLevelField = usesDisplayedLevelStatBug ? displayedLevelStatBug.displayedLevelField : "level";
        const statLevelDelta = usesDisplayedLevelStatBug
            ? finiteNumber(source[displayedLevelStatBug.statLevelDeltaMemberField], 0)
            : 0;
        const suppressLevelAdjustment = Boolean(source[
            usesDisplayedLevelStatBug
                ? displayedLevelStatBug.suppressionMemberField
                : "suppressDamageFormulaLevelAdjustment"
        ]);
        const natureRequired = source.naturePolicy === "runtime-observed-required";
        const ivsRequired = source.ivPolicy === "runtime-observed-required";
        const species = hasSource
            ? source.displaySpecies || source.species || source.speciesId || display.species || display.name
            : display.species || display.name;
        const sourceMoves = source.moveIds || source.moves || [];
        const moves = hasSource && Array.isArray(sourceMoves) && sourceMoves.length
            ? sourceMoves
            : Array.isArray(display.moves) ? display.moves : [];
        const ivs = completeStatTable(observed.ivs)
            ? statTable(observed.ivs)
            : ivsRequired
                ? {}
                : hasSource && completeStatTable(source.ivs)
                        ? statTable(source.ivs)
                        : completeStatTable(display.ivs)
                            ? statTable(display.ivs)
                            : statTable(runtimeDefaults.ivs);
        const sourceDeclaresEmptyEvs = sourceMon && source.evs && typeof source.evs === "object" && !Object.keys(source.evs).length;
        const verifiedZeroEvs = side === "player" && mechanics.features?.playerEvGainDisabled === true
            || side === "enemy" && sourceDeclaresEmptyEvs;
        const evs = completeStatTable(observed.evs)
            ? statTable(observed.evs)
            : hasSource && completeStatTable(source.evs)
                    ? statTable(source.evs)
                    : verifiedZeroEvs
                        ? statTable({}, 0)
                        : completeStatTable(display.evs)
                            ? statTable(display.evs)
                            : statTable(runtimeDefaults.evs);
        return {
            species,
            level: finiteNumber(hasSource ? source[displayedLevelField] ?? source.level ?? display.level : display.level, NaN),
            statCalculationLevelDelta: statLevelDelta,
            ability: hasSource
                ? source.ability ?? source.abilityId ?? display.ability ?? runtimeDefaults.ability ?? ""
                : display.ability || runtimeDefaults.ability || "",
            item: hasSource
                ? source.item ?? source.itemId ?? ""
                : display.item || runtimeDefaults.item || "",
            nature: observed.nature || (natureRequired
                ? ""
                : hasSource
                    ? source.nature || source.natureId || display.nature || runtimeDefaults.nature || ""
                    : display.nature || runtimeDefaults.nature || ""),
            gender: hasSource ? source.gender ?? runtimeDefaults.gender : display.gender || runtimeDefaults.gender,
            ivs,
            evs,
            moves,
            status: STATUS_NAMES.has(display.status) ? display.status : undefined,
            toxicCounter: Math.max(0, finiteNumber(display.toxicCounter, 0)),
            currentHP: finiteNumber(display.currentHP, undefined),
            boosts: statTable(display.boosts),
            typeOverrides: Array.isArray(display.typeOverrides) ? display.typeOverrides.map(String) : null,
            statOverrides: display.statOverrides && typeof display.statOverrides === "object" ? { ...display.statOverrides } : null,
            damageFormulaLevelDelta: usesDisplayedLevelStatBug
                ? -statLevelDelta
                : finiteNumber(source.damageFormulaLevelDelta, 0),
            suppressDamageFormulaLevelAdjustment: suppressLevelAdjustment,
            runtimeNatureRequired: natureRequired,
            runtimeIvsRequired: ivsRequired
        };
    }

    function validateCombatant(mon, label) {
        if (!mon.species) throw new Error(`${label} species is unavailable`);
        if (!Number.isFinite(mon.level)) throw new Error(`${label} level is unavailable`);
        const statCalculationLevel = mon.level + finiteNumber(mon.statCalculationLevelDelta, 0);
        if (!Number.isInteger(statCalculationLevel) || statCalculationLevel < 1 || statCalculationLevel > 100) {
            throw new Error(`${label} stat-calculation level is unavailable`);
        }
        if (!mon.nature) throw new Error(mon.runtimeNatureRequired ? `${label} nature must be entered in the overlay dock` : `${label} nature is unavailable`);
        if (!completeStatTable(mon.ivs)) throw new Error(mon.runtimeIvsRequired ? `${label} IVs must be entered in the overlay dock` : `${label} IVs are unavailable`);
        if (!completeStatTable(mon.evs)) throw new Error(`${label} EVs are unavailable`);
    }

    function pokemonOptions(mon) {
        const item = /^(none|-)?$/i.test(String(mon.item || "")) ? "" : mon.item;
        return {
            name: mon.mechanicsSpeciesName || undefined,
            level: mon.level + finiteNumber(mon.statCalculationLevelDelta, 0),
            ability: mon.ability || undefined,
            item: item || undefined,
            nature: mon.nature,
            ivs: mon.ivs,
            evs: mon.evs,
            gender: mon.gender || undefined,
            status: mon.status,
            toxicCounter: mon.toxicCounter,
            curHP: mon.currentHP,
            boosts: mon.boosts
        };
    }

    function damageNumbers(value, output) {
        if (Number.isFinite(value)) output.push(value);
        else if (Array.isArray(value)) for (const part of value) damageNumbers(part, output);
        return output;
    }

    function trainerSource(runtime, trainerId, slot, variantId) {
        const trainer = runtime.trainers.get(String(trainerId ?? ""));
        if (!trainer || !Array.isArray(trainer.team)) return { trainer: null, mon: null };
        const numericSlot = Number(slot);
        const baseMon = trainer.team.find(entry => Number(entry.slot) === numericSlot + 1) || trainer.team[numericSlot] || null;
        if (!Array.isArray(trainer.mechanicsVariants) || !trainer.mechanicsVariants.length) return { trainer, mon: baseMon };
        const selected = trainer.mechanicsVariants.find(variant =>
            String(variant.id) === String(variantId ?? "")
            || String(variant.finalRomTrainerId) === String(variantId ?? "")
        );
        if (!selected) {
            return {
                trainer,
                mon: null,
                error: `Trainer ${trainer.displayName || trainer.id} requires an exact final-ROM trainer variant`
            };
        }
        const variantMon = selected.team?.find(entry => Number(entry.slot) === numericSlot + 1) || selected.team?.[numericSlot] || null;
        return {
            trainer: { ...trainer, selectedMechanicsVariant: selected },
            mon: variantMon ? { ...baseMon, ...variantMon } : baseMon,
            variant: selected
        };
    }

    function fieldGameType(trainer, requested, mechanics) {
        const profile = mechanics.trainerBattleProfile || mechanics.difficultyProfile || "default";
        const format = String(
            requested
            || trainer?.selectedMechanicsVariant?.battleFormat
            || trainer?.battleProfiles?.[profile]?.format
            || trainer?.battleProfiles?.default?.format
            || "single"
        ).toLowerCase();
        return format.startsWith("double") || format.startsWith("triple") ? "Doubles" : "Singles";
    }

    function fieldOptions(trainer, request, mechanics) {
        const weather = request.weather;
        const terrain = request.terrain;
        const allowedWeather = new Set(["Rain", "Sun", "Sand", "Hail", "Snow"]);
        const allowedTerrain = new Set(["Electric", "Grassy", "Misty", "Psychic"]);
        if (weather !== undefined && !allowedWeather.has(weather)) throw new Error(`Unsupported weather ${weather}`);
        if (terrain !== undefined && !allowedTerrain.has(terrain)) throw new Error(`Unsupported terrain ${terrain}`);
        const sideOptions = (state, combatantState, opposingState) => ({
            isReflect: Number(state?.reflectTurns || 0) > 0,
            isLightScreen: Number(state?.lightScreenTurns || 0) > 0,
            isTailwind: Number(state?.tailwindTurns || 0) > 0,
            isHelpingHand: Boolean(combatantState?.volatileConditions?.helpinghand),
            isForesight: Boolean(opposingState?.volatileConditions?.foresight),
            isPowerTrick: Boolean(combatantState?.volatileConditions?.powertrick)
        });
        return {
            gameType: fieldGameType(trainer, request.battleFormat, mechanics),
            weather,
            terrain,
            isGravity: Boolean(request.isGravity),
            isMagicRoom: Boolean(request.isMagicRoom),
            isWonderRoom: Boolean(request.isWonderRoom),
            attackerSide: sideOptions(request.attackerFieldState, request.attackerState, request.defenderState),
            defenderSide: sideOptions(request.defenderFieldState, request.defenderState, request.attackerState)
        };
    }

    function canonicalizeCombatant(mon, generation) {
        const wantedSpeciesId = toId(mon.species);
        const speciesRecord = generation.species.get(wantedSpeciesId)
            || Array.from(generation.species).find(record => toId(record.name) === wantedSpeciesId);
        return {
            ...mon,
            species: speciesRecord?.id || mon.species,
            mechanicsSpeciesName: speciesRecord?.mechanicsName || speciesRecord?.name || mon.species,
            ability: generation.abilities.get(toId(mon.ability))?.name || mon.ability,
            item: generation.items.get(toId(mon.item))?.name || mon.item,
            nature: generation.natures.get(toId(mon.nature))?.name || mon.nature,
            typeOverrides: Array.isArray(mon.typeOverrides) ? mon.typeOverrides.map(type => generation.types.get(toId(type))?.name || type) : null
        };
    }

    function applyFormulaLevelAdjustment(pokemon, delta) {
        if (!delta) return;
        const rawStats = { ...pokemon.rawStats };
        const stats = { ...pokemon.stats };
        const originalCurHP = pokemon.originalCurHP;
        const cloneAtStatLevel = pokemon.clone.bind(pokemon);
        pokemon.level += delta;
        pokemon.clone = function () {
            const adjusted = cloneAtStatLevel();
            adjusted.level = pokemon.level;
            adjusted.rawStats = { ...rawStats };
            adjusted.stats = { ...stats };
            adjusted.originalCurHP = originalCurHP;
            return adjusted;
        };
    }

    function applyCombatantStateOverrides(pokemon, mon) {
        if (Array.isArray(mon.typeOverrides) && mon.typeOverrides.length) {
            pokemon.types = [...mon.typeOverrides];
            pokemon.species = { ...pokemon.species, types: [...mon.typeOverrides] };
        }
        for (const [stat, value] of Object.entries(mon.statOverrides || {})) {
            const numeric = Number(value);
            if (!["hp", "atk", "def", "spa", "spd", "spe"].includes(stat) || !Number.isFinite(numeric) || numeric < 1) continue;
            pokemon.rawStats[stat] = numeric;
            pokemon.stats[stat] = numeric;
        }
    }

    function moveOptions(request) {
        const overrides = request.moveOverrides;
        const hits = request.moveHits === undefined || request.moveHits === null ? undefined : Number(request.moveHits);
        const criticalHit = request.criticalHit;
        if (hits !== undefined && (!Number.isInteger(hits) || hits < 1 || hits > 10)) {
            throw new Error("Move hits must be an integer from 1 through 10");
        }
        if (criticalHit !== undefined && typeof criticalHit !== "boolean") {
            throw new Error("criticalHit must be a boolean when supplied");
        }
        if (overrides !== undefined && overrides !== null && (typeof overrides !== "object" || Array.isArray(overrides))) {
            throw new Error("Move overrides must be an object");
        }
        const keys = Object.keys(overrides || {});
        if (keys.some(key => key !== "basePower")) {
            throw new Error("Only a basePower move override is supported");
        }
        const moveOverrides = {};
        if (keys.length) {
            const basePower = Number(overrides.basePower);
            if (!Number.isInteger(basePower) || basePower < 0 || basePower > 1000) {
                throw new Error("Move basePower override must be an integer from 0 to 1000");
            }
            moveOverrides.basePower = basePower;
        }
        // The pinned engine treats a move-level willCrit flag as authoritative. A
        // forced normal calculation must override it so consumers can model
        // Lucky Chant and other critical-hit blockers without approximating damage.
        if (criticalHit === false) moveOverrides.willCrit = false;
        const options = {
            ...(Object.keys(moveOverrides).length ? { overrides: moveOverrides } : {}),
            ...(hits === undefined ? {} : { hits }),
            ...(criticalHit === true ? { isCrit: true } : {})
        };
        return Object.keys(options).length ? options : undefined;
    }

    function damageDistribution(value) {
        const hitRolls = Array.isArray(value) && value.some(Array.isArray)
            ? value.map(hit => damageNumbers(hit, []))
            : [damageNumbers(value, [])];
        if (hitRolls.some(rolls => !rolls.length)) return [];
        let distribution = new Map([[0, 1]]);
        for (const rolls of hitRolls) {
            const next = new Map();
            for (const [total, probability] of distribution) {
                for (const damage of rolls) {
                    const sum = total + Number(damage);
                    next.set(sum, (next.get(sum) || 0) + probability / rolls.length);
                }
            }
            distribution = next;
        }
        return [...distribution.entries()].sort((left, right) => left[0] - right[0]).map(([damage, probability]) => ({ damage, probability }));
    }

    function hitCountOptions(moveData, requestedHits, attacker) {
        if (requestedHits !== undefined && requestedHits !== null) return [{ hits: Number(requestedHits), probability: 1 }];
        const multihit = moveData.multihit;
        if (Number.isInteger(Number(multihit))) return [{ hits: Number(multihit), probability: 1 }];
        if (!Array.isArray(multihit) || multihit.length !== 2) return [{ hits: undefined, probability: 1 }];
        const [min, max] = multihit.map(Number);
        const guaranteedMaximum = attacker?.ability === "Skill Link" || attacker?.item === "Grip Claw";
        const hits = guaranteedMaximum ? max : min + 1;
        return [{ hits: Math.min(max, hits), probability: 1 }];
    }

    function calculate(runtime, request) {
        if (!runtime?.ready) return { status: "unavailable", label: runtime?.label || "Calc data pending" };
        try {
            const source = trainerSource(runtime, request.attackerTrainerId, request.attackerSlot, request.attackerTrainerVariantId);
            const defenderSource = trainerSource(runtime, request.defenderTrainerId, request.defenderSlot, request.defenderTrainerVariantId);
            if (source.error || defenderSource.error) throw new Error(source.error || defenderSource.error);
            const attacker = canonicalizeCombatant(
                mergeCombatant(request.attacker, source.mon, request.attackerSide || "enemy", runtime.mechanics, request.attackerRuntimeInputs),
                runtime.generation
            );
            const defender = canonicalizeCombatant(
                mergeCombatant(request.defender, defenderSource.mon, request.defenderSide || "player", runtime.mechanics, request.defenderRuntimeInputs),
                runtime.generation
            );
            validateCombatant(attacker, "Attacker");
            validateCombatant(defender, "Defender");

            const moveCandidates = [request.moveName, ...(request.moveCandidates || [])].filter(Boolean);
            const moveData = moveCandidates.map(value => runtime.generation.moves.get(toId(value))).find(Boolean);
            if (!moveData) throw new Error(`Move ${request.moveName} is unavailable`);
            if (String(moveData.category).toLowerCase() === "status") return { status: "status", label: "Status" };

            const attackerPokemon = new runtime.calc.Pokemon(runtime.generation, attacker.species, pokemonOptions(attacker));
            const defenderPokemon = new runtime.calc.Pokemon(runtime.generation, defender.species, pokemonOptions(defender));
            applyCombatantStateOverrides(attackerPokemon, attacker);
            applyCombatantStateOverrides(defenderPokemon, defender);
            if (!attacker.suppressDamageFormulaLevelAdjustment) {
                applyFormulaLevelAdjustment(attackerPokemon, attacker.damageFormulaLevelDelta);
            }
            const field = new runtime.calc.Field(fieldOptions(source.trainer || defenderSource.trainer, request, runtime.mechanics));
            const hitOptions = hitCountOptions(moveData, request.moveHits, attacker);
            const hitResults = hitOptions.map(hitOption => {
                const move = new runtime.calc.Move(runtime.generation, moveData.name, moveOptions({ ...request, moveHits: hitOption.hits }));
                const result = runtime.calc.calculate(runtime.generation, attackerPokemon, defenderPokemon, move, field);
                return { ...hitOption, result, distribution: damageDistribution(result.damage) };
            });
            const combined = new Map();
            for (const hitResult of hitResults) {
                for (const entry of hitResult.distribution) {
                    combined.set(entry.damage, (combined.get(entry.damage) || 0) + entry.probability * hitResult.probability);
                }
            }
            const distribution = [...combined.entries()].sort((left, right) => left[0] - right[0]).map(([damage, probability]) => ({ damage, probability }));
            const singleRaw = hitResults.length === 1 && Array.isArray(hitResults[0].result.damage) && !hitResults[0].result.damage.some(Array.isArray)
                ? damageNumbers(hitResults[0].result.damage, [])
                : null;
            const values = singleRaw || distribution.map(entry => entry.damage);
            if (!values.length) return { status: "no-damage", label: "No damage", result: hitResults[0]?.result };
            const hp = defenderPokemon.maxHP();
            const minPercent = Math.min(...values) / hp * 100;
            const maxPercent = Math.max(...values) / hp * 100;
            return {
                status: "ok",
                label: `${minPercent.toFixed(1)}–${maxPercent.toFixed(1)}%`,
                minPercent,
                maxPercent,
                damage: values,
                damageDistribution: distribution,
                criticalHit: Boolean(hitResults[0]?.result?.rawDesc?.isCritical),
                result: hitResults[0].result,
                hitResults
            };
        } catch (error) {
            return { status: "unavailable", label: "Calc unavailable", reason: error.message, error };
        }
    }

    function unavailable(reason) {
        return Object.freeze({
            ready: false,
            status: "unavailable",
            label: "Calc data pending",
            reason: String(reason?.message || reason || "Calculator data is unavailable"),
            calculate(request) { return calculate(this, request); }
        });
    }

    function createFromDocuments(context, calc, mechanics, documents) {
        try {
            if (!calc?.Generations || !calc?.Pokemon || !calc?.Move || !calc?.calculate) throw new Error("Calculator engine is unavailable");
            validateMechanics(mechanics, context);
            const generation = buildGeneration(calc, mechanics, documents);
            const runtime = {
                ready: true,
                status: "ready",
                label: "Calc ready",
                reason: "",
                mechanics,
                generation,
                trainers: indexTrainers(documents["trainers.json"], mechanics.gameId),
                calc
            };
            runtime.calculate = request => calculate(runtime, request);
            return Object.freeze(runtime);
        } catch (error) {
            return unavailable(error);
        }
    }

    async function load(context, calc) {
        try {
            const mechanics = await context.fetchSource("battle_mechanics.json");
            const entries = await Promise.all(REQUIRED_SOURCES.map(async file => [file, await context.fetchSource(file)]));
            return createFromDocuments(context, calc, mechanics, Object.fromEntries(entries));
        } catch (error) {
            return unavailable(error);
        }
    }

    return Object.freeze({
        ENGINE_ID,
        ENGINE_VERSION,
        REQUIRED_SOURCES: Object.freeze([...REQUIRED_SOURCES]),
        createFromDocuments,
        load,
        toId
    });
});
