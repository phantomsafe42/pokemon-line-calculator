import { clone, normalizeRange, shortHash, stableStringify, toId } from "./primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { effectiveCombatantMove, fieldAdjustedMove } from "./combatant_moves.js?v=20260907-two-turn-immunity-v1";
import { forcedTurnAction, forcedTurnActionAllows } from "./forced_actions.js?v=20260907-two-turn-immunity-v1";
import { createDefaultVolatiles, normalizeFieldCondition, resetTurnFlags, updateStateHash } from "./plan.js?v=20260905-drafts-freecalc-partners-v1";
import { actionEntries, actionList, activeEntries, activeKey, activeKeys, activeSlotEntries, actorSlot, battleFormat, pendingReplacementSlots, replacementList, setActiveKey, setPendingReplacementSlots, slotsPerSide } from "./battle_slots.js?v=20260905-drafts-freecalc-partners-v1";
import { belongsToSlotParty, eligibleReserves, partyOwnerForSlot } from "./party_ownership.js?v=20260905-drafts-freecalc-partners-v1";
import { moveSupport as defaultMoveSupport } from "../rulesets/core_move_support.js?v=20260907-two-turn-immunity-v1";
import {
  criticalHitProbability,
  endOfTurnSupportIssue,
  effectiveAccuracy,
  itemResidualRule,
  protectSuccessProbability,
  semiInvulnerabilityResult,
  statusApplicationResult,
  statusResidualRule,
  weatherIsSuppressed,
  weatherResidualRule
} from "../rulesets/battle_rules.js?v=20260907-two-turn-immunity-v1";
import {
  applyExactHpChange,
  entryAbilityEffects,
  entryHazardEffects,
  isGrounded,
  moveImmunity,
  outgoingSwitchEffects
} from "../rulesets/switch_rules.js?v=20260907-two-turn-immunity-v1";
import { applyDefeatedEnemyExperience, registerSwitchExperienceParticipation } from "../rulesets/vw2r_experience.js?v=20260905-drafts-freecalc-partners-v1";
import { actionOrderAlternatives, applyActionOrderState, effectiveActionSpeed, effectiveMovePriority } from "../rulesets/action_order.js?v=20260905-drafts-freecalc-partners-v1";
import { adjacentActiveEntries, areSlotsAdjacent, canSelectShift, combatantsAreAdjacent, shiftWithCenter, triplePositionForSlot, tripleSlotForPosition, TRIPLE_POSITIONS } from "../rulesets/triple_battle.js?v=20260905-drafts-freecalc-partners-v1";
import { participatingActiveEntries, participatingActiveKeys, rotateToActor, rotationFrontKey, rotationFrontSlot } from "../rulesets/rotation_battle.js?v=20260905-drafts-freecalc-partners-v1";
import {
  abilityActionRule,
  abilityAfterDamagingHit,
  abilityAfterFaintEffect,
  abilityEndOfTurnEffect,
  abilityStatStageRule,
  abilityStatusImmunity,
  activeAbilityId,
  trappingAbilityBlocksSwitch
} from "../rulesets/ability_rules.js?v=20260905-drafts-freecalc-partners-v1";
import { applyCombatantFormState, desiredWeatherAbilityForm, desiredZenModeForm, restoreCombatantIdentityState } from "../rulesets/form_rules.js?v=20260905-drafts-freecalc-partners-v1";
import { afterDamagingMoveItemActivation, damageReductionItemActivation } from "../rulesets/item_rules.js?v=20260909-item-consumption-v1";

const TRACE_BLOCKED_ABILITIES = new Set(["", "flowergift", "forecast", "illusion", "imposter", "multitype", "stancechange", "trace", "wonderguard", "zenmode"]);

function participantEntries(state) {
  return participatingActiveEntries(state);
}

function participantKeys(state, side) {
  return participatingActiveKeys(state, side);
}

export class ResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResolutionError";
  }
}

function sideActiveKey(state, side) {
  return participantKeys(state, side)[0] || null;
}

function opposite(side) {
  return side === "player" ? "enemy" : "player";
}

function stageMultiplier(stage) {
  const value = Math.max(-6, Math.min(6, Number(stage || 0)));
  return value >= 0 ? (2 + value) / 2 : 2 / (2 - value);
}

export function effectiveSpeed(combatant, state, generation = 5) {
  return effectiveActionSpeed({ combatant, combatantState: state, generation });
}

function currentCalculatedStat(plan, state, combatantKey, stat) {
  const combatantState = state.combatantStates[combatantKey];
  return Number(combatantState?.calculatedStatOverrides?.[stat] ?? combatantState?.currentStats?.[stat] ?? plan.combatants[combatantKey]?.calculatedStats?.[stat] ?? 0);
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

function actionPriority(action, dataset, plan, state) {
  if (action.actionType === "switch") return 6;
  const combatant = plan.combatants[action.actorKey];
  const combatantState = state.combatantStates[action.actorKey];
  const move = effectiveCombatantMove(dataset, combatant, combatantState, action.moveId);
  return effectiveMovePriority({ action, move, combatantState, generation: Number(dataset.mechanics?.damageGeneration || 5) });
}

function actionSide(action, plan) {
  return plan.combatants[action.actorKey]?.side || action.side || null;
}

function orderedActions(plan, state, actions, dataset) {
  const generation = Number(dataset.mechanics?.damageGeneration || 5);
  const trickRoom = Number(state.fieldState?.global?.trickRoomTurns || 0) > 0;
  const activeCombatantStates = participantEntries(state).map(entry => state.combatantStates[entry.combatantKey]).filter(Boolean);
  const suppressedWeather = weatherIsSuppressed(activeCombatantStates);
  const baseEntries = actionEntries(state, actions).map(entry => {
    const combatant = plan.combatants[entry.action.actorKey];
    const combatantState = state.combatantStates[combatant.combatantKey];
    const move = entry.action.actionType === "move" ? effectiveCombatantMove(dataset, combatant, combatantState, entry.action.moveId) : null;
    const speed = effectiveActionSpeed({ combatant, combatantState, battleState: state, side: entry.side, generation, weatherSuppressed: suppressedWeather });
    let priority = actionPriority(entry.action, dataset, plan, state);
    if (entry.action.actionType === "move" && entry.action.moveId === "pursuit") {
      const targetKey = entry.action.targetKeys?.[0];
      if (actionEntries(state, actions).some(candidate => candidate.action.actorKey === targetKey && candidate.action.actionType === "switch")) priority = 7;
    }
    return { ...entry, priority, speed, orderAlternatives: actionOrderAlternatives({ action: entry.action, move, combatantState, battleState: state, generation }) };
  });

  let configurations = [{ entries: [], probability: 1, conditions: [] }];
  for (const entry of baseEntries) {
    configurations = configurations.flatMap(configuration => entry.orderAlternatives.map(alternative => ({
      entries: [...configuration.entries, { ...entry, fractionalPriority: Number(alternative.fractionalPriority || 0), orderAlternative: alternative }],
      probability: probabilityProduct(configuration.probability, alternative.probability),
      conditions: alternative.orderEvent
        ? [...configuration.conditions, `order:${entry.action.actorKey}:${alternative.orderEvent.modifierId}:${alternative.orderEvent.activated ? "activated" : "not-activated"}`]
        : [...configuration.conditions]
    })));
  }

  let orders = [];
  for (const configuration of configurations) {
    const entries = [...configuration.entries].sort((left, right) =>
      right.priority - left.priority
      || right.fractionalPriority - left.fractionalPriority
      || (trickRoom ? left.speed - right.speed : right.speed - left.speed)
      || left.side.localeCompare(right.side)
      || left.slot - right.slot
    );
    let variants = [{ entries: [], probability: configuration.probability, conditions: configuration.conditions }];
    let tieGroupNumber = 0;
    for (let index = 0; index < entries.length;) {
      let end = index + 1;
      while (end < entries.length
        && entries[end].priority === entries[index].priority
        && entries[end].fractionalPriority === entries[index].fractionalPriority
        && entries[end].speed === entries[index].speed) end += 1;
      const tied = entries.slice(index, end);
      const tieGroup = tied.length > 1 ? `tie-${++tieGroupNumber}` : null;
      variants = variants.map(order => ({
        entries: [...order.entries, ...tied.map(entry => ({ ...entry, tieGroup }))],
        probability: order.probability,
        conditions: tied.length > 1 ? [...order.conditions, `speed-tie:${tied.map(candidate => candidate.action.actorKey).join(",")}`] : [...order.conditions]
      }));
      index = end;
    }
    orders.push(...variants);
  }
  if (orders.length > 256) throw new ResolutionError("Action-order modifier branching exceeds the safe exact limit");
  return orders;
}

function canonicalTarget(move) {
  return String(move?.target || "normal").toLowerCase().replace(/[^a-z]/g, "");
}

function moveIgnoresDistance(targetMode, descriptor = {}) {
  return targetMode === "any" || descriptor.flags?.distance === 1 || descriptor.flags?.distance === true;
}

function legalTargetKeys(state, side, actorKey, targetMode, legalIncomingTargets = [], format = "singles", descriptor = {}) {
  if (format === "rotation") {
    const opponentSide = opposite(side);
    const opposingFront = rotationFrontKey(state, opponentSide);
    if (targetMode === "adjacentally") return [];
    if (targetMode === "adjacentallyorself") return [actorKey];
    if (targetMode === "any") return [opposingFront].filter(key => key && Number(state.combatantStates[key]?.hp?.max) > 0);
    return [opposingFront].filter(key => key && Number(state.combatantStates[key]?.hp?.max) > 0);
  }
  const actorPosition = actorSlot(state, side, actorKey);
  const own = activeSlotEntries(state, side).filter(entry => Number(state.combatantStates[entry.combatantKey]?.hp?.max) > 0);
  const opponentSide = opposite(side);
  const opponents = [
    ...activeSlotEntries(state, opponentSide),
    ...legalIncomingTargets.map(entry => typeof entry === "string" ? { combatantKey: entry, slot: -1 } : entry)
  ].filter(entry => Number(state.combatantStates[entry.combatantKey]?.hp?.max) > 0);
  const adjacent = (entry, targetSide) => areSlotsAdjacent(format, side, actorPosition, targetSide, entry.slot);
  if (targetMode === "adjacentally") return own.filter(entry => entry.combatantKey !== actorKey && adjacent(entry, side)).map(entry => entry.combatantKey);
  if (targetMode === "adjacentallyorself") return own.filter(entry => entry.combatantKey === actorKey || adjacent(entry, side)).map(entry => entry.combatantKey);
  if (targetMode === "any") return [...opponents, ...own.filter(entry => entry.combatantKey !== actorKey)].map(entry => entry.combatantKey);
  if (moveIgnoresDistance(targetMode, descriptor)) return opponents.map(entry => entry.combatantKey);
  return opponents.filter(entry => adjacent(entry, opponentSide)).map(entry => entry.combatantKey);
}

function validateAction(side, slot, action, plan, state, dataset, moveSupport, legalIncomingTargets = []) {
  if (!action || !["move", "switch", "shift"].includes(action.actionType)) throw new ResolutionError(`${side} needs a Move, Switch, or Shift action`);
  const actorActiveKey = activeKey(state, side, slot);
  if (action.actorKey !== actorActiveKey) throw new ResolutionError(`${side} action actor is not the active Pokémon`);
  const actor = plan.combatants[actorActiveKey];
  const actorState = state.combatantStates[actorActiveKey];
  if (!actor || !actorState || Number(actorState.hp?.max) <= 0) throw new ResolutionError(`${side} active Pokémon has fainted`);
  const forcedAction = forcedTurnAction(actorState);
  if (forcedAction && !forcedTurnActionAllows(action, forcedAction)) {
    throw new ResolutionError(forcedAction.kind === "recharge"
      ? `${actor.displayName} must recharge`
      : `${actor.displayName} must continue ${forcedAction.moveId}`);
  }
  if (forcedAction?.kind === "recharge") return;
  if (action.actionType === "switch") {
    if (Number(state.fieldState?.global?.fairyLockTurns || 0) > 0) throw new ResolutionError("Fairy Lock prevents switching this turn");
    if (battleFormat(plan) === "rotation" && slot !== rotationFrontSlot(state, side)) throw new ResolutionError(`${side} can switch only its front Pokémon`);
    const target = plan.combatants[action.switchToKey];
    const targetState = state.combatantStates[action.switchToKey];
    if (!belongsToSlotParty(plan, target, side, slot)) throw new ResolutionError(`${side} switch target is invalid for this trainer's slot`);
    if (activeKeys(state, side).includes(target.combatantKey)) throw new ResolutionError(`${side} switch target is already active`);
    if (!targetState || Number(targetState.hp?.max) <= 0) throw new ResolutionError(`${side} switch target has fainted`);
    const heldItem = actorState.itemState === "held" ? toId(actorState.currentItemId) : "";
    if ((action.switchKind || "voluntary") === "voluntary" && heldItem !== "shedshell") {
      for (const opposingKey of participantKeys(state, opposite(side))) {
        const opposingState = state.combatantStates[opposingKey];
        if (!opposingState || Number(opposingState.hp?.max) <= 0) continue;
        const trappingAbility = trappingAbilityBlocksSwitch({ sourceState: opposingState, targetState: actorState, fieldState: state.fieldState });
        if (trappingAbility) throw new ResolutionError(`${readableMechanicName(trappingAbility)} prevents ${actor.displayName} from switching`);
      }
    }
    return;
  }
  if (action.actionType === "shift") {
    if (!canSelectShift(plan, state, side, actorActiveKey)) throw new ResolutionError(`${actor.displayName} cannot Shift from the center position`);
    return;
  }
  const move = effectiveCombatantMove(dataset, actor, actorState, action.moveId);
  const knownMoves = actorState.moveSetOverride || actor.moves;
  if (!move || !knownMoves.some(entry => entry.moveId === action.moveId)) throw new ResolutionError(`${actor.displayName} does not know ${action.moveId}`);
  if (Number(actorState.volatileConditions?.tauntTurns || 0) > 0 && String(move.category).toLowerCase() === "status") throw new ResolutionError(`${actor.displayName} is taunted`);
  if (actorState.volatileConditions?.disabledMoveId === action.moveId) throw new ResolutionError(`${move.name} is disabled`);
  if (actorState.volatileConditions?.encoredMoveId && actorState.volatileConditions.encoredMoveId !== action.moveId) throw new ResolutionError(`${actor.displayName} must use its encored move`);
  if (actorState.volatileConditions?.choiceLockedMoveId && actorState.volatileConditions.choiceLockedMoveId !== action.moveId) throw new ResolutionError(`${actor.displayName} is locked into another move`);
  if (Number(actorState.volatileConditions?.bideTurns || 0) > 0 && action.moveId !== "bide") throw new ResolutionError(`${actor.displayName} must continue Bide`);
  if (Number(actorState.volatileConditions?.uproarTurns || 0) > 0 && action.moveId !== "uproar") throw new ResolutionError(`${actor.displayName} must continue Uproar`);
  if (actorState.volatileConditions?.thrashMoveId && action.moveId !== actorState.volatileConditions.thrashMoveId) throw new ResolutionError(`${actor.displayName} must continue its locked move`);
  const continuingMove = action.moveId === "bide" && Number(actorState.volatileConditions?.bideTurns || 0) > 0
    || actorState.volatileConditions?.chargingMoveId === action.moveId
    || Number(dataset.mechanics?.damageGeneration) === 4 && (actorState.volatileConditions?.thrashMoveId === action.moveId || action.moveId === 'uproar' && actorState.volatileConditions?.uproarTurns > 0);
  if (!continuingMove && Number(actorState.movePp?.[action.moveId] || 0) <= 0) throw new ResolutionError(`${move.name} has no PP`);
  const support = moveSupport(move, dataset);
  if (!support.supported) throw new ResolutionError(support.reason);
  const chargingMoveId = actorState.volatileConditions?.chargingMoveId;
  if (chargingMoveId && chargingMoveId !== action.moveId) throw new ResolutionError(`${actor.displayName} must continue ${chargingMoveId}`);
  if (actorState.volatileConditions?.torment && actorState.lastMoveId === action.moveId) throw new ResolutionError(`${actor.displayName} cannot repeat a move under Torment`);
  if (Number(actorState.volatileConditions?.healBlockTurns || 0) > 0 && support.flags?.heal) throw new ResolutionError(`${actor.displayName} cannot use a healing move under Heal Block`);
  const imprisoned = participantKeys(state, opposite(side)).some(key => {
    const opponentState = state.combatantStates[key];
    const opponent = plan.combatants[key];
    return opponentState?.volatileConditions?.imprison
      && (opponentState.moveSetOverride || opponent.moves).some(entry => entry.moveId === action.moveId);
  });
  if (imprisoned) throw new ResolutionError(`${move.name} is sealed by Imprison`);
  const targetMode = support.targetMode || canonicalTarget(move);
  const supportTarget = support.target || (["all", "alladjacent", "alladjacentfoes", "scripted"].includes(targetMode) ? "automatic" : "target");
  if (supportTarget === "target") {
    const legal = legalTargetKeys(state, side, actorActiveKey, targetMode, legalIncomingTargets, battleFormat(plan), support);
    if (legal.length && (!Array.isArray(action.targetKeys) || action.targetKeys.length !== 1 || !legal.includes(action.targetKeys[0]))) {
      throw new ResolutionError(`${move.name} needs one legal active target`);
    }
    if (!legal.length && Array.isArray(action.targetKeys) && action.targetKeys.length) {
      throw new ResolutionError(`${move.name} has no legal target in this position`);
    }
  }
  if (support.operations?.some(operation => operation.kind === "self-switch")) {
    const switchToKey = action.mechanicActivations?.find(entry => entry?.id === "after-move-switch")?.switchToKey;
    const replacement = plan.combatants[switchToKey];
    if (!belongsToSlotParty(plan, replacement, side, slot) || activeKeys(state, side).includes(switchToKey) || Number(state.combatantStates[switchToKey]?.hp?.max) <= 0) {
      throw new ResolutionError(`${move.name} needs a legal after-move switch-in`);
    }
  }
}

export function validateTurnActions({ plan, parentState, actions, dataset, moveSupport = defaultMoveSupport }) {
  const pending = pendingReplacementSlots(parentState);
  if (pending.length) {
    throw new ResolutionError(`Resolve forced replacement for ${pending.map(entry => `${entry.side} slot ${entry.slot + 1}`).join(" and ")} before selecting turn actions`);
  }
  const actuallyEnded = ["player", "enemy"].some(side => !Object.values(plan.combatants).some(combatant =>
    combatant.side === side && Number(parentState.combatantStates[combatant.combatantKey]?.hp?.max) > 0
  ));
  if (actuallyEnded) throw new ResolutionError("The battle has ended");
  const requiredSlots = [];
  for (const side of ["player", "enemy"]) {
    const sideActions = actionList(actions, side);
    const entries = activeSlotEntries(parentState, side).filter(entry => Number(parentState.combatantStates[entry.combatantKey]?.hp?.max) > 0);
    const requiredCount = battleFormat(plan) === "rotation" ? 1 : entries.length;
    if (sideActions.length !== requiredCount) throw new ResolutionError(`${side} needs ${requiredCount} action${requiredCount === 1 ? "" : "s"}`);
    const switchTargets = sideActions.filter(action => action.actionType === "switch").map(action => action.switchToKey);
    if (new Set(switchTargets).size !== switchTargets.length) throw new ResolutionError(`${side} cannot switch both slots to the same Pokémon`);
    const legalIncomingTargets = actionList(actions, opposite(side)).filter(action => action.actionType === "switch").map(action => ({
      combatantKey: action.switchToKey,
      slot: actorSlot(parentState, opposite(side), action.actorKey)
    }));
    for (const action of sideActions) {
      const slot = actorSlot(parentState, side, action.actorKey);
      validateAction(side, slot, action, plan, parentState, dataset, moveSupport, legalIncomingTargets);
      requiredSlots.push({ side, slot, actorKey: action.actorKey });
    }
  }
  return { ready: true, requiredSides: ["player", "enemy"], requiredSlots };
}

function probabilityProduct(left, right) {
  if (left === null || right === null || left === undefined || right === undefined) return null;
  return Number(left) * Number(right);
}

const RANDOM_STATUS_COUNTERS = Object.freeze([2, 3, 4, 5]);

function normalizedCounterDistribution(entries) {
  if (!Array.isArray(entries)) return null;
  const grouped = new Map();
  for (const entry of entries) {
    const value = Math.floor(Number(entry?.value));
    const probability = Number(entry?.probability);
    if (!Number.isFinite(value) || value < 1 || !Number.isFinite(probability) || probability <= 0) continue;
    grouped.set(value, (grouped.get(value) || 0) + probability);
  }
  const total = [...grouped.values()].reduce((sum, probability) => sum + probability, 0);
  if (!total) return null;
  return [...grouped.entries()].sort((left, right) => left[0] - right[0]).map(([value, probability]) => ({ value, probability: probability / total }));
}

function uniformStatusCounterDistribution() {
  return RANDOM_STATUS_COUNTERS.map(value => ({ value, probability: 1 / RANDOM_STATUS_COUNTERS.length }));
}

function statusCounterDistribution(volatiles, kind) {
  const distributionKey = `${kind}CounterDistribution`;
  const current = normalizedCounterDistribution(volatiles?.[distributionKey]);
  if (current) return current;
  const legacyValue = Number(volatiles?.[`${kind}Turns`]);
  if (Number.isFinite(legacyValue) && legacyValue >= 0) {
    const value = kind === "sleep" ? legacyValue + 1 : legacyValue;
    return value >= 1 ? [{ value, probability: 1 }] : null;
  }
  return kind === "sleep" ? [{ value: 2, probability: 1 }] : null;
}

function setStatusCounterDistribution(volatiles, kind, entries) {
  const normalized = normalizedCounterDistribution(entries);
  volatiles[`${kind}CounterDistribution`] = normalized;
  volatiles[`${kind}Turns`] = normalized?.length === 1
    ? Math.max(0, normalized[0].value - (kind === "sleep" ? 1 : 0))
    : null;
  return normalized;
}

function advanceStatusCounter(entries) {
  const current = normalizedCounterDistribution(entries) || [];
  let endedProbability = 0;
  const active = [];
  for (const entry of current) {
    const value = entry.value - 1;
    if (value <= 0) endedProbability += entry.probability;
    else active.push({ value, probability: entry.probability });
  }
  const activeProbability = Math.max(0, 1 - endedProbability);
  return {
    endedProbability,
    activeProbability,
    activeDistribution: activeProbability > 0
      ? active.map(entry => ({ value: entry.value, probability: entry.probability / activeProbability }))
      : null
  };
}

function distributionFor(state) {
  if (Array.isArray(state.hpDistribution) && state.hpDistribution.length) return state.hpDistribution;
  const hp = normalizeRange(state.hp);
  if (hp.min === hp.max) return [{ value: hp.min, probability: 1 }];
  return null;
}

function setHpDistribution(state, entries) {
  const grouped = new Map();
  for (const entry of entries) grouped.set(entry.value, (grouped.get(entry.value) || 0) + Number(entry.probability || 0));
  const total = [...grouped.values()].reduce((sum, value) => sum + value, 0) || 1;
  state.hpDistribution = [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([value, probability]) => ({ value, probability: probability / total }));
  const values = state.hpDistribution.map(entry => entry.value);
  state.hp = { min: Math.min(...values), max: Math.max(...values), maxHp: state.hp.maxHp };
}

function clampStage(value) {
  return Math.max(-6, Math.min(6, Number(value || 0)));
}

function event(branch, details) {
  const next = { ...details, source: "planned", changes: details.changes || [], metadata: details.metadata || {} };
  branch.events.push(next);
  return next;
}

function applyAbilityAwareStatStages(branch, {
  actorKey,
  targetKey,
  statStages,
  generation = 5,
  moveId = null,
  cause = null,
  target = null
}) {
  const affectedState = branch.state.combatantStates[targetKey];
  if (!affectedState) return [];
  const changes = [];
  let reaction = null;
  for (const [stat, requestedDelta] of Object.entries(statStages || {})) {
    const rule = abilityStatStageRule({ targetState: affectedState, sourceKey: actorKey, targetKey, stat, requestedDelta, generation });
    if (rule.blockedBy) {
      event(branch, {
        eventType: "ability-blocked",
        actorKey: targetKey,
        targetKey,
        moveId,
        metadata: { cause: rule.blockedBy, blockedStat: stat, resultLabel: `${readableMechanicName(rule.blockedBy)} prevented the stat drop` }
      });
      continue;
    }
    const from = clampStage(affectedState.statStages[stat]);
    const to = clampStage(from + Number(rule.delta));
    affectedState.statStages[stat] = to;
    changes.push({
      path: `combatantStates.${targetKey}.statStages.${stat}`,
      stat,
      from,
      to,
      requestedDelta: Number(requestedDelta),
      appliedDelta: to - from
    });
    if (rule.reaction && to < from) reaction = rule.reaction;
  }
  if (changes.length) {
    event(branch, {
      eventType: "stat-stage-change",
      actorKey,
      targetKey,
      moveId,
      changes,
      metadata: {
        ...(target ? { target } : {}),
        ...(cause ? { cause } : {}),
        resultLabel: changes.map(change => `${STAT_LABELS[change.stat] || change.stat} ${change.appliedDelta >= 0 ? "+" : ""}${change.appliedDelta}`).join(", ")
      }
    });
  }
  if (reaction) {
    applyAbilityAwareStatStages(branch, {
      actorKey: targetKey,
      targetKey,
      statStages: { [reaction.stat]: reaction.delta },
      generation,
      cause: reaction.cause
    });
  }
  return changes;
}

function readableMechanicName(value) {
  const compact = toId(value);
  const known = {
    baddreams: "Bad Dreams", clearbody: "Clear Body", cursedbody: "Cursed Body", dryskin: "Dry Skin",
    effectspore: "Effect Spore", flamebody: "Flame Body", flashfire: "Flash Fire", fullmetalbody: "Full Metal Body",
    icebody: "Ice Body", ironbarbs: "Iron Barbs", lightningrod: "Lightning Rod", motordrive: "Motor Drive",
    poisonpoint: "Poison Point", raindish: "Rain Dish", roughskin: "Rough Skin", sapsipper: "Sap Sipper",
    shedskin: "Shed Skin", solarpower: "Solar Power", speedboost: "Speed Boost", stormdrain: "Storm Drain",
    suctioncups: "Suction Cups", waterabsorb: "Water Absorb", weakarmor: "Weak Armor"
  }[compact];
  if (known) return known;
  return String(value || "recovery")
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function percentRange(range, maxHp) {
  const maximum = Number(maxHp);
  if (!range || !Number.isFinite(maximum) || maximum <= 0) return null;
  return { min: Number(range.min) / maximum * 100, max: Number(range.max) / maximum * 100 };
}

function actualHealingRange(before, after) {
  const previous = normalizeRange(before);
  const current = normalizeRange(after);
  return {
    min: Math.max(0, current.max - previous.max),
    max: Math.max(0, current.min - previous.min)
  };
}

function switchEvent(branch, details) {
  return event(branch, { actorKey: null, targetKey: null, moveId: null, ...details });
}

function transformCombatantState(branch, actorKey, targetKey, plan, { cause = "transform", moveId = null } = {}) {
  const actorState = branch.state.combatantStates[actorKey];
  const targetState = branch.state.combatantStates[targetKey];
  if (!actorState || !targetState) return false;
  actorState.currentAbilityId = targetState.currentAbilityId;
  actorState.currentSpeciesId = targetState.currentSpeciesId || plan.combatants[targetKey].speciesId;
  actorState.currentSpriteId = targetState.currentSpriteId || plan.combatants[targetKey].speciesId;
  actorState.currentTypeIds = [...targetState.currentTypeIds];
  actorState.statStages = { ...targetState.statStages };
  actorState.transformedIntoKey = targetKey;
  actorState.calculatedStatOverrides = {
    ...plan.combatants[targetKey].calculatedStats,
    ...(targetState.currentStats || {}),
    hp: currentCalculatedStat(plan, branch.state, actorKey, "hp")
  };
  actorState.moveSetOverride = plan.combatants[targetKey].moves.map(entry => ({ moveId: entry.moveId, maxPp: Math.min(5, entry.maxPp) }));
  actorState.movePp = Object.fromEntries(actorState.moveSetOverride.map(entry => [entry.moveId, entry.maxPp]));
  event(branch, {
    eventType: "ability-change",
    actorKey,
    targetKey,
    moveId,
    metadata: { cause, resultLabel: `Transformed into ${plan.combatants[targetKey].displayName}` }
  });
  return true;
}

function applySwitchEffect(branch, targetKey, side, effect, opposingKey = null, generation = 5, plan = null, dataset = null) {
  const targetState = branch.state.combatantStates[targetKey];
  if (effect.kind === "unsupported") throw new ResolutionError(effect.reason);
  if (effect.kind === "damage") {
    if (!targetState.abilitySuppressed && String(targetState.currentAbilityId || "").toLowerCase() === "magicguard") return [branch];
    return applyResidualDamage(branch, targetKey, { ...effect, eventType: "entry-hazard-damage" });
  }
  if (effect.kind === "heal") {
    const before = clone(targetState.hp);
    applyExactHpChange(targetState, effect.amount);
    const healingHp = actualHealingRange(before, targetState.hp);
    switchEvent(branch, { eventType: "switch-heal", targetKey, healingHp, healingPercent: percentRange(healingHp, targetState.hp.maxHp), metadata: { cause: effect.cause, resultLabel: `${readableMechanicName(effect.cause)} recovery` }, changes: [{ path: `combatantStates.${targetKey}.hp`, from: before, to: clone(targetState.hp) }] });
    return [branch];
  }
  if (effect.kind === "clear-status") {
    const previous = targetState.majorStatus;
    targetState.majorStatus = null;
    targetState.toxicCounter = 0;
    switchEvent(branch, { eventType: "status-cleared", targetKey, metadata: { cause: effect.cause, resultLabel: "Status cured" }, changes: [{ path: `combatantStates.${targetKey}.majorStatus`, from: previous, to: null }] });
    return [branch];
  }
  if (effect.kind === "absorb-toxic-spikes") {
    const hazards = branch.state.fieldState.sides[side].hazards;
    const previous = hazards.toxicSpikes;
    hazards.toxicSpikes = 0;
    switchEvent(branch, { eventType: "hazard-cleared", targetKey, metadata: { cause: effect.cause, resultLabel: "Toxic Spikes absorbed" }, changes: [{ path: `fieldState.sides.${side}.hazards.toxicSpikes`, from: previous, to: 0 }] });
    return [branch];
  }
  if (effect.kind === "status") {
    targetState.majorStatus = effect.statusId;
    targetState.toxicCounter = effect.statusId === "tox" ? 1 : 0;
    switchEvent(branch, { eventType: "major-status", targetKey, metadata: { cause: effect.cause, statusId: effect.statusId, resultLabel: `Inflicted ${effect.statusId.toUpperCase()}` }, changes: [{ path: `combatantStates.${targetKey}.majorStatus`, from: null, to: effect.statusId }] });
    return [branch];
  }
  if (effect.kind === "stat-stage") {
    const affectedKey = effect.target === "opponent" ? (opposingKey || sideActiveKey(branch.state, opposite(side))) : targetKey;
    applyAbilityAwareStatStages(branch, {
      actorKey: targetKey,
      targetKey: affectedKey,
      statStages: { [effect.stat]: effect.delta },
      generation,
      cause: effect.cause
    });
    return [branch];
  }
  if (effect.kind === "intimidate-blocked") {
    switchEvent(branch, { eventType: "ability-blocked", actorKey: targetKey, targetKey: opposingKey || sideActiveKey(branch.state, opposite(side)), metadata: { cause: effect.cause, resultLabel: "Intimidate blocked" } });
    return [branch];
  }
  if (effect.kind === "weather") {
    const previous = clone(branch.state.fieldState.global.weather);
    const condition = normalizeFieldCondition("weather", {
      id: effect.weatherId,
      source: `ability:${effect.cause}`,
      durationMode: effect.durationMode,
      remainingTurns: effect.remainingTurns
    });
    branch.state.fieldState.global.weather = condition;
    switchEvent(branch, { eventType: "field-change", actorKey: targetKey, metadata: { cause: effect.cause, fieldKind: "weather", fieldId: effect.weatherId, resultLabel: `${effect.weatherId} weather` }, changes: [{ path: "fieldState.global.weather", from: previous, to: clone(condition) }] });
    if (plan && dataset) refreshWeatherAbilityForms(branch, plan, dataset);
    return [branch];
  }
  if (effect.kind === "copy-opponent-ability") {
    const sourceState = branch.state.combatantStates[opposingKey];
    const copied = activeAbilityId(sourceState);
    if (!copied || TRACE_BLOCKED_ABILITIES.has(copied)) return [branch];
    const previous = targetState.currentAbilityId;
    targetState.currentAbilityId = copied;
    targetState.volatileConditions.tracePending = false;
    switchEvent(branch, {
      eventType: "ability-change",
      actorKey: targetKey,
      targetKey,
      metadata: { cause: effect.cause, copiedAbilityId: copied, resultLabel: `Copied ${readableMechanicName(copied)}` },
      changes: [{ path: `combatantStates.${targetKey}.currentAbilityId`, from: previous, to: copied }]
    });
    return [branch];
  }
  if (effect.kind === "transform-opponent") {
    const sourceState = branch.state.combatantStates[opposingKey];
    if (!plan || !sourceState || sourceState.volatileConditions?.substituteHp || sourceState.transformedIntoKey) return [branch];
    transformCombatantState(branch, targetKey, opposingKey, plan, { cause: effect.cause });
    return [branch];
  }
  return [branch];
}

function formChangeEvent(branch, combatantKey, form, changes) {
  if (!changes.length) return;
  event(branch, {
    eventType: "form-change",
    actorKey: combatantKey,
    targetKey: combatantKey,
    moveId: null,
    changes: changes.map(change => ({ path: `combatantStates.${combatantKey}.${change.field}`, from: change.from, to: change.to })),
    metadata: {
      cause: form.cause,
      speciesId: form.speciesId,
      spriteId: form.spriteId,
      resultLabel: `${readableMechanicName(form.cause)} changed form`
    }
  });
}

function updateFlowerGiftSideState(branch) {
  for (const side of ["player", "enemy"]) {
    branch.state.fieldState.sides[side].isFlowerGift = participantKeys(branch.state, side).some(combatantKey => {
      const state = branch.state.combatantStates[combatantKey];
      return Number(state?.hp?.max) > 0
        && activeAbilityId(state) === "flowergift"
        && state.currentSpriteId === "cherrim-sunshine";
    });
  }
}

function refreshWeatherAbilityForms(branch, plan, dataset) {
  const suppressed = weatherIsSuppressed(activeStates(branch));
  for (const entry of participantEntries(branch.state)) {
    const state = branch.state.combatantStates[entry.combatantKey];
    if (!state || state.transformedIntoKey) continue;
    const form = desiredWeatherAbilityForm({
      combatant: plan.combatants[entry.combatantKey],
      state,
      fieldState: branch.state.fieldState,
      weatherSuppressed: suppressed
    });
    const changes = applyCombatantFormState({ combatant: plan.combatants[entry.combatantKey], state, dataset, form });
    formChangeEvent(branch, entry.combatantKey, form, changes);
  }
  updateFlowerGiftSideState(branch);
  return branch;
}

function reconcileChangedAbilities(branch, combatantKeys, plan, dataset) {
  for (const combatantKey of combatantKeys.filter(Boolean)) {
    const state = branch.state.combatantStates[combatantKey];
    if (!state) continue;
    state.volatileConditions.tracePending = activeAbilityId(state) === "trace";
    if (!state.transformedIntoKey
      && state.currentSpeciesId === "darmanitanzen"
      && activeAbilityId(state) !== "zenmode") {
      const form = desiredZenModeForm({ combatant: plan.combatants[combatantKey], state });
      const changes = applyCombatantFormState({ combatant: plan.combatants[combatantKey], state, dataset, form });
      formChangeEvent(branch, combatantKey, form, changes);
    }
  }
  refreshWeatherAbilityForms(branch, plan, dataset);
  return resolvePendingTraceBranches(branch, plan, dataset);
}

function traceEligibleOpponents(branch, combatantKey, side, plan) {
  return participantKeys(branch.state, opposite(side)).filter(opposingKey => {
    const sourceState = branch.state.combatantStates[opposingKey];
    return Number(sourceState?.hp?.max) > 0
      && combatantsAreAdjacent(branch.state, side, combatantKey, opposite(side), opposingKey, plan)
      && !TRACE_BLOCKED_ABILITIES.has(activeAbilityId(sourceState));
  });
}

function applyEntryAbilityBranches(branch, combatantKey, side, plan, dataset, { entrySlot = null } = {}) {
  const state = branch.state.combatantStates[combatantKey];
  if (!state || Number(state.hp?.max) <= 0) return [branch];
  const generation = Number(dataset.mechanics?.damageGeneration || 5);
  const ability = activeAbilityId(state);
  if (ability === "trace" && state.volatileConditions?.tracePending === false) return [branch];
  if (ability === "trace" && state.volatileConditions?.tracePending !== false) {
    const eligible = traceEligibleOpponents(branch, combatantKey, side, plan);
    if (!eligible.length) return [branch];
    return eligible.flatMap(opposingKey => {
      const next = eligible.length > 1 ? clone(branch) : branch;
      if (eligible.length > 1) {
        next.probability = probabilityProduct(next.probability, 1 / eligible.length);
        next.probabilityStatus = next.probability === null ? "unknown" : "known";
      }
      const targetState = next.state.combatantStates[combatantKey];
      const copied = activeAbilityId(next.state.combatantStates[opposingKey]);
      const previous = targetState.currentAbilityId;
      targetState.currentAbilityId = copied;
      targetState.volatileConditions.tracePending = false;
      next.conditions.push(`trace:${combatantKey}:${opposingKey}:${copied}`);
      event(next, {
        eventType: "ability-change",
        actorKey: combatantKey,
        targetKey: combatantKey,
        moveId: null,
        changes: [{ path: `combatantStates.${combatantKey}.currentAbilityId`, from: previous, to: copied }],
        metadata: { cause: "trace", copiedAbilityId: copied, copiedFromKey: opposingKey, resultLabel: `Copied ${readableMechanicName(copied)}` }
      });
      return applyEntryAbilityBranches(next, combatantKey, side, plan, dataset, { entrySlot });
    });
  }
  const opponents = participantKeys(branch.state, opposite(side)).filter(key => Number(branch.state.combatantStates[key]?.hp?.max) > 0);
  const opposingStates = opponents.map(key => entryComparisonState(plan, branch.state, key));
  const firstEffects = entryAbilityEffects({ enteringState: state, opposingState: opposingStates[0] || null, opposingStates, generation });
  const targetsEachOpponent = firstEffects.some(effect => effect.target === "opponent" || effect.kind === "intimidate-blocked");
  let branches = [branch];
  if (targetsEachOpponent) {
    const eligibleOpponents = ability === "intimidate"
      ? opponents.filter(opposingKey => combatantsAreAdjacent(branch.state, side, combatantKey, opposite(side), opposingKey, plan))
      : opponents;
    for (const opposingKey of eligibleOpponents) {
      branches = branches.flatMap(current => {
        const currentOpposingStates = opponents.map(key => entryComparisonState(plan, current.state, key));
        const effects = entryAbilityEffects({ enteringState: current.state.combatantStates[combatantKey], opposingState: entryComparisonState(plan, current.state, opposingKey), opposingStates: currentOpposingStates, generation });
        let affected = [current];
        for (const effect of effects) affected = affected.flatMap(next => applySwitchEffect(next, combatantKey, side, effect, opposingKey, generation, plan, dataset));
        return affected;
      });
    }
  } else {
    const opposingKey = ability === "imposter"
      ? activeKey(branch.state, opposite(side), Number.isInteger(entrySlot) ? entrySlot : actorSlot(branch.state, side, combatantKey)) || opponents[0] || null
      : opponents[0] || null;
    for (const effect of firstEffects) branches = branches.flatMap(current => applySwitchEffect(current, combatantKey, side, effect, opposingKey, generation, plan, dataset));
  }
  return branches.map(current => refreshWeatherAbilityForms(current, plan, dataset));
}

function resolvePendingTraceBranches(branch, plan, dataset) {
  let branches = [branch];
  for (const entry of participantEntries(branch.state)) {
    branches = branches.flatMap(current => {
      const state = current.state.combatantStates[entry.combatantKey];
      return activeAbilityId(state) === "trace" && state?.volatileConditions?.tracePending !== false
        ? applyEntryAbilityBranches(current, entry.combatantKey, entry.side, plan, dataset, { entrySlot: entry.slot })
        : [current];
    });
  }
  return branches;
}

function applySwitch(branch, side, slot, action, plan, dataset) {
  const outgoingKey = activeKey(branch.state, side, slot);
  let outgoingState = branch.state.combatantStates[outgoingKey];
  const sleepCounterStart = outgoingState.majorStatus === "slp"
    ? normalizedCounterDistribution(outgoingState.volatileConditions?.sleepCounterStartDistribution)
      || statusCounterDistribution(outgoingState.volatileConditions, "sleep")
    : null;
  const batonPassState = action.switchMode === "copyvolatile" ? {
    statStages: clone(outgoingState.statStages),
    volatileConditions: clone(outgoingState.volatileConditions)
  } : null;
  if (batonPassState) {
    batonPassState.volatileConditions.protectStreak = 0;
    batonPassState.volatileConditions.rechargeRequired = false;
    batonPassState.volatileConditions.chargingMoveId = null;
    batonPassState.volatileConditions.selfDestructResolved = false;
  }
  let branches = [branch];
  const switchKind = action.switchKind || "voluntary";
  if (switchKind !== "forced") {
    for (const effect of outgoingSwitchEffects(outgoingState)) {
      branches = branches.flatMap(current => applySwitchEffect(current, outgoingKey, side, effect, null, Number(dataset.mechanics?.damageGeneration || 5), plan, dataset));
    }
  }
  branch = branches[0];
  outgoingState = branch.state.combatantStates[outgoingKey];
  const outgoing = plan.combatants[outgoingKey];
  outgoingState.statStages = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
  outgoingState.volatileConditions = createDefaultVolatiles();
  if (sleepCounterStart) {
    setStatusCounterDistribution(outgoingState.volatileConditions, "sleep", sleepCounterStart);
    outgoingState.volatileConditions.sleepCounterStartDistribution = clone(sleepCounterStart);
  }
  outgoingState.currentAbilityId = outgoing.originalAbilityId;
  outgoingState.abilitySuppressed = false;
  restoreCombatantIdentityState({ combatant: outgoing, state: outgoingState, dataset });
  outgoingState.lastMoveId = null;
  outgoingState.lastHitMoveId = null;
  outgoingState.lastHitSourceKey = null;
  outgoingState.usedMoveIds = [];
  delete outgoingState.moveSetOverride;
  delete outgoingState.transformedIntoKey;
  if (outgoingState.majorStatus === "tox") outgoingState.toxicCounter = 1;
  setActiveKey(branch.state, side, slot, action.switchToKey);
  registerSwitchExperienceParticipation(branch.state, side, action.switchToKey);
  event(branch, {
    eventType: "switch",
    actorKey: outgoingKey,
    targetKey: action.switchToKey,
    moveId: null,
    metadata: { side, slot, switchKind, displayName: plan.combatants[action.switchToKey].displayName }
  });
  const enteringState = branch.state.combatantStates[action.switchToKey];
  const entering = plan.combatants[action.switchToKey];
  enteringState.currentAbilityId = entering.originalAbilityId;
  enteringState.abilitySuppressed = false;
  restoreCombatantIdentityState({ combatant: entering, state: enteringState, dataset });
  enteringState.volatileConditions.tracePending = activeAbilityId(enteringState) === "trace";
  enteringState.enteredTurnNumber = Number(branch.state.turnNumber || 0) + 1;
  if (batonPassState) {
    enteringState.statStages = batonPassState.statStages;
    enteringState.volatileConditions = { ...enteringState.volatileConditions, ...batonPassState.volatileConditions };
  }
  const generation = Number(dataset.mechanics?.damageGeneration || 5);
  const hazards = entryHazardEffects({ state: enteringState, fieldState: branch.state.fieldState, side, dataset, generation });
  branches = [branch];
  for (const effect of hazards) branches = branches.flatMap(current => applySwitchEffect(current, action.switchToKey, side, effect, null, generation, plan, dataset));
  branches = branches.flatMap(current => Number(current.state.combatantStates[action.switchToKey].hp?.max) <= 0
    ? [current]
    : applyEntryAbilityBranches(current, action.switchToKey, side, plan, dataset, { entrySlot: slot }));
  for (const current of branches) {
    const slotEffects = current.state.fieldState.sides[side].slotEffects || {};
    const slotEffect = slotEffects[slot];
    if (slotEffect && Number(current.state.combatantStates[action.switchToKey].hp?.max) > 0) {
      const switchedInState = current.state.combatantStates[action.switchToKey];
      setExactCurrentHp(switchedInState, switchedInState.hp.maxHp);
      clearStatus(switchedInState);
      if (slotEffect.restorePp) {
        switchedInState.movePp = Object.fromEntries((switchedInState.moveSetOverride || entering.moves).map(entry => [entry.moveId, entry.maxPp]));
      }
      delete slotEffects[slot];
      switchEvent(current, {
        eventType: "slot-heal",
        targetKey: action.switchToKey,
        metadata: { cause: slotEffect.id, resultLabel: slotEffect.restorePp ? "HP, status, and PP restored" : "HP and status restored" }
      });
    }
  }
  branches = branches.flatMap(current => resolvePendingTraceBranches(current, plan, dataset));
  for (const current of branches) refreshWeatherAbilityForms(current, plan, dataset);
  return branches;
}

function applyShift(branch, side, action) {
  const actorKey = action.actorKey;
  const actorState = branch.state.combatantStates[actorKey];
  if (!actorState || Number(actorState.hp?.max) <= 0) return skipped(branch, actorKey, "actor-fainted-before-shifting");
  const shift = shiftWithCenter(branch.state, side, actorKey);
  if (!shift) return skipped(branch, actorKey, "actor-no-longer-on-edge");
  setActiveKey(branch.state, side, shift.fromSlot, shift.centerKey || null);
  setActiveKey(branch.state, side, shift.centerSlot, actorKey);
  actorState.turnFlags.hasMoved = true;
  event(branch, {
    eventType: "shift",
    actorKey,
    targetKey: shift.centerKey || null,
    moveId: null,
    changes: [
      { path: `active.${side}CombatantKeys.${shift.fromSlot}`, from: actorKey, to: shift.centerKey || null },
      { path: `active.${side}CombatantKeys.${shift.centerSlot}`, from: shift.centerKey || null, to: actorKey }
    ],
    metadata: { side, fromSlot: shift.fromSlot, toSlot: shift.centerSlot, resultLabel: `Shifted to ${shift.centerSlot + 1}` }
  });
  return [branch];
}

function applyRotationSelections(branch, actions, plan, dataset) {
  if (battleFormat(plan) !== "rotation") return branch;
  for (const side of ["player", "enemy"]) {
    const action = actionList(actions, side)[0];
    if (!action || action.actionType !== "move") continue;
    const rotation = rotateToActor(branch.state, side, action.actorKey);
    if (!rotation?.changed) continue;
    event(branch, {
      eventType: "rotation",
      actorKey: action.actorKey,
      targetKey: null,
      moveId: action.moveId || null,
      changes: [{ path: `rotation.frontSlots.${side}`, from: rotation.fromSlot, to: rotation.toSlot }],
      metadata: {
        side,
        fromSlot: rotation.fromSlot,
        toSlot: rotation.toSlot,
        priority: 6,
        resultLabel: `Rotated to Slot ${rotation.toSlot + 1}`
      }
    });
  }
  refreshWeatherAbilityForms(branch, plan, dataset);
  return branch;
}

function markMoved(branch, actorKey, moveId, consumePp = true) {
  const state = branch.state.combatantStates[actorKey];
  state.turnFlags.hasMoved = true;
  state.lastMoveId = moveId;
  state.usedMoveIds ||= [];
  if (!state.usedMoveIds.includes(moveId)) state.usedMoveIds.push(moveId);
  branch.state.fieldState.global.lastMoveId = moveId;
  if (consumePp) state.movePp[moveId] = Math.max(0, Number(state.movePp[moveId] || 0) - 1);
}

function recordBideDamage(state, actorKey, amount) {
  const volatiles = state.volatileConditions || {};
  if (Number(volatiles.bideTurns || 0) <= 0 || Number(amount) <= 0) return;
  volatiles.bideDamage = Number(volatiles.bideDamage || 0) + Number(amount);
  volatiles.bideSourceKey = actorKey;
}

function applyDestinyBond(branch, faintedKey, sourceKey, move) {
  const faintedState = branch.state.combatantStates[faintedKey];
  const sourceState = branch.state.combatantStates[sourceKey];
  if (!faintedState?.volatileConditions?.destinybond || !sourceState || Number(sourceState.hp?.max) <= 0 || faintedKey === sourceKey) return;
  setExactCurrentHp(sourceState, 0);
  event(branch, {
    eventType: "destiny-bond",
    actorKey: faintedKey,
    targetKey: sourceKey,
    moveId: move.id,
    metadata: { resultLabel: "Destiny Bond knocked out the attacker" }
  });
}

function abilityReactionStatusAllowed(branch, targetKey, statusId) {
  const state = branch.state.combatantStates[targetKey];
  if (!state || state.majorStatus) return false;
  const types = (state.currentTypeIds || []).map(toId);
  if (statusId === "brn" && types.includes("fire")) return false;
  if (["psn", "tox"].includes(statusId) && (types.includes("poison") || types.includes("steel"))) return false;
  return !abilityStatusImmunity({ state, statusId, fieldState: branch.state.fieldState });
}

function applyAbilityReactionStatus(branch, sourceKey, targetKey, statusId, cause) {
  if (!abilityReactionStatusAllowed(branch, targetKey, statusId)) return branch;
  const targetState = branch.state.combatantStates[targetKey];
  targetState.majorStatus = statusId;
  targetState.toxicCounter = statusId === "tox" ? 1 : 0;
  if (statusId === "slp") {
    const distribution = uniformStatusCounterDistribution();
    setStatusCounterDistribution(targetState.volatileConditions, "sleep", distribution);
    targetState.volatileConditions.sleepCounterStartDistribution = clone(distribution);
  }
  event(branch, {
    eventType: "major-status",
    actorKey: sourceKey,
    targetKey,
    moveId: null,
    changes: [{ path: `combatantStates.${targetKey}.majorStatus`, from: null, to: statusId }],
    metadata: { cause, statusId, resultLabel: `${readableMechanicName(cause)} inflicted ${statusId.toUpperCase()}` }
  });
  return branch;
}

function applyAbilityHitEffect(branch, effect, targetKey, sourceKey, move) {
  const targetState = branch.state.combatantStates[targetKey];
  const sourceState = branch.state.combatantStates[sourceKey];
  if (effect.kind === "stat-stage") {
    applyAbilityAwareStatStages(branch, { actorKey: targetKey, targetKey, statStages: { [effect.stat]: effect.delta }, generation: Number(branch.generation || 5), cause: effect.cause });
    return [branch];
  }
  if (effect.kind === "set-stage") {
    const from = clampStage(targetState.statStages[effect.stat]);
    const to = clampStage(effect.value);
    targetState.statStages[effect.stat] = to;
    event(branch, { eventType: "stat-stage-change", actorKey: targetKey, targetKey, moveId: move.id, changes: [{ path: `combatantStates.${targetKey}.statStages.${effect.stat}`, from, to, stat: effect.stat, appliedDelta: to - from }], metadata: { cause: effect.cause, resultLabel: `${STAT_LABELS[effect.stat] || effect.stat} ${to - from >= 0 ? "+" : ""}${to - from}` } });
    return [branch];
  }
  if (effect.kind === "damage-source") {
    if (!sourceState || Number(sourceState.hp?.max) <= 0) return [branch];
    return applyResidualDamage(branch, sourceKey, { ...effect, actorKey: targetKey });
  }
  if (effect.kind === "replace-source-ability") {
    if (!sourceState || Number(sourceState.hp?.max) <= 0 || ["multitype", "stancechange"].includes(activeAbilityId(sourceState))) return [branch];
    const previous = sourceState.currentAbilityId;
    sourceState.currentAbilityId = effect.abilityId;
    event(branch, { eventType: "ability-change", actorKey: targetKey, targetKey: sourceKey, moveId: move.id, changes: [{ path: `combatantStates.${sourceKey}.currentAbilityId`, from: previous, to: effect.abilityId }], metadata: { cause: effect.cause, resultLabel: `${readableMechanicName(effect.cause)} replaced the attacker's Ability` } });
    return [branch];
  }
  if (effect.kind === "disable-source-move") {
    if (!sourceState || Number(sourceState.hp?.max) <= 0) return [branch];
    return probabilityBranch(branch, Number(effect.chance), applied => {
      applied.state.combatantStates[sourceKey].volatileConditions.disabledMoveId = move.id;
      applied.state.combatantStates[sourceKey].volatileConditions.disableTurns = 4;
      event(applied, { eventType: "volatile-status", actorKey: targetKey, targetKey: sourceKey, moveId: move.id, metadata: { cause: effect.cause, volatileStatusId: "disable", resultLabel: `${move.name} was disabled` } });
    });
  }
  if (effect.kind === "status") {
    if (!abilityReactionStatusAllowed(branch, sourceKey, effect.statusId)) return [branch];
    return probabilityBranch(branch, Number(effect.chance), applied => applyAbilityReactionStatus(applied, targetKey, sourceKey, effect.statusId, effect.cause));
  }
  if (effect.kind === "random-status") {
    const statuses = effect.statuses.filter(statusId => abilityReactionStatusAllowed(branch, sourceKey, statusId));
    const perStatus = Number(effect.chance) / Math.max(1, effect.statuses.length);
    const outcomes = statuses.map(statusId => {
      const applied = clone(branch);
      applied.probability = probabilityProduct(branch.probability, perStatus);
      applied.probabilityStatus = applied.probability === null ? "unknown" : "known";
      return applyAbilityReactionStatus(applied, targetKey, sourceKey, statusId, effect.cause);
    });
    const noEffectProbability = Math.max(0, 1 - perStatus * statuses.length);
    if (noEffectProbability > 0) {
      const noEffect = clone(branch);
      noEffect.probability = probabilityProduct(branch.probability, noEffectProbability);
      noEffect.probabilityStatus = noEffect.probability === null ? "unknown" : "known";
      outcomes.push(noEffect);
    }
    return outcomes;
  }
  if (effect.kind === "attract") {
    const sourceCombatant = branch.planCombatants?.[sourceKey];
    const targetCombatant = branch.planCombatants?.[targetKey];
    const sourceGender = toId(sourceCombatant?.gender);
    const targetGender = toId(targetCombatant?.gender);
    if (!sourceGender || !targetGender || sourceGender === targetGender || activeAbilityId(sourceState) === "oblivious") return [branch];
    return probabilityBranch(branch, Number(effect.chance), applied => {
      applied.state.combatantStates[sourceKey].volatileConditions.attractSourceKey = targetKey;
      event(applied, { eventType: "volatile-status", actorKey: targetKey, targetKey: sourceKey, moveId: move.id, metadata: { cause: effect.cause, volatileStatusId: "attract", resultLabel: `${readableMechanicName(effect.cause)} caused infatuation` } });
    });
  }
  return [branch];
}

function applyDamageReactions(branch, targetKey, sourceKey, move, fainted, criticalHit = false, descriptor = {}) {
  const targetState = branch.state.combatantStates[targetKey];
  const sourceState = branch.state.combatantStates[sourceKey];
  if (targetState?.volatileConditions?.rage && !fainted) {
    const from = clampStage(targetState.statStages.atk);
    const to = clampStage(from + 1);
    targetState.statStages.atk = to;
    event(branch, { eventType: "stat-stage-change", actorKey: targetKey, targetKey, moveId: "rage", metadata: { cause: "rage", resultLabel: `Attack +${to - from}` } });
  }
  if (fainted && targetState?.volatileConditions?.grudge && sourceState?.movePp && move?.id in sourceState.movePp) {
    sourceState.movePp[move.id] = 0;
    event(branch, { eventType: "pp-change", actorKey: targetKey, targetKey: sourceKey, moveId: move.id, metadata: { cause: "grudge", resultLabel: `${move.name} lost all PP` } });
  }
  let branches = [branch];
  const reactionMove = { ...move, flags: { ...(move.flags || {}), ...(descriptor.flags || {}) } };
  for (const effect of abilityAfterDamagingHit({ targetState, move: reactionMove, criticalHit, fainted, generation: Number(branch.generation || 5) })) {
    branches = branches.flatMap(current => applyAbilityHitEffect(current, effect, targetKey, sourceKey, move));
  }
  if (fainted) {
    branches = branches.map(current => {
      const currentSource = current.state.combatantStates[sourceKey];
      const faintEffect = Number(currentSource?.hp?.max) > 0 ? abilityAfterFaintEffect(currentSource) : null;
      if (faintEffect) applyAbilityAwareStatStages(current, { actorKey: sourceKey, targetKey: sourceKey, statStages: { [faintEffect.stat]: faintEffect.delta }, generation: Number(current.generation || 5), cause: faintEffect.cause });
      return current;
    });
  }
  return branches;
}

function applySubstituteDamage(branch, { actorKey, targetKey, move, damageValues, damageDistribution, criticalHit, criticalHits, criticalHitProbability: critProbability }) {
  const targetState = branch.state.combatantStates[targetKey];
  const substituteHp = Math.max(1, Number(targetState.volatileConditions.substituteHp || 0));
  const rolls = damageValues.map(Number).filter(value => Number.isFinite(value) && value >= 0);
  const rollEntries = Array.isArray(damageDistribution) && damageDistribution.length
    ? damageDistribution.map(entry => ({ damage: Number(entry.damage), probability: Number(entry.probability) })).filter(entry => Number.isFinite(entry.damage) && Number.isFinite(entry.probability) && entry.probability > 0)
    : rolls.map(damage => ({ damage, probability: 1 / Math.max(1, rolls.length) }));
  if (!rollEntries.length) throw new ResolutionError(`${move.name} returned no usable substitute damage rolls`);
  const grouped = new Map();
  for (const roll of rollEntries) {
    const remaining = Math.max(0, substituteHp - roll.damage);
    const current = grouped.get(remaining) || { probability: 0, damages: [] };
    current.probability += roll.probability;
    current.damages.push(roll.damage);
    grouped.set(remaining, current);
  }
  return [...grouped.entries()].map(([remaining, details]) => {
    const next = clone(branch);
    next.probability = probabilityProduct(branch.probability, details.probability);
    next.probabilityStatus = next.probability === null ? "unknown" : "known";
    next.state.combatantStates[targetKey].volatileConditions.substituteHp = remaining;
    next.substituteAbsorbedTargetKey = targetKey;
    event(next, {
      eventType: remaining ? "substitute-damage" : "substitute-broken",
      actorKey,
      targetKey,
      moveId: move.id,
      damageHp: { min: Math.min(...details.damages), max: Math.max(...details.damages) },
      metadata: { substituteHp: remaining, criticalHit, criticalHits, criticalHitProbability: critProbability, resultLabel: remaining ? `Substitute has ${remaining} HP` : "Substitute broke" }
    });
    return next;
  });
}

function skipped(branch, actorKey, reason) {
  event(branch, { eventType: "action-skipped", actorKey, targetKey: null, moveId: null, reason });
  return [branch];
}

function normalizedDamageDistribution(entries, fallbackDamage) {
  const grouped = new Map();
  for (const entry of entries || []) {
    const damage = Number(entry.damage ?? entry.actualDamage);
    const probability = Number(entry.probability);
    if (!Number.isFinite(damage) || damage < 0 || !Number.isFinite(probability) || probability <= 0) continue;
    grouped.set(damage, (grouped.get(damage) || 0) + probability);
  }
  if (!grouped.size && Number.isFinite(Number(fallbackDamage))) grouped.set(Number(fallbackDamage), 1);
  const total = [...grouped.values()].reduce((sum, probability) => sum + probability, 0);
  return [...grouped.entries()].sort((left, right) => left[0] - right[0]).map(([damage, probability]) => ({
    damage,
    probability: probability / total
  }));
}

function markDamageTaken(branch, targetKey, actorKey, move, damageEntries, fallbackDamage = 0) {
  const state = branch.state.combatantStates[targetKey];
  const distribution = normalizedDamageDistribution(damageEntries, fallbackDamage);
  const damageMax = distribution.length ? Math.max(...distribution.map(entry => entry.damage)) : 0;
  const damaged = damageMax > 0;
  if (!damaged) return;
  state.turnFlags.wasDamaged = true;
  state.turnFlags.hpLostThisTurn = true;
  state.turnFlags.damageTaken = damageMax;
  state.turnFlags.damagingHitsTaken = Number(state.turnFlags.damagingHitsTaken || 0) + 1;
  state.turnFlags.lastDamageSourceKey = actorKey;
  state.turnFlags.lastDamageCategory = String(move.category || "").toLowerCase();
  const sourceSide = branch.planCombatants?.[actorKey]?.side || null;
  const sourceSlot = sourceSide ? actorSlot(branch.state, sourceSide, actorKey) : -1;
  state.turnFlags.damageHistory ||= [];
  state.turnFlags.damageHistory.push({
    sourceKey: actorKey,
    sourceSide,
    sourceSlot: sourceSlot >= 0 ? sourceSlot : null,
    moveId: move.id,
    category: String(move.category || "").toLowerCase(),
    damage: { min: Math.min(...distribution.map(entry => entry.damage)), max: damageMax },
    damageDistribution: distribution,
    sequence: state.turnFlags.damageHistory.length
  });
}

function retaliationPolicy(dataset, move, handlerId) {
  const generation = Number(dataset.mechanics?.damageGeneration || 5);
  const declared = dataset.mechanics?.runtimeInputs?.moves?.[toId(move?.id)]?.retaliationPolicy;
  if (declared?.kind === "retaliation") return declared;
  return {
    kind: "retaliation",
    generation,
    damageClass: handlerId === "counter-damage" ? "physical" : handlerId === "mirror-coat-damage" ? "special" : "any",
    damageMultiplierNumerator: handlerId === "metal-burst-damage" ? 3 : 2,
    damageMultiplierDenominator: handlerId === "metal-burst-damage" ? 2 : 1,
    selection: generation >= 5
      ? "newest-to-oldest-current-turn-damage-records-filter-allies-and-static-move-category"
      : "generation-specific-last-damage-source",
    sourceMustStillHaveHP: generation < 5,
    fallback: generation === 4
      ? "random-opponent-then-no-target-script"
      : generation >= 5
        ? "source-mon-if-present; otherwise-recorded-position-occupant; otherwise-default-Pound-target-position-occupant; otherwise-original-source-mon"
        : "none",
    followMe: generation < 5 ? "live-follow-me-before-remembered-source" : "no-follow-me-read-in-this-handler; common-event-pipeline-remains-separate"
  };
}

function retaliationRecord(state, actorKey, side, policy) {
  const history = state.combatantStates[actorKey]?.turnFlags?.damageHistory || [];
  const opposing = history.filter(record => record.sourceSide ? record.sourceSide !== side : record.sourceKey !== actorKey);
  if (!opposing.length) return null;
  const categoryMatches = record => policy.damageClass === "any" || record.category === policy.damageClass;
  if (String(policy.selection || "").startsWith("newest-to-oldest")) {
    return [...opposing].reverse().find(categoryMatches) || null;
  }
  const latest = opposing.at(-1);
  return latest && categoryMatches(latest) ? latest : null;
}

function activeLivingKey(state, side, key) {
  return participantKeys(state, side).includes(key) && Number(state.combatantStates[key]?.hp?.max) > 0;
}

function retaliationTargetResolution(state, side, action, move, handlerId, plan, dataset, format) {
  const policy = retaliationPolicy(dataset, move, handlerId);
  const record = retaliationRecord(state, action.actorKey, side, policy);
  if (!record) return { targetKeys: [], redirects: [], retaliationRecord: null };
  const targetSide = opposite(side);
  if (String(policy.followMe || "").startsWith("live-follow-me")) {
    const redirector = participantKeys(state, targetSide).find(key => {
      const targetState = state.combatantStates[key];
      return Number(targetState?.hp?.max) > 0
        && (targetState.volatileConditions?.followme || targetState.volatileConditions?.ragepowder)
        && (format !== "triples" || combatantsAreAdjacent(state, side, action.actorKey, targetSide, key, format));
    });
    if (redirector) return {
      targetKeys: [redirector],
      redirects: redirector === record.sourceKey ? [] : [{ fromTargetKey: record.sourceKey, targetKey: redirector, reason: "attention-redirection" }],
      retaliationRecord: record
    };
  }
  if (activeLivingKey(state, targetSide, record.sourceKey)) {
    return { targetKeys: [record.sourceKey], redirects: [], retaliationRecord: record };
  }
  if (!policy.sourceMustStillHaveHP && Number.isInteger(record.sourceSlot)) {
    const occupant = activeKey(state, targetSide, record.sourceSlot);
    if (activeLivingKey(state, targetSide, occupant)) {
      return {
        targetKeys: [occupant],
        redirects: occupant === record.sourceKey ? [] : [{ fromTargetKey: record.sourceKey, targetKey: occupant, reason: "recorded-position-occupant" }],
        retaliationRecord: record
      };
    }
  }
  const livingOpponents = participantKeys(state, targetSide).filter(key => Number(state.combatantStates[key]?.hp?.max) > 0);
  if (String(policy.fallback || "").startsWith("random-opponent") && livingOpponents.length) {
    return {
      targetKeys: [livingOpponents[0]],
      redirects: [{ fromTargetKey: record.sourceKey, targetKey: livingOpponents[0], reason: "random-opponent-fallback" }],
      retaliationRecord: record,
      alternatives: livingOpponents.map(targetKey => ({
        targetKeys: [targetKey],
        redirects: [{ fromTargetKey: record.sourceKey, targetKey, reason: "random-opponent-fallback" }],
        retaliationRecord: record,
        probability: 1 / livingOpponents.length
      }))
    };
  }
  if (!policy.sourceMustStillHaveHP && livingOpponents.length) {
    return {
      targetKeys: [livingOpponents[0]],
      redirects: [{ fromTargetKey: record.sourceKey, targetKey: livingOpponents[0], reason: "default-target-fallback" }],
      retaliationRecord: record
    };
  }
  return { targetKeys: [], redirects: [], retaliationRecord: record };
}

function retaliationDamageDistribution(record, policy) {
  const numerator = Number(policy.damageMultiplierNumerator || 1);
  const denominator = Number(policy.damageMultiplierDenominator || 1);
  const source = record?.damageDistribution?.length
    ? record.damageDistribution
    : [{ damage: Number(record?.damage?.max || 0), probability: 1 }];
  return normalizedDamageDistribution(source.map(entry => ({
    damage: Math.max(1, Math.floor(Number(entry.damage) * numerator / denominator)),
    probability: entry.probability
  })), 0);
}

function markHpLostThisTurn(state, amount) {
  if (Number(amount) > 0) state.turnFlags.hpLostThisTurn = true;
}

function activeHeldItemId(state, fieldState) {
  if (state?.itemState !== "held") return "";
  if (Number(state.volatileConditions?.embargoTurns || 0) > 0) return "";
  if (Number(fieldState?.global?.magicRoomTurns || 0) > 0) return "";
  if (!state.abilitySuppressed && toId(state.currentAbilityId) === "klutz") return "";
  return toId(state.currentItemId);
}

function focusSashCanActivate(branch, targetState, move) {
  return toId(move?.id || move?.name) !== "confusion"
    && activeHeldItemId(targetState, branch.state.fieldState) === "focussash";
}

function sturdyCanActivate(branch, actorKey, targetState, move) {
  const attackerAbility = activeAbilityId(branch.state.combatantStates[actorKey]);
  return Number(branch.generation || 5) >= 5
    && toId(move?.id || move?.name) !== "confusion"
    && activeAbilityId(targetState) === "sturdy"
    && !["moldbreaker", "teravolt", "turboblaze"].includes(attackerAbility);
}

function recordSturdyActivation(branch, targetKey, move) {
  event(branch, {
    eventType: "ability-activated",
    actorKey: targetKey,
    targetKey,
    moveId: move.id,
    metadata: { cause: "sturdy", resultLabel: "Sturdy activated" }
  });
}

function consumeHeldItem(branch, { actorKey, holderKey, move, itemId, cause, resultLabel }) {
  const holderState = branch.state.combatantStates[holderKey];
  const heldItemId = toId(holderState?.currentItemId);
  if (!holderState || holderState.itemState !== "held" || heldItemId !== toId(itemId)) return false;
  const previousItemId = holderState.currentItemId;
  holderState.lastItemId = previousItemId;
  holderState.currentItemId = "";
  holderState.itemState = "consumed";
  event(branch, {
    eventType: "item-consumed",
    actorKey,
    targetKey: holderKey,
    moveId: move.id,
    metadata: { itemId: heldItemId, cause, resultLabel },
    changes: [
      { path: `combatantStates.${holderKey}.currentItemId`, from: previousItemId, to: "" },
      { path: `combatantStates.${holderKey}.itemState`, from: "held", to: "consumed" }
    ]
  });
  return true;
}

function consumeFocusSash(branch, actorKey, targetKey, move) {
  consumeHeldItem(branch, {
    actorKey,
    holderKey: targetKey,
    move,
    itemId: "focussash",
    cause: "survive-lethal-move",
    resultLabel: "Focus Sash activated"
  });
}

function consumeActivatedDamageReductionItem(branch, { actorKey, targetKey, move, dataset, appliedDefenderItemIds }) {
  const activation = damageReductionItemActivation({
    dataset,
    defenderState: branch.state.combatantStates[targetKey],
    appliedDefenderItemIds
  });
  if (!activation) return false;
  return consumeHeldItem(branch, {
    actorKey,
    holderKey: targetKey,
    move,
    itemId: activation.itemId,
    cause: activation.activationId,
    resultLabel: `${activation.itemName} activated`
  });
}

function consumeActivatedAfterDamagingMoveItem(branch, { actorKey, targetKey, move, dataset, damage, throughSubstitute = false }) {
  const targetState = branch.state.combatantStates[targetKey];
  const activation = afterDamagingMoveItemActivation({
    dataset,
    defenderState: targetState,
    activeItemId: activeHeldItemId(targetState, branch.state.fieldState),
    damage,
    throughSubstitute
  });
  if (!activation) return false;
  return consumeHeldItem(branch, {
    actorKey,
    holderKey: targetKey,
    move,
    itemId: activation.itemId,
    cause: activation.activationId,
    resultLabel: activation.consumptionMethod === "burst" ? `${activation.itemName} burst` : `${activation.itemName} activated`
  });
}

function applyDamage(branch, { actorKey, targetKey, move, damageValues, damageDistribution, damageSequenceDistribution, descriptor, effectiveBasePower, powerConditionMet, moveHits, dataset = null, appliedDefenderItemIds = [], criticalHit = false, criticalHits = 0, criticalHitProbability: critProbability = 0 }) {
  const targetState = branch.state.combatantStates[targetKey];
  if (targetKey !== actorKey && Number(targetState.volatileConditions?.substituteHp || 0) > 0 && !descriptor.flags?.sound && !descriptor.flags?.bypasssub) {
    const outcomes = applySubstituteDamage(branch, { actorKey, targetKey, move, damageValues, damageDistribution, criticalHit, criticalHits, criticalHitProbability: critProbability });
    for (const outcome of outcomes) {
      const substituteDamage = outcome.events.at(-1)?.damageHp?.max || 0;
      consumeActivatedAfterDamagingMoveItem(outcome, { actorKey, targetKey, move, dataset, damage: substituteDamage, throughSubstitute: true });
    }
    return outcomes;
  }
  const hpDistribution = distributionFor(targetState);
  const maxHp = Number(targetState.hp.maxHp);
  const targetHpBefore = clone(targetState.hp);
  const rolls = damageValues.map(Number).filter(value => Number.isFinite(value) && value >= 0);
  if (!rolls.length) throw new ResolutionError(`${move.name} returned no usable damage rolls`);
  const enduring = targetState.turnFlags.enduring === true;
  const rollEntries = Array.isArray(damageSequenceDistribution) && damageSequenceDistribution.length
    ? damageSequenceDistribution.map(entry => ({
      damage: Number(entry.damage),
      firstDamage: Number(entry.firstDamage),
      remainingDamage: Number(entry.remainingDamage),
      probability: Number(entry.probability)
    })).filter(entry => Number.isFinite(entry.damage) && entry.damage >= 0
      && Number.isFinite(entry.firstDamage) && entry.firstDamage >= 0
      && Number.isFinite(entry.remainingDamage) && entry.remainingDamage >= 0
      && Number.isFinite(entry.probability) && entry.probability > 0)
    : Array.isArray(damageDistribution) && damageDistribution.length
    ? damageDistribution.map(entry => ({ damage: Number(entry.damage), probability: Number(entry.probability) })).filter(entry => Number.isFinite(entry.damage) && entry.damage >= 0 && Number.isFinite(entry.probability) && entry.probability > 0)
    : rolls.map(damage => ({ damage, probability: 1 / rolls.length }));

  if (!hpDistribution) {
    const damageMin = Math.min(...rolls);
    const damageMax = Math.max(...rolls);
    const hp = normalizeRange(targetState.hp);
    const canKo = !enduring && damageMax >= hp.min;
    const canSurvive = damageMin < hp.max;
    const thresholdAmbiguous = canKo && canSurvive;
    const outcomes = [];
    if (canKo) {
      const ko = clone(branch);
      if (thresholdAmbiguous) {
        ko.probability = null;
        ko.probabilityStatus = "unknown";
      }
      ko.state.combatantStates[targetKey].hp = { min: 0, max: 0, maxHp };
      ko.state.combatantStates[targetKey].hpDistribution = [{ value: 0, probability: 1 }];
      consumeActivatedDamageReductionItem(ko, { actorKey, targetKey, move, dataset, appliedDefenderItemIds });
      markDamageTaken(ko, targetKey, actorKey, move, null, damageMax);
      recordBideDamage(ko.state.combatantStates[targetKey], actorKey, damageMax);
      event(ko, { eventType: "damage", actorKey, targetKey, moveId: move.id, damageHp: { min: damageMin, max: damageMax }, damagePercent: { min: damageMin / maxHp * 100, max: damageMax / maxHp * 100 }, metadata: { thresholdOutcome: "ko", criticalHit, criticalHits, criticalHitProbability: critProbability, effectiveBasePower, powerConditionMet, moveHits, targetHpBefore, damageRolls: rolls.slice(0, 512) } });
      consumeActivatedAfterDamagingMoveItem(ko, { actorKey, targetKey, move, dataset, damage: damageMax });
      const reacted = applyDamageReactions(ko, targetKey, actorKey, move, true, criticalHit, descriptor);
      for (const next of reacted) applyDestinyBond(next, targetKey, actorKey, move);
      outcomes.push(...reacted);
    }
    if (canSurvive) {
      const survive = clone(branch);
      if (thresholdAmbiguous) {
        survive.probability = null;
        survive.probabilityStatus = "unknown";
      }
      survive.state.combatantStates[targetKey].hp = { min: Math.max(1, hp.min - damageMax), max: Math.max(1, hp.max - damageMin), maxHp };
      delete survive.state.combatantStates[targetKey].hpDistribution;
      consumeActivatedDamageReductionItem(survive, { actorKey, targetKey, move, dataset, appliedDefenderItemIds });
      markDamageTaken(survive, targetKey, actorKey, move, null, damageMax);
      recordBideDamage(survive.state.combatantStates[targetKey], actorKey, damageMax);
      event(survive, { eventType: "damage", actorKey, targetKey, moveId: move.id, damageHp: { min: damageMin, max: damageMax }, damagePercent: { min: damageMin / maxHp * 100, max: damageMax / maxHp * 100 }, metadata: { thresholdOutcome: "survive", criticalHit, criticalHits, criticalHitProbability: critProbability, effectiveBasePower, powerConditionMet, moveHits, targetHpBefore, damageRolls: rolls.slice(0, 512) } });
      consumeActivatedAfterDamagingMoveItem(survive, { actorKey, targetKey, move, dataset, damage: damageMax });
      outcomes.push(...applyDamageReactions(survive, targetKey, actorKey, move, false, criticalHit, descriptor));
    }
    return outcomes;
  }

  const buckets = new Map();
  const focusSashActive = focusSashCanActivate(branch, targetState, move);
  const sturdyActive = sturdyCanActivate(branch, actorKey, targetState, move);
  for (const hpEntry of hpDistribution) {
    for (const roll of rollEntries) {
      const damage = roll.damage;
      const probability = Number(hpEntry.probability) * roll.probability;
      const nonlethal = branch.nonlethalCurrentMove === true;
      const hpBefore = Number(hpEntry.value);
      const firstDamage = Number.isFinite(roll.firstDamage) ? roll.firstDamage : damage;
      const remainingDamage = Number.isFinite(roll.remainingDamage) ? roll.remainingDamage : 0;
      const focusSashActivated = !enduring
        && !nonlethal
        && focusSashActive
        && hpBefore === maxHp
        && firstDamage >= hpBefore;
      const sturdyActivated = !enduring
        && !nonlethal
        && !focusSashActivated
        && sturdyActive
        && hpBefore === maxHp
        && firstDamage >= hpBefore;
      const remainingAfterFirst = focusSashActivated || sturdyActivated ? 1 : Math.max(enduring || nonlethal ? 1 : 0, hpBefore - firstDamage);
      const remaining = Math.max(enduring || nonlethal ? 1 : 0, remainingAfterFirst - remainingDamage);
      const kind = remaining === 0 ? "ko" : "survive";
      const survivalAbility = sturdyActivated ? "sturdy" : null;
      const bucketKey = `${kind}:${focusSashActivated ? "sash" : survivalAbility || "ordinary"}`;
      const entries = buckets.get(bucketKey) || { kind, focusSashActivated, survivalAbility, values: [] };
      entries.values.push({ value: remaining, probability, damage, actualDamage: Math.max(0, hpBefore - remaining) });
      buckets.set(bucketKey, entries);
    }
  }
  const outcomes = [];
  for (const { kind, focusSashActivated, survivalAbility, values: entries } of buckets.values()) {
    const localProbability = entries.reduce((sum, entry) => sum + entry.probability, 0);
    const next = clone(branch);
    next.probability = probabilityProduct(branch.probability, localProbability);
    next.probabilityStatus = next.probability === null ? "unknown" : "known";
    setHpDistribution(next.state.combatantStates[targetKey], entries.map(entry => ({ value: entry.value, probability: entry.probability / localProbability })));
    const damages = entries.map(entry => entry.damage);
    const damageMin = Math.min(...damages);
    const damageMax = Math.max(...damages);
    const target = next.state.combatantStates[targetKey];
    const actualDamageMax = Math.max(...entries.map(entry => entry.actualDamage));
    consumeActivatedDamageReductionItem(next, { actorKey, targetKey, move, dataset, appliedDefenderItemIds });
    if (focusSashActivated) consumeFocusSash(next, actorKey, targetKey, move);
    if (survivalAbility === "sturdy") recordSturdyActivation(next, targetKey, move);
    markDamageTaken(next, targetKey, actorKey, move, entries.map(entry => ({ damage: entry.actualDamage, probability: entry.probability })), actualDamageMax);
    recordBideDamage(target, actorKey, actualDamageMax);
    event(next, {
      eventType: "damage",
      actorKey,
      targetKey,
      moveId: move.id,
      damageHp: { min: damageMin, max: damageMax },
      damagePercent: { min: damageMin / maxHp * 100, max: damageMax / maxHp * 100 },
      metadata: { thresholdOutcome: kind, criticalHit, criticalHits, criticalHitProbability: critProbability, effectiveBasePower, powerConditionMet, moveHits, targetHpBefore, damageRolls: damages.slice(0, 512), focusSashActivated, sturdyActivated: survivalAbility === "sturdy" }
    });
    consumeActivatedAfterDamagingMoveItem(next, { actorKey, targetKey, move, dataset, damage: actualDamageMax });
    if (kind === "ko") applyDestinyBond(next, targetKey, actorKey, move);
    const reacted = applyDamageReactions(next, targetKey, actorKey, move, kind === "ko", criticalHit, descriptor);
    for (const reaction of reacted) {
      if (descriptor.effectId === "damage-with-recoil") {
        const [numerator, denominator] = descriptor.recoil;
        const recoilMin = Math.floor(damageMin * numerator / denominator);
        const recoilMax = Math.floor(damageMax * numerator / denominator);
        const actorHp = normalizeRange(reaction.state.combatantStates[actorKey].hp);
        const changed = reaction.state.combatantStates[actorKey];
        changed.hp = { min: Math.max(0, actorHp.min - recoilMax), max: Math.max(0, actorHp.max - recoilMin), maxHp: actorHp.maxHp };
        delete changed.hpDistribution;
        markHpLostThisTurn(changed, recoilMax);
        event(reaction, { eventType: "recoil", actorKey, targetKey: actorKey, moveId: move.id, damageHp: { min: recoilMin, max: recoilMax } });
      }
      outcomes.push(reaction);
    }
  }
  return outcomes;
}

const STAT_LABELS = Object.freeze({ atk: "Attack", def: "Defense", spa: "Sp. Atk", spd: "Sp. Def", spe: "Speed", accuracy: "Accuracy", evasion: "Evasion" });

function applySelfStatStages(branch, actorKey, move, descriptor) {
  applyAbilityAwareStatStages(branch, {
    actorKey,
    targetKey: actorKey,
    moveId: move.id,
    statStages: descriptor.statStages,
    generation: Number(branch.generation || 5),
    target: "self"
  });
  return [branch];
}

function applyStatStages(branch, actorKey, targetKey, move, operation) {
  const affectedKey = operation.target === "self" ? actorKey : targetKey;
  if (!affectedKey) throw new ResolutionError(`${move.name} has no stat-stage target`);
  applyAbilityAwareStatStages(branch, {
    actorKey,
    targetKey: affectedKey,
    moveId: move.id,
    statStages: operation.statStages,
    generation: Number(branch.generation || 5),
    target: operation.target
  });
  return [branch];
}

function applySelfHeal(branch, actorKey, move, descriptor) {
  const actorState = branch.state.combatantStates[actorKey];
  const maxHp = Number(actorState.hp.maxHp);
  const [numerator, denominator] = descriptor.heal;
  const requested = Math.floor(maxHp * Number(numerator) / Number(denominator));
  const hpDistribution = distributionFor(actorState);
  let healedValues;
  if (hpDistribution) {
    healedValues = hpDistribution.map(entry => Math.max(0, Math.min(requested, maxHp - Number(entry.value))));
    setHpDistribution(actorState, hpDistribution.map(entry => ({
      value: Math.min(maxHp, Number(entry.value) + requested),
      probability: entry.probability
    })));
  } else {
    const hp = normalizeRange(actorState.hp);
    healedValues = [Math.max(0, Math.min(requested, maxHp - hp.max)), Math.max(0, Math.min(requested, maxHp - hp.min))];
    actorState.hp = { min: Math.min(maxHp, hp.min + requested), max: Math.min(maxHp, hp.max + requested), maxHp };
    delete actorState.hpDistribution;
  }
  const healingHp = { min: Math.min(...healedValues), max: Math.max(...healedValues) };
  const resultLabel = healingHp.min === healingHp.max ? `Healed ${healingHp.min} HP` : `Healed ${healingHp.min}–${healingHp.max} HP`;
  event(branch, {
    eventType: "heal",
    actorKey,
    targetKey: actorKey,
    moveId: move.id,
    changes: [{ path: `combatantStates.${actorKey}.hp`, healingHp }],
    healingHp,
    healingPercent: percentRange(healingHp, maxHp),
    metadata: { target: "self", requestedHp: requested, resultLabel }
  });
  return [branch];
}

function applyFixedHeal(branch, combatantKey, move, requestedAmount, metadata = {}) {
  const state = branch.state.combatantStates[combatantKey];
  const maxHp = Number(state.hp.maxHp);
  const requested = Math.max(0, Math.floor(Number(requestedAmount || 0)));
  const before = distributionFor(state);
  let healedValues;
  if (before) {
    healedValues = before.map(entry => Math.max(0, Math.min(requested, maxHp - Number(entry.value))));
    setHpDistribution(state, before.map(entry => ({
      value: Math.min(maxHp, Number(entry.value) + requested),
      probability: entry.probability
    })));
  } else {
    const hp = normalizeRange(state.hp);
    healedValues = [Math.max(0, Math.min(requested, maxHp - hp.max)), Math.max(0, Math.min(requested, maxHp - hp.min))];
    state.hp = { min: Math.min(maxHp, hp.min + requested), max: Math.min(maxHp, hp.max + requested), maxHp };
    delete state.hpDistribution;
  }
  const healingHp = { min: Math.min(...healedValues), max: Math.max(...healedValues) };
  event(branch, {
    eventType: "heal",
    actorKey: metadata.actorKey || combatantKey,
    targetKey: combatantKey,
    moveId: move.id,
    changes: [{ path: `combatantStates.${combatantKey}.hp`, healingHp }],
    healingHp,
    healingPercent: percentRange(healingHp, maxHp),
    metadata: {
      target: metadata.target || (metadata.actorKey && metadata.actorKey !== combatantKey ? "target" : "self"),
      requestedHp: requested,
      resultLabel: healingHp.min === healingHp.max ? `Healed ${healingHp.min} HP` : `Healed ${healingHp.min}–${healingHp.max} HP`,
      ...metadata
    }
  });
  return [branch];
}

function applyProtect(branch, actorKey, move, descriptor, dataset, isLastAction) {
  const actorState = branch.state.combatantStates[actorKey];
  const streak = Number(actorState.volatileConditions?.protectStreak || 0);
  if (descriptor.failsIfLastAction && isLastAction) {
    actorState.turnFlags.protected = false;
    actorState.volatileConditions.protectStreak = 0;
    event(branch, {
      eventType: "protect",
      actorKey,
      targetKey: actorKey,
      moveId: move.id,
      metadata: { success: false, successProbability: 0, reason: "last-action", resultLabel: "Protect failed" }
    });
    return [branch];
  }
  const probability = protectSuccessProbability(dataset.mechanics?.damageGeneration, streak);
  const successful = clone(branch);
  successful.state.combatantStates[actorKey].turnFlags.protected = true;
  successful.state.combatantStates[actorKey].volatileConditions.protectStreak = streak + 1;
  successful.probability = probabilityProduct(branch.probability, probability);
  successful.probabilityStatus = successful.probability === null ? "unknown" : "known";
  event(successful, {
    eventType: "protect",
    actorKey,
    targetKey: actorKey,
    moveId: move.id,
    metadata: { success: true, successProbability: probability, resultLabel: "Protected" }
  });
  if (probability >= 1) return [successful];
  const failed = clone(branch);
  failed.state.combatantStates[actorKey].turnFlags.protected = false;
  failed.state.combatantStates[actorKey].volatileConditions.protectStreak = 0;
  failed.probability = probabilityProduct(branch.probability, 1 - probability);
  failed.probabilityStatus = failed.probability === null ? "unknown" : "known";
  event(failed, {
    eventType: "protect",
    actorKey,
    targetKey: actorKey,
    moveId: move.id,
    metadata: { success: false, successProbability: probability, resultLabel: "Protect failed" }
  });
  return [successful, failed];
}

function applyMajorStatus(branch, actorKey, targetKey, move, descriptor, dataset) {
  const targetState = branch.state.combatantStates[targetKey];
  if (descriptor.statusId === "slp" && activeAbilityId(targetState) !== 'soundproof' && activeStates(branch).some(state => Number(state.volatileConditions?.uproarTurns || 0) > 0)) {
    event(branch, { eventType: "status-failed", actorKey, targetKey, moveId: move.id, metadata: { statusId: "slp", reason: "uproar", resultLabel: "Uproar prevents sleep" } });
    return [branch];
  }
  const targetAbility = targetState.abilitySuppressed ? "" : String(targetState.currentAbilityId || "").toLowerCase();
  if (!descriptor.ignoreReaction && targetAbility === "magicbounce" && String(move.category || "status").toLowerCase() === "status" && actorKey !== targetKey) {
    event(branch, { eventType: "status-reflected", actorKey: targetKey, targetKey: actorKey, moveId: move.id, metadata: { cause: "magic-bounce", resultLabel: "Magic Bounce reflected the status" } });
    return applyMajorStatus(branch, targetKey, actorKey, move, { ...descriptor, ignoreReaction: true }, dataset);
  }
  const result = statusApplicationResult({
    descriptor,
    attackerState: branch.state.combatantStates[actorKey],
    targetState,
    fieldState: branch.state.fieldState,
    generation: dataset.mechanics?.damageGeneration
  });
  if (result.unsupported) throw new ResolutionError(result.reason);
  if (!result.applies) {
    event(branch, {
      eventType: "status-failed",
      actorKey,
      targetKey,
      moveId: move.id,
      metadata: { statusId: descriptor.statusId, reason: result.reason, resultLabel: "Status failed" }
    });
    return [branch];
  }
  targetState.majorStatus = descriptor.statusId;
  targetState.toxicCounter = descriptor.statusId === "tox" ? 1 : 0;
  event(branch, {
    eventType: "major-status",
    actorKey,
    targetKey,
    moveId: move.id,
    changes: [{ path: `combatantStates.${targetKey}.majorStatus`, from: null, to: descriptor.statusId }],
    metadata: { statusId: descriptor.statusId, resultLabel: `Inflicted ${descriptor.statusId.toUpperCase()}` }
  });
  if (descriptor.statusId === "slp") {
    const distribution = uniformStatusCounterDistribution();
    setStatusCounterDistribution(targetState.volatileConditions, "sleep", distribution);
    targetState.volatileConditions.sleepCounterStartDistribution = clone(distribution);
  }
  if (!descriptor.ignoreReaction && targetAbility === "synchronize" && ["brn", "par", "psn", "tox"].includes(descriptor.statusId) && actorKey !== targetKey) {
    const synchronized = applyMajorStatus(branch, targetKey, actorKey, move, { ...descriptor, ignoreReaction: true }, dataset);
    for (const outcome of synchronized) {
      event(outcome, { eventType: "status-reflected", actorKey: targetKey, targetKey: actorKey, moveId: move.id, metadata: { cause: "synchronize", resultLabel: "Synchronize shared the status" } });
    }
    return synchronized;
  }
  return [branch];
}

function applySetField(branch, actorKey, move, descriptor, plan = null, dataset = null) {
  const actorState = branch.state.combatantStates[actorKey];
  const extensionItems = { rain: "damprock", sun: "heatrock", sand: "smoothrock", hail: "icyrock" };
  const heldItem = actorState.itemState === "held" ? String(actorState.currentItemId || "").toLowerCase() : "";
  const durationTurns = extensionItems[descriptor.fieldId] === heldItem ? 8 : descriptor.durationTurns;
  const condition = normalizeFieldCondition(descriptor.fieldKind, {
    id: descriptor.fieldId,
    source: `move:${move.id}`,
    durationMode: "turns",
    remainingTurns: durationTurns
  });
  const previous = branch.state.fieldState.global[descriptor.fieldKind];
  branch.state.fieldState.global[descriptor.fieldKind] = condition;
  event(branch, {
    eventType: "field-change",
    actorKey,
    targetKey: null,
    moveId: move.id,
    changes: [{ path: `fieldState.global.${descriptor.fieldKind}`, from: previous, to: condition }],
    metadata: { fieldKind: descriptor.fieldKind, fieldId: descriptor.fieldId, resultLabel: `${descriptor.fieldId} ${descriptor.fieldKind}` }
  });
  if (descriptor.fieldKind === "weather" && plan && dataset) refreshWeatherAbilityForms(branch, plan, dataset);
  return [branch];
}

function applyVolatileStatus(branch, actorKey, targetKey, move, operation, plan = null, dataset = null) {
  const affectedKey = operation.target === "self" ? actorKey : targetKey;
  if (!affectedKey) throw new ResolutionError(`${move.name} has no volatile-status target`);
  const affectedState = branch.state.combatantStates[affectedKey];
  const volatileId = operation.volatileStatusId;
  const volatiles = affectedState.volatileConditions;
  if (Number(dataset?.mechanics?.damageGeneration) === 4 && ['lockedmove', 'uproar'].includes(volatileId)) {
    const field = volatileId === 'lockedmove' ? 'thrashTurns' : 'uproarTurns';
    if (Number(volatiles[field]) > 0) return [branch];
    // Pinned Platinum subscript_thrash / subscript_uproar: Random 1,2 / 3,3.
    // Store the actual hidden counter on each resolver branch, not a guessed mean.
    const durations = volatileId === 'lockedmove' ? [2, 3] : [3, 4, 5, 6];
    return durations.map(turns => {
      const outcome = clone(branch), values = outcome.state.combatantStates[affectedKey].volatileConditions;
      outcome.probability = probabilityProduct(branch.probability, 1 / durations.length);
      outcome.probabilityStatus = outcome.probability === null ? 'unknown' : 'known';
      values[field] = turns;
      if (volatileId === 'lockedmove') values.thrashMoveId = move.id;
      event(outcome, { eventType: 'volatile-status', actorKey, targetKey: affectedKey, moveId: move.id, metadata: { volatileStatusId: volatileId, remainingTurns: turns, resultLabel: `Locked into ${move.name}` } });
      return outcome;
    });
  }
  if (volatileId === "flinch") affectedState.turnFlags.flinched = true;
  else if (volatileId === "taunt") volatiles.tauntTurns = 3;
  else if (volatileId === "disable") {
    volatiles.disabledMoveId = affectedState.lastMoveId;
    volatiles.disableTurns = 4;
  } else if (volatileId === "encore") {
    volatiles.encoredMoveId = affectedState.lastMoveId;
    volatiles.encoreTurns = 3;
  } else if (volatileId === "magnetrise") volatiles.magnetRiseTurns = 5;
  else if (volatileId === "telekinesis") volatiles.telekinesisTurns = 3;
  else if (volatileId === "leechseed") {
    volatiles.leechSeeded = true;
    volatiles.leechSeedSourceKey = actorKey;
  } else if (volatileId === "mustrecharge") volatiles.rechargeRequired = true;
  else if (volatileId === "partiallytrapped") {
    volatiles.partiallyTrappedTurns = 4;
    volatiles.partiallyTrappedSourceKey = actorKey;
  } else if (volatileId === "yawn") {
    volatiles.yawnTurns = 2;
    volatiles.yawnSourceKey = actorKey;
  } else if (volatileId === "healblock") volatiles.healBlockTurns = 5;
  else if (volatileId === "embargo") volatiles.embargoTurns = 5;
  else if (volatileId === "uproar") volatiles.uproarTurns = 3;
  else if (volatileId === "gastroacid") {
    affectedState.abilitySuppressed = true;
    volatiles.gastroacid = true;
  }
  else if (volatileId === "stockpile") {
    volatiles.stockpileLayers = Math.min(3, Number(volatiles.stockpileLayers || 0) + 1);
    applyStatStages(branch, actorKey, affectedKey, move, { target: affectedKey === actorKey ? "self" : "target", statStages: { def: 1, spd: 1 } });
  } else if (volatileId === "substitute") {
    const cost = Math.floor(Number(affectedState.hp.maxHp) / 4);
    if (Number(affectedState.hp.max) <= cost) {
      event(branch, { eventType: "volatile-status-failed", actorKey, targetKey: affectedKey, moveId: move.id, metadata: { volatileStatusId: volatileId, reason: "insufficient-hp", resultLabel: "Substitute failed" } });
      return [branch];
    }
    applyExactHpChange(affectedState, -cost);
    volatiles.substituteHp = cost;
  } else if (volatileId === "confusion") {
    setStatusCounterDistribution(volatiles, "confusion", uniformStatusCounterDistribution());
  } else volatiles[volatileId] = operation.durationTurns || true;
  event(branch, {
    eventType: "volatile-status",
    actorKey,
    targetKey: affectedKey,
    moveId: move.id,
    changes: [{ path: `combatantStates.${affectedKey}.${volatileId === "flinch" ? "turnFlags.flinched" : "volatileConditions"}`, to: volatileId === "flinch" ? true : clone(volatiles) }],
    metadata: { volatileStatusId: volatileId, resultLabel: volatileId === "flinch" ? "Flinched" : volatileId === "confusion" ? "Confused" : volatileId }
  });
  if (volatileId === "gastroacid" && plan && dataset) return reconcileChangedAbilities(branch, [affectedKey], plan, dataset);
  return [branch];
}

function applySideCondition(branch, side, actorKey, move, operation) {
  const affectedSide = operation.targetSide === "own" ? side : opposite(side);
  const sideState = branch.state.fieldState.sides[affectedSide];
  const id = operation.sideConditionId;
  const hazardCaps = { spikes: 3, toxicspikes: 2, stealthrock: 1, stickyweb: 1 };
  const hazardFields = { spikes: "spikes", toxicspikes: "toxicSpikes", stealthrock: "stealthRock", stickyweb: "stickyWeb" };
  let path;
  let from;
  let to;
  if (hazardCaps[id]) {
    const field = hazardFields[id];
    path = `fieldState.sides.${affectedSide}.hazards.${field}`;
    from = Number(sideState.hazards[field] || 0);
    to = Math.min(hazardCaps[id], from + 1);
    sideState.hazards[field] = to;
  } else {
    const durationFields = {
      reflect: ["reflectTurns", 5],
      lightscreen: ["lightScreenTurns", 5],
      safeguard: ["safeguardTurns", 5],
      mist: ["mistTurns", 5],
      tailwind: ["tailwindTurns", 4],
      quickguard: ["quickGuardTurns", 1],
      wideguard: ["wideGuardTurns", 1],
      luckychant: ["luckyChantTurns", 5]
    };
    const [field, turns] = durationFields[id] || [`${id}Turns`, 1];
    path = `fieldState.sides.${affectedSide}.${field}`;
    from = Number(sideState[field] || 0);
    to = turns;
    sideState[field] = turns;
  }
  event(branch, {
    eventType: hazardCaps[id] ? "hazard-set" : "side-condition",
    actorKey,
    targetKey: null,
    moveId: move.id,
    changes: [{ path, from, to }],
    metadata: { side: affectedSide, sideConditionId: id, resultLabel: move.name }
  });
  return [branch];
}

function applyPseudoWeather(branch, actorKey, move, operation) {
  const fields = {
    trickroom: "trickRoomTurns",
    gravity: "gravityTurns",
    magicroom: "magicRoomTurns",
    wonderroom: "wonderRoomTurns",
    iondeluge: "ionDelugeTurns",
    fairylock: "fairyLockTurns"
  };
  const field = fields[operation.pseudoWeatherId];
  if (!field) throw new ResolutionError(`${move.name} uses unsupported field effect ${operation.pseudoWeatherId}`);
  const from = Number(branch.state.fieldState.global[field] || 0);
  const to = from > 0 && operation.pseudoWeatherId === "trickroom" ? 0
    : operation.pseudoWeatherId === "iondeluge" ? 1
      : operation.pseudoWeatherId === "fairylock" ? 2
        : 5;
  branch.state.fieldState.global[field] = to;
  event(branch, {
    eventType: "field-change",
    actorKey,
    targetKey: null,
    moveId: move.id,
    changes: [{ path: `fieldState.global.${field}`, from, to }],
    metadata: { fieldKind: "pseudo-weather", fieldId: operation.pseudoWeatherId, resultLabel: move.name }
  });
  return [branch];
}

function damageEventFor(branch, actorKey, targetKey, moveId) {
  return [...branch.events].reverse().find(entry => entry.eventType === "damage" && entry.actorKey === actorKey && entry.targetKey === targetKey && entry.moveId === moveId);
}

function applyDamageRecovery(branch, actorKey, targetKey, move, operation) {
  const damageEvent = damageEventFor(branch, actorKey, targetKey, move.id);
  if (!damageEvent) return [branch];
  const actorState = branch.state.combatantStates[actorKey];
  const hp = normalizeRange(actorState.hp);
  const maxHp = Number(hp.maxHp);
  if (operation.drain) {
    const [numerator, denominator] = operation.drain;
    const healMin = Math.floor(Number(damageEvent.damageHp.min) * numerator / denominator);
    const healMax = Math.floor(Number(damageEvent.damageHp.max) * numerator / denominator);
    actorState.hp = { min: Math.min(maxHp, hp.min + healMin), max: Math.min(maxHp, hp.max + healMax), maxHp };
    delete actorState.hpDistribution;
    const healingHp = actualHealingRange(hp, actorState.hp);
    event(branch, { eventType: "heal", actorKey, targetKey: actorKey, moveId: move.id, healingHp, healingPercent: percentRange(healingHp, maxHp), metadata: { cause: "drain", resultLabel: `Drained ${healingHp.min === healingHp.max ? healingHp.min : `${healingHp.min}–${healingHp.max}`} HP` } });
  }
  if (operation.recoil) {
    const current = normalizeRange(actorState.hp);
    const [numerator, denominator] = operation.recoil;
    const recoilMin = Math.floor(Number(damageEvent.damageHp.min) * numerator / denominator);
    const recoilMax = Math.floor(Number(damageEvent.damageHp.max) * numerator / denominator);
    actorState.hp = { min: Math.max(0, current.min - recoilMax), max: Math.max(0, current.max - recoilMin), maxHp: current.maxHp };
    delete actorState.hpDistribution;
    markHpLostThisTurn(actorState, recoilMax);
    event(branch, { eventType: "recoil", actorKey, targetKey: actorKey, moveId: move.id, damageHp: { min: recoilMin, max: recoilMax }, metadata: { resultLabel: `${recoilMin === recoilMax ? recoilMin : `${recoilMin}–${recoilMax}`} recoil` } });
  }
  return [branch];
}

function applyStructuredOperation(branch, context, operation) {
  const { side, actorKey, targetKey, move, dataset, plan, action } = context;
  const affectsTargetCombatant = ["stat-stages", "heal", "major-status", "volatile-status", "force-switch"].includes(operation.kind)
    && operation.target !== "self";
  if (affectsTargetCombatant && targetKey && Number(branch.state.combatantStates[targetKey]?.hp?.max || 0) <= 0) return [branch];
  if (branch.substituteAbsorbedTargetKey === targetKey && operation.target !== "self") return [branch];
  if (operation.kind === "stat-stages") return applyStatStages(branch, actorKey, targetKey, move, operation);
  if (operation.kind === "heal") return applySelfHeal(branch, operation.target === "target" ? targetKey : actorKey, move, { heal: operation.fraction });
  if (operation.kind === "major-status") {
    const affectedKey = operation.target === "self" ? actorKey : targetKey;
    return applyMajorStatus(branch, actorKey, affectedKey, move, operation, dataset);
  }
  if (operation.kind === "field-condition") return applySetField(branch, actorKey, move, { fieldKind: operation.fieldKind, fieldId: operation.fieldId, durationTurns: operation.durationTurns }, plan, dataset);
  if (operation.kind === "volatile-status") return applyVolatileStatus(branch, actorKey, targetKey, move, operation, plan, dataset);
  if (operation.kind === "side-condition") return applySideCondition(branch, side, actorKey, move, operation);
  if (operation.kind === "pseudo-weather") return applyPseudoWeather(branch, actorKey, move, operation);
  if (operation.kind === "slot-condition") return applyVolatileStatus(branch, actorKey, targetKey, move, { target: "target", volatileStatusId: operation.slotConditionId });
  if (operation.kind === "self-switch") {
    if (Number(branch.state.combatantStates[actorKey]?.hp?.max) <= 0) return [branch];
    const switchToKey = action?.mechanicActivations?.find(entry => entry?.id === "after-move-switch")?.switchToKey;
    const slot = actorSlot(branch.state, side, actorKey);
    if (slot < 0 || !switchToKey) return [branch];
    return applySwitch(branch, side, slot, { actionType: "switch", actorKey, switchToKey, switchKind: "pivot", switchMode: operation.switchMode }, plan, dataset);
  }
  if (operation.kind === "force-switch") {
    if (!targetKey || Number(branch.state.combatantStates[targetKey]?.hp?.max) <= 0) return [branch];
    const targetState = branch.state.combatantStates[targetKey];
    const sourceAbility = activeAbilityId(branch.state.combatantStates[actorKey]);
    const ignoresAbility = ["moldbreaker", "teravolt", "turboblaze"].includes(sourceAbility);
    if (targetState.volatileConditions?.ingrain || (activeAbilityId(targetState) === "suctioncups" && !ignoresAbility)) {
      event(branch, {
        eventType: "move-blocked",
        actorKey,
        targetKey,
        moveId: move.id,
        metadata: { cause: targetState.volatileConditions?.ingrain ? "ingrain" : "suctioncups", resultLabel: `${plan.combatants[targetKey].displayName} could not be forced out` }
      });
      return [branch];
    }
    const affectedSide = opposite(side);
    const slot = actorSlot(branch.state, affectedSide, targetKey);
    const active = activeKeys(branch.state, affectedSide);
    const candidates = eligibleReserves(plan, branch.state, affectedSide, slot);
    if (slot < 0 || !candidates.length) return [branch];
    return candidates.flatMap(candidate => {
      const next = clone(branch);
      next.probability = probabilityProduct(branch.probability, 1 / candidates.length);
      next.probabilityStatus = next.probability === null ? "unknown" : "known";
      return applySwitch(next, affectedSide, slot, { actionType: "switch", actorKey: targetKey, switchToKey: candidate.combatantKey, switchKind: "forced" }, plan, dataset);
    });
  }
  throw new ResolutionError(`${move.name} uses unsupported structured operation ${operation.kind}`);
}

function applyStructuredOperations(branches, context, operations) {
  let current = branches;
  for (const operation of operations) {
    if (operation.kind === "chance") {
      current = current.flatMap(branch => {
        if (branch.substituteAbsorbedTargetKey === context.targetKey && operation.operations.every(nested => nested.target !== "self")) return [branch];
        if (context.targetKey && Number(branch.state.combatantStates[context.targetKey]?.hp?.max || 0) <= 0
          && operation.operations.every(nested => nested.target !== "self")) return [branch];
        const rainbowMultiplier = Number(branch.state.fieldState.sides?.[context.side]?.rainbowTurns || 0) > 0 ? 2 : 1;
        const chance = Math.max(0, Math.min(100, Number(operation.chance) * rainbowMultiplier)) / 100;
        if (chance >= 1) return applyStructuredOperations([branch], context, operation.operations);
        if (chance <= 0) return [branch];
        const applied = clone(branch);
        applied.probability = probabilityProduct(branch.probability, chance);
        applied.probabilityStatus = applied.probability === null ? "unknown" : "known";
        const skippedBranch = clone(branch);
        skippedBranch.probability = probabilityProduct(branch.probability, 1 - chance);
        skippedBranch.probabilityStatus = skippedBranch.probability === null ? "unknown" : "known";
        const secondaryTargetKeys = [...new Set(operation.operations.map(nested => nested.target === "self" ? context.actorKey : context.targetKey).filter(Boolean))];
        event(skippedBranch, {
          eventType: "secondary-effect-missed",
          actorKey: context.actorKey,
          targetKey: secondaryTargetKeys.length === 1 ? secondaryTargetKeys[0] : context.targetKey,
          moveId: context.move.id,
          metadata: { chance: Number(operation.chance), secondaryTargetKeys, resultLabel: "No secondary effect" }
        });
        return [...applyStructuredOperations([applied], context, operation.operations), skippedBranch];
      });
    } else {
      current = current.flatMap(branch => applyStructuredOperation(branch, context, operation));
    }
  }
  return current;
}

function specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, resultLabel, changes = [], metadata = {}) {
  event(branch, {
    eventType: "special-move-effect",
    actorKey,
    targetKey,
    moveId: move.id,
    changes,
    metadata: { handlerId, resultLabel, ...metadata }
  });
  return [branch];
}

function clearStatus(state) {
  const from = state.majorStatus;
  state.majorStatus = null;
  state.toxicCounter = 0;
  state.volatileConditions.sleepTurns = null;
  state.volatileConditions.sleepCounterDistribution = null;
  state.volatileConditions.sleepCounterStartDistribution = null;
  return from;
}

function setExactCurrentHp(state, value) {
  const maxHp = Number(state.hp.maxHp);
  const next = Math.max(0, Math.min(maxHp, Math.floor(Number(value))));
  state.hp = { min: next, max: next, maxHp };
  state.hpDistribution = [{ value: next, probability: 1 }];
}

function swapStageGroups(left, right, stats) {
  for (const stat of stats) [left.statStages[stat], right.statStages[stat]] = [right.statStages[stat], left.statStages[stat]];
}

function applyCrashDamage(branch, actorKey, move, reason) {
  const actorState = branch.state.combatantStates[actorKey];
  const damage = Math.max(1, Math.floor(Number(actorState.hp.maxHp) / 2));
  event(branch, {
    eventType: "crash",
    actorKey,
    targetKey: actorKey,
    moveId: move.id,
    metadata: { reason, resultLabel: `${move.name} crash damage` }
  });
  return applyDamage(branch, {
    actorKey,
    targetKey: actorKey,
    move: { id: `${move.id}-crash`, name: `${move.name} crash`, category: "physical" },
    damageValues: [damage],
    descriptor: {},
    effectiveBasePower: 0
  });
}

function applySpecialHandler(branch, context, handlerId) {
  const { side, actorKey, targetKey, move, dataset, plan, action, previousLastMoveId, damageAdapter, isLastAction, pendingActions = [] } = context;
  const actorState = branch.state.combatantStates[actorKey];
  const targetState = targetKey ? branch.state.combatantStates[targetKey] : null;
  const targetSide = targetKey ? plan.combatants[targetKey]?.side : null;
  const fail = reason => specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, `${move.name} failed`, [], { failed: true, reason });
  if (handlerId === "bide") {
    const turns = Number(actorState.volatileConditions.bideTurns || 0);
    branch.skipCurrentMoveDamage = true;
    if (!turns) {
      actorState.volatileConditions.bideTurns = 2;
      actorState.volatileConditions.bideDamage = 0;
      actorState.volatileConditions.bideSourceKey = null;
      return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, "Bide started storing damage", [], { charging: true, remainingTurns: 2 });
    }
    if (turns > 1) {
      actorState.volatileConditions.bideTurns = turns - 1;
      return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, "Bide is storing energy", [], { charging: true, remainingTurns: turns - 1 });
    }
    const damage = Number(actorState.volatileConditions.bideDamage || 0) * 2;
    const sourceKey = actorState.volatileConditions.bideSourceKey;
    actorState.volatileConditions.bideTurns = 0;
    actorState.volatileConditions.bideDamage = 0;
    actorState.volatileConditions.bideSourceKey = null;
    if (!damage || !sourceKey || Number(branch.state.combatantStates[sourceKey]?.hp?.max) <= 0) return fail("no-stored-damage-source");
    return applyDamage(branch, {
      actorKey,
      targetKey: sourceKey,
      move,
      damageValues: [damage],
      descriptor: {},
      effectiveBasePower: 0
    });
  }
  if (handlerId === "destiny-bond") return [branch];
  if (handlerId === "delayed-attack") {
    const rotationTarget = battleFormat(plan) === "rotation";
    const targetSlot = rotationTarget ? rotationFrontSlot(branch.state, opposite(side)) : actorSlot(branch.state, opposite(side), targetKey);
    if (targetSlot < 0) {
      branch.skipCurrentMoveDamage = true;
      return fail("target-slot-unavailable");
    }
    const delayed = branch.state.fieldState.global.delayedAttacks ||= [];
    if (delayed.some(entry => entry.side === opposite(side) && (rotationTarget ? entry.rotationFront === true : Number(entry.slot) === targetSlot))) {
      branch.skipCurrentMoveDamage = true;
      return fail("target-slot-already-has-delayed-attack");
    }
    delayed.push({ side: opposite(side), slot: targetSlot, rotationFront: rotationTarget, sourceKey: actorKey, moveId: move.id, remainingTurns: 3 });
    branch.skipCurrentMoveDamage = true;
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, `${move.name} was foreseen`, [], { delayedTurns: 2, targetSlot });
  }
  if (handlerId === "nonlethal-damage") {
    branch.nonlethalCurrentMove = true;
    return [branch];
  }
  if (handlerId === "requires-undamaged-before-action") {
    if (actorState.turnFlags.wasDamaged) {
      branch.skipCurrentMoveDamage = true;
      return fail("lost-focus-after-taking-damage");
    }
    return [branch];
  }
  if (handlerId === "crash-on-failure") return [branch];
  if (handlerId === "self-destruct") {
    if (!actorState.volatileConditions.selfDestructResolved) {
      actorState.volatileConditions.selfDestructResolved = true;
      setExactCurrentHp(actorState, 0);
      specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, `${plan.combatants[actorKey].displayName} fainted`);
    }
    return [branch];
  }
  if (["healing-wish", "lunar-dance"].includes(handlerId)) {
    const slot = actorSlot(branch.state, side, actorKey);
    const canSwitch = Object.values(plan.combatants).some(combatant => combatant.side === side
      && !activeKeys(branch.state, side).includes(combatant.combatantKey)
      && Number(branch.state.combatantStates[combatant.combatantKey]?.hp?.max) > 0);
    if (slot < 0 || !canSwitch) return fail("no-available-switch-in");
    const slotEffects = branch.state.fieldState.sides[side].slotEffects ||= {};
    slotEffects[slot] = { id: handlerId, restorePp: handlerId === "lunar-dance" };
    setExactCurrentHp(actorState, 0);
    return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, handlerId === "lunar-dance" ? "Lunar Dance awaits the replacement" : "Healing Wish awaits the replacement", [], { slot });
  }
  if (handlerId === "wish") {
    const rotationTarget = battleFormat(plan) === "rotation";
    const slot = rotationTarget ? rotationFrontSlot(branch.state, side) : actorSlot(branch.state, side, actorKey);
    const delayed = branch.state.fieldState.global.delayedHeals ||= [];
    if (slot < 0 || delayed.some(entry => entry.side === side && (rotationTarget ? entry.rotationFront === true : Number(entry.slot) === slot))) return fail("slot-already-has-wish");
    delayed.push({ side, slot, rotationFront: rotationTarget, sourceKey: actorKey, amount: Math.max(1, Math.floor(Number(actorState.hp.maxHp) / 2)), remainingTurns: 2 });
    return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, "Wish will heal this slot next turn", [], { slot });
  }
  if (handlerId === "curse") {
    const ghostCurse = actorState.currentTypeIds.map(type => String(type).toLowerCase()).includes("ghost");
    if (!ghostCurse) {
      return applyStatStages(branch, actorKey, actorKey, move, { target: "self", statStages: { atk: 1, def: 1, spe: -1 } });
    }
    if (!targetState || targetKey === actorKey) return fail("ghost-curse-needs-opponent");
    applyExactHpChange(actorState, -Math.max(1, Math.floor(Number(actorState.hp.maxHp) / 2)));
    targetState.volatileConditions.curseSourceKey = actorKey;
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Target was afflicted by the curse");
  }
  if (handlerId === "attract") {
    if (!targetState) return fail("target-unavailable");
    const actorGender = String(plan.combatants[actorKey].gender || "").toLowerCase();
    const targetGender = String(plan.combatants[targetKey].gender || "").toLowerCase();
    if (!actorGender || !targetGender || actorGender === targetGender || !["m", "f", "male", "female"].includes(actorGender) || !["m", "f", "male", "female"].includes(targetGender)) {
      return fail("incompatible-gender");
    }
    targetState.volatileConditions.attractSourceKey = actorKey;
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Target fell in love");
  }
  if (handlerId === "present") {
    const variants = [
      { probability: 0.4, basePower: 40 },
      { probability: 0.3, basePower: 80 },
      { probability: 0.1, basePower: 120 },
      { probability: 0.2, heal: true }
    ];
    return variants.flatMap(variant => {
      const next = clone(branch);
      next.probability = probabilityProduct(branch.probability, variant.probability);
      next.probabilityStatus = next.probability === null ? "unknown" : "known";
      if (variant.heal) {
        next.skipCurrentMoveDamage = true;
        return applySelfHeal(next, targetKey, move, { heal: [1, 4] });
      }
      next.currentMoveOverrides = { basePower: variant.basePower };
      event(next, { eventType: "random-move-power", actorKey, targetKey, moveId: move.id, metadata: { basePower: variant.basePower, resultLabel: `${variant.basePower} base power` } });
      return [next];
    });
  }
  if (handlerId === "magnitude") {
    if (branch.randomMoveOutcome?.moveId === move.id) {
      branch.currentMoveOverrides = { basePower: branch.randomMoveOutcome.basePower };
      return [branch];
    }
    const variants = [
      [4, 10, 0.05], [5, 30, 0.1], [6, 50, 0.2], [7, 70, 0.3], [8, 90, 0.2], [9, 110, 0.1], [10, 150, 0.05]
    ];
    return variants.map(([level, basePower, probability]) => {
      const next = clone(branch);
      next.probability = probabilityProduct(branch.probability, probability);
      next.probabilityStatus = next.probability === null ? "unknown" : "known";
      next.currentMoveOverrides = { basePower };
      next.randomMoveOutcome = { moveId: move.id, basePower, magnitude: level };
      event(next, { eventType: "random-move-power", actorKey, targetKey, moveId: move.id, metadata: { magnitude: level, basePower, resultLabel: `Magnitude ${level}` } });
      return next;
    });
  }
  if (handlerId === "incinerate-berry") {
    if (targetState?.itemState === "held" && String(targetState.currentItemId || "").toLowerCase().endsWith("berry")) {
      targetState.lastItemId = targetState.currentItemId;
      targetState.currentItemId = "";
      targetState.itemState = "consumed";
      return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Target's Berry was incinerated");
    }
    return [branch];
  }
  if (handlerId === "last-resort") {
    const known = (actorState.moveSetOverride || plan.combatants[actorKey].moves).map(entry => entry.moveId).filter(id => id !== move.id);
    if (!known.length || known.some(id => !actorState.usedMoveIds?.includes(id))) {
      branch.skipCurrentMoveDamage = true;
      return fail("other-known-moves-have-not-all-been-used");
    }
    return [branch];
  }
  if (handlerId === "sky-drop") {
    if (actorState.volatileConditions.chargingMoveId !== move.id) {
      actorState.volatileConditions.chargingMoveId = move.id;
      if (targetState) targetState.volatileConditions.skyDropSourceKey = actorKey;
      branch.skipCurrentMoveDamage = true;
      return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Target was carried into the sky", [], { charging: true });
    }
    actorState.volatileConditions.chargingMoveId = null;
    if (targetState) targetState.volatileConditions.skyDropSourceKey = null;
    return [branch];
  }
  if (handlerId === "pledge") {
    const pledgeIds = new Set(["firepledge", "grasspledge", "waterpledge"]);
    if (branch.pendingPledge) {
      const pair = new Set([branch.pendingPledge.moveId, move.id]);
      delete branch.pendingPledge;
      branch.currentMoveOverrides = { basePower: 150 };
      const affectedSide = pair.has("firepledge") && pair.has("waterpledge") ? side : opposite(side);
      const condition = pair.has("firepledge") && pair.has("waterpledge") ? "rainbow"
        : pair.has("firepledge") && pair.has("grasspledge") ? "seaOfFire"
          : "swamp";
      branch.state.fieldState.sides[affectedSide][`${condition}Turns`] = 4;
      return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Pledge combination", [], { combination: condition, basePower: 150, affectedSide });
    }
    const partner = pendingActions.find(entry => entry.side === side && entry.action?.actorKey !== actorKey && pledgeIds.has(entry.action?.moveId));
    if (!partner) return [branch];
    branch.pendingPledge = { moveId: move.id, actorKey };
    branch.actionOrderDirective = { kind: "move-next", targetKey: partner.action.actorKey };
    branch.skipCurrentMoveDamage = true;
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Waiting to combine pledges", [], { waitingForKey: partner.action.actorKey });
  }
  if (["counter-damage", "mirror-coat-damage", "metal-burst-damage"].includes(handlerId)) {
    const policy = retaliationPolicy(dataset, move, handlerId);
    const record = retaliationRecord(branch.state, actorKey, side, policy);
    if (!record) {
      branch.skipCurrentMoveDamage = true;
      return fail("no-matching-damage-this-turn");
    }
    const damageDistribution = retaliationDamageDistribution(record, policy);
    const damageValues = damageDistribution.map(entry => entry.damage);
    branch.skipCurrentMoveDamage = true;
    return applyDamage(branch, { actorKey, targetKey, move, damageValues, damageDistribution, descriptor: {}, effectiveBasePower: 0, dataset });
  }
  if (["final-gambit-damage", "endeavor-damage", "half-current-hp-damage"].includes(handlerId)) {
    if (!targetState) {
      branch.skipCurrentMoveDamage = true;
      return fail("target-unavailable");
    }
    const actorHp = normalizeRange(actorState.hp);
    const targetHp = normalizeRange(targetState.hp);
    const damageValues = handlerId === "final-gambit-damage"
      ? [actorHp.min, actorHp.max]
      : handlerId === "endeavor-damage"
        ? [Math.max(0, targetHp.min - actorHp.max), Math.max(0, targetHp.max - actorHp.min)]
        : [Math.max(1, Math.floor(targetHp.min / 2)), Math.max(1, Math.floor(targetHp.max / 2))];
    branch.skipCurrentMoveDamage = true;
    const outcomes = applyDamage(branch, { actorKey, targetKey, move, damageValues, descriptor: {}, effectiveBasePower: 0 });
    if (handlerId === "final-gambit-damage") for (const outcome of outcomes) setExactCurrentHp(outcome.state.combatantStates[actorKey], 0);
    return outcomes;
  }
  if (handlerId === "first-turn-only") {
    if (Number(actorState.enteredTurnNumber || 0) !== Number(branch.state.turnNumber || 0)) {
      branch.skipCurrentMoveDamage = true;
      return fail("not-first-active-turn");
    }
    return [branch];
  }
  if (handlerId === "requires-sleeping-target") {
    if (targetState?.majorStatus !== "slp") {
      branch.skipCurrentMoveDamage = true;
      return fail("target-not-asleep");
    }
    return [branch];
  }
  if (handlerId === "requires-damaging-target-action") {
    const pending = pendingActions.find(entry => entry.action?.actorKey === targetKey)?.action;
    const selectedMove = pending?.actionType === "move" ? dataset.get("moves", pending.moveId) : null;
    if (!targetState || targetState.turnFlags.hasMoved || !selectedMove || String(selectedMove.category).toLowerCase() === "status") {
      branch.skipCurrentMoveDamage = true;
      return fail("target-is-not-pending-a-damaging-move");
    }
    return [branch];
  }
  if (handlerId === "two-turn-charge") {
    const weather = branch.state.fieldState.global.weather?.id;
    const powerHerb = actorState.itemState === "held" && String(actorState.currentItemId || "").toLowerCase() === "powerherb";
    const immediate = move.id === "solarbeam" && weather === "sun" || powerHerb;
    if (powerHerb && actorState.volatileConditions.chargingMoveId !== move.id) {
      actorState.lastItemId = actorState.currentItemId;
      actorState.currentItemId = "";
      actorState.itemState = "consumed";
      event(branch, { eventType: "item-consumed", actorKey, targetKey: actorKey, moveId: move.id, metadata: { itemId: "powerherb", resultLabel: "Power Herb skipped charging" } });
    }
    if (!immediate && actorState.volatileConditions.chargingMoveId !== move.id) {
      actorState.volatileConditions.chargingMoveId = move.id;
      branch.skipCurrentMoveDamage = true;
      return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, `Charging ${move.name}`, [], { charging: true });
    }
    actorState.volatileConditions.chargingMoveId = null;
    return [branch];
  }
  if (handlerId === "sport-field") {
    actorState.volatileConditions[move.id] = true;
    return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, `${move.name} is active`);
  }
  if (handlerId === "spit-up") {
    const layers = Math.max(0, Math.min(3, Number(actorState.volatileConditions.stockpileLayers || 0)));
    if (!layers) {
      branch.skipCurrentMoveDamage = true;
      return fail("no-stockpile");
    }
    branch.currentMoveOverrides = { basePower: layers * 100 };
    actorState.volatileConditions.stockpileLayers = 0;
    return [branch];
  }
  if (handlerId === "clear-target-stat-stages") {
    if (targetState) for (const stat of Object.keys(targetState.statStages)) targetState.statStages[stat] = 0;
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Target stat changes cleared");
  }
  if (["steal-item", "remove-item"].includes(handlerId)) {
    if (!targetState || targetState.itemState !== "held") return [branch];
    const itemId = targetState.currentItemId;
    targetState.lastItemId = itemId;
    targetState.currentItemId = "";
    targetState.itemState = "consumed";
    if (handlerId === "steal-item" && actorState.itemState !== "held") {
      actorState.currentItemId = itemId;
      actorState.itemState = "held";
    }
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, handlerId === "steal-item" ? "Item stolen" : "Item removed");
  }
  if (handlerId === "clear-own-hazards") {
    branch.state.fieldState.sides[side].hazards = {};
    actorState.volatileConditions.leechSeeded = false;
    actorState.volatileConditions.partiallyTrappedTurns = 0;
    return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, "Hazards and trapping cleared");
  }
  if (handlerId === "break-target-screens") {
    if (targetSide) {
      const fields = branch.state.fieldState.sides[targetSide];
      fields.reflectTurns = 0;
      fields.lightScreenTurns = 0;
      fields.auroraVeilTurns = 0;
    }
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Target screens cleared");
  }
  if (handlerId === "wake-target") {
    if (targetState?.majorStatus === "slp") clearStatus(targetState);
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Target woke up");
  }
  if (handlerId === "protect") return applyProtect(branch, actorKey, move, { failsIfLastAction: true }, dataset, isLastAction);
  if (handlerId === "endure") {
    actorState.turnFlags.enduring = true;
    return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, "Will endure lethal damage");
  }
  if (handlerId === "no-op") return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, "No additional effect");
  if (handlerId === "flower-shield" || handlerId === "rototiller") {
    const statStages = handlerId === "flower-shield" ? { def: 1 } : { atk: 1, spa: 1 };
    const affected = participantEntries(branch.state).filter(entry => {
      const state = branch.state.combatantStates[entry.combatantKey];
      return state.currentTypeIds.map(toId).includes("grass")
        && (handlerId !== "rototiller" || isGrounded(state, branch.state.fieldState));
    });
    if (!affected.length) return fail("no-eligible-grass-type");
    for (const entry of affected) applyStatStages(branch, actorKey, entry.combatantKey, move, { target: entry.combatantKey === actorKey ? "self" : "target", statStages });
    return specialHandlerEvent(branch, actorKey, null, move, handlerId, `${affected.length} Grass-type Pokémon boosted`, [], { affectedKeys: affected.map(entry => entry.combatantKey) });
  }
  if (handlerId === "invert-stat-stages") {
    if (!targetState) return fail("target-unavailable");
    for (const stat of Object.keys(targetState.statStages)) targetState.statStages[stat] = -Number(targetState.statStages[stat] || 0);
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Target stat changes reversed");
  }
  if (handlerId === "terrain-target-heal") {
    if (!targetState) return fail("target-unavailable");
    return applySelfHeal(branch, targetKey, move, { heal: branch.state.fieldState.global.terrain?.id === "grassy" ? [2, 3] : [1, 2] });
  }
  if (handlerId === "terrain-self-heal") {
    return applySelfHeal(branch, actorKey, move, { heal: branch.state.fieldState.global.weather?.id === "sand" ? [2, 3] : [1, 2] });
  }
  if (["plus-minus-offense", "plus-minus-defense"].includes(handlerId)) {
    const statStages = handlerId === "plus-minus-offense" ? { atk: 1, spa: 1 } : { def: 1, spd: 1 };
    const affected = participantEntries(branch.state).filter(entry => entry.side === side
      && ["plus", "minus"].includes(activeAbilityId(branch.state.combatantStates[entry.combatantKey])));
    if (!affected.length) return fail("no-plus-or-minus-ally");
    for (const entry of affected) applyStatStages(branch, actorKey, entry.combatantKey, move, { target: entry.combatantKey === actorKey ? "self" : "target", statStages });
    return specialHandlerEvent(branch, actorKey, null, move, handlerId, `${affected.length} Plus or Minus Pokémon boosted`, [], { affectedKeys: affected.map(entry => entry.combatantKey) });
  }
  if (handlerId === "purify") {
    if (!targetState?.majorStatus) return fail("target-has-no-status");
    const clearedStatus = clearStatus(targetState);
    specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Target status cleared", [], { clearedStatus });
    return applySelfHeal(branch, actorKey, move, { heal: [1, 2] });
  }
  if (handlerId === "swap-speed-stats") {
    if (!targetState) return fail("target-unavailable");
    const actorSpeed = currentCalculatedStat(plan, branch.state, actorKey, "spe");
    const targetSpeed = currentCalculatedStat(plan, branch.state, targetKey, "spe");
    actorState.calculatedStatOverrides ||= {};
    targetState.calculatedStatOverrides ||= {};
    actorState.calculatedStatOverrides.spe = targetSpeed;
    targetState.calculatedStatOverrides.spe = actorSpeed;
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Speed stats swapped");
  }
  if (handlerId === "strength-sap") {
    if (!targetState || Number(targetState.statStages.atk || 0) <= -6) return fail("target-attack-cannot-fall");
    const healAmount = Math.max(1, Math.floor(currentCalculatedStat(plan, branch.state, targetKey, "atk") * stageMultiplier(targetState.statStages.atk)));
    applyStatStages(branch, actorKey, targetKey, move, { target: "target", statStages: { atk: -1 } });
    return applyFixedHeal(branch, actorKey, move, healAmount, { cause: handlerId });
  }
  if (handlerId === "venom-drench") {
    if (!targetState || !["psn", "tox"].includes(targetState.majorStatus)) return fail("target-not-poisoned");
    return applyStatStages(branch, actorKey, targetKey, move, { target: "target", statStages: { atk: -1, spa: -1, spe: -1 } });
  }
  if (["add-ghost-type", "add-grass-type", "set-psychic-type"].includes(handlerId)) {
    if (!targetState) return fail("target-unavailable");
    const typeId = handlerId === "add-ghost-type" ? "ghost" : handlerId === "add-grass-type" ? "grass" : "psychic";
    const from = [...targetState.currentTypeIds];
    if (handlerId === "set-psychic-type") targetState.currentTypeIds = [typeId];
    else if (!targetState.currentTypeIds.map(toId).includes(typeId)) targetState.currentTypeIds = [...targetState.currentTypeIds, typeId];
    else return fail("target-already-has-type");
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, handlerId === "set-psychic-type" ? "Type changed to Psychic" : `${typeId === "ghost" ? "Ghost" : "Grass"} type added`, [{ path: `combatantStates.${targetKey}.currentTypeIds`, from, to: [...targetState.currentTypeIds] }]);
  }
  if (handlerId === "stuff-cheeks") {
    const itemId = toId(actorState.currentItemId);
    if (actorState.itemState !== "held" || !itemId.endsWith("berry")) return fail("no-held-berry");
    actorState.lastItemId = actorState.currentItemId;
    actorState.currentItemId = "";
    actorState.itemState = "consumed";
    event(branch, { eventType: "item-consumed", actorKey, targetKey: actorKey, moveId: move.id, metadata: { itemId, resultLabel: `${readableMechanicName(itemId)} consumed` } });
    return applyStatStages(branch, actorKey, actorKey, move, { target: "self", statStages: { def: 2 } });
  }
  if (handlerId === "teatime") {
    const affected = participantEntries(branch.state).filter(entry => {
      const state = branch.state.combatantStates[entry.combatantKey];
      return state.itemState === "held" && toId(state.currentItemId).endsWith("berry");
    });
    if (!affected.length) return fail("no-held-berries");
    for (const entry of affected) {
      const state = branch.state.combatantStates[entry.combatantKey];
      const itemId = toId(state.currentItemId);
      state.lastItemId = state.currentItemId;
      state.currentItemId = "";
      state.itemState = "consumed";
      event(branch, { eventType: "item-consumed", actorKey, targetKey: entry.combatantKey, moveId: move.id, metadata: { itemId, resultLabel: `${readableMechanicName(itemId)} consumed` } });
    }
    return [branch];
  }
  if (handlerId === "court-change") {
    const left = branch.state.fieldState.sides.player;
    const right = branch.state.fieldState.sides.enemy;
    const fields = ["reflectTurns", "lightScreenTurns", "auroraVeilTurns", "tailwindTurns", "safeguardTurns", "mistTurns", "luckyChantTurns", "hazards"];
    for (const field of fields) [left[field], right[field]] = [clone(right[field]), clone(left[field])];
    return specialHandlerEvent(branch, actorKey, null, move, handlerId, "Side conditions swapped");
  }
  if (handlerId === "party-quarter-heal-status") {
    const affected = participantEntries(branch.state).filter(entry => entry.side === side);
    for (const entry of affected) {
      const state = branch.state.combatantStates[entry.combatantKey];
      const clearedStatus = clearStatus(state);
      applySelfHeal(branch, entry.combatantKey, move, { heal: [1, 4] });
      if (clearedStatus) specialHandlerEvent(branch, actorKey, entry.combatantKey, move, handlerId, "Status cleared", [], { clearedStatus });
    }
    return [branch];
  }
  if (handlerId === "take-heart") {
    const clearedStatus = clearStatus(actorState);
    applyStatStages(branch, actorKey, actorKey, move, { target: "self", statStages: { spa: 1, spd: 1 } });
    return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, "Sp. Atk and Sp. Def rose", [], { clearedStatus });
  }
  if (handlerId === "clear-all-stat-stages") {
    for (const entry of participantEntries(branch.state)) {
      const stages = branch.state.combatantStates[entry.combatantKey].statStages;
      for (const stat of Object.keys(stages)) stages[stat] = 0;
    }
    return specialHandlerEvent(branch, actorKey, null, move, handlerId, "All stat changes cleared");
  }
  if (handlerId === "rest") {
    if (["insomnia", "vitalspirit"].includes(String(actorState.currentAbilityId || "").toLowerCase())) return fail("ability-prevents-sleep");
    if (actorState.majorStatus === "slp" || Number(actorState.hp.max) >= Number(actorState.hp.maxHp)) return fail("already-asleep-or-full-hp");
    clearStatus(actorState);
    actorState.majorStatus = "slp";
    setStatusCounterDistribution(actorState.volatileConditions, "sleep", [{ value: 3, probability: 1 }]);
    actorState.volatileConditions.sleepCounterStartDistribution = [{ value: 3, probability: 1 }];
    return applySelfHeal(branch, actorKey, move, { heal: [1, 1] });
  }
  if (["set-water-type", "copy-types", "camouflage", "conversion", "conversion-2"].includes(handlerId)) {
    let typeIds = null;
    if (handlerId === "set-water-type") typeIds = ["water"];
    if (handlerId === "copy-types" && targetState) typeIds = [...targetState.currentTypeIds];
    if (handlerId === "camouflage") typeIds = [{ electric: "electric", grassy: "grass", misty: "fairy", psychic: "psychic" }[branch.state.fieldState.global.terrain?.id] || "normal"];
    if (handlerId === "conversion") {
      const firstMove = dataset.get("moves", plan.combatants[actorKey].moves[0]?.moveId);
      if (firstMove) typeIds = [String(firstMove.type || "normal").toLowerCase()];
    }
    if (handlerId === "conversion-2") {
      const declared = action?.mechanicActivations?.find(entry => entry?.id === "conversion-type")?.typeId;
      if (declared) typeIds = [String(declared).toLowerCase()];
      else return fail("conversion-type-outcome-not-selected");
    }
    const affectedState = handlerId === "set-water-type" || handlerId === "copy-types" ? targetState : actorState;
    if (!affectedState || !typeIds?.length) return fail("type-unavailable");
    const from = [...affectedState.currentTypeIds];
    affectedState.currentTypeIds = typeIds;
    return specialHandlerEvent(branch, actorKey, handlerId === "set-water-type" || handlerId === "copy-types" ? targetKey : actorKey, move, handlerId, `Type changed to ${typeIds.join("/")}`, [{ path: `combatantStates.${handlerId === "set-water-type" || handlerId === "copy-types" ? targetKey : actorKey}.currentTypeIds`, from, to: typeIds }]);
  }
  if (handlerId === "trap-target") return applyVolatileStatus(branch, actorKey, targetKey, move, { target: "target", volatileStatusId: "trapped" });
  if (handlerId === "sure-hit") {
    actorState.volatileConditions.sureHitTargetKey = targetKey;
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Next move cannot miss");
  }
  if (handlerId === "defog") {
    if (targetState) applyStatStages(branch, actorKey, targetKey, move, { target: "target", statStages: { evasion: -1 } });
    for (const affectedSide of [side, targetSide].filter(Boolean)) {
      branch.state.fieldState.sides[affectedSide].hazards = {};
    }
    if (targetSide) {
      const targetFields = branch.state.fieldState.sides[targetSide];
      for (const field of ["reflectTurns", "lightScreenTurns", "safeguardTurns", "mistTurns"]) targetFields[field] = 0;
    }
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Hazards and target screens cleared");
  }
  if (handlerId === "recycle-item") {
    if (actorState.itemState === "held" || !actorState.lastItemId) return fail("no-recyclable-item");
    actorState.currentItemId = actorState.lastItemId;
    actorState.itemState = "held";
    actorState.lastItemId = null;
    return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, "Item restored");
  }
  if (["clear-self-status", "clear-party-status"].includes(handlerId)) {
    const keys = handlerId === "clear-self-status" ? [actorKey] : Object.values(plan.combatants).filter(entry => entry.side === side).map(entry => entry.combatantKey);
    const cleared = keys.filter(key => clearStatus(branch.state.combatantStates[key]));
    return specialHandlerEvent(branch, actorKey, handlerId === "clear-self-status" ? actorKey : null, move, handlerId, cleared.length ? "Status cleared" : "No status to clear", [], { clearedKeys: cleared });
  }
  if (handlerId === "copy-stat-stages") {
    if (!targetState) return fail("target-unavailable");
    actorState.statStages = { ...targetState.statStages };
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Stat changes copied");
  }
  if (handlerId === "weather-heal") {
    const weather = branch.state.fieldState.global.weather?.id;
    const heal = weather === "sun" ? [2, 3] : ["rain", "sand", "hail"].includes(weather) ? [1, 4] : [1, 2];
    return applySelfHeal(branch, actorKey, move, { heal });
  }
  if (handlerId === "belly-drum") {
    if (Number(actorState.hp.max) <= Math.floor(Number(actorState.hp.maxHp) / 2) || actorState.statStages.atk >= 6) return fail("insufficient-hp-or-max-attack");
    applyExactHpChange(actorState, -Math.floor(Number(actorState.hp.maxHp) / 2));
    actorState.statStages.atk = 6;
    return specialHandlerEvent(branch, actorKey, actorKey, move, handlerId, "HP halved; Attack +6");
  }
  if (["swap-defensive-stages", "swap-offensive-stages", "swap-all-stages"].includes(handlerId)) {
    if (!targetState) return fail("target-unavailable");
    const stats = handlerId === "swap-defensive-stages" ? ["def", "spd"] : handlerId === "swap-offensive-stages" ? ["atk", "spa"] : Object.keys(actorState.statStages);
    swapStageGroups(actorState, targetState, stats);
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Stat changes swapped");
  }
  if (handlerId === "target-heal") return targetState ? applySelfHeal(branch, targetKey, move, { heal: [1, 2] }) : fail("target-unavailable");
  if (handlerId === "pain-split") {
    if (!targetState) return fail("target-unavailable");
    const actorHp = normalizeRange(actorState.hp);
    const targetHp = normalizeRange(targetState.hp);
    const sharedMin = Math.floor((actorHp.min + targetHp.min) / 2);
    const sharedMax = Math.floor((actorHp.max + targetHp.max) / 2);
    actorState.hp = { min: Math.min(actorHp.maxHp, sharedMin), max: Math.min(actorHp.maxHp, sharedMax), maxHp: actorHp.maxHp };
    targetState.hp = { min: Math.min(targetHp.maxHp, sharedMin), max: Math.min(targetHp.maxHp, sharedMax), maxHp: targetHp.maxHp };
    delete actorState.hpDistribution;
    delete targetState.hpDistribution;
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "HP shared equally");
  }
  if (["swap-abilities", "swap-items"].includes(handlerId)) {
    if (!targetState) return fail("target-unavailable");
    if (handlerId === "swap-abilities") [actorState.currentAbilityId, targetState.currentAbilityId] = [targetState.currentAbilityId, actorState.currentAbilityId];
    else {
      [actorState.currentItemId, targetState.currentItemId] = [targetState.currentItemId, actorState.currentItemId];
      [actorState.itemState, targetState.itemState] = [targetState.itemState, actorState.itemState];
    }
    specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, handlerId === "swap-abilities" ? "Abilities swapped" : "Items swapped");
    return handlerId === "swap-abilities" ? reconcileChangedAbilities(branch, [actorKey, targetKey], plan, dataset) : [branch];
  }
  if (["set-insomnia", "set-simple", "copy-ability", "share-ability"].includes(handlerId)) {
    if (!targetState && handlerId !== "copy-ability") return fail("target-unavailable");
    if (handlerId === "set-insomnia") targetState.currentAbilityId = "insomnia";
    if (handlerId === "set-simple") targetState.currentAbilityId = "simple";
    if (handlerId === "copy-ability") actorState.currentAbilityId = targetState?.currentAbilityId || actorState.currentAbilityId;
    if (handlerId === "share-ability") targetState.currentAbilityId = actorState.currentAbilityId;
    specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Ability changed");
    return reconcileChangedAbilities(branch, [handlerId === "copy-ability" ? actorKey : targetKey], plan, dataset);
  }
  if (handlerId === "random-stat-boost") {
    const affectedKey = targetKey || actorKey;
    const eligible = Object.keys(branch.state.combatantStates[affectedKey].statStages).filter(stat => branch.state.combatantStates[affectedKey].statStages[stat] < 6);
    if (!eligible.length) return fail("all-stats-maximized");
    return eligible.map(stat => {
      const next = clone(branch);
      next.probability = probabilityProduct(branch.probability, 1 / eligible.length);
      next.probabilityStatus = next.probability === null ? "unknown" : "known";
      applyStatStages(next, actorKey, affectedKey, move, { target: affectedKey === actorKey ? "self" : "target", statStages: { [stat]: 2 } });
      return next;
    });
  }
  if (handlerId === "flame-burst") {
    if (!targetKey || !targetSide) return [branch];
    const adjacentAllies = adjacentActiveEntries(branch.state, targetSide, targetKey, targetSide, plan)
      .map(entry => entry.combatantKey)
      .filter(key => key !== targetKey && Number(branch.state.combatantStates[key]?.hp?.max) > 0);
    let branches = [branch];
    for (const allyKey of adjacentAllies) {
      branches = branches.flatMap(current => {
        const allyState = current.state.combatantStates[allyKey];
        if (!allyState.abilitySuppressed && String(allyState.currentAbilityId || "").toLowerCase() === "magicguard") return [current];
        return applyResidualDamage(current, allyKey, { cause: "flame-burst", eventType: "collateral-damage", numerator: 1, denominator: 16 });
      });
    }
    return branches;
  }
  if (handlerId === "ally-switch") {
    const slot = actorSlot(branch.state, side, actorKey);
    const position = battleFormat(plan) === "triples" ? triplePositionForSlot(plan, side, slot) : slot;
    const targetPosition = battleFormat(plan) === "triples"
      ? position === TRIPLE_POSITIONS.left ? TRIPLE_POSITIONS.right
        : position === TRIPLE_POSITIONS.right ? TRIPLE_POSITIONS.left
          : -1
      : slot === 0 ? 1 : 0;
    const targetSlot = battleFormat(plan) === "triples" && targetPosition >= 0
      ? tripleSlotForPosition(plan, side, targetPosition)
      : targetPosition;
    const allyKey = targetSlot >= 0 ? activeKey(branch.state, side, targetSlot) : null;
    if (!allyKey || Number(branch.state.combatantStates[allyKey]?.hp?.max) <= 0) return fail("no-active-ally");
    setActiveKey(branch.state, side, slot, allyKey);
    setActiveKey(branch.state, side, targetSlot, actorKey);
    return specialHandlerEvent(branch, actorKey, allyKey, move, handlerId, "Active positions swapped");
  }
  if (["split-defenses", "split-offenses"].includes(handlerId)) {
    if (!targetState) return fail("target-unavailable");
    const stats = handlerId === "split-defenses" ? ["def", "spd"] : ["atk", "spa"];
    actorState.calculatedStatOverrides ||= {};
    targetState.calculatedStatOverrides ||= {};
    for (const stat of stats) {
      const shared = Math.floor((currentCalculatedStat(plan, branch.state, actorKey, stat) + currentCalculatedStat(plan, branch.state, targetKey, stat)) / 2);
      actorState.calculatedStatOverrides[stat] = shared;
      targetState.calculatedStatOverrides[stat] = shared;
    }
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Stats averaged");
  }
  if (handlerId === "perish-song") {
    const affected = [];
    for (const entry of participantEntries(branch.state)) {
      const state = branch.state.combatantStates[entry.combatantKey];
      if (!state.volatileConditions.perishTurns) {
        state.volatileConditions.perishTurns = 3;
        affected.push(entry.combatantKey);
      }
    }
    return specialHandlerEvent(branch, actorKey, null, move, handlerId, "Perish count set to 3", [], { affectedKeys: affected });
  }
  if (handlerId === "psycho-shift") {
    if (!targetState || !actorState.majorStatus) return fail("no-status-to-transfer");
    const statusId = actorState.majorStatus;
    const outcomes = applyMajorStatus(branch, actorKey, targetKey, move, { statusId }, dataset);
    for (const outcome of outcomes) clearStatus(outcome.state.combatantStates[actorKey]);
    return outcomes;
  }
  if (handlerId === "give-item") {
    if (!targetState || targetState.itemState === "held" || actorState.itemState !== "held") return fail("item-transfer-unavailable");
    targetState.currentItemId = actorState.currentItemId;
    targetState.itemState = "held";
    actorState.currentItemId = "";
    actorState.itemState = "none";
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, "Item given");
  }
  if (handlerId === "swallow") {
    const layers = Math.max(0, Math.min(3, Number(actorState.volatileConditions.stockpileLayers || 0)));
    if (!layers) return fail("no-stockpile");
    actorState.volatileConditions.stockpileLayers = 0;
    return applySelfHeal(branch, actorKey, move, { heal: layers === 1 ? [1, 4] : layers === 2 ? [1, 2] : [1, 1] });
  }
  if (handlerId === "reduce-last-move-pp") {
    const lastMoveId = targetState?.lastMoveId;
    if (!lastMoveId || !Number(targetState.movePp[lastMoveId])) return fail("target-has-no-last-move-pp");
    const from = Number(targetState.movePp[lastMoveId]);
    targetState.movePp[lastMoveId] = Math.max(0, from - 4);
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, `${lastMoveId} lost ${from - targetState.movePp[lastMoveId]} PP`);
  }
  if (handlerId === "copy-last-move") {
    const copiedMoveId = targetState?.lastMoveId;
    const index = plan.combatants[actorKey].moves.findIndex(entry => entry.moveId === move.id);
    const copied = dataset.get("moves", copiedMoveId);
    if (!copiedMoveId || !copied || index < 0) return fail("copy-source-unavailable");
    actorState.moveSetOverride = [...(actorState.moveSetOverride || plan.combatants[actorKey].moves)].map((entry, moveIndex) => moveIndex === index ? { moveId: copiedMoveId, maxPp: copied.pp } : { ...entry });
    delete actorState.movePp[move.id];
    actorState.movePp[copiedMoveId] = copied.pp;
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, `Copied ${copied.name}`);
  }
  if (handlerId === "transform") {
    if (!targetState) return fail("target-unavailable");
    transformCombatantState(branch, actorKey, targetKey, plan, { cause: handlerId, moveId: move.id });
    return [branch];
  }
  if (["move-last", "move-next"].includes(handlerId)) {
    if (!targetKey || participantKeys(branch.state, side).length < 2 && participantKeys(branch.state, opposite(side)).length < 2) return fail("requires-doubles");
    if (!pendingActions.some(entry => entry.action?.actorKey === targetKey)) return fail("target-has-already-acted");
    branch.actionOrderDirective = { kind: handlerId, targetKey };
    return specialHandlerEvent(branch, actorKey, targetKey, move, handlerId, handlerId === "move-last" ? "Target acts last" : "Target acts next", [], { orderControl: handlerId });
  }
  if (["call-party-move", "call-last-field-move", "call-target-move", "call-random-move", "call-target-last-move", "nature-power", "sleep-talk"].includes(handlerId)) {
    const declaredActivation = action?.mechanicActivations?.find(entry => entry?.id === "called-move");
    const declared = declaredActivation?.moveId;
    const automatic = handlerId === "call-last-field-move" ? previousLastMoveId
      : handlerId === "call-target-move" || handlerId === "call-target-last-move" ? targetState?.lastMoveId
        : handlerId === "nature-power" ? ({ electric: "thunderbolt", grassy: "energyball", misty: "moonblast", psychic: "psychic" }[branch.state.fieldState.global.terrain?.id] || "triattack")
          : null;
    const calledMoveId = declared || automatic;
    if (!calledMoveId || !dataset.get("moves", calledMoveId)) return fail("called-move-outcome-not-selected");
    if (calledMoveId === move.id) return fail("called-move-cannot-call-itself");
    const calledMove = dataset.get("moves", calledMoveId);
    const calledDescriptor = defaultMoveSupport(calledMove, dataset);
    if (!calledDescriptor.supported) return fail("called-move-is-unsupported");
    event(branch, { eventType: "move-called", actorKey, targetKey, moveId: move.id, metadata: { handlerId, calledMoveId, resultLabel: `Calls ${calledMove.name}` } });
    const calledMode = calledDescriptor.targetMode || canonicalTarget(calledMove);
    const legalCalledTargets = calledDescriptor.target === "target" ? legalTargetKeys(branch.state, side, actorKey, calledMode) : [];
    const calledTargetKey = declaredActivation?.targetKey || (legalCalledTargets.includes(targetKey) ? targetKey : legalCalledTargets[0]);
    const calledAction = { ...action, moveId: calledMoveId, targetKeys: calledTargetKey ? [calledTargetKey] : [], mechanicActivations: [] };
    const targetResolution = moveTargets(branch.state, side, calledAction, calledDescriptor, calledMove, null, battleFormat(plan), plan, dataset);
    const targetAlternatives = targetResolution.alternatives || [targetResolution];
    if (!targetAlternatives.some(resolution => resolution.targetKeys?.length) && calledDescriptor.target === "target") {
      return fail("called-move-has-no-target");
    }
    return targetAlternatives.flatMap((resolution, alternativeIndex) => {
      const current = targetAlternatives.length > 1 ? clone(branch) : branch;
      if (targetAlternatives.length > 1) {
        current.probability = probabilityProduct(current.probability, Number(resolution.probability || 0));
        current.probabilityStatus = current.probability === null ? "unknown" : "known";
        current.conditions.push(`called-target-random:${actorKey}:${calledMove.id}:${alternativeIndex + 1}`);
      }
      const targets = resolution.targetKeys || [];
      recordMoveRedirects(current, actorKey, calledMove.id, resolution.redirects);
      let calledBranches = [current];
      for (const calledTargetKey of targets.length ? targets : [null]) {
        calledBranches = calledBranches.flatMap(candidate => applyMoveToTarget(candidate, {
          side,
          action: calledAction,
          actorKey,
          actor: plan.combatants[actorKey],
          move: calledMove,
          descriptor: calledDescriptor,
          targetKey: calledTargetKey,
          targetCount: Math.max(1, targets.length),
          plan,
          dataset,
          damageAdapter,
          isLastAction,
          previousLastMoveId,
          pendingActions
        }));
      }
      return calledBranches;
    });
  }
  if (handlerId === "instruct") {
    const calledMoveId = targetState?.lastMoveId;
    const banned = new Set(["instruct", "beakblast", "focuspunch", "shelltrap", "sketch", "transform", "mimic", "kingsshield", "struggle"]);
    if (!targetState?.turnFlags?.hasMoved || !calledMoveId || banned.has(toId(calledMoveId))) return fail("target-has-no-repeatable-move");
    const calledMove = dataset.get("moves", calledMoveId);
    const calledDescriptor = defaultMoveSupport(calledMove, dataset);
    if (!calledMove || !calledDescriptor.supported) return fail("target-last-move-is-unsupported");
    const repeatedSide = plan.combatants[targetKey]?.side;
    const calledMode = calledDescriptor.targetMode || canonicalTarget(calledMove);
    const legalTargets = calledDescriptor.target === "target"
      ? legalTargetKeys(branch.state, repeatedSide, targetKey, calledMode, [], battleFormat(plan), calledDescriptor)
      : [];
    const remembered = (targetState.lastMoveTargetKeys || []).find(key => legalTargets.includes(key));
    const calledTargetKey = remembered || legalTargets[0] || null;
    if (calledDescriptor.target === "target" && !calledTargetKey) return fail("repeated-move-has-no-target");
    event(branch, { eventType: "move-called", actorKey, targetKey, moveId: move.id, metadata: { handlerId, calledMoveId, resultLabel: `Instructed ${calledMove.name}` } });
    const ppBefore = Number(targetState.movePp?.[calledMoveId] || 0);
    const repeatedAction = { actionType: "move", actorKey: targetKey, moveId: calledMoveId, targetKeys: calledTargetKey ? [calledTargetKey] : [], mechanicActivations: [] };
    const repeated = applyMove(branch, repeatedSide, actorSlot(branch.state, repeatedSide, targetKey), repeatedAction, plan, dataset, damageAdapter, defaultMoveSupport, isLastAction, null, pendingActions);
    for (const outcome of repeated) outcome.state.combatantStates[targetKey].movePp[calledMoveId] = ppBefore;
    return repeated;
  }
  return fail("handler-not-implemented");
}

function damageOverrides(descriptor, actorState, targetKey) {
  if (descriptor.effectId !== "conditional-damage") return { moveOverrides: undefined, powerConditionMet: undefined };
  if (descriptor.powerCondition !== "damaged-by-target-this-turn") {
    throw new ResolutionError(`Unsupported conditional power rule ${descriptor.powerCondition}`);
  }
  const powerConditionMet = actorState.turnFlags.wasDamaged === true
    && actorState.turnFlags.lastDamageSourceKey === targetKey;
  return {
    moveOverrides: { basePower: powerConditionMet ? descriptor.conditionBasePower : descriptor.basePower },
    powerConditionMet
  };
}

function multiHitOutcomes(operation, actorState, generation) {
  const multihit = operation?.multihit;
  if (!multihit) return [{ moveHits: undefined, probability: 1 }];
  if (Number.isInteger(Number(multihit))) return [{ moveHits: Number(multihit), probability: 1 }];
  if (!Array.isArray(multihit) || multihit.length !== 2) return [{ moveHits: undefined, probability: 1 }];
  const min = Number(multihit[0]);
  const max = Number(multihit[1]);
  if (String(actorState.currentAbilityId || "").toLowerCase() === "skilllink") return [{ moveHits: max, probability: 1 }];
  if (Number(generation) === 5 && min === 2 && max === 5) {
    return [
      { moveHits: 2, probability: 3 / 8 },
      { moveHits: 3, probability: 3 / 8 },
      { moveHits: 4, probability: 1 / 8 },
      { moveHits: 5, probability: 1 / 8 }
    ];
  }
  const count = max - min + 1;
  return Array.from({ length: count }, (_, index) => ({ moveHits: min + index, probability: 1 / count }));
}

function dynamicMoveOverrides(branch, { side, move, actor, target, actorState, targetState, previousLastMoveId, pendingActions, dataset }, existing) {
  const type = String(move.type || "").toLowerCase();
  let basePower = Number(existing?.basePower ?? move.basePower ?? 0);
  let adjusted = existing;
  const moveId = String(move.id || "").toLowerCase();
  if (existing?.basePower === undefined) {
    const actorHp = normalizeRange(actorState.hp);
    const targetHp = normalizeRange(targetState.hp);
    const actorRatio = Number(actorHp.max) / Math.max(1, Number(actorHp.maxHp));
    const targetRatio = Number(targetHp.max) / Math.max(1, Number(targetHp.maxHp));
    if (moveId === "acrobatics" && actorState.itemState !== "held") basePower *= 2;
    else if (moveId === "assurance" && targetState.turnFlags.hpLostThisTurn) basePower *= 2;
    else if (["avalanche", "revenge"].includes(moveId) && actorState.turnFlags.wasDamaged && actorState.turnFlags.lastDamageSourceKey === target.combatantKey) basePower *= 2;
    else if (moveId === "retaliate" && branch.state.fieldState.sides?.[side]?.retaliateReady === true) basePower *= 2;
    else if (moveId === "brine" && targetRatio <= 0.5) basePower *= 2;
    else if (["crushgrip", "wringout"].includes(moveId)) basePower = Math.max(1, Math.floor(120 * targetRatio) + 1);
    else if (["eruption", "waterspout"].includes(moveId)) basePower = Math.max(1, Math.floor(150 * actorRatio));
    else if (moveId === "facade" && actorState.majorStatus && !["slp", "frz"].includes(actorState.majorStatus)) basePower *= 2;
    else if (["flail", "reversal"].includes(moveId)) {
      const bucket = Math.floor(48 * actorRatio);
      basePower = bucket <= 1 ? (bucket === 0 ? 200 : 150) : bucket === 2 ? 100 : bucket === 3 ? 80 : bucket <= 8 ? 40 : 20;
    } else if (moveId === "gyroball") {
      const generation = Number(dataset?.mechanics?.damageGeneration || 5);
      const weatherSuppressed = weatherIsSuppressed(activeStates(branch));
      const actorSpeed = Math.max(1, effectiveActionSpeed({ combatant: actor, combatantState: actorState, battleState: branch.state, side: actor.side, generation, weatherSuppressed }));
      const targetSpeed = Math.max(1, effectiveActionSpeed({ combatant: target, combatantState: targetState, battleState: branch.state, side: target.side, generation, weatherSuppressed }));
      basePower = Math.min(150, Math.floor(25 * targetSpeed / actorSpeed) + 1);
    } else if (moveId === "electroball") {
      const generation = Number(dataset?.mechanics?.damageGeneration || 5);
      const weatherSuppressed = weatherIsSuppressed(activeStates(branch));
      const actorSpeed = Math.max(1, effectiveActionSpeed({ combatant: actor, combatantState: actorState, battleState: branch.state, side: actor.side, generation, weatherSuppressed }));
      const targetSpeed = Math.max(1, effectiveActionSpeed({ combatant: target, combatantState: targetState, battleState: branch.state, side: target.side, generation, weatherSuppressed }));
      const ratio = actorSpeed / targetSpeed;
      basePower = ratio >= 4 ? 150 : ratio >= 3 ? 120 : ratio >= 2 ? 80 : ratio >= 1 ? 60 : 40;
    } else if (moveId === "hex" && targetState.majorStatus) basePower *= 2;
    else if (moveId === "payback" && targetState.turnFlags.hasMoved) basePower *= 2;
    else if (moveId === "pursuit" && pendingActions.some(entry => entry.action?.actorKey === target.combatantKey && entry.action?.actionType === "switch")) basePower *= 2;
    else if (moveId === "storedpower") basePower = 20 + 20 * Object.values(actorState.statStages).filter(value => Number(value) > 0).reduce((sum, value) => sum + Number(value), 0);
    else if (moveId === "trumpcard") {
      const pp = Number(actorState.movePp[move.id] || 0);
      basePower = pp >= 4 ? 40 : pp === 3 ? 50 : pp === 2 ? 60 : pp === 1 ? 80 : 200;
    } else if (moveId === "venoshock" && ["psn", "tox"].includes(targetState.majorStatus)) basePower *= 2;
    else if (moveId === "wakeupslap" && targetState.majorStatus === "slp") basePower *= 2;
    else if (["fusionbolt", "fusionflare"].includes(moveId) && ["fusionbolt", "fusionflare"].includes(previousLastMoveId) && previousLastMoveId !== moveId) basePower *= 2;
    else if (["furycutter", "rollout", "iceball"].includes(moveId)) {
      const count = Math.max(1, Number(actorState.volatileConditions.consecutiveMoveCount || 1));
      basePower = Math.min(moveId === "furycutter" ? 160 : basePower * 16, basePower * (2 ** (count - 1)));
      if (["rollout", "iceball"].includes(moveId) && actorState.volatileConditions.defensecurl) basePower *= 2;
    } else if (moveId === "stomp" && targetState.volatileConditions.minimize) basePower *= 2;
    else if (["gust", "twister"].includes(moveId) && ["fly", "bounce", "skydrop"].includes(targetState.volatileConditions.chargingMoveId)) basePower *= 2;
    else if (["earthquake", "magnitude"].includes(moveId) && targetState.volatileConditions.chargingMoveId === "dig") basePower *= 2;
    else if (["surf", "whirlpool"].includes(moveId) && targetState.volatileConditions.chargingMoveId === "dive") basePower *= 2;
    adjusted = { ...(existing || {}), basePower };
  }
  if (type === "electric" && actorState.volatileConditions?.charge) {
    basePower *= 2;
    adjusted = { ...(adjusted || {}), basePower };
  }
  const mudSportActive = type === "electric" && activeStates(branch).some(state => state.volatileConditions?.mudsport);
  if (!mudSportActive) return adjusted;
  const sportPower = Math.max(1, Math.floor((Math.floor(basePower * 1352) + 2047) / 4096));
  return { ...(adjusted || {}), basePower: sportPower };
}

function resultDamageDistribution(result) {
  const supplied = Array.isArray(result.damageDistribution) ? result.damageDistribution : [];
  const values = Array.isArray(result.damage) ? result.damage : [result.damage];
  const entries = supplied.length
    ? supplied.map(entry => ({ damage: Number(entry.damage), probability: Number(entry.probability) }))
    : values.map(damage => ({ damage: Number(damage), probability: 1 / Math.max(1, values.length) }));
  const grouped = new Map();
  for (const entry of entries) {
    if (!Number.isFinite(entry.damage) || !Number.isFinite(entry.probability) || entry.probability <= 0) continue;
    grouped.set(entry.damage, (grouped.get(entry.damage) || 0) + entry.probability);
  }
  const total = [...grouped.values()].reduce((sum, probability) => sum + probability, 0);
  if (!total) return [];
  return [...grouped.entries()].sort((left, right) => left[0] - right[0]).map(([damage, probability]) => ({ damage, probability: probability / total }));
}

function convolveDamageDistributions(left, right) {
  const grouped = new Map();
  for (const first of left) {
    for (const second of right) {
      const damage = Number(first.damage) + Number(second.damage);
      grouped.set(damage, (grouped.get(damage) || 0) + Number(first.probability) * Number(second.probability));
    }
  }
  return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([damage, probability]) => ({ damage, probability }));
}

function repeatedDamageDistribution(distribution, count) {
  let result = [{ damage: 0, probability: 1 }];
  for (let index = 0; index < count; index += 1) result = convolveDamageDistributions(result, distribution);
  return result;
}

function damageSequenceDistribution(firstDistribution, remainingDistribution, weight = 1) {
  const grouped = new Map();
  for (const first of firstDistribution) {
    for (const remaining of remainingDistribution) {
      const firstDamage = Number(first.damage);
      const remainingDamage = Number(remaining.damage);
      const probability = Number(first.probability) * Number(remaining.probability) * weight;
      const key = `${firstDamage}:${remainingDamage}`;
      const existing = grouped.get(key) || { firstDamage, remainingDamage, damage: firstDamage + remainingDamage, probability: 0 };
      existing.probability += probability;
      grouped.set(key, existing);
    }
  }
  return [...grouped.values()];
}

function normalizeDamageSequences(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = `${entry.firstDamage}:${entry.remainingDamage}`;
    const existing = grouped.get(key) || { ...entry, probability: 0 };
    existing.probability += Number(entry.probability);
    grouped.set(key, existing);
  }
  const total = [...grouped.values()].reduce((sum, entry) => sum + entry.probability, 0) || 1;
  return [...grouped.values()].map(entry => ({ ...entry, probability: entry.probability / total }));
}

function totalDamageDistributionFromSequences(entries) {
  const grouped = new Map();
  for (const entry of entries) grouped.set(entry.damage, (grouped.get(entry.damage) || 0) + Number(entry.probability));
  return [...grouped.entries()].sort((left, right) => left[0] - right[0]).map(([damage, probability]) => ({ damage, probability }));
}

function binomialCoefficient(total, selected) {
  const count = Math.min(selected, total - selected);
  let value = 1;
  for (let index = 1; index <= count; index += 1) value = value * (total - count + index) / index;
  return value;
}

function calculateDamageVariants(branch, { actor, target, actorState, targetState, move, descriptor, damageAdapter, dataset, battleFormat, spreadTargetCount, moveOverrides, moveHits }) {
  updateFlowerGiftSideState(branch);
  let critProbability = criticalHitProbability({
    generation: dataset.mechanics?.damageGeneration,
    descriptor,
    attacker: actor,
    attackerState: actorState,
    defenderState: targetState,
    defenderSideState: branch.state.fieldState.sides?.[target?.side]
  });
  if (critProbability === null) throw new ResolutionError(`Critical-hit branching is unavailable for generation ${dataset.mechanics?.damageGeneration}`);
  if (damageAdapter.supportsCriticalHits !== true) critProbability = 0;

  const calculate = (criticalHit, requestedHits = moveHits, effectiveTargetState = targetState) => {
    const result = damageAdapter.calculate({
      attacker: actor,
      defender: target,
      attackerState: actorState,
      defenderState: effectiveTargetState,
      move,
      fieldState: branch.state.fieldState,
      moveOverrides,
      moveHits: requestedHits,
      criticalHit,
      battleFormat,
      spreadTargetCount
    });
    if (result.status !== "ok") throw new ResolutionError(result.reason || `${move.name} cannot be calculated`);
    return result;
  };

  const totalHits = Number(moveHits || 1);
  const focusSashSequenceRequired = totalHits > 1
    && focusSashCanActivate(branch, targetState, move)
    && Number(targetState.hp?.max) === Number(targetState.hp?.maxHp);
  if (focusSashSequenceRequired) {
    const normalResult = calculate(false, 1);
    const normalDistribution = resultDamageDistribution(normalResult);
    let criticalResult = critProbability > 0 ? calculate(true, 1) : null;
    if (criticalResult && criticalResult.criticalHit !== true) {
      critProbability = 0;
      criticalResult = null;
    }
    const criticalDistribution = criticalResult ? resultDamageDistribution(criticalResult) : normalDistribution;
    const criticalHitCounts = critProbability <= 0
      ? [0]
      : critProbability >= 1
        ? [totalHits]
        : Array.from({ length: totalHits + 1 }, (_, index) => index);
    return criticalHitCounts.map(criticalHits => {
      const normalHits = totalHits - criticalHits;
      const localProbability = critProbability <= 0 || critProbability >= 1
        ? 1
        : binomialCoefficient(totalHits, criticalHits)
          * (critProbability ** criticalHits)
          * ((1 - critProbability) ** normalHits);
      const next = criticalHitCounts.length === 1 ? branch : clone(branch);
      next.probability = probabilityProduct(branch.probability, localProbability);
      next.probabilityStatus = next.probability === null ? "unknown" : "known";
      const sequences = [];
      if (criticalHits > 0) {
        const remaining = convolveDamageDistributions(
          repeatedDamageDistribution(criticalDistribution, criticalHits - 1),
          repeatedDamageDistribution(normalDistribution, normalHits)
        );
        sequences.push(...damageSequenceDistribution(criticalDistribution, remaining, criticalHits / totalHits));
      }
      if (normalHits > 0) {
        const remaining = convolveDamageDistributions(
          repeatedDamageDistribution(criticalDistribution, criticalHits),
          repeatedDamageDistribution(normalDistribution, normalHits - 1)
        );
        sequences.push(...damageSequenceDistribution(normalDistribution, remaining, normalHits / totalHits));
      }
      const normalizedSequences = normalizeDamageSequences(sequences);
      const totalDistribution = totalDamageDistributionFromSequences(normalizedSequences);
      const criticalHit = criticalHits > 0;
      if (criticalHit) next.conditions.push(`critical-hit:${actor.combatantKey}:${target.combatantKey}:${move.id}:${criticalHits}`);
      const baseResult = criticalHit ? criticalResult : normalResult;
      return {
        branch: next,
        result: {
          ...baseResult,
          criticalHit,
          damage: totalDistribution.map(entry => entry.damage),
          damageDistribution: totalDistribution,
          damageSequenceDistribution: normalizedSequences
        },
        criticalHit,
        criticalHits,
        criticalHitProbability: critProbability
      };
    });
  }
  if (totalHits > 1 && critProbability > 0 && critProbability < 1) {
    const normal = calculate(false, 1);
    const critical = calculate(true, 1);
    if (critical.criticalHit !== true) return [{ branch, result: calculate(false), criticalHit: false, criticalHits: 0, criticalHitProbability: 0 }];
    const normalFirstDistribution = resultDamageDistribution(normal);
    const criticalFirstDistribution = resultDamageDistribution(critical);
    const appliedDefenderItemIds = [...new Set([
      ...(normal.appliedDefenderItemIds || []),
      ...(critical.appliedDefenderItemIds || [])
    ])];
    const damageItemActivation = damageReductionItemActivation({ dataset, defenderState: targetState, appliedDefenderItemIds });
    let normalRemainingDistribution = normalFirstDistribution;
    let criticalRemainingDistribution = criticalFirstDistribution;
    if (damageItemActivation) {
      const targetAfterConsumption = clone(targetState);
      targetAfterConsumption.lastItemId = targetAfterConsumption.currentItemId;
      targetAfterConsumption.currentItemId = "";
      targetAfterConsumption.itemState = "consumed";
      normalRemainingDistribution = resultDamageDistribution(calculate(false, 1, targetAfterConsumption));
      criticalRemainingDistribution = resultDamageDistribution(calculate(true, 1, targetAfterConsumption));
    }
    return Array.from({ length: totalHits + 1 }, (_, criticalHits) => {
      const next = clone(branch);
      const normalHits = totalHits - criticalHits;
      const localProbability = binomialCoefficient(totalHits, criticalHits)
        * (critProbability ** criticalHits)
        * ((1 - critProbability) ** normalHits);
      next.probability = probabilityProduct(branch.probability, localProbability);
      next.probabilityStatus = next.probability === null ? "unknown" : "known";
      const sequences = [];
      if (criticalHits > 0) {
        const remaining = convolveDamageDistributions(
          repeatedDamageDistribution(criticalRemainingDistribution, criticalHits - 1),
          repeatedDamageDistribution(normalRemainingDistribution, normalHits)
        );
        sequences.push(...damageSequenceDistribution(criticalFirstDistribution, remaining, criticalHits / totalHits));
      }
      if (normalHits > 0) {
        const remaining = convolveDamageDistributions(
          repeatedDamageDistribution(criticalRemainingDistribution, criticalHits),
          repeatedDamageDistribution(normalRemainingDistribution, normalHits - 1)
        );
        sequences.push(...damageSequenceDistribution(normalFirstDistribution, remaining, normalHits / totalHits));
      }
      const normalizedSequences = normalizeDamageSequences(sequences);
      const distribution = totalDamageDistributionFromSequences(normalizedSequences);
      const criticalHit = criticalHits > 0;
      if (criticalHit) next.conditions.push(`critical-hit:${actor.combatantKey}:${target.combatantKey}:${move.id}:${criticalHits}`);
      return {
        branch: next,
        result: {
          ...(criticalHit ? critical : normal),
          criticalHit,
          damage: distribution.map(entry => entry.damage),
          damageDistribution: distribution,
          damageSequenceDistribution: normalizedSequences,
          appliedDefenderItemIds
        },
        criticalHit,
        criticalHits,
        criticalHitProbability: critProbability
      };
    });
  }

  const modes = critProbability <= 0
    ? [{ criticalHit: false, probability: 1 }]
    : critProbability >= 1
      ? [{ criticalHit: true, probability: 1 }]
      : [{ criticalHit: false, probability: 1 - critProbability }, { criticalHit: true, probability: critProbability }];
  return modes.map(mode => {
    const next = modes.length === 1 ? branch : clone(branch);
    next.probability = probabilityProduct(branch.probability, mode.probability);
    next.probabilityStatus = next.probability === null ? "unknown" : "known";
    const result = calculate(mode.criticalHit);
    const criticalHit = result.criticalHit === true;
    if (criticalHit) next.conditions.push(`critical-hit:${actor.combatantKey}:${target.combatantKey}:${move.id}:1`);
    return { branch: next, result, criticalHit, criticalHits: criticalHit ? totalHits : 0, criticalHitProbability: critProbability };
  });
}

const POST_DAMAGE_HANDLERS = new Set([
  "clear-target-stat-stages",
  "steal-item",
  "remove-item",
  "clear-own-hazards",
  "break-target-screens",
  "wake-target",
  "flame-burst"
]);

function applyMoveEffect(branch, { side, actorKey, targetKey, actor, target, actorState, targetState, move, descriptor, damageAdapter, dataset, isLastAction, battleFormat, spreadTargetCount, plan, action, previousLastMoveId, pendingActions, specialHandlerAlreadyApplied = false }) {
  if (descriptor.effectId === "self-stat-stages") return applySelfStatStages(branch, actorKey, move, descriptor);
  if (descriptor.effectId === "self-heal") return applySelfHeal(branch, actorKey, move, descriptor);
  if (descriptor.effectId === "protect") return applyProtect(branch, actorKey, move, descriptor, dataset, isLastAction);
  if (descriptor.effectId === "major-status") return applyMajorStatus(branch, actorKey, targetKey, move, descriptor, dataset);
  if (descriptor.effectId === "set-field") return applySetField(branch, actorKey, move, descriptor, plan, dataset);
  if (descriptor.effectId === "structured-move") {
    const damageOperation = descriptor.operations.find(operation => operation.kind === "damage");
    const otherOperations = descriptor.operations.filter(operation => operation !== damageOperation);
    const postDamageHandler = POST_DAMAGE_HANDLERS.has(descriptor.specialHandlerId) ? descriptor.specialHandlerId : null;
    let branches = descriptor.specialHandlerId && !postDamageHandler && !specialHandlerAlreadyApplied
      ? applySpecialHandler(branch, { side, actorKey, targetKey, move, dataset, plan, action, previousLastMoveId, damageAdapter, isLastAction, pendingActions }, descriptor.specialHandlerId)
      : [branch];
    if (damageOperation) {
      branches = branches.flatMap(current => {
        if (current.skipCurrentMoveDamage) {
          delete current.skipCurrentMoveDamage;
          return [current];
        }
        const currentActorState = current.state.combatantStates[actorKey];
        const currentTargetState = current.state.combatantStates[targetKey];
        const hitOutcomes = multiHitOutcomes(damageOperation, currentActorState, dataset.mechanics?.damageGeneration);
        return hitOutcomes.flatMap(hitOutcome => {
          const damageBranch = hitOutcomes.length === 1 ? current : clone(current);
          damageBranch.probability = probabilityProduct(current.probability, hitOutcome.probability);
          damageBranch.probabilityStatus = damageBranch.probability === null ? "unknown" : "known";
          const calculatedOverrides = damageOverrides(descriptor, currentActorState, targetKey);
          const moveOverrides = dynamicMoveOverrides(damageBranch, { side, move, actor, target, actorState: currentActorState, targetState: currentTargetState, previousLastMoveId, pendingActions, dataset }, damageBranch.currentMoveOverrides || calculatedOverrides.moveOverrides);
          const powerConditionMet = calculatedOverrides.powerConditionMet;
          const variants = calculateDamageVariants(damageBranch, {
            actor,
            target,
            actorState: currentActorState,
            targetState: currentTargetState,
            move,
            descriptor,
            damageAdapter,
            dataset,
            battleFormat,
            spreadTargetCount,
            moveOverrides,
            moveHits: hitOutcome.moveHits
          });
          return variants.flatMap(variant => applyDamage(variant.branch, {
            actorKey,
            targetKey,
            move,
            damageValues: variant.result.damage,
            damageDistribution: variant.result.damageDistribution,
            damageSequenceDistribution: variant.result.damageSequenceDistribution,
            descriptor,
            effectiveBasePower: moveOverrides?.basePower ?? Number(move.basePower || 0),
            powerConditionMet,
            moveHits: hitOutcome.moveHits,
            dataset,
            appliedDefenderItemIds: variant.result.appliedDefenderItemIds,
            criticalHit: variant.criticalHit,
            criticalHits: variant.criticalHits,
            criticalHitProbability: variant.criticalHitProbability
          }).flatMap(next => applyDamageRecovery(next, actorKey, targetKey, move, damageOperation)));
        });
      });
    }
    if (postDamageHandler) {
      branches = branches.flatMap(current => current.substituteAbsorbedTargetKey === targetKey && postDamageHandler !== "flame-burst"
        ? [current]
        : applySpecialHandler(current, { side, actorKey, targetKey, move, dataset, plan, action, previousLastMoveId, damageAdapter, isLastAction, pendingActions }, postDamageHandler));
    }
    return applyStructuredOperations(branches, { side, actorKey, targetKey, move, dataset, plan, action }, otherOperations);
  }
  const { moveOverrides, powerConditionMet } = damageOverrides(descriptor, actorState, targetKey);
  const effectiveBasePower = moveOverrides?.basePower ?? Number(move.basePower || 0);
  const variants = calculateDamageVariants(branch, {
    actor,
    target,
    actorState,
    targetState,
    move,
    descriptor,
    damageAdapter,
    dataset,
    battleFormat,
    spreadTargetCount,
    moveOverrides
  });
  return variants.flatMap(variant => applyDamage(variant.branch, {
    actorKey,
    targetKey,
    move,
    damageValues: variant.result.damage,
    damageDistribution: variant.result.damageDistribution,
    damageSequenceDistribution: variant.result.damageSequenceDistribution,
    descriptor,
    effectiveBasePower,
    powerConditionMet,
    dataset,
    appliedDefenderItemIds: variant.result.appliedDefenderItemIds,
    criticalHit: variant.criticalHit,
    criticalHits: variant.criticalHits,
    criticalHitProbability: variant.criticalHitProbability
  }));
}

function moveTargets(state, side, action, descriptor, move, declaredTargetSlots, format = "singles", plan = null, dataset = null) {
  if (descriptor.target === "self") return { targetKeys: [action.actorKey], redirects: [] };
  if (descriptor.target === "field") return { targetKeys: [null], redirects: [] };
  const mode = descriptor.targetMode || canonicalTarget(move);
  if (mode === "scripted") {
    const handlerId = descriptor.specialHandlerId;
    if (["counter-damage", "mirror-coat-damage", "metal-burst-damage"].includes(handlerId) && plan && dataset) {
      return retaliationTargetResolution(state, side, action, move, handlerId, plan, dataset, format);
    }
    const sourceKey = state.combatantStates[action.actorKey]?.turnFlags?.lastDamageSourceKey;
    return { targetKeys: sourceKey ? [sourceKey] : [], redirects: [] };
  }
  if (format === "rotation") {
    if (mode === "all") return { targetKeys: [null], redirects: [] };
    if (["adjacentally", "adjacentallyorself"].includes(mode)) {
      return { targetKeys: mode === "adjacentallyorself" ? [action.actorKey] : [], redirects: [] };
    }
    const targetKey = rotationFrontKey(state, opposite(side));
    return { targetKeys: targetKey && Number(state.combatantStates[targetKey]?.hp?.max) > 0 ? [targetKey] : [], redirects: [] };
  }
  if (mode === "all") return { targetKeys: [null], redirects: [] };
  if (mode === "alladjacentfoes") return {
    targetKeys: adjacentActiveEntries(state, side, action.actorKey, opposite(side), format)
      .map(entry => entry.combatantKey)
      .filter(key => Number(state.combatantStates[key]?.hp?.max) > 0),
    redirects: []
  };
  if (mode === "alladjacent") {
    return {
      targetKeys: [
        ...adjacentActiveEntries(state, side, action.actorKey, side, format),
        ...adjacentActiveEntries(state, side, action.actorKey, opposite(side), format)
      ].map(entry => entry.combatantKey).filter(key => key !== action.actorKey && Number(state.combatantStates[key]?.hp?.max) > 0),
      redirects: []
    };
  }
  const redirects = [];
  const selected = (action.targetKeys || []).map(targetKey => {
    const declaredSlot = declaredTargetSlots?.[targetKey];
    const currentTargetKey = declaredSlot ? activeKey(state, declaredSlot.side, declaredSlot.slot) : targetKey;
    const targetSide = declaredSlot?.side
      || (state.active.playerCombatantKeys?.includes(currentTargetKey) ? "player" : null)
      || (state.active.enemyCombatantKeys?.includes(currentTargetKey) ? "enemy" : null);
    const selectableMode = ["normal", "any", "adjacentfoe", "randomnormal", "adjacentally", "adjacentallyorself"].includes(mode);
    if (!selectableMode || !targetSide) return currentTargetKey;
    if (currentTargetKey === action.actorKey && targetKey !== action.actorKey) return null;
    const currentTargetLiving = currentTargetKey && Number(state.combatantStates[currentTargetKey]?.hp?.max) > 0;
    const currentTargetReachable = currentTargetLiving && (
      moveIgnoresDistance(mode, descriptor)
      || combatantsAreAdjacent(state, side, action.actorKey, targetSide, currentTargetKey, format)
      || currentTargetKey === action.actorKey
    );
    if (currentTargetReachable) return currentTargetKey;
    // A living target made unreachable by an earlier Shift is not retargeted.
    if (currentTargetLiving || targetSide === side) return null;
    const redirectedTargetKey = participantKeys(state, targetSide).find(key => Number(state.combatantStates[key]?.hp?.max) > 0 && (
      moveIgnoresDistance(mode, descriptor)
      || combatantsAreAdjacent(state, side, action.actorKey, targetSide, key, format)
    )) || null;
    if (redirectedTargetKey) redirects.push({ fromTargetKey: currentTargetKey || targetKey, targetKey: redirectedTargetKey, reason: "target-fainted" });
    return redirectedTargetKey;
  }).filter(Boolean);
  if (["normal", "any", "adjacentfoe", "randomnormal"].includes(mode) && selected.length === 1) {
    const redirectAbility = toId(move?.type) === "electric" ? "lightningrod"
      : toId(move?.type) === "water" ? "stormdrain"
        : null;
    if (redirectAbility) {
      const redirector = participantEntries(state).find(entry => {
        const targetState = state.combatantStates[entry.combatantKey];
        const reachable = moveIgnoresDistance(mode, descriptor)
          || combatantsAreAdjacent(state, side, action.actorKey, entry.side, entry.combatantKey, format);
        return entry.combatantKey !== action.actorKey
          && entry.combatantKey !== selected[0]
          && reachable
          && Number(targetState?.hp?.max) > 0
          && activeAbilityId(targetState) === redirectAbility;
      });
      if (redirector) {
        redirects.push({ fromTargetKey: selected[0], targetKey: redirector.combatantKey, reason: `${redirectAbility}-redirection` });
        return { targetKeys: [redirector.combatantKey], redirects };
      }
    }
    const targetSide = selected[0] && state.active.playerCombatantKeys?.includes(selected[0]) ? "player"
      : selected[0] && state.active.enemyCombatantKeys?.includes(selected[0]) ? "enemy"
        : null;
    if (targetSide && targetSide !== side) {
      const redirector = participantKeys(state, targetSide).find(key => {
        const targetState = state.combatantStates[key];
        const reachable = moveIgnoresDistance(mode, descriptor)
          || combatantsAreAdjacent(state, side, action.actorKey, targetSide, key, format);
        return reachable && Number(targetState?.hp?.max) > 0 && (targetState.volatileConditions?.followme || targetState.volatileConditions?.ragepowder);
      });
      if (redirector && redirector !== selected[0]) {
        redirects.push({ fromTargetKey: selected[0], targetKey: redirector, reason: "attention-redirection" });
        return { targetKeys: [redirector], redirects };
      }
    }
  }
  return { targetKeys: selected, redirects };
}

function recordMoveRedirects(branch, actorKey, moveId, redirects) {
  for (const redirect of redirects || []) {
    event(branch, {
      eventType: "move-redirected",
      actorKey,
      targetKey: redirect.targetKey,
      moveId,
      metadata: {
        fromTargetKey: redirect.fromTargetKey || null,
        reason: redirect.reason,
        resultLabel: "Move redirected"
      }
    });
  }
}

function applyMoveToTarget(branch, { side, action, actorKey, actor, move, descriptor, targetKey, targetCount, plan, dataset, damageAdapter, isLastAction, previousLastMoveId, pendingActions, specialHandlerAlreadyApplied = false }) {
  const actorState = branch.state.combatantStates[actorKey];
  const target = targetKey ? plan.combatants[targetKey] : null;
  const targetState = targetKey ? branch.state.combatantStates[targetKey] : actorState;
  if (targetKey && Number(targetState?.hp?.max) <= 0) {
    event(branch, { eventType: "action-skipped", actorKey, targetKey, moveId: move.id, reason: "target-fainted-before-action", metadata: { resultLabel: "Target already fainted" } });
    return [branch];
  }
  const targetSide = targetKey ? plan.combatants[targetKey]?.side : null;
  const opposingTarget = targetSide && targetSide !== side;
  // Platinum moveHit records the displayed attack, including non-damaging,
  // missed and protected moves. It is not the Counter/Metal Burst damage log.
  if (Number(dataset.mechanics?.damageGeneration) === 4 && targetKey) {
    targetState.lastHitMoveId = move.id;
    targetState.lastHitSourceKey = actorKey;
  }
  const targetSideState = targetSide ? branch.state.fieldState.sides[targetSide] : null;
  const spreadMove = ["alladjacent", "alladjacentfoes"].includes(descriptor.targetMode || canonicalTarget(move));
  const guarded = opposingTarget && descriptor.breaksProtect !== true && (
    Number(targetSideState?.wideGuardTurns || 0) > 0 && spreadMove
    || Number(targetSideState?.quickGuardTurns || 0) > 0 && Number(move.priority || 0) > 0
  );
  if (guarded) {
    event(branch, { eventType: "move-blocked", actorKey, targetKey, moveId: move.id, metadata: { reason: spreadMove ? "wide-guard" : "quick-guard", resultLabel: spreadMove ? "Blocked by Wide Guard" : "Blocked by Quick Guard" } });
    return [branch];
  }
  if (descriptor.target !== "self" && descriptor.target !== "field" && targetState.turnFlags.protected && descriptor.breaksProtect !== true) {
    event(branch, { eventType: "move-blocked", actorKey, targetKey, moveId: move.id, metadata: { reason: "protect", resultLabel: "Blocked by Protect" } });
    return descriptor.specialHandlerId === "crash-on-failure" ? applyCrashDamage(branch, actorKey, move, "protect") : [branch];
  }
  if (descriptor.specialHandlerId === "crash-on-failure" && Number(branch.state.fieldState.global.gravityTurns || 0) > 0) {
    event(branch, { eventType: "move-failed", actorKey, targetKey, moveId: move.id, metadata: { reason: "gravity", resultLabel: `${move.name} failed under Gravity` } });
    return applyCrashDamage(branch, actorKey, move, "gravity");
  }
  const semiInvulnerability = descriptor.target === "field" || descriptor.target === "self"
    ? null
    : semiInvulnerabilityResult({ move, attackerState: actorState, defenderState: targetState, targetKey });
  if (semiInvulnerability) {
    event(branch, {
      eventType: "move-immune",
      actorKey,
      targetKey,
      moveId: move.id,
      metadata: {
        reason: semiInvulnerability.reason,
        moveType: semiInvulnerability.moveType,
        semiInvulnerableState: semiInvulnerability.stateId,
        resultLabel: "Immune"
      }
    });
    return [branch];
  }
  const immunity = descriptor.target === "field" || descriptor.target === "self"
    ? null
    : moveImmunity({
      dataset,
      move,
      ignoreImmunity: descriptor.ignoreImmunity,
      attackerState: actorState,
      defenderState: targetState,
      fieldState: branch.state.fieldState,
      attackerSide: side,
      defenderSide: targetSide
    });
  if (immunity) {
    event(branch, {
      eventType: "move-immune",
      actorKey,
      targetKey,
      moveId: move.id,
      metadata: { reason: immunity.reason, moveType: immunity.moveType, abilityId: immunity.abilityId || null, resultLabel: "Immune" }
    });
    const effect = immunity.effect;
    if (effect?.kind === "heal") {
      return applyResidualHeal(branch, targetKey, { ...effect, cause: immunity.abilityId, actorKey: targetKey });
    }
    if (effect?.kind === "stat-stage") {
      applyAbilityAwareStatStages(branch, {
        actorKey: targetKey,
        targetKey,
        statStages: { [effect.stat]: effect.delta },
        generation: Number(dataset.mechanics?.damageGeneration || 5),
        cause: immunity.abilityId
      });
    } else if (effect?.kind === "volatile") {
      const previous = Boolean(targetState.volatileConditions?.[effect.volatileId]);
      targetState.volatileConditions[effect.volatileId] = true;
      event(branch, {
        eventType: "ability-activated",
        actorKey: targetKey,
        targetKey,
        moveId: move.id,
        metadata: { cause: immunity.abilityId, resultLabel: `${readableMechanicName(immunity.abilityId)} activated` },
        changes: [{ path: `combatantStates.${targetKey}.volatileConditions.${effect.volatileId}`, from: previous, to: true }]
      });
    }
    return [branch];
  }
  const accuracy = descriptor.target === "field" || descriptor.target === "self"
    ? 100
    : effectiveAccuracy({ move, attackerState: actorState, defenderState: targetState, fieldState: branch.state.fieldState, generation: dataset.mechanics?.damageGeneration });
  const branches = [];
  if (accuracy < 100) {
    const miss = clone(branch);
    miss.probability = probabilityProduct(branch.probability, (100 - accuracy) / 100);
    miss.probabilityStatus = miss.probability === null ? "unknown" : "known";
    event(miss, { eventType: "miss", actorKey, targetKey, moveId: move.id });
    branches.push(...(descriptor.specialHandlerId === "crash-on-failure" ? applyCrashDamage(miss, actorKey, move, "miss") : [miss]));
    branch.probability = probabilityProduct(branch.probability, accuracy / 100);
    branch.probabilityStatus = branch.probability === null ? "unknown" : "known";
  }
  branches.push(...applyMoveEffect(branch, {
    side, actorKey, targetKey, actor, target, actorState, targetState, move, descriptor, damageAdapter, dataset, isLastAction,
    battleFormat: plan.game?.battleFormat || "singles",
    spreadTargetCount: targetCount,
    plan,
    action,
    previousLastMoveId,
    pendingActions,
    specialHandlerAlreadyApplied
  }));
  return branches;
}

function applyMove(branch, side, slot, action, plan, dataset, damageAdapter, moveSupport, isLastAction = false, declaredTargetSlots = null, pendingActions = []) {
  const actorKey = action.actorKey;
  const actorState = branch.state.combatantStates[actorKey];
  if (Number(actorState.hp?.max) <= 0) return skipped(branch, actorKey, "actor-fainted-before-moving");
  const currentSlot = actorSlot(branch.state, side, actorKey);
  if (currentSlot < 0) return skipped(branch, actorKey, "actor-no-longer-active");
  const actor = plan.combatants[actorKey];
  const move = fieldAdjustedMove(effectiveCombatantMove(dataset, actor, actorState, action.moveId), branch.state.fieldState);
  const descriptor = moveSupport(move, dataset);
  const previousLastMoveId = branch.state.fieldState.global.lastMoveId || null;
  actorState.volatileConditions.consecutiveMoveCount = actorState.lastMoveId === action.moveId
    ? Number(actorState.volatileConditions.consecutiveMoveCount || 1) + 1
    : 1;
  if (action.moveId !== "destinybond") actorState.volatileConditions.destinybond = false;
  const continuingMove = action.moveId === "bide" && Number(actorState.volatileConditions.bideTurns || 0) > 0
    || actorState.volatileConditions.chargingMoveId === action.moveId
    || Number(dataset.mechanics?.damageGeneration) === 4 && (actorState.volatileConditions.thrashMoveId === action.moveId || action.moveId === 'uproar' && actorState.volatileConditions.uproarTurns > 0);
  markMoved(branch, actorKey, action.moveId, !continuingMove);
  if (descriptor.effectId !== "protect" && descriptor.specialHandlerId !== "protect") actorState.volatileConditions.protectStreak = 0;
  if (descriptor.specialHandlerId === "self-destruct") {
    const dampKey = participantEntries(branch.state).find(entry => activeAbilityId(branch.state.combatantStates[entry.combatantKey]) === "damp")?.combatantKey;
    if (dampKey) {
      event(branch, { eventType: "move-blocked", actorKey, targetKey: dampKey, moveId: move.id, metadata: { cause: "damp", resultLabel: "Damp prevented the move" } });
      return [branch];
    }
  }
  const targetResolution = moveTargets(branch.state, side, action, descriptor, move, declaredTargetSlots, plan.game?.battleFormat || "singles", plan, dataset);
  const targetAlternatives = targetResolution.alternatives || [targetResolution];
  if (!targetAlternatives.some(resolution => resolution.targetKeys?.length)) return skipped(branch, actorKey, "no-legal-target");
  return targetAlternatives.flatMap((resolution, alternativeIndex) => {
    const current = targetAlternatives.length > 1 ? clone(branch) : branch;
    if (targetAlternatives.length > 1) {
      current.probability = probabilityProduct(current.probability, Number(resolution.probability || 0));
      current.probabilityStatus = current.probability === null ? "unknown" : "known";
      current.conditions.push(`target-random:${actorKey}:${move.id}:${alternativeIndex + 1}`);
    }
    const targets = resolution.targetKeys || [];
    const currentActorState = current.state.combatantStates[actorKey];
    currentActorState.lastMoveTargetKeys = [...targets].filter(Boolean);
    recordMoveRedirects(current, actorKey, move.id, resolution.redirects);
    const pressureCost = targets.filter(targetKey => plan.combatants[targetKey]?.side !== side
      && activeAbilityId(current.state.combatantStates[targetKey]) === "pressure").length;
    if (!continuingMove && pressureCost > 0) {
      const previousPp = Number(currentActorState.movePp[action.moveId] || 0);
      currentActorState.movePp[action.moveId] = Math.max(0, previousPp - pressureCost);
    }
    let branches = [current];
    let specialHandlerAlreadyApplied = false;
    if (descriptor.specialHandlerId === "two-turn-charge") {
      branches = applySpecialHandler(current, {
        side, actorKey, targetKey: targets[0] || null, move, dataset, plan, action, previousLastMoveId, damageAdapter, isLastAction, pendingActions
      }, descriptor.specialHandlerId);
      specialHandlerAlreadyApplied = true;
      if (branches.some(candidate => candidate.skipCurrentMoveDamage)) {
        for (const candidate of branches) delete candidate.skipCurrentMoveDamage;
        return branches;
      }
    }
    for (const targetKey of targets) {
      branches = branches.flatMap(candidate => applyMoveToTarget(candidate, {
        side, action, actorKey, actor, move, descriptor, targetKey, targetCount: targets.length, plan, dataset, damageAdapter,
        isLastAction, previousLastMoveId, pendingActions, specialHandlerAlreadyApplied
      }));
    }
    for (const candidate of branches) delete candidate.state.combatantStates[actorKey].volatileConditions.helpinghand;
    if (String(move.type || "").toLowerCase() === "electric" && String(move.category || "").toLowerCase() !== "status") {
      for (const candidate of branches) candidate.state.combatantStates[actorKey].volatileConditions.charge = false;
    }
    for (const candidate of branches) delete candidate.randomMoveOutcome;
    for (const candidate of branches) delete candidate.substituteAbsorbedTargetKey;
    return branches;
  });
}

function applyMoveAfterStatusChecks(branch, side, slot, action, context) {
  return applyMove(branch, side, slot, action, context.plan, context.dataset, context.damageAdapter, context.moveSupport, context.isLastAction, context.declaredTargetSlots, context.pendingActions);
}

function applyAfterConfusionCheck(branch, side, slot, action, context) {
  const actorKey = action.actorKey;
  const actorState = branch.state.combatantStates[actorKey];
  if (actorState.majorStatus === "par") {
    const unable = clone(branch);
    unable.probability = probabilityProduct(branch.probability, 0.25);
    unable.probabilityStatus = unable.probability === null ? "unknown" : "known";
    unable.state.combatantStates[actorKey].turnFlags.hasMoved = true;
    unable.state.combatantStates[actorKey].volatileConditions.protectStreak = 0;
    event(unable, { eventType: "action-skipped", actorKey, targetKey: null, moveId: action.moveId, reason: "full-paralysis", metadata: { resultLabel: "Fully paralyzed" } });
    const acted = clone(branch);
    acted.probability = probabilityProduct(branch.probability, 0.75);
    acted.probabilityStatus = acted.probability === null ? "unknown" : "known";
    return [unable, ...applyMoveAfterStatusChecks(acted, side, slot, action, context)];
  }
  return applyMoveAfterStatusChecks(branch, side, slot, action, context);
}

function applyConfusionCheck(branch, side, slot, action, context) {
  const actorKey = action.actorKey;
  const actorState = branch.state.combatantStates[actorKey];
  const distribution = statusCounterDistribution(actorState.volatileConditions, "confusion");
  if (!distribution) return applyAfterConfusionCheck(branch, side, slot, action, context);
  const advanced = advanceStatusCounter(distribution);
  const outcomes = [];
  if (advanced.endedProbability > 0) {
    const snapped = clone(branch);
    snapped.probability = probabilityProduct(branch.probability, advanced.endedProbability);
    snapped.probabilityStatus = snapped.probability === null ? "unknown" : "known";
    setStatusCounterDistribution(snapped.state.combatantStates[actorKey].volatileConditions, "confusion", null);
    event(snapped, { eventType: "volatile-status-cleared", actorKey, targetKey: actorKey, moveId: action.moveId, metadata: { volatileStatusId: "confusion", resultLabel: "Snapped out of confusion" } });
    outcomes.push(...applyAfterConfusionCheck(snapped, side, slot, action, context));
  }
  if (advanced.activeProbability > 0) {
    const activeProbability = advanced.activeProbability * 0.5;
    const selfHit = clone(branch);
    selfHit.probability = probabilityProduct(branch.probability, activeProbability);
    selfHit.probabilityStatus = selfHit.probability === null ? "unknown" : "known";
    setStatusCounterDistribution(selfHit.state.combatantStates[actorKey].volatileConditions, "confusion", advanced.activeDistribution);
    selfHit.state.combatantStates[actorKey].turnFlags.hasMoved = true;
    const combatant = context.plan.combatants[actorKey];
    const selfState = selfHit.state.combatantStates[actorKey];
    const attack = Number(selfState.calculatedStatOverrides?.atk ?? selfState.currentStats?.atk ?? combatant.calculatedStats.atk) * stageMultiplier(selfState.statStages.atk) * (selfState.majorStatus === "brn" ? 0.5 : 1);
    const defense = Number(selfState.calculatedStatOverrides?.def ?? selfState.currentStats?.def ?? combatant.calculatedStats.def) * stageMultiplier(selfState.statStages.def);
    const currentLevel = Number(selfState.currentLevel ?? combatant.level);
    const base = Math.floor(Math.floor(Math.floor((Math.floor(2 * currentLevel / 5) + 2) * 40 * attack / Math.max(1, defense)) / 50) + 2);
    const rolls = Array.from({ length: 16 }, (_, index) => Math.max(1, Math.floor(base * (85 + index) / 100)));
    event(selfHit, { eventType: "confusion-self-hit", actorKey, targetKey: actorKey, moveId: action.moveId, metadata: { resultLabel: "Hurt itself in confusion" } });
    outcomes.push(...applyDamage(selfHit, { actorKey, targetKey: actorKey, move: { id: "confusion", name: "Confusion", category: "physical" }, damageValues: rolls, descriptor: {}, effectiveBasePower: 40 }));

    const acted = clone(branch);
    acted.probability = probabilityProduct(branch.probability, activeProbability);
    acted.probabilityStatus = acted.probability === null ? "unknown" : "known";
    setStatusCounterDistribution(acted.state.combatantStates[actorKey].volatileConditions, "confusion", advanced.activeDistribution);
    event(acted, { eventType: "confusion-check", actorKey, targetKey: actorKey, moveId: action.moveId, metadata: { outcome: "acted", resultLabel: "Acts through confusion" } });
    outcomes.push(...applyAfterConfusionCheck(acted, side, slot, action, context));
  }
  return outcomes;
}

function applyAfterSleepCheck(branch, side, slot, action, context) {
  const actorKey = action.actorKey;
  const actorState = branch.state.combatantStates[actorKey];
  if (actorState.majorStatus === "frz") {
    const frozen = clone(branch);
    frozen.probability = probabilityProduct(branch.probability, 0.8);
    frozen.probabilityStatus = frozen.probability === null ? "unknown" : "known";
    frozen.state.combatantStates[actorKey].turnFlags.hasMoved = true;
    event(frozen, { eventType: "action-skipped", actorKey, targetKey: null, moveId: action.moveId, reason: "freeze", metadata: { resultLabel: "Frozen" } });
    const thawed = clone(branch);
    thawed.probability = probabilityProduct(branch.probability, 0.2);
    thawed.probabilityStatus = thawed.probability === null ? "unknown" : "known";
    thawed.state.combatantStates[actorKey].majorStatus = null;
    event(thawed, { eventType: "status-cleared", actorKey, targetKey: actorKey, moveId: action.moveId, metadata: { cause: "thaw", resultLabel: "Thawed out" } });
    return [frozen, ...applyConfusionCheck(thawed, side, slot, action, context)];
  }
  return applyConfusionCheck(branch, side, slot, action, context);
}

function applyStatusActionChecks(branch, side, slot, action, context) {
  const actorKey = action.actorKey;
  const actorState = branch.state.combatantStates[actorKey];
  if (actorState.majorStatus !== "slp" || action.moveId === "sleeptalk") return applyAfterSleepCheck(branch, side, slot, action, context);
  const distribution = statusCounterDistribution(actorState.volatileConditions, "sleep");
  const advanced = advanceStatusCounter(distribution);
  const outcomes = [];
  if (advanced.endedProbability > 0) {
    const woke = clone(branch);
    woke.probability = probabilityProduct(branch.probability, advanced.endedProbability);
    woke.probabilityStatus = woke.probability === null ? "unknown" : "known";
    clearStatus(woke.state.combatantStates[actorKey]);
    event(woke, { eventType: "status-cleared", actorKey, targetKey: actorKey, moveId: action.moveId, metadata: { cause: "wake", resultLabel: "Woke up" } });
    outcomes.push(...applyAfterSleepCheck(woke, side, slot, action, context));
  }
  if (advanced.activeProbability > 0) {
    const asleep = clone(branch);
    asleep.probability = probabilityProduct(branch.probability, advanced.activeProbability);
    asleep.probabilityStatus = asleep.probability === null ? "unknown" : "known";
    setStatusCounterDistribution(asleep.state.combatantStates[actorKey].volatileConditions, "sleep", advanced.activeDistribution);
    asleep.state.combatantStates[actorKey].turnFlags.hasMoved = true;
    event(asleep, { eventType: "action-skipped", actorKey, targetKey: null, moveId: action.moveId, reason: "sleep", metadata: { resultLabel: "Asleep" } });
    outcomes.push(asleep);
  }
  return outcomes;
}

function applyAction(branch, side, slot, action, context) {
  if (action.actionType === "switch") {
    const currentSlot = actorSlot(branch.state, side, action.actorKey);
    return currentSlot < 0 ? skipped(branch, action.actorKey, "actor-no-longer-active") : applySwitch(branch, side, currentSlot, action, context.plan, context.dataset);
  }
  if (action.actionType === "shift") return applyShift(branch, side, action);
  const actorKey = action.actorKey;
  const actorState = branch.state.combatantStates[actorKey];
  if (actorState.volatileConditions?.skyDropSourceKey) {
    actorState.turnFlags.hasMoved = true;
    event(branch, { eventType: "action-skipped", actorKey, targetKey: null, moveId: action.moveId, reason: "sky-drop", metadata: { resultLabel: "Unable to move during Sky Drop" } });
    return [branch];
  }
  if (!actorState.turnFlags.truantChecked) {
    actorState.turnFlags.truantChecked = true;
    const truant = abilityActionRule(actorState);
    if (truant?.kind === "skip") {
      actorState.volatileConditions.truantLoafing = false;
      actorState.turnFlags.hasMoved = true;
      event(branch, { eventType: "action-skipped", actorKey, targetKey: null, moveId: action.moveId, reason: truant.cause, metadata: { cause: truant.cause, resultLabel: truant.resultLabel } });
      return [branch];
    }
    if (truant?.kind === "arm") actorState.volatileConditions.truantLoafing = true;
  }
  if (actorState.volatileConditions?.attractSourceKey && !actorState.turnFlags.attractChecked) {
    const sourceKey = actorState.volatileConditions.attractSourceKey;
    const sourceActive = participantEntries(branch.state).some(entry => entry.combatantKey === sourceKey);
    if (!sourceActive || Number(branch.state.combatantStates[sourceKey]?.hp?.max) <= 0) {
      actorState.volatileConditions.attractSourceKey = null;
    } else {
      const unable = clone(branch);
      unable.probability = probabilityProduct(branch.probability, 0.5);
      unable.probabilityStatus = unable.probability === null ? "unknown" : "known";
      unable.state.combatantStates[actorKey].turnFlags.hasMoved = true;
      unable.state.combatantStates[actorKey].turnFlags.attractChecked = true;
      event(unable, { eventType: "action-skipped", actorKey, targetKey: null, moveId: action.moveId, reason: "attract", metadata: { resultLabel: "Immobilized by love" } });
      const acted = clone(branch);
      acted.probability = probabilityProduct(branch.probability, 0.5);
      acted.probabilityStatus = acted.probability === null ? "unknown" : "known";
      acted.state.combatantStates[actorKey].turnFlags.attractChecked = true;
      return [unable, ...applyAction(acted, side, slot, action, context)];
    }
  }
  if (actorState.turnFlags.flinched) {
    actorState.turnFlags.hasMoved = true;
    event(branch, { eventType: "action-skipped", actorKey, targetKey: null, moveId: action.moveId, reason: "flinch", metadata: { resultLabel: "Flinched" } });
    return [branch];
  }
  if (actorState.volatileConditions?.rechargeRequired) {
    actorState.volatileConditions.rechargeRequired = false;
    actorState.volatileConditions.protectStreak = 0;
    actorState.turnFlags.hasMoved = true;
    event(branch, { eventType: "action-skipped", actorKey, targetKey: null, moveId: action.moveId, reason: "recharge", metadata: { resultLabel: "Must recharge" } });
    return [branch];
  }
  return applyStatusActionChecks(branch, side, slot, action, context);
}

function fixedHpAmount(state, rule) {
  if (Number.isFinite(Number(rule.amount))) return Math.max(0, Number(rule.amount));
  return Math.max(1, Math.floor(Number(state.hp.maxHp) * Number(rule.numerator) / Number(rule.denominator)));
}

function applyResidualDamage(branch, targetKey, rule) {
  const targetState = branch.state.combatantStates[targetKey];
  const amount = fixedHpAmount(targetState, rule);
  const maxHp = Number(targetState.hp.maxHp);
  const distribution = distributionFor(targetState);
  if (!distribution) {
    const hp = normalizeRange(targetState.hp);
    const outcomes = [];
    if (amount >= hp.min) {
      const fainted = clone(branch);
      fainted.probability = null;
      fainted.probabilityStatus = "unknown";
      fainted.state.combatantStates[targetKey].hp = { min: 0, max: 0, maxHp };
      fainted.state.combatantStates[targetKey].hpDistribution = [{ value: 0, probability: 1 }];
      markHpLostThisTurn(fainted.state.combatantStates[targetKey], amount);
      event(fainted, { eventType: rule.eventType || "residual-damage", actorKey: rule.actorKey ?? null, targetKey, moveId: null, damageHp: { min: amount, max: amount }, damagePercent: { min: amount / maxHp * 100, max: amount / maxHp * 100 }, metadata: { cause: rule.cause, thresholdOutcome: "ko", resultLabel: `${readableMechanicName(rule.cause)} damage` } });
      outcomes.push(fainted);
    }
    if (amount < hp.max) {
      const survived = clone(branch);
      survived.probability = null;
      survived.probabilityStatus = "unknown";
      survived.state.combatantStates[targetKey].hp = { min: Math.max(1, hp.min - amount), max: hp.max - amount, maxHp };
      delete survived.state.combatantStates[targetKey].hpDistribution;
      markHpLostThisTurn(survived.state.combatantStates[targetKey], amount);
      event(survived, { eventType: rule.eventType || "residual-damage", actorKey: rule.actorKey ?? null, targetKey, moveId: null, damageHp: { min: amount, max: amount }, damagePercent: { min: amount / maxHp * 100, max: amount / maxHp * 100 }, metadata: { cause: rule.cause, thresholdOutcome: "survive", resultLabel: `${readableMechanicName(rule.cause)} damage` } });
      outcomes.push(survived);
    }
    return outcomes;
  }
  const buckets = { ko: [], survive: [] };
  for (const entry of distribution) {
    const remaining = Math.max(0, Number(entry.value) - amount);
    buckets[remaining === 0 ? "ko" : "survive"].push({ value: remaining, probability: Number(entry.probability) });
  }
  const outcomes = [];
  for (const [kind, entries] of Object.entries(buckets)) {
    if (!entries.length) continue;
    const localProbability = entries.reduce((sum, entry) => sum + entry.probability, 0);
    const next = clone(branch);
    next.probability = probabilityProduct(branch.probability, localProbability);
    next.probabilityStatus = next.probability === null ? "unknown" : "known";
    setHpDistribution(next.state.combatantStates[targetKey], entries.map(entry => ({ value: entry.value, probability: entry.probability / localProbability })));
    markHpLostThisTurn(next.state.combatantStates[targetKey], amount);
    event(next, { eventType: rule.eventType || "residual-damage", actorKey: rule.actorKey ?? null, targetKey, moveId: null, damageHp: { min: amount, max: amount }, damagePercent: { min: amount / maxHp * 100, max: amount / maxHp * 100 }, metadata: { cause: rule.cause, thresholdOutcome: kind, resultLabel: `${readableMechanicName(rule.cause)} damage` } });
    outcomes.push(next);
  }
  return outcomes;
}

function applyResidualHeal(branch, targetKey, rule) {
  const targetState = branch.state.combatantStates[targetKey];
  const amount = fixedHpAmount(targetState, rule);
  const maxHp = Number(targetState.hp.maxHp);
  const distribution = distributionFor(targetState);
  let healedValues;
  if (distribution) {
    healedValues = distribution.map(entry => Math.max(0, Math.min(amount, maxHp - Number(entry.value))));
    setHpDistribution(targetState, distribution.map(entry => ({ value: Math.min(maxHp, Number(entry.value) + amount), probability: entry.probability })));
  } else {
    const hp = normalizeRange(targetState.hp);
    healedValues = [Math.max(0, Math.min(amount, maxHp - hp.max)), Math.max(0, Math.min(amount, maxHp - hp.min))];
    targetState.hp = { min: Math.min(maxHp, hp.min + amount), max: Math.min(maxHp, hp.max + amount), maxHp };
    delete targetState.hpDistribution;
  }
  const healingHp = { min: Math.min(...healedValues), max: Math.max(...healedValues) };
  event(branch, { eventType: rule.eventType || "residual-heal", actorKey: rule.actorKey ?? null, targetKey, moveId: null, healingHp, healingPercent: percentRange(healingHp, maxHp), metadata: { cause: rule.cause, resultLabel: `${readableMechanicName(rule.cause)} recovery` } });
  return [branch];
}

function applyResidualRule(branch, targetKey, rule) {
  if (!rule) return [branch];
  if (rule.unsupported) throw new ResolutionError(rule.reason);
  const outcomes = rule.kind === "heal"
    ? applyResidualHeal(branch, targetKey, rule)
    : applyResidualDamage(branch, targetKey, rule);
  if (rule.nextToxicCounter !== null && rule.nextToxicCounter !== undefined) {
    for (const outcome of outcomes) outcome.state.combatantStates[targetKey].toxicCounter = rule.nextToxicCounter;
  }
  return outcomes;
}

function activeStates(branch) {
  return participantEntries(branch.state).map(entry => branch.state.combatantStates[entry.combatantKey]).filter(Boolean);
}

function resolveDueDelayedAttacks(branch, plan, dataset, damageAdapter) {
  const delayed = branch.state.fieldState.global.delayedAttacks || [];
  const index = delayed.findIndex(entry => Number(entry.remainingTurns) <= 0);
  if (index < 0) return [branch];
  const [entry] = delayed.splice(index, 1);
  const targetKey = entry.rotationFront && branch.state.rotation
    ? rotationFrontKey(branch.state, entry.side)
    : activeKey(branch.state, entry.side, Number(entry.slot));
  const source = plan.combatants[entry.sourceKey];
  const target = plan.combatants[targetKey];
  const sourceState = branch.state.combatantStates[entry.sourceKey];
  const targetState = branch.state.combatantStates[targetKey];
  const move = dataset.get("moves", entry.moveId);
  if (!source || !target || !sourceState || !targetState || !move || Number(targetState.hp?.max) <= 0) {
    event(branch, { eventType: "delayed-attack-failed", actorKey: entry.sourceKey, targetKey: targetKey || null, moveId: entry.moveId, metadata: { resultLabel: `${entry.moveId} had no target` } });
    return resolveDueDelayedAttacks(branch, plan, dataset, damageAdapter);
  }
  const result = damageAdapter.calculate({
    attacker: source,
    defender: target,
    attackerState: sourceState,
    defenderState: targetState,
    move,
    fieldState: branch.state.fieldState,
    battleFormat: plan.game?.battleFormat || "singles",
    spreadTargetCount: 1
  });
  if (result.status !== "ok") throw new ResolutionError(result.reason || `${move.name} delayed damage cannot be calculated`);
  event(branch, { eventType: "delayed-attack", actorKey: entry.sourceKey, targetKey, moveId: move.id, metadata: { resultLabel: `${move.name} struck` } });
  return applyDamage(branch, {
    actorKey: entry.sourceKey,
    targetKey,
    move,
    damageValues: result.damage,
    damageDistribution: result.damageDistribution,
    descriptor: {},
    effectiveBasePower: Number(move.basePower || 0),
    dataset,
    appliedDefenderItemIds: result.appliedDefenderItemIds
  }).flatMap(next => resolveDueDelayedAttacks(next, plan, dataset, damageAdapter));
}

function applyDelayedEffects(branch, plan, dataset, damageAdapter) {
  for (const entry of branch.state.fieldState.global.delayedAttacks || []) entry.remainingTurns = Number(entry.remainingTurns) - 1;
  for (const entry of branch.state.fieldState.global.delayedHeals || []) entry.remainingTurns = Number(entry.remainingTurns) - 1;
  let branches = resolveDueDelayedAttacks(branch, plan, dataset, damageAdapter);
  branches = branches.flatMap(current => {
    const delayed = current.state.fieldState.global.delayedHeals || [];
    const due = delayed.filter(entry => Number(entry.remainingTurns) <= 0);
    current.state.fieldState.global.delayedHeals = delayed.filter(entry => Number(entry.remainingTurns) > 0);
    let healed = [current];
    for (const entry of due) {
      healed = healed.flatMap(next => {
        const targetKey = entry.rotationFront && next.state.rotation
          ? rotationFrontKey(next.state, entry.side)
          : activeKey(next.state, entry.side, Number(entry.slot));
        const state = next.state.combatantStates[targetKey];
        if (!state || Number(state.hp?.max) <= 0) {
          event(next, { eventType: "delayed-heal-failed", actorKey: entry.sourceKey, targetKey: targetKey || null, moveId: "wish", metadata: { resultLabel: "Wish had no target" } });
          return [next];
        }
        event(next, { eventType: "delayed-heal", actorKey: entry.sourceKey, targetKey, moveId: "wish", metadata: { resultLabel: "Wish came true" } });
        return applyResidualHeal(next, targetKey, { kind: "heal", amount: Number(entry.amount), cause: "wish" });
      });
    }
    return healed;
  });
  return branches;
}

function applyVolatileEndOfTurn(branch, targetKey, dataset) {
  const state = branch.state.combatantStates[targetKey];
  const volatiles = state.volatileConditions || {};
  let branches = [branch];
  for (const [flag, rule] of [
    ["aquaRing", { kind: "heal", numerator: 1, denominator: 16, cause: "aqua-ring" }],
    ["aquaring", { kind: "heal", numerator: 1, denominator: 16, cause: "aqua-ring" }],
    ["ingrain", { kind: "heal", numerator: 1, denominator: 16, cause: "ingrain" }],
    ["nightmare", state.majorStatus === "slp" ? { kind: "damage", numerator: 1, denominator: 4, cause: "nightmare" } : null],
    ["curseSourceKey", volatiles.curseSourceKey ? { kind: "damage", numerator: 1, denominator: 4, cause: "curse" } : null],
    ["partiallyTrappedTurns", Number(volatiles.partiallyTrappedTurns || 0) > 0 ? { kind: "damage", numerator: 1, denominator: 8, cause: "partial-trap" } : null]
  ]) {
    if (volatiles[flag] && rule) branches = branches.flatMap(current => applyResidualRule(current, targetKey, rule));
  }
  if (volatiles.leechSeeded) {
    const sourceKey = volatiles.leechSeedSourceKey;
    const amount = Math.max(1, Math.floor(Number(state.hp.maxHp) / 8));
    branches = branches.flatMap(current => applyResidualDamage(current, targetKey, { kind: "damage", amount, cause: "leech-seed" }).flatMap(next => {
      const sourceState = next.state.combatantStates[sourceKey];
      if (!sourceState || Number(sourceState.hp.max) <= 0) return [next];
      return applyResidualHeal(next, sourceKey, { kind: "heal", amount, cause: "leech-seed" });
    }));
  }
  const targetSide = activeKeys(branch.state, "player").includes(targetKey) ? "player" : "enemy";
  if (Number(branch.state.fieldState.sides[targetSide]?.seaOfFireTurns || 0) > 0 && !state.currentTypeIds.map(type => String(type).toLowerCase()).includes("fire")) {
    branches = branches.flatMap(current => applyResidualDamage(current, targetKey, { kind: "damage", numerator: 1, denominator: 8, cause: "sea-of-fire" }));
  }
  for (const current of branches) {
    const currentVolatiles = current.state.combatantStates[targetKey].volatileConditions;
    if (Number(currentVolatiles.partiallyTrappedTurns || 0) > 0) currentVolatiles.partiallyTrappedTurns -= 1;
  }
  branches = branches.flatMap(current => {
    const currentState = current.state.combatantStates[targetKey];
    const currentVolatiles = currentState.volatileConditions;
    if (Number(currentVolatiles.yawnTurns || 0) > 0) {
      currentVolatiles.yawnTurns -= 1;
      if (currentVolatiles.yawnTurns === 0) {
        return applyMajorStatus(current, currentVolatiles.yawnSourceKey || targetKey, targetKey, { id: "yawn", name: "Yawn" }, { statusId: "slp", immuneAbilities: ["insomnia", "vitalspirit", "sweetveil"] }, dataset);
      }
    }
    return [current];
  });
  for (const current of branches) {
    const currentState = current.state.combatantStates[targetKey];
    const perish = Number(currentState.volatileConditions.perishTurns || 0);
    if (perish > 0) {
      const next = perish - 1;
      currentState.volatileConditions.perishTurns = next;
      event(current, { eventType: "perish-count", actorKey: null, targetKey, moveId: null, metadata: { remainingTurns: next, resultLabel: next ? `Perish count ${next}` : "Perished" } });
      if (next === 0) setExactCurrentHp(currentState, 0);
    }
  }
  return branches;
}

function cureMajorStatus(branch, targetKey, cause) {
  const state = branch.state.combatantStates[targetKey];
  const previous = state.majorStatus;
  if (!previous) return branch;
  state.majorStatus = null;
  state.toxicCounter = 0;
  state.volatileConditions.sleepTurns = null;
  state.volatileConditions.sleepCounterDistribution = null;
  state.volatileConditions.sleepCounterStartDistribution = null;
  event(branch, {
    eventType: "status-cured",
    actorKey: targetKey,
    targetKey,
    moveId: null,
    changes: [{ path: `combatantStates.${targetKey}.majorStatus`, from: previous, to: null }],
    metadata: { cause, statusId: previous, resultLabel: `${readableMechanicName(cause)} cured ${previous.toUpperCase()}` }
  });
  return branch;
}

function probabilityBranch(branch, probability, mutateApplied, skippedEvent) {
  const applied = clone(branch);
  applied.probability = probabilityProduct(branch.probability, probability);
  applied.probabilityStatus = applied.probability === null ? "unknown" : "known";
  mutateApplied(applied);
  const skippedBranch = clone(branch);
  skippedBranch.probability = probabilityProduct(branch.probability, 1 - probability);
  skippedBranch.probabilityStatus = skippedBranch.probability === null ? "unknown" : "known";
  if (skippedEvent) event(skippedBranch, skippedEvent);
  return [applied, skippedBranch];
}

function applyMoodyEndOfTurn(branch, targetKey, cause) {
  const state = branch.state.combatantStates[targetKey];
  const stats = ["atk", "def", "spa", "spd", "spe", "accuracy", "evasion"];
  const boosts = stats.filter(stat => clampStage(state.statStages[stat]) < 6);
  if (!boosts.length) return [branch];
  const results = [];
  for (const boostStat of boosts) {
    const drops = stats.filter(stat => stat !== boostStat && clampStage(state.statStages[stat]) > -6);
    if (!drops.length) {
      const next = clone(branch);
      next.probability = probabilityProduct(branch.probability, 1 / boosts.length);
      applyAbilityAwareStatStages(next, { actorKey: targetKey, targetKey, statStages: { [boostStat]: 2 }, generation: Number(branch.generation || 5), cause });
      results.push(next);
      continue;
    }
    for (const dropStat of drops) {
      const next = clone(branch);
      next.probability = probabilityProduct(branch.probability, 1 / boosts.length / drops.length);
      next.probabilityStatus = next.probability === null ? "unknown" : "known";
      applyAbilityAwareStatStages(next, { actorKey: targetKey, targetKey, statStages: { [boostStat]: 2, [dropStat]: -1 }, generation: Number(branch.generation || 5), cause });
      results.push(next);
    }
  }
  return results;
}

function applyAbilityEndOfTurn(branch, targetKey, residualOrder) {
  const state = branch.state.combatantStates[targetKey];
  if (!state || Number(state.hp?.max) <= 0) return [branch];
  const side = activeKeys(branch.state, "player").includes(targetKey) ? "player" : "enemy";
  const opposingStates = participantKeys(branch.state, opposite(side)).map(combatantKey => ({
    combatantKey,
    state: branch.state.combatantStates[combatantKey]
  }));
  const rule = abilityEndOfTurnEffect({ state, fieldState: branch.state.fieldState, opposingStates });
  if (!rule || Number(rule.residualOrder) !== Number(residualOrder)) return [branch];
  if (rule.kind === "stat-stage") {
    applyAbilityAwareStatStages(branch, { actorKey: targetKey, targetKey, statStages: { [rule.stat]: rule.delta }, generation: Number(branch.generation || 5), cause: rule.cause });
    return [branch];
  }
  if (rule.kind === "moody") return applyMoodyEndOfTurn(branch, targetKey, rule.cause);
  if (rule.kind === "cure-status") return [cureMajorStatus(branch, targetKey, rule.cause)];
  if (rule.kind === "chance-cure-status") {
    return probabilityBranch(
      branch,
      Number(rule.chance),
      applied => cureMajorStatus(applied, targetKey, rule.cause),
      { eventType: "ability-no-effect", actorKey: targetKey, targetKey, moveId: null, metadata: { cause: rule.cause, resultLabel: `${readableMechanicName(rule.cause)} did not cure the status` } }
    );
  }
  if (rule.kind === "heal") return applyResidualHeal(branch, targetKey, { ...rule, actorKey: targetKey });
  if (rule.kind === "damage") return applyResidualDamage(branch, targetKey, { ...rule, actorKey: targetKey });
  if (rule.kind === "damage-targets") {
    let branches = [branch];
    for (const affectedKey of rule.targetKeys) {
      branches = branches.flatMap(current => Number(current.state.combatantStates[affectedKey]?.hp?.max) > 0
        ? applyResidualDamage(current, affectedKey, { ...rule, actorKey: targetKey })
        : [current]);
    }
    return branches;
  }
  return [branch];
}

function applyZenModeEndOfTurn(branch, targetKey, plan, dataset) {
  const state = branch.state.combatantStates[targetKey];
  if (!state || Number(state.hp?.max) <= 0 || state.transformedIntoKey) return [branch];
  const combatant = plan.combatants[targetKey];
  if (!String(combatant?.speciesId || "").toLowerCase().startsWith("darmanitan")) return [branch];
  const threshold = Number(state.hp.maxHp) / 2;
  const distribution = distributionFor(state);
  const crossesThreshold = Number(state.hp.min) <= threshold && Number(state.hp.max) > threshold;
  if (crossesThreshold && !distribution) {
    const uncertain = clone(branch);
    uncertain.probability = null;
    uncertain.probabilityStatus = "unknown";
    uncertain.conditions.push(`zen-mode-threshold:${targetKey}:unresolved-hp-range`);
    return [uncertain];
  }
  const groups = crossesThreshold
    ? [
      { id: "zen", entries: distribution.filter(entry => Number(entry.value) <= threshold) },
      { id: "standard", entries: distribution.filter(entry => Number(entry.value) > threshold) }
    ].filter(group => group.entries.length)
    : [{ id: Number(state.hp.max) <= threshold ? "zen" : "standard", entries: distribution }];
  return groups.map(group => {
    const next = groups.length > 1 ? clone(branch) : branch;
    if (groups.length > 1) {
      const groupProbability = group.entries.reduce((sum, entry) => sum + Number(entry.probability || 0), 0);
      next.probability = probabilityProduct(next.probability, groupProbability);
      next.probabilityStatus = next.probability === null ? "unknown" : "known";
      setHpDistribution(next.state.combatantStates[targetKey], group.entries);
      next.conditions.push(`zen-mode-threshold:${targetKey}:${group.id}`);
    }
    const targetState = next.state.combatantStates[targetKey];
    const form = desiredZenModeForm({ combatant, state: targetState });
    const changes = applyCombatantFormState({ combatant, state: targetState, dataset, form });
    formChangeEvent(next, targetKey, form, changes);
    return next;
  });
}

function applyEndOfTurn(branch, dataset, plan, damageAdapter) {
  let branches = applyDelayedEffects(branch, plan, dataset, damageAdapter);
  const initialStates = activeStates(branch);
  for (const [index, state] of initialStates.entries()) {
    const issue = endOfTurnSupportIssue(state, branch.state.fieldState, initialStates[index === 0 ? 1 : 0]);
    if (issue) throw new ResolutionError(issue);
  }
  for (const phase of ["weather", "ability-weather", "ability-early", "item", "status", "ability-late"]) {
    for (const entry of participantEntries(branch.state)) {
      branches = branches.flatMap(current => {
        const targetKey = activeKey(current.state, entry.side, entry.slot);
        const state = current.state.combatantStates[targetKey];
        if (!state || Number(state.hp?.max) <= 0) return [current];
        let rule = null;
        if (phase === "weather" && !weatherIsSuppressed(activeStates(current))) {
          rule = weatherResidualRule(current.state.fieldState?.global?.weather, state);
        } else if (phase === "ability-weather") {
          return weatherIsSuppressed(activeStates(current)) ? [current] : applyAbilityEndOfTurn(current, targetKey, 1);
        } else if (phase === "ability-early") {
          return applyAbilityEndOfTurn(current, targetKey, 5);
        } else if (phase === "status") {
          rule = statusResidualRule(state, dataset.mechanics?.damageGeneration);
        } else if (phase === "item") {
          rule = itemResidualRule(state);
        } else if (phase === "ability-late") {
          return applyAbilityEndOfTurn(current, targetKey, 28);
        }
        return applyResidualRule(current, targetKey, rule);
      });
    }
  }
  for (const entry of participantEntries(branch.state)) {
    branches = branches.flatMap(current => {
      const targetKey = activeKey(current.state, entry.side, entry.slot);
      const state = current.state.combatantStates[targetKey];
      return !state || Number(state.hp?.max) <= 0 ? [current] : applyVolatileEndOfTurn(current, targetKey, dataset);
    });
  }
  for (const entry of participantEntries(branch.state)) {
    branches = branches.flatMap(current => {
      const targetKey = activeKey(current.state, entry.side, entry.slot);
      return targetKey ? applyZenModeEndOfTurn(current, targetKey, plan, dataset) : [current];
    });
  }
  for (const current of branches) {
    if (Number(dataset.mechanics?.damageGeneration) === 4 && activeStates(current).some(mon => mon.volatileConditions?.uproarTurns > 0)) {
      for (const entry of participantEntries(current.state)) {
        const mon = current.state.combatantStates[entry.combatantKey];
        if (mon?.hp?.max > 0 && mon.majorStatus === 'slp' && activeAbilityId(mon) !== 'soundproof') cureMajorStatus(current, entry.combatantKey, 'uproar');
      }
    }
    decrementTurnLimitedEffects(current, dataset);
    refreshWeatherAbilityForms(current, plan, dataset);
  }
  return branches;
}

function decrementFieldCondition(branch, kind) {
  const current = normalizeFieldCondition(kind, branch.state.fieldState?.global?.[kind]);
  if (current.durationMode !== "turns" || !Number.isFinite(Number(current.remainingTurns))) {
    branch.state.fieldState.global[kind] = current;
    return;
  }
  const remainingTurns = Math.max(0, Number(current.remainingTurns) - 1);
  const next = remainingTurns > 0 ? { ...current, remainingTurns } : normalizeFieldCondition(kind, null);
  branch.state.fieldState.global[kind] = next;
  event(branch, {
    eventType: remainingTurns > 0 ? "field-duration" : "field-expired",
    actorKey: null,
    targetKey: null,
    moveId: null,
    changes: [{ path: `fieldState.global.${kind}.remainingTurns`, from: current.remainingTurns, to: remainingTurns }],
    metadata: { fieldKind: kind, fieldId: current.id, remainingTurns }
  });
}

function decrementTurnLimitedEffects(branch, dataset) {
  decrementFieldCondition(branch, "weather");
  decrementFieldCondition(branch, "terrain");
  for (const key of ["trickRoomTurns", "gravityTurns", "magicRoomTurns", "wonderRoomTurns", "ionDelugeTurns", "fairyLockTurns"]) {
    const current = Number(branch.state.fieldState.global[key] || 0);
    if (current > 0) branch.state.fieldState.global[key] = current - 1;
  }
  for (const side of ["player", "enemy"]) {
    const sideState = branch.state.fieldState.sides?.[side] || {};
    for (const key of ["reflectTurns", "lightScreenTurns", "auroraVeilTurns", "tailwindTurns", "safeguardTurns", "mistTurns", "luckyChantTurns", "quickGuardTurns", "wideGuardTurns", "rainbowTurns", "swampTurns", "seaOfFireTurns"]) {
      const current = Number(sideState[key] || 0);
      if (current > 0) sideState[key] = current - 1;
    }
  }
  for (const [combatantKey, state] of Object.entries(branch.state.combatantStates)) {
    const volatiles = state.volatileConditions || {};
    volatiles.followme = false;
    volatiles.ragepowder = false;
    volatiles.selfDestructResolved = false;
    volatiles.roost = false;
    const uproarTurns = Number(volatiles.uproarTurns || 0);
    if (uproarTurns > 0) volatiles.uproarTurns = uproarTurns - 1;
    const failedLockedMove = Number(dataset?.mechanics?.damageGeneration) === 4 && branch.events.some(entry => entry.actorKey === combatantKey && (
      entry.eventType === 'move-immune' && entry.metadata?.reason === 'type-immunity'
      || entry.eventType === 'confusion-self-hit'
      || entry.eventType === 'action-skipped' && ['full-paralysis', 'flinch', 'attract'].includes(entry.reason)
    ));
    if (failedLockedMove && uproarTurns > 0) volatiles.uproarTurns = 0;
    if (Number(dataset?.mechanics?.damageGeneration) === 4 && volatiles.thrashTurns > 0) {
      volatiles.thrashTurns -= 1;
      // Retail MoveFailed is not the broad DID_NOT_HIT mask: misses/Protect do
      // not terminate this counter, while ordinary type immunity does.
      const failed = failedLockedMove;
      if (failed) volatiles.thrashTurns = 0;
      if (volatiles.thrashTurns === 0) {
        volatiles.thrashMoveId = null;
        if (!failed && !statusCounterDistribution(volatiles, 'confusion') && activeAbilityId(state) !== 'owntempo') setStatusCounterDistribution(volatiles, 'confusion', uniformStatusCounterDistribution());
      }
    }
    for (const [turnField, valueField] of [["tauntTurns", null], ["disableTurns", "disabledMoveId"], ["encoreTurns", "encoredMoveId"], ["magnetRiseTurns", null], ["telekinesisTurns", null], ["healBlockTurns", null], ["embargoTurns", null]]) {
      const turns = Number(volatiles[turnField] || 0);
      if (turns <= 0) continue;
      volatiles[turnField] = turns - 1;
      if (volatiles[turnField] === 0 && valueField) volatiles[valueField] = null;
    }
  }
}

function updateBattleBoundary(branch, plan) {
  updateFlowerGiftSideState(branch);
  const pending = [];
  let ended = false;
  for (const side of ["player", "enemy"]) {
    const slotEntries = activeSlotEntries(branch.state, side);
    const sideActiveKeys = slotEntries.map(entry => entry.combatantKey);
    const faintedSlots = slotEntries.filter(entry => Number(branch.state.combatantStates[entry.combatantKey]?.hp?.max) <= 0);
    const livingActive = slotEntries.filter(entry => Number(branch.state.combatantStates[entry.combatantKey]?.hp?.max) > 0);
    const available = Object.values(plan.combatants).filter(combatant =>
      combatant.side === side
      && !sideActiveKeys.includes(combatant.combatantKey)
      && Number(branch.state.combatantStates[combatant.combatantKey]?.hp?.max) > 0
    );
    const sideEnded = livingActive.length + available.length === 0;
    branch.state.fieldState.sides[side].retaliateReady = faintedSlots.length > 0;
    if (sideEnded) ended = true;
    const ownedSlots = faintedSlots.filter(entry => partyOwnerForSlot(plan, side, entry.slot) !== null);
    const replaceableSlots = ownedSlots.length ? faintedSlots.filter(entry => eligibleReserves(plan, branch.state, side, entry.slot).length) : faintedSlots;
    const replacementCount = Math.min(available.length, replaceableSlots.length);
    const chooseReplacementSlot = battleFormat(plan) === "triples" && replacementCount > 0 && replacementCount < faintedSlots.length;
    const requiredSlots = chooseReplacementSlot ? replaceableSlots : replaceableSlots.slice(0, replacementCount);
    pending.push(...requiredSlots.map(entry => ({ side, slot: entry.slot })));
    const canLeaveSlotEmpty = slotsPerSide(plan) > 1 && !sideEnded;
    for (const entry of canLeaveSlotEmpty && !chooseReplacementSlot ? faintedSlots.filter(entry => !requiredSlots.includes(entry)) : []) {
      setActiveKey(branch.state, side, entry.slot, null);
      event(branch, {
        eventType: "slot-emptied",
        actorKey: null,
        targetKey: entry.combatantKey,
        moveId: null,
        changes: [{ path: `active.${side}CombatantKeys.${entry.slot}`, from: entry.combatantKey, to: null }],
        metadata: { side, slot: entry.slot, resultLabel: `${side} Slot ${entry.slot + 1} is empty` }
      });
    }
  }
  setPendingReplacementSlots(branch.state, ended ? [] : pending);
  branch.state.battleEnded = ended;
  if (!ended && !pending.length && battleFormat(plan) === "triples") {
    const livingBySide = Object.fromEntries(["player", "enemy"].map(side => [side, Object.values(plan.combatants).filter(combatant =>
      combatant.side === side && Number(branch.state.combatantStates[combatant.combatantKey]?.hp?.max) > 0
    )]));
    if (livingBySide.player.length === 1 && livingBySide.enemy.length === 1) {
      const playerKey = livingBySide.player[0].combatantKey;
      const enemyKey = livingBySide.enemy[0].combatantKey;
      if (!combatantsAreAdjacent(branch.state, "player", playerKey, "enemy", enemyKey, plan)) {
        for (const [side, combatantKey] of [["player", playerKey], ["enemy", enemyKey]]) {
          const fromSlot = actorSlot(branch.state, side, combatantKey);
          const centerSlot = tripleSlotForPosition(plan, side, TRIPLE_POSITIONS.center);
          if (fromSlot < 0 || fromSlot === centerSlot) continue;
          setActiveKey(branch.state, side, fromSlot, null);
          setActiveKey(branch.state, side, centerSlot, combatantKey);
          event(branch, {
            eventType: "automatic-center",
            actorKey: combatantKey,
            targetKey: null,
            moveId: null,
            changes: [
              { path: `active.${side}CombatantKeys.${fromSlot}`, from: combatantKey, to: null },
              { path: `active.${side}CombatantKeys.${centerSlot}`, from: null, to: combatantKey }
            ],
            metadata: { side, fromSlot, toSlot: centerSlot, resultLabel: "Moved to center" }
          });
        }
      }
    }
  }
  if (!ended && pending.length) {
    event(branch, {
      eventType: "replacement-required",
      actorKey: null,
      targetKey: null,
      moveId: null,
      metadata: { slots: clone(pending), sides: [...new Set(pending.map(entry => entry.side))], resultLabel: `Replace ${pending.map(entry => `${entry.side} ${entry.slot + 1}`).join(" and ")}` }
    });
  }
  if (ended) {
    event(branch, {
      eventType: "battle-ended",
      actorKey: null,
      targetKey: null,
      moveId: null,
      metadata: { resultLabel: "Battle ended" }
    });
  }
}

function battleRosterEnded(state, plan) {
  return ["player", "enemy"].some(side => !Object.values(plan.combatants).some(combatant =>
    combatant.side === side && Number(state.combatantStates[combatant.combatantKey]?.hp?.max) > 0
  ));
}

function outcomeLabel(branch) {
  const lastDamage = [...branch.events].reverse().find(entry => ["damage", "residual-damage"].includes(entry.eventType));
  if (lastDamage?.metadata?.thresholdOutcome === "ko") {
    const target = branch.planCombatants?.[lastDamage.targetKey];
    return `${target?.displayName || "Pokémon"} fainted`;
  }
  if (branch.events.some(entry => entry.eventType === "miss")) return "A selected move missed";
  if (branch.events.some(entry => entry.eventType === "switch")) return "Switch line resolved";
  if (branch.events.some(entry => entry.eventType === "shift")) return "Shift line resolved";
  const structuredEffect = [...branch.events].reverse().find(entry => ["stat-stage-change", "heal", "protect", "major-status", "status-failed", "field-change", "move-blocked", "residual-damage", "residual-heal"].includes(entry.eventType));
  if (structuredEffect?.metadata?.resultLabel) return structuredEffect.metadata.resultLabel;
  return participantEntries(branch.state).length > 2 ? "All active Pokémon survived" : "Both Pokémon survived";
}

function mergeEquivalent(branches) {
  const map = new Map();
  for (const branch of branches) {
    updateStateHash(branch.state);
    const criticalSignature = branch.events
      .filter(entry => entry.metadata?.criticalHit === true)
      .map(entry => `${entry.eventType}:${entry.actorKey || ""}:${entry.targetKey || ""}:${entry.moveId || ""}:${entry.metadata?.criticalHits || 1}`)
      .join("|");
    const key = `${branch.state.stateHash}::${criticalSignature}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, branch);
      continue;
    }
    if (existing.probability !== null && branch.probability !== null) existing.probability += branch.probability;
    else {
      existing.probability = null;
      existing.probabilityStatus = "unknown";
    }
    existing.conditions.push(...branch.conditions);
  }
  return [...map.values()];
}

function applyActionOrderDirective(branch, remaining) {
  const directive = branch.actionOrderDirective;
  if (!directive) return remaining;
  delete branch.actionOrderDirective;
  const index = remaining.findIndex(entry => entry.action?.actorKey === directive.targetKey);
  if (index < 0) return remaining;
  const reordered = [...remaining];
  const [target] = reordered.splice(index, 1);
  if (directive.kind === "move-next") reordered.unshift(target);
  else reordered.push(target);
  return reordered;
}

function resolveActionEntries(branch, entries, context) {
  if (!entries.length) return [branch];
  const hadDirective = Boolean(branch.actionOrderDirective);
  const ordered = applyActionOrderDirective(branch, entries);
  const firstTieGroup = !hadDirective ? ordered[0]?.tieGroup : null;
  const choices = firstTieGroup ? ordered.filter(entry => entry.tieGroup === firstTieGroup) : ordered.slice(0, 1);
  let resolved = [];
  for (const choice of choices) {
    const nextBranch = choices.length > 1 ? clone(branch) : branch;
    if (choices.length > 1) {
      nextBranch.probability = probabilityProduct(nextBranch.probability, 1 / choices.length);
      nextBranch.probabilityStatus = nextBranch.probability === null ? "unknown" : "known";
    }
    const choiceIndex = ordered.indexOf(choice);
    const remaining = ordered.filter((_, index) => index !== choiceIndex);
    const applied = applyAction(nextBranch, choice.side, choice.slot, choice.action, {
      ...context,
      isLastAction: remaining.length === 0,
      pendingActions: remaining
    });
    if (Number(context.dataset.mechanics?.damageGeneration) === 4) for (const next of applied) {
      const actor = next.state.combatantStates[choice.action.actorKey];
      // ClearFlags clears the acting battler's moveHit after its action, not at
      // the end of the turn. Later incoming attacks can populate it again.
      if (actor?.turnFlags?.hasMoved) {
        actor.lastHitMoveId = null;
        actor.lastHitSourceKey = null;
      }
    }
    const rewarded = mergeEquivalent(applied.map(next => applyDefeatedEnemyExperience(next, context.plan, context.dataset)));
    resolved.push(...rewarded.flatMap(next => battleRosterEnded(next.state, context.plan)
      ? [next]
      : resolveActionEntries(next, remaining, context)));
    resolved = mergeEquivalent(resolved);
    if (resolved.length > 4096) throw new ResolutionError("Outcome branching exceeds the safe exact limit");
  }
  return resolved;
}

export function resolveTurn({ plan, parentStateNodeId, actions, dataset, damageAdapter, moveSupport = defaultMoveSupport }) {
  const parentState = plan.stateNodes[parentStateNodeId];
  if (!parentState) throw new ResolutionError(`State ${parentStateNodeId} is unavailable`);
  validateTurnActions({ plan, parentState, actions, dataset, moveSupport });
  const declaredTargetSlots = Object.fromEntries(activeEntries(parentState).map(entry => [entry.combatantKey, { side: entry.side, slot: entry.slot }]));
  for (const entry of actionEntries(parentState, actions)) {
    if (entry.action.actionType === "switch") declaredTargetSlots[entry.action.switchToKey] = { side: entry.side, slot: entry.slot };
  }
  let resolved = [];
  const entryBranch = {
    state: clone(parentState),
    events: [],
    probability: 1,
    probabilityStatus: "known",
    conditions: [],
    planCombatants: plan.combatants,
    generation: Number(dataset.mechanics?.damageGeneration || 5)
  };
  refreshWeatherAbilityForms(entryBranch, plan, dataset);
  const entryBranches = resolvePendingTraceBranches(entryBranch, plan, dataset);
  for (const entered of entryBranches) {
    applyRotationSelections(entered, actions, plan, dataset);
    const orders = orderedActions(plan, entered.state, actions, dataset);
    for (const order of orders) {
      const preparedOrder = applyActionOrderState(entered.state, order.entries);
      const state = preparedOrder.state;
      state.parentActionGroupId = null;
      state.parentReplacementTransitionId = null;
      state.childActionGroupIds = [];
      state.childReplacementTransitionIds = [];
      state.resolutionEventIds = [];
      for (const monState of Object.values(state.combatantStates)) monState.turnFlags = resetTurnFlags();
      let branches = [{
        state,
        events: [
          ...entered.events,
          ...preparedOrder.initialEvents.map(details => ({ ...details, source: "planned", changes: details.changes || [], metadata: details.metadata || {} }))
        ],
        probability: probabilityProduct(entered.probability, order.probability),
        probabilityStatus: entered.probability === null || order.probability === null ? "unknown" : "known",
        conditions: [...entered.conditions, ...order.conditions],
        planCombatants: plan.combatants,
        generation: Number(dataset.mechanics?.damageGeneration || 5)
      }];
      branches = branches.flatMap(branch => resolveActionEntries(branch, order.entries, { plan, dataset, damageAdapter, moveSupport, declaredTargetSlots }));
      branches = branches.flatMap(branch => battleRosterEnded(branch.state, plan) ? [branch] : applyEndOfTurn(branch, dataset, plan, damageAdapter));
      branches = branches.map(branch => applyDefeatedEnemyExperience(branch, plan, dataset));
      for (const branch of branches) updateBattleBoundary(branch, plan);
      resolved.push(...branches);
    }
  }
  resolved = mergeEquivalent(resolved);
  const totalKnown = resolved.every(branch => branch.probability !== null);
  if (totalKnown) {
    const total = resolved.reduce((sum, branch) => sum + branch.probability, 0) || 1;
    for (const branch of resolved) branch.probability /= total;
  }
  return resolved.map((branch, index) => ({
    previewOutcomeId: `preview-${index + 1}-${shortHash(stableStringify({ state: branch.state.stateHash, conditions: branch.conditions }))}`,
    state: branch.state,
    events: branch.events,
    outcome: {
      kind: resolved.length > 1 ? "chance" : "decision",
      label: outcomeLabel(branch),
      probability: branch.probability,
      probabilityStatus: branch.probability === null ? "unknown" : resolved.length > 1 && resolved.every(other => other.probability === branch.probability) ? "tied" : "known",
      conditions: branch.conditions.map(condition => ({ kind: "resolver", expression: condition }))
    }
  }));
}

export function resolveForcedReplacement({ plan, parentStateNodeId, replacements, dataset }) {
  const parentState = plan.stateNodes[parentStateNodeId];
  if (!parentState) throw new ResolutionError(`State ${parentStateNodeId} is unavailable`);
  const required = pendingReplacementSlots(parentState);
  if (!required.length) throw new ResolutionError("No forced replacement is required");
  let branches = [{
    state: clone(parentState),
    events: [],
    probability: 1,
    probabilityStatus: "known",
    conditions: [],
    planCombatants: plan.combatants,
    generation: Number(dataset.mechanics?.damageGeneration || 5)
  }];
  const selectedBySlot = new Map();
  for (const side of ["player", "enemy"]) {
    const sideRequired = required.filter(entry => entry.side === side);
    if (!sideRequired.length) continue;
    const sideActions = replacementList(replacements, side);
    const active = activeKeys(parentState, side);
    const availableCount = Object.values(plan.combatants).filter(combatant => combatant.side === side
      && !active.includes(combatant.combatantKey)
      && Number(parentState.combatantStates[combatant.combatantKey]?.hp?.max) > 0).length;
    const replacementCount = Math.min(availableCount, sideRequired.length);
    if (sideActions.length !== replacementCount) throw new ResolutionError(`${side} needs ${replacementCount} forced replacement${replacementCount === 1 ? "" : "s"}`);
    for (const action of sideActions) {
      const slot = Number(action?.slot ?? 0);
      if (!sideRequired.some(entry => entry.slot === slot) || selectedBySlot.has(`${side}:${slot}`)) {
        throw new ResolutionError(`${side} slot ${slot + 1} is not an available replacement position`);
      }
      if (action.actionType !== "replacement" || action.side !== side || action.consumesTurn !== false) {
        throw new ResolutionError(`${side} slot ${slot + 1} needs a forced replacement`);
      }
      selectedBySlot.set(`${side}:${slot}`, action);
    }
  }
  const selectedTargets = [];
  for (const { side, slot } of required) {
    const action = selectedBySlot.get(`${side}:${slot}`);
    if (!action) continue;
    const currentActiveKey = activeKey(parentState, side, slot);
    const target = plan.combatants[action.switchToKey];
    const targetState = parentState.combatantStates[action.switchToKey];
    if (!belongsToSlotParty(plan, target, side, slot) || activeKeys(parentState, side).includes(target.combatantKey) || selectedTargets.includes(target.combatantKey) || Number(targetState?.hp?.max) <= 0) {
      throw new ResolutionError(`${side} slot ${slot + 1} replacement target is invalid`);
    }
    selectedTargets.push(target.combatantKey);
    branches = branches.flatMap(branch => applySwitch(branch, side, slot, {
      actionType: "switch",
      actorKey: currentActiveKey,
      switchToKey: action.switchToKey,
      switchKind: "forced"
    }, plan, dataset));
  }
  branches = branches.map(branch => applyDefeatedEnemyExperience(branch, plan, dataset));
  for (const branch of branches) updateBattleBoundary(branch, plan);
  return mergeEquivalent(branches).map((branch, index) => ({
    previewOutcomeId: `replacement-${index + 1}-${shortHash(stableStringify({ state: branch.state.stateHash, conditions: branch.conditions }))}`,
    state: branch.state,
    events: branch.events,
    outcome: {
      kind: branch.probability === 1 ? "decision" : "chance",
      label: pendingReplacementSlots(branch.state).length ? "Replacement faints on entry" : "Replacement enters battle",
      probability: branch.probability,
      probabilityStatus: branch.probability === null ? "unknown" : "known",
      conditions: branch.conditions.map(condition => ({ kind: "resolver", expression: condition }))
    }
  }));
}
