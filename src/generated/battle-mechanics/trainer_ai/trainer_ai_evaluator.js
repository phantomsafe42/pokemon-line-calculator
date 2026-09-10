(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.TrainerAiEvaluator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PROFILE_SCHEMA_VERSION = "trainer-ai-evaluator-profile/v1alpha1";
    const REQUEST_SCHEMA_VERSION = "trainer-ai-evaluation-request/v1alpha1";
    const RESPONSE_SCHEMA_VERSION = "trainer-ai-evaluation-response/v1alpha1";
    const FORECAST_RESPONSE_SCHEMA_VERSION = "trainer-ai-forecast-response/v1alpha1";
    const DEFAULT_G4_FORECAST_SAMPLE_SIZE = 32;
    const LIKELIHOOD_BANDS = Object.freeze([
        Object.freeze({ id: "very-unlikely", label: "Very Unlikely", minimum: [0, 1], maximum: [1, 10], maximumInclusive: false }),
        Object.freeze({ id: "unlikely", label: "Unlikely", minimum: [1, 10], maximum: [1, 4], maximumInclusive: false }),
        Object.freeze({ id: "possible", label: "Possible", minimum: [1, 4], maximum: [1, 2], maximumInclusive: false }),
        Object.freeze({ id: "likely", label: "Likely", minimum: [1, 2], maximum: [3, 4], maximumInclusive: false }),
        Object.freeze({ id: "very-likely", label: "Very Likely", minimum: [3, 4], maximum: [1, 1], maximumInclusive: false }),
        Object.freeze({ id: "guaranteed", label: "Guaranteed", minimum: [1, 1], maximum: [1, 1], maximumInclusive: true })
    ]);
    const OPERATION_KINDS = new Set(["branch", "branch-random", "jump", "set-variable", "set-random-choice", "adjust-score", "emit-action", "return", "halt", "noop"]);

    function gcd(left, right) {
        let a = left < 0n ? -left : left;
        let b = right < 0n ? -right : right;
        while (b !== 0n) {
            const remainder = a % b;
            a = b;
            b = remainder;
        }
        return a || 1n;
    }

    class Rational {
        constructor(numerator, denominator = 1n) {
            let top = typeof numerator === "bigint" ? numerator : BigInt(numerator);
            let bottom = typeof denominator === "bigint" ? denominator : BigInt(denominator);
            if (bottom === 0n) throw new Error("Rational denominator cannot be zero");
            if (bottom < 0n) {
                top = -top;
                bottom = -bottom;
            }
            const divisor = gcd(top, bottom);
            this.numerator = top / divisor;
            this.denominator = bottom / divisor;
            Object.freeze(this);
        }

        static from(value) {
            if (value instanceof Rational) return value;
            if (Array.isArray(value) && value.length === 2) return new Rational(value[0], value[1]);
            if (value && typeof value === "object" && value.numerator !== undefined && value.denominator !== undefined) {
                return new Rational(value.numerator, value.denominator);
            }
            if (typeof value === "number" && !Number.isInteger(value)) {
                const text = String(value);
                if (/^-?\d+\.\d+$/.test(text)) {
                    const negative = text.startsWith("-");
                    const [whole, fraction] = text.replace(/^-/, "").split(".");
                    const denominator = 10n ** BigInt(fraction.length);
                    const numerator = BigInt(whole) * denominator + BigInt(fraction);
                    return new Rational(negative ? -numerator : numerator, denominator);
                }
            }
            return new Rational(value);
        }

        add(other) {
            const value = Rational.from(other);
            return new Rational(
                this.numerator * value.denominator + value.numerator * this.denominator,
                this.denominator * value.denominator
            );
        }

        subtract(other) {
            const value = Rational.from(other);
            return new Rational(
                this.numerator * value.denominator - value.numerator * this.denominator,
                this.denominator * value.denominator
            );
        }

        multiply(other) {
            const value = Rational.from(other);
            return new Rational(this.numerator * value.numerator, this.denominator * value.denominator);
        }

        divide(other) {
            const value = Rational.from(other);
            if (value.numerator === 0n) throw new Error("Cannot divide by zero");
            return new Rational(this.numerator * value.denominator, this.denominator * value.numerator);
        }

        compare(other) {
            const value = Rational.from(other);
            const difference = this.numerator * value.denominator - value.numerator * this.denominator;
            return difference < 0n ? -1 : difference > 0n ? 1 : 0;
        }

        isZero() {
            return this.numerator === 0n;
        }

        toNumber() {
            if (this.numerator === 0n) return 0;
            const direct = Number(this.numerator) / Number(this.denominator);
            if (Number.isFinite(direct)) return direct;
            const negative = this.numerator < 0n;
            const top = negative ? -this.numerator : this.numerator;
            const whole = top / this.denominator;
            const scale = 1000000000000000n;
            const fraction = ((top % this.denominator) * scale) / this.denominator;
            const value = Number(whole) + Number(fraction) / Number(scale);
            return negative ? -value : value;
        }

        toJSON() {
            return {
                numerator: this.numerator.toString(),
                denominator: this.denominator.toString(),
                decimal: this.toNumber()
            };
        }
    }

    const ZERO = new Rational(0n);
    const ONE = new Rational(1n);

    class EvaluationIssue extends Error {
        constructor(code, message, details = {}) {
            super(message);
            this.name = "EvaluationIssue";
            this.code = code;
            this.details = details;
        }
    }

    function stableValue(value) {
        if (value instanceof Rational) return value.toJSON();
        if (typeof value === "bigint") return value.toString();
        if (Array.isArray(value)) return value.map(stableValue);
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
        }
        return value;
    }

    function stableStringify(value) {
        return JSON.stringify(stableValue(value));
    }

    function cloneValue(value) {
        if (value === undefined || value === null || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(cloneValue);
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
    }

    function getPath(rootValue, pathValue) {
        const path = String(pathValue || "");
        if (!path) return rootValue;
        return path.split(".").reduce((value, key) => value === null || value === undefined ? undefined : value[key], rootValue);
    }

    function requireArray(value, label) {
        if (!Array.isArray(value)) throw new EvaluationIssue("invalid-contract", `${label} must be an array`);
        return value;
    }

    function validateConditionalExactRequirements(readiness, programId) {
        const conditional = readiness?.conditionalExactRequirements;
        if (!conditional) return;
        if (conditional.failClosedWhenUnsatisfied !== true || !Array.isArray(conditional.all) || conditional.all.length === 0) {
            throw new EvaluationIssue("invalid-profile", `Program ${programId} has malformed conditional exact-readiness requirements`);
        }
        for (const requirement of conditional.all) {
            if (!requirement || typeof requirement.requestPath !== "string" || !requirement.requestPath
                || !["uint32", "integer", "present"].includes(requirement.valueType)) {
                throw new EvaluationIssue("invalid-profile", `Program ${programId} has a malformed conditional exact-readiness requirement`);
            }
        }
    }

    function conditionalRequirementSatisfied(request, requirement) {
        const value = getPath(request, requirement.requestPath);
        if (requirement.valueType === "uint32") return Number.isInteger(value) && value >= 0 && value <= 0xFFFFFFFF;
        if (requirement.valueType === "integer") return Number.isInteger(value);
        return value !== undefined;
    }

    function validateProfile(profile) {
        if (!profile || typeof profile !== "object") throw new EvaluationIssue("invalid-profile", "Trainer AI profile is required");
        if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) {
            throw new EvaluationIssue("invalid-profile", `Unsupported Trainer AI profile schema ${profile.schemaVersion || "<missing>"}`);
        }
        if (!profile.profileId || !Number.isInteger(Number(profile.generation)) || !profile.engineFamily) {
            throw new EvaluationIssue("invalid-profile", "Trainer AI profile identity is incomplete");
        }
        const exactGames = profile.scope?.exactGames || profile.exactGameScope;
        const supportedBattleFormats = profile.scope?.supportedBattleFormats || profile.supportedBattleFormats;
        if (!Array.isArray(exactGames) || exactGames.length === 0
            || !Array.isArray(supportedBattleFormats) || supportedBattleFormats.length === 0
            || !profile.provenance || typeof profile.provenance !== "object"
            || !profile.bindings || typeof profile.bindings !== "object"
            || !profile.constants || typeof profile.constants !== "object"
            || !profile.selectionModels || typeof profile.selectionModels !== "object"
            || !profile.reasonCatalog || typeof profile.reasonCatalog !== "object"
            || !Array.isArray(profile.validationCases)
            || !(Array.isArray(profile.stateRequirements) || profile.stateRequirements && typeof profile.stateRequirements === "object")) {
            throw new EvaluationIssue("invalid-profile", "Trainer AI profile is missing required scope, provenance, bindings, state, selection, reason, or validation metadata");
        }
        if (!profile.numericModel || !Number.isInteger(Number(profile.numericModel.initialScore))) {
            throw new EvaluationIssue("invalid-profile", "Trainer AI profile does not declare an integer initial score");
        }
        requireArray(profile.actionPipeline, "profile.actionPipeline");
        requireArray(profile.commands, "profile.commands");
        requireArray(profile.programs, "profile.programs");
        if (!profile.readiness || typeof profile.readiness !== "object") {
            throw new EvaluationIssue("invalid-profile", "Trainer AI profile readiness is required");
        }
        const commandIds = new Set();
        for (const command of profile.commands) {
            const id = command.id || command.commandId;
            if (!id || commandIds.has(id)) throw new EvaluationIssue("invalid-profile", `Duplicate or missing command ID ${id || "<missing>"}`);
            commandIds.add(id);
            if (command.executable !== false && !command.operation) {
                throw new EvaluationIssue("invalid-profile", `Executable command ${id} has no normalized operation`);
            }
            if (command.operation && !OPERATION_KINDS.has(command.operation.kind)) {
                throw new EvaluationIssue("invalid-profile", `Command ${id} uses unsupported operation ${command.operation.kind}`);
            }
        }
        const programIds = new Set();
        for (const program of profile.programs) {
            if (!program.id || programIds.has(program.id) || !Array.isArray(program.instructions)) {
                throw new EvaluationIssue("invalid-profile", `Duplicate, missing, or malformed program ${program.id || "<missing>"}`);
            }
            programIds.add(program.id);
            for (const instruction of program.instructions) {
                if (instruction.commandId && !commandIds.has(instruction.commandId)) {
                    throw new EvaluationIssue("invalid-profile", `Program ${program.id} references unknown command ${instruction.commandId}`);
                }
                if (instruction.operation && !OPERATION_KINDS.has(instruction.operation.kind)) {
                    throw new EvaluationIssue("invalid-profile", `Program ${program.id} uses unsupported operation ${instruction.operation.kind}`);
                }
                const command = instruction.commandId ? profile.commands.find(entry => (entry.id || entry.commandId) === instruction.commandId) : null;
                if (instruction.operation && command?.operation
                    && profile.operations?.instructionOperationPolicy === "commands-canonical-instruction-copy-must-match"
                    && stableStringify(instruction.operation) !== stableStringify(command.operation)) {
                    throw new EvaluationIssue("invalid-profile", `Program ${program.id} instruction ${instruction.pc ?? "<unknown>"} drifts from canonical command ${instruction.commandId}`);
                }
            }
            validateConditionalExactRequirements(program.readiness, program.id);
        }
        return profile;
    }

    function validateRequest(request) {
        if (!request || typeof request !== "object" || request.schemaVersion !== REQUEST_SCHEMA_VERSION) {
            throw new EvaluationIssue("invalid-request", `Expected ${REQUEST_SCHEMA_VERSION}`);
        }
        if (!request.state || typeof request.state !== "object") throw new EvaluationIssue("invalid-request", "request.state is required");
        if (!request.trainer || typeof request.trainer !== "object") throw new EvaluationIssue("invalid-request", "request.trainer is required");
        if (!request.phaseInputs || typeof request.phaseInputs !== "object") throw new EvaluationIssue("invalid-request", "request.phaseInputs is required");
        const g4Seed = request.state?.random?.g4LcrngSeed;
        if (g4Seed !== undefined && (!Number.isInteger(g4Seed) || g4Seed < 0 || g4Seed > 0xFFFFFFFF)) {
            throw new EvaluationIssue("invalid-request", "state.random.g4LcrngSeed must be an unsigned 32-bit integer");
        }
        return request;
    }

    function randomSourceMap(profile) {
        if (Array.isArray(profile.randomSources)) return new Map(profile.randomSources.map(source => [source.id, source]));
        return new Map(Object.entries(profile.randomSources || {}).map(([id, source]) => [id, { id, ...source }]));
    }

    function commandMap(profile) {
        return new Map(profile.commands.map(command => [command.id || command.commandId, command]));
    }

    function programMap(profile) {
        return new Map(profile.programs.map(program => [program.id, program]));
    }

    function newWorld(probability = ONE, request = null) {
        return {
            probability,
            randomValues: {},
            queryMemory: cloneValue(request?.state?.queryMemory || {}),
            randomState: request?.state?.random?.g4LcrngSeed === undefined ? {} : { g4LcrngSeed: request.state.random.g4LcrngSeed >>> 0, g4DrawCount: 0 },
            scores: {},
            traces: new Map(),
            action: null
        };
    }

    function cloneWorld(world) {
        return {
            probability: world.probability,
            randomValues: { ...world.randomValues },
            queryMemory: cloneValue(world.queryMemory || {}),
            randomState: { ...(world.randomState || {}) },
            scores: { ...world.scores },
            traces: new Map([...world.traces].map(([key, value]) => [key, { event: value.event, mass: value.mass }])),
            action: cloneValue(world.action),
            returnValue: cloneValue(world.returnValue)
        };
    }

    function scaleWorld(world, factorValue) {
        const factor = Rational.from(factorValue);
        const result = cloneWorld(world);
        result.probability = result.probability.multiply(factor);
        result.traces = new Map([...result.traces].map(([key, value]) => [key, {
            event: value.event,
            mass: value.mass.multiply(factor)
        }]));
        return result;
    }

    function addTrace(world, event) {
        const key = stableStringify(event);
        world.traces.set(key, {
            event,
            mass: world.probability
        });
    }

    function mergeTraceMaps(target, source) {
        for (const [key, value] of source) {
            const current = target.get(key);
            target.set(key, { event: value.event, mass: (current?.mass || ZERO).add(value.mass) });
        }
    }

    function worldStateKey(world) {
        return stableStringify({ randomValues: world.randomValues, randomState: world.randomState, queryMemory: world.queryMemory, scores: world.scores, action: world.action, returnValue: world.returnValue });
    }

    function mergeWorlds(worlds) {
        const merged = new Map();
        for (const world of worlds) {
            if (world.probability.isZero()) continue;
            const key = worldStateKey(world);
            const current = merged.get(key);
            if (!current) {
                merged.set(key, cloneWorld(world));
                continue;
            }
            current.probability = current.probability.add(world.probability);
            mergeTraceMaps(current.traces, world.traces);
        }
        return [...merged.values()];
    }

    function mergeExecutionStates(states) {
        const merged = new Map();
        for (const state of states) {
            const key = stableStringify({ pc: state.pc, locals: state.locals, lastBranch: state.lastBranch, enumeratedChoice: state.enumeratedChoice, world: worldStateKey(state.world), done: state.done });
            const current = merged.get(key);
            if (!current) {
                merged.set(key, { ...state, locals: cloneValue(state.locals), world: cloneWorld(state.world) });
                continue;
            }
            current.world.probability = current.world.probability.add(state.world.probability);
            mergeTraceMaps(current.world.traces, state.world.traces);
        }
        return [...merged.values()];
    }

    function comparison(operator, left, right) {
        switch (String(operator || "").toLowerCase()) {
        case "lt": return left < right;
        case "lte": return left <= right;
        case "eq": return left === right;
        case "ne":
        case "neq": return left !== right;
        case "gte": return left >= right;
        case "gt": return left > right;
        default: throw new EvaluationIssue("unsupported-comparison", `Unsupported comparison ${operator}`);
        }
    }

    function applyOperator(operator, expressions, environment) {
        const op = String(operator || "").toLowerCase();
        const condition = expression => {
            const value = evaluateExpression(expression, environment);
            if (value === undefined) throw new EvaluationIssue("missing-state", `Operation ${op} received an unresolved condition`);
            return Boolean(value);
        };
        if (op === "and") {
            for (const expression of expressions) if (!condition(expression)) return false;
            return true;
        }
        if (op === "or") {
            for (const expression of expressions) if (condition(expression)) return true;
            return false;
        }
        if (op === "not") return !condition(expressions[0]);
        if (op === "coalesce") {
            for (const expression of expressions) {
                const value = evaluateExpression(expression, environment);
                if (value !== undefined && value !== null) return value;
            }
            return null;
        }
        if (op === "if") return evaluateExpression(condition(expressions[0]) ? expressions[1] : expressions[2], environment);

        const values = expressions.map(expression => evaluateExpression(expression, environment));
        if (values.some(value => value === undefined)) throw new EvaluationIssue("missing-state", `Operation ${op} received an unresolved value`);
        if (["eq", "ne", "neq", "lt", "lte", "gte", "gt"].includes(op)) return comparison(op, values[0], values[1]);
        if (["add", "subtract", "multiply", "divide-floor", "divide-trunc", "mod", "modulo", "bit-and-nonzero", "bit-and-zero", "min", "max", "abs"].includes(op)
            && values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new EvaluationIssue("invalid-numeric-operand", `Operation ${op} requires finite numbers`);
        if (["divide-floor", "divide-trunc", "mod", "modulo"].includes(op) && values[1] === 0) throw new EvaluationIssue("invalid-numeric-operand", `Operation ${op} cannot divide by zero`);
        switch (op) {
        case "add": return values.reduce((sum, value) => sum + Number(value), 0);
        case "subtract": return Number(values[0]) - Number(values[1]);
        case "multiply": return values.reduce((product, value) => product * Number(value), 1);
        case "divide-floor": return Math.floor(Number(values[0]) / Number(values[1]));
        case "divide-trunc": return Math.trunc(Number(values[0]) / Number(values[1]));
        case "mod":
        case "modulo": return Number(values[0]) % Number(values[1]);
        case "bit-and-nonzero": return (Number(values[0]) & Number(values[1])) !== 0;
        case "bit-and-zero": return (Number(values[0]) & Number(values[1])) === 0;
        case "in": return Array.isArray(values[1]) && values[1].some(value => value === values[0]);
        case "contains": return Array.isArray(values[0]) ? values[0].some(value => value === values[1]) : String(values[0]).includes(String(values[1]));
        case "length": return values[0]?.length ?? 0;
        case "min": return Math.min(...values.map(Number));
        case "max": return Math.max(...values.map(Number));
        case "abs": return Math.abs(Number(values[0]));
        default: throw new EvaluationIssue("unsupported-operator", `Unsupported expression operator ${operator}`);
        }
    }

    function evaluateExpression(expression, environment) {
        if (expression === null || expression === undefined || typeof expression !== "object") return expression;
        if (Array.isArray(expression)) return expression.map(value => evaluateExpression(value, environment));
        if (expression.type === "integer" && Object.prototype.hasOwnProperty.call(expression, "value")) return expression.value;
        if (expression.type === "label") return expression.pc ?? expression.token;
        if (expression.type === "constant-token") return expression.value ?? expression.token;
        if (Object.prototype.hasOwnProperty.call(expression, "literal")) return cloneValue(expression.literal);
        if (Object.prototype.hasOwnProperty.call(expression, "operand")) {
            const key = expression.operand;
            const value = typeof key === "number" ? environment.argumentList[key] : environment.arguments[key];
            return value && typeof value === "object" ? evaluateExpression(value, environment) : value;
        }
        if (Object.prototype.hasOwnProperty.call(expression, "variable")) return environment.locals[expression.variable];
        if (Object.prototype.hasOwnProperty.call(expression, "state")) return getPath(environment.context, expression.state);
        if (Object.prototype.hasOwnProperty.call(expression, "constant")) return getPath(environment.profile.constants || {}, expression.constant);
        if (Object.prototype.hasOwnProperty.call(expression, "query")) {
            const descriptor = expression.query && typeof expression.query === "object" ? expression.query : null;
            const queryId = descriptor?.id || expression.query;
            const args = (descriptor?.arguments || expression.args || []).map(value => evaluateExpression(value, environment));
            if (args.some(value => value === undefined)) throw new EvaluationIssue("missing-state", `Query ${queryId} received an unresolved argument`, { query: queryId });
            const query = environment.queries[queryId];
            let value;
            if (typeof query === "function") {
                const queryMetadata = {
                    context: environment.context,
                    profile: environment.profile,
                    locals: cloneValue(environment.locals),
                    arguments: cloneValue(environment.arguments),
                    argumentList: cloneValue(environment.argumentList),
                    program: environment.program || null,
                    instruction: environment.instruction || null,
                    instructionIndex: environment.instructionIndex ?? null
                };
                queryMetadata.scoringPass = cloneValue(environment.executionState?.world.randomValues[`scoring-pass:${environment.context.phase.id}`] || null);
                // Capabilities are non-enumerable: diagnostic snapshots remain
                // structured-cloneable and never serialize executable callbacks.
                Object.defineProperties(queryMetadata, {
                    readMemory: { value: id => cloneValue(environment.executionState.world.queryMemory?.[id]) },
                    writeMemory: { value: (id, value) => {
                        if (typeof id !== 'string' || !id || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new EvaluationIssue('invalid-query-memory-key', 'Query memory requires a safe nonempty key');
                        environment.executionState.world.queryMemory[id] = cloneValue(value);
                    } },
                    hiddenStateValue: { value: id => {
                        const model = environment.profile.constants?.hiddenStateModels?.[id];
                        if (!model || model.coverage !== 'exhaustive-equivalence-classes' || !Array.isArray(model.values) || !model.values.length || model.values.length > 256) throw new EvaluationIssue('invalid-hidden-state-model', `No exhaustive source model exists for ${id}`);
                        const values = environment.context.request.state.hiddenStateValues || {};
                        if (!Object.prototype.hasOwnProperty.call(values, id)) throw new EvaluationIssue('hidden-state-required', model.summary || `Unobserved engine state ${id} affects this path`, { hiddenStateId: id });
                        if (!model.values.some(value => stableStringify(value) === stableStringify(values[id]))) throw new EvaluationIssue('invalid-hidden-state-value', `The value for ${id} is outside its source model`);
                        return cloneValue(values[id]);
                    } },
                    evaluateQueryProgram: { value: (programId, state) => evaluateQueryProgram({ profile: environment.profile, programId, state, queries: environment.queries }) },
                    drawRandom: { value: sourceId => {
                        const source = environment.randomSources.get(sourceId);
                        if (!source) throw new EvaluationIssue("missing-random-source", `Query ${queryId} requested undeclared source ${sourceId}`);
                        if (environment.educationalScoreMarginals === true) return sourceRepresentativeValue(source);
                        const draw = drawFromExactG4State(environment.executionState.world, source);
                        if (!draw) throw new EvaluationIssue("conditional-readiness-unsatisfied", "This source query needs the shared random trajectory", {
                            requirements: [{ requestPath: "state.random.g4LcrngSeed", valueType: "uint32" }]
                        });
                        environment.executionState.world = draw.world;
                        return draw.value;
                    } }
                });
                value = query(...args, queryMetadata);
            } else {
                const recorded = environment.context.request.queryResults?.[queryId];
                if (recorded === undefined) throw new EvaluationIssue("missing-query", `Query ${queryId} is not available`, { query: queryId });
                if (recorded && typeof recorded === "object" && !Array.isArray(recorded)) {
                    const key = stableStringify(args);
                    value = Object.prototype.hasOwnProperty.call(recorded, key) ? recorded[key] : recorded.default;
                } else value = recorded;
            }
            if (value === undefined) throw new EvaluationIssue("missing-query-result", `Query ${queryId} has no result for these arguments`, { query: queryId, args });
            if (value && typeof value.then === "function") throw new EvaluationIssue("async-query", `Query ${queryId} returned a Promise`);
            return value;
        }
        if (Object.prototype.hasOwnProperty.call(expression, "op")) return applyOperator(expression.op, expression.args || [], environment);
        return Object.fromEntries(Object.entries(expression).map(([key, value]) => [key, evaluateExpression(value, environment)]));
    }

    function normalizedArguments(instruction, command) {
        const raw = instruction.arguments ?? instruction.args ?? {};
        if (!Array.isArray(raw)) return { named: raw || {}, list: [] };
        const named = {};
        const operands = command?.operands || command?.parameters || [];
        raw.forEach((value, index) => {
            named[operands[index]?.name || String(index)] = value;
        });
        return { named, list: raw };
    }

    function sourceRange(source, limits, enforceSupportLimit = true) {
        const distribution = source.distribution || source;
        if (distribution.kind && !["uniform-int", "uniform-integer"].includes(distribution.kind)) {
            throw new EvaluationIssue("unsupported-random-source", `Random source ${source.id} is not a uniform integer source`);
        }
        const minimum = Number(distribution.minimum ?? distribution.min ?? distribution.range?.[0] ?? 0);
        const maximum = Number(distribution.maximum ?? distribution.max ?? distribution.range?.[1]);
        if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || maximum < minimum) {
            throw new EvaluationIssue("invalid-random-source", `Random source ${source.id} has an invalid range`);
        }
        const size = maximum - minimum + 1;
        if (enforceSupportLimit && size > limits.maxRandomSupport) throw new EvaluationIssue("random-support-limit", `Random source ${source.id} has ${size} values`);
        return { minimum, maximum, size };
    }

    function moduloSourceSupport(source, limits) {
        if (source.distribution?.kind !== 'uniform-int-modulo') return null;
        const { inputDomain, modulus } = source.distribution;
        if (source.endpointsInclusive !== true || !Array.isArray(inputDomain) || inputDomain.length !== 2
            || inputDomain.some(value => !Number.isSafeInteger(value) || value < 0)
            || inputDomain[1] < inputDomain[0] || !Number.isSafeInteger(modulus) || modulus <= 0) {
            throw new EvaluationIssue('invalid-random-source', `Random source ${source.id} has an invalid inclusive modulo domain`);
        }
        // Enumerate residues, not the potentially much larger parent domain.
        const minimum = BigInt(inputDomain[0]);
        const maximum = BigInt(inputDomain[1]);
        const divisor = BigInt(modulus);
        const total = maximum - minimum + 1n;
        const supportSize = total < divisor ? total : divisor;
        if (supportSize > BigInt(limits.maxRandomSupport)) throw new EvaluationIssue('random-support-limit', `Random source ${source.id} has ${supportSize} residues`);
        const rows = [];
        for (let offset = 0n; offset < supportSize; offset += 1n) {
            const first = minimum + offset;
            rows.push({ value: Number(first % divisor), weight: (maximum - first) / divisor + 1n });
        }
        return { rows: rows.sort((left, right) => left.value - right.value), total };
    }

    function sourceRepresentativeValue(source) {
        if (source.distribution?.kind === 'uniform-int-modulo') {
            moduloSourceSupport(source, { maxRandomSupport: 4096 });
            const [minimum, maximum] = source.distribution.inputDomain.map(BigInt);
            return Number(((minimum + maximum) / 2n) % BigInt(source.distribution.modulus));
        }
        const inputDomain = source.distribution?.inputDomain;
        if (Array.isArray(inputDomain) && inputDomain.length === 2
            && Number.isInteger(Number(inputDomain[0])) && Number.isInteger(Number(inputDomain[1]))
            && Number(inputDomain[1]) >= Number(inputDomain[0])) {
            return Math.floor((Number(inputDomain[0]) + Number(inputDomain[1])) / 2);
        }
        const range = sourceRange(source, { maxRandomSupport: Number.MAX_SAFE_INTEGER }, false);
        return Math.floor((range.minimum + range.maximum) / 2);
    }

    function requirementsOnlyNeedG4Seed(requirements) {
        return Array.isArray(requirements)
            && requirements.length > 0
            && requirements.every(requirement => requirement.requestPath === "state.random.g4LcrngSeed" && requirement.valueType === "uint32");
    }

    function randomScopeKey(source, context) {
        const scope = String(source.scope || "instruction");
        if (["instruction", "fresh"].includes(scope)) return null;
        if (scope === "candidate") return `${source.id}:candidate:${context.candidate?.id || "none"}`;
        if (scope === "phase") return `${source.id}:phase:${context.phase?.id || "none"}`;
        if (scope === "turn") return `${source.id}:turn:${context.state?.turn ?? context.battle?.turn ?? "unknown"}`;
        if (["actor-selection-pass", "selection-pass", "actor"].includes(scope)) {
            return `${source.id}:actor:${context.request.actorId || context.trainer.actorId || context.trainer.id || "default"}`;
        }
        if (scope === "request") return `${source.id}:request`;
        throw new EvaluationIssue("unsupported-random-scope", `Unsupported random scope ${scope}`, { sourceId: source.id });
    }

    function drawFromExactG4State(world, source) {
        if (!Number.isInteger(world.randomState?.g4LcrngSeed)) return null;
        if (!String(source.id || "").startsWith("g4-") && !/g4-lcrng-output/i.test(String(source.derivedFrom || ""))) return null;
        const next = cloneWorld(world);
        const seed = (BigInt(next.randomState.g4LcrngSeed) * 1103515245n + 24691n) & 0xFFFFFFFFn;
        next.randomState.g4LcrngSeed = Number(seed);
        next.randomState.g4DrawCount = Number(next.randomState.g4DrawCount || 0) + 1;
        const output = Number(seed >> 16n);
        const derivation = String(source.derivedFrom || source.distribution?.kind || "");
        let value = output;
        if (/100\s*-\s*\(?g4-lcrng-output modulo 16\)?/i.test(derivation)) value = 100 - (output % 16);
        else {
            const modulo = derivation.match(/g4-lcrng-output\s+modulo\s+(\d+)/i);
            if (modulo) value = output % Number(modulo[1]);
        }
        return { world: next, value, output };
    }

    function resolveJumpTarget(target, labels, instructions) {
        if (labels.has(String(target))) return labels.get(String(target));
        const byPc = instructions.findIndex(instruction => String(instruction.pc) === String(target));
        if (byPc >= 0) return byPc;
        if (typeof target === "number" && Number.isInteger(target) && target >= 0 && target < instructions.length) return target;
        throw new EvaluationIssue("invalid-jump-target", `Program jump target ${target} does not exist`, { target });
    }

    function branchRandom(state, operation, environment, labels, instructions, randomSources, limits) {
        const source = randomSources.get(operation.source);
        if (!source) throw new EvaluationIssue("missing-random-source", `Random source ${operation.source} is not declared`);
        const threshold = evaluateExpression(operation.value, environment);
        if (threshold === undefined) throw new EvaluationIssue("missing-state", `Random branch threshold for ${source.id} is unresolved`);
        const target = resolveJumpTarget(evaluateExpression(operation.target, environment), labels, instructions);
        const scopeKey = randomScopeKey(source, environment.context);
        const moduloSupport = moduloSourceSupport(source, limits);
        if (moduloSupport) {
            const passing = moduloSupport.rows.filter(row => comparison(operation.comparison, row.value, threshold)).reduce((total, row) => total + row.weight, 0n);
            const next = (world, value) => {
                const taken = comparison(operation.comparison, value, threshold);
                return { ...state, pc: taken ? target : state.pc + 1, world, lastBranch: {
                    pc: instructions[state.pc].pc, taken, kind: 'random', sourceId: source.id,
                    outcomeProbability: new Rational(taken ? passing : moduloSupport.total - passing, moduloSupport.total).toJSON()
                } };
            };
            if (scopeKey && Object.prototype.hasOwnProperty.call(state.world.randomValues, scopeKey)) return [next(state.world, state.world.randomValues[scopeKey])];
            const seeded = drawFromExactG4State(state.world, source);
            if (seeded) {
                if (source.distribution.inputDomain[0] !== 0 || source.distribution.inputDomain[1] !== 65535) throw new EvaluationIssue('invalid-random-source', 'A Gen 4 seeded modulo source must declare the full unsigned 16-bit parent output');
                const value = seeded.output % source.distribution.modulus;
                if (scopeKey) seeded.world.randomValues[scopeKey] = value;
                return [next(seeded.world, value)];
            }
            if (scopeKey) return moduloSupport.rows.map(row => {
                const world = scaleWorld(state.world, new Rational(row.weight, moduloSupport.total));
                world.randomValues[scopeKey] = row.value;
                return next(world, row.value);
            });
            return [true, false].flatMap(taken => {
                const weight = taken ? passing : moduloSupport.total - passing;
                if (weight === 0n) return [];
                const example = moduloSupport.rows.find(row => comparison(operation.comparison, row.value, threshold) === taken).value;
                return [next(scaleWorld(state.world, new Rational(weight, moduloSupport.total)), example)];
            });
        }
        const exactDraw = drawFromExactG4State(state.world, source);
        const range = sourceRange(source, limits, !exactDraw);
        let passing = 0;
        let passingExample;
        let failingExample;
        for (let value = range.minimum; value <= range.maximum; value += 1) {
            if (comparison(operation.comparison, value, threshold)) {
                passing += 1;
                if (passingExample === undefined) passingExample = value;
            } else if (failingExample === undefined) failingExample = value;
        }
        const outcomeProbability = taken => new Rational(BigInt(taken ? passing : range.size - passing), BigInt(range.size)).toJSON();
        const nextState = (world, value) => {
            const taken = comparison(operation.comparison, value, threshold);
            return {
                ...state,
                pc: taken ? target : state.pc + 1,
                lastBranch: {
                    pc: instructions[state.pc].pc,
                    taken,
                    kind: "random",
                    sourceId: source.id,
                    outcomeProbability: outcomeProbability(taken)
                },
                world
            };
        };
        if (exactDraw) return [nextState(exactDraw.world, exactDraw.value)];
        if (scopeKey && Object.prototype.hasOwnProperty.call(state.world.randomValues, scopeKey)) {
            return [nextState(state.world, state.world.randomValues[scopeKey])];
        }
        if (scopeKey) {
            const states = [];
            for (let value = range.minimum; value <= range.maximum; value += 1) {
                const world = scaleWorld(state.world, new Rational(1n, BigInt(range.size)));
                world.randomValues[scopeKey] = value;
                states.push(nextState(world, value));
            }
            return states;
        }
        const states = [];
        if (passing > 0) states.push(nextState(scaleWorld(state.world, new Rational(BigInt(passing), BigInt(range.size))), passingExample));
        if (passing < range.size) states.push(nextState(scaleWorld(state.world, new Rational(BigInt(range.size - passing), BigInt(range.size))), failingExample));
        return states;
    }

    function setRandomChoice(state, operation, environment, randomSources, limits) {
        const source = randomSources.get(operation.source);
        if (!source) throw new EvaluationIssue("missing-random-source", `Random source ${operation.source} is not declared`);
        const options = evaluateExpression(operation.options, environment);
        if (!Array.isArray(options) || options.length === 0) throw new EvaluationIssue("invalid-random-choice", "Random choice requires at least one option");
        const scopeKey = randomScopeKey(source, environment.context);
        const moduloSupport = moduloSourceSupport(source, limits);
        if (moduloSupport) {
            if (options.length > limits.maxRandomSupport) throw new EvaluationIssue('random-support-limit', `Random choice has ${options.length} options`);
            const next = (world, value) => ({ ...state, pc: state.pc + 1, world, locals: { ...state.locals, [operation.name]: cloneValue(options[value % options.length]) } });
            if (scopeKey && Object.prototype.hasOwnProperty.call(state.world.randomValues, scopeKey)) return [next(state.world, state.world.randomValues[scopeKey])];
            const seeded = drawFromExactG4State(state.world, source);
            if (seeded) {
                if (source.distribution.inputDomain[0] !== 0 || source.distribution.inputDomain[1] !== 65535) throw new EvaluationIssue('invalid-random-source', 'A Gen 4 seeded modulo source must declare the full unsigned 16-bit parent output');
                const value = seeded.output % source.distribution.modulus;
                if (scopeKey) seeded.world.randomValues[scopeKey] = value;
                return [next(seeded.world, value)];
            }
            return moduloSupport.rows.map(row => {
                const world = scaleWorld(state.world, new Rational(row.weight, moduloSupport.total));
                if (scopeKey) world.randomValues[scopeKey] = row.value;
                return next(world, row.value);
            });
        }
        const exactDraw = drawFromExactG4State(state.world, source);
        if (exactDraw) {
            const next = { ...state, pc: state.pc + 1, world: exactDraw.world, locals: { ...state.locals } };
            next.locals[operation.name] = options[exactDraw.output % options.length];
            return [next];
        }
        if (scopeKey && Object.prototype.hasOwnProperty.call(state.world.randomValues, scopeKey)) {
            const next = { ...state, pc: state.pc + 1, locals: { ...state.locals } };
            next.locals[operation.name] = options[state.world.randomValues[scopeKey] % options.length];
            return [next];
        }
        if (options.length > limits.maxRandomSupport) throw new EvaluationIssue("random-support-limit", `Random choice has ${options.length} options`);
        return options.map((option, index) => {
            const world = scaleWorld(state.world, new Rational(1n, BigInt(options.length)));
            if (scopeKey) world.randomValues[scopeKey] = index;
            const next = { ...state, pc: state.pc + 1, world, locals: { ...state.locals },
                enumeratedChoice: state.enumeratedChoice || new Set(options.map(stableStringify)).size > 1 };
            next.locals[operation.name] = cloneValue(option);
            return next;
        });
    }

    function executeOperation(state, operation, environment, metadata, labels, instructions, randomSources, limits) {
        switch (operation.kind) {
        case "branch": {
            const condition = evaluateExpression(operation.when, environment);
            if (condition === undefined) throw new EvaluationIssue("missing-state", "Branch condition is unresolved");
            const target = resolveJumpTarget(evaluateExpression(operation.target, environment), labels, instructions);
            return { next: [{ ...state, pc: condition ? target : state.pc + 1, lastBranch: { pc: instructions[state.pc].pc, taken: Boolean(condition) } }] };
        }
        case "branch-random":
            return { next: branchRandom(state, operation, environment, labels, instructions, randomSources, limits) };
        case "jump": {
            const target = resolveJumpTarget(evaluateExpression(operation.target, environment), labels, instructions);
            return { next: [{ ...state, pc: target }] };
        }
        case "set-variable": {
            const value = evaluateExpression(operation.value, environment);
            if (value === undefined) throw new EvaluationIssue("missing-state", `Variable ${operation.name} value is unresolved`);
            return { next: [{ ...state, pc: state.pc + 1, locals: { ...state.locals, [operation.name]: cloneValue(value) } }] };
        }
        case "set-random-choice":
            return { next: setRandomChoice(state, operation, environment, randomSources, limits) };
        case "adjust-score": {
            if (!metadata.candidate) throw new EvaluationIssue("invalid-operation-context", "Score adjustment requires a candidate");
            const value = Number(evaluateExpression(operation.value, environment));
            if (!Number.isInteger(value)) throw new EvaluationIssue("invalid-score", `Score adjustment ${value} is not an integer`);
            const world = cloneWorld(state.world);
            const previousScore = Number(world.scores[metadata.candidate.id]);
            let adjustedScore = previousScore + value;
            const scoreModel = environment.profile?.numericModel?.score;
            if (Number.isInteger(scoreModel?.widthBits) && scoreModel.widthBits > 0 && scoreModel.widthBits <= 32
                && /wrap|low-byte|two-complement/i.test(String(scoreModel.overflow || ""))) {
                const modulus = 2 ** scoreModel.widthBits;
                adjustedScore = ((adjustedScore % modulus) + modulus) % modulus;
                if (scoreModel.signed === true && adjustedScore >= modulus / 2) adjustedScore -= modulus;
            }
            if (Number.isFinite(scoreModel?.lowerClamp) && adjustedScore < scoreModel.lowerClamp) adjustedScore = scoreModel.lowerClamp;
            if (Number.isFinite(scoreModel?.upperClamp) && adjustedScore > scoreModel.upperClamp) adjustedScore = scoreModel.upperClamp;
            world.scores[metadata.candidate.id] = adjustedScore;
            addTrace(world, {
                phaseId: metadata.phaseId,
                programId: metadata.programId,
                candidateId: metadata.candidate.id,
                instructionPc: state.pc,
                reasonCode: metadata.reasonCode || operation.reasonCode || `${metadata.programId}:${state.pc}`,
                title: metadata.title || operation.title,
                summary: metadata.instructionSummary || operation.summary || metadata.summary || "The Trainer AI adjusted this candidate's score.",
                programReasonCode: metadata.programReasonCode,
                source: metadata.source,
                delta: value,
                previousScore,
                resultingScore: adjustedScore,
                scoringProbability: state.lastBranch?.kind === "random"
                    ? cloneValue(state.lastBranch.outcomeProbability)
                    : ONE.toJSON(),
                probabilityBasis: state.enumeratedChoice ? "pre-selection-random-choice"
                    : state.lastBranch?.kind === "random" ? "source-random-branch" : "deterministic-state"
            });
            return { next: [{ ...state, pc: state.pc + 1, world }] };
        }
        case "emit-action": {
            const action = evaluateExpression(operation.action, environment);
            if (action && typeof action === "object" && Array.isArray(action.$distribution)) {
                let total = ZERO;
                const complete = action.$distribution.map((outcome, index) => {
                    const factor = Rational.from(outcome.probability);
                    if (factor.compare(ZERO) < 0) throw new EvaluationIssue("invalid-query-distribution", `Query distribution outcome ${index} has negative probability`);
                    total = total.add(factor);
                    const world = scaleWorld(state.world, factor);
                    const value = outcome.value;
                    if (value !== null && value !== undefined) {
                        if (typeof value !== "object") throw new EvaluationIssue("invalid-action", "Distributed action must be an object or null");
                        world.action = cloneValue(value);
                    } else if (!operation.allowNoAction) {
                        throw new EvaluationIssue("invalid-action", "A null distributed action requires allowNoAction");
                    }
                    if (world.action && (operation.reasonCode || operation.summary)) {
                        addTrace(world, {
                            phaseId: metadata.phaseId,
                            programId: metadata.programId,
                            candidateId: metadata.candidate?.id || null,
                            instructionPc: state.pc,
                            reasonCode: operation.reasonCode || `${metadata.programId}:${state.pc}`,
                            summary: operation.summary || "The Trainer AI selected this action."
                        });
                    }
                    return { ...state, world, done: true };
                });
                if (total.compare(ONE) !== 0) throw new EvaluationIssue("invalid-query-distribution", "Query distribution probabilities must sum to exactly one");
                return { complete };
            }
            if ((action === null || action === undefined) && operation.allowNoAction) {
                return { complete: [{ ...state, done: true }] };
            }
            if (!action || typeof action !== "object") throw new EvaluationIssue("invalid-action", "Emitted action must be an object");
            const world = cloneWorld(state.world);
            world.action = action;
            if (operation.reasonCode || operation.summary) {
                addTrace(world, {
                    phaseId: metadata.phaseId,
                    programId: metadata.programId,
                    candidateId: metadata.candidate?.id || null,
                    instructionPc: state.pc,
                    reasonCode: operation.reasonCode || `${metadata.programId}:${state.pc}`,
                    summary: operation.summary || "The Trainer AI selected this action."
                });
            }
            return { complete: [{ ...state, world, done: true }] };
        }
        case "return":
            if (operation.value !== undefined) state.world.returnValue = evaluateExpression(operation.value, environment);
            return { complete: [{ ...state, done: true }] };
        case "halt":
            if (operation.status === "unavailable" || operation.status === "unresolved") {
                throw new EvaluationIssue("profile-halt-unavailable", operation.summary || "The profile halted on an unavailable path");
            }
            return { complete: [{ ...state, done: true }] };
        case "noop":
            return { next: [{ ...state, pc: state.pc + 1 }] };
        default:
            throw new EvaluationIssue("unsupported-operation", `Unsupported operation ${operation.kind}`);
        }
    }

    function diagnosticRecord(issue, metadata, instruction, mass) {
        return {
            code: issue.code || "evaluation-error",
            message: issue.message,
            phaseId: metadata.phaseId,
            programId: metadata.programId,
            candidateId: metadata.candidate?.id || null,
            instructionPc: instruction?.pc ?? metadata.instructionIndex ?? null,
            commandId: instruction?.commandId || instruction?.command || null,
            details: issue.details || {},
            mass
        };
    }

    function executeProgram(worlds, program, executionContext) {
        const { commands, randomSources, request, phaseInput, candidate, profile, queries, limits } = executionContext;
        if (program.readiness?.status === "unavailable" || program.readiness?.executable === false) {
            const mass = worlds.reduce((sum, world) => sum.add(world.probability), ZERO);
            return {
                worlds: [],
                unresolvedMass: mass,
                diagnostics: [diagnosticRecord(new EvaluationIssue("program-unavailable", `Program ${program.id} is unavailable`), {
                    phaseId: phaseInput.id, programId: program.id, candidate
                }, null, mass)]
            };
        }
        const conditional = program.readiness?.conditionalExactRequirements;
        const unsatisfiedRequirements = conditional?.all?.filter(requirement => !conditionalRequirementSatisfied(request, requirement)) || [];
        const educationalSeedBypass = executionContext.educationalScoreMarginals === true
            && requirementsOnlyNeedG4Seed(unsatisfiedRequirements);
        if (conditional?.failClosedWhenUnsatisfied === true && unsatisfiedRequirements.length > 0 && !educationalSeedBypass) {
            const mass = worlds.reduce((sum, world) => sum.add(world.probability), ZERO);
            return {
                worlds: [],
                unresolvedMass: mass,
                diagnostics: [diagnosticRecord(new EvaluationIssue(
                    "conditional-readiness-unsatisfied",
                    `Program ${program.id} requires ${unsatisfiedRequirements.map(requirement => requirement.requestPath).join(", ")} for exact execution`,
                    { requirements: unsatisfiedRequirements }
                ), {
                    phaseId: phaseInput.id, programId: program.id, candidate
                }, null, mass)]
            };
        }
        const instructions = program.instructions;
        const labels = new Map();
        instructions.forEach((instruction, index) => {
            if (instruction.label) labels.set(instruction.label, index);
            if (instruction.kind === "label" && instruction.name) labels.set(instruction.name, index);
        });
        const entryPc = program.entryPc === undefined || program.entryPc === null
            ? 0
            : resolveJumpTarget(program.entryPc, labels, instructions);
        let states = worlds.map(world => ({ pc: entryPc, locals: cloneValue(executionContext.sharedVariableKey ? world.randomValues[executionContext.sharedVariableKey] || { calcTemp: 0 } : {}), world, done: false }));
        const completed = [];
        const diagnostics = [];
        let unresolvedMass = ZERO;
        let steps = 0;

        while (states.length > 0 && steps < limits.maxInstructionSteps) {
            if (states.length > limits.maxWorlds) {
                const mass = states.reduce((sum, state) => sum.add(state.world.probability), ZERO);
                unresolvedMass = unresolvedMass.add(mass);
                diagnostics.push(diagnosticRecord(new EvaluationIssue("world-limit", `Program ${program.id} exceeded ${limits.maxWorlds} probability worlds`), {
                    phaseId: phaseInput.id, programId: program.id, candidate
                }, null, mass));
                states = [];
                break;
            }
            const nextStates = [];
            for (const state of states) {
                if (state.pc < 0 || state.pc >= instructions.length) {
                    completed.push({ ...state, done: true });
                    continue;
                }
                const instruction = instructions[state.pc];
                if ((instruction.kind === "label" || instruction.label) && !instruction.commandId && !instruction.command && !instruction.operation) {
                    nextStates.push({ ...state, pc: state.pc + 1 });
                    continue;
                }
                const commandId = instruction.commandId || instruction.command;
                const command = commandId ? commands.get(commandId) : null;
                const branchReason = instruction.reasonVariants?.find(variant => String(variant.branchPc) === String(state.lastBranch?.pc) && variant.branchTaken === state.lastBranch?.taken);
                const metadata = {
                    phaseId: phaseInput.id,
                    programId: program.id,
                    candidate,
                    instructionIndex: state.pc,
                    reasonCode: branchReason?.reasonCode || instruction.reasonCode || command?.reasonCode,
                    title: branchReason?.title || instruction.title || command?.title,
                    instructionSummary: branchReason?.summary || instruction.summary,
                    // Program descriptions name an entire strategy, not the branch that earned points.
                    summary: branchReason?.summary || instruction.summary || command?.summary || "An enabled AI scoring rule changed this candidate's incentive score.",
                    programReasonCode: program.educationalReason?.code || null,
                    source: cloneValue(instruction.source || null)
                };
                try {
                    if (commandId && !command) throw new EvaluationIssue("unknown-command", `Command ${commandId} is not declared`);
                    if (command?.executable === false) throw new EvaluationIssue("command-unavailable", `Command ${commandId} is not executable`, { semanticStatus: command.semanticStatus || null });
                    const operation = instruction.operation || command?.operation;
                    if (!operation) throw new EvaluationIssue("missing-operation", `Instruction ${state.pc} has no executable operation`);
                    const args = normalizedArguments(instruction, command);
                    const context = {
                        state: request.state,
                        battle: request.state.battle || request.state,
                        trainer: request.trainer,
                        candidate,
                        phase: phaseInput,
                        request
                    };
                    const environment = {
                        profile,
                        queries,
                        context,
                        locals: state.locals,
                        arguments: args.named,
                        argumentList: args.list,
                        program,
                        instruction,
                        instructionIndex: state.pc,
                        executionState: state,
                        randomSources,
                        educationalScoreMarginals: executionContext.educationalScoreMarginals === true
                    };
                    const result = executeOperation(state, operation, environment, metadata, labels, instructions, randomSources, limits);
                    if (result.next) nextStates.push(...result.next);
                    if (result.complete) completed.push(...result.complete);
                } catch (error) {
                    const issue = error instanceof EvaluationIssue ? error : new EvaluationIssue("evaluation-error", error.message || String(error));
                    unresolvedMass = unresolvedMass.add(state.world.probability);
                    diagnostics.push(diagnosticRecord(issue, metadata, instruction, state.world.probability));
                }
            }
            states = mergeExecutionStates(nextStates);
            steps += 1;
        }
        if (states.length > 0) {
            const mass = states.reduce((sum, state) => sum.add(state.world.probability), ZERO);
            unresolvedMass = unresolvedMass.add(mass);
            diagnostics.push(diagnosticRecord(new EvaluationIssue("instruction-limit", `Program ${program.id} exceeded ${limits.maxInstructionSteps} steps`), {
                phaseId: phaseInput.id, programId: program.id, candidate
            }, null, mass));
        }
        return { worlds: mergeWorlds(completed.map(state => {
            if (executionContext.sharedVariableKey) state.world.randomValues[executionContext.sharedVariableKey] = cloneValue(state.locals);
            return state.world;
        })), unresolvedMass, diagnostics };
    }

    function phaseDescriptor(entry, profile) {
        if (typeof entry === "string") {
            const model = profile.selectionModels?.[entry] || {};
            return { id: entry, mode: model.mode || (entry.includes("move") ? "scoring" : "decision"), ...model };
        }
        return entry;
    }

    function activePrograms(profile, phase, input, candidate, allowValidationOnlyPrograms = false) {
        const programs = profile.programs;
        const explicit = candidate?.programIds || input.programIds || phase.programIds;
        if (Array.isArray(explicit)) {
            for (const programId of explicit) {
                const program = programs.find(entry => entry.id === programId);
                if (program?.activation?.executableEntry === false) {
                    throw new EvaluationIssue("program-not-live-executable", `Program ${programId} has no live executable entry`);
                }
                if (program?.activation?.validationOnly === true && !allowValidationOnlyPrograms) {
                    throw new EvaluationIssue("validation-only-program", `Program ${programId} may run only as a profile validation case`);
                }
            }
            return explicit;
        }
        const activeFlags = new Set((input.activeFlagIds || input.flagIds || []).map(String));
        return programs.filter(program => {
            const activation = program.activation || {};
            if (activation.executableEntry === false) return false;
            if (activation.validationOnly === true && !allowValidationOnlyPrograms) return false;
            const activationPhase = activation.phaseId || activation.phase;
            const activationFlag = activation.flagId ?? activation.flag;
            if (activationPhase && activationPhase !== phase.id) return false;
            if (program.kind && phase.programKind && program.kind !== phase.programKind) return false;
            if (activationFlag !== undefined && activationFlag !== null && !activeFlags.has(String(activationFlag))) return false;
            return activationPhase === phase.id || activationFlag !== undefined && activationFlag !== null && activeFlags.has(String(activationFlag));
        }).sort((left, right) => Number(left.activation?.order ?? left.order ?? 0) - Number(right.activation?.order ?? right.order ?? 0)).map(program => program.id);
    }

    function runPrograms(worlds, programIds, executionContext, programs) {
        let active = worlds;
        const emitted = [];
        let unresolvedMass = ZERO;
        const diagnostics = [];
        for (const programId of programIds) {
            const program = programs.get(programId);
            if (!program) {
                const mass = active.reduce((sum, world) => sum.add(world.probability), ZERO);
                unresolvedMass = unresolvedMass.add(mass);
                diagnostics.push(diagnosticRecord(new EvaluationIssue("unknown-program", `Program ${programId} is not declared`), {
                    phaseId: executionContext.phaseInput.id, programId, candidate: executionContext.candidate
                }, null, mass));
                active = [];
                break;
            }
            const result = executeProgram(active, program, executionContext);
            unresolvedMass = unresolvedMass.add(result.unresolvedMass);
            diagnostics.push(...result.diagnostics);
            active = [];
            for (const world of result.worlds) {
                if (world.action) emitted.push(world);
                else active.push(world);
            }
            if (active.length === 0) break;
        }
        return { worlds: mergeWorlds([...active, ...emitted]), unresolvedMass, diagnostics };
    }

    function addMass(map, key, value, create) {
        const current = map.get(key);
        if (!current) {
            map.set(key, create(value));
            return;
        }
        current.mass = current.mass.add(value);
    }

    function aggregateAction(actionMap, world, factor = ONE, candidateId = null) {
        const mass = world.probability.multiply(factor);
        const action = cloneValue(world.action);
        const key = stableStringify(action);
        let record = actionMap.get(key);
        if (!record) {
            record = { action, mass: ZERO, traces: new Map(), candidateIds: new Set() };
            actionMap.set(key, record);
        }
        record.mass = record.mass.add(mass);
        if (candidateId) record.candidateIds.add(candidateId);
        for (const [traceKey, trace] of world.traces) {
            const current = record.traces.get(traceKey);
            const traceMass = trace.mass.multiply(factor);
            record.traces.set(traceKey, { event: trace.event, mass: (current?.mass || ZERO).add(traceMass) });
        }
    }

    function verifyScoringCoverage(phase, input, candidates, context) {
        const model = context.profile.selectionModels?.scoringCoverage;
        if (!model) return; // Existing profiles retain their declared source schedules.
        if (model.kind !== 'required-flag-programs') throw new EvaluationIssue('unsupported-scoring-coverage', 'Unknown scoring coverage model');
        if (context.allowValidationOnlyPrograms && input.validationScope === 'isolated-source-slice') return;
        const flags = getPath(context.request, model.flagIdsRequestPath);
        if (!Array.isArray(flags) || flags.some(flag => !['string', 'number'].includes(typeof flag)) || new Set(flags.map(String)).size !== flags.length) {
            throw new EvaluationIssue('missing-scoring-flags', 'Complete effective scoring flags are required');
        }
        if (model.flagMaskRequestPath !== undefined || model.bitByFlag !== undefined) {
            const mask = typeof model.flagMaskRequestPath === 'string' ? getPath(context.request, model.flagMaskRequestPath) : undefined;
            const entries = Object.entries(model.bitByFlag || {});
            if (typeof model.flagMaskRequestPath !== 'string' || !Number.isInteger(mask) || mask < 0 || mask > 0xFFFFFFFF
                || entries.length === 0 || entries.some(([, bit]) => !Number.isInteger(bit) || bit < 0 || bit > 31)
                || new Set(entries.map(([, bit]) => bit)).size !== entries.length) {
                throw new EvaluationIssue('invalid-scoring-mask', 'The effective scoring mask and its numeric bit bindings are required');
            }
            const knownMask = entries.reduce((value, [, bit]) => value | (1n << BigInt(bit)), 0n);
            const numericMask = BigInt(mask);
            if ((numericMask & ~knownMask) !== 0n) throw new EvaluationIssue('scoring-coverage-unavailable', 'The effective mask reaches an unbound scoring or special-action bit');
            const decoded = entries.filter(([, bit]) => (numericMask & (1n << BigInt(bit))) !== 0n).map(([flag]) => flag).sort();
            if (stableStringify(decoded) !== stableStringify([...flags.map(String)].sort())) {
                throw new EvaluationIssue('scoring-flag-mismatch', 'Decoded scoring flags do not match the effective numeric mask');
            }
        }
        const suppliedFlags = input.activeFlagIds ?? input.flagIds;
        if (suppliedFlags && (!Array.isArray(suppliedFlags) || stableStringify([...suppliedFlags.map(String)].sort()) !== stableStringify([...flags.map(String)].sort()))) {
            throw new EvaluationIssue('scoring-flag-mismatch', 'Phase flags do not match the effective trainer flags');
        }
        const order = model.flagOrder;
        if (!Array.isArray(order) || new Set(order.map(String)).size !== order.length || flags.some(flag => !order.map(String).includes(String(flag)))) throw new EvaluationIssue('scoring-coverage-unavailable', 'Effective flag is absent from the source scoring order');
        const orderedFlags = order.filter(flag => flags.map(String).includes(String(flag)));
        const required = [];
        for (const flag of orderedFlags) {
            const binding = model.requiredProgramsByFlag?.[String(flag)];
            if (!binding || binding.coverage !== 'complete' || !Array.isArray(binding.programIds) || binding.programIds.length === 0) {
                throw new EvaluationIssue('scoring-coverage-unavailable', `Scoring flag ${flag} does not have a complete program binding`, { flagId: flag });
            }
            required.push(...binding.programIds);
        }
        for (const candidate of candidates) {
            const selected = activePrograms(context.profile, phase, input, candidate, context.allowValidationOnlyPrograms);
            if (stableStringify(selected) !== stableStringify(required)) throw new EvaluationIssue('incomplete-scoring-programs', 'Candidate programs omit, replace, duplicate or reorder a required scoring program', { candidateId: candidate.id, required, selected });
        }
    }

    function scoringPhase(worlds, phase, input, context) {
        const candidates = (input.candidates || []).filter(candidate => candidate && candidate.enabled !== false && candidate.legal !== false);
        verifyScoringCoverage(phase, input, candidates, context);
        if (candidates.length === 0) {
            const mass = worlds.reduce((sum, world) => sum.add(world.probability), ZERO);
            return {
                worlds: [],
                unresolvedMass: mass,
                diagnostics: [diagnosticRecord(new EvaluationIssue("no-legal-candidates", `Phase ${phase.id} has no legal candidates`), {
                    phaseId: phase.id, programId: null, candidate: null
                }, null, mass)],
                scoreDistributions: [],
                scoreAdjustments: []
            };
        }
        let active = worlds.map(world => {
            const next = cloneWorld(world);
            for (const candidate of candidates) {
                next.scores[candidate.id] = Number(candidate.initialScore ?? input.initialScore ?? context.profile.numericModel.initialScore);
            }
            return next;
        });
        let unresolvedMass = ZERO;
        const diagnostics = [];
        const schedule = input.sourceRoutine === true ? context.profile.selectionModels?.scoringExecution?.byFormat?.[context.request.state.battle.format] : null;
        if (input.sourceRoutine === true && !schedule) throw new EvaluationIssue('missing-scoring-schedule', 'A source-routine scoring request requires a declared execution schedule');
        const scheduledDraws = (world, descriptors) => {
            let next = cloneWorld(world);
            const memory = { ...(next.randomValues[`scoring-pass:${phase.id}`] || {}) };
            for (const descriptor of descriptors || []) {
                const values = [];
                for (let i = 0; i < descriptor.count; i++) {
                    const source = context.randomSources.get(descriptor.source);
                    if (!source) throw new EvaluationIssue('missing-random-source', `Unknown setup source ${descriptor.source}`);
                    if (context.educationalScoreMarginals === true) {
                        values.push(sourceRepresentativeValue(source));
                    } else {
                        const draw = drawFromExactG4State(next, source);
                        if (!draw) throw new EvaluationIssue('conditional-readiness-unsatisfied', 'Source-order setup requires a shared random trajectory', { requirements: [{ requestPath: 'state.random.g4LcrngSeed', valueType: 'uint32' }] });
                        next = draw.world;
                        values.push(draw.value);
                    }
                }
                if (descriptor.storeAs) memory[descriptor.storeAs] = values;
            }
            next.randomValues[`scoring-pass:${phase.id}`] = memory;
            return next;
        };
        if (schedule) active = active.map(world => scheduledDraws(world, schedule.initialDraws));
        const grouped = new Map();
        for (const candidate of candidates) {
            const key = schedule ? getPath(candidate, schedule.groupBy) : candidate.id;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(candidate);
        }
        const groups = [...grouped.entries()];
        if (schedule) groups.sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [groupId, group] of groups) {
            if (schedule) {
                group.sort((a, b) => Number(getPath(a, schedule.candidateOrderBy)) - Number(getPath(b, schedule.candidateOrderBy)));
                active = active.map(world => {
                    const next = scheduledDraws(world, schedule.groupDraws);
                    next.randomValues[`scoring-locals:${phase.id}`] = { calcTemp: 0 };
                    return next;
                });
            }
            const pairs = schedule
                ? activePrograms(context.profile, phase, input, null, context.allowValidationOnlyPrograms).flatMap(programId => group.map(candidate => ({ candidate, programIds: [programId] })))
                : group.map(candidate => ({ candidate, programIds: activePrograms(context.profile, phase, input, candidate, context.allowValidationOnlyPrograms) }));
            for (const { candidate, programIds } of pairs) {
            if (candidate.skipScoring === true) continue;
            const result = runPrograms(active, programIds, { ...context, phaseInput: input, candidate, sharedVariableKey: schedule ? `scoring-locals:${phase.id}` : null }, context.programs);
            unresolvedMass = unresolvedMass.add(result.unresolvedMass);
            diagnostics.push(...result.diagnostics);
            active = result.worlds;
            if (active.some(world => world.action)) {
                const mass = active.filter(world => world.action).reduce((sum, world) => sum.add(world.probability), ZERO);
                unresolvedMass = unresolvedMass.add(mass);
                diagnostics.push(diagnosticRecord(new EvaluationIssue("unexpected-scoring-action", `Scoring program emitted an action in phase ${phase.id}`), {
                    phaseId: phase.id, programId: null, candidate
                }, null, mass));
                active = active.filter(world => !world.action);
            }
            if (active.length === 0) break;
            }
            if (schedule?.selectWithinGroupAfterScoring && context.educationalScoreMarginals !== true) active = active.map(world => {
                const winners = maximumCandidates(world, group);
                const draw = exactG4Selection(world, winners.length);
                if (!draw) throw new EvaluationIssue('missing-random-state', 'Scheduled group selection requires the same random trajectory');
                const selected = { candidateId: winners[draw.index].id, score: world.scores[winners[draw.index].id] };
                if (group[0].targetIsAlly && selected.score < context.profile.numericModel.initialScore) selected.score = -1;
                draw.world.randomValues[`group-selection:${stableStringify(groupId)}`] = selected;
                return draw.world;
            });
            if (active.length === 0) break;
        }
        const scoreMaps = new Map(candidates.map(candidate => [candidate.id, new Map()]));
        for (const world of active) {
            for (const candidate of candidates) {
                const score = world.scores[candidate.id];
                const map = scoreMaps.get(candidate.id);
                map.set(score, (map.get(score) || ZERO).add(world.probability));
            }
        }
        const scoreAdjustments = new Map();
        const choiceAdjustmentMass = new Map();
        const phaseStartingMass = worlds.reduce((sum, world) => sum.add(world.probability), ZERO);
        for (const world of active) {
            for (const trace of world.traces.values()) {
                const event = trace.event;
                if (event.phaseId !== phase.id || !event.candidateId || !Number.isInteger(event.delta)) continue;
                const key = stableStringify({
                    phaseId: event.phaseId,
                    programId: event.programId,
                    candidateId: event.candidateId,
                    instructionPc: event.instructionPc,
                    reasonCode: event.reasonCode,
                    title: event.title,
                    summary: event.summary,
                    delta: event.delta,
                    scoringProbability: event.scoringProbability,
                    probabilityBasis: event.probabilityBasis
                });
                if (!scoreAdjustments.has(key)) scoreAdjustments.set(key, cloneValue(event));
                if (event.probabilityBasis === "pre-selection-random-choice") {
                    choiceAdjustmentMass.set(key, (choiceAdjustmentMass.get(key) || ZERO).add(trace.mass));
                }
            }
        }
        for (const [key, mass] of choiceAdjustmentMass) {
            scoreAdjustments.get(key).scoringProbability = mass.divide(phaseStartingMass).toJSON();
        }
        return {
            worlds: active,
            unresolvedMass,
            diagnostics,
            candidates,
            scoreAdjustments: [...scoreAdjustments.values()],
            scoreDistributions: candidates.map(candidate => ({
                candidateId: candidate.id,
                scores: [...scoreMaps.get(candidate.id).entries()].sort((a, b) => Number(b[0]) - Number(a[0])).map(([score, probability]) => ({ score: Number(score), probability: probability.toJSON() }))
            }))
        };
    }

    function aggregateDiagnostics(records) {
        const aggregated = new Map();
        for (const record of records) {
            const key = stableStringify({ ...record, mass: undefined });
            const current = aggregated.get(key);
            if (!current) aggregated.set(key, { ...record, mass: record.mass });
            else current.mass = current.mass.add(record.mass);
        }
        return [...aggregated.values()].map(record => ({ ...record, probability: record.mass.toJSON(), mass: undefined }));
    }

    function actionRecords(actionMap, knownMass) {
        return [...actionMap.values()].sort((left, right) => right.mass.compare(left.mass)).map(record => ({
            action: record.action,
            probability: record.mass.toJSON(),
            conditionalOnKnown: knownMass.isZero() ? null : record.mass.divide(knownMass).toJSON(),
            candidateIds: [...record.candidateIds].sort(),
            reasons: [...record.traces.values()].sort((left, right) => right.mass.compare(left.mass)).map(trace => ({
                ...trace.event,
                probability: trace.mass.toJSON()
            }))
        }));
    }

    function candidateSelectionModel(profile, request) {
        const format = String(request.state?.battle?.format || "singles").toLowerCase();
        return profile.selectionModels?.moveTargetSelection?.byFormat?.[format]
            || { kind: "uniform-maximum-candidates", scoreField: "score", tieDistribution: "uniform" };
    }

    function maximumCandidates(world, candidates) {
        const maximum = Math.max(...candidates.map(candidate => Number(world.scores[candidate.id])));
        return candidates.filter(candidate => Number(world.scores[candidate.id]) === maximum);
    }

    function selectorFactors(selector, count) {
        if (!Number.isInteger(count) || count <= 0) throw new EvaluationIssue("invalid-selection-count", `Selection count ${count} is invalid`);
        const sampler = String(selector?.sourceSampler || "");
        if (!/BattleSystem_RandNext\s+modulo/i.test(sampler)) {
            const factor = new Rational(1n, BigInt(count));
            return Array.from({ length: count }, () => factor);
        }
        const denominator = 65536n;
        return Array.from({ length: count }, (_, residue) => {
            const numerator = ((65535n - BigInt(residue)) / BigInt(count)) + 1n;
            return new Rational(numerator, denominator);
        });
    }

    function exactG4Selection(world, count) {
        const draw = drawFromExactG4State(world, { id: "g4-selection", derivedFrom: "g4-lcrng-output" });
        return draw ? { index: draw.output % count, world: draw.world } : null;
    }

    function selectionWeights(world, candidates, model) {
        if (!candidates.length) throw new EvaluationIssue("no-scoring-candidates", "A scoring phase has no legal candidates");
        const staged = Object.entries(world.randomValues).filter(([key]) => key.startsWith('group-selection:')).map(([, value]) => value);
        if (staged.length) {
            const maximum = Math.max(...staged.map(row => row.score));
            const winners = staged.filter(row => row.score === maximum);
            const draw = exactG4Selection(world, winners.length);
            const candidate = candidates.find(row => row.id === winners[draw.index].candidateId);
            return [{ candidate, factor: ONE, world: draw.world, tieKind: 'staged-highest-score-tie' }];
        }
        if (!model || model.kind === "uniform-maximum-candidates") {
            const winners = maximumCandidates(world, candidates);
            const exact = /BattleSystem_RandNext\s+modulo/i.test(String(model?.sourceSampler || "")) ? exactG4Selection(world, winners.length) : null;
            if (exact) return [{ candidate: winners[exact.index], factor: ONE, world: exact.world, tieKind: winners.length > 1 ? "highest-score-tie" : null }];
            const factors = selectorFactors(model, winners.length);
            return winners.map((candidate, index) => ({ candidate, factor: factors[index], tieKind: winners.length > 1 ? "highest-score-tie" : null }));
        }
        if (["staged-maximum", "uniform-target-then-maximum"].includes(model.kind)) {
            const groupPath = model.groupBy || "action.target";
            const groups = new Map();
            for (const candidate of candidates) {
                const groupKey = stableStringify(getPath(candidate, groupPath));
                if (!groups.has(groupKey)) groups.set(groupKey, []);
                groups.get(groupKey).push(candidate);
            }
            const allGroups = [...groups.values()];
            let selectedGroups = allGroups;
            if (model.kind === "staged-maximum") {
                const groupMaximum = group => Math.max(...group.map(candidate => Number(world.scores[candidate.id])));
                const maximumGroupScore = Math.max(...selectedGroups.map(groupMaximum));
                selectedGroups = selectedGroups.filter(group => groupMaximum(group) === maximumGroupScore);
            }
            if (Number.isInteger(world.randomState?.g4LcrngSeed)) {
                let selectedWorld = world;
                const selectedWithinGroups = new Map();
                for (const group of allGroups) {
                    const winners = maximumCandidates(selectedWorld, group);
                    const draw = exactG4Selection(selectedWorld, winners.length);
                    selectedWorld = draw.world;
                    selectedWithinGroups.set(group, winners[draw.index]);
                }
                const groupDraw = exactG4Selection(selectedWorld, selectedGroups.length);
                return [{ candidate: selectedWithinGroups.get(selectedGroups[groupDraw.index]), factor: ONE, world: groupDraw.world, tieKind: "staged-highest-score-tie" }];
            }
            const groupFactors = selectorFactors(model.betweenGroups, selectedGroups.length);
            return selectedGroups.flatMap((group, groupIndex) => {
                const winners = maximumCandidates(world, group);
                const candidateFactors = selectorFactors(model.withinGroup, winners.length);
                const biasedGroupSampler = /BattleSystem_RandNext\s+modulo/i.test(String(model.betweenGroups?.sourceSampler || ""));
                const biasedCandidateSampler = /BattleSystem_RandNext\s+modulo/i.test(String(model.withinGroup?.sourceSampler || ""));
                if ((biasedGroupSampler && selectedGroups.length > 1 && 65536 % selectedGroups.length !== 0)
                    || (biasedCandidateSampler && winners.length > 1 && 65536 % winners.length !== 0)) {
                    throw new EvaluationIssue("unresolved-random-correlation", "A staged selector with a biased modulo count requires stateful LCRNG seed enumeration; multiplying marginal weights would overclaim an exact joint distribution");
                }
                return winners.map((candidate, candidateIndex) => ({
                    candidate,
                    factor: groupFactors[groupIndex].multiply(candidateFactors[candidateIndex]),
                    tieKind: "staged-highest-score-tie"
                }));
            });
        }
        throw new EvaluationIssue("unsupported-selection-model", `Unsupported candidate selection model ${model.kind}`);
    }

    function expectedSubset(actual, expected) {
        if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
        if (Array.isArray(expected)) {
            return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => expectedSubset(actual[index], value));
        }
        return actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => expectedSubset(actual[key], value));
    }

    function verifyNotApplicableEvidence(request, evidenceRows) {
        if (!Array.isArray(evidenceRows) || evidenceRows.length === 0) return false;
        const root = { state: request.state, trainer: request.trainer, request };
        return evidenceRows.every(row => {
            if (!row || !row.statePath) return false;
            const actual = getPath(root, row.statePath);
            switch (row.operator) {
            case "eq": return Object.is(actual, row.value);
            case "ne": return actual !== undefined && !Object.is(actual, row.value);
            case "empty": return Array.isArray(actual) ? actual.length === 0 : typeof actual === "string" ? actual.length === 0 : false;
            case "truthy": return Boolean(actual);
            case "falsy": return actual !== undefined && !actual;
            default: return false;
            }
        });
    }

    function distributionResult(outcomes) {
        const merged = new Map();
        for (const outcome of outcomes) {
            const probability = Rational.from(outcome.probability);
            if (probability.isZero()) continue;
            const key = stableStringify(outcome.value ?? null);
            const current = merged.get(key);
            if (current) current.probability = current.probability.add(probability);
            else merged.set(key, { value: cloneValue(outcome.value ?? null), probability });
        }
        return {
            $distribution: [...merged.values()].map(outcome => ({
                value: outcome.value,
                probability: outcome.probability.toJSON()
            }))
        };
    }

    function stateConditionSet(mon) {
        const conditions = new Set();
        const status = String(mon?.status || "none").toLowerCase();
        const statusAliases = { slp: "sleep", psn: "poison", brn: "burn", frz: "freeze", par: "paralysis", tox: "poison" };
        if (status && status !== "none") conditions.add(statusAliases[status] || status);
        const volatiles = mon?.volatiles || {};
        for (const [key, value] of Object.entries(volatiles)) if (value) conditions.add(String(key).toLowerCase().replaceAll("_", "-"));
        return conditions;
    }

    function gen5TrainerItemAction(profile, request, phaseInput) {
        const table = profile.trainerItemUse?.byNumericId || {};
        const bagSlots = request.trainer?.bagSlots || request.trainer?.battleProfile?.bagItemIds;
        if (!Array.isArray(bagSlots)) return undefined;
        const actor = request.state?.actor;
        const active = Array.isArray(phaseInput?.activePokemon) ? phaseInput.activePokemon : actor ? [actor] : [];
        if (!active.length) return undefined;
        const ordered = [...active].sort((left, right) => Number(right.positionOrder ?? right.positionIndex ?? 0) - Number(left.positionOrder ?? left.positionIndex ?? 0));
        const party = request.state?.sides?.ai?.party || request.state?.aiParty || [];
        const partyCount = Number(phaseInput?.partyCount ?? (party.filter(mon => !mon?.empty).length || 1));
        const slotMaximums = profile.trainerItemUse?.scan?.partyCountMaximumBySlot || [6, 4, 2, 1];
        for (const mon of ordered) {
            if (mon?.volatiles?.embargo || mon?.conditions?.includes?.("embargo") || mon?.volatiles?.semiInvulnerable || mon?.semiInvulnerable) continue;
            const currentHp = Number(mon?.hp ?? mon?.currentHp);
            const maximumHp = Number(mon?.maximumHp ?? mon?.maxHp);
            const conditions = stateConditionSet(mon);
            for (let slot = 0; slot < Math.min(4, bagSlots.length); slot += 1) {
                if (Number(slotMaximums[slot]) < partyCount) continue;
                const raw = bagSlots[slot];
                const numericId = Number(raw?.numericId ?? raw?.itemNumericId ?? raw);
                if (!Number.isInteger(numericId) || numericId <= 0) continue;
                const item = table[String(numericId)];
                if (!item) return undefined;
                const healingUsable = item.healing && Number.isFinite(currentHp) && Number.isFinite(maximumHp)
                    && currentHp > 0 && currentHp < maximumHp && currentHp <= Math.floor(maximumHp / 4);
                const cureUsable = (item.curedStatuses || []).some(status => conditions.has(status));
                const stageKey = item.raisedStat;
                const normalizedStageKey = ({ attack: "atk", defense: "def", speed: "spe", "special-attack": "spa", "special-defense": "spd", accuracy: "accuracy" })[stageKey] || stageKey;
                const currentStage = normalizedStageKey ? Number(mon?.stages?.[normalizedStageKey] ?? 0) : 0;
                const statUsable = Boolean(stageKey) && Number.isFinite(currentStage) && currentStage < 6;
                if (healingUsable || cureUsable || statUsable) {
                    return {
                        type: "item",
                        itemId: numericId,
                        itemToken: item.itemId,
                        bagSlot: slot,
                        target: mon.position ?? mon.id ?? "actor",
                        effect: {
                            healing: cloneValue(item.healing),
                            curedStatuses: cloneValue(item.curedStatuses || []),
                            raisedStat: item.raisedStat ?? null,
                            raisedStages: Number(item.raisedStages || 0)
                        }
                    };
                }
            }
        }
        return null;
    }

    function gen5SwitchOutDistribution(request, phaseInput) {
        if (String(request.state?.battle?.kind || "").toLowerCase() === "wild") return null;
        const context = phaseInput?.actionContext;
        if (!context || context.complete !== true || !Array.isArray(context.targets)) return undefined;
        if (context.canSwitch === false || context.targets.length === 0) return null;
        const targetFactor = new Rational(1n, BigInt(context.targets.length));
        const outcomes = [];
        for (const target of context.targets) {
            let remaining = targetFactor;
            const triggers = Array.isArray(target.triggers) ? target.triggers : [];
            for (const trigger of triggers) {
                if (trigger?.applicable !== true || remaining.isZero()) continue;
                const gateProbability = trigger.gateProbability ? Rational.from(trigger.gateProbability) : ONE;
                if (gateProbability.compare(ZERO) < 0 || gateProbability.compare(ONE) > 0) {
                    throw new EvaluationIssue("invalid-action-context", `Gate probability for ${trigger.id || "trigger"} is outside [0,1]`);
                }
                const skipped = remaining.multiply(ONE.subtract(gateProbability));
                let gatedRemaining = remaining.multiply(gateProbability);
                const attempts = Array.isArray(trigger.attempts) && trigger.attempts.length
                    ? trigger.attempts
                    : [{ partySlot: trigger.partySlot, probability: trigger.switchProbability }];
                for (const attempt of attempts) {
                    if (attempt?.partySlot === undefined || !attempt?.probability || gatedRemaining.isZero()) continue;
                    const switchProbability = Rational.from(attempt.probability);
                    if (switchProbability.compare(ZERO) < 0 || switchProbability.compare(ONE) > 0) {
                        throw new EvaluationIssue("invalid-action-context", `Switch probability for ${trigger.id || "trigger"} is outside [0,1]`);
                    }
                    outcomes.push({
                        value: { type: "switch", partySlot: attempt.partySlot, target: target.id ?? target.position ?? null, reason: trigger.id || "switch-trigger" },
                        probability: gatedRemaining.multiply(switchProbability)
                    });
                    gatedRemaining = gatedRemaining.multiply(ONE.subtract(switchProbability));
                }
                remaining = skipped.add(gatedRemaining);
            }
            outcomes.push({ value: null, probability: remaining });
        }
        return distributionResult(outcomes);
    }

    function gen5ReplacementDistribution(request, phaseInput) {
        const actor = request.state?.actor || {};
        const needsReplacement = actor.fainted === true || actor.pivoting === true || actor.forcedContinuation === "replacement";
        if (!needsReplacement) return null;
        const context = phaseInput?.actionContext;
        if (!context || context.complete !== true || !Array.isArray(context.targets) || context.targets.length === 0) return undefined;
        const factor = new Rational(1n, BigInt(context.targets.length));
        const outcomes = [];
        for (const target of context.targets) {
            const candidates = (target.candidates || []).filter(candidate => candidate?.legal !== false && Number.isFinite(Number(candidate?.score)));
            if (!candidates.length) return undefined;
            const best = Math.max(...candidates.map(candidate => Number(candidate.score)));
            const winner = candidates.filter(candidate => Number(candidate.score) === best)
                .sort((left, right) => Number(left.partyOrder ?? left.partySlot) - Number(right.partyOrder ?? right.partySlot))[0];
            outcomes.push({
                value: { type: "switch", partySlot: winner.partySlot, target: target.id ?? target.position ?? null, reason: "replacement-ranking" },
                probability: factor
            });
        }
        return distributionResult(outcomes);
    }

    function gen5ActionResolver(profile, request, resolverId) {
        const phaseInput = request.phaseInputs?.[resolverId] || {};
        const actor = request.state?.actor || {};
        if (resolverId === "forced-continuation") {
            const continuation = actor.forcedContinuation;
            if (continuation === null || continuation === undefined || continuation === "replacement") return null;
            if (continuation.action && typeof continuation.action === "object") return cloneValue(continuation.action);
            if (continuation.kind === "recharge") return { type: "recharge", actorId: actor.id, forced: true };
            const moveId = continuation.moveId ?? continuation.move ?? continuation;
            if (!["string", "number"].includes(typeof moveId)) throw new EvaluationIssue("invalid-forced-continuation", "A forced move must identify a move; choice locks are candidate restrictions, not forced actions.");
            return { type: "move", moveId, target: continuation.target ?? actor.forcedTarget ?? null, forced: true };
        }
        if (resolverId === "trainer-item-selection") return gen5TrainerItemAction(profile, request, phaseInput);
        if (resolverId === "switch-out") return gen5SwitchOutDistribution(request, phaseInput);
        if (resolverId === "switch-in-or-replacement") return gen5ReplacementDistribution(request, phaseInput);
        if (resolverId === "rotation") {
            if (String(request.state?.battle?.format || "").toLowerCase() !== "rotation") return null;
            if (phaseInput?.actorPreselected === true) return null;
            return undefined;
        }
        return undefined;
    }

    function gen5MoveEffectJump(minimum, maximum, tableToken, metadata) {
        const candidate = metadata?.context?.candidate || {};
        const effect = Number(candidate.aiEffectId ?? candidate.move?.aiEffectId ?? candidate.moveData?.aiEffectId);
        if (!Number.isInteger(effect)) return undefined;
        if (effect < Number(minimum) || effect > Number(maximum)) return "__program_end__";
        const instructions = metadata?.program?.instructions || [];
        const labelIndex = instructions.findIndex(instruction => instruction.label === tableToken);
        if (labelIndex < 0) return undefined;
        const entries = [];
        for (let index = labelIndex + 1; index < instructions.length; index += 1) {
            const instruction = instructions[index];
            if (instruction.label) break;
            if (instruction.commandId === "meta-table-entry") entries.push(instruction);
        }
        const entry = entries[effect - Number(minimum)];
        return entry?.arguments?.target?.pc ?? entry?.arguments?.target?.token;
    }

    function builtInQueries(profile, request) {
        if (Number(profile.generation) !== 5) return {};
        return {
            "gen5.action.resolve": (resolverId) => gen5ActionResolver(profile, request, resolverId),
            "gen5.command.0x73": (minimum, maximum, tableToken, metadata) => gen5MoveEffectJump(minimum, maximum, tableToken, metadata)
        };
    }

    // Execute an explicitly selected Dataset query routine through the same IR.
    // Query routines return a numeric/value result, never a battle action or planner node.
    function evaluateQueryProgram({ profile, programId, state, queries = {} }) {
        const program = programMap(profile).get(programId);
        if (!program || program.kind !== "query-routine") throw new EvaluationIssue("missing-query-program", `No query routine ${programId}`);
        const request = { state, trainer: {}, phaseInputs: {}, actorId: "query" };
        const result = executeProgram([newWorld(ONE, request)], program, {
            profile, request, queries, commands: commandMap(profile), randomSources: randomSourceMap(profile),
            phaseInput: { id: "query" }, candidate: null,
            limits: { maxWorlds: 1, maxInstructionSteps: 10000, maxRandomSupport: 4096 }
        });
        if (result.diagnostics.length || result.worlds.length !== 1) throw new EvaluationIssue("query-program-unavailable", `Query routine ${programId} could not produce one value`, { diagnostics: result.diagnostics });
        return result.worlds[0].returnValue;
    }

    function evaluate(options) {
        const profile = validateProfile(options?.profile);
        const request = validateRequest(options?.request);
        validatePrecedingActors(options, profile);
        return evaluateActorPass(options, profile, request);
    }

    function validatePrecedingActors(options, profile) {
        if (!options?.precedingActors?.length) return;
        if (Number(profile.generation) !== 4 || profile.selectionModels?.actorSelectionPass?.kind !== 'serialized-full-actor' || options.precedingActors.length > 3) throw new EvaluationIssue('unsupported-actor-pass', 'The profile must declare source-ordered full actor selection');
        const ids = new Set();
        for (const entry of [...options.precedingActors, options]) {
            validateRequest(entry.request);
            if (!entry.request.actorId || ids.has(entry.request.actorId)) throw new EvaluationIssue('invalid-actor-pass', 'Each actor occurs exactly once in a selection pass');
            ids.add(entry.request.actorId);
        }
    }

    // Replay preceding actors within each world, never multiply their marginal
    // forecasts. Their terminal RNG, query cache and switch reservations become
    // the next actor's input. Hidden-state alternatives cover the entire pass.
    function evaluateActorPass(options, profile, request) {
        if (!options?.precedingActors?.length) return evaluateValidated(options, profile, request);
        let random = cloneValue(request.state.random || {}), memory = cloneValue(request.state.queryMemory || {});
        const selectedActions = [];
        const reservations = [...(request.state.aiSwitchedPartySlots || [])];
        for (const entry of options.precedingActors) {
            const input = cloneValue(entry.request);
            input.captureContinuationState = true;
            input.state = { ...input.state, random, queryMemory: memory, hiddenStateValues: cloneValue(request.state.hiddenStateValues || {}), aiSwitchedPartySlots: [...reservations] };
            const result = evaluateValidated(entry, profile, input);
            if (result.status !== 'exact') return result;
            if (result.continuationStates.length !== 1) return { ...result, status: 'unavailable', actions: [], knownProbability: ZERO.toJSON(), unresolvedProbability: ONE.toJSON(), diagnostics: [{ code: 'conditional-readiness-unsatisfied', message: 'A shared actor pass requires one source RNG trajectory', details: { requirements: [{ requestPath: 'state.random.g4LcrngSeed', valueType: 'uint32' }] } }] };
            const terminal = result.continuationStates[0];
            random = terminal.randomState;
            memory = terminal.queryMemory;
            selectedActions.push({ actorId: input.actorId, action: terminal.action });
            if (terminal.action.type === 'switch') reservations.push(terminal.action.partySlot);
        }
        const input = cloneValue(request);
        input.captureContinuationState = true;
        input.state = { ...input.state, random, queryMemory: memory, aiSwitchedPartySlots: reservations };
        const result = evaluateValidated(options, profile, input);
        result.selectionPassOutcomes = (result.continuationStates || []).map(terminal => ({ actions: [...selectedActions, { actorId: request.actorId, action: terminal.action }], probability: terminal.probability }));
        return result;
    }

    // A forecast validates its immutable contract once, then executes independent
    // hidden-state worlds. Public evaluate() still validates every invocation.
    function evaluateValidated(options, profile, request) {
        const queries = { ...builtInQueries(profile, request), ...(options?.queries || {}) };
        const limits = {
            maxWorlds: Number(options?.limits?.maxWorlds || 100000),
            maxInstructionSteps: Number(options?.limits?.maxInstructionSteps || 10000),
            maxRandomSupport: Number(options?.limits?.maxRandomSupport || 4096)
        };
        const commands = commandMap(profile);
        const programs = programMap(profile);
        const randomSources = randomSourceMap(profile);
        const context = { profile, request, queries, limits, commands, programs, randomSources, allowValidationOnlyPrograms: options?._validationRun === true };
        const actionMap = new Map();
        const continuationStates = [];
        const recordAction = (world, factor = ONE, candidateId = null) => {
            aggregateAction(actionMap, world, factor, candidateId);
            if (request.captureContinuationState === true) continuationStates.push({ action: cloneValue(world.action), probability: world.probability.multiply(factor).toJSON(), randomState: cloneValue(world.randomState), queryMemory: cloneValue(world.queryMemory) });
        };
        const diagnostics = [];
        const phaseCoverage = [];
        const scoreDistributions = [];
        const scoreAdjustments = [];
        let unresolvedMass = ZERO;
        let active = [newWorld(ONE, request)];
        const pipeline = profile.actionPipeline.map(rawPhase => phaseDescriptor(rawPhase, profile));
        const startPhaseId = request.evaluationScope?.startPhaseId || null;
        const startIndex = startPhaseId ? pipeline.findIndex(phase => phase.id === startPhaseId) : 0;
        if (startPhaseId && startIndex < 0) throw new EvaluationIssue("invalid-evaluation-scope", `Evaluation start phase ${startPhaseId} is not in the profile action pipeline`);

        for (const phase of pipeline.slice(startIndex)) {
            if (active.length === 0) break;
            const supplied = request.phaseInputs[phase.id];
            if (!supplied) {
                if (phase.optional === true) {
                    phaseCoverage.push({ phaseId: phase.id, status: "skipped-optional" });
                    continue;
                }
                const mass = active.reduce((sum, world) => sum.add(world.probability), ZERO);
                unresolvedMass = unresolvedMass.add(mass);
                diagnostics.push(diagnosticRecord(new EvaluationIssue("missing-phase-input", `Request does not provide phase ${phase.id}`), {
                    phaseId: phase.id, programId: null, candidate: null
                }, null, mass));
                phaseCoverage.push({ phaseId: phase.id, status: "unavailable", probability: mass.toJSON() });
                active = [];
                break;
            }
            const input = { id: phase.id, ...supplied };
            const startingMass = active.reduce((sum, world) => sum.add(world.probability), ZERO);
            if (input.disposition === "not-applicable") {
                if (!verifyNotApplicableEvidence(request, input.notApplicableEvidence)) {
                    unresolvedMass = unresolvedMass.add(startingMass);
                    diagnostics.push(diagnosticRecord(new EvaluationIssue("invalid-not-applicable-proof", `Phase ${phase.id} was marked not applicable without evidence that matches the request state`), {
                        phaseId: phase.id, programId: null, candidate: null
                    }, null, startingMass));
                    phaseCoverage.push({ phaseId: phase.id, status: "unavailable", unresolvedProbability: startingMass.toJSON() });
                    active = [];
                    break;
                }
                phaseCoverage.push({ phaseId: phase.id, status: "not-applicable", inputProbability: startingMass.toJSON() });
                continue;
            }
            if (input.disposition === "unavailable") {
                unresolvedMass = unresolvedMass.add(startingMass);
                diagnostics.push(diagnosticRecord(new EvaluationIssue("phase-unavailable", input.reason || `Phase ${phase.id} is unavailable for this request`), {
                    phaseId: phase.id, programId: null, candidate: null
                }, null, startingMass));
                phaseCoverage.push({ phaseId: phase.id, status: "unavailable", unresolvedProbability: startingMass.toJSON() });
                active = [];
                break;
            }
            if ((input.mode || phase.mode) === "scoring") {
                let result;
                try { result = scoringPhase(active, phase, input, context); }
                catch (error) {
                    const issue = error instanceof EvaluationIssue ? error : new EvaluationIssue('evaluation-error', error.message || String(error));
                    result = { worlds: [], candidates: [], unresolvedMass: startingMass, diagnostics: [diagnosticRecord(issue, { phaseId: phase.id, programId: null, candidate: null }, null, startingMass)], scoreDistributions: [], scoreAdjustments: [] };
                }
                unresolvedMass = unresolvedMass.add(result.unresolvedMass);
                diagnostics.push(...result.diagnostics);
                scoreDistributions.push(...result.scoreDistributions.map(entry => ({ phaseId: phase.id, ...entry })));
                scoreAdjustments.push(...result.scoreAdjustments);
                const selectionModel = candidateSelectionModel(profile, request);
                for (const world of result.worlds) {
                    for (const selection of selectionWeights(world, result.candidates, selectionModel)) {
                        const { candidate, factor, tieKind } = selection;
                        const selected = cloneWorld(selection.world || world);
                        selected.action = cloneValue(candidate.selectedAction || candidate.action || { type: "candidate", candidateId: candidate.id });
                        if (tieKind) {
                            addTrace(selected, {
                                phaseId: phase.id,
                                programId: null,
                                candidateId: candidate.id,
                                reasonCode: tieKind,
                                summary: tieKind === "staged-highest-score-tie"
                                    ? "The game selected a target group under the format's documented selector, then selected uniformly among that group's highest-scoring moves."
                                    : "Multiple legal candidates shared the highest score, so the game selected uniformly among them."
                            });
                        }
                        recordAction(selected, factor, candidate.id);
                    }
                }
                const resolvedMass = result.worlds.reduce((sum, world) => sum.add(world.probability), ZERO);
                phaseCoverage.push({ phaseId: phase.id, status: result.unresolvedMass.isZero() ? "exact" : "partial", inputProbability: startingMass.toJSON(), resolvedProbability: resolvedMass.toJSON(), unresolvedProbability: result.unresolvedMass.toJSON() });
                active = [];
                break;
            }
            const programIds = activePrograms(profile, phase, input, null, context.allowValidationOnlyPrograms);
            const readinessStatus = phase.status || profile.readiness?.phases?.[phase.id]?.status || "unavailable";
            if (programIds.length === 0 && readinessStatus !== "exact") {
                unresolvedMass = unresolvedMass.add(startingMass);
                diagnostics.push(diagnosticRecord(new EvaluationIssue("unproven-phase-no-action", `Phase ${phase.id} is ${readinessStatus}; an empty program list does not prove that the phase selected no action`), {
                    phaseId: phase.id, programId: null, candidate: null
                }, null, startingMass));
                phaseCoverage.push({ phaseId: phase.id, status: "unavailable", unresolvedProbability: startingMass.toJSON() });
                active = [];
                break;
            }
            const result = runPrograms(active, programIds, { ...context, phaseInput: input, candidate: null }, programs);
            unresolvedMass = unresolvedMass.add(result.unresolvedMass);
            diagnostics.push(...result.diagnostics);
            active = [];
            let emittedMass = ZERO;
            for (const world of result.worlds) {
                if (world.action) {
                    emittedMass = emittedMass.add(world.probability);
                    recordAction(world);
                } else active.push(world);
            }
            const passMass = active.reduce((sum, world) => sum.add(world.probability), ZERO);
            phaseCoverage.push({ phaseId: phase.id, status: result.unresolvedMass.isZero() ? "exact" : "partial", inputProbability: startingMass.toJSON(), actionProbability: emittedMass.toJSON(), passProbability: passMass.toJSON(), unresolvedProbability: result.unresolvedMass.toJSON() });
        }

        if (active.length > 0) {
            if (request.fallbackAction) {
                for (const world of active) {
                    const selected = cloneWorld(world);
                    selected.action = cloneValue(request.fallbackAction);
                    recordAction(selected);
                }
            } else {
                const mass = active.reduce((sum, world) => sum.add(world.probability), ZERO);
                unresolvedMass = unresolvedMass.add(mass);
                diagnostics.push(diagnosticRecord(new EvaluationIssue("no-final-action", "The action pipeline ended without selecting an action"), {
                    phaseId: null, programId: null, candidate: null
                }, null, mass));
            }
        }

        const knownMass = [...actionMap.values()].reduce((sum, record) => sum.add(record.mass), ZERO);
        const accounted = knownMass.add(unresolvedMass);
        if (accounted.compare(ONE) < 0) {
            const missing = ONE.subtract(accounted);
            unresolvedMass = unresolvedMass.add(missing);
            diagnostics.push(diagnosticRecord(new EvaluationIssue("unaccounted-probability", "The evaluator found unaccounted probability mass"), {
                phaseId: null, programId: null, candidate: null
            }, null, missing));
        }
        if (accounted.compare(ONE) > 0) throw new EvaluationIssue("probability-overflow", "Evaluator probability mass exceeded one");
        const status = knownMass.isZero() ? "unavailable" : unresolvedMass.isZero() && knownMass.compare(ONE) === 0 ? "exact" : "partial";
        return {
            schemaVersion: RESPONSE_SCHEMA_VERSION,
            requestId: request.requestId || null,
            profileId: profile.profileId,
            generation: Number(profile.generation),
            engineFamily: profile.engineFamily,
            evaluationScope: startPhaseId
                ? { kind: "conditional-on-phase-entry", startPhaseId }
                : { kind: "full-action-pipeline" },
            status,
            knownProbability: knownMass.toJSON(),
            unresolvedProbability: unresolvedMass.toJSON(),
            actions: actionRecords(actionMap, knownMass),
            scoreDistributions,
            scoreAdjustments,
            phaseCoverage,
            ...(request.captureContinuationState === true ? { continuationStates } : {}),
            diagnostics: aggregateDiagnostics(diagnostics)
        };
    }

    function likelihoodBand(value) {
        const probability = Rational.from(value);
        if (probability.compare(ZERO) < 0 || probability.compare(ONE) > 0) {
            throw new EvaluationIssue("invalid-forecast-weight", "Forecast weight must be between zero and one");
        }
        const band = probability.compare(ONE) === 0
            ? LIKELIHOOD_BANDS[LIKELIHOOD_BANDS.length - 1]
            : [...LIKELIHOOD_BANDS].reverse().find(entry => probability.compare(new Rational(entry.minimum[0], entry.minimum[1])) >= 0);
        return {
            id: band.id,
            label: band.label,
            range: {
                minimumInclusive: new Rational(band.minimum[0], band.minimum[1]).toJSON(),
                maximum: new Rational(band.maximum[0], band.maximum[1]).toJSON(),
                maximumInclusive: band.maximumInclusive
            }
        };
    }

    function seedOnlyReadinessFailure(response) {
        return response.status !== "exact" && response.diagnostics.length > 0 && response.diagnostics.every(diagnostic => {
            const requirements = diagnostic.details?.requirements;
            return diagnostic.code === "conditional-readiness-unsatisfied"
                && Array.isArray(requirements)
                && requirements.length > 0
                && requirements.every(requirement => requirement.requestPath === "state.random.g4LcrngSeed" && requirement.valueType === "uint32");
        });
    }

    function deterministicG4ForecastSeed(index) {
        if (index === 0) return 0;
        return (Math.imul(index, 0x9E3779B9) + 0xA341316C) >>> 0;
    }

    function forecastCandidateMap(request, profile) {
        const candidates = new Map();
        for (const phaseInput of Object.values(request.phaseInputs || {})) {
            for (const candidate of phaseInput?.candidates || []) {
                if (!candidate?.id) continue;
                candidates.set(candidate.id, {
                    candidateId: candidate.id,
                    action: cloneValue(candidate.action || null),
                    initialScore: Number(candidate.initialScore ?? phaseInput.initialScore ?? profile.numericModel.initialScore)
                });
            }
        }
        return candidates;
    }

    function preSelectionScoreMarginals(options, profile, request) {
        if (Number(profile.generation) !== 4) return null;
        const marginalRequest = cloneValue(request);
        if (marginalRequest.state?.random) {
            delete marginalRequest.state.random.g4LcrngSeed;
            if (Object.keys(marginalRequest.state.random).length === 0) delete marginalRequest.state.random;
        }
        const queries = { ...builtInQueries(profile, marginalRequest), ...(options?.queries || {}) };
        const limits = {
            maxWorlds: Number(options?.limits?.maxWorlds || 100000),
            maxInstructionSteps: Number(options?.limits?.maxInstructionSteps || 10000),
            maxRandomSupport: Number(options?.limits?.maxRandomSupport || 4096)
        };
        const context = {
            profile,
            request: marginalRequest,
            queries,
            limits,
            commands: commandMap(profile),
            programs: programMap(profile),
            randomSources: randomSourceMap(profile),
            allowValidationOnlyPrograms: options?._validationRun === true,
            educationalScoreMarginals: true
        };
        const scoreDistributions = [];
        const scoreAdjustments = new Map();
        for (const rawPhase of profile.actionPipeline) {
            const phase = phaseDescriptor(rawPhase, profile);
            const supplied = marginalRequest.phaseInputs[phase.id];
            if (!supplied || supplied.disposition === "not-applicable" || supplied.disposition === "unavailable") continue;
            if ((supplied.mode || phase.mode) !== "scoring") continue;
            const candidates = (supplied.candidates || []).filter(candidate => candidate && candidate.enabled !== false && candidate.legal !== false);
            for (const candidate of candidates) {
                const input = { id: phase.id, ...supplied, candidates: [candidate] };
                const result = scoringPhase([newWorld(ONE, marginalRequest)], phase, input, context);
                if (!result.unresolvedMass.isZero() || result.diagnostics.length > 0 || result.scoreDistributions.length !== 1) {
                    const detail = result.diagnostics.map(row => row.message).filter(Boolean).join(" ");
                    throw new EvaluationIssue("pre-selection-score-model-unavailable", detail || `Candidate ${candidate.id} did not produce one complete pre-selection score distribution`);
                }
                const distribution = result.scoreDistributions[0];
                const total = distribution.scores.reduce((sum, row) => sum.add(Rational.from(row.probability)), ZERO);
                if (total.compare(ONE) !== 0) throw new EvaluationIssue("pre-selection-score-model-incomplete", `Candidate ${candidate.id} score probabilities do not sum to one`);
                scoreDistributions.push({
                    phaseId: phase.id,
                    candidateId: candidate.id,
                    probabilityBasis: "pre-selection-source-marginals",
                    representativeInputs: "midpoint-for-non-gate-random-values",
                    scores: cloneValue(distribution.scores)
                });
                for (const adjustment of result.scoreAdjustments) {
                    const key = stableStringify(adjustment);
                    if (!scoreAdjustments.has(key)) scoreAdjustments.set(key, cloneValue(adjustment));
                }
            }
        }
        return {
            scoreDistributions,
            scoreAdjustments: [...scoreAdjustments.values()],
            basis: {
                kind: "pre-selection-source-marginals",
                randomGates: "exact-declared-source-fractions",
                nonGateRandomValues: "integer-domain-midpoint-rounded-down",
                hiddenSeedWeightsUsed: false
            }
        };
    }

    function combineForecastEvaluations({ profile, request, evaluations, basis, preSelectionScoring = null }) {
        const evaluationFactor = new Rational(1n, BigInt(evaluations.length));
        const actions = new Map();
        const scores = new Map();
        const scoreAdjustments = new Map();
        const passOutcomes = new Map();
        const candidateDetails = forecastCandidateMap(request, profile);

        for (const evaluation of evaluations) {
            for (const adjustment of preSelectionScoring ? [] : evaluation.scoreAdjustments || []) {
                const key = stableStringify(adjustment);
                if (!scoreAdjustments.has(key)) scoreAdjustments.set(key, cloneValue(adjustment));
            }
            for (const row of evaluation.selectionPassOutcomes || []) {
                const key = stableStringify(row.actions), existing = passOutcomes.get(key);
                passOutcomes.set(key, { actions: cloneValue(row.actions), mass: (existing?.mass || ZERO).add(Rational.from(row.probability).multiply(evaluationFactor)) });
            }
            for (const entry of evaluation.actions) {
                const actionKey = stableStringify(entry.action);
                const mass = Rational.from(entry.probability).multiply(evaluationFactor);
                let record = actions.get(actionKey);
                if (!record) {
                    record = { actionKey, action: cloneValue(entry.action), mass: ZERO, candidateIds: new Set(), reasons: new Map() };
                    actions.set(actionKey, record);
                }
                record.mass = record.mass.add(mass);
                for (const candidateId of entry.candidateIds || []) record.candidateIds.add(candidateId);
                for (const reason of entry.reasons || []) {
                    const reasonEvent = { ...reason };
                    delete reasonEvent.probability;
                    delete reasonEvent.conditionalOnAction;
                    const reasonKey = stableStringify(reasonEvent);
                    const reasonMass = Rational.from(reason.probability || entry.probability).multiply(evaluationFactor);
                    const current = record.reasons.get(reasonKey);
                    record.reasons.set(reasonKey, { event: reasonEvent, mass: (current?.mass || ZERO).add(reasonMass) });
                }
            }
            for (const distribution of preSelectionScoring ? [] : evaluation.scoreDistributions || []) {
                const key = stableStringify({ phaseId: distribution.phaseId, candidateId: distribution.candidateId });
                let record = scores.get(key);
                if (!record) {
                    record = { phaseId: distribution.phaseId, candidateId: distribution.candidateId, values: new Map() };
                    scores.set(key, record);
                }
                for (const outcome of distribution.scores || []) {
                    const score = Number(outcome.score);
                    const mass = Rational.from(outcome.probability).multiply(evaluationFactor);
                    record.values.set(score, (record.values.get(score) || ZERO).add(mass));
                }
            }
        }

        if (preSelectionScoring) {
            for (const adjustment of preSelectionScoring.scoreAdjustments || []) {
                const key = stableStringify(adjustment);
                if (!scoreAdjustments.has(key)) scoreAdjustments.set(key, cloneValue(adjustment));
            }
            for (const distribution of preSelectionScoring.scoreDistributions || []) {
                const key = stableStringify({ phaseId: distribution.phaseId, candidateId: distribution.candidateId });
                const record = { phaseId: distribution.phaseId, candidateId: distribution.candidateId, probabilityBasis: distribution.probabilityBasis, representativeInputs: distribution.representativeInputs, values: new Map() };
                for (const outcome of distribution.scores || []) record.values.set(Number(outcome.score), Rational.from(outcome.probability));
                scores.set(key, record);
            }
        }

        const scoreDistributions = [...scores.values()].map(record => ({
            phaseId: record.phaseId,
            candidateId: record.candidateId,
            candidate: cloneValue(candidateDetails.get(record.candidateId) || null),
            probabilityBasis: record.probabilityBasis || "exact-evaluation",
            ...(record.representativeInputs ? { representativeInputs: record.representativeInputs } : {}),
            scores: [...record.values.entries()].sort((left, right) => right[0] - left[0]).map(([score, weight]) => ({
                score,
                probability: weight.toJSON()
            }))
        }));
        const scoreByCandidate = new Map(scoreDistributions.map(distribution => [distribution.candidateId, distribution]));
        const records = [...actions.values()].sort((left, right) => right.mass.compare(left.mass));
        const outputActions = records.map(record => {
            const equallyLikely = records.filter(other => other.mass.compare(record.mass) === 0);
            const reasons = [...record.reasons.values()].sort((left, right) => right.mass.compare(left.mass)).map(reason => ({
                ...reason.event,
                modeledWeight: reason.mass.toJSON()
            }));
            const incentiveCandidates = [...record.candidateIds].map(candidateId => {
                const detail = candidateDetails.get(candidateId) || { candidateId, initialScore: Number(profile.numericModel.initialScore), action: null };
                return {
                    ...cloneValue(detail),
                    finalScores: cloneValue(scoreByCandidate.get(candidateId)?.scores || []),
                    adjustments: [...scoreAdjustments.values()].filter(reason => reason.candidateId === candidateId).map(reason => ({
                        reasonCode: reason.reasonCode,
                        title: reason.title,
                        summary: reason.summary,
                        delta: reason.delta,
                        previousScore: reason.previousScore,
                        resultingScore: reason.resultingScore,
                        scoringProbability: reason.scoringProbability,
                        probabilityBasis: reason.probabilityBasis
                    }))
                };
            });
            return {
                actionKey: record.actionKey,
                action: record.action,
                modeledWeight: record.mass.toJSON(),
                likelihood: likelihoodBand(record.mass),
                equalLikelihood: {
                    count: equallyLikely.length,
                    actionKeys: equallyLikely.map(other => other.actionKey)
                },
                candidateIds: [...record.candidateIds].sort(),
                reasons,
                incentiveLedger: record.action?.type === "move" && incentiveCandidates.length > 0 ? {
                    model: "initial-score-plus-adjustments",
                    initialScore: Number(profile.numericModel.initialScore),
                    candidates: incentiveCandidates
                } : null
            };
        });
        return {
            schemaVersion: FORECAST_RESPONSE_SCHEMA_VERSION,
            requestId: request.requestId || null,
            profileId: profile.profileId,
            generation: Number(profile.generation),
            engineFamily: profile.engineFamily,
            status: "available",
            ...(passOutcomes.size ? { selectionPassOutcomes: [...passOutcomes.values()].map(row => ({ actions: row.actions, modeledWeight: row.mass.toJSON() })) } : {}),
            basis,
            likelihoodBands: LIKELIHOOD_BANDS.map(entry => ({
                id: entry.id,
                label: entry.label,
                minimumInclusive: new Rational(entry.minimum[0], entry.minimum[1]).toJSON(),
                maximum: new Rational(entry.maximum[0], entry.maximum[1]).toJSON(),
                maximumInclusive: entry.maximumInclusive
            })),
            incentiveModel: {
                appliesTo: ["move-target-selection"],
                initialScore: Number(profile.numericModel.initialScore),
                scoreDistributionBasis: preSelectionScoring?.basis || { kind: "exact-evaluation", hiddenSeedWeightsUsed: false },
                summary: `Each legal move-target candidate starts at ${Number(profile.numericModel.initialScore)}; executable AI commands then add or subtract documented incentive points before selection.`
            },
            actions: outputActions,
            scoreDistributions,
            scoreAdjustments: [...scoreAdjustments.values()],
            diagnostics: []
        };
    }

    function forecastError(profile, request, evaluation, message, basis = { kind: "unavailable" }) {
        return {
            schemaVersion: FORECAST_RESPONSE_SCHEMA_VERSION,
            requestId: request.requestId || null,
            profileId: profile.profileId,
            generation: Number(profile.generation),
            engineFamily: profile.engineFamily,
            status: "error",
            basis,
            likelihoodBands: LIKELIHOOD_BANDS.map(entry => ({ id: entry.id, label: entry.label })),
            incentiveModel: {
                appliesTo: ["move-target-selection"],
                initialScore: Number(profile.numericModel.initialScore),
                summary: `Each legal move-target candidate starts at ${Number(profile.numericModel.initialScore)}; executable AI commands then add or subtract documented incentive points before selection.`
            },
            actions: [],
            scoreDistributions: [],
            error: { code: "forecast-unavailable", message },
            diagnostics: cloneValue(evaluation.diagnostics || [])
        };
    }

    function forecast(options) {
        const profile = validateProfile(options?.profile);
        const request = validateRequest(options?.request);
        validatePrecedingActors(options, profile);
        return forecastValidated(options, profile, request, 0);
    }

    // Unknown internal state is not a random draw. Enumerate source-backed
    // equivalence classes, then retain bounds without assigning them weights.
    function boundedHiddenForecast(options, profile, request, response, depth, budget) {
        const issues = response.diagnostics || [];
        if (!issues.length || issues.some(issue => issue.code !== 'hidden-state-required')) return null;
        const id = issues[0].details.hiddenStateId;
        const model = profile.constants.hiddenStateModels[id];
        if (depth >= 6 || !model || model.values.length > 256) return forecastError(profile, request, response, 'Hidden-state combination limit exceeded');
        const scenarios = [];
        for (const value of model.values) {
            if (--budget.remaining < 0) return forecastError(profile, request, response, 'Hidden-state alternative budget exceeded');
            const nextRequest = cloneValue(request);
            nextRequest.state.hiddenStateValues = { ...(request.state.hiddenStateValues || {}), [id]: value };
            const result = forecastValidated(options, profile, nextRequest, depth + 1, budget);
            if (result.status !== 'available') return result;
            if (result.scenarios) scenarios.push(...result.scenarios);
            else scenarios.push({ values: cloneValue(nextRequest.state.hiddenStateValues), result });
        }
        const records = new Map();
        const scores = new Map();
        for (const scenario of scenarios) {
            for (const row of scenario.result.actions) {
                let target = records.get(row.actionKey);
                if (!target) { target = { ...cloneValue(row), reasons: [], candidateIds: [] }; records.set(row.actionKey, target); }
                target.candidateIds = [...new Set([...target.candidateIds, ...row.candidateIds])];
                for (const reason of row.reasons || []) {
                    const stripped = { ...cloneValue(reason) }; delete stripped.modeledWeight; delete stripped.conditionalOnAction;
                    if (!target.reasons.some(other => stableStringify(other) === stableStringify(stripped))) target.reasons.push(stripped);
                }
            }
            for (const distribution of scenario.result.scoreDistributions || []) {
                let record = scores.get(distribution.candidateId);
                if (!record) { record = { ...cloneValue(distribution), scores: [] }; scores.set(distribution.candidateId, record); }
                for (const row of distribution.scores) if (!record.scores.some(other => other.score === row.score)) record.scores.push({ score: row.score, conditionalOnHiddenState: true });
            }
        }
        const vectors = new Map();
        for (const record of records.values()) {
            const vector = scenarios.map(scenario => Rational.from(scenario.result.actions.find(row => row.actionKey === record.actionKey)?.modeledWeight || ZERO));
            vectors.set(record.actionKey, vector);
            const minimum = vector.reduce((a, b) => a.compare(b) < 0 ? a : b), maximum = vector.reduce((a, b) => a.compare(b) > 0 ? a : b);
            delete record.modeledWeight;
            // The individual conditional ledgers remain in scenarios; no hidden
            // state prior is invented for a combined incentive ledger.
            record.incentiveLedger = null;
            record.modeledWeightRange = { minimum: minimum.toJSON(), maximum: maximum.toJSON() };
            const low = likelihoodBand(minimum), high = likelihoodBand(maximum);
            record.likelihood = minimum.compare(maximum) === 0 ? low : { id: 'bounded', label: low.label === high.label ? low.label : `${low.label}–${high.label}`, minimum: low, maximum: high };
        }
        for (const record of records.values()) {
            const vector = vectors.get(record.actionKey);
            const equal = [...vectors].filter(([, other]) => vector.every((value, index) => value.compare(other[index]) === 0)).map(([key]) => key);
            record.equalLikelihood = { count: equal.length, actionKeys: equal };
        }
        return {
            ...scenarios[0].result,
            basis: { kind: 'bounded-hidden-state', exact: false, hiddenStateId: id, scenarioCount: scenarios.length,
                hiddenRngModeled: scenarios.some(row => row.result.basis.hiddenRngModeled), summary: `${model.summary} These alternatives have no assumed probability distribution; the displayed range covers every modeled alternative.` },
            actions: [...records.values()].sort((a, b) => b.modeledWeightRange.maximum.decimal - a.modeledWeightRange.maximum.decimal),
            // Joint outcomes remain conditional in scenarios, never borrow one
            // hidden-state alternative's weights for the combined forecast.
            selectionPassOutcomes: null,
            scoreDistributions: [...scores.values()], scenarios, diagnostics: []
        };
    }

    function forecastValidated(options, profile, request, depth, budget = { remaining: 1024 }) {
        const initial = evaluateActorPass(options, profile, request);
        if (initial.status === "exact") {
            let preSelectionScoring = null;
            if (Number(profile.generation) === 4 && (initial.scoreDistributions || []).length > 0) {
                try {
                    preSelectionScoring = preSelectionScoreMarginals(options, profile, request);
                } catch (error) {
                    const issue = error instanceof EvaluationIssue ? error : new EvaluationIssue("pre-selection-score-model-unavailable", error.message || String(error));
                    return forecastError(profile, request, { diagnostics: aggregateDiagnostics([diagnosticRecord(issue, { phaseId: null, programId: null, candidate: null }, null, ONE)]) }, issue.message, {
                        kind: "exact-evaluation",
                        sampleSize: 1,
                        hiddenRngModeled: false
                    });
                }
            }
            return combineForecastEvaluations({
                profile,
                request,
                evaluations: [initial],
                basis: { kind: "exact-evaluation", sampleSize: 1, hiddenRngModeled: false },
                preSelectionScoring
            });
        }
        if (Number(profile.generation) !== 4 || !seedOnlyReadinessFailure(initial)) {
            const bounded = boundedHiddenForecast(options, profile, request, initial, depth, budget);
            if (bounded) return bounded;
            const detail = initial.diagnostics.map(diagnostic => diagnostic.message).filter(Boolean).join(" ");
            return forecastError(profile, request, initial, detail || "The evaluator could not resolve this action from the supplied battle state.");
        }
        const sampleSize = Number(options?.forecast?.g4SeedSampleSize ?? DEFAULT_G4_FORECAST_SAMPLE_SIZE);
        if (!Number.isInteger(sampleSize) || sampleSize < 16 || sampleSize > 4096) {
            throw new EvaluationIssue("invalid-forecast-sample-size", "Gen 4 forecast sample size must be an integer from 16 through 4096");
        }
        const evaluations = [];
        for (let index = 0; index < sampleSize; index += 1) {
            const seededRequest = cloneValue(request);
            seededRequest.state.random = { ...(seededRequest.state.random || {}), g4LcrngSeed: deterministicG4ForecastSeed(index) };
            const evaluation = evaluateActorPass(options, profile, seededRequest);
            if (evaluation.status !== "exact") {
                const bounded = boundedHiddenForecast(options, profile, request, evaluation, depth, budget);
                if (bounded) return bounded;
                const detail = evaluation.diagnostics.map(diagnostic => diagnostic.message).filter(Boolean).join(" ");
                return forecastError(profile, request, evaluation, detail || "A sampled hidden-RNG path reached unavailable semantics.", {
                    kind: "deterministic-g4-seed-ensemble",
                    sampleSize,
                    failedSampleIndex: index,
                    hiddenRngModeled: true
                });
            }
            evaluations.push(evaluation);
        }
        let preSelectionScoring = null;
        if (evaluations.some(evaluation => (evaluation.scoreDistributions || []).length > 0)) {
            try {
                preSelectionScoring = preSelectionScoreMarginals(options, profile, request);
            } catch (error) {
                const issue = error instanceof EvaluationIssue ? error : new EvaluationIssue("pre-selection-score-model-unavailable", error.message || String(error));
                return forecastError(profile, request, { diagnostics: aggregateDiagnostics([diagnosticRecord(issue, { phaseId: null, programId: null, candidate: null }, null, ONE)]) }, issue.message, {
                    kind: "deterministic-g4-seed-ensemble",
                    sampleSize,
                    hiddenRngModeled: true
                });
            }
        }
        return combineForecastEvaluations({
            profile,
            request,
            evaluations,
            preSelectionScoring,
            basis: {
                kind: "deterministic-g4-seed-ensemble",
                sampleSize,
                seedSequence: "uint32-weyl-0x9E3779B9-offset-0xA341316C",
                hiddenRngModeled: true,
                summary: "Qualitative guidance from a deterministic spread of exact stateful Gen 4 RNG executions; this is not an exact probability claim or an observed emulator seed."
            }
        });
    }

    function runValidationCases(options) {
        const profile = validateProfile(options?.profile);
        const selectedIds = options?.caseIds ? new Set(options.caseIds) : null;
        const cases = profile.validationCases.filter(validationCase => validationCase.executable !== false && (!selectedIds || selectedIds.has(validationCase.id)));
        const results = cases.map(validationCase => {
            const request = validationCase.request || validationCase.input;
            if (!validationCase.id || !request || !validationCase.expected) {
                return { id: validationCase.id || null, passed: false, error: "Validation case is missing id, evaluation request, or expected response" };
            }
            try {
                const response = evaluate({
                    profile,
                    request,
                    queries: options?.queriesByCase?.[validationCase.id] || {},
                    limits: options?.limits,
                    _validationRun: true
                });
                const passed = expectedSubset(response, validationCase.expected);
                return { id: validationCase.id, passed, ...(passed ? {} : { expected: validationCase.expected, actual: response }) };
            } catch (error) {
                return { id: validationCase.id, passed: false, error: error.message || String(error) };
            }
        });
        return {
            profileId: profile.profileId,
            passed: results.every(result => result.passed),
            total: results.length,
            passedCount: results.filter(result => result.passed).length,
            failedCount: results.filter(result => !result.passed).length,
            results
        };
    }

    return Object.freeze({
        PROFILE_SCHEMA_VERSION,
        REQUEST_SCHEMA_VERSION,
        RESPONSE_SCHEMA_VERSION,
        FORECAST_RESPONSE_SCHEMA_VERSION,
        LIKELIHOOD_BANDS,
        Rational,
        EvaluationIssue,
        validateProfile,
        validateRequest,
        evaluate,
        evaluateQueryProgram,
        forecast,
        likelihoodBand,
        runValidationCases
    });
});
