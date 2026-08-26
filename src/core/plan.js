import { assertValidPlanDocument } from "../contracts/plan_contract.js";
import { clone, exactRange, makeStableId, nowIso, shortHash, stableStringify, toId } from "./primitives.js";
import { activeKeys, battleFormat as normalizeBattleFormat, slotsPerSide } from "./battle_slots.js";
import { createInitialExperienceState } from "../rulesets/vw2r_experience.js";
import { entryAbilityEffects } from "../rulesets/switch_rules.js?v=20260825-download";
import { currentMechanicsFingerprint } from "../rulesets/resolver_profile.js";

export const INITIAL_ENTRY_EFFECTS_VERSION = 1;

const INITIAL_STAT_LABELS = Object.freeze({ atk: "Attack", def: "Defense", spa: "Sp. Atk", spd: "Sp. Def", spe: "Speed", accuracy: "Accuracy", evasion: "Evasion" });

function defaultStages() {
  return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
}

export function createDefaultVolatiles() {
  return {
    sleepTurns: null,
    sleepCounterDistribution: null,
    sleepCounterStartDistribution: null,
    confusionTurns: null,
    confusionCounterDistribution: null,
    leechSeeded: false,
    substituteHp: 0,
    tauntTurns: 0,
    encoredMoveId: null,
    disabledMoveId: null,
    choiceLockedMoveId: null,
    rechargeRequired: false,
    protectStreak: 0,
    magnetRiseTurns: 0,
    telekinesisTurns: 0
  };
}

const STATUS_ALIASES = Object.freeze({ burn: "brn", burned: "brn", poison: "psn", poisoned: "psn", toxic: "tox", badlypoisoned: "tox", paralysis: "par", paralyzed: "par", sleep: "slp", asleep: "slp", freeze: "frz", frozen: "frz" });
const FIELD_ALIASES = Object.freeze({ raindance: "rain", sunnyday: "sun", sandstorm: "sand", electricterrain: "electric", grassyterrain: "grassy", mistyterrain: "misty", psychicterrain: "psychic" });

export function normalizeMajorStatus(value) {
  const id = toId(value);
  return id ? STATUS_ALIASES[id] || id : null;
}

export function normalizeFieldCondition(kind, value, defaults = {}) {
  const raw = value && typeof value === "object" ? value : { id: value };
  const rawId = toId(raw?.id);
  const id = rawId ? FIELD_ALIASES[rawId] || rawId : null;
  if (!id) return { id: null, source: null, durationMode: null, remainingTurns: null };
  const allowed = kind === "weather"
    ? new Set(["rain", "sun", "sand", "hail", "snow"])
    : new Set(["electric", "grassy", "misty", "psychic"]);
  if (!allowed.has(id)) throw new Error(`Unsupported ${kind} condition ${id}`);
  const durationMode = raw.durationMode || defaults.durationMode || (raw.remainingTurns === undefined && defaults.remainingTurns === undefined ? "permanent" : "turns");
  if (!["permanent", "turns"].includes(durationMode)) throw new Error(`Unsupported ${kind} duration mode ${durationMode}`);
  const suppliedTurns = raw.remainingTurns ?? defaults.remainingTurns;
  const remainingTurns = durationMode === "permanent" ? null : Number(suppliedTurns);
  if (durationMode === "turns" && (!Number.isInteger(remainingTurns) || remainingTurns < 1)) {
    throw new Error(`${kind} remainingTurns must be a positive integer`);
  }
  return {
    id,
    source: raw.source || defaults.source || "manual",
    durationMode,
    remainingTurns
  };
}

export function resetTurnFlags() {
  return {
    hasMoved: false,
    wasDamaged: false,
    hpLostThisTurn: false,
    damageTaken: 0,
    damagingHitsTaken: 0,
    lastDamageSourceKey: null,
    lastDamageCategory: null,
    flinched: false,
    protected: false
  };
}

export function createCombatantState(combatant, override = {}) {
  const maxHp = Number(combatant.calculatedStats?.hp);
  if (!Number.isFinite(maxHp) || maxHp < 1) throw new Error(`${combatant.displayName} has no calculated HP`);
  const declaredHp = override.currentHp ?? override.hp ?? maxHp;
  const hp = Math.max(0, Math.min(maxHp, Number(declaredHp)));
  return {
    combatantKey: combatant.combatantKey,
    currentLevel: Number(combatant.level),
    experience: Number.isInteger(combatant.experience) ? combatant.experience : null,
    hp: exactRange(hp, maxHp),
    hpDistribution: [{ value: hp, probability: 1 }],
    majorStatus: normalizeMajorStatus(override.majorStatus),
    toxicCounter: normalizeMajorStatus(override.majorStatus) === "tox" ? Math.max(1, Number(override.toxicCounter || 1)) : 0,
    statStages: { ...defaultStages(), ...(override.statStages || {}) },
    currentAbilityId: combatant.originalAbilityId,
    abilitySuppressed: false,
    currentItemId: combatant.originalItemId,
    itemState: combatant.originalItemId ? "held" : "none",
    currentTypeIds: [...combatant.originalTypeIds],
    lastMoveId: null,
    usedMoveIds: [],
    enteredTurnNumber: 0,
    movePp: Object.fromEntries(combatant.moves.map(move => [move.moveId, move.maxPp])),
    volatileConditions: createDefaultVolatiles(),
    turnFlags: resetTurnFlags()
  };
}

export function createInitialState({ combatants, playerActiveKeys, enemyActiveKeys, battleFormat = "singles", initialConditions = {} }) {
  const combatantStates = Object.fromEntries(Object.values(combatants).map(combatant => [
    combatant.combatantKey,
    createCombatantState(combatant, initialConditions.combatants?.[combatant.combatantKey])
  ]));
  const initialExperienceState = createInitialExperienceState(combatants, playerActiveKeys, enemyActiveKeys);
  const state = {
    stateNodeId: "state-root",
    parentActionGroupId: null,
    parentReplacementTransitionId: null,
    turnNumber: 0,
    createdOrder: 0,
    outcome: { kind: "initial", label: "Initial state", probability: 1, probabilityStatus: "known", conditions: [] },
    active: {
      playerCombatantKeys: [...playerActiveKeys],
      enemyCombatantKeys: [...enemyActiveKeys],
      playerCombatantKey: playerActiveKeys[0],
      enemyCombatantKey: enemyActiveKeys[0]
    },
    combatantStates,
    ...(initialExperienceState ? { experienceState: initialExperienceState } : {}),
    fieldState: {
      global: {
        weather: normalizeFieldCondition("weather", initialConditions.weather),
        terrain: normalizeFieldCondition("terrain", initialConditions.terrain),
        trickRoomTurns: Number(initialConditions.trickRoomTurns || 0),
        gravityTurns: Number(initialConditions.gravityTurns || 0),
        magicRoomTurns: Number(initialConditions.magicRoomTurns || 0),
        wonderRoomTurns: Number(initialConditions.wonderRoomTurns || 0),
        lastMoveId: null,
        delayedAttacks: [],
        delayedHeals: []
      },
      sides: {
        player: { reflectTurns: 0, lightScreenTurns: 0, auroraVeilTurns: 0, tailwindTurns: 0, safeguardTurns: 0, mistTurns: 0, luckyChantTurns: 0, retaliateReady: false, hazards: {}, slotEffects: {} },
        enemy: { reflectTurns: 0, lightScreenTurns: 0, auroraVeilTurns: 0, tailwindTurns: 0, safeguardTurns: 0, mistTurns: 0, luckyChantTurns: 0, retaliateReady: false, hazards: {}, slotEffects: {} }
      }
    },
    pendingReplacementSlots: [],
    pendingReplacementSides: [],
    battleEnded: false,
    resolutionEventIds: [],
    childActionGroupIds: [],
    childReplacementTransitionIds: [],
    stateHash: "",
    status: "resolved",
    displaySnapshot: {
      turnNumber: 0,
      outcomeLabel: "Initial state",
      players: [],
      enemies: []
    },
    draftNote: ""
  };
  state.stateHash = `state-${shortHash(stableStringify({
    active: state.active,
    combatantStates,
    experienceState: state.experienceState || null,
    fieldState: state.fieldState,
    pendingReplacementSlots: state.pendingReplacementSlots,
    battleEnded: state.battleEnded
  }))}`;
  return state;
}

function initialEntryOrder(plan, root) {
  return ["player", "enemy"].flatMap((side, sideOrder) => activeKeys(root, side).map((combatantKey, slot) => ({
    side,
    sideOrder,
    slot,
    combatantKey,
    speed: Number(plan.combatants[combatantKey]?.calculatedStats?.spe || 0)
  }))).sort((left, right) => right.speed - left.speed || left.sideOrder - right.sideOrder || left.slot - right.slot);
}

function initialEntryEvent(events, details) {
  events.push({ actorKey: null, targetKey: null, moveId: null, source: "planned", changes: [], metadata: {}, ...details });
}

function entryComparisonState(plan, state, combatantKey) {
  const combatantState = state.combatantStates[combatantKey];
  return {
    ...combatantState,
    currentStats: {
      ...(plan.combatants[combatantKey]?.calculatedStats || {}),
      ...(combatantState?.currentStats || {})
    }
  };
}

function applyInitialEntryEffect(root, events, actorKey, side, effect, opposingKey = null) {
  if (effect.kind === "unsupported") throw new Error(effect.reason);
  if (effect.kind === "stat-stage") {
    const affectedKey = effect.target === "opponent" ? opposingKey : actorKey;
    const affectedState = root.combatantStates[affectedKey];
    if (!affectedState) return;
    const from = Math.max(-6, Math.min(6, Number(affectedState.statStages[effect.stat] || 0)));
    const to = Math.max(-6, Math.min(6, from + Number(effect.delta || 0)));
    affectedState.statStages[effect.stat] = to;
    initialEntryEvent(events, {
      eventType: "stat-stage-change",
      actorKey,
      targetKey: affectedKey,
      metadata: { cause: effect.cause, resultLabel: `${INITIAL_STAT_LABELS[effect.stat] || effect.stat} ${to - from >= 0 ? "+" : ""}${to - from}` },
      changes: [{ path: `combatantStates.${affectedKey}.statStages.${effect.stat}`, from, to }]
    });
    return;
  }
  if (effect.kind === "intimidate-blocked") {
    initialEntryEvent(events, { eventType: "ability-blocked", actorKey, targetKey: opposingKey, metadata: { cause: effect.cause, resultLabel: "Intimidate blocked" } });
    return;
  }
  if (effect.kind === "weather") {
    const previous = clone(root.fieldState.global.weather);
    const condition = normalizeFieldCondition("weather", {
      id: effect.weatherId,
      source: `ability:${effect.cause}`,
      durationMode: effect.durationMode,
      remainingTurns: effect.remainingTurns
    });
    root.fieldState.global.weather = condition;
    initialEntryEvent(events, {
      eventType: "field-change",
      actorKey,
      metadata: { cause: effect.cause, fieldKind: "weather", fieldId: effect.weatherId, resultLabel: `${effect.weatherId} weather` },
      changes: [{ path: "fieldState.global.weather", from: previous, to: clone(condition) }]
    });
  }
}

export function upgradeInitialEntryEffects(plan, dataset) {
  if (Number(plan?.initialEntryEffectsVersion || 0) >= INITIAL_ENTRY_EFFECTS_VERSION) return { plan, changed: false };
  const next = clone(plan);
  const root = next.stateNodes[next.initialStateNodeId];
  if (!root) throw new Error("The plan has no initial state for switch-in ability resolution");
  const generation = Number(dataset.mechanics?.damageGeneration || 5);
  const events = [];
  for (const entry of initialEntryOrder(next, root)) {
    const otherSide = entry.side === "player" ? "enemy" : "player";
    const opponents = activeKeys(root, otherSide).filter(key => Number(root.combatantStates[key]?.hp?.max) > 0);
    const firstOpponent = opponents[0] || null;
    const opposingStates = opponents.map(key => entryComparisonState(next, root, key));
    const firstEffects = entryAbilityEffects({
      enteringState: root.combatantStates[entry.combatantKey],
      opposingState: opposingStates[0] || null,
      opposingStates,
      generation
    });
    const targetsEachOpponent = firstEffects.some(effect => effect.target === "opponent" || effect.kind === "intimidate-blocked");
    if (targetsEachOpponent) {
      for (const opposingKey of opponents) {
        const effects = entryAbilityEffects({
          enteringState: root.combatantStates[entry.combatantKey],
          opposingState: entryComparisonState(next, root, opposingKey),
          opposingStates,
          generation
        });
        for (const effect of effects) applyInitialEntryEffect(root, events, entry.combatantKey, entry.side, effect, opposingKey);
      }
    } else {
      for (const effect of firstEffects) applyInitialEntryEffect(root, events, entry.combatantKey, entry.side, effect, firstOpponent);
    }
  }
  next.resolutionEvents ||= {};
  root.resolutionEventIds = [];
  events.forEach((rawEvent, index) => {
    const eventId = `event-initial-${index + 1}-${shortHash(stableStringify(rawEvent))}`;
    next.resolutionEvents[eventId] = { eventId, turnNumber: 0, step: index + 1, ...rawEvent };
    root.resolutionEventIds.push(eventId);
  });
  next.initialEntryEffectsVersion = INITIAL_ENTRY_EFFECTS_VERSION;
  updateStateHash(root);
  return { plan: assertValidPlanDocument(next), changed: true };
}

function sideSnapshot(side, key, combatants) {
  const mon = combatants[key];
  return {
    combatantKey: key,
    speciesId: mon.speciesId,
    displayName: mon.nickname || mon.displayName,
    spriteId: mon.formId || mon.speciesId,
    action: null
  };
}

export function createPlanDocument({
  name,
  dataset,
  trainerId,
  trainerVariantId = null,
  playerCombatants,
  enemyCombatants,
  playerActiveKey = playerCombatants[0]?.combatantKey,
  enemyActiveKey = enemyCombatants[0]?.combatantKey,
  playerActiveKeys = null,
  enemyActiveKeys = null,
  battleFormat = null,
  sourceSnapshot,
  initialConditions = {},
  now = nowIso()
}) {
  const format = normalizeBattleFormat(battleFormat || dataset.trainerBattleFormat?.(trainerId) || "singles");
  const required = slotsPerSide(format);
  const selectedPlayerKeys = (playerActiveKeys || [playerActiveKey, ...playerCombatants.slice(1).map(mon => mon.combatantKey)]).slice(0, required);
  const selectedEnemyKeys = (enemyActiveKeys || [enemyActiveKey, ...enemyCombatants.slice(1).map(mon => mon.combatantKey)]).slice(0, required);
  if (selectedPlayerKeys.length !== required || selectedEnemyKeys.length !== required || selectedPlayerKeys.some(key => !key) || selectedEnemyKeys.some(key => !key)) {
    throw new Error(`${format} requires ${required} active Pokémon per side`);
  }
  if (new Set(selectedPlayerKeys).size !== required || new Set(selectedEnemyKeys).size !== required) throw new Error("Active slots must contain distinct Pokémon");
  const combatants = Object.fromEntries([...playerCombatants, ...enemyCombatants].map(mon => [mon.combatantKey, clone(mon)]));
  const root = createInitialState({ combatants, playerActiveKeys: selectedPlayerKeys, enemyActiveKeys: selectedEnemyKeys, battleFormat: format, initialConditions });
  root.displaySnapshot.players = selectedPlayerKeys.map(key => sideSnapshot("player", key, combatants));
  root.displaySnapshot.enemies = selectedEnemyKeys.map(key => sideSnapshot("enemy", key, combatants));
  if (format === "singles") {
    root.displaySnapshot.player = root.displaySnapshot.players[0];
    root.displaySnapshot.enemy = root.displaySnapshot.enemies[0];
  }
  const identity = { gameId: dataset.gameId, trainerId, trainerVariantId, sourceSnapshot };
  const plan = {
    kind: "pokemon-battle-plan",
    schemaVersion: 2,
    planId: makeStableId("plan", identity),
    name: name || `${dataset.displayName} Battle Plan`,
    createdAt: now,
    updatedAt: now,
    documentRevision: 0,
    game: { gameId: dataset.gameId, battleFormat: format, trainerId, trainerVariantId },
    mechanicsFingerprint: currentMechanicsFingerprint(dataset),
    sourceSnapshot: clone(sourceSnapshot || {}),
    combatants,
    initialStateNodeId: root.stateNodeId,
    stateNodes: { [root.stateNodeId]: root },
    actionGroups: {},
    replacementTransitions: {},
    resolutionEvents: {},
    workingDraft: null,
    initialEntryEffectsVersion: 0
  };
  return upgradeInitialEntryEffects(plan, dataset).plan;
}

export function planHasWork(plan) {
  return Number(plan?.documentRevision) > 0 || Object.keys(plan?.actionGroups || {}).length > 0 || Boolean(plan?.workingDraft);
}

export function actionSignature(parentStateNodeId, actions) {
  return `actions-${shortHash(stableStringify({ parentStateNodeId, actions }))}`;
}

export function nextCreatedOrder(plan) {
  return Math.max(
    0,
    ...Object.values(plan.stateNodes).map(node => Number(node.createdOrder) || 0),
    ...Object.values(plan.actionGroups).map(group => Number(group.createdOrder) || 0),
    ...Object.values(plan.replacementTransitions || {}).map(transition => Number(transition.createdOrder) || 0)
  ) + 1;
}

export function updateStateHash(state) {
  state.stateHash = `state-${shortHash(stableStringify({
    active: state.active,
    combatantStates: state.combatantStates,
    experienceState: state.experienceState || null,
    fieldState: state.fieldState,
    pendingReplacementSlots: state.pendingReplacementSlots || [],
    battleEnded: Boolean(state.battleEnded)
  }))}`;
  return state;
}

export function touchPlan(plan, now = nowIso()) {
  plan.documentRevision = Number(plan.documentRevision || 0) + 1;
  plan.updatedAt = now;
  return plan;
}

export function setStateNodeNote(plan, stateNodeId, field, value, now = nowIso()) {
  if (!plan?.stateNodes?.[stateNodeId]) throw new Error(`State ${stateNodeId} is unavailable`);
  if (!["notes", "draftNote"].includes(field)) throw new Error(`Unsupported state note field ${field}`);
  const text = String(value ?? "");
  if (text.length > 4096) throw new Error("Node notes cannot exceed 4096 characters");
  plan.stateNodes[stateNodeId][field] = text;
  touchPlan(plan, now);
  return plan;
}
