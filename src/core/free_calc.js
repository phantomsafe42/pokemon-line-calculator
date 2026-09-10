import { clone, exactRange, makeStableId, nowIso, STAGE_KEYS } from './primitives.js?v=20260905-drafts-freecalc-partners-v1';
import { activeKey, activeKeys, setActiveKey } from './battle_slots.js?v=20260905-drafts-freecalc-partners-v1';
import { createCombatantState, nextCreatedOrder, touchPlan, updateStateHash } from './plan.js?v=20260905-drafts-freecalc-partners-v1';
import { calculateStats } from '../adapters/combatant_ingest.js?v=20260909-level-drift-v1';
import { experienceForLevel, levelFromExperience } from '../rulesets/vw2r_experience.js?v=20260905-drafts-freecalc-partners-v1';
import { assertValidPlanDocument } from '../contracts/plan_contract.js?v=20260905-drafts-freecalc-partners-v1';

export function addFreeCalcBranch(original, stateId) {
  const plan = clone(original);
  const parent = plan.stateNodes[stateId];
  if (!parent) throw new Error('Select an existing state for Free Calc');
  const order = nextCreatedOrder(plan);
  const transitionId = `free-calc-${order}`;
  const nextId = `state-free-calc-${order}`;
  const state = clone(parent);
  Object.assign(state, { stateNodeId: nextId, parentActionGroupId: null, parentReplacementTransitionId: null,
    parentManualTransitionId: transitionId, childActionGroupIds: [], childReplacementTransitionIds: [], childManualTransitionIds: [],
    createdOrder: order, freeCalc: true, resolutionEventIds: [], notes: '', draftNote: '', status: 'resolved',
    outcome: { kind: 'decision', label: 'Free Calc', probability: null, probabilityStatus: 'unknown', conditions: [] } });
  delete state.trainerAiForecast;
  plan.schemaVersion = 5;
  plan.manualTransitions ||= {};
  plan.manualTransitions[transitionId] = { manualTransitionId: transitionId, kind: 'free-calc',
    parentStateNodeId: stateId, turnNumber: parent.turnNumber, createdOrder: order,
    outcomeStateNodeIds: [nextId], defaultOutcomeStateNodeId: nextId };
  parent.childManualTransitionIds = [...(parent.childManualTransitionIds || []), transitionId];
  plan.stateNodes[nextId] = state;
  refreshFreeCalcBoundary(plan, state);
  touchPlan(plan); updateStateHash(state);
  return { plan: assertValidPlanDocument(plan), stateId: nextId };
}

function integer(value, minimum, maximum, label) {
  if (value === null || value === undefined || String(value).trim() === '') throw new Error(`${label} requires a number`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return number;
}

export function editFreeCalcCombatant(plan, stateId, key, changes, dataset) {
  const state = plan.stateNodes[stateId];
  if (!state?.freeCalc) throw new Error('Manual editing is available only in Free Calc');
  const mon = plan.combatants[key];
  const next = clone(state.combatantStates[key]);
  if (!mon || !next) throw new Error('Pokémon is unavailable');
  let level = Number(next.currentLevel ?? mon.level);
  if (Object.hasOwn(changes, 'level')) {
    level = integer(changes.level, 1, 100, 'Level');
    if (mon.growthRate) next.experience = experienceForLevel(level, mon.growthRate);
  }
  if (Object.hasOwn(changes, 'experience')) {
    next.experience = integer(changes.experience, 0, 10000000, 'Total EXP');
    if (mon.growthRate) level = levelFromExperience(next.experience, mon.growthRate);
  }
  if (level !== Number(next.currentLevel ?? mon.level)) {
    const stats = calculateStats({ ...mon, speciesId: next.currentSpeciesId || mon.speciesId, level }, dataset);
    next.currentLevel = level; next.currentStats = stats;
    const hp = Math.min(stats.hp, Number(next.hp.max));
    next.hp = exactRange(hp, stats.hp); next.hpDistribution = [{ value: hp, probability: 1 }];
  }
  if (Object.hasOwn(changes, 'hp')) {
    const hp = integer(changes.hp, 0, next.hp.maxHp, 'HP');
    next.hp = exactRange(hp, next.hp.maxHp); next.hpDistribution = [{ value: hp, probability: 1 }];
  }
  if (Object.hasOwn(changes, 'status')) {
    if (![null, '', 'brn', 'par', 'psn', 'tox', 'slp', 'frz'].includes(changes.status)) throw new Error('Invalid major status');
    next.majorStatus = changes.status || null; next.toxicCounter = changes.status === 'tox' ? 1 : 0;
    delete next.sleepTurnsRemaining; delete next.sleepDurationDistribution;
    for (const field of ['sleepCounterDistribution', 'sleepTurns', 'sleepTurnsRemaining']) delete next.volatileConditions[field];
  }
  for (const [field, kind, target] of [['abilityId', 'abilities', 'currentAbilityId'], ['itemId', 'items', 'currentItemId']]) {
    if (!Object.hasOwn(changes, field)) continue;
    const id = changes[field] || null;
    if ((id && !dataset.get(kind, id)) || (!id && field === 'abilityId')) throw new Error(`Invalid ${field}`);
    next[target] = id;
    if (field === 'itemId') next.itemState = id ? 'held' : 'none';
    else next.abilitySuppressed = false;
  }
  if (changes.statStages) for (const [stat, value] of Object.entries(changes.statStages)) {
    if (!STAGE_KEYS.includes(stat)) throw new Error('Invalid stat stage');
    next.statStages[stat] = integer(value, -6, 6, stat);
  }
  if (changes.moves) {
    if (!Array.isArray(changes.moves) || changes.moves.length > 4 || new Set(changes.moves).size !== changes.moves.length) throw new Error('Choose up to four distinct moves');
    next.moveSetOverride = changes.moves.map(id => {
      const move = dataset.get('moves', id); if (!move) throw new Error(`Unknown move ${id}`);
      return { moveId: id, maxPp: Number(move.pp) };
    });
    next.movePp = Object.fromEntries(next.moveSetOverride.map(move => [move.moveId, move.maxPp]));
  }
  state.combatantStates[key] = next;
  refreshFreeCalcBoundary(plan, state);
  touchPlan(plan); updateStateHash(state);
}

export function replaceFreeCalcSlot(plan, stateId, side, slot, combatant) {
  const state = plan.stateNodes[stateId];
  if (!state?.freeCalc || combatant.side !== side) throw new Error('Invalid Free Calc Pokémon');
  const key = combatant.combatantKey;
  if (activeKeys(state, side).includes(key) && activeKey(state, side, slot) !== key) throw new Error('That Pokémon is already in another slot');
  const outgoing = activeKey(state, side, slot);
  const restoring = state.freeCalcRemovedKeys?.includes(key);
  const newcomer = !state.combatantStates[key];
  if (!plan.combatants[key]) {
    if (side !== 'player') throw new Error('Enemy choices must belong to its party');
    plan.combatants[key] = clone(combatant);
  }
  if (newcomer) state.combatantStates[key] = createCombatantState(plan.combatants[key]);
  if (restoring) {
    state.combatantStates[key] = clone(state.freeCalcRetiredStates?.[key] || createCombatantState(plan.combatants[key]));
    state.freeCalcRemovedKeys = state.freeCalcRemovedKeys.filter(id => id !== key);
    if (state.freeCalcRetiredStates) delete state.freeCalcRetiredStates[key];
  }
  if (newcomer || restoring) {
    // A Box newcomer replaces this roster member, without a switch, faint or entry event.
    if (outgoing) {
      state.freeCalcRetiredStates ||= {};
      state.freeCalcRetiredStates[outgoing] = clone(state.combatantStates[outgoing]);
      state.freeCalcRemovedKeys = [...new Set([...(state.freeCalcRemovedKeys || []), outgoing])];
      const retired = state.combatantStates[outgoing]; retired.hp = exactRange(0, retired.hp.maxHp); retired.hpDistribution = [{ value: 0, probability: 1 }];
    }
  }
  setActiveKey(state, side, slot, key);
  refreshFreeCalcBoundary(plan, state);
  touchPlan(plan); updateStateHash(state);
}

export function refreshFreeCalcBoundary(plan, state) {
  state.battleEnded = ['player', 'enemy'].some(side => !Object.values(plan.combatants).some(mon => mon.side === side && Number(state.combatantStates[mon.combatantKey]?.hp?.max) > 0));
  state.pendingReplacementSlots = []; state.pendingReplacementSides = [];
}

export function freeCalcAsNewPlan(plan, stateId, name) {
  const next = clone(plan); const root = clone(next.stateNodes[stateId]);
  if (!root?.freeCalc) throw new Error('Select a Free Calc state');
  const now = nowIso();
  next.planId = makeStableId('plan-free', { now, random: globalThis.crypto.randomUUID() });
  next.name = String(name).trim(); next.createdAt = now; next.updatedAt = now; next.documentRevision = 0;
  Object.assign(root, { stateNodeId: 'state-root', turnNumber: 0, createdOrder: 0, parentActionGroupId: null,
    parentReplacementTransitionId: null, parentManualTransitionId: null, childActionGroupIds: [], childReplacementTransitionIds: [], childManualTransitionIds: [], resolutionEventIds: [] });
  next.initialStateNodeId = root.stateNodeId; next.stateNodes = { [root.stateNodeId]: root };
  next.actionGroups = {}; next.replacementTransitions = {}; next.manualTransitions = {}; next.resolutionEvents = {}; next.workingDraft = null;
  delete next.exportSelection;
  updateStateHash(root);
  return assertValidPlanDocument(next);
}
