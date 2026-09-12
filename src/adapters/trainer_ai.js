import { activeSlotEntries } from "../core/battle_slots.js?v=20260905-drafts-freecalc-partners-v1";
import { upgradeInitialEntryEffects } from "../core/plan.js?v=20260911-ability-storage-reimp-v1";
import { belongsToSlotParty } from '../core/party_ownership.js?v=20260905-drafts-freecalc-partners-v1';
import { rotationFrontSlot } from "../rulesets/rotation_battle.js?v=20260905-drafts-freecalc-partners-v1";
import { areSlotsAdjacent, triplePositionForSlot } from "../rulesets/triple_battle.js?v=20260905-drafts-freecalc-partners-v1";
import { trappingAbilityBlocksSwitch } from "../rulesets/ability_rules.js?v=20260905-drafts-freecalc-partners-v1";
import { effectiveActionSpeed } from "../rulesets/action_order.js?v=20260905-drafts-freecalc-partners-v1";

export class TrainerAiReadinessError extends Error {
  constructor(message) {
    super(message);
    this.name = "TrainerAiReadinessError";
  }
}

function requireProfile(document, { expectedGameId = null, kind, profileId = null }) {
  if (!document || !Number.isInteger(Number(document.schemaVersion)) || document.kind !== kind
    || expectedGameId && document.gameId !== expectedGameId
    || profileId && document.profileId !== profileId) {
    throw new TrainerAiReadinessError(`${kind} does not match its generated profile contract`);
  }
  return document;
}

export async function loadTrainerAiDocumentation({ baseUrl, gameId = "volt-white-2r", generation = null, fetchImpl = fetch }) {
  const root = String(baseUrl || "").replace(/\/$/, "");
  const read = async path => {
    const response = await fetchImpl(`${root}/${path}`, { cache: "no-store" });
    if (!response.ok) throw new TrainerAiReadinessError(`${path} returned HTTP ${response.status}`);
    return response.json();
  };
  const binding = await read(`${gameId}/trainer_ai.json`);
  requireProfile(binding, { expectedGameId: gameId, kind: "trainer-ai" });
  const inheritedSourceGeneration = String(binding.inheritance?.sourceGameId || "").match(/^generation-(\d+)$/)?.[1];
  const bindingGeneration = Number(binding.inheritance?.generation ?? inheritedSourceGeneration);
  if (!Number.isInteger(bindingGeneration)) {
    throw new TrainerAiReadinessError(`${gameId} Trainer AI binding does not declare its inherited generation`);
  }
  if (generation !== null && Number(generation) !== bindingGeneration) {
    throw new TrainerAiReadinessError(`${gameId} Trainer AI binding declares Generation ${bindingGeneration}, not Generation ${generation}`);
  }
  const generationKey = `gen${bindingGeneration}`;
  const [shared, semantics] = await Promise.all([
    read(`${generationKey}/trainer_ai.json`),
    bindingGeneration === 5 ? read(`${generationKey}/trainer_ai_engine_semantics.json`) : Promise.resolve(null)
  ]);
  requireProfile(shared, { expectedGameId: `generation-${bindingGeneration}`, kind: "trainer-ai" });
  const inheritedProfileId = binding.inheritance?.profileId || binding.inheritance?.baseProfile;
  const profile = Array.isArray(shared.profiles)
    ? shared.profiles.find(entry => entry.profileId === inheritedProfileId)
    : shared;
  if (!profile || profile.profileId !== inheritedProfileId) {
    throw new TrainerAiReadinessError(`${gameId} Trainer AI binding does not match the generated Generation ${bindingGeneration} profile`);
  }
  if (semantics) requireProfile(semantics, { kind: "trainer-ai-engine-semantics", profileId: profile.profileId });
  return { binding, shared, profile, semantics, evaluatorProfile: profile.evaluator || null, generation: bindingGeneration };
}

export function formatTrainerAiProbability(value) {
  return `${(Number(value) * 100).toFixed(2).replace(/\.00$/, "")}%`;
}

const LIKELIHOOD_THRESHOLDS = Object.freeze([
  [1, "guaranteed", "Guaranteed"],
  [0.75, "very-likely", "Very Likely"],
  [0.5, "likely", "Likely"],
  [0.25, "possible", "Possible"],
  [0.1, "unlikely", "Unlikely"],
  [0, "very-unlikely", "Very Unlikely"]
]);

export function trainerAiLikelihood(value, evaluator = null) {
  const engine = evaluator || globalThis.TrainerAiEvaluator;
  if (engine?.likelihoodBand) return engine.likelihoodBand(Number(value));
  const probability = Math.max(0, Math.min(1, Number(value) || 0));
  const [, id, label] = LIKELIHOOD_THRESHOLDS.find(([minimum]) => probability >= minimum);
  return { id, label };
}

function forecastWeight(entry) {
  if (entry?.modeledWeightRange) return null;
  return Number(entry?.modeledWeight?.decimal ?? entry?.probability?.decimal ?? 0);
}

function forecastGroupRange(result, matches) {
  if (!result?.scenarios) return null;
  const values = result.scenarios.map(scenario => scenario.result.actions.filter(matches).reduce((sum, action) => sum + forecastWeight(action), 0));
  return { minimum: Math.min(...values), maximum: Math.max(...values), scenarioWeights: values };
}

function rangeLikelihood(range, engine) {
  if (!range) return null;
  const low = trainerAiLikelihood(range.minimum, engine), high = trainerAiLikelihood(range.maximum, engine);
  return range.minimum === range.maximum ? low : { id: 'bounded', label: low.label === high.label ? low.label : `${low.label}–${high.label}`, minimum: low, maximum: high };
}

function stableForecastValue(value) {
  if (Array.isArray(value)) return value.map(stableForecastValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableForecastValue(value[key])]));
  }
  return value;
}

function stableForecastKey(value) {
  return JSON.stringify(stableForecastValue(value));
}

function memoizeDeterministicQueries(queries) {
  return Object.fromEntries(Object.entries(queries).map(([id, query]) => {
    const cache = new Map();
    return [id, (...parameters) => {
      const metadata = parameters.at(-1);
      const key = stableForecastKey({
        values: parameters.slice(0, -1),
        candidateId: metadata?.context?.candidate?.id || null,
        locals: metadata?.locals || {},
        arguments: metadata?.arguments || {},
        programId: metadata?.program?.id || null,
        instructionPc: metadata?.instruction?.pc ?? null
      });
      if (cache.has(key)) return cache.get(key);
      const value = query(...parameters);
      cache.set(key, value);
      return value;
    }];
  }));
}

function mergeExactForecastBranches(engine, profile, requestId, branches) {
  const Rational = engine?.Rational;
  if (!Rational || !branches.length) return null;
  const failed = branches.find(branch => branch.result?.status !== "available");
  if (failed) return failed.result;
  const zero = new Rational(0n);
  const actions = new Map();
  const scores = new Map();
  const scoreAdjustments = new Map();
  let scoreConflict = null;
  for (const branch of branches) {
    const branchWeight = Rational.from(branch.weight);
    for (const adjustment of branch.result.scoreAdjustments || []) {
      const key = stableForecastKey(adjustment);
      if (!scoreAdjustments.has(key)) scoreAdjustments.set(key, structuredClone(adjustment));
    }
    for (const entry of branch.result.actions || []) {
      const actionKey = stableForecastKey(entry.action);
      const mass = branchWeight.multiply(Rational.from(entry.modeledWeight || entry.probability));
      let record = actions.get(actionKey);
      if (!record) {
        record = { actionKey, action: entry.action, mass: zero, candidateIds: new Set(), reasons: new Map() };
        actions.set(actionKey, record);
      }
      record.mass = record.mass.add(mass);
      for (const candidateId of entry.candidateIds || []) record.candidateIds.add(candidateId);
      for (const reason of entry.reasons || []) {
        const event = { ...reason };
        delete event.modeledWeight;
        delete event.probability;
        delete event.conditionalOnAction;
        const reasonKey = stableForecastKey(event);
        const reasonWeight = Rational.from(reason.modeledWeight || reason.probability || entry.modeledWeight || entry.probability);
        const existing = record.reasons.get(reasonKey);
        record.reasons.set(reasonKey, { event, mass: (existing?.mass || zero).add(branchWeight.multiply(reasonWeight)) });
      }
    }
    for (const distribution of branch.result.scoreDistributions || []) {
      const key = `${distribution.phaseId || ""}:${distribution.candidateId}`;
      const normalized = {
        ...structuredClone(distribution),
        scores: (distribution.scores || []).map(outcome => ({ score: Number(outcome.score), probability: outcome.probability }))
      };
      const signature = stableForecastKey(normalized);
      const existing = scores.get(key);
      if (!existing) scores.set(key, { distribution: normalized, signature });
      else if (existing.signature !== signature) {
        scoreConflict = `Pre-selection score outcomes for ${distribution.candidateId} changed across actor-pass worlds; hidden action-world weights cannot be used as incentive probabilities.`;
      }
    }
  }
  if (scoreConflict) return {
    schemaVersion: engine.FORECAST_RESPONSE_SCHEMA_VERSION || "trainer-ai-forecast-response/v1alpha1",
    requestId,
    profileId: profile.profileId,
    generation: Number(profile.generation),
    engineFamily: profile.engineFamily,
    status: "error",
    basis: { kind: "unavailable" },
    likelihoodBands: engine.LIKELIHOOD_BANDS || [],
    incentiveModel: branches[0].result.incentiveModel,
    actions: [],
    scoreDistributions: [],
    error: { code: "pre-selection-score-world-conflict", message: scoreConflict },
    diagnostics: [{ code: "pre-selection-score-world-conflict", message: scoreConflict }]
  };
  const allActionRecords = [...actions.values()];
  const actionRecords = allActionRecords.sort((left, right) => right.mass.compare(left.mass)).map(record => {
    const equallyLikely = allActionRecords.filter(other => other.mass.compare(record.mass) === 0);
    return {
      actionKey: record.actionKey,
      action: record.action,
      modeledWeight: record.mass.toJSON(),
      likelihood: engine.likelihoodBand(record.mass),
      equalLikelihood: { count: equallyLikely.length, actionKeys: equallyLikely.map(other => other.actionKey) },
      candidateIds: [...record.candidateIds].sort(),
      reasons: [...record.reasons.values()].sort((left, right) => right.mass.compare(left.mass)).map(reason => ({
        ...reason.event,
        modeledWeight: reason.mass.toJSON()
      })),
      incentiveLedger: null
    };
  });
  return {
    schemaVersion: engine.FORECAST_RESPONSE_SCHEMA_VERSION || "trainer-ai-forecast-response/v1alpha1",
    requestId,
    profileId: profile.profileId,
    generation: Number(profile.generation),
    engineFamily: profile.engineFamily,
    status: "available",
    basis: {
      kind: "exact-gen5-actor-selection-pass",
      exact: true,
      activePokemonOrder: "right-to-left",
      switchReservationsModeled: true,
      trainerItemConsumptionModeled: true
    },
    likelihoodBands: engine.LIKELIHOOD_BANDS || [],
    incentiveModel: branches[0].result.incentiveModel,
    actions: actionRecords,
    scoreAdjustments: [...scoreAdjustments.values()],
    scoreDistributions: [...scores.values()].map(record => record.distribution),
    diagnostics: []
  };
}

function exactEvaluationAsForecast(engine, options) {
  if (engine?.forecast) return engine.forecast(options);
  const result = engine?.evaluate?.(options);
  if (!result) return null;
  if (result.status !== "exact") {
    return {
      status: "error",
      basis: { kind: "unavailable" },
      actions: [],
      scoreDistributions: [],
      error: { code: "forecast-unavailable", message: result.diagnostics?.map(entry => entry.message).filter(Boolean).join(" ") || "Trainer AI evaluation did not resolve." },
      diagnostics: result.diagnostics || []
    };
  }
  return {
    status: "available",
    basis: { kind: "exact-evaluation", sampleSize: 1, hiddenRngModeled: false },
    actions: result.actions.map(entry => ({
      ...entry,
      modeledWeight: entry.probability,
      likelihood: trainerAiLikelihood(entry.probability.decimal, engine),
      equalLikelihood: { count: 1, actionKeys: [] },
      incentiveLedger: entry.action?.type === "move" ? { initialScore: Number(options.profile.numericModel?.initialScore ?? 100), candidates: [] } : null
    })),
    scoreDistributions: result.scoreDistributions || [],
    incentiveModel: { initialScore: Number(options.profile.numericModel?.initialScore ?? 100) },
    diagnostics: []
  };
}

function usableMoves(plan, state, combatantKey) {
  const combatant = plan.combatants[combatantKey];
  const combatantState = state.combatantStates[combatantKey];
  const choiceLock = ["choiceband", "choicespecs", "choicescarf"].includes(effectiveAiItem(combatantState, state))
    ? combatantState.volatileConditions?.choiceLockedMoveId : null;
  return (combatantState.moveSetOverride || combatant.moves || []).filter(move =>
    Number(combatantState.movePp?.[move.moveId] ?? move.maxPp) > 0 && (!choiceLock || move.moveId === choiceLock));
}

function effectiveAiItem(mon, state) {
  if (mon?.itemState && mon.itemState !== "held" || mon?.volatileConditions?.embargoTurns > 0
    || state.fieldState?.global?.magicRoomTurns > 0 || !mon?.abilitySuppressed && toId(mon?.currentAbilityId) === "klutz") return "";
  return toId(mon?.currentItemId);
}

// Same live-state legality used by the turn resolver, not an ability-name guess.
function aiSwitchBlocked(plan, state, actorEntry) {
  const mon = state.combatantStates[actorEntry.combatantKey];
  if (effectiveAiItem(mon, state) === "shedshell") return false;
  const volatile = mon?.volatileConditions || {};
  if (volatile.trapped || volatile.noSwitch || volatile.trappedBy || volatile.ingrain || volatile.partiallytrapped) return true;
  return activeSlotEntries(state, "player").some(entry => {
    if (plan.game.battleFormat === "rotation" && entry.slot !== rotationFrontSlot(state, "player")) return false;
    const source = state.combatantStates[entry.combatantKey];
    return Number(source?.hp?.max ?? 0) > 0 && Boolean(trappingAbilityBlocksSwitch({
      sourceState: source, targetState: { ...mon, currentItemId: effectiveAiItem(mon, state) }, fieldState: state.fieldState
    }));
  });
}

function combatantName(combatant) {
  return combatant?.nickname || combatant?.displayName || combatant?.speciesId || "Pokémon";
}

function trainerProfile(plan, dataset, entry = null) {
  const ownerId = plan.combatants[entry?.combatantKey]?.source?.partyOwnerId;
  const trainer = dataset.trainer(ownerId || plan.game.trainerId);
  const profileId = dataset.mechanics?.trainerBattleProfile;
  return { trainer, battleProfile: profileId ? trainer?.battleProfiles?.[profileId] : null };
}

function actorParty(plan, entry, side = 'enemy') {
  const key = entry?.combatantKey;
  const owner = plan.combatants[key]?.source?.partyOwnerId;
  return Object.values(plan.combatants).filter(mon => mon.side === side
    && (owner ? mon.source?.partyOwnerId === owner : belongsToSlotParty(plan, mon, side, entry?.slot ?? 0)));
}

function activeEnemyEntries(plan, state) {
  const living = activeSlotEntries(state, "enemy").filter(entry => {
    const hp = state.combatantStates[entry.combatantKey]?.hp;
    return Number(hp?.current ?? hp?.max ?? hp?.min ?? 0) > 0;
  });
  if (plan.game.battleFormat === "rotation") return living;
  return living;
}

function scriptSummary(ai, flagIds) {
  const byId = new Map((ai.profile.scripts || []).map(script => [script.id, script]));
  return flagIds.map(id => byId.get(id)).filter(Boolean).map(script => ({
    id: script.id,
    name: script.name || script.id,
    summary: script.summary || "Applies its documented score adjustments."
  }));
}

function evaluatorFlagIds(flagIds) {
  const normalized = new Set(flagIds.map(String));
  for (const flagId of flagIds) {
    const match = String(flagId).match(/^flag(\d+)$/i);
    if (match) normalized.add(String(Number(match[1])));
  }
  return [...normalized];
}

function knownHp(combatantState) {
  const minimum = Number(combatantState?.hp?.min ?? combatantState?.hp?.current);
  const maximum = Number(combatantState?.hp?.max ?? combatantState?.hp?.current);
  return Number.isFinite(minimum) && minimum === maximum ? minimum : null;
}

function normalizedActor(plan, state, entry) {
  const combatant = plan.combatants[entry.combatantKey];
  const combatantState = state.combatantStates[entry.combatantKey];
  return {
    id: entry.combatantKey,
    position: entry.slot,
    partyIndex: Number(combatant?.source?.trainerSlot ?? combatant?.source?.slot ?? entry.slot + 1) - 1,
    hp: knownHp(combatantState),
    maximumHp: Number(combatantState?.hp?.maxHp ?? combatantState?.hp?.max ?? 0),
    status: combatantState?.majorStatus || "none",
    stages: { ...(combatantState?.statStages || {}) },
    volatiles: { ...(combatantState?.volatileConditions || {}) },
    currentTypes: [...(combatantState?.currentTypeIds || combatant?.originalTypeIds || [])],
    ability: combatantState?.currentAbilityId || combatant?.originalAbilityId || null,
    item: combatantState?.currentItemId || null,
    forcedContinuation: combatantState?.volatileConditions?.rechargeRequired
      ? { action: { type: "recharge", actorId: entry.combatantKey, forced: true } }
      : null,
    fainted: Number(combatantState?.hp?.max ?? 0) <= 0,
    pivoting: false
  };
}

function toId(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function moveDamageClassification(move) {
  const category = toId(move?.category);
  if (category === "physical" || category === "special") return "damaging";
  if (category === "status") return "status";
  return "unknown";
}

function isDamagingMove(move) {
  return moveDamageClassification(move) === "damaging";
}

function hasDamagingMove(moves) {
  const classifications = moves.map(moveDamageClassification);
  return classifications.includes("unknown") ? undefined : classifications.includes("damaging");
}

function gen4BattlerId(side, slot) {
  return side === "player" ? Number(slot) * 2 : Number(slot) * 2 + 1;
}

function gen4EntryByBattlerId(state, battlerId) {
  const numeric = Number(battlerId);
  const side = numeric % 2 === 0 ? "player" : "enemy";
  const slot = Math.floor(numeric / 2);
  return activeSlotEntries(state, side).find(entry => entry.slot === slot) || null;
}

function candidateContext(metadata) {
  return metadata?.context?.candidate || null;
}

function candidateMove(metadata, dataset) {
  const action = candidateContext(metadata)?.action || {};
  const canonicalId = action.canonicalMoveId || dataset.getBySaveNumericId("moves", action.moveId)?.id;
  const descriptor = canonicalId ? dataset.get("moves", canonicalId) : null;
  return descriptor ? { id: descriptor.id || canonicalId, ...descriptor } : null;
}

function candidateTargetEntry(state, metadata) {
  const action = candidateContext(metadata)?.action || {};
  if (action.targetCombatantKey) {
    return [...activeSlotEntries(state, "player"), ...activeSlotEntries(state, "enemy")]
      .find(entry => entry.combatantKey === action.targetCombatantKey) || null;
  }
  return Number.isInteger(Number(action.target)) ? gen4EntryByBattlerId(state, Number(action.target)) : null;
}

function actorPartnerEntry(state, actorEntry) {
  return activeSlotEntries(state, "enemy").find(entry => entry.combatantKey !== actorEntry.combatantKey) || null;
}

function targetPartnerEntry(state, targetEntry) {
  if (!targetEntry) return null;
  return activeSlotEntries(state, "player").find(entry => entry.combatantKey !== targetEntry.combatantKey) || null;
}

function selectedBattlerEntry(state, actorEntry, metadata, selector) {
  const targetEntry = candidateTargetEntry(state, metadata);
  switch (Number(selector)) {
  case 0: return targetEntry;
  case 1: return actorEntry;
  case 2: return actorPartnerEntry(state, actorEntry);
  case 3: return targetPartnerEntry(state, targetEntry);
  default: return gen4EntryByBattlerId(state, selector);
  }
}

function numericRecordId(dataset, kind, canonicalId) {
  if (!canonicalId) return 0;
  const record = dataset.get(kind, canonicalId);
  const value = Number(record?.trainerAi?.numericId ?? record?.romId ?? record?.num);
  return Number.isInteger(value) ? value : undefined;
}

function numericTypeId(typeId, profile) {
  const id = toId(typeId);
  if (id === "fairy" && profile.constants?.gameOverrides?.numericTypeTokens?.["9"] === "RP_TYPE_FAIRY") return 9;
  const token = `TYPE_${String(typeId || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const value = Number(profile.constants?.numericByToken?.[token]);
  return Number.isInteger(value) ? value : undefined;
}

function combatantTypes(plan, state, entry) {
  if (!entry) return [];
  const combatant = plan.combatants[entry.combatantKey];
  const combatantState = state.combatantStates[entry.combatantKey];
  return [...(combatantState?.currentTypeIds || combatant?.originalTypeIds || [])];
}

function typeEffectivenessCode(plan, state, dataset, metadata) {
  const move = candidateMove(metadata, dataset);
  const targetEntry = candidateTargetEntry(state, metadata);
  if (!move || !targetEntry) return undefined;
  let multiplier = 1;
  for (const targetType of combatantTypes(plan, state, targetEntry)) {
    const record = dataset.get("types", targetType);
    if (!record) return undefined;
    const attackType = toId(move.type);
    if ((record.immune || []).some(type => toId(type) === attackType)) return 0;
    if ((record.weak || []).some(type => toId(type) === attackType)) multiplier *= 2;
    if ((record.resist || []).some(type => toId(type) === attackType)) multiplier /= 2;
  }
  return new Map([[0.25, 10], [0.5, 20], [1, 40], [2, 80], [4, 160]]).get(multiplier);
}

function majorStatusMask(combatantState) {
  const status = toId(combatantState?.majorStatus);
  if (status === "slp" || status === "sleep") return 0x7;
  if (status === "psn" || status === "poison") return 1 << 3;
  if (status === "brn" || status === "burn") return 1 << 4;
  if (status === "frz" || status === "freeze") return 1 << 5;
  if (status === "par" || status === "paralysis") return 1 << 6;
  if (status === "tox" || status === "toxic") return (1 << 7) | (Math.max(0, Number(combatantState?.toxicCounter || 0)) << 8);
  return 0;
}

function volatileStatusMask(combatantState, metadata) {
  const volatile = combatantState?.volatileConditions || {};
  if (Number.isInteger(combatantState?.trainerAiVolatileStatusMask)) return combatantState.trainerAiVolatileStatusMask;
  let mask = 0;
  const fields = {
    CONFUSION: ['confusion', 'confusionTurns', 'confusionCounterDistribution'], UPROAR: ['uproarTurns'], BIDE: ['bideTurns'], THRASH: ['thrashTurns', 'thrashMoveId'],
    MOVE_LOCKED: ['chargingMoveId', 'moveLockedInto'], BIND: ['partiallyTrappedTurns'], ATTRACT: ['attract', 'attractSourceKey'],
    FOCUS_ENERGY: ['focusEnergy', 'focusenergy'], TRANSFORM: ['transformed'], RECHARGING: ['rechargeRequired'], RAGE: ['rage'],
    SUBSTITUTE: ['substitute', 'substituteHp'], DESTINY_BOND: ['destinybond'], MEAN_LOOK: ['trappedBy', 'meanlook', 'blocked'],
    NIGHTMARE: ['nightmare'], CURSE: ['curse', 'curseSourceKey'], FORESIGHT: ['foresight'], DEFENSE_CURL: ['defenseCurl', 'defensecurl'], TORMENT: ['torment']
  };
  for (const [token, keys] of Object.entries(fields)) if (keys.some(key => Array.isArray(volatile[key]) ? volatile[key].length > 0 : Boolean(volatile[key]))) mask |= metadata.profile.constants.numericByToken[`VOLATILE_CONDITION_${token}`];
  return mask;
}

function hpPercent(combatantState) {
  const current = knownHp(combatantState);
  const maximum = Number(combatantState?.hp?.maxHp ?? combatantState?.hp?.max);
  return current === null || !Number.isFinite(maximum) || maximum <= 0 ? undefined : Math.floor(current * 100 / maximum);
}

function statStage(combatantState, statId) {
  const key = ["hp", "atk", "def", "spe", "spa", "spd", "accuracy", "evasion"][Number(statId)];
  if (!key) return undefined;
  return 6 + Number(combatantState?.statStages?.[key] || 0);
}

function weatherCode(state) {
  const value = state.fieldState?.global?.weather;
  const weather = toId(value && typeof value === 'object' ? value.id : value);
  return ({ "": 0, none: 0, sun: 1, sunnyday: 1, harshsunlight: 1, rain: 2, raindance: 2, sand: 3, sandstorm: 3, hail: 4, fog: 5 })[weather];
}

function tableContains(profile, tableId, value) {
  const table = profile.constants?.dataLists?.[tableId];
  if (!Array.isArray(table)) return undefined;
  return table.some(entry => Number(entry?.numericId ?? entry?.value ?? entry) === Number(value));
}

function damageMaximum({ plan, state, dataset, actorEntry, targetEntry, move, damageAdapter, damageRoll = "maximum" }) {
  if (!damageAdapter || !actorEntry || !targetEntry || !move) return undefined;
  const targetMode = String(move.target || "normal").toLowerCase();
  const spreadTargetCount = ["alladjacent", "alladjacentfoes", "allopponents"].includes(targetMode)
    ? activeSlotEntries(state, "player").filter(entry => Number(state.combatantStates[entry.combatantKey]?.hp?.max ?? 0) > 0).length
      + (targetMode === "alladjacent" ? activeSlotEntries(state, "enemy").filter(entry => entry.combatantKey !== actorEntry.combatantKey && Number(state.combatantStates[entry.combatantKey]?.hp?.max ?? 0) > 0).length : 0)
    : 1;
  const result = damageAdapter.calculate({
    attacker: plan.combatants[actorEntry.combatantKey],
    defender: plan.combatants[targetEntry.combatantKey],
    attackerState: state.combatantStates[actorEntry.combatantKey],
    defenderState: state.combatantStates[targetEntry.combatantKey],
    move,
    fieldState: state.fieldState,
    criticalHit: false,
    battleFormat: plan.game.battleFormat,
    spreadTargetCount
  });
  if (result?.status === "status" || result?.status === "no-damage") return null;
  const values = (result?.damage || []).map(Number).filter(Number.isFinite);
  return result?.status === "ok" && values.length ? (damageRoll === "minimum" ? Math.min(...values) : Math.max(...values)) : undefined;
}

export function createPlatinumQueryProvider({ plan, state, dataset, actorEntry, moves, damageAdapter, alreadySelected = [] }) {
  const eligibleDamage = (move, metadata) => metadata.profile.constants.damageScoringEffects.sAltPowerMoveEffects.includes(move?.trainerAi?.effectId)
    || Number(move?.trainerAi?.basePower) > 1 && !metadata.profile.constants.damageScoringEffects.sNoDamageCalcMoveEffects.includes(move?.trainerAi?.effectId);
  const variance = (metadata, slot, vary) => {
    if (!vary) return 100;
    const roll = metadata.scoringPass?.moveDamageRolls?.[slot];
    if (!Number.isInteger(roll)) throw new Error(`Missing target-local source damage roll for move slot ${slot}`);
    return roll;
  };
  const sourceDamage = (metadata, move, attacker = actorEntry, parameterEntry = attacker, roll = 100, ivs = null) => platinumScoringDamage({ plan, state, dataset, actorEntry: attacker, targetEntry: candidateTargetEntry(state, metadata), parameterEntry, move, metadata, variance: roll, ivs });
  const allDamage = (metadata, vary, attacker = actorEntry, parameterEntry = attacker) => platinumMoves(plan, state, dataset, parameterEntry.combatantKey).map((move, slot) => eligibleDamage(move, metadata) ? sourceDamage(metadata, move, attacker, parameterEntry, variance(metadata, slot, vary)) : 0);
  const moveSlot = metadata => candidateContext(metadata)?.action?.moveSlot ?? platinumMoves(plan, state, dataset, actorEntry.combatantKey).findIndex(move => move.id === candidateMove(metadata, dataset)?.id);
  const damageFor = (metadata, vary) => {
    const move = candidateMove(metadata, dataset);
    return eligibleDamage(move, metadata) ? sourceDamage(metadata, move, actorEntry, actorEntry, variance(metadata, moveSlot(metadata), vary)) : null;
  };
  const damageRank = (vary, metadata) => {
    if (!eligibleDamage(candidateMove(metadata, dataset), metadata)) return 0;
    const vector = allDamage(metadata, vary);
    return vector.some(value => value > vector[moveSlot(metadata)]) ? 1 : 2;
  };
  const battlerState = (selector, metadata) => {
    const entry = selectedBattlerEntry(state, actorEntry, metadata, selector);
    return entry ? state.combatantStates[entry.combatantKey] : null;
  };
  // Despite the command name, retail checks the unavailable-slot mask, not HP.
  // That mask is set only when a defeated slot cannot be filled, and cleared
  // when its replacement enters (battle_controller_player.c / battle_script.c).
  const battlerUnavailable = (selector, metadata) => {
    const entry = selectedBattlerEntry(state, actorEntry, metadata, selector);
    if (!entry) return true;
    const explicitMask = state.trainerAiBattlersUnavailableMask;
    if (Number.isInteger(explicitMask)) return Boolean(explicitMask & (1 << gen4BattlerId(plan.combatants[entry.combatantKey].side, entry.slot)));
    if (knownHp(state.combatantStates[entry.combatantKey]) > 0) return false;
    const side = plan.combatants[entry.combatantKey].side;
    const active = new Set(activeSlotEntries(state, side).map(row => row.combatantKey));
    const reservations = new Set([...alreadySelected, ...(metadata?.context?.request?.state?.aiSwitchedPartySlots || [])]);
    return !actorParty(plan, entry, side).some((mon, index) => !active.has(mon.combatantKey) && !reservations.has(trainerPartyOrder(mon, index)) && knownHp(state.combatantStates[mon.combatantKey]) > 0);
  };
  const battlerCombatant = (selector, metadata) => {
    const entry = selectedBattlerEntry(state, actorEntry, metadata, selector);
    return entry ? plan.combatants[entry.combatantKey] : null;
  };
  const loaded = metadata => metadata?.locals?.calcTemp;
  const selectedEntry = (selector, metadata) => selectedBattlerEntry(state, actorEntry, metadata, selector);
  const party = (selector, metadata) => {
    const side = battlerCombatant(selector, metadata)?.side;
    return actorParty(plan, selectedEntry(selector, metadata), side);
  };
  const sideState = (selector, metadata) => state.fieldState?.sides?.[battlerCombatant(selector, metadata)?.side] || {};
  const maskOf = (record, mapping, metadata) => Object.entries(mapping).reduce((mask, [token, keys]) => keys.some(key => Boolean(record?.[key])) ? mask | Number(metadata.profile.constants.numericByToken[token]) : mask, 0);
  const sideMask = (selector, metadata) => maskOf(sideState(selector, metadata), {
    SIDE_CONDITION_REFLECT: ['reflect', 'reflectTurns'], SIDE_CONDITION_LIGHT_SCREEN: ['lightScreen', 'lightScreenTurns'], SIDE_CONDITION_SPIKES: ['spikes', 'spikesLayers'], SIDE_CONDITION_TOXIC_SPIKES: ['toxicSpikes', 'toxicSpikesLayers'], SIDE_CONDITION_STEALTH_ROCK: ['stealthRock'], SIDE_CONDITION_SAFEGUARD: ['safeguard', 'safeguardTurns'], SIDE_CONDITION_MIST: ['mist', 'mistTurns'], SIDE_CONDITION_TAILWIND: ['tailwindTurns'], SIDE_CONDITION_LUCKY_CHANT: ['luckyChantTurns'], SIDE_CONDITION_WISH: ['wish'], SIDE_CONDITION_FUTURE_SIGHT: ['futureSight']
  }, metadata);
  const effectMask = (selector, metadata) => {
    const mon = battlerState(selector, metadata);
    return maskOf({ ...mon?.volatileConditions, abilitySuppressed: mon?.abilitySuppressed }, {
      MOVE_EFFECT_LEECH_SEED: ['leechSeed', 'leechSeeded', 'leechSeedSourceKey'], MOVE_EFFECT_PERISH_SONG: ['perishSong', 'perishSongTurns', 'perishTurns'], MOVE_EFFECT_MINIMIZE: ['minimize'], MOVE_EFFECT_CHARGE: ['charge'], MOVE_EFFECT_INGRAIN: ['ingrain'], MOVE_EFFECT_YAWN: ['yawnTurns'], MOVE_EFFECT_IMPRISON: ['imprison'], MOVE_EFFECT_GRUDGE: ['grudge'], MOVE_EFFECT_MUD_SPORT: ['mudSport', 'mudsport'], MOVE_EFFECT_WATER_SPORT: ['waterSport', 'watersport'], MOVE_EFFECT_ABILITY_SUPPRESSED: ['abilitySuppressed'], MOVE_EFFECT_MIRACLE_EYE: ['miracleEye', 'miracleeye'], MOVE_EFFECT_POWER_TRICK: ['powerTrick', 'powertrick'], MOVE_EFFECT_AQUA_RING: ['aquaRing', 'aquaring'], MOVE_EFFECT_HEAL_BLOCK: ['healBlockTurns'], MOVE_EFFECT_EMBARGO: ['embargoTurns'], MOVE_EFFECT_MAGNET_RISE: ['magnetRiseTurns']
    }, metadata);
  };
  const rememberedMoves = (selector, metadata, effects = false) => {
    const mon = battlerState(selector, metadata), combatant = battlerCombatant(selector, metadata);
    if (!mon || !combatant) return [];
    if (![0, 1, ...(effects ? [] : [2])].includes(Number(selector)) || Number(selector) === 2 && knownHp(mon) === 0) return null;
    const ids = Number(selector) === 0 ? mon.aiKnownMoveIds || mon.usedMoveIds || [] : (mon.moveSetOverride || combatant.moves).map(row => row.moveId);
    return ids.map(id => effects ? dataset.get('moves', id)?.trainerAi?.effectId : numericRecordId(dataset, 'moves', id));
  };
  const knownItem = (selector, metadata, selfOnly = false) => {
    const mon = battlerState(selector, metadata);
    return numericRecordId(dataset, 'items', Number(selector) === 1 || !selfOnly && Number(selector) === 2 ? mon?.currentItemId : mon?.aiKnownItemId);
  };
  const previousMove = (selector, metadata) => numericRecordId(dataset, 'moves', battlerState(selector, metadata)?.lastMoveId);
  const moveRecord = (id, metadata) => metadata.profile.constants.moveTable.byNumericId[String(id)];
  const knownAbility = (selector, metadata, expected = null) => {
    const mon = battlerState(selector, metadata), combatant = battlerCombatant(selector, metadata);
    if (!mon || !combatant) return undefined;
    if (mon.abilitySuppressed) return 0;
    const actual = numericRecordId(dataset, 'abilities', mon.currentAbilityId);
    if ([1, 2].includes(Number(selector))) return actual;
    if (mon.aiKnownAbilityId) return numericRecordId(dataset, 'abilities', mon.aiKnownAbilityId);
    if (['shadowtag', 'arenatrap', 'magnetpull'].includes(toId(mon.currentAbilityId))) return actual;
    const slots = dataset.get('species', mon.currentSpeciesId || combatant.speciesId)?.abilitySlots;
    if (!Array.isArray(slots) || !slots.length) return undefined;
    const ids = slots.slice(0, 2).map(id => numericRecordId(dataset, 'abilities', id));
    if (ids.some(id => id === undefined)) return undefined;
    if (!ids[1]) return ids[0];
    if (!ids[0]) return ids[1];
    if (expected !== null) return ids.includes(expected) ? 0 : ids[0];
    return metadata.drawRandom('g4-ability-guess') & 1 ? ids[0] : ids[1];
  };
  const comparisons = {
    "platinum.command.IfLoadedEqualTo": (value, metadata) => loaded(metadata) === value,
    "platinum.command.IfLoadedNotEqualTo": (value, metadata) => loaded(metadata) === undefined ? undefined : loaded(metadata) !== value,
    "platinum.command.IfLoadedLessThan": (value, metadata) => loaded(metadata) === undefined ? undefined : loaded(metadata) < value,
    "platinum.command.IfLoadedGreaterThan": (value, metadata) => loaded(metadata) === undefined ? undefined : loaded(metadata) > value,
    "platinum.command.IfLoadedMask": (mask, metadata) => loaded(metadata) === undefined ? undefined : Boolean(Number(loaded(metadata)) & Number(mask)),
    "platinum.command.IfLoadedNotMask": (mask, metadata) => loaded(metadata) === undefined ? undefined : !Boolean(Number(loaded(metadata)) & Number(mask)),
    "platinum.command.IfLoadedInTable": (table, metadata) => loaded(metadata) === undefined ? undefined : tableContains(metadata.profile, table, loaded(metadata)),
    "platinum.command.IfLoadedNotInTable": (table, metadata) => {
      const present = loaded(metadata) === undefined ? undefined : tableContains(metadata.profile, table, loaded(metadata));
      return present === undefined ? undefined : !present;
    },
    "platinum.command.IfTempEqualTo": (value, metadata) => loaded(metadata) === value
  };
  const resolveAction = (key, metadata) => {
      if (key === 'forced-controller' || key === 'forced-fight') return platinumForcedAction({ plan, state, dataset, actorEntry, metadata, phase: key });
      const reservations = [...new Set([...alreadySelected, ...(metadata?.context?.request?.state?.aiSwitchedPartySlots || [])])];
      return key === "voluntary-switch"
        ? platinumVoluntarySwitchAction({ plan, state, dataset, actorEntry, metadata, alreadySelected: reservations })
        : key === "post-ko-replacement"
          ? platinumPostKoAction({ plan, state, dataset, actorEntry, metadata, alreadySelected: reservations })
          : key === "trainer-item"
            ? platinumTrainerItemAction({ plan, state, dataset, actorEntry, profile: metadata?.profile })
            : { status: "unavailable", action: undefined };
  };
  return {
    ...comparisons,
    "platinum.command.IfSideCondition": (selector, mask, metadata) => Boolean(sideMask(selector, metadata) & mask),
    "platinum.command.IfMoveEffect": (selector, mask, metadata) => Boolean(effectMask(selector, metadata) & mask),
    "platinum.command.IfNotMoveEffect": (selector, mask, metadata) => !(effectMask(selector, metadata) & mask),
    "platinum.command.IfFieldConditionsMask": (mask, metadata) => {
      const global = state.fieldState?.global || {}, constants = metadata.profile.constants.numericByToken;
      let bits = maskOf(global, { FIELD_CONDITION_GRAVITY: ['gravityTurns'], FIELD_CONDITION_TRICK_ROOM: ['trickRoomTurns'] }, metadata);
      const weather = weatherCode(state);
      bits |= constants[({ 1: 'FIELD_CONDITION_SUNNY', 2: 'FIELD_CONDITION_RAINING', 3: 'FIELD_CONDITION_SANDSTORM', 4: 'FIELD_CONDITION_HAILING', 5: 'FIELD_CONDITION_DEEP_FOG' })[weather]] || 0;
      return Boolean(bits & mask);
    },
    "platinum.command.IfLevel": (operation, metadata) => { const actor = battlerCombatant(1, metadata)?.level, target = battlerCombatant(0, metadata)?.level; return operation === 0 ? actor > target : operation === 1 ? actor < target : operation === 2 && actor === target; },
    "platinum.command.IfBattlerUnderEffect": (selector, effect, metadata) => { const volatile = battlerState(selector, metadata)?.volatileConditions; return effect === 0 ? Boolean(volatile?.disabledTurns || volatile?.disableTurns) : effect === 1 && Boolean(volatile?.encoreTurns); },
    "platinum.command.LoadSpikesLayers": (selector, condition, metadata) => condition === metadata.profile.constants.numericByToken.SIDE_CONDITION_SPIKES ? Number(sideState(selector, metadata).spikesLayers || 0) : condition === metadata.profile.constants.numericByToken.SIDE_CONDITION_TOXIC_SPIKES ? Number(sideState(selector, metadata).toxicSpikesLayers || 0) : loaded(metadata),
    "platinum.command.LoadGender": (selector, metadata) => ({ M: 0, F: 1, N: 2 })[battlerCombatant(selector, metadata)?.gender],
    "platinum.command.LoadStockpileCount": (selector, metadata) => Number(battlerState(selector, metadata)?.volatileConditions?.stockpileCount ?? battlerState(selector, metadata)?.volatileConditions?.stockpileLayers ?? 0),
    "platinum.command.LoadBattleType": metadata => Number(state.trainerAiBattleTypeMask ?? (metadata.profile.constants.numericByToken.BATTLE_TYPE_TRAINER | (plan.game.battleFormat === 'doubles' ? metadata.profile.constants.numericByToken.BATTLE_TYPE_DOUBLES : 0))),
    "platinum.command.LoadRecycleItem": (selector, metadata) => numericRecordId(dataset, 'items', battlerState(selector, metadata)?.lastConsumedItemId),
    "platinum.command.IfPartyMemberStatus": (selector, mask, metadata) => { const active = new Set([...activeSlotEntries(state, 'enemy'), ...activeSlotEntries(state, 'player')].map(row => row.combatantKey)); return party(selector, metadata).some(row => !active.has(row.combatantKey) && knownHp(state.combatantStates[row.combatantKey]) > 0 && (majorStatusMask(state.combatantStates[row.combatantKey]) & mask)); },
    "platinum.command.IfAnyPartyMemberIsWounded": (selector, metadata) => party(selector, metadata).some(row => row.combatantKey !== selectedEntry(selector, metadata)?.combatantKey && knownHp(state.combatantStates[row.combatantKey]) !== state.combatantStates[row.combatantKey]?.hp?.maxHp),
    "platinum.command.IfAnyPartyMemberUsedPP": (selector, metadata) => party(selector, metadata).some(row => row.combatantKey !== selectedEntry(selector, metadata)?.combatantKey && row.moves.some(move => state.combatantStates[row.combatantKey]?.movePp?.[move.moveId] !== move.maxPp)),
    "platinum.command.IfHeldItemEqualTo": (selector, expected, metadata) => knownItem(selector, metadata) === expected,
    "platinum.command.LoadHeldItemEffect": (selector, metadata) => metadata.profile.constants.itemBattleParameters[String(knownItem(selector, metadata, true))]?.holdEffect,
    "platinum.command.LoadFlingPower": (selector, metadata) => { const mon = battlerState(selector, metadata); return effectiveAiItem(mon, state) ? platinumItemParameters(dataset, metadata.profile, mon.currentItemId).flingPower : 0; },
    "platinum.command.DiffStatStages": (selector, stat, metadata) => statStage(battlerState(selector, metadata), stat) - statStage(battlerState(1, metadata), stat),
    "platinum.command.SumPositiveStatStages": (selector, metadata) => Object.values(battlerState(selector, metadata)?.statStages || {}).reduce((sum, value) => sum + Math.max(0, Number(value)), 0),
    "platinum.command.IfCanUseLastResort": (selector, metadata) => { const mon = battlerState(selector, metadata), count = (mon?.moveSetOverride || battlerCombatant(selector, metadata)?.moves || []).length; return count > 1 && Number(mon?.volatileConditions?.lastResortCount ?? mon?.usedMoveIds?.filter(id => id !== 'lastresort').length ?? 0) >= count - 1; },
    "platinum.command.IfMoveKnown": (selector, move, metadata) => rememberedMoves(selector, metadata)?.includes(move) || false,
    "platinum.command.IfMoveNotKnown": (selector, move, metadata) => { const list = rememberedMoves(selector, metadata); return list === null ? false : !list.includes(move); },
    "platinum.command.IfMoveEffectKnown": (selector, effect, metadata) => rememberedMoves(selector, metadata, true)?.includes(effect) || false,
    "platinum.command.IfMoveEffectNotKnown": (selector, effect, metadata) => { const list = rememberedMoves(selector, metadata, true); return list === null ? false : !list.includes(effect); },
    "platinum.command.LoadBattlerPreviousMove": previousMove,
    "platinum.command.LoadDefenderLastUsedMoveClass": metadata => moveRecord(previousMove(0, metadata), metadata)?.class,
    "platinum.command.LoadBattlerTurnCount": (selector, metadata) => Number(state.turnNumber || 0) - Number(battlerState(selector, metadata)?.enteredTurnNumber || 0),
    "platinum.command.IfTargetIsNotTaunted": metadata => !battlerState(0, metadata)?.volatileConditions?.tauntTurns,
    "platinum.command.LoadProtectChain": (selector, metadata) => ['protect', 'detect', 'endure'].includes(battlerState(selector, metadata)?.lastMoveId) ? Number(battlerState(selector, metadata)?.volatileConditions?.protectChain || 0) : 0,
    "platinum.command.FlagBattlerIsType": (selector, type, metadata) => Number(combatantTypes(plan, state, selectedEntry(selector, metadata)).some(id => numericTypeId(id, metadata.profile) === type)),
    "platinum.command.IfActivatedFlashFire": (selector, metadata) => Boolean(battlerState(selector, metadata)?.volatileConditions?.flashFire),
    "platinum.command.LoadAbility": (selector, metadata) => battlerState(selector, metadata)?.abilitySuppressed ? 0 : numericRecordId(dataset, 'abilities', battlerState(selector, metadata)?.currentAbilityId),
    "platinum.command.CheckBattlerAbility": (selector, expected, metadata) => { const value = knownAbility(selector, metadata, expected); return value === undefined ? undefined : value === 0 ? 2 : value === expected ? 1 : 0; },
    "platinum.command.IfTargetIsPartner": metadata => candidateTargetEntry(state, metadata)?.combatantKey === actorPartnerEntry(state, actorEntry)?.combatantKey,
    "platinum.command.IfMoveEqualTo": (moveId, metadata) => Number(candidateContext(metadata)?.action?.moveId) === Number(moveId),
    "platinum.command.FlagMoveDamageScore": damageRank,
    "platinum.command.IfCurrentMoveKills": (vary, metadata) => {
      const damage = damageFor(metadata, vary);
      const target = candidateTargetEntry(state, metadata);
      const hp = target ? knownHp(state.combatantStates[target.combatantKey]) : null;
      return damage === undefined || hp === null ? undefined : damage !== null && damage >= hp;
    },
    "platinum.command.IfCurrentMoveDoesNotKill": (vary, metadata) => {
      const damage = damageFor(metadata, vary);
      const target = candidateTargetEntry(state, metadata);
      const hp = target ? knownHp(state.combatantStates[target.combatantKey]) : null;
      return damage === undefined || hp === null ? undefined : damage !== null && damage < hp;
    },
    "platinum.command.IfPartyMemberDealsMoreDamage": (vary, metadata) => {
      const maximum = Math.max(0, ...allDamage(metadata, vary));
      return actorParty(plan, actorEntry).filter(mon => mon.combatantKey !== actorEntry.combatantKey && knownHp(state.combatantStates[mon.combatantKey]) > 0)
        .some(mon => Math.max(0, ...allDamage(metadata, vary, actorEntry, { combatantKey: mon.combatantKey })) > maximum);
    },
    "platinum.command.IfBattlerDealsMoreDamage": (selector, vary, metadata) => {
      const maximum = Math.max(0, ...allDamage(metadata, vary));
      const entry = selectedEntry(selector, metadata);
      const id = state.combatantStates[entry.combatantKey].lastMoveId;
      const move = id ? { ...dataset.get('moves', id), id } : { id: '', type: 'normal', trainerAi: { numericId: 0, basePower: 0 } };
      return sourceDamage(metadata, move, entry, entry, variance(metadata, moveSlot(metadata), vary), plan.combatants[actorEntry.combatantKey].ivs) > maximum;
    },
    "platinum.command.CheckIfHighestDamageWithPartner": (vary, metadata) => {
      if (!eligibleDamage(candidateMove(metadata, dataset), metadata)) return 0;
      const own = allDamage(metadata, vary);
      // The source exits before calculating the partner's moves. Those damage
      // queries can draw randomness (Magnitude/Psywave), so this is not cosmetic.
      if (own.some(value => value > own[moveSlot(metadata)])) return 1;
      const partner = actorPartnerEntry(state, actorEntry);
      if (!partner) throw new Error('Partner damage comparison requires the source partner battler');
      const other = allDamage(metadata, vary, partner);
      return other.some(value => value > own[moveSlot(metadata)]) ? 1 : 2;
    },
    "platinum.command.IfHasSuperEffectiveMove": metadata => activeSlotEntries(state, 'player').filter(entry => knownHp(state.combatantStates[entry.combatantKey]) > 0 && !state.combatantStates[entry.combatantKey].turnFlags?.switching)
      .some(defender => platinumMoves(plan, state, dataset, actorEntry.combatantKey).some(move => platinumTypeFacts({ plan, state, dataset, attacker: actorEntry, defender, move, metadata }).superEffective)),
    "platinum.command.IfMoveEffectivenessEquals": (modifier, metadata) => {
      const move = candidateMove(metadata, dataset), targetEntry = candidateTargetEntry(state, metadata);
      const result = platinumApplyTypeDamage({ plan, state, dataset, actorEntry, targetEntry, move, metadata, damage: 40 });
      return ({ 120: 80, 240: 160, 30: 20, 15: 10 })[result.damage] === Number(modifier)
        || ![120, 240, 30, 15].includes(result.damage) && result.damage === Number(modifier);
    },
    "platinum.command.LoadCurrentMoveEffect": metadata => candidateMove(metadata, dataset)?.trainerAi?.effectId,
    "platinum.command.IfCurrentMoveEffectEqualTo": (effectId, metadata) => candidateMove(metadata, dataset)?.trainerAi?.effectId === Number(effectId),
    "platinum.command.LoadCurrentMovePP": metadata => {
      const move = candidateMove(metadata, dataset);
      return move ? Number(state.combatantStates[actorEntry.combatantKey]?.movePp?.[move.id] ?? move.pp) : undefined;
    },
    "platinum.command.LoadPowerOfLoadedMove": metadata => loaded(metadata) === undefined
      ? undefined
      : metadata.profile.constants?.moveTable?.byNumericId?.[String(loaded(metadata))]?.power,
    "platinum.command.LoadEffectOfLoadedMove": metadata => loaded(metadata) === undefined
      ? undefined
      : metadata.profile.constants?.moveTable?.byNumericId?.[String(loaded(metadata))]?.effect,
    "platinum.command.LoadTypeFrom": (source, metadata) => {
      if (Number(source) === 4) return candidateMove(metadata, dataset)?.trainerAi?.typeId;
      const selectors = { 0: [0, 0], 1: [1, 0], 2: [0, 1], 3: [1, 1], 5: [3, 0], 6: [2, 0], 7: [3, 1], 8: [2, 1] };
      const [battler, typeIndex] = selectors[Number(source)] || [];
      const types = combatantTypes(plan, state, selectedBattlerEntry(state, actorEntry, metadata, battler));
      return types[typeIndex] || types[0] ? numericTypeId(types[typeIndex] || types[0], metadata.profile) : undefined;
    },
    "platinum.command.LoadBattlerAbility": knownAbility,
    "platinum.command.LoadHeldItem": (selector, metadata) => numericRecordId(dataset, "items", battlerState(selector, metadata)?.currentItemId),
    "platinum.command.IfHPPercentLessThan": (selector, percent, metadata) => {
      const value = hpPercent(battlerState(selector, metadata)); return value === undefined ? undefined : value < Number(percent);
    },
    "platinum.command.IfHPPercentGreaterThan": (selector, percent, metadata) => {
      const value = hpPercent(battlerState(selector, metadata)); return value === undefined ? undefined : value > Number(percent);
    },
    "platinum.command.IfHPPercentEqualTo": (selector, percent, metadata) => hpPercent(battlerState(selector, metadata)) === Number(percent),
    "platinum.command.IfHPPercentNotEqualTo": (selector, percent, metadata) => {
      const value = hpPercent(battlerState(selector, metadata)); return value === undefined ? undefined : value !== Number(percent);
    },
    "platinum.command.IfStatus": (selector, mask, metadata) => Boolean(majorStatusMask(battlerState(selector, metadata)) & Number(mask)),
    "platinum.command.IfNotStatus": (selector, mask, metadata) => !Boolean(majorStatusMask(battlerState(selector, metadata)) & Number(mask)),
    "platinum.command.IfVolatileStatus": (selector, mask, metadata) => Boolean(volatileStatusMask(battlerState(selector, metadata), metadata) & Number(mask)),
    "platinum.command.IfNotVolatileStatus": (selector, mask, metadata) => !Boolean(volatileStatusMask(battlerState(selector, metadata), metadata) & Number(mask)),
    "platinum.command.IfStatStageLessThan": (selector, stat, value, metadata) => statStage(battlerState(selector, metadata), stat) < Number(value),
    "platinum.command.IfStatStageGreaterThan": (selector, stat, value, metadata) => statStage(battlerState(selector, metadata), stat) > Number(value),
    "platinum.command.IfStatStageEqualTo": (selector, stat, value, metadata) => statStage(battlerState(selector, metadata), stat) === Number(value),
    "platinum.command.IfStatStageNotEqualTo": (selector, stat, value, metadata) => statStage(battlerState(selector, metadata), stat) !== Number(value),
    "platinum.command.LoadCurrentWeather": () => weatherCode(state),
    "platinum.command.LoadTurnCount": () => Number(state.turnNumber || 0),
    "platinum.command.LoadIsFirstTurnInBattle": (selector, metadata) => Number(battlerState(selector, metadata)?.enteredTurnNumber || 0) >= Number(state.turnNumber || 0) ? 1 : 0,
    "platinum.command.CountAlivePartyBattlers": (selector, metadata) => {
      const entry = selectedBattlerEntry(state, actorEntry, metadata, selector);
      if (!entry) return undefined;
      const side = plan.combatants[entry.combatantKey]?.side;
      const active = new Set(activeSlotEntries(state, side).map(row => row.combatantKey));
      return actorParty(plan, entry, side).filter(combatant => !active.has(combatant.combatantKey) && combatant.speciesId && combatant.speciesId !== 'egg' && knownHp(state.combatantStates[combatant.combatantKey]) > 0).length;
    },
    "platinum.command.IfBattlerFainted": battlerUnavailable,
    "platinum.command.IfBattlerNotFainted": (selector, metadata) => !battlerUnavailable(selector, metadata),
    "platinum.command.IfAttackerHasNoDamagingMoves": metadata => {
      const result = hasDamagingMove(moves.map(move => dataset.get("moves", move.moveId)));
      return result === undefined ? undefined : !result;
    },
    "platinum.command.IfSpeedCompareEqualTo": (comparison, metadata) => {
      const targetEntry = candidateTargetEntry(state, metadata);
      return platinumCompareSpeed({ plan, state, dataset, first: actorEntry, second: targetEntry, metadata }) === Number(comparison);
    },
    "platinum.command.LoadBattlerSpeedRank": (selector, metadata) => {
      const entries = [...activeSlotEntries(state, 'player'), ...activeSlotEntries(state, 'enemy')].sort((a, b) => gen4BattlerId(plan.combatants[a.combatantKey].side, a.slot) - gen4BattlerId(plan.combatants[b.combatantKey].side, b.slot));
      for (let i = 0; i < entries.length - 1; i++) for (let j = i + 1; j < entries.length; j++) {
        if (platinumCompareSpeed({ plan, state, dataset, first: entries[i], second: entries[j], metadata })) [entries[i], entries[j]] = [entries[j], entries[i]];
      }
      return entries.findIndex(row => row.combatantKey === selectedEntry(selector, metadata)?.combatantKey);
    },
    "platinum.action.decision": (key, metadata) => {
      const result = resolveAction(key, metadata);
      return result.status === "unavailable" ? undefined : result.action !== null;
    },
    "platinum.action.result": (key, metadata) => {
      const result = resolveAction(key, metadata);
      return result.status === "unavailable" ? undefined : result.action;
    }
  };
}

const gen5TokenCache = new WeakMap();

function gen5ProfileTokens(profile) {
  if (gen5TokenCache.has(profile)) return gen5TokenCache.get(profile);
  const tokens = new Set();
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (typeof value.token === "string") tokens.add(value.token);
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(profile.programs || []);
  visit(profile.constants || {});
  gen5TokenCache.set(profile, tokens);
  return tokens;
}

function gen5SourceToken(prefix, value, metadata, empty = null) {
  const id = toId(value);
  if (!id) return empty;
  const match = [...gen5ProfileTokens(metadata.profile)].find(token => token.startsWith(`${prefix}.`) && toId(token.slice(prefix.length + 1)) === id);
  return match || `${prefix}.${id}`;
}

function gen5SelectedBattlerEntry(state, actorEntry, metadata, selector) {
  const token = String(selector ?? "").toLowerCase();
  const numeric = Number(selector);
  const normalized = Number.isInteger(numeric) ? numeric : token.startsWith("target.ally") ? 2
    : token.startsWith("ally") ? 3 : token.startsWith("user") ? 1 : token.startsWith("target") ? 0 : -1;
  const targetEntry = candidateTargetEntry(state, metadata);
  if (normalized === 0) return targetEntry;
  if (normalized === 1) return actorEntry;
  if (normalized === 2) return targetPartnerEntry(state, targetEntry);
  if (normalized === 3) return actorPartnerEntry(state, actorEntry);
  return null;
}

function gen5EntryState(state, actorEntry, metadata, selector) {
  const entry = gen5SelectedBattlerEntry(state, actorEntry, metadata, selector);
  return entry ? state.combatantStates[entry.combatantKey] : null;
}

function gen5EntryCombatant(plan, state, actorEntry, metadata, selector) {
  const entry = gen5SelectedBattlerEntry(state, actorEntry, metadata, selector);
  return entry ? plan.combatants[entry.combatantKey] : null;
}

function gen5StatusId(combatantState) {
  const value = toId(combatantState?.majorStatus);
  return ({ slp: "sleep", asleep: "sleep", psn: "poison", tox: "toxic", brn: "burn", frz: "freeze", par: "paralysis" })[value] || value || "none";
}

function gen5ConditionPresent(combatantState, token) {
  if (!combatantState) return undefined;
  const id = toId(String(token).replace(/^(status|cond)\./i, ""));
  const status = gen5StatusId(combatantState);
  if (id === "sleep") return status === "sleep";
  if (id === "poison") return status === "poison" || status === "toxic";
  if (id === "toxic" || id === "badlypoisoned") return status === "toxic";
  if (["burn", "freeze", "paralysis"].includes(id)) return status === id;
  const volatile = combatantState.volatileConditions || {};
  const aliases = {
    confusion: ["confusion", "confusionTurns", "confusionCounterDistribution"], nightmare: ["nightmare"], leechseed: ["leechSeeded", "leechSeedSourceKey"],
    disable: ["disabledMoveId", "disableTurns"], encore: ["encoredMoveId", "encoreTurns"], lockon: ["sureHitTargetKey", "lockOn"],
    block: ["block", "blocked", "trappedBy"], curse: ["curseSourceKey", "curse"], foresight: ["foresight"],
    perishsong: ["perishTurns", "perishSong"], infatuated: ["attractSourceKey", "attract"], torment: ["torment"],
    taunt: ["tauntTurns", "taunt"], ingrain: ["ingrain"], embargo: ["embargoTurns", "embargo"],
    healblock: ["healBlockTurns", "healBlock"], gastroacid: ["gastroAcid", "abilitySuppressed"], aquaring: ["aquaRing"],
    floating: ["magnetRiseTurns", "telekinesisTurns", "floating"], telekinesis: ["telekinesisTurns"], yawn: ["yawnTurns", "yawn"],
    substitute: ["substituteHp", "substitute"], roost: ["roost"], movelock: ["moveLock"], chargelock: ["chargingMoveId"],
    choicelock: ["choiceLockedMoveId"], musthit: ["mustHit", "sureHitTargetKey"], knockeddown: ["smackDown", "knockedDown"],
    skydrop: ["skyDropSourceKey", "skyDropTargetKey"], accuracyup: ["accuracyUp"],
  };
  return (aliases[id] || [id]).some(key => { const value = combatantState[key] ?? volatile[key]; return Array.isArray(value) ? value.length > 0 : Boolean(value); });
}

function gen5ConditionFlagPresent(combatantState, token) {
  if (!combatantState) return undefined;
  const id = toId(String(token).replace(/^cond_fl\./i, ""));
  const volatile = combatantState.volatileConditions || {};
  const charging = toId(volatile.chargingMoveId);
  const values = {
    actiondone: Boolean(combatantState.turnFlags?.hasMoved),
    noswitch: Boolean(volatile.noSwitch || volatile.trappedBy),
    charge: Boolean(volatile.charge || volatile.chargingMoveId),
    fly: charging === "fly", dive: charging === "dive", dig: charging === "dig", shadowforce: charging === "shadowforce",
    defensecurl: Boolean(volatile.defenseCurl || volatile.defensecurl), minimize: Boolean(volatile.minimize),
    focusenergy: Boolean(volatile.focusEnergy || volatile.focusenergy), powertrick: Boolean(volatile.powerTrick || volatile.powertrick),
    micleberry: Boolean(volatile.micleBerry || volatile.micleberry), noaction: Boolean(volatile.noAction),
    flashfire: Boolean(volatile.flashFire || volatile.flashfire), batonpass: Boolean(volatile.batonPass || volatile.batonpass),
  };
  return Object.prototype.hasOwnProperty.call(values, id) ? values[id] : undefined;
}

function gen5SideForEntry(plan, entry) {
  return entry ? plan.combatants[entry.combatantKey]?.side : null;
}

function gen5SideConditionValue(plan, state, actorEntry, metadata, selector, token) {
  const entry = gen5SelectedBattlerEntry(state, actorEntry, metadata, selector);
  const side = gen5SideForEntry(plan, entry);
  const sideState = side ? state.fieldState?.sides?.[side] : null;
  if (!sideState) return undefined;
  const id = toId(String(token).replace(/^(side_status|side_cond)\./i, ""));
  const turnFields = { reflect: "reflectTurns", lightscreen: "lightScreenTurns", safeguard: "safeguardTurns", mist: "mistTurns", tailwind: "tailwindTurns", luckychant: "luckyChantTurns", wideguard: "wideGuardTurns", quickguard: "quickGuardTurns", rainbow: "rainbowTurns", seaoffire: "seaOfFireTurns", swamp: "swampTurns" };
  if (turnFields[id]) return Math.max(0, Number(sideState[turnFields[id]] || 0));
  if (["spikes", "toxicspikes", "stealthrock"].includes(id)) return Math.max(0, Number(sideState.hazards?.[id] ?? sideState.hazards?.[id.replace("rock", "Rock")] ?? 0));
  return undefined;
}

function gen5MoveIdsForEntry(plan, state, entry, { aiKnownOpponent = false } = {}) {
  if (!entry) return undefined;
  const combatant = plan.combatants[entry.combatantKey];
  const combatantState = state.combatantStates[entry.combatantKey];
  if (!combatant || !combatantState) return undefined;
  if (aiKnownOpponent && combatant.side === "player") return [...new Set(combatantState.aiKnownMoveIds || combatantState.usedMoveIds || [])];
  return (combatantState.moveSetOverride || combatant.moves || []).map(move => move.moveId || move.id).filter(Boolean);
}

function gen5HasMove(plan, state, actorEntry, metadata, selector, moveToken) {
  const entry = gen5SelectedBattlerEntry(state, actorEntry, metadata, selector);
  const ids = gen5MoveIdsForEntry(plan, state, entry, { aiKnownOpponent: true });
  return ids ? ids.some(id => toId(id) === toId(String(moveToken).replace(/^move\./i, ""))) : undefined;
}

function gen5MoveEffectsForEntry(plan, state, dataset, actorEntry, metadata, selector) {
  const entry = gen5SelectedBattlerEntry(state, actorEntry, metadata, selector);
  const ids = gen5MoveIdsForEntry(plan, state, entry, { aiKnownOpponent: true });
  if (!ids) return undefined;
  const effects = ids.map(id => dataset.get("moves", id)?.aiEffect).filter(Boolean);
  return effects.length === ids.length ? effects : undefined;
}

function gen5TypeMultiplier(plan, state, dataset, metadata, moveOverride = null) {
  const move = moveOverride || candidateMove(metadata, dataset);
  const targetEntry = candidateTargetEntry(state, metadata);
  if (!move || !targetEntry) return undefined;
  let multiplier = 1;
  for (const targetType of combatantTypes(plan, state, targetEntry)) {
    const record = dataset.get("types", targetType);
    if (!record) return undefined;
    const attackType = toId(move.type);
    if ((record.immune || []).some(type => toId(type) === attackType)) return 0;
    if ((record.weak || []).some(type => toId(type) === attackType)) multiplier *= 2;
    if ((record.resist || []).some(type => toId(type) === attackType)) multiplier /= 2;
  }
  // Ability immunities belong to the source script's explicit ability-guess
  // branches, not this type-chart query. In particular, do not repair Script 0's
  // Storm Drain/Levitate typo or Soundproof/Hyper Voice omission here.
  // Levitate is different: the source type calculator calls the separate
  // grounding event, not the omitted move-no-effect event.
  const targetState = state.combatantStates[targetEntry.combatantKey];
  if (toId(move.type) === "ground" && !targetState?.abilitySuppressed && toId(targetState?.currentAbilityId) === "levitate") return 0;
  return multiplier;
}

function gen5DamageState(state, targetEntry, move, policy) {
  const mon = state.combatantStates[targetEntry?.combatantKey];
  const ability = toId(mon?.currentAbilityId);
  const simulation = policy?.damageSimulation;
  const omitted = simulation?.ignoreDefenderImmunityAbilityIds?.includes(ability)
    || simulation?.conditionalIgnoreDefenderAbilities?.some(row => row.abilityId === ability && row.moveType === toId(move?.type));
  if (!omitted || mon?.abilitySuppressed) return state;
  // The source AI calls the damage formula without the move-no-effect event.
  // This isolated calculation view must not alter actual battle state or memory.
  return { ...state, combatantStates: { ...state.combatantStates,
    [targetEntry.combatantKey]: { ...mon, currentAbilityId: "none", abilitySuppressed: true } } };
}

function gen5ItemNumericId(dataset, itemId) {
  if (!itemId || toId(itemId) === "none") return 0;
  const record = dataset.get("items", itemId);
  const value = Number(record?.num ?? record?.trainerAi?.numericId);
  return Number.isInteger(value) ? value : undefined;
}

function gen5ItemToken(dataset, itemId, metadata) {
  const numeric = gen5ItemNumericId(dataset, itemId);
  if (numeric === 0) return "item.none";
  return numeric === undefined ? undefined : gen5SourceToken("item", itemId, metadata);
}

function gen5AbilityOptions({ plan, state, dataset, actorEntry, metadata, selector }) {
  const entry = gen5SelectedBattlerEntry(state, actorEntry, metadata, selector);
  if (!entry) return undefined;
  const combatant = plan.combatants[entry.combatantKey];
  const combatantState = state.combatantStates[entry.combatantKey];
  if (combatantState?.abilitySuppressed) return ["ability.none"];
  const actual = combatantState?.abilitySuppressed ? null : combatantState?.currentAbilityId || combatant?.originalAbilityId;
  const remembered = state.trainerAiBelief?.abilityByPosition?.[combatant?.side]?.[entry.slot];
  const trapping = new Set(["shadowtag", "arenatrap", "magnetpull"]);
  if (combatant?.side === "enemy" || remembered || trapping.has(toId(actual))) {
    const known = combatant?.side === "enemy" ? actual : remembered || actual;
    return known ? [gen5SourceToken("ability", known, metadata)] : undefined;
  }
  const speciesId = combatantState?.currentSpeciesId || combatant?.speciesId;
  const abilities = (dataset.get("species", speciesId)?.abilities || []).filter(ability => ability && !["none", "0"].includes(toId(ability)));
  return abilities.length ? abilities.map(ability => gen5SourceToken("ability", ability, metadata)) : undefined;
}

function gen5Compare(operator, left, right) {
  const id = toId(operator);
  if (id === "lt") return left < right;
  if (id === "gt") return left > right;
  if (id === "eq") return left === right;
  if (id === "and") return Boolean(Number(left) & Number(right));
  if (id === "nand") return !Boolean(Number(left) & Number(right));
  if (id === "lte") return left <= right;
  if (id === "gte") return left >= right;
  return undefined;
}

function gen5ProgramDataList(metadata, labelToken) {
  const instructions = metadata?.program?.instructions || [];
  const start = instructions.findIndex(instruction => instruction.label === labelToken || String(instruction.pc) === String(labelToken));
  if (start < 0) return undefined;
  const result = [];
  for (let index = start + 1; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (instruction.label) break;
    if (!["meta-literal", "meta-raw-word", "meta-table-entry"].includes(instruction.commandId)) break;
    const value = instruction.arguments?.value;
    result.push(value?.token ?? value?.value ?? value);
  }
  return result;
}

export function createGen5QueryProvider({ plan, state, dataset, actorEntry, moves, damageAdapter, gameId = "volt-white-2r" }) {
  const damageCache = new Map();
  const entryFor = (selector, metadata) => gen5SelectedBattlerEntry(state, actorEntry, metadata, selector);
  const stateFor = (selector, metadata) => gen5EntryState(state, actorEntry, metadata, selector);
  const combatantFor = (selector, metadata) => gen5EntryCombatant(plan, state, actorEntry, metadata, selector);
  const damageFor = (metadata, selector = "target", moveOverride = null, sourceEntry = actorEntry) => {
    const targetEntry = entryFor(selector, metadata);
    const move = moveOverride || candidateMove(metadata, dataset);
    const key = `${sourceEntry?.combatantKey || "?"}:${move?.id || "?"}:${targetEntry?.combatantKey || "?"}`;
    if (!damageCache.has(key)) damageCache.set(key, damageMaximum({ plan, state: gen5DamageState(state, targetEntry, move, dataset.abilityKnowledgePolicy), dataset, actorEntry: sourceEntry, targetEntry, move, damageAdapter, damageRoll: "minimum" }));
    return damageCache.get(key);
  };
  const actorAllMoves = () => {
    const combatant = plan.combatants[actorEntry.combatantKey];
    const monState = state.combatantStates[actorEntry.combatantKey];
    return (monState.moveSetOverride || combatant.moves || []).map(move => ({ id: move.moveId, ...dataset.get("moves", move.moveId) }));
  };
  const strongestDamage = (sourceEntry, targetEntry) => {
    if (!sourceEntry || !targetEntry) return undefined;
    const combatant = plan.combatants[sourceEntry.combatantKey];
    const monState = state.combatantStates[sourceEntry.combatantKey];
    const values = (monState.moveSetOverride || combatant.moves || []).map(entry => {
      const move = { id: entry.moveId, ...dataset.get("moves", entry.moveId) };
      return damageMaximum({ plan, state: gen5DamageState(state, targetEntry, move, dataset.abilityKnowledgePolicy), dataset, actorEntry: sourceEntry, targetEntry, move, damageAdapter, damageRoll: "minimum" });
    });
    if (values.some(value => value === undefined)) return undefined;
    return Math.max(0, ...values.map(value => value === null ? 0 : value));
  };
  const stored = metadata => metadata?.locals?.stored;
  const storedCompare = (value, metadata, operator) => {
    const left = stored(metadata);
    return left === undefined ? undefined : operator(left, value);
  };
  const equality = (left, right) => typeof left === "string" || typeof right === "string" ? toId(left) === toId(right) : left === right;
  const stageKey = stat => ({ atk: "atk", def: "def", spe: "spe", spa: "spa", spd: "spd", acc: "accuracy", eva: "evasion" })[toId(stat)];
  const compareStage = (pokemon, stat, stage, metadata, compare) => {
    const key = stageKey(stat);
    const stages = stateFor(pokemon, metadata)?.statStages;
    if (!key || !stages || !Object.prototype.hasOwnProperty.call(stages, key)) return undefined;
    const current = Number(stages[key]);
    return Number.isFinite(current) ? compare(current, Number(stage)) : undefined;
  };
  const itemBuildKey = gameId === "volt-white-2r" ? "vw2rEgglocke" : "retail";
  const itemParameters = (itemId, metadata) => {
    const numericId = gen5ItemNumericId(dataset, itemId);
    return numericId === undefined ? undefined : metadata.profile.itemBattleParameters?.records?.[String(numericId)]?.[itemBuildKey];
  };
  const queries = {
    "gen5.command.0x05": (pokemon, health, metadata) => { const value = hpPercent(stateFor(pokemon, metadata)); return value === undefined ? undefined : value < Number(health); },
    "gen5.command.0x06": (pokemon, health, metadata) => { const value = hpPercent(stateFor(pokemon, metadata)); return value === undefined ? undefined : value > Number(health); },
    "gen5.command.0x07": (pokemon, health, metadata) => { const value = hpPercent(stateFor(pokemon, metadata)); return value === undefined ? undefined : value === Number(health); },
    "gen5.command.0x08": (pokemon, health, metadata) => { const value = hpPercent(stateFor(pokemon, metadata)); return value === undefined ? undefined : value !== Number(health); },
    "gen5.command.0x09": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); return mon ? gen5StatusId(mon) !== "none" : undefined; },
    "gen5.command.0x0a": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); return mon ? gen5StatusId(mon) === "none" : undefined; },
    "gen5.command.0x0b": (pokemon, condition, metadata) => gen5ConditionPresent(stateFor(pokemon, metadata), condition),
    "gen5.command.0x0c": (pokemon, condition, metadata) => { const value = gen5ConditionPresent(stateFor(pokemon, metadata), condition); return value === undefined ? undefined : !value; },
    "gen5.command.0x0d": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); return mon ? gen5StatusId(mon) === "toxic" : undefined; },
    "gen5.command.0x0e": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); return mon ? gen5StatusId(mon) !== "toxic" : undefined; },
    "gen5.command.0x0f": (pokemon, flag, metadata) => gen5ConditionFlagPresent(stateFor(pokemon, metadata), flag),
    "gen5.command.0x10": (pokemon, flag, metadata) => { const value = gen5ConditionFlagPresent(stateFor(pokemon, metadata), flag); return value === undefined ? undefined : !value; },
    "gen5.command.0x11": (pokemon, condition, metadata) => { const value = gen5SideConditionValue(plan, state, actorEntry, metadata, pokemon, condition); return value === undefined ? undefined : value > 0; },
    "gen5.command.0x12": (pokemon, condition, metadata) => { const value = gen5SideConditionValue(plan, state, actorEntry, metadata, pokemon, condition); return value === undefined ? undefined : value === 0; },
    "gen5.command.0x13": (value, metadata) => storedCompare(value, metadata, (left, right) => Number(left) < Number(right)),
    "gen5.command.0x14": (value, metadata) => storedCompare(value, metadata, (left, right) => Number(left) > Number(right)),
    "gen5.command.0x15": (value, metadata) => storedCompare(value, metadata, equality),
    "gen5.command.0x16": (value, metadata) => storedCompare(value, metadata, (left, right) => !equality(left, right)),
    "gen5.command.0x17": (value, metadata) => storedCompare(value, metadata, (left, right) => Boolean(Number(left) & Number(right))),
    "gen5.command.0x18": (value, metadata) => storedCompare(value, metadata, (left, right) => !Boolean(Number(left) & Number(right))),
    "gen5.command.0x19": (move, metadata) => equality(gen5SourceToken("move", candidateMove(metadata, dataset)?.id, metadata), move),
    "gen5.command.0x1a": (move, metadata) => !equality(gen5SourceToken("move", candidateMove(metadata, dataset)?.id, metadata), move),
    "gen5.command.0x1b": (label, metadata) => { const list = gen5ProgramDataList(metadata, label); return list ? list.some(value => equality(value, stored(metadata))) : undefined; },
    "gen5.command.0x1c": (label, metadata) => { const list = gen5ProgramDataList(metadata, label); return list ? !list.some(value => equality(value, stored(metadata))) : undefined; },
    "gen5.command.0x1d": metadata => hasDamagingMove(actorAllMoves()),
    "gen5.command.0x1e": metadata => {
      const result = hasDamagingMove(actorAllMoves());
      return result === undefined ? undefined : !result;
    },
    "gen5.command.0x1f": () => Math.max(0, Number(state.turnNumber || 0)),
    "gen5.command.0x20": (typeParam, metadata) => {
      const token = String(typeParam); const id = toId(token);
      if (id === "movetype") return gen5SourceToken("type", candidateMove(metadata, dataset)?.type, metadata);
      if (id === "storedmovetype") { const moveId = String(stored(metadata) || "").replace(/^move\./i, ""); return gen5SourceToken("type", dataset.get("moves", toId(moveId))?.type, metadata); }
      const selector = id.startsWith("targetally") ? "target.ally" : id.startsWith("ally") ? "ally" : id.startsWith("user") ? "user" : "target";
      const index = id.endsWith("type2") ? 1 : 0;
      return gen5SourceToken("type", combatantTypes(plan, state, entryFor(selector, metadata))[index], metadata);
    },
    "gen5.command.0x21": metadata => candidateMove(metadata, dataset)?.basePower,
    "gen5.command.0x22": (target, metadata) => {
      const current = damageFor(metadata, target); if (current === undefined) return undefined;
      if (current === null) return "no_damage";
      const targetEntry = entryFor(target, metadata); const best = strongestDamage(actorEntry, targetEntry);
      return best === undefined ? undefined : current >= best ? "is_strongest" : "not_strongest";
    },
    "gen5.command.0x23": (pokemon, metadata) => gen5SourceToken("move", stateFor(pokemon, metadata)?.lastMoveId, metadata, "move.none"),
    "gen5.command.0x24": (value, metadata) => storedCompare(value, metadata, equality),
    "gen5.command.0x25": (value, metadata) => storedCompare(value, metadata, (left, right) => !equality(left, right)),
    "gen5.command.0x26": (operator, metadata) => {
      const target = candidateTargetEntry(state, metadata); if (!target) return undefined;
      const targetSpeed = effectiveActionSpeed({ combatant: plan.combatants[target.combatantKey], combatantState: state.combatantStates[target.combatantKey], battleState: state, side: "player", generation: 5 });
      const userSpeed = effectiveActionSpeed({ combatant: plan.combatants[actorEntry.combatantKey], combatantState: state.combatantStates[actorEntry.combatantKey], battleState: state, side: "enemy", generation: 5 });
      return gen5Compare(operator, targetSpeed, userSpeed);
    },
    "gen5.command.0x27": (pokemon, metadata) => {
      const entry = entryFor(pokemon, metadata); const side = gen5SideForEntry(plan, entry); if (!side) return undefined;
      const active = new Set(activeSlotEntries(state, side).map(row => row.combatantKey));
      return actorParty(plan, entry, side).filter(mon => !active.has(mon.combatantKey) && Number(state.combatantStates[mon.combatantKey]?.hp?.max ?? 0) > 0).length;
    },
    "gen5.command.0x28": metadata => gen5SourceToken("move", candidateMove(metadata, dataset)?.id, metadata),
    "gen5.command.0x29": metadata => candidateMove(metadata, dataset)?.aiEffect,
    "gen5.command.0x2a.ability-options": (pokemon, metadata) => gen5AbilityOptions({ plan, state, dataset, actorEntry, metadata, selector: pokemon }),
    "gen5.command.0x2c": (effectiveness, metadata) => {
      const multiplier = gen5TypeMultiplier(plan, state, dataset, metadata); if (multiplier === undefined) return undefined;
      const token = ({ 0: "0x", 0.25: "1/4x", 0.5: "1/2x", 1: "1x", 2: "2x", 4: "4x" })[multiplier]; return token === effectiveness;
    },
    "gen5.command.0x2d": (statusToken, metadata) => {
      const status = toId(String(statusToken).replace(/^status\./i, ""));
      return actorParty(plan, actorEntry).some(mon => Number(state.combatantStates[mon.combatantKey]?.hp?.max ?? 0) > 0 && (status === "poison" ? ["poison", "toxic"].includes(gen5StatusId(state.combatantStates[mon.combatantKey])) : gen5StatusId(state.combatantStates[mon.combatantKey]) === status));
    },
    "gen5.command.0x2f": metadata => gen5SourceToken("weather", state.fieldState?.global?.weather?.id, metadata, "weather.none"),
    "gen5.command.0x30": (effect, metadata) => equality(candidateMove(metadata, dataset)?.aiEffect, effect),
    "gen5.command.0x32": (pokemon, stat, stage, metadata) => compareStage(pokemon, stat, stage, metadata, (current, expected) => current < expected),
    "gen5.command.0x33": (pokemon, stat, stage, metadata) => compareStage(pokemon, stat, stage, metadata, (current, expected) => current > expected),
    "gen5.command.0x34": (pokemon, stat, stage, metadata) => compareStage(pokemon, stat, stage, metadata, (current, expected) => current === expected),
    "gen5.command.0x35": (pokemon, stat, stage, metadata) => compareStage(pokemon, stat, stage, metadata, (current, expected) => current !== expected),
    "gen5.command.0x36": (pokemon, metadata) => { const damage = damageFor(metadata, pokemon); const hp = knownHp(stateFor(pokemon, metadata)); return damage === undefined || hp === null ? undefined : damage !== null && damage >= hp; },
    "gen5.command.0x38": (pokemon, move, metadata) => gen5HasMove(plan, state, actorEntry, metadata, pokemon, move),
    "gen5.command.0x39": (pokemon, move, metadata) => { const value = gen5HasMove(plan, state, actorEntry, metadata, pokemon, move); return value === undefined ? undefined : !value; },
    "gen5.command.0x3a": (pokemon, effect, metadata) => { const values = gen5MoveEffectsForEntry(plan, state, dataset, actorEntry, metadata, pokemon); return values ? values.some(value => equality(value, effect)) : undefined; },
    "gen5.command.0x3b": (pokemon, effect, metadata) => { const values = gen5MoveEffectsForEntry(plan, state, dataset, actorEntry, metadata, pokemon); return values ? !values.some(value => equality(value, effect)) : undefined; },
    "gen5.command.0x40": (pokemon, metadata) => gen5ItemToken(dataset, stateFor(pokemon, metadata)?.currentItemId, metadata),
    "gen5.command.0x41": (pokemon, metadata) => { const row = itemParameters(stateFor(pokemon, metadata)?.currentItemId, metadata); return row ? row.holdEffectParameter1 === 107 ? "item_ef.move_last" : row.holdEffectParameter1 : undefined; },
    "gen5.command.0x42": (pokemon, metadata) => { const gender = combatantFor(pokemon, metadata)?.gender || stateFor(pokemon, metadata)?.gender; return gender ? toId(gender) : undefined; },
    "gen5.command.0x43": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); return mon ? Number(mon.enteredTurnNumber ?? 0) === Number(state.turnNumber || 0) ? 1 : 0 : undefined; },
    "gen5.command.0x44": (pokemon, metadata) => Number(stateFor(pokemon, metadata)?.volatileConditions?.stockpileLayers || 0),
    "gen5.command.0x45": () => ({ singles: "single_battle", doubles: "double_battle", triples: "triple_battle", rotation: "single_battle" })[plan.game.battleFormat],
    "gen5.command.0x46": () => state.trainerAiBattleType || (plan.game.trainerId ? "plc_npc_trainer_battle" : undefined),
    "gen5.command.0x47": (pokemon, metadata) => gen5ItemToken(dataset, stateFor(pokemon, metadata)?.lastItemId, metadata),
    "gen5.command.0x49": metadata => { const moveToken = stored(metadata); return !moveToken || equality(moveToken, "move.none") ? 0 : dataset.get("moves", toId(String(moveToken).replace(/^move\./i, "")))?.basePower; },
    "gen5.command.0x4a": metadata => { const moveToken = stored(metadata); return !moveToken || equality(moveToken, "move.none") ? -1 : dataset.get("moves", toId(String(moveToken).replace(/^move\./i, "")))?.aiEffect; },
    "gen5.command.0x4b": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); const moveId = toId(mon?.lastMoveId); return ["protect", "detect", "endure"].includes(moveId) ? Number(mon?.volatileConditions?.protectStreak || 0) : 0; },
    "gen5.command.0x4e": (comparison, metadata) => { const target = candidateTargetEntry(state, metadata); const targetLevel = target && Number(state.combatantStates[target.combatantKey]?.currentLevel ?? plan.combatants[target.combatantKey]?.level); const actorLevel = Number(state.combatantStates[actorEntry.combatantKey]?.currentLevel ?? plan.combatants[actorEntry.combatantKey]?.level); return Number.isFinite(targetLevel) && Number.isFinite(actorLevel) ? gen5Compare(comparison, actorLevel, targetLevel) : undefined; },
    "gen5.command.0x50": metadata => { const target = candidateTargetEntry(state, metadata); return target ? !gen5ConditionPresent(state.combatantStates[target.combatantKey], "status.taunt") : undefined; },
    "gen5.command.0x51": metadata => candidateTargetEntry(state, metadata)?.combatantKey === actorPartnerEntry(state, actorEntry)?.combatantKey,
    "gen5.command.0x52": (pokemon, type, metadata) => { const entry = entryFor(pokemon, metadata); return entry ? (combatantTypes(plan, state, entry).some(value => toId(value) === toId(String(type).replace(/^type\./i, ""))) ? 1 : 0) : undefined; },
    "gen5.command.0x53.ability-match-options": (pokemon, ability, metadata) => { const values = gen5AbilityOptions({ plan, state, dataset, actorEntry, metadata, selector: pokemon }); return values?.map(value => equality(value, ability)); },
    "gen5.command.0x54": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); return mon ? Boolean(mon.volatileConditions?.flashFire) : undefined; },
    "gen5.command.0x55": (pokemon, item, metadata) => { const mon = stateFor(pokemon, metadata); const held = mon ? gen5ItemToken(dataset, mon.currentItemId, metadata, "item.none") : undefined; return held === undefined ? undefined : equality(held, item); },
    "gen5.command.0x56": (effect, metadata) => {
      const id = toId(String(effect).replace(/^field_ef\./i, "")); const global = state.fieldState?.global || {};
      const turns = { trickroom: global.trickRoomTurns, gravity: global.gravityTurns, wonderroom: global.wonderRoomTurns, magicroom: global.magicRoomTurns };
      if (Object.prototype.hasOwnProperty.call(turns, id)) return Number(turns[id] || 0) > 0;
      if (id === "imprison") return activeSlotEntries(state, "player").concat(activeSlotEntries(state, "enemy")).some(entry => Boolean(state.combatantStates[entry.combatantKey]?.volatileConditions?.imprison));
      if (id === "mudsport" || id === "watersport") return activeSlotEntries(state, "player").concat(activeSlotEntries(state, "enemy")).some(entry => Boolean(state.combatantStates[entry.combatantKey]?.volatileConditions?.[id]));
      return undefined;
    },
    "gen5.command.0x57": (pokemon, condition, metadata) => gen5SideConditionValue(plan, state, actorEntry, metadata, pokemon, condition),
    "gen5.command.0x58": (pokemon, metadata) => { const entry = entryFor(pokemon, metadata); const side = gen5SideForEntry(plan, entry); return side ? actorParty(plan, entry, side).some(mon => { const hp = state.combatantStates[mon.combatantKey]?.hp; return Number(hp?.max ?? 0) > 0 && Number(hp.max) < Number(hp.maxHp); }) : undefined; },
    "gen5.command.0x59": (pokemon, metadata) => { const entry = entryFor(pokemon, metadata); const side = gen5SideForEntry(plan, entry); return side ? actorParty(plan, entry, side).some(mon => (mon.moves || []).some(move => Number(state.combatantStates[mon.combatantKey]?.movePp?.[move.moveId] ?? move.maxPp) < Number(move.maxPp))) : undefined; },
    "gen5.command.0x5a": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); if (!mon) return undefined; if (mon.itemState !== "held" || Number(mon.volatileConditions?.embargoTurns || 0) > 0 || Number(state.fieldState?.global?.magicRoomTurns || 0) > 0 || toId(mon.currentAbilityId) === "klutz") return 0; return itemParameters(mon.currentItemId, metadata)?.flingPowerParameter10; },
    "gen5.command.0x5b": metadata => { const move = candidateMove(metadata, dataset); return move ? Number(state.combatantStates[actorEntry.combatantKey]?.movePp?.[move.id] ?? move.pp) : undefined; },
    "gen5.command.0x5c": (pokemon, metadata) => { const entry = entryFor(pokemon, metadata); const ids = gen5MoveIdsForEntry(plan, state, entry); const used = stateFor(pokemon, metadata)?.usedMoveIds; return ids && Array.isArray(used) ? ids.filter(id => toId(id) !== "lastresort").every(id => used.some(value => toId(value) === toId(id))) : undefined; },
    "gen5.command.0x5e": metadata => { const id = state.combatantStates[actorEntry.combatantKey]?.lastMoveId; return id ? dataset.get("moves", id)?.category : 0; },
    "gen5.command.0x5f": (pokemon, metadata) => stateFor(pokemon, metadata)?.turnOrderPosition,
    "gen5.command.0x60": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); return mon ? Math.max(0, Number(state.turnNumber || 0) - Number(mon.enteredTurnNumber || 0)) : undefined; },
    "gen5.command.0x61": (pokemon, metadata) => { const target = entryFor(pokemon, metadata); const active = new Set(activeSlotEntries(state, "enemy").map(entry => entry.combatantKey)); const actorBest = strongestDamage(actorEntry, target); if (actorBest === undefined) return undefined; const reserveValues = actorParty(plan, actorEntry).filter(mon => !active.has(mon.combatantKey) && Number(state.combatantStates[mon.combatantKey]?.hp?.max ?? 0) > 0).map(mon => strongestDamage({ combatantKey: mon.combatantKey }, target)); return reserveValues.some(value => value === undefined) ? undefined : reserveValues.some(value => value > actorBest); },
    "gen5.command.0x62": metadata => {
      const values = actorAllMoves().map(move => gen5TypeMultiplier(plan, state, dataset, metadata, move));
      return values.some(value => value === undefined) ? undefined : values.some(value => value > 1);
    },
    "gen5.command.0x63": (previousPokemon, targetPokemon, metadata) => { const previous = stateFor(previousPokemon, metadata); const recorded = previous?.lastMoveDamage; const target = entryFor(targetPokemon, metadata); const best = strongestDamage(actorEntry, target); return Number.isFinite(Number(recorded)) && best !== undefined ? Number(recorded) > best : undefined; },
    "gen5.command.0x64": (pokemon, metadata) => { const stages = stateFor(pokemon, metadata)?.statStages; return stages ? ["atk", "def", "spe", "spa", "spd", "accuracy", "evasion"].reduce((sum, key) => sum + Math.max(0, Number(stages[key] || 0)), 0) : undefined; },
    "gen5.command.0x65": (pokemon, stat, metadata) => { const key = ({ atk: "atk", def: "def", spe: "spe", spa: "spa", spd: "spd", acc: "accuracy", eva: "evasion" })[toId(stat)]; const selected = stateFor(pokemon, metadata)?.statStages; const actorStages = state.combatantStates[actorEntry.combatantKey]?.statStages; return key && selected && actorStages ? Number(selected[key] || 0) - Number(actorStages[key] || 0) : undefined; },
    "gen5.command.0x69": (pokemon, metadata) => { const target = entryFor(pokemon, metadata); const partner = actorPartnerEntry(state, actorEntry); const current = damageFor(metadata, pokemon); const partnerBest = strongestDamage(partner, target); return current === undefined || partnerBest === undefined ? undefined : Number(current || 0) >= partnerBest ? "is_strongest" : "not_strongest"; },
    "gen5.command.0x6a": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); return mon ? Number(mon.hp?.max ?? 0) <= 0 : undefined; },
    "gen5.command.0x6d": (pokemon, metadata) => { const mon = stateFor(pokemon, metadata); return mon ? Number(mon.volatileConditions?.substituteHp || 0) > 0 : undefined; },
    "gen5.command.0x6e": (pokemon, metadata) => gen5SourceToken("species", stateFor(pokemon, metadata)?.currentSpeciesId || combatantFor(pokemon, metadata)?.speciesId, metadata),
    "gen5.command.0x74": (pokemon, metadata) => { const entry = entryFor(pokemon, metadata); return entry ? (state.fieldState?.global?.delayedAttacks || []).some(row => row.targetKey === entry.combatantKey || row.targetSlot === entry.slot) : undefined; },
    "gen5.command.0x75": (pokemon, metadata) => { const entry = entryFor(pokemon, metadata); const spa = Number(stateFor(pokemon, metadata)?.currentStats?.spa ?? combatantFor(pokemon, metadata)?.calculatedStats?.spa); const index = entry ? gen4BattlerId(gen5SideForEntry(plan, entry), entry.slot) : NaN; return Number.isFinite(spa) && Number.isFinite(index) ? index < spa : undefined; },
    "gen5.command.0x76": (pokemon, metadata) => { const entry = entryFor(pokemon, metadata); const spa = Number(stateFor(pokemon, metadata)?.currentStats?.spa ?? combatantFor(pokemon, metadata)?.calculatedStats?.spa); const index = entry ? gen4BattlerId(gen5SideForEntry(plan, entry), entry.slot) : NaN; return Number.isFinite(spa) && Number.isFinite(index) ? index > spa : undefined; },
  };
  return queries;
}

function moveTargetEntries(plan, state, actorEntry, move, dataset) {
  const descriptor = dataset.get("moves", move.moveId) || {};
  const targetMode = String(descriptor.target || "normal").toLowerCase();
  if (["self", "adjacentallyorself", "allies", "allyside", "foeside", "field"].includes(targetMode)) {
    return [{ combatantKey: actorEntry.combatantKey, slot: actorEntry.slot }];
  }
  if (["alladjacent", "alladjacentfoes", "allopponents"].includes(targetMode)) {
    return [{ combatantKey: "all-opponents", slot: null }];
  }
  let opponents = activeSlotEntries(state, "player").filter(entry => Number(state.combatantStates[entry.combatantKey]?.hp?.max ?? 0) > 0);
  if (plan.game.battleFormat === "rotation") {
    const frontSlot = rotationFrontSlot(state, "player");
    opponents = opponents.filter(entry => entry.slot === frontSlot);
  } else if (plan.game.battleFormat === "triples" && descriptor.distance !== true) {
    opponents = opponents.filter(entry => areSlotsAdjacent(plan, "enemy", actorEntry.slot, "player", entry.slot));
  }
  return opponents;
}

function evaluatorMoveTargetEntries(plan, state, actorEntry, move, dataset) {
  const targets = moveTargetEntries(plan, state, actorEntry, move, dataset);
  if (!targets.some(target => target.combatantKey === "all-opponents")) return targets;
  return activeSlotEntries(state, "player").filter(entry => Number(state.combatantStates[entry.combatantKey]?.hp?.max ?? 0) > 0);
}

function trainerPartyOrder(combatant, fallback = 0) {
  const slot = Number(combatant?.source?.trainerSlot ?? combatant?.source?.slot ?? fallback + 1);
  return Number.isInteger(slot) && slot > 0 ? slot - 1 : fallback;
}

function normalizedPartyMember(plan, state, combatant, fallback = 0) {
  const monState = state.combatantStates[combatant.combatantKey];
  const activeEntry = [...activeSlotEntries(state, "player"), ...activeSlotEntries(state, "enemy")]
    .find(entry => entry.combatantKey === combatant.combatantKey);
  return {
    ...normalizedActor(plan, state, activeEntry || { combatantKey: combatant.combatantKey, slot: trainerPartyOrder(combatant, fallback) }),
    partySlot: trainerPartyOrder(combatant, fallback),
    partyOrder: trainerPartyOrder(combatant, fallback),
    active: Boolean(activeEntry),
    empty: !monState,
    moves: (monState?.moveSetOverride || combatant.moves || []).map(move => ({
      id: move.moveId || move.id,
      pp: Number(monState?.movePp?.[move.moveId || move.id] ?? move.maxPp ?? 0)
    }))
  };
}

function typeOnlyMultiplier(plan, state, dataset, move, targetEntry) {
  if (!move || !targetEntry) return undefined;
  let multiplier = 1;
  const attackType = toId(move.type);
  if (!attackType) return undefined;
  for (const targetType of combatantTypes(plan, state, targetEntry)) {
    const record = dataset.get("types", targetType);
    if (!record) return undefined;
    if ((record.immune || []).some(type => toId(type) === attackType)) return 0;
    if ((record.weak || []).some(type => toId(type) === attackType)) multiplier *= 2;
    if ((record.resist || []).some(type => toId(type) === attackType)) multiplier /= 2;
  }
  return multiplier;
}

function moveEffectivenessAgainst(plan, state, dataset, move, targetEntry) {
  const multiplier = typeOnlyMultiplier(plan, state, dataset, move, targetEntry);
  if (multiplier === undefined || !targetEntry) return multiplier;
  const targetState = state.combatantStates[targetEntry.combatantKey];
  const ability = targetState?.abilitySuppressed ? "" : toId(targetState?.currentAbilityId);
  const immunities = {
    ground: ["levitate"],
    water: ["waterabsorb", "stormdrain", "dryskin"],
    electric: ["voltabsorb", "motordrive", "lightningrod"],
    fire: ["flashfire"],
    grass: ["sapsipper"]
  };
  if ((immunities[toId(move.type)] || []).includes(ability)) return 0;
  if (ability === "wonderguard" && multiplier <= 1 && isDamagingMove(move)) return 0;
  return multiplier;
}

function platinumReserves(plan, state, actorEntry, alreadySelected = []) {
  const active = new Set(activeSlotEntries(state, "enemy").map(entry => entry.combatantKey));
  return actorParty(plan, actorEntry)
    .map((combatant, index) => ({ combatant, partySlot: trainerPartyOrder(combatant, index) }))
    .filter(({ combatant, partySlot }) => !alreadySelected.includes(partySlot) && !active.has(combatant.combatantKey) && Number(state.combatantStates[combatant.combatantKey]?.hp?.max ?? 0) > 0)
    .sort((left, right) => left.partySlot - right.partySlot);
}

function platinumItemParameters(dataset, profile, itemId) {
  const id = numericRecordId(dataset, "items", itemId || "none");
  const params = profile.constants.itemBattleParameters?.[String(id)];
  if (!params) throw new Error(`Missing source held-item parameters for ${itemId}`);
  const token = Object.keys(profile.constants.numericByToken).find(key => key.startsWith("HOLD_EFFECT_") && profile.constants.numericByToken[key] === params.holdEffect);
  return { ...params, token };
}

function platinumMoves(plan, state, dataset, key) {
  return (state.combatantStates[key]?.moveSetOverride || plan.combatants[key]?.moves || []).map(row => {
    const id = row.moveId || row.id;
    const move = dataset.get("moves", id);
    if (!move?.trainerAi) throw new Error(`Missing source AI move record ${id}`);
    return { ...move, id, sourcePower: move.trainerAi.basePower };
  });
}

function platinumTypeToken(profile, numeric) {
  const token = profile.constants.gameOverrides?.numericTypeTokens?.[numeric]
    || Object.keys(profile.constants.numericByToken).find(key => key.startsWith('TYPE_') && profile.constants.numericByToken[key] === numeric);
  return token?.replace(/^(?:RP_)?TYPE_/, '').toLowerCase() || `invalid-source-type-${numeric}`;
}

function platinumMoveType(plan, state, dataset, entry, move, metadata, party = false) {
  const mon = state.combatantStates[entry.combatantKey];
  const combatant = plan.combatants[entry.combatantKey];
  if (toId(mon.currentAbilityId) === "normalize" && !mon.abilitySuppressed) return "normal";
  if (move.resolvedAiType) return move.resolvedAiType;
  if (move.id === "hiddenpower") {
    const ivs = combatant.ivs;
    if (!ivs || ["hp", "atk", "def", "spe", "spa", "spd"].some(key => !Number.isInteger(ivs[key]))) throw new Error("Hidden Power AI type requires all six IVs");
    const bits = ["hp", "atk", "def", "spe", "spa", "spd"].reduce((sum, key, index) => sum + ((ivs[key] & 1) << index), 0);
    return ["fighting", "flying", "poison", "ground", "rock", "bug", "ghost", "steel", "fire", "water", "grass", "electric", "psychic", "ice", "dragon", "dark"][Math.floor(bits * 15 / 63)];
  }
  if (move.id === "judgment" || move.id === "naturalgift") {
    const item = platinumItemParameters(dataset, metadata.profile, party ? mon.currentItemId : effectiveAiItem(mon, state));
    if (move.id === "judgment") return item.token.startsWith('HOLD_EFFECT_ARCEUS_') ? metadata.profile.constants.damageTypeBoostItems[item.token]?.toLowerCase() || "normal" : "normal";
    return platinumTypeToken(metadata.profile, item.naturalGiftType);
  }
  if (move.id === "weatherball") {
    const blocked = [...activeSlotEntries(state, "enemy"), ...activeSlotEntries(state, "player")].some(row => !state.combatantStates[row.combatantKey]?.abilitySuppressed && ["cloudnine", "airlock"].includes(toId(state.combatantStates[row.combatantKey]?.currentAbilityId)));
    const weather = blocked ? "" : toId(state.fieldState?.global?.weather?.id || state.fieldState?.global?.weather);
    if (party && !['sun', 'sunnyday', 'rain', 'raindance', 'sand', 'sandstorm', 'hail'].includes(weather)) {
      const raw = state.trainerAiBattleContextAddress;
      const numeric = Number.isInteger(raw) ? raw & 255 : metadata.hiddenStateValue('g4-party-weather-ball-type');
      return platinumTypeToken(metadata.profile, numeric);
    }
    return ({ sun: "fire", sunnyday: "fire", rain: "water", raindance: "water", sand: "rock", sandstorm: "rock", hail: "ice" })[weather] || "normal";
  }
  return toId(move.type);
}

// The source AI's type-check helpers do NOT apply Water Absorb / Flash Fire /
// Volt Absorb as ordinary damage immunities. ApplyTypeChart and CalcEffectiveness
// also differ for status moves, Magnet Rise, Foresight and Wonder Guard flags.
function platinumTypeFacts({ plan, state, dataset, attacker, defender, move, metadata, party = false, attackerIsParty = party, defenderIsParty = false }) {
  const type = platinumMoveType(plan, state, dataset, attacker, move, metadata, attackerIsParty);
  const attackerState = state.combatantStates[attacker.combatantKey];
  const defenderState = state.combatantStates[defender.combatantKey];
  const aa = attackerState.abilitySuppressed && !attackerIsParty ? "" : toId(attackerState.currentAbilityId);
  const da = defenderState.abilitySuppressed && !defenderIsParty ? "" : toId(defenderState.currentAbilityId);
  const volatile = defenderState.volatileConditions || {};
  const item = defenderIsParty ? toId(defenderState.currentItemId) : effectiveAiItem(defenderState, state);
  const gravity = Boolean(state.fieldState?.global?.gravityTurns || state.fieldState?.global?.gravity);
  let factorRows = [];
  for (const targetType of [...new Set(combatantTypes(plan, state, defender).map(toId))]) {
    const record = dataset.get("types", targetType);
    if (!record) throw new Error(`Missing source type ${targetType}`);
    if (!party && targetType === "flying" && defenderState.turnFlags?.roosting) continue;
    let factor = (record.immune || []).map(toId).includes(type) ? 0 : (record.weak || []).map(toId).includes(type) ? 2 : (record.resist || []).map(toId).includes(type) ? 0.5 : 1;
    if (factor === 0 && targetType === "flying" && (item === "ironball" || gravity || !party && volatile.ingrain)) factor = 1;
    if (factor === 0 && targetType === "ghost" && (aa === "scrappy" || !party && volatile.foresight)) factor = 1;
    if (factor === 0 && targetType === "dark" && !party && volatile.miracleEye) factor = 1;
    factorRows.push({ id: targetType, factor });
  }
  // Type chart applies weaknesses/resistances in its source table order, not in
  // the target's displayed type order. The per-attack rows are Dataset-owned.
  const order = metadata?.profile?.constants?.typeChartOrder?.[type];
  if (order) factorRows.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
  const factors = factorRows.map(row => row.factor);
  let multiplier = move.id === "struggle" ? 1 : factors.reduce((value, factor) => value * factor, 1);
  const sourcePower = Number(move.sourcePower ?? move.trainerAi?.basePower);
  let ineffective = false, superEffective = false, resisted = false;
  const levitated = move.id !== "struggle" && aa !== "moldbreaker" && da === "levitate" && type === "ground" && item !== "ironball" && !gravity;
  const magnetRise = !party && move.id !== "struggle" && type === "ground" && volatile.magnetRiseTurns && !volatile.ingrain && item !== "ironball";
  // Both source helpers update flags one type-table row at a time. Immunity
  // clears the basic flags, but a later weakness/resistance can set one again
  // without clearing INEFFECTIVE (the retail dual non-immunity bug).
  if (move.id !== "struggle" && !levitated && !magnetRise) for (const factor of factors) {
    if (factor === 0) {
      ineffective = true;
      resisted = false;
      superEffective = false;
    } else if (party || sourcePower > 0) {
      if (factor === 0.5) {
        if (superEffective) superEffective = false;
        else resisted = true;
      } else if (factor === 2) {
        if (resisted) resisted = false;
        else superEffective = true;
      }
    }
  }
  let immune = ineffective;
  if (levitated || magnetRise) { immune = true; multiplier = 0; ineffective = party && levitated; superEffective = false; resisted = false; }
  const charging = ["BATTLE_EFFECT_BIDE", "BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT", "BATTLE_EFFECT_CHARGE_TURN_HIGH_CRIT_FLINCH", "BATTLE_EFFECT_CHARGE_TURN_DEF_UP", "BATTLE_EFFECT_SKIP_CHARGE_TURN_IN_SUN", "BATTLE_EFFECT_FLY", "BATTLE_EFFECT_DIVE", "BATTLE_EFFECT_DIG", "BATTLE_EFFECT_BOUNCE", "BATTLE_EFFECT_FLINCH_BURN_HIT"].includes(move.trainerAi?.effectToken);
  if (move.id !== "struggle" && aa !== "moldbreaker" && da === "wonderguard" && !charging && !superEffective && (party || sourcePower > 0)) { immune = true; if (party) ineffective = true; }
  return { type, factors, multiplier, immune, ineffective, superEffective, resisted, neutral: !immune && !superEffective && !resisted };
}

function platinumApplyTypeDamage({ plan, state, dataset, actorEntry, targetEntry, move, metadata, damage }) {
  const facts = platinumTypeFacts({ plan, state, dataset, attacker: actorEntry, defender: targetEntry, move, metadata });
  const actor = state.combatantStates[actorEntry.combatantKey], target = state.combatantStates[targetEntry.combatantKey];
  const ability = actor.abilitySuppressed ? '' : toId(actor.currentAbilityId);
  const targetAbility = target.abilitySuppressed || ability === 'moldbreaker' ? '' : toId(target.currentAbilityId);
  if (move.id !== 'struggle') {
    if (combatantTypes(plan, state, actorEntry).map(toId).includes(facts.type)) damage = Math.trunc(damage * (ability === 'adaptability' ? 2 : 1.5));
    for (const factor of facts.factors) if (damage) damage = factor === 0 ? 0 : Math.max(1, Math.trunc(damage * factor));
    if (facts.superEffective) {
      if (['filter', 'solidrock'].includes(targetAbility) && damage) damage = Math.max(1, Math.trunc(damage * 3 / 4));
      const item = platinumItemParameters(dataset, metadata.profile, effectiveAiItem(actor, state));
      if (item.token === 'HOLD_EFFECT_POWER_UP_SE') damage = Math.trunc(damage * (100 + item.effectParam) / 100);
    }
    if (facts.resisted && ability === 'tintedlens') damage *= 2;
  }
  return { damage: facts.immune ? 0 : damage, facts };
}

// Bind PLC state to Dataset's source-level damage query. No damage formula lives here.
function platinumPreTypeDamage({ plan, state, dataset, actorEntry, targetEntry, move, metadata }) {
  const profile = metadata.profile;
  const all = [...activeSlotEntries(state, "player"), ...activeSlotEntries(state, "enemy")];
  const alive = entry => Number(state.combatantStates[entry.combatantKey]?.hp?.max ?? 0) > 0;
  const bindMon = entry => {
    const mon = state.combatantStates[entry.combatantKey];
    const combatant = plan.combatants[entry.combatantKey];
    const stats = { ...combatant.calculatedStats, ...mon.currentStats };
    const item = platinumItemParameters(dataset, profile, effectiveAiItem(mon, state));
    const volatile = mon.volatileConditions || {};
    return {
      ...Object.fromEntries(["atk", "def", "spa", "spd"].map(key => [key, stats[key]])),
      ...Object.fromEntries(["atk", "def", "spa", "spd"].map(key => [`${key}Stage`, Number(mon.statStages?.[key] || 0)])),
      level: mon.currentLevel ?? combatant.level, species: toId(mon.currentSpeciesId || combatant.speciesId),
      ability: mon.abilitySuppressed ? "" : toId(mon.currentAbilityId || combatant.abilityId),
      types: combatantTypes(plan, state, entry).map(toId), gender: combatant.gender,
      hp: entry.combatantKey === actorEntry.combatantKey && (!metadata.context?.state?.actor?.id || metadata.context.state.actor.id === entry.combatantKey) ? Number(metadata.context?.state?.actor?.hp ?? knownHp(mon)) : knownHp(mon),
      maxHp: Number(mon.hp.maxHp ?? mon.hp.max), hasStatus: !["", "none"].includes(gen5StatusId(mon)), burned: gen5StatusId(mon) === "burn",
      itemEffect: item.token, itemPower: item.effectParam, itemBoostType: profile.constants.damageTypeBoostItems[item.token] || null,
      charge: Boolean(volatile.charge), helpingHand: Boolean(mon.turnFlags?.helpingHand),
      slowStart: Number(state.turnNumber || 0) - Number(mon.enteredTurnNumber || 0) < 5,
      transformed: Boolean(volatile.transformed || mon.transformed), flashFire: Boolean(volatile.flashFire || mon.turnFlags?.flashFire)
    };
  };
  const attacker = bindMon(actorEntry), defender = bindMon(targetEntry);
  const global = state.fieldState?.global || {};
  const weather = all.some(entry => ["cloudnine", "airlock"].includes(bindMon(entry).ability)) ? "" : toId(global.weather?.id || global.weather);
  const sameSide = (entry, ref) => plan.combatants[entry.combatantKey].side === plan.combatants[ref.combatantKey].side;
  const countAbility = (ref, ability) => all.some(entry => sameSide(entry, ref) && alive(entry) && bindMon(entry).ability === ability);
  const side = state.fieldState?.sides?.[plan.combatants[targetEntry.combatantKey].side] || {};
  const sourceMove = profile.constants.moveTable.byNumericId[String(move.trainerAi?.numericId ?? numericRecordId(dataset, "moves", move.id))];
  if (!sourceMove) throw new Error(`Missing source move record ${move.id}`);
  const input = { attacker, defender, move: {
    id: move.id, power: move.resolvedAiPower || sourceMove.power, type: move.resolvedAiType || toId(move.type), category: ["physical", "special", "status"][sourceMove.class],
    punching: profile.constants.damagePunchingMoves.includes(move.id),
    halveDefense: sourceMove.effect === profile.constants.numericByToken.BATTLE_EFFECT_HALVE_DEFENSE,
    removeScreens: sourceMove.effect === profile.constants.numericByToken.BATTLE_EFFECT_REMOVE_SCREENS,
    range: sourceMove.range === profile.constants.numericByToken.RANGE_ADJACENT_OPPONENTS ? "adjacent-opponents" : sourceMove.range === profile.constants.numericByToken.RANGE_ALL_ADJACENT ? "all-adjacent" : "single"
  }, field: {
    powerMul: 10, frontier: false, doubles: plan.game.battleFormat === "doubles",
    sun: ["sun", "sunnyday"].includes(weather), rain: ["rain", "raindance"].includes(weather), sand: ["sand", "sandstorm"].includes(weather),
    solarDown: ["rain", "raindance", "sand", "sandstorm", "hail", "fog"].includes(weather),
    allyPlus: countAbility(actorEntry, "plus"), allyMinus: countAbility(actorEntry, "minus"), allyFlowerGift: countAbility(actorEntry, "flowergift"), foeFlowerGift: countAbility(targetEntry, "flowergift"),
    mudSport: all.some(entry => Boolean(state.combatantStates[entry.combatantKey]?.volatileConditions?.mudSport || state.combatantStates[entry.combatantKey]?.volatileConditions?.mudsport)),
    waterSport: all.some(entry => Boolean(state.combatantStates[entry.combatantKey]?.volatileConditions?.waterSport || state.combatantStates[entry.combatantKey]?.volatileConditions?.watersport)),
    reflect: Boolean(side.reflect || side.reflectTurns), lightScreen: Boolean(side.lightScreen || side.lightScreenTurns),
    defenderSideAlive: all.filter(entry => sameSide(entry, targetEntry) && alive(entry)).length,
    otherAlive: all.filter(entry => entry.combatantKey !== actorEntry.combatantKey && alive(entry)).length
  } };
  return metadata.evaluateQueryProgram("platinum-query-pre-type-damage", input);
}

// TrainerAI_CalcDamage is an AI estimate, deliberately distinct from normal
// move execution. Only its enumerated variable-power cases are substituted.
function platinumScoringDamage({ plan, state, dataset, actorEntry, targetEntry, parameterEntry, move, metadata, variance, ivs: suppliedIvs }) {
  const actor = plan.combatants[actorEntry.combatantKey], target = plan.combatants[targetEntry.combatantKey];
  const actorState = state.combatantStates[actorEntry.combatantKey], targetState = state.combatantStates[targetEntry.combatantKey];
  const parameters = plan.combatants[parameterEntry.combatantKey], parameterState = state.combatantStates[parameterEntry.combatantKey];
  const ivs = suppliedIvs || parameters.ivs;
  let power = 0, type = toId(move.type), fixed = 0;
  const level = Number(actorState.currentLevel ?? actor.level);
  const item = platinumItemParameters(dataset, metadata.profile, parameterState.currentItemId);
  // IfAnyPartyMemberDealsMoreDamage passes raw party ability and embargo=FALSE,
  // including the other active party slot. The damage battler stays the actor.
  const partyParameters = parameterEntry.combatantKey !== actorEntry.combatantKey;
  const parameterAbility = !partyParameters && parameterState.abilitySuppressed ? '' : toId(parameterState.currentAbilityId);
  const parameterEmbargo = !partyParameters && Number(parameterState.volatileConditions?.embargoTurns || 0) > 0;
  switch (move.id) {
    case 'naturalgift':
      if (parameterAbility !== 'klutz' && !parameterEmbargo) {
        power = item.naturalGiftPower;
        type = power ? platinumTypeToken(metadata.profile, item.naturalGiftType) : 'normal';
      }
      break;
    case 'judgment':
      if (parameterAbility !== 'klutz' && !parameterEmbargo) type = item.token.startsWith('HOLD_EFFECT_ARCEUS_') ? metadata.profile.constants.damageTypeBoostItems[item.token] || 'normal' : 'normal';
      break;
    case 'hiddenpower': {
      const keys = ['hp', 'atk', 'def', 'spe', 'spa', 'spd'];
      if (!ivs || keys.some(key => !Number.isInteger(ivs[key]))) throw new Error('AI Hidden Power requires six exact IVs');
      const bits = bit => keys.reduce((sum, key, index) => sum + (((ivs[key] >> bit) & 1) << index), 0);
      power = Math.trunc(bits(1) * 40 / 63) + 30;
      type = ['fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'][Math.trunc(bits(0) * 15 / 63)];
      break;
    }
    case 'gyroball': power = Math.min(150, 1 + Math.trunc(25 * platinumCachedSpeed({ plan, state, dataset, entry: targetEntry, metadata }) / platinumCachedSpeed({ plan, state, dataset, entry: actorEntry, metadata }))); break;
    case 'dragonrage': fixed = 40; break;
    case 'seismictoss': case 'nightshade': fixed = level; break;
    case 'psywave': fixed = Math.trunc(level * (metadata.drawRandom('g4-lcrng-output') % 11 + 5) / 10); break;
    case 'sonicboom': fixed = 20; break;
    case 'return': case 'frustration': {
      const friendship = actorState.friendship ?? actor.friendship;
      if (!Number.isInteger(friendship)) throw new Error('AI friendship-based power requires the source friendship value');
      power = Math.trunc((move.id === 'return' ? friendship : 255 - friendship) * 10 / 25); break;
    }
    case 'magnitude': {
      const draw = metadata.drawRandom('g4-lcrng-output') % 100;
      power = draw < 5 ? 10 : draw < 15 ? 30 : draw < 35 ? 50 : draw < 65 ? 70 : draw < 85 ? 90 : draw < 95 ? 110 : 150; break;
    }
    case 'lowkick': case 'grassknot': {
      const weight = targetState.aiWeight ?? Number(target.weightKg ?? dataset.get('species', targetState.currentSpeciesId || target.speciesId)?.weightKg) * 10;
      if (!Number.isFinite(weight)) throw new Error('AI weight-based power requires the exact current source weight');
      power = metadata.profile.constants.damageWeightToPower.find(row => row.maximumWeight >= weight)?.power ?? 120; break;
    }
  }
  const sourceMove = { ...move, resolvedAiPower: power, resolvedAiType: type };
  let damage = fixed || platinumPreTypeDamage({ plan, state, dataset, actorEntry, targetEntry, move: sourceMove, metadata });
  const facts = platinumTypeFacts({ plan, state, dataset, attacker: actorEntry, defender: targetEntry, move: sourceMove, metadata });
  if (!fixed && move.id !== 'struggle') {
    const ability = actorState.abilitySuppressed ? '' : toId(actorState.currentAbilityId);
    const targetAbility = targetState.abilitySuppressed || ability === 'moldbreaker' ? '' : toId(targetState.currentAbilityId);
    if (combatantTypes(plan, state, actorEntry).map(toId).includes(facts.type)) damage = Math.trunc(damage * (ability === 'adaptability' ? 2 : 1.5));
    for (const factor of facts.factors) if (damage) damage = factor === 0 ? 0 : Math.max(1, Math.trunc(damage * factor));
    if (facts.superEffective) {
      if (['filter', 'solidrock'].includes(targetAbility) && damage) damage = Math.max(1, Math.trunc(damage * 3 / 4));
      const held = platinumItemParameters(dataset, metadata.profile, effectiveAiItem(actorState, state));
      if (held.token === 'HOLD_EFFECT_POWER_UP_SE') damage = Math.trunc(damage * (100 + held.effectParam) / 100);
    }
    if (facts.resisted && ability === 'tintedlens') damage *= 2;
  }
  return facts.immune ? 0 : damage ? Math.max(1, Math.trunc(damage * variance / 100)) : 0;
}

function platinumSpeedFacts({ plan, state, dataset, entry, metadata, includePriority = true }) {
  const mon = state.combatantStates[entry.combatantKey], combatant = plan.combatants[entry.combatantKey];
  const ability = mon.abilitySuppressed ? '' : toId(mon.currentAbilityId);
  const item = platinumItemParameters(dataset, metadata.profile, effectiveAiItem(mon, state));
  let stage = Number(mon.statStages?.spe || 0);
  if (ability === 'simple') stage = Math.max(-6, Math.min(6, stage * 2));
  let speed = Math.trunc(Number(mon.calculatedStatOverrides?.spe ?? mon.currentStats?.spe ?? combatant.calculatedStats.spe) * Math.max(2, 2 + stage) / Math.max(2, 2 - stage)) >>> 0;
  const all = [...activeSlotEntries(state, 'player'), ...activeSlotEntries(state, 'enemy')];
  const weatherBlocked = all.some(row => !state.combatantStates[row.combatantKey].abilitySuppressed && ['cloudnine', 'airlock'].includes(toId(state.combatantStates[row.combatantKey].currentAbilityId)));
  const weather = weatherBlocked ? '' : toId(state.fieldState?.global?.weather?.id);
  if (ability === 'swiftswim' && weather === 'rain' || ability === 'chlorophyll' && weather === 'sun') speed = speed * 2 >>> 0;
  const rawItem = platinumItemParameters(dataset, metadata.profile, mon.currentItemId);
  if (metadata.profile.constants.speedHalvingItemEffects.includes(rawItem.token)) speed = Math.trunc(speed / 2);
  if (item.token === 'HOLD_EFFECT_CHOICE_SPEED') speed = Math.trunc(speed * 15 / 10) >>> 0;
  if (item.token === 'HOLD_EFFECT_DITTO_SPEED_UP' && toId(mon.currentSpeciesId || combatant.speciesId) === 'ditto') speed = speed * 2 >>> 0;
  if (ability === 'quickfeet' && gen5StatusId(mon) !== 'none') speed = Math.trunc(speed * 15 / 10) >>> 0;
  else if (gen5StatusId(mon) === 'paralysis') speed = Math.trunc(speed / 4);
  if (ability === 'slowstart' && Number(state.turnNumber || 0) - Number(mon.volatileConditions?.slowStartTurnNumber ?? mon.enteredTurnNumber ?? 0) < 5) speed = Math.trunc(speed / 2);
  if (ability === 'unburden' && mon.volatileConditions?.unburden && !mon.currentItemId) speed = speed * 2 >>> 0;
  if (state.fieldState?.sides?.[combatant.side]?.tailwindTurns) speed = speed * 2 >>> 0;
  let priority = false;
  if (includePriority && item.token === 'HOLD_EFFECT_SOMETIMES_PRIORITY') {
    const id = gen4BattlerId(combatant.side, entry.slot);
    const speedRand = mon.aiSpeedRand ?? metadata.context?.state?.random?.g4SpeedRand?.[id];
    priority = Number.isInteger(speedRand) ? speedRand % Math.trunc(100 / item.effectParam) === 0
      : metadata.hiddenStateValue(`g4-speed-rand-priority-${id}`);
  }
  if (item.token === 'HOLD_EFFECT_PINCH_PRIORITY') priority = knownHp(mon) <= Math.trunc(Number(mon.hp.maxHp) / (ability === 'gluttony' ? Math.trunc(item.effectParam / 2) : item.effectParam));
  return { speed, priority, lagging: item.token === 'HOLD_EFFECT_PRIORITY_DOWN', stall: ability === 'stall' };
}

function platinumCachedSpeed({ plan, state, dataset, entry, metadata }) {
  const key = `platinum.monSpeedValues.${gen4BattlerId(plan.combatants[entry.combatantKey].side, entry.slot)}`;
  const stored = metadata.readMemory(key);
  if (stored !== undefined) return stored;
  const observed = state.combatantStates[entry.combatantKey].aiSpeedValue;
  // ShowBattleMon sorts speed immediately before command selection. Reconstruct
  // the numeric cache, not its random ordering: Quick Claw cannot change speed.
  const value = observed ?? platinumSpeedFacts({ plan, state, dataset, entry, metadata, includePriority: false }).speed;
  metadata.writeMemory(key, value);
  return value;
}

function platinumCompareSpeed({ plan, state, dataset, first, second, metadata }) {
  const hp1 = knownHp(state.combatantStates[first.combatantKey]), hp2 = knownHp(state.combatantStates[second.combatantKey]);
  if (hp1 === 0 && hp2) return 1;
  if (hp1 && hp2 === 0) return 0;
  const a = platinumSpeedFacts({ plan, state, dataset, entry: first, metadata });
  const b = platinumSpeedFacts({ plan, state, dataset, entry: second, metadata });
  for (const [entry, facts] of [[first, a], [second, b]]) metadata.writeMemory(`platinum.monSpeedValues.${gen4BattlerId(plan.combatants[entry.combatantKey].side, entry.slot)}`, facts.speed);
  let reverse = false;
  if (a.priority || b.priority) {
    if (a.priority !== b.priority) return b.priority ? 1 : 0;
  } else if (a.lagging || b.lagging) {
    if (a.lagging !== b.lagging) return a.lagging ? 1 : 0;
    reverse = true;
  } else if (a.stall || b.stall) {
    if (a.stall !== b.stall) return a.stall ? 1 : 0;
    reverse = true;
  } else reverse = Boolean(state.fieldState?.global?.trickRoomTurns);
  if (a.speed === b.speed) return metadata.drawRandom('g4-lcrng-output') & 1 ? 2 : 0;
  return (reverse ? a.speed > b.speed : a.speed < b.speed) ? 1 : 0;
}

function platinumPostKoAction({ plan, state, dataset, actorEntry, metadata, alreadySelected = [] }) {
  const opponents = activeSlotEntries(state, "player").sort((a, b) => a.slot - b.slot);
  // RandomOpponent always draws in Doubles, even when only one opponent is alive.
  const index = plan.game.battleFormat === "doubles" ? metadata.drawRandom("g4-switch-draw") & 1 : 0;
  let targetEntry = opponents[index];
  if (!targetEntry || Number(state.combatantStates[targetEntry.combatantKey]?.hp?.max ?? 0) <= 0) targetEntry = opponents[index ^ 1];
  const reserves = platinumReserves(plan, state, actorEntry, alreadySelected);
  if (!reserves.length) return { status: 'exact', action: { type: 'no-replacement', reason: 'party-exhausted' } };
  if (!targetEntry) return { status: "unavailable", action: undefined, reason: "No living opponent is available for the post-KO selector." };
  const result = (partySlot, reason) => ({ status: "exact", action: { type: "switch", partySlot, reason } });
  let score; // Deliberately survives the stage-one loop and skipped move slots.
  const disregarded = new Set();
  while (true) {
    let best = null, maximum = 0;
    for (const reserve of reserves) {
      if (disregarded.has(reserve.partySlot)) continue;
      const types = combatantTypes(plan, state, { combatantKey: reserve.combatant.combatantKey });
      score = (40 * typeOnlyMultiplier(plan, state, dataset, { type: types[0] }, targetEntry)
        + 40 * typeOnlyMultiplier(plan, state, dataset, { type: types[1] || types[0] }, targetEntry)) & 255;
      if (score > maximum) { maximum = score; best = reserve; }
    }
    if (!best) break;
    const entry = { combatantKey: best.combatant.combatantKey, slot: best.partySlot };
    if (platinumMoves(plan, state, dataset, entry.combatantKey).some(move => platinumTypeFacts({ plan, state, dataset, attacker: entry, defender: targetEntry, move, metadata, party: true }).superEffective)) return result(best.partySlot, "post-ko-stage-one");
    disregarded.add(best.partySlot);
  }
  let maximum = 0, picked = null;
  for (const reserve of reserves) {
    const entry = { combatantKey: reserve.combatant.combatantKey, slot: reserve.partySlot };
    const moves = platinumMoves(plan, state, dataset, entry.combatantKey);
    for (let slot = 0; slot < 4; slot += 1) {
      const move = moves[slot];
      if (move && move.sourcePower !== 1) {
        score = platinumPreTypeDamage({ plan, state, dataset, actorEntry, targetEntry, move, metadata }) & 255;
        // Variable type comes from the reserve; stats, ability, STAB and held-item
        // modifiers still come from the outgoing battler, exactly as the source.
        const resolvedType = platinumMoveType(plan, state, dataset, entry, move, metadata, true);
        const typedMove = { ...move, resolvedAiType: resolvedType };
        const facts = platinumTypeFacts({ plan, state, dataset, attacker: actorEntry, defender: targetEntry, move: typedMove, metadata });
        const actor = state.combatantStates[actorEntry.combatantKey];
        const target = state.combatantStates[targetEntry.combatantKey];
        const ability = actor.abilitySuppressed ? "" : toId(actor.currentAbilityId);
        const targetAbility = target.abilitySuppressed || ability === "moldbreaker" ? "" : toId(target.currentAbilityId);
        if (move.id !== "struggle") {
          if (combatantTypes(plan, state, actorEntry).map(toId).includes(facts.type)) score = Math.trunc(score * (ability === "adaptability" ? 2 : 1.5));
          for (const factor of facts.factors) if (score) score = factor === 0 ? 0 : Math.max(1, Math.trunc(score * factor));
          if (facts.superEffective) {
            if (["filter", "solidrock"].includes(targetAbility) && score) score = Math.max(1, Math.trunc(score * 3 / 4));
            const item = platinumItemParameters(dataset, metadata.profile, effectiveAiItem(actor, state));
            if (item.token === "HOLD_EFFECT_POWER_UP_SE") score = Math.trunc(score * (100 + item.effectParam) / 100);
          }
          if (facts.resisted && ability === "tintedlens") score *= 2;
        }
        score &= 255;
        if (facts.immune) score = 0;
      }
      if (score > maximum) { maximum = score; picked = reserve.partySlot; }
    }
  }
  // Both source callers replace the sentinel with the first legal party member.
  return result(picked ?? reserves[0].partySlot, picked === null ? "post-ko-party-order-fallback" : "post-ko-stage-two");
}

function platinumVoluntarySwitchAction({ plan, state, dataset, actorEntry, metadata, alreadySelected = [] }) {
  const actorState = state.combatantStates[actorEntry.combatantKey];
  const actorCombatant = plan.combatants[actorEntry.combatantKey];
  if (!actorState || !actorCombatant) return { status: "unavailable", action: undefined };
  const volatile = actorState.volatileConditions || {};
  // Retail TrainerAI_ShouldSwitch (pinned trainer_ai.c:3902-3912) deliberately
  // uses a naive gate: no Flying/Shadow Tag/Shed Shell escape exceptions. Keep
  // that AI bug separate from the actual legality helper used for Gen 5.
  const ability = entry => {
    const mon = state.combatantStates[entry.combatantKey];
    return mon?.abilitySuppressed ? "" : toId(mon?.currentAbilityId);
  };
  const opponents = activeSlotEntries(state, "player");
  const others = [...opponents, ...activeSlotEntries(state, "enemy")].filter(entry => entry.combatantKey !== actorEntry.combatantKey);
  if (volatile.trapped || volatile.trappedBy || volatile.meanlook || volatile.blocked
    || volatile.partiallytrapped || Number(volatile.partiallyTrappedTurns || 0) > 0 || volatile.ingrain
    || opponents.some(entry => ["shadowtag", "arenatrap"].includes(ability(entry)))
    || others.some(entry => ability(entry) === "magnetpull") && combatantTypes(plan, state, actorEntry).some(type => toId(type) === "steel")) {
    return { status: "exact", action: null };
  }
  const reserves = platinumReserves(plan, state, actorEntry, alreadySelected);
  if (!reserves.length) return { status: "exact", action: null };
  const finalPerishTurn = volatile.perishSongTurns !== undefined
    ? Number(volatile.perishSongTurns) === 0
    : volatile.perishTurns !== undefined && Number(volatile.perishTurns) === 1;
  if ((volatile.perishSong || volatile.perishSongTurns !== undefined || volatile.perishTurns !== undefined) && finalPerishTurn) {
    return platinumPostKoAction({ plan, state, dataset, actorEntry, metadata, alreadySelected });
  }
  const draw = () => metadata.drawRandom("g4-switch-draw");
  const stay = { status: "exact", action: null };
  const choose = (partySlot, reason) => ({ status: "exact", action: { type: "switch", partySlot, reason } });
  const targets = [...opponents].sort((a, b) => a.slot - b.slot);
  const alive = target => Number(state.combatantStates[target.combatantKey]?.hp?.max ?? 0) > 0;
  const actorMoves = platinumMoves(plan, state, dataset, actorEntry.combatantKey);
  const facts = (attacker, defender, move, party = false) => platinumTypeFacts({ plan, state, dataset, attacker, defender, move, metadata, party });
  const reserveFacts = reserves.map(row => ({ ...row, entry: { combatantKey: row.combatant.combatantKey, slot: row.partySlot }, moves: platinumMoves(plan, state, dataset, row.combatant.combatantKey) }));
  const doubledTargets = plan.game.battleFormat === "singles" ? [targets[0], targets[0]] : targets;
  const superTargets = [...targets].sort((a, b) => Number(b.slot === actorEntry.slot) - Number(a.slot === actorEntry.slot));
  const hasSuper = force => {
    for (const target of superTargets) {
      if (state.combatantStates[target.combatantKey]?.turnFlags?.switching) continue;
      for (const move of actorMoves) if (facts(actorEntry, target, move).superEffective && (force || draw() % 10 !== 0)) return true;
    }
    return false;
  };
  // Wonder Guard is a Singles-only routine; each qualifying move gets its own
  // modulo-3 draw, even when an earlier move on the same reserve failed its draw.
  if (plan.game.battleFormat === "singles" && toId(state.combatantStates[targets[0].combatantKey].currentAbilityId) === "wonderguard"
      && !actorMoves.some(move => facts(actorEntry, targets[0], move).superEffective)) {
    for (const row of reserveFacts) for (const move of row.moves) if (facts(row.entry, targets[0], move, true).superEffective && draw() % 3 < 2) return choose(row.partySlot, "wonder-guard-counter");
  }
  // In Singles the source checks the same defender twice. A failed first draw
  // is followed by a fresh second draw, not one combined nominal probability.
  const attacking = actorMoves.filter(move => move.sourcePower !== 0);
  if (attacking.length >= 2 && attacking.every(move => doubledTargets.every(target => alive(target) && facts(actorEntry, target, move).ineffective))) {
    for (const stage of ["super", "neutral"]) for (const row of reserveFacts) for (const move of row.moves.filter(move => move.sourcePower !== 0)) for (const target of doubledTargets) {
      const effect = alive(target) ? facts(row.entry, target, move, true) : { superEffective: false, neutral: true };
      if (stage === "super" ? effect.superEffective && draw() % 3 < 2 : effect.neutral && draw() % 2 === 0) return choose(row.partySlot, `only-ineffective-${stage}`);
    }
  }
  const lastSourceKey = actorState.lastHitSourceKey;
  const lastMoveId = actorState.lastHitMoveId;
  const lastMove = lastMoveId ? { id: lastMoveId, ...dataset.get("moves", lastMoveId) } : null;
  const absorbByType = { fire: "flashfire", water: "waterabsorb", electric: "voltabsorb" };
  if (!(hasSuper(true) && draw() % 3 !== 0) && lastMove && lastMove.trainerAi?.basePower !== 0) {
    const absorb = absorbByType[toId(lastMove.type)];
    if (absorb && ability(actorEntry) !== absorb) for (const row of reserveFacts) {
      if (toId(state.combatantStates[row.entry.combatantKey].currentAbilityId) === absorb && (draw() & 1)) return choose(row.partySlot, "absorb-last-hit");
    }
  }
  const counter = (desired, modulo) => {
    if (!lastMove || lastMove.trainerAi?.basePower === 0 || !lastSourceKey) return null;
    const sourceEntry = { combatantKey: lastSourceKey, slot: targets.find(row => row.combatantKey === lastSourceKey)?.slot };
    for (const row of reserveFacts) {
      const incoming = platinumTypeFacts({ plan, state, dataset, attacker: sourceEntry, defender: row.entry, move: lastMove, metadata, party: true, attackerIsParty: false, defenderIsParty: true });
      if (!(desired === "immune" ? incoming.immune : incoming.resisted)) continue;
      for (const move of row.moves) if (facts(row.entry, sourceEntry, move, true).superEffective && draw() % modulo === 0) return choose(row.partySlot, `last-hit-${desired}-counter`);
    }
    return null;
  };
  const currentHp = knownHp(actorState);
  const maximumHp = Number(actorState.hp?.maxHp ?? actorState.hp?.max);
  if (ability(actorEntry) === "naturalcure" && gen5StatusId(actorState) === "sleep"
    && currentHp !== null && Number.isFinite(maximumHp) && currentHp >= Math.floor(maximumHp / 2)) {
    const replacement = () => platinumPostKoAction({ plan, state, dataset, actorEntry, metadata, alreadySelected });
    if (!lastMove && (draw() & 1)) return replacement();
    if ((!lastMove || lastMove.trainerAi?.basePower === 0) && (draw() & 1)) return replacement();
    // The source passes 1 (not 2): a qualifying counter always succeeds but
    // still consumes the RNG draw. Preserve this code/comment discrepancy.
    const selected = counter("immune", 1) || counter("resisted", 1);
    if (selected) return selected;
    if (draw() & 1) return replacement();
  }
  if (hasSuper(false)) return stay;
  const positiveBoosts = Object.values(actorState.statStages || {}).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
  if (positiveBoosts >= 4) return stay;
  return counter("immune", 2) || counter("resisted", 3) || stay;
}

function platinumValidMoves({ plan, state, dataset, actorEntry, profile }) {
  const mon = state.combatantStates[actorEntry.combatantKey], volatile = mon.volatileConditions || {};
  const sourceMoves = mon.moveSetOverride || plan.combatants[actorEntry.combatantKey].moves;
  const choice = ['choiceband', 'choicescarf', 'choicespecs'].includes(effectiveAiItem(mon, state)) && sourceMoves.some(move => move.moveId === volatile.choiceLockedMoveId) ? volatile.choiceLockedMoveId : null;
  return sourceMoves.filter((move, slot) => {
    if (Number.isInteger(mon.trainerAiInvalidMoveMask)) return !(mon.trainerAiInvalidMoveMask & (1 << slot));
    const source = dataset.get('moves', move.moveId)?.trainerAi;
    if (!source) throw new Error(`Missing Gen 4 numeric move authority for ${move.moveId}`);
    if (Number(mon.movePp?.[move.moveId] ?? move.maxPp) === 0 || move.moveId === volatile.disabledMoveId) return false;
    if (volatile.torment && move.moveId === mon.lastMoveId || volatile.tauntTurns && source.basePower === 0) return false;
    if (volatile.encoredMoveId && move.moveId !== volatile.encoredMoveId || choice && move.moveId !== choice) return false;
    if (state.fieldState?.global?.gravityTurns && profile.constants.invalidMoveLists.sMovesAffectedByGravity.includes(source.numericId)) return false;
    if (volatile.healBlockTurns && profile.constants.invalidMoveLists.sMovesAffectedByHealBlock.includes(source.numericId)) return false;
    if (activeSlotEntries(state, 'player').some(entry => {
      const other = state.combatantStates[entry.combatantKey];
      return knownHp(other) > 0 && other.volatileConditions?.imprison && (other.moveSetOverride || plan.combatants[entry.combatantKey].moves).some(known => known.moveId === move.moveId);
    })) return false;
    return true;
  });
}

function platinumForcedAction({ plan, state, dataset, actorEntry, metadata, phase }) {
  const mon = state.combatantStates[actorEntry.combatantKey], volatile = mon.volatileConditions || {};
  let moveId = null, reason;
  if (phase === 'forced-controller') {
    if (volatile.rechargeRequired) return { status: 'exact', action: { type: 'recharge', actorId: actorEntry.combatantKey, forced: true } };
    moveId = volatile.chargingMoveId || (volatile.bideTurns > 0 ? 'bide' : volatile.uproarTurns > 0 ? 'uproar' : null) || volatile.thrashMoveId || volatile.moveLockedInto;
    reason = 'An ongoing multi-turn move bypasses trainer switching, items and incentive scoring.';
  } else {
    if (!platinumValidMoves({ plan, state, dataset, actorEntry, profile: metadata.profile }).length) moveId = 'struggle';
    else moveId = volatile.encoredMoveId || null;
    reason = moveId === 'struggle' ? 'All four move slots are invalid, so Fight becomes Struggle after the switch and item checks.' : 'Encore fixes the move after the switch and item checks; move scoring is not run.';
  }
  if (!moveId) return { status: 'exact', action: null };
  const source = dataset.get('moves', moveId)?.trainerAi;
  if (!source) return { status: 'unavailable', action: undefined };
  // Command prediction ends before FightCommand resolves its execution target.
  // Do not consume that later RNG here: other actors still have to select.
  return { status: 'exact', action: { type: 'move', actorId: actorEntry.combatantKey, canonicalMoveId: moveId, moveId: source.numericId, forced: true, target: null, targetSelection: { timing: 'execution', sourceRoutine: 'BattleSystem_Defender', randomize: phase === 'forced-fight' }, explanation: reason } };
}

function platinumTrainerItemAction({ plan, state, dataset, actorEntry, profile }) {
  const actorState = state.combatantStates[actorEntry.combatantKey];
  if (!actorState || !profile?.trainerItemUse?.byNumericId) return { status: "unavailable", action: undefined };
  const scan = profile.trainerItemUse.scan;
  if (!scan || ![0, 1].includes(scan.laterSlotEligibilityOffset)
    || typeof scan.loopBreaksAfterUsable !== 'boolean' || scan.slots !== 4
    || scan.slot0AlwaysExamined !== true) return { status: "unavailable", action: undefined };
  if (actorState.volatileConditions?.embargo || Number(actorState.volatileConditions?.embargoTurns || 0) > 0) return { status: "exact", action: null };
  const battleProfile = trainerProfile(plan, dataset, actorEntry).battleProfile;
  const storedBag = state.trainerAi?.g4Bags?.[actorEntry.slot];
  const bag = storedBag?.slots || (battleProfile?.bagItemIds || []).filter(Boolean);
  const numericBag = bag.map(itemId => Number.isInteger(itemId) ? itemId : numericRecordId(dataset, "items", itemId));
  const initialCount = storedBag?.initialCount ?? numericBag.length;
  if (numericBag.some(value => !Number.isInteger(value))) return { status: "unavailable", action: undefined };
  const alive = actorParty(plan, actorEntry).filter(combatant => Number(state.combatantStates[combatant.combatantKey]?.hp?.max ?? 0) > 0).length;
  const currentHp = knownHp(actorState);
  const maximumHp = Number(actorState.hp?.maxHp ?? actorState.hp?.max);
  if (currentHp === null || !Number.isFinite(maximumHp)) return { status: "unavailable", action: undefined };
  const status = gen5StatusId(actorState);
  const confused = Boolean(actorState.volatileConditions?.confusion || actorState.volatileConditions?.confusionTurns || actorState.volatileConditions?.confusionCounterDistribution?.length);
  const firstTurn = Number(actorState.enteredTurnNumber ?? 0) >= Number(state.turnNumber || 0);
  const mist = Number(state.fieldState?.sides?.enemy?.mistTurns || 0) > 0;
  let result = false;
  let selected = null;
  let usedItemType = null, usedItemCondition = 0;
  const consumedBagSlots = [];
  for (let index = 0; index < Math.min(4, numericBag.length); index += 1) {
    if (index !== 0 && alive > initialCount - index + scan.laterSlotEligibilityOffset) continue;
    const numericId = numericBag[index];
    if (numericId === 0) continue;
    const item = profile.trainerItemUse.byNumericId[String(numericId)];
    if (!item?.executable) return { status: "unavailable", action: undefined };
    const decision = item.trainerAiDecision || {};
    let usable = false;
    if (item.classification === "full-restore") usable = currentHp > 0 && currentHp < Math.floor(maximumHp / 4);
    else if (item.classification === "fixed-hp-restore") usable = currentHp > 0
      && (currentHp < Math.floor(maximumHp / 4) || maximumHp - currentHp > Number(decision.healing?.amount || 0));
    else if (item.classification === "status-cure") {
      const tested = decision.testedStatus;
      usable = tested === "confusion" ? confused : tested === "poison" ? ["poison", "toxic"].includes(status) : status === tested;
    } else if (item.classification === "stat-raise") usable = firstTurn;
    else if (item.classification === "guard-spec") usable = firstTurn && !mist;
    if (usable) {
      result = true;
      usedItemType = item.classification;
      if (item.classification === 'status-cure') usedItemCondition |= ({ sleep: 32, poison: 16, burn: 8, freeze: 4, paralysis: 2, confusion: 1 })[decision.testedStatus] || 0;
      if (item.classification === 'stat-raise') {
        const token = { attack: 'BATTLE_STAT_ATTACK', defense: 'BATTLE_STAT_DEFENSE', speed: 'BATTLE_STAT_SPEED', 'special-attack': 'BATTLE_STAT_SP_ATTACK', 'special-defense': 'BATTLE_STAT_SP_DEFENSE', accuracy: 'BATTLE_STAT_ACCURACY' }[decision.raisedStat];
        usedItemCondition = profile.constants.numericByToken[token];
        if (!Number.isInteger(usedItemCondition)) throw new Error('Missing source trainer item stat constant');
      }
    } else if (!firstTurn && !['full-restore', 'fixed-hp-restore', 'status-cure'].includes(item.classification)) usedItemType = 'unrecognized';
    if (result) {
      selected = { numericId, item, bagSlot: index };
      consumedBagSlots.push(index);
      if (scan.loopBreaksAfterUsable) break;
    }
  }
  return result && selected
    ? { status: "exact", action: { type: "item", itemId: selected.numericId, itemToken: dataset.getBySaveNumericId("items", selected.numericId)?.id || selected.item.itemId, bagSlot: selected.bagSlot, target: actorEntry.combatantKey, bagOwner: actorEntry.slot, consumedBagSlots, initialBagCount: initialCount, usedItemType, usedItemCondition } }
    : { status: "exact", action: null };
}

function combatantMoveDescriptors(plan, state, dataset, combatantKey) {
  const combatant = plan.combatants[combatantKey];
  const monState = state.combatantStates[combatantKey];
  if (!combatant || !monState) return [];
  return (monState.moveSetOverride || combatant.moves || []).filter(move => Number(monState.movePp?.[move.moveId] ?? move.maxPp) > 0)
    .map(move => ({ id: move.moveId, ...dataset.get("moves", move.moveId) }));
}

function gen5ReplacementCandidates({ plan, state, dataset, actorEntry, targetEntry, alreadySelected = [] }) {
  const active = new Set(activeSlotEntries(state, "enemy").map(entry => entry.combatantKey));
  const excluded = new Set(alreadySelected);
  return actorParty(plan, actorEntry)
    .map((combatant, index) => ({ combatant, partySlot: trainerPartyOrder(combatant, index) }))
    .filter(({ combatant, partySlot }) => !active.has(combatant.combatantKey) && !excluded.has(partySlot)
      && Number(state.combatantStates[combatant.combatantKey]?.hp?.max ?? 0) > 0)
    .map(({ combatant, partySlot }) => {
      const moveDescriptors = combatantMoveDescriptors(plan, state, dataset, combatant.combatantKey);
      const damageCategoriesComplete = moveDescriptors.every(move => moveDamageClassification(move) !== "unknown");
      const moves = moveDescriptors.filter(isDamagingMove);
      const scoredMoves = moves.map(move => {
        const multiplier = typeOnlyMultiplier(plan, state, dataset, move, targetEntry);
        if (multiplier === undefined) return undefined;
        const basePower = Number(move.basePower) < 10 ? 60 : Number(move.basePower);
        return { moveId: move.id, score: Math.trunc(basePower * multiplier) };
      });
      const scores = scoredMoves.map(row => row?.score);
      const score = scores.some(value => value === undefined) ? null : Math.max(0, ...scores);
      return {
        partySlot,
        partyOrder: partySlot,
        combatantKey: combatant.combatantKey,
        legal: damageCategoriesComplete && scores.every(score => score !== undefined),
        score,
        highestDamageMoveIds: score === null ? [] : scoredMoves.filter(row => row.score === score).map(row => row.moveId),
        hasSuperEffectiveMove: moves.some(move => typeOnlyMultiplier(plan, state, dataset, move, targetEntry) > 1),
        hasNeutralMove: moves.some(move => typeOnlyMultiplier(plan, state, dataset, move, targetEntry) === 1)
      };
    });
}

function firstBestPartySlot(candidates, predicate = () => true) {
  const eligible = candidates.filter(candidate => candidate.legal && Number.isFinite(Number(candidate.score)) && predicate(candidate));
  if (!eligible.length) return null;
  const best = Math.max(...eligible.map(candidate => Number(candidate.score)));
  return eligible.filter(candidate => Number(candidate.score) === best).sort((left, right) => left.partyOrder - right.partyOrder)[0].partySlot;
}

function gen5SwitchContext({ plan, state, dataset, actorEntry, alreadySelected = [] }) {
  const format = plan.game.battleFormat;
  const actorState = state.combatantStates[actorEntry.combatantKey];
  const actorCombatant = plan.combatants[actorEntry.combatantKey];
  if (!actorState || !actorCombatant) return { complete: false, reason: "actor state is unavailable" };
  const volatiles = actorState.volatileConditions || {};
  if (aiSwitchBlocked(plan, state, actorEntry)) return { complete: true, canSwitch: false, targets: [] };
  const targets = activeSlotEntries(state, "player").filter(entry => {
    if (format === "rotation") return entry.slot === rotationFrontSlot(state, "player");
    if (format === "triples") return areSlotsAdjacent(plan, "enemy", actorEntry.slot, "player", entry.slot);
    return true;
  });
  const actorMoveDescriptors = combatantMoveDescriptors(plan, state, dataset, actorEntry.combatantKey);
  const actorDamageCategoriesComplete = actorMoveDescriptors.every(move => moveDamageClassification(move) !== "unknown");
  const actorMoves = actorMoveDescriptors.filter(isDamagingMove);
  const status = gen5StatusId(actorState);
  const stageTotal = Object.values(actorState.statStages || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const lastSourceKey = actorState.turnFlags?.lastDamageSourceKey;
  const lastMoveId = lastSourceKey ? state.combatantStates[lastSourceKey]?.lastMoveId : null;
  const lastMove = lastMoveId ? { id: lastMoveId, ...dataset.get("moves", lastMoveId) } : null;
  const normalizedTargets = targets.map(targetEntry => {
      const reserves = gen5ReplacementCandidates({ plan, state, dataset, actorEntry, targetEntry, alreadySelected });
      const standard = firstBestPartySlot(reserves);
      const actorHasSuperEffectiveMove = actorMoves.some(move => typeOnlyMultiplier(plan, state, dataset, move, targetEntry) > 1);
      const actorDamagingMultipliers = actorMoves.map(move => typeOnlyMultiplier(plan, state, dataset, move, targetEntry));
      if (!actorDamageCategoriesComplete || reserves.some(candidate => !candidate.legal) || actorDamagingMultipliers.some(value => value === undefined)) {
        return { id: targetEntry.combatantKey, complete: false, triggers: [] };
      }
      const targetAbility = toId(state.combatantStates[targetEntry.combatantKey]?.currentAbilityId);
      const noEffectiveMoves = actorMoves.length >= 2 && actorDamagingMultipliers.every(value => value === 0);
      const lockedMoveId = actorState.volatileConditions?.choiceLockedMoveId;
      const lockedMove = lockedMoveId ? { id: lockedMoveId, ...dataset.get("moves", lockedMoveId) } : null;
      const choiceItem = ["choiceband", "choicespecs", "choicescarf"].includes(effectiveAiItem(actorState, state));
      const choiceLocked = choiceItem && lockedMove;
      const lockedMoveClassification = choiceLocked ? moveDamageClassification(lockedMove) : null;
      if (lockedMoveClassification === "unknown") return { id: targetEntry.combatantKey, complete: false, triggers: [] };
      const lockedMultiplier = choiceLocked && lockedMoveClassification === "damaging"
        ? typeOnlyMultiplier(plan, state, dataset, lockedMove, targetEntry)
        : null;
      const reserveSuper = reserves.filter(candidate => candidate.hasSuperEffectiveMove);
      const reserveNeutral = reserves.filter(candidate => candidate.hasNeutralMove);
      const absorbMap = {
        water: new Set(["waterabsorb", "stormdrain", "dryskin"]),
        electric: new Set(["voltabsorb", "motordrive", "lightningrod"]),
        grass: new Set(["overgrow"]),
        fire: new Set(["flashfire"])
      };
      const absorbCandidates = lastMove ? reserves.filter(candidate => {
        const ability = toId(state.combatantStates[candidate.combatantKey]?.currentAbilityId);
        return absorbMap[toId(lastMove.type)]?.has(ability);
      }) : [];
      const naturalCureCandidates = lastMove ? reserves.filter(candidate => {
        const entry = { combatantKey: candidate.combatantKey, slot: candidate.partySlot };
        return typeOnlyMultiplier(plan, state, dataset, lastMove, entry) < 1;
      }) : [];
      const defensiveCandidates = lastMove ? reserveSuper.map(candidate => {
        const entry = { combatantKey: candidate.combatantKey, slot: candidate.partySlot };
        return { ...candidate, lastMoveMultiplier: typeOnlyMultiplier(plan, state, dataset, lastMove, entry) };
      }).filter(candidate => candidate.lastMoveMultiplier < 1) : [];
      return {
        id: targetEntry.combatantKey,
        position: targetEntry.slot,
        triggers: [
          { id: "perish-song", applicable: Number(volatiles.perishTurns ?? volatiles.perishSongTurns) === 1 && standard !== null, partySlot: standard, switchProbability: { numerator: 1, denominator: 1 } },
          { id: "wonder-guard", applicable: format === "singles" && targetAbility === "wonderguard" && !actorHasSuperEffectiveMove && reserveSuper.length > 0 && standard !== null, partySlot: standard, switchProbability: { numerator: 2, denominator: 3 } },
          { id: "no-effective-moves-super-effective", applicable: noEffectiveMoves && reserveSuper.length > 0, partySlot: firstBestPartySlot(reserveSuper), switchProbability: { numerator: 2, denominator: 3 } },
          { id: "no-effective-moves-neutral", applicable: noEffectiveMoves && reserveSuper.length === 0 && reserveNeutral.length > 0, partySlot: firstBestPartySlot(reserveNeutral), switchProbability: { numerator: 1, denominator: 2 } },
          { id: "choice-lock-status", applicable: Boolean(choiceLocked) && lockedMoveClassification === "status" && standard !== null, partySlot: standard, switchProbability: { numerator: 1, denominator: 2 } },
          { id: "choice-lock-immune-super-effective", applicable: Boolean(choiceLocked) && lockedMultiplier === 0 && reserveSuper.length > 0, partySlot: firstBestPartySlot(reserveSuper), switchProbability: { numerator: 2, denominator: 3 } },
          { id: "choice-lock-immune-neutral", applicable: Boolean(choiceLocked) && lockedMultiplier === 0 && reserveSuper.length === 0 && reserveNeutral.length > 0, partySlot: firstBestPartySlot(reserveNeutral), switchProbability: { numerator: 1, denominator: 2 } },
          {
            id: "type-immunity-ability",
            applicable: absorbCandidates.length > 0,
            gateProbability: actorHasSuperEffectiveMove ? { numerator: 1, denominator: 3 } : { numerator: 1, denominator: 1 },
            attempts: absorbCandidates.sort((a, b) => a.partyOrder - b.partyOrder).map(candidate => ({ partySlot: candidate.partySlot, probability: { numerator: 1, denominator: 2 } }))
          },
          {
            id: "natural-cure",
            applicable: toId(actorState.currentAbilityId) === "naturalcure" && ["sleep", "freeze"].includes(status)
              && Number(actorState.hp?.max ?? 0) * 2 >= Number(actorState.hp?.maxHp ?? actorState.hp?.max ?? 0) && naturalCureCandidates.length > 0,
            partySlot: naturalCureCandidates.sort((a, b) => a.partyOrder - b.partyOrder)[0]?.partySlot,
            switchProbability: { numerator: 1, denominator: 1 }
          },
          {
            id: "type-effectiveness",
            applicable: Boolean(actorState.turnFlags?.wasDamaged) && stageTotal < -38 && defensiveCandidates.length > 0,
            gateProbability: actorHasSuperEffectiveMove ? { numerator: 1, denominator: 10 } : { numerator: 1, denominator: 1 },
            attempts: defensiveCandidates.sort((a, b) => a.partyOrder - b.partyOrder).map(candidate => ({
              partySlot: candidate.partySlot,
              probability: candidate.lastMoveMultiplier === 0 ? { numerator: 1, denominator: 2 } : { numerator: 1, denominator: 3 }
            }))
          }
        ]
      };
    });
  return {
    complete: normalizedTargets.every(target => target.complete !== false),
    canSwitch: true,
    targets: normalizedTargets
  };
}

function gen5ReplacementContext({ plan, state, dataset, actorEntry, alreadySelected = [] }) {
  const targets = activeSlotEntries(state, "player").filter(entry => {
    if (Number(state.combatantStates[entry.combatantKey]?.hp?.max ?? 0) <= 0) return false;
    if (plan.game.battleFormat === "rotation") return entry.slot === rotationFrontSlot(state, "player");
    if (plan.game.battleFormat === "triples") return areSlotsAdjacent(plan, "enemy", actorEntry.slot, "player", entry.slot);
    return true;
  });
  return {
    complete: true,
    targets: targets.map(targetEntry => ({
      id: targetEntry.combatantKey,
      position: targetEntry.slot,
      candidates: gen5ReplacementCandidates({ plan, state, dataset, actorEntry, targetEntry, alreadySelected })
    }))
  };
}

function gen5FullActionEvaluation({ plan, state, dataset, ai, actorEntry, moveActorEntry, moves, flagIds, battleProfile, evaluator, damageAdapter, alreadySelectedSwitches = [], trainerBagSlots = null, itemActivePokemon = null, requestIdSuffix = "" }) {
  const engine = evaluator || globalThis.TrainerAiEvaluator;
  const profile = ai.evaluatorProfile;
  if ((!engine?.forecast && !engine?.evaluate) || !profile) return null;
  const actor = normalizedActor(plan, state, actorEntry);
  const moveActor = moveActorEntry || actorEntry;
  const candidates = moves.flatMap(move => evaluatorMoveTargetEntries(plan, state, moveActor, move, dataset).map(target => ({
    id: `${moveActor.combatantKey}:${move.moveId}:${target.combatantKey}`,
    initialScore: Number(profile.numericModel?.initialScore ?? 100),
    aiEffectId: dataset.get("moves", move.moveId)?.aiEffectId,
    action: {
      type: "move",
      moveId: move.moveId,
      canonicalMoveId: move.moveId,
      actorId: moveActor.combatantKey,
      target: target.combatantKey,
      targetCombatantKey: target.combatantKey,
      targetSlot: target.slot
    }
  })));
  const aiParty = actorParty(plan, actorEntry)
    .map((combatant, index) => normalizedPartyMember(plan, state, combatant, index));
  const opponentParty = Object.values(plan.combatants).filter(combatant => combatant.side === "player")
    .map((combatant, index) => normalizedPartyMember(plan, state, combatant, index));
  const activePokemon = activeSlotEntries(state, "enemy").filter(entry => !plan.game.partyOwnership?.enemy || actorParty(plan, actorEntry).some(mon => mon.combatantKey === entry.combatantKey)).map(entry => ({
    ...normalizedActor(plan, state, entry),
    positionIndex: entry.slot,
    positionOrder: entry.slot
  }));
  const request = {
    schemaVersion: engine.REQUEST_SCHEMA_VERSION || "trainer-ai-evaluation-request/v1alpha1",
    requestId: `plc:full:${state.stateNodeId || state.turnNumber}:${moveActor.combatantKey}${requestIdSuffix}`,
    actorId: actorEntry.combatantKey,
    state: {
      battle: { format: plan.game.battleFormat, turn: Number(state.turnNumber) + 1, kind: "trainer" },
      actor,
      field: state.fieldState || {},
      sides: { ai: { party: aiParty }, opponent: { party: opponentParty } }
    },
    trainer: {
      id: plan.game.trainerId,
      aiMask: Number(battleProfile.aiMask ?? battleProfile.ai ?? 0),
      aiFlagIds: [...flagIds],
      bagSlots: trainerBagSlots || [...(battleProfile.bagItemIds || [])].map(itemId => gen5ItemNumericId(dataset, itemId) ?? 0)
    },
    phaseInputs: {
      "forced-continuation": { disposition: "evaluate" },
      "trainer-item-selection": { disposition: "evaluate", activePokemon: itemActivePokemon || activePokemon, partyCount: aiParty.filter(mon => Number(mon.hp) > 0).length },
      "switch-out": { disposition: "evaluate", actionContext: gen5SwitchContext({ plan, state, dataset, actorEntry, alreadySelected: alreadySelectedSwitches }) },
      "switch-in-or-replacement": { disposition: "evaluate", actionContext: gen5ReplacementContext({ plan, state, dataset, actorEntry }) },
      rotation: { disposition: "evaluate", actorPreselected: plan.game.battleFormat === "rotation" },
      "move-target-selection": { disposition: "evaluate", mode: "scoring", activeFlagIds: evaluatorFlagIds(flagIds), candidates }
    }
  };
  const queries = memoizeDeterministicQueries(createGen5QueryProvider({ plan, state, dataset, actorEntry: moveActor, moves, damageAdapter, gameId: ai.binding.gameId }));
  try {
    return exactEvaluationAsForecast(engine, { profile, request, queries });
  } catch (error) {
    return {
      status: "error",
      basis: { kind: "unavailable" },
      actions: [],
      scoreDistributions: [],
      error: { code: "consumer-evaluation-error", message: error.message || String(error) },
      diagnostics: [{ code: "consumer-evaluation-error", message: error.message || String(error), candidateId: null }]
    };
  }
}

function gen5ActorPassError(message) {
  return {
    status: "error",
    basis: { kind: "unavailable" },
    actions: [],
    scoreDistributions: [],
    error: { code: "actor-selection-pass-unavailable", message },
    diagnostics: [{ code: "actor-selection-pass-unavailable", message, candidateId: null }]
  };
}

function mergeGen5ActorPassWorlds(engine, worlds) {
  const merged = new Map();
  const zero = new engine.Rational(0n);
  for (const world of worlds) {
    if (world.mass.isZero()) continue;
    const reservations = [...world.reservations].sort((left, right) => left - right);
    const key = stableForecastKey({ bagSlots: world.bagSlots, reservations });
    const existing = merged.get(key);
    if (existing) existing.mass = existing.mass.add(world.mass);
    else merged.set(key, { mass: zero.add(world.mass), bagSlots: [...world.bagSlots], reservations });
  }
  return [...merged.values()];
}

function gen5ActorPassEvaluations({ plan, state, dataset, ai, enemies, flagIds, battleProfile, evaluator, damageAdapter }) {
  const engine = evaluator || globalThis.TrainerAiEvaluator;
  const profile = ai.evaluatorProfile;
  if (!engine?.Rational || !profile) return null;
  const pass = profile.selectionModels?.actorSelectionPass;
  if (pass?.activePokemonOrder !== "right-to-left"
    || pass?.reservationArray?.reset !== "once-before-active-pokemon-pass"
    || pass?.reservationArray?.laterActorsExcludeReservedPartySlots !== true
    || pass?.trainerItemBag?.selectedSlotClearedImmediately !== true
    || pass?.trainerItemBag?.laterActorsObserveClearedSlots !== true) {
    const error = gen5ActorPassError("The Generation 5 profile does not declare an exact cross-actor selection pass.");
    return new Map(enemies.map(entry => [entry.combatantKey, error]));
  }
  const initialBagSlots = [...(battleProfile.bagItemIds || [])].slice(0, 4).map(itemId => gen5ItemNumericId(dataset, itemId) ?? 0);
  while (initialBagSlots.length < 4) initialBagSlots.push(0);
  let worlds = [{ mass: new engine.Rational(1n), bagSlots: initialBagSlots, reservations: [] }];
  const evaluations = new Map();
  const orderedActors = [...enemies].sort((left, right) =>
    triplePositionForSlot(plan, "enemy", right.slot) - triplePositionForSlot(plan, "enemy", left.slot));
  for (const [actorIndex, actorEntry] of orderedActors.entries()) {
    const moves = usableMoves(plan, state, actorEntry.combatantKey);
    const branches = [];
    const nextWorlds = [];
    for (const [worldIndex, world] of worlds.entries()) {
      const itemActor = {
        ...normalizedActor(plan, state, actorEntry),
        positionIndex: actorEntry.slot,
        positionOrder: actorEntry.slot
      };
      const result = gen5FullActionEvaluation({
        plan,
        state,
        dataset,
        ai,
        actorEntry,
        moveActorEntry: actorEntry,
        moves,
        flagIds,
        battleProfile,
        evaluator: engine,
        damageAdapter,
        alreadySelectedSwitches: world.reservations,
        trainerBagSlots: world.bagSlots,
        itemActivePokemon: [itemActor],
        requestIdSuffix: `:pass-${actorIndex}-world-${worldIndex}`
      });
      branches.push({ weight: world.mass, result });
      if (result?.status !== "available") continue;
      for (const action of result.actions || []) {
        const actionWeight = engine.Rational.from(action.modeledWeight || action.probability);
        const mass = world.mass.multiply(actionWeight);
        if (mass.isZero()) continue;
        const bagSlots = [...world.bagSlots];
        const reservations = [...world.reservations];
        if (action.action?.type === "item") {
          const bagSlot = Number(action.action.bagSlot);
          if (!Number.isInteger(bagSlot) || bagSlot < 0 || bagSlot >= bagSlots.length) {
            const error = gen5ActorPassError("A Generation 5 trainer-item action did not identify its consumed bag slot.");
            return new Map(enemies.map(entry => [entry.combatantKey, error]));
          }
          bagSlots[bagSlot] = 0;
        } else if (action.action?.type === "switch") {
          const partySlot = Number(action.action.partySlot);
          if (!Number.isInteger(partySlot) || reservations.includes(partySlot)) {
            const error = gen5ActorPassError("A Generation 5 switch action violated the shared party-slot reservation contract.");
            return new Map(enemies.map(entry => [entry.combatantKey, error]));
          }
          reservations.push(partySlot);
        }
        nextWorlds.push({ mass, bagSlots, reservations });
      }
    }
    const mixed = mergeExactForecastBranches(engine, profile, `plc:actor-pass:${state.stateNodeId || state.turnNumber}:${actorEntry.combatantKey}`, branches);
    if (!mixed || mixed.status !== "available") {
      const error = mixed || gen5ActorPassError("The Generation 5 actor selection pass returned no action distribution.");
      evaluations.set(actorEntry.combatantKey, error);
      for (const later of orderedActors.slice(actorIndex + 1)) evaluations.set(later.combatantKey, error);
      break;
    }
    evaluations.set(actorEntry.combatantKey, mixed);
    worlds = mergeGen5ActorPassWorlds(engine, nextWorlds);
    if (!worlds.length && actorIndex + 1 < orderedActors.length) {
      const error = gen5ActorPassError("The Generation 5 actor selection pass lost all probability mass before the next active Pokémon.");
      for (const later of orderedActors.slice(actorIndex + 1)) evaluations.set(later.combatantKey, error);
      break;
    }
  }
  return evaluations;
}

function platinumFullActionEvaluation({ plan, state, dataset, ai, actorEntry, moves, flagIds, battleProfile, evaluator, damageAdapter }) {
  const engine = evaluator || globalThis.TrainerAiEvaluator;
  const profile = ai.evaluatorProfile;
  if ((!engine?.forecast && !engine?.evaluate) || !profile) return null;
  const actor = normalizedActor(plan, state, actorEntry);
  const sourceMoves = state.combatantStates[actorEntry.combatantKey].moveSetOverride || plan.combatants[actorEntry.combatantKey].moves;
  const validMoves = platinumValidMoves({ plan, state, dataset, actorEntry, profile });
  const sourceTargets = (plan.game.battleFormat === 'doubles' ? [...activeSlotEntries(state, 'player'), ...activeSlotEntries(state, 'enemy')] : activeSlotEntries(state, 'player')).filter(row => row.combatantKey !== actorEntry.combatantKey && knownHp(state.combatantStates[row.combatantKey]) > 0);
  const candidates = sourceMoves.flatMap((move, moveSlot) => sourceTargets.map(target => ({
    id: `${actorEntry.combatantKey}:${move.moveId}:${target.combatantKey}`,
    initialScore: validMoves.some(row => row.moveId === move.moveId) ? Number(profile.numericModel?.initialScore ?? 100) : 0,
    skipScoring: Number(state.combatantStates[actorEntry.combatantKey].movePp?.[move.moveId] ?? move.maxPp) === 0,
    targetIsAlly: plan.combatants[target.combatantKey].side === 'enemy',
    action: {
      type: "move",
      moveSlot,
      moveId: Number(dataset.get("moves", move.moveId)?.trainerAi?.numericId),
      canonicalMoveId: move.moveId,
      actorId: actorEntry.combatantKey,
      target: target.slot === null ? target.combatantKey : gen4BattlerId(plan.combatants[target.combatantKey]?.side || "player", target.slot),
      targetCombatantKey: target.combatantKey,
      targetSlot: target.slot
    }
  })));
  for (const candidate of candidates) {
    const source = dataset.get('moves', candidate.action.canonicalMoveId)?.trainerAi;
    if (plan.game.battleFormat === 'doubles' && ((source?.targetId === profile.constants.numericByToken.RANGE_USER_OR_ALLY && !candidate.targetIsAlly)
      || candidate.action.canonicalMoveId === 'curse' && !combatantTypes(plan, state, actorEntry).map(toId).includes('ghost'))) {
      candidate.selectedAction = { ...candidate.action, target: gen4BattlerId('enemy', actorEntry.slot), targetCombatantKey: actorEntry.combatantKey, targetSlot: actorEntry.slot };
    }
  }
  const actorNeedsReplacement = actor.fainted === true || actor.pivoting === true;
  const request = {
    schemaVersion: engine.REQUEST_SCHEMA_VERSION || "trainer-ai-evaluation-request/v1alpha1",
    requestId: `plc:full:${state.stateNodeId || state.turnNumber}:${actorEntry.combatantKey}`,
    actorId: actorEntry.combatantKey,
    state: {
      battle: { format: plan.game.battleFormat, turn: Number(state.turnNumber) + 1, kind: "trainer" },
      actor,
      field: state.fieldState || {},
      sides: {
        ai: { party: actorParty(plan, actorEntry).map((combatant, index) => normalizedPartyMember(plan, state, combatant, index)) },
        opponent: { party: Object.values(plan.combatants).filter(combatant => combatant.side === "player").map((combatant, index) => normalizedPartyMember(plan, state, combatant, index)) }
      }
    },
    trainer: {
      id: plan.game.trainerId,
      aiMask: Number(battleProfile.aiMask ?? battleProfile.ai ?? 0),
      aiFlagIds: [...flagIds],
      bagSlots: [...(battleProfile.bagItemIds || [])]
    },
    phaseInputs: {
      "forced-controller": { disposition: "evaluate" },
      "voluntary-switch": actorNeedsReplacement
        ? { disposition: "not-applicable", notApplicableEvidence: [{ statePath: "state.actor.fainted", operator: "eq", value: true }] }
        : { disposition: "evaluate" },
      "post-ko-replacement": actorNeedsReplacement
        ? { disposition: "evaluate" }
        : {
          disposition: "not-applicable",
          notApplicableEvidence: [
            { statePath: "state.actor.fainted", operator: "eq", value: false },
            { statePath: "state.actor.pivoting", operator: "eq", value: false }
          ]
        },
      "trainer-item-selection": { disposition: "evaluate" },
      "forced-fight": { disposition: "evaluate" },
      "move-target-selection": { disposition: "evaluate", mode: "scoring", sourceRoutine: true, activeFlagIds: evaluatorFlagIds(plan.game.battleFormat === 'doubles' ? [...flagIds, 'AI_FLAG_TAG_STRATEGY', '7'] : flagIds), candidates }
    }
  };
  const queries = createPlatinumQueryProvider({ plan, state, dataset, actorEntry, moves, damageAdapter });
  try {
    return exactEvaluationAsForecast(engine, { profile, request, queries });
  } catch (error) {
    return {
      status: "error",
      basis: { kind: "unavailable" },
      actions: [],
      scoreDistributions: [],
      error: { code: "consumer-evaluation-error", message: error.message || String(error) },
      diagnostics: [{ code: "consumer-evaluation-error", message: error.message || String(error), candidateId: null }]
    };
  }
}

function replacementEvaluation({ plan, state, dataset, ai, actorEntry, battleProfile, evaluator, damageAdapter, alreadySelected = [] }) {
  const engine = evaluator || globalThis.TrainerAiEvaluator;
  const profile = ai.evaluatorProfile;
  if ((!engine?.forecast && !engine?.evaluate) || !profile) return null;
  const generation = Number(ai.generation);
  if (![4, 5].includes(generation)) return null;
  const actor = {
    ...normalizedActor(plan, state, actorEntry),
    hp: 0,
    fainted: true,
    pivoting: false,
    forcedContinuation: "replacement"
  };
  const aiParty = actorParty(plan, actorEntry)
    .map((combatant, index) => normalizedPartyMember(plan, state, combatant, index));
  const opponentParty = Object.values(plan.combatants).filter(combatant => combatant.side === "player")
    .map((combatant, index) => normalizedPartyMember(plan, state, combatant, index));
  const phaseId = generation === 4 ? "post-ko-replacement" : "switch-in-or-replacement";
  const request = {
    schemaVersion: engine.REQUEST_SCHEMA_VERSION || "trainer-ai-evaluation-request/v1alpha1",
    requestId: `plc:replacement:${state.stateNodeId || state.turnNumber}:${actorEntry.combatantKey}`,
    actorId: actorEntry.combatantKey,
    evaluationScope: { startPhaseId: phaseId },
    state: {
      battle: { format: plan.game.battleFormat, turn: Number(state.turnNumber) + 1, kind: "trainer" },
      actor,
      field: state.fieldState || {},
      sides: { ai: { party: aiParty }, opponent: { party: opponentParty } }
    },
    trainer: {
      id: plan.game.trainerId,
      aiMask: Number(battleProfile.aiMask ?? battleProfile.ai ?? 0),
      aiFlagIds: [...(battleProfile.aiFlagIds || [])],
      bagSlots: [...(battleProfile.bagItemIds || [])]
    },
    phaseInputs: generation === 4
      ? { [phaseId]: { disposition: "evaluate" } }
      : { [phaseId]: { disposition: "evaluate", actionContext: gen5ReplacementContext({ plan, state, dataset, actorEntry, alreadySelected }) } }
  };
  const moves = usableMoves(plan, state, actorEntry.combatantKey);
  const queries = generation === 4
    ? createPlatinumQueryProvider({ plan, state, dataset, actorEntry, moves, damageAdapter, alreadySelected })
    : createGen5QueryProvider({ plan, state, dataset, actorEntry, moves, damageAdapter, gameId: ai.binding.gameId });
  try {
    // Preserve the evaluator's reached-path diagnostic. Re-running a random
    // source routine outside its world loses both RNG state and query bindings.
    return exactEvaluationAsForecast(engine, { profile, request, queries });
  } catch (error) {
    return {
      status: "error",
      basis: { kind: "unavailable" },
      actions: [],
      scoreDistributions: [],
      error: { code: "consumer-evaluation-error", message: error.message || String(error) },
      diagnostics: [{ code: "consumer-evaluation-error", message: error.message || String(error), candidateId: null }]
    };
  }
}

// Living actors below are independent "if this one faints" hypotheses. Only
// actually fainted slots share one replacement pass and its reserve reservations.
function gen5FaintedReplacementPass(options, entries) {
  const engine = options.evaluator || globalThis.TrainerAiEvaluator;
  const evaluations = new Map();
  let worlds = [{ mass: new engine.Rational(1n), reservations: [], actions: [] }];
  const ordered = [...entries].sort((a, b) =>
    triplePositionForSlot(options.plan, "enemy", b.slot) - triplePositionForSlot(options.plan, "enemy", a.slot));
  for (const entry of ordered) {
    const branches = [];
    const next = [];
    for (const world of worlds) {
      const result = replacementEvaluation({ ...options, actorEntry: entry, alreadySelected: world.reservations });
      branches.push({ weight: world.mass, result });
      if (result?.status !== "available") continue;
      for (const outcome of result.actions) {
        const partySlot = outcome.action?.partySlot;
        if (outcome.action?.type !== "switch" || world.reservations.includes(partySlot)) continue;
        next.push({
          mass: world.mass.multiply(engine.Rational.from(outcome.modeledWeight || outcome.probability)),
          reservations: [...world.reservations, partySlot],
          actions: [...world.actions, { actorId: entry.combatantKey, partySlot }]
        });
      }
    }
    const result = mergeExactForecastBranches(engine, options.ai.evaluatorProfile, `replacement-pass:${entry.combatantKey}`, branches);
    evaluations.set(entry.combatantKey, result);
    if (result?.status !== "available") {
      for (const later of ordered.slice(ordered.indexOf(entry) + 1)) evaluations.set(later.combatantKey, result);
      return { evaluations, outcomes: [] };
    }
    worlds = next;
  }
  return { evaluations, outcomes: worlds.map(world => ({ actions: world.actions, probability: world.mass.toJSON() })) };
}

function platinumActorPassEvaluations(options, entries, replacement = false) {
  const engine = options.evaluator || globalThis.TrainerAiEvaluator;
  const evaluations = new Map(), precedingActors = [];
  let lastResult = null;
  for (const actorEntry of [...entries].sort((a, b) => a.slot - b.slot)) {
    let captured;
    const evaluator = { ...engine, forecast: input => {
      captured = input;
      return engine.forecast({ ...input, precedingActors: [...precedingActors] });
    } };
    lastResult = replacement
      ? replacementEvaluation({ ...options, actorEntry, evaluator })
      : platinumFullActionEvaluation({ ...options, actorEntry, evaluator, moves: usableMoves(options.plan, options.state, actorEntry.combatantKey) });
    evaluations.set(actorEntry.combatantKey, lastResult);
    if (captured) precedingActors.push(captured);
  }
  const outcomes = (lastResult?.selectionPassOutcomes || []).map(row => ({
    actions: row.actions.map(entry => ({ actorId: entry.actorId, partySlot: entry.action.partySlot ?? null, action: entry.action })),
    probability: row.modeledWeight
  }));
  return { evaluations, outcomes, conditionalScenarios: lastResult?.scenarios || [] };
}

function conditionalMoveEvaluation({ plan, state, dataset, ai, actorEntry, moves, flagIds, battleProfile, evaluator, damageAdapter }) {
  const engine = evaluator || globalThis.TrainerAiEvaluator;
  const profile = ai.evaluatorProfile;
  if (!engine?.evaluate || !profile) return null;
  const actor = normalizedActor(plan, state, actorEntry);
  const platinum = Number(ai.generation) === 4;
  const candidates = moves.flatMap(move => evaluatorMoveTargetEntries(plan, state, actorEntry, move, dataset).map(target => ({
    id: `${actorEntry.combatantKey}:${move.moveId}:${target.combatantKey}`,
    initialScore: Number(profile.numericModel?.initialScore ?? 100),
    aiEffectId: dataset.get("moves", move.moveId)?.aiEffectId,
    action: {
      type: "move",
      moveId: platinum ? Number(dataset.get("moves", move.moveId)?.trainerAi?.numericId) : move.moveId,
      canonicalMoveId: move.moveId,
      target: platinum && target.slot !== null
        ? gen4BattlerId(plan.combatants[target.combatantKey]?.side || "player", target.slot)
        : target.combatantKey,
      targetCombatantKey: target.combatantKey,
      targetSlot: target.slot
    }
  })));
  if (!candidates.length) return null;
  const request = {
    schemaVersion: engine.REQUEST_SCHEMA_VERSION || "trainer-ai-evaluation-request/v1alpha1",
    requestId: `plc:${state.stateNodeId || state.turnNumber}:${actorEntry.combatantKey}`,
    actorId: actorEntry.combatantKey,
    evaluationScope: { startPhaseId: "move-target-selection" },
    state: {
      battle: { format: plan.game.battleFormat, turn: Number(state.turnNumber) + 1, kind: "trainer" },
      actor,
      field: state.fieldState || {},
      sides: {
        ai: { party: actorParty(plan, actorEntry) },
        opponent: { party: Object.values(plan.combatants).filter(combatant => combatant.side === "player") }
      }
    },
    trainer: {
      id: plan.game.trainerId,
      aiMask: Number(battleProfile.aiMask ?? battleProfile.ai ?? 0),
      aiFlagIds: [...flagIds],
      bagSlots: [...(battleProfile.bagItemIds || [])].filter(Boolean)
    },
    phaseInputs: {
      "move-target-selection": {
        disposition: "evaluate",
        mode: "scoring",
        activeFlagIds: evaluatorFlagIds(flagIds),
        candidates
      }
    }
  };
  try {
    const queries = Number(ai.generation) === 4
      ? createPlatinumQueryProvider({ plan, state, dataset, actorEntry, moves, damageAdapter })
      : createGen5QueryProvider({ plan, state, dataset, actorEntry, moves, damageAdapter, gameId: ai.binding.gameId });
    return engine.evaluate({ profile, request, queries });
  } catch (error) {
    return {
      status: "unavailable",
      knownProbability: { decimal: 0 },
      unresolvedProbability: { decimal: 1 },
      actions: [],
      diagnostics: [{ code: "consumer-evaluation-error", message: error.message || String(error), candidateId: null }]
    };
  }
}

function evaluatedMoveSummary(result, moveId) {
  if (!result) return null;
  if (result.status === "error") {
    return {
      modeledWeight: null,
      explanation: result.error?.message || result.diagnostics?.map(entry => entry.message).filter(Boolean).join(" ") || "The Trainer AI forecast could not resolve this state.",
      evaluatorStatus: "error",
      incentiveLedger: null
    };
  }
  const actions = result.actions.filter(entry => entry.action?.type === "move" && (entry.action.canonicalMoveId || entry.action.moveId) === moveId);
  const modeledWeightRange = forecastGroupRange(result, entry => entry.action?.type === 'move' && (entry.action.canonicalMoveId || entry.action.moveId) === moveId);
  const modeledWeight = modeledWeightRange ? null : actions.reduce((sum, entry) => sum + forecastWeight(entry), 0);
  const selectedCandidateIds = new Set(actions.flatMap(entry => entry.candidateIds || []));
  const candidateIds = new Set(selectedCandidateIds);
  for (const distribution of result.scoreDistributions || []) {
    const action = distribution.candidate?.action;
    if ((action?.canonicalMoveId || action?.moveId) === moveId || String(distribution.candidateId || "").includes(`:${moveId}:`)) {
      candidateIds.add(distribution.candidateId);
    }
  }
  if (candidateIds.size === 0) {
    return {
      modeledWeight,
      modeledWeightRange,
      explanation: actions.some(row => row.action?.forced) ? actions.map(row => row.action.explanation).filter(Boolean).join(' ') || 'This move is forced without running the 100-point incentive scoring.' : "An earlier trainer item, switch, or forced action preempts move scoring in this state, so the 100-point move ledger is not reached.",
      evaluatorStatus: result.basis?.kind === "exact-evaluation" || result.basis?.exact === true ? "exact" : "modeled",
      incentiveLedger: null
    };
  }
  const allReasons = (result.scoreAdjustments || [])
    .filter(reason => reason.candidateId && candidateIds.has(reason.candidateId));
  const adjustments = [...new Map(allReasons.filter(reason => Number.isInteger(reason.delta)).map(reason => [
    `${reason.candidateId || ""}:${reason.reasonCode}:${reason.delta}:${reason.summary}`,
    {
      candidateId: reason.candidateId || null,
      reasonCode: reason.reasonCode,
      title: reason.title,
      delta: reason.delta,
      summary: reason.summary,
      previousScore: reason.previousScore,
      resultingScore: reason.resultingScore,
      probability: reason.scoringProbability || null,
      probabilityBasis: reason.probabilityBasis || null
    }
  ])).values()];
  const finalScores = [...new Set((result.scoreDistributions || [])
    .filter(distribution => candidateIds.has(distribution.candidateId))
    .flatMap(distribution => (distribution.scores || []).map(outcome => Number(outcome.score))))].sort((left, right) => right - left);
  const finalScoreDistributions = (result.scoreDistributions || [])
    .filter(distribution => candidateIds.has(distribution.candidateId))
    .map(distribution => ({
      candidateId: distribution.candidateId,
      influencesLikelihood: selectedCandidateIds.has(distribution.candidateId),
      targetSide: distribution.candidate?.action?.targetSide || null,
      targetSlot: Number.isInteger(distribution.candidate?.action?.targetSlot)
        ? distribution.candidate.action.targetSlot
        : null,
      scores: (distribution.scores || []).map(outcome => ({
        score: Number(outcome.score),
        probability: outcome.probability || null,
        probabilityBasis: distribution.probabilityBasis || null
      }))
    }));
  const initialScore = Number(result.incentiveModel?.initialScore ?? 100);
  const adjustmentText = adjustments.length
    ? ` Documented adjustments reached here: ${adjustments.map(adjustment => `${adjustment.delta >= 0 ? "+" : ""}${adjustment.delta} — ${adjustment.summary}`).join(" ")}`
    : ` No active scoring rule changes this move from ${initialScore} in this state.`;
  const scoreText = finalScores.length
    ? ` Pre-selection final ${finalScores.length === 1 ? "score" : "scores"}: ${finalScores.join(", ")}.`
    : "";
  const selectionReasons = [...new Set(actions.flatMap(entry => entry.reasons || []).filter(reason => reason.summary && !Number.isInteger(reason.delta)).map(reason => reason.summary))];
  return {
    modeledWeight,
    modeledWeightRange,
    explanation: `Starts at ${initialScore}.${adjustmentText}${scoreText}${selectionReasons.length ? ` ${selectionReasons.join(" ")}` : ""}${modeledWeightRange ? ` ${result.basis.summary}` : ''}`,
    evaluatorStatus: result.basis?.kind === "exact-evaluation" || result.basis?.exact === true ? "exact" : "modeled",
    incentiveLedger: { initialScore, adjustments, finalScores, finalScoreDistributions }
  };
}

export function analyzeTrainerAi({ plan, state, dataset, ai, evaluator = null, damageAdapter = null }) {
  if (!plan || !state || !dataset || !ai) return null;
  const policy = ai.evaluatorProfile?.constants?.abilityKnowledge;
  if (policy) dataset = { ...dataset, abilityKnowledgePolicy: policy };
  if (policy && state.trainerAiBelief?.modelId !== policy.modelId) {
    if (state.stateNodeId !== plan.initialStateNodeId) throw new TrainerAiReadinessError("Recalculate this saved branch to reconstruct Gen 5 ability observations before forecasting.");
    plan = upgradeInitialEntryEffects(plan, dataset).plan;
    state = plan.stateNodes[plan.initialStateNodeId];
  }
  const assumptions = Object.entries(state.combatantStates || {}).flatMap(([combatantKey, mon]) => {
    const { min, max } = mon.hp || {};
    return Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max > min
      ? [{ kind: "midpoint-hp", combatantKey, name: combatantName(plan.combatants[combatantKey]), minimum: min, maximum: max, assumedHp: Math.floor(min + (max - min) / 2) }]
      : [];
  });
  // Temporary presentation model, not a change to planner state or source AI rules.
  const forecastState = assumptions.length ? structuredClone(state) : state;
  for (const assumption of assumptions) {
    const mon = forecastState.combatantStates[assumption.combatantKey];
    mon.hp = { ...mon.hp, min: assumption.assumedHp, max: assumption.assumedHp };
    mon.hpDistribution = [{ value: assumption.assumedHp, probability: 1 }];
  }
  const result = analyzeTrainerAiState({ plan, state: forecastState, dataset, ai, evaluator, damageAdapter });
  if (!result || !assumptions.length) return result;
  result.assumptions = assumptions;
  result.assumptionNote = `${assumptions.map(row => `${row.name}: assumes ${row.assumedHp} HP from ${row.minimum}–${row.maximum}`).join("; ")}. Uses midpoint HP rounded down, not the most likely damage roll. All likelihoods, including Guaranteed, apply only under this assumption; AI choices may change at other HP values.`;
  result.exactActionProbabilities = false;
  if (result.status === "exact") result.status = "modeled";
  for (const actor of result.actors) {
    actor.forecastBasis = { ...actor.forecastBasis, hpAssumptions: assumptions };
    if (actor.fullEvaluatorStatus === "exact") actor.fullEvaluatorStatus = "modeled";
    for (const row of [...actor.moves, ...actor.actions]) {
      if (row.turnLikelihood?.id === "guaranteed") row.turnLikelihood = { ...row.turnLikelihood, label: "Guaranteed (assumed HP)" };
    }
  }
  for (const replacement of result.replacementForecasts) {
    replacement.basis = { ...replacement.basis, hpAssumptions: assumptions };
    for (const row of replacement.options) {
      if (row.likelihood?.id === "guaranteed") row.likelihood = { ...row.likelihood, label: "Guaranteed (assumed HP)" };
    }
  }
  return result;
}

function analyzeTrainerAiState({ plan, state, dataset, ai, evaluator = null, damageAdapter = null }) {
  if (!plan || !state || !dataset || !ai || state.freeCalc) return null;
  const { trainer, battleProfile } = trainerProfile(plan, dataset);
  if (!trainer || !battleProfile) return null;
  const flagIds = battleProfile.aiFlagIds || [];
  const aiMask = Number(battleProfile.aiMask ?? battleProfile.ai ?? 0);
  const scripts = scriptSummary(ai, flagIds);
  const readiness = ai.binding.predictionReadiness || ai.profile.predictionReadiness || {};
  const blockers = [...new Set([
    ...(ai.binding.predictionReadiness?.blockers || []),
    ...(ai.profile.predictionReadiness?.blockers || [])
  ].map(entry => typeof entry === "string" ? entry : entry.detail || entry.id).filter(Boolean))];
  const enemies = activeEnemyEntries(plan, state);
  const livingFieldCount = plan.game.battleFormat === "rotation" ? enemies.length : 1;
  const actorProbability = plan.game.battleFormat === "rotation" && livingFieldCount ? 1 / livingFieldCount : 1;
  const rotationFrontEntry = plan.game.battleFormat === "rotation"
    ? enemies.find(entry => entry.slot === rotationFrontSlot(state, "enemy")) || enemies[0]
    : null;
  const engine = evaluator || globalThis.TrainerAiEvaluator;
  const enemyByPartySlot = new Map(Object.values(plan.combatants).filter(combatant => combatant.side === "enemy")
    .map((combatant, index) => [trainerPartyOrder(combatant, index), combatant]));
  const ownedParties = plan.game.partyOwnership?.enemy?.policy === 'per-trainer';
  const gen5ActorPass = !ownedParties && Number(ai.generation) === 5 && plan.game.battleFormat !== "rotation" && enemies.length > 1
    ? gen5ActorPassEvaluations({ plan, state, dataset, ai, enemies, flagIds, battleProfile, evaluator: engine, damageAdapter })
    : null;
  const platinumActorPass = !ownedParties && Number(ai.generation) === 4 && enemies.length > 1
    ? platinumActorPassEvaluations({ plan, state, dataset, ai, flagIds, battleProfile, evaluator: engine, damageAdapter }, enemies) : null;
  const actors = enemies.map(entry => {
    const { battleProfile } = trainerProfile(plan, dataset, entry);
    const flagIds = battleProfile?.aiFlagIds || [];
    const aiMask = Number(battleProfile?.aiMask ?? battleProfile?.ai ?? 0);
    const enemyByPartySlot = new Map(actorParty(plan, entry).map((mon, index) => [trainerPartyOrder(mon, index), mon]));
    const moves = usableMoves(plan, state, entry.combatantKey);
    const uniformWithoutScripts = Boolean(ai.semantics) && aiMask === 0 && ["singles", "rotation"].includes(plan.game.battleFormat);
    const fullEvaluation = Number(ai.generation) === 5
      ? gen5ActorPass?.get(entry.combatantKey) || gen5FullActionEvaluation({
        plan,
        state,
        dataset,
        ai,
        actorEntry: rotationFrontEntry || entry,
        moveActorEntry: entry,
        moves,
        flagIds,
        battleProfile,
        evaluator,
        damageAdapter
      })
      : Number(ai.generation) === 4
        ? platinumActorPass?.evaluations.get(entry.combatantKey) || platinumFullActionEvaluation({ plan, state, dataset, ai, actorEntry: entry, moves, flagIds, battleProfile, evaluator, damageAdapter })
        : null;
    const forecastAvailable = fullEvaluation?.status === "available";
    const actionRecords = (fullEvaluation?.actions || []).map(action => {
      const range = forecastGroupRange(fullEvaluation, row => row.actionKey === action.actionKey);
      const modeledWeight = range ? null : forecastWeight(action) * actorProbability;
      return {
        ...action,
        displayName: action.action?.type === "item"
          ? `Use ${dataset.getBySaveNumericId("items", action.action.itemId)?.name || action.action.itemToken || `item ${action.action.itemId}`}`
          : action.action?.type === "switch"
            ? `Switch to ${combatantName(enemyByPartySlot.get(Number(action.action.partySlot)))}`
            : String(action.action?.type || "Other action"),
        turnProbability: modeledWeight,
        modeledWeightRange: range,
        turnLikelihood: range ? rangeLikelihood(range, engine) : trainerAiLikelihood(modeledWeight, engine),
        explanation: [...new Set((action.reasons || []).map(reason => reason.summary).filter(Boolean))].join(" ")
          || (action.action?.type === "item"
            ? "Trainer item selection occurs before move scoring and preempts the rest of the turn when an item is usable."
            : action.action?.type === "switch"
              ? "The switch routine occurs before move scoring and preempts the rest of the turn when its documented conditions pass."
              : "The Trainer AI selected this action through the documented phase order.")
      };
    });
    const displayMoves = [...moves];
    for (const row of fullEvaluation?.actions || []) if (row.action?.type === 'move' && row.action.canonicalMoveId && !displayMoves.some(move => move.moveId === row.action.canonicalMoveId)) displayMoves.push({ moveId: row.action.canonicalMoveId });
    const moveRecords = displayMoves.map(move => {
      const summary = evaluatedMoveSummary(fullEvaluation, move.moveId);
      const fallbackWeight = !fullEvaluation && (moves.length === 1 || uniformWithoutScripts) ? 1 / moves.length : null;
      const modeledWeight = summary?.modeledWeight ?? fallbackWeight;
      const turnWeight = modeledWeight === null ? null : modeledWeight * actorProbability;
      return {
        moveId: move.moveId,
        name: dataset.get("moves", move.moveId)?.name || move.moveId,
        conditionalProbability: modeledWeight,
        turnProbability: turnWeight,
        modeledWeightRange: summary?.modeledWeightRange || null,
        turnLikelihood: forecastAvailable ? summary?.modeledWeightRange ? rangeLikelihood(summary.modeledWeightRange, engine) : turnWeight !== null ? trainerAiLikelihood(turnWeight, engine) : null : null,
        evaluatorStatus: summary?.evaluatorStatus || null,
        incentiveLedger: summary?.incentiveLedger || null,
        explanation: summary?.explanation
          || (moves.length === 1
            ? "Starts at 100. It is the only usable move if the AI reaches move selection."
            : uniformWithoutScripts
              ? `Each move starts at 100. No scoring flags are active, so all ${moves.length} usable moves remain equally likely if move selection is reached.`
              : "The move incentive forecast could not be evaluated from this state.")
      };
    });
    const optionRows = [
      ...actionRecords.filter(action => action.action?.type !== "move").map(action => ({ key: action.actionKey, label: action.action?.type === "item"
        ? `Use ${dataset.getBySaveNumericId("items", action.action.itemId)?.name || action.action.itemToken || `item ${action.action.itemId}`}`
        : action.action?.type === "switch"
          ? `Switch to ${combatantName(enemyByPartySlot.get(Number(action.action.partySlot)))}`
          : String(action.action?.type || "Other action"), weight: action.turnProbability, record: action })),
      ...moveRecords.map(move => ({ key: `move:${move.moveId}`, label: move.name, weight: move.turnProbability, record: move }))
    ].filter(option => option.weight !== null || option.record.modeledWeightRange);
    for (const option of optionRows) {
      const equal = option.record.modeledWeightRange
        ? optionRows.filter(other => other.key !== option.key && other.record.modeledWeightRange && JSON.stringify(other.record.modeledWeightRange.scenarioWeights) === JSON.stringify(option.record.modeledWeightRange.scenarioWeights))
        : Number(option.weight) > 0
        ? optionRows.filter(other => other.key !== option.key && Number(other.weight) > 0 && Math.abs(Number(other.weight) - Number(option.weight)) < 1e-12)
        : [];
      option.record.equalLikelihood = {
        count: equal.length + 1,
        labels: equal.map(other => other.label)
      };
    }
    return {
      combatantKey: entry.combatantKey,
      name: combatantName(plan.combatants[entry.combatantKey]),
      slot: entry.slot,
      front: plan.game.battleFormat !== "rotation" || entry.slot === rotationFrontSlot(state, "enemy"),
      actorProbability,
      forecastStatus: fullEvaluation?.status || "error",
      forecastBasis: fullEvaluation?.basis || { kind: "unavailable" },
      forecastError: fullEvaluation?.status === "error"
        ? fullEvaluation.error?.message || fullEvaluation.diagnostics?.map(diagnostic => diagnostic.message).filter(Boolean).join(" ") || "The turn-action forecast could not be resolved."
        : null,
      fullEvaluatorStatus: forecastAvailable ? fullEvaluation.basis?.kind === "exact-evaluation" || fullEvaluation.basis?.exact === true ? "exact" : "modeled" : "unavailable",
      unresolvedActionProbability: forecastAvailable ? 0 : 1,
      actions: actionRecords,
      moves: moveRecords
    };
  });
  const faintedEntries = activeSlotEntries(state, "enemy").filter(entry => Number(state.combatantStates[entry.combatantKey]?.hp?.max ?? 0) <= 0);
  const replacementPass = !ownedParties && Number(ai.generation) === 5 && engine?.Rational && ai.evaluatorProfile && faintedEntries.length > 1
    ? gen5FaintedReplacementPass({ plan, state, dataset, ai, battleProfile, evaluator, damageAdapter }, faintedEntries)
    : !ownedParties && Number(ai.generation) === 4 && faintedEntries.length > 1
      ? platinumActorPassEvaluations({ plan, state, dataset, ai, battleProfile, evaluator: engine, damageAdapter }, faintedEntries, true) : null;
  const replacementForecasts = [...enemies, ...faintedEntries].map(entry => {
    const { battleProfile } = trainerProfile(plan, dataset, entry);
    const enemyByPartySlot = new Map(actorParty(plan, entry).map((mon, index) => [trainerPartyOrder(mon, index), mon]));
    const reserves = platinumReserves(plan, state, entry);
    if (!reserves.length) {
      return {
        combatantKey: entry.combatantKey,
        name: combatantName(plan.combatants[entry.combatantKey]),
        slot: entry.slot,
        status: "not-applicable",
        options: [],
        explanation: "No healthy reserve Pokémon remains to replace this battler."
      };
    }
    const result = replacementPass?.evaluations.get(entry.combatantKey)
      || replacementEvaluation({ plan, state, dataset, ai, actorEntry: entry, battleProfile, evaluator, damageAdapter });
    if (result?.status !== "available") {
      return {
        combatantKey: entry.combatantKey,
        name: combatantName(plan.combatants[entry.combatantKey]),
        slot: entry.slot,
        status: "error",
        basis: result?.basis || { kind: "unavailable" },
        options: [],
        error: result?.error?.message || result?.diagnostics?.map(diagnostic => diagnostic.message).filter(Boolean).join(" ") || "Replacement selection did not resolve to a documented switch."
      };
    }
    const byPartySlot = new Map();
    const gen5Context = Number(ai.generation) === 5
      ? gen5ReplacementContext({ plan, state, dataset, actorEntry: entry })
      : null;
    if (result.actions.length && result.actions.every(row => row.action?.type === 'no-replacement')) return { combatantKey: entry.combatantKey, name: combatantName(plan.combatants[entry.combatantKey]), slot: entry.slot, status: 'not-applicable', basis: result.basis, options: [], explanation: 'The earlier fainted slot receives the last healthy reserve; this slot remains empty.' };
    for (const action of result.actions.filter(action => action.action?.type === "switch")) {
      const partySlot = Number(action.action.partySlot);
      const current = byPartySlot.get(partySlot) || { weight: 0, highestDamageReferences: [] };
      current.weight += forecastWeight(action);
      const target = gen5Context?.targets.find(row => row.id === action.action.target || Number(row.position) === Number(action.action.target));
      const candidate = target?.candidates.find(row => Number(row.partySlot) === partySlot);
      for (const moveId of candidate?.highestDamageMoveIds || []) {
        const reference = {
          moveId,
          moveName: dataset.get("moves", moveId)?.name || moveId,
          targetCombatantKey: target.id,
          targetSlot: Number(target.position),
          score: candidate.score
        };
        if (!current.highestDamageReferences.some(row => row.moveId === reference.moveId && row.targetCombatantKey === reference.targetCombatantKey)) {
          current.highestDamageReferences.push(reference);
        }
      }
      byPartySlot.set(partySlot, current);
    }
    const options = [...byPartySlot.entries()].map(([partySlot, details]) => {
      const { weight, highestDamageReferences } = details;
      const range = forecastGroupRange(result, row => row.action?.type === 'switch' && Number(row.action.partySlot) === partySlot);
      return {
      partySlot,
      combatantKey: enemyByPartySlot.get(partySlot)?.combatantKey || null,
      name: combatantName(enemyByPartySlot.get(partySlot)),
      modeledWeight: range ? null : weight,
      modeledWeightRange: range,
      likelihood: range ? rangeLikelihood(range, engine) : trainerAiLikelihood(weight, engine),
      highestDamageReference: highestDamageReferences.length === 1 ? highestDamageReferences[0] : null,
      highestDamageReferences,
      equalLikelihood: { count: 1, labels: [] }
    }; }).sort((left, right) => (right.modeledWeightRange?.maximum ?? right.modeledWeight) - (left.modeledWeightRange?.maximum ?? left.modeledWeight) || left.partySlot - right.partySlot);
    for (const option of options) {
      const equal = options.filter(other => other.partySlot !== option.partySlot && (option.modeledWeightRange
        ? JSON.stringify(other.modeledWeightRange?.scenarioWeights) === JSON.stringify(option.modeledWeightRange.scenarioWeights)
        : !other.modeledWeightRange && Math.abs(other.modeledWeight - option.modeledWeight) < 1e-12));
      option.equalLikelihood = { count: equal.length + 1, labels: equal.map(other => other.name) };
    }
    return {
      combatantKey: entry.combatantKey,
      name: combatantName(plan.combatants[entry.combatantKey]),
      slot: entry.slot,
      status: options.length ? "available" : "error",
      basis: result.basis,
      options,
      error: options.length ? null : "Replacement selection did not return a legal reserve Pokémon.",
      explanation: replacementPass?.evaluations.has(entry.combatantKey)
        ? "These fainted slots are evaluated together; later replacements exclude reserves already selected for earlier slots."
        : `This forecast assumes only this battler needs replacing, with the other active slots unchanged. It does not compete with current-turn actions.${result.scenarios ? ` ${result.basis.summary}` : ''}`
    };
  });
  const exactActionProbabilities = [4, 5].includes(Number(ai.generation)) && actors.length > 0
    && actors.every(actor => actor.fullEvaluatorStatus === "exact");
  const forecastAvailable = actors.length > 0 && actors.every(actor => actor.forecastStatus === "available");
  return {
    trainerName: trainer.displayName || trainer.name || trainer.id,
    aiMask,
    flagIds,
    scripts,
    actors,
    replacementForecasts,
    jointReplacementOutcomes: replacementPass?.outcomes || [],
    jointReplacementScenarios: replacementPass?.conditionalScenarios || [],
    jointTurnOutcomes: platinumActorPass?.outcomes || [],
    exactActionProbabilities,
    status: exactActionProbabilities ? "exact" : forecastAvailable ? "modeled" : "error",
    blockers,
    actorSelectionPass: gen5ActorPass ? {
      activePokemonOrder: "right-to-left",
      switchReservationsModeled: true,
      trainerItemConsumptionModeled: true
    } : null,
    unresolvedActiveOpcodeCount: Number(readiness.unresolvedActiveOpcodeCount ?? ai.profile.predictionReadiness?.blockers?.[0]?.unresolvedUsedOpcodes?.length ?? 0),
    rotation: plan.game.battleFormat === "rotation" ? {
      livingFieldCount,
      actorProbability,
      likelihood: trainerAiLikelihood(actorProbability, engine),
      explanation: livingFieldCount === 3
        ? "Before move scoring, the left, right, and current front Pokémon are equally likely to act."
        : livingFieldCount === 2
          ? "Before move scoring, the two living field Pokémon are equally likely to act."
          : "Only one living field Pokémon remains, so it acts if the AI reaches move selection."
    } : null
  };
}
