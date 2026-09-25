import { clone, normalizeRange, toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";

const POWER_ITEMS = new Set(["poweranklet", "powerband", "powerbelt", "powerbracer", "powerlens", "powerweight"]);
const SLOW_ITEMS = new Set(["ironball", "machobrace", ...POWER_ITEMS]);
const LATE_ITEMS = new Set(["fullincense", "laggingtail"]);

function activeAbilityId(state) {
  return state?.abilitySuppressed ? "" : toId(state?.currentAbilityId);
}

function heldItemId(state, fieldState, { includeKlutzIgnored = false } = {}) {
  if (state?.itemState !== "held") return "";
  if (Number(state.volatileConditions?.embargoTurns || 0) > 0) return "";
  if (Number(fieldState?.global?.magicRoomTurns || 0) > 0) return "";
  const item = toId(state.currentItemId);
  if (!includeKlutzIgnored && activeAbilityId(state) === "klutz") return "";
  return item;
}

function weatherId(fieldState, weatherSuppressed) {
  return weatherSuppressed ? "" : toId(fieldState?.global?.weather?.id || fieldState?.global?.weather);
}

function stageMultiplier(stage) {
  const value = Math.max(-6, Math.min(6, Number(stage || 0)));
  return value >= 0 ? (2 + value) / 2 : 2 / (2 - value);
}

export function effectiveActionSpeed({
  combatant,
  combatantState,
  battleState = null,
  side = null,
  generation = 5,
  weatherSuppressed = false
}) {
  const fieldState = battleState?.fieldState || {};
  const ability = activeAbilityId(combatantState);
  const status = toId(combatantState?.majorStatus);
  if (Number(generation) === 4) {
    // Platinum truncates at each operation, and speed-halving items bypass
    // Klutz/Embargo. Keep this order for action and spread-target comparisons.
    const stage = Number(combatantState?.statStages?.spe || 0) * (ability === "simple" ? 2 : 1);
    let speed = Math.floor(Number(combatantState?.calculatedStatOverrides?.spe ?? combatantState?.currentStats?.spe ?? combatant?.calculatedStats?.spe ?? 0) * stageMultiplier(stage));
    const weather = weatherId(fieldState, weatherSuppressed);
    if (ability === "chlorophyll" && weather === "sun" || ability === "swiftswim" && weather === "rain") speed *= 2;
    const rawItem = combatantState?.itemState === "held" ? toId(combatantState.currentItemId) : "";
    const item = heldItemId(combatantState, fieldState);
    if (SLOW_ITEMS.has(rawItem)) speed = Math.floor(speed / 2);
    if (item === "choicescarf") speed = Math.floor(speed * 1.5);
    if (item === "quickpowder" && !combatantState?.transformedIntoKey && toId(combatantState?.currentSpeciesId || combatant?.speciesId) === "ditto") speed *= 2;
    if (ability === "quickfeet" && status && status !== "none") speed = Math.floor(speed * 1.5);
    else if (["par", "paralysis"].includes(status)) speed = Math.floor(speed / 4);
    if (ability === "slowstart" && Number(battleState?.turnNumber || 0) - Number(combatantState?.enteredTurnNumber || 0) < 5) speed = Math.floor(speed / 2);
    if (ability === "unburden" && !rawItem && (combatantState?.volatileConditions?.unburden || combatantState?.lastItemId)) speed *= 2;
    if (side && Number(fieldState?.sides?.[side]?.tailwindTurns || 0) > 0) speed *= 2;
    return Math.max(0, speed);
  }
  let speed = Number(combatantState?.currentStats?.spe ?? combatant?.calculatedStats?.spe ?? 0)
    * stageMultiplier(combatantState?.statStages?.spe);

  if (status === "par" || status === "paralysis") {
    if (ability !== "quickfeet") speed *= Number(generation) >= 7 ? 0.5 : 0.25;
  }

  const weather = weatherId(fieldState, weatherSuppressed);
  if (ability === "chlorophyll" && weather === "sun") speed *= 2;
  if (ability === "swiftswim" && weather === "rain") speed *= 2;
  if (ability === "sandrush" && weather === "sand") speed *= 2;
  if (ability === "quickfeet" && status) speed *= 1.5;
  if (ability === "unburden" && combatantState?.itemState !== "held" && combatantState?.lastItemId) speed *= 2;
  if (ability === "slowstart" && Number(battleState?.turnNumber || 0) - Number(combatantState?.enteredTurnNumber || 0) < 5) speed *= 0.5;

  const ordinaryItem = heldItemId(combatantState, fieldState);
  const klutzIgnoredItem = heldItemId(combatantState, fieldState, { includeKlutzIgnored: true });
  if (ordinaryItem === "choicescarf") speed *= 1.5;
  if (ordinaryItem === 'quickpowder' && !combatantState?.transformedIntoKey && toId(combatantState?.currentSpeciesId || combatant?.speciesId) === 'ditto') speed *= 2;
  if (ordinaryItem === "ironball" || SLOW_ITEMS.has(klutzIgnoredItem) && klutzIgnoredItem !== "ironball") speed *= 0.5;

  if (side && Number(fieldState?.sides?.[side]?.tailwindTurns || 0) > 0) speed *= 2;
  if (side && Number(fieldState?.sides?.[side]?.swampTurns || 0) > 0) speed *= 0.25;
  return Math.max(0, Math.floor(speed));
}

export function effectiveMovePriority({ action, move, combatantState, generation = 5 }) {
  if (action?.actionType === "switch") return 6;
  let priority = Number(move?.priority || 0);
  const ability = activeAbilityId(combatantState);
  if (ability === "prankster" && String(move?.category || "").toLowerCase() === "status") priority += 1;
  if (ability === "galewings" && Number(generation) >= 6 && toId(move?.type) === "flying") {
    const hp = normalizeRange(combatantState?.hp || { min: 0, max: 0, maxHp: 0 });
    if (Number(generation) === 6 || hp.min === hp.maxHp && hp.max === hp.maxHp) priority += 1;
  }
  return priority;
}

// BattleSystem_SortMonSpeedOrder / CompareBattlerSpeed(..., TRUE). This is
// rebuilt before each action, ignores move priority, and uses a fresh coin for
// each tied pair in the retail nested-loop sort (not a uniform permutation).
export function gen4BattlerSpeedOrders({ plan, state, entries, weatherSuppressed = false, orderItems = {} }) {
  const trickRoom = Number(state.fieldState?.global?.trickRoomTurns || 0) > 0;
  let variants = [{ entries: [], probability: 1, orderItems: clone(orderItems) }];
  for (const entry of [...entries].sort((a, b) => a.slot - b.slot || (a.side === "player" ? -1 : 1))) {
    const mon = state.combatantStates[entry.combatantKey];
    const position = `${entry.side}:${entry.slot}`;
    const ability = activeAbilityId(mon);
    const item = heldItemId(mon, state.fieldState);
    const custapThreshold = Math.floor(Number(mon.hp.maxHp) / (ability === "gluttony" ? 2 : 4));
    if (item === "custapberry" && Number(mon.hp.min) <= custapThreshold && Number(mon.hp.max) > custapThreshold) {
      throw new Error("Gen 4 spread target order requires resolved HP across the Custap threshold");
    }
    const speed = effectiveActionSpeed({ combatant: plan.combatants[entry.combatantKey], combatantState: mon, battleState: state, side: entry.side, generation: 4, weatherSuppressed });
    variants = variants.flatMap(variant => {
      const remembered = variant.orderItems[position] || {};
      const alternatives = item === "quickclaw"
        ? (remembered.quickclaw === undefined ? [{ active: true, probability: 0.2 }, { active: false, probability: 0.8 }] : [{ active: remembered.quickclaw, probability: 1 }])
        : [{ active: item === "custapberry" && Number(mon.hp.max) <= custapThreshold
          || remembered.custapberry && remembered.combatantKey === entry.combatantKey && !mon.turnFlags?.hasMoved, probability: 1 }];
      return alternatives.map(alternative => ({
        entries: [...variant.entries, { ...entry, speed, alive: Number(mon.hp.max) > 0, early: Boolean(alternative.active), late: LATE_ITEMS.has(item), stall: ability === "stall" }],
        probability: variant.probability * alternative.probability,
        orderItems: { ...variant.orderItems, [position]: { ...remembered, ...(item === "quickclaw" ? { quickclaw: alternative.active } : {}) } }
      }));
    });
  }
  for (let i = 0; i < entries.length - 1; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      variants = variants.flatMap(variant => {
        const a = variant.entries[i], b = variant.entries[j];
        let comparison;
        if (a.alive !== b.alive) comparison = a.alive ? -1 : 1;
        else if (a.early !== b.early) comparison = a.early ? -1 : 1;
        else if (a.early) comparison = b.speed - a.speed;
        else if (a.late !== b.late) comparison = a.late ? 1 : -1;
        else if (a.late) comparison = a.speed - b.speed;
        else if (a.stall !== b.stall) comparison = a.stall ? 1 : -1;
        else comparison = a.stall || trickRoom ? a.speed - b.speed : b.speed - a.speed;
        const swapped = { ...variant, entries: [...variant.entries] };
        [swapped.entries[i], swapped.entries[j]] = [swapped.entries[j], swapped.entries[i]];
        return comparison > 0 ? [swapped] : comparison < 0 ? [variant]
          : [{ ...variant, probability: variant.probability / 2 }, { ...swapped, probability: variant.probability / 2 }];
      });
    }
  }
  const merged = new Map();
  for (const variant of variants) {
    const key = JSON.stringify([variant.entries.map(entry => entry.combatantKey), variant.orderItems]);
    if (merged.has(key)) merged.get(key).probability += variant.probability;
    else merged.set(key, variant);
  }
  return [...merged.values()];
}

function normalizedHpDistribution(state) {
  const supplied = Array.isArray(state?.hpDistribution) ? state.hpDistribution : [];
  const usable = supplied.map(entry => ({ value: Number(entry.value), probability: Number(entry.probability) }))
    .filter(entry => Number.isFinite(entry.value) && Number.isFinite(entry.probability) && entry.probability > 0);
  if (usable.length) {
    const total = usable.reduce((sum, entry) => sum + entry.probability, 0);
    return usable.map(entry => ({ ...entry, probability: entry.probability / total }));
  }
  const hp = normalizeRange(state?.hp || { min: 0, max: 0, maxHp: 0 });
  return hp.min === hp.max ? [{ value: hp.min, probability: 1 }] : null;
}

function hpThresholdAlternatives(state, threshold) {
  const distribution = normalizedHpDistribution(state);
  if (distribution) {
    const groups = [
      { active: true, values: distribution.filter(entry => entry.value <= threshold) },
      { active: false, values: distribution.filter(entry => entry.value > threshold) }
    ].filter(group => group.values.length);
    return groups.map(group => ({
      active: group.active,
      probability: group.values.reduce((sum, entry) => sum + entry.probability, 0),
      hpDistribution: group.values
    }));
  }
  const hp = normalizeRange(state?.hp || { min: 0, max: 0, maxHp: 0 });
  if (hp.max <= threshold) return [{ active: true, probability: 1, hpRange: hp }];
  if (hp.min > threshold) return [{ active: false, probability: 1, hpRange: hp }];
  return [
    { active: true, probability: null, hpRange: { min: hp.min, max: threshold, maxHp: hp.maxHp } },
    { active: false, probability: null, hpRange: { min: threshold + 1, max: hp.max, maxHp: hp.maxHp } }
  ];
}

function orderEvent(modifierId, activated, extra = {}) {
  const sourceId = modifierId === "quickclaw" ? "quickclaw" : "custapberry";
  const sourceName = modifierId === "quickclaw" ? "Quick Claw" : "Custap Berry";
  return {
    modifierId,
    activated,
    sourceType: "item",
    sourceId,
    sourceName,
    resultLabel: activated ? `${sourceName} activated` : `${sourceName} did not activate`,
    hiddenFromOutcomes: !activated,
    ...extra
  };
}

export function actionOrderAlternatives({ action, move, combatantState, battleState, generation = 5 }) {
  if (action?.actionType !== "move") return [{ probability: 1, fractionalPriority: 0, orderEvent: null }];
  const ability = activeAbilityId(combatantState);
  const item = heldItemId(combatantState, battleState?.fieldState || {});
  const baseFractionalPriority = ability === "stall" || LATE_ITEMS.has(item) ? -0.1 : 0;
  if (item === "quickclaw") {
    return [
      { probability: 0.2, fractionalPriority: 0.1, orderEvent: orderEvent("quickclaw", true) },
      { probability: 0.8, fractionalPriority: baseFractionalPriority, orderEvent: orderEvent("quickclaw", false) }
    ];
  }
  if (item === "custapberry") {
    const ownSide = battleState?.active?.playerCombatantKeys?.includes(action.actorKey) ? 'player' : 'enemy';
    const opponentKeys = battleState?.active?.[`${ownSide === 'player' ? 'enemy' : 'player'}CombatantKeys`] || [];
    if (generation >= 5 && opponentKeys.some(key => battleState.combatantStates[key]?.hp?.max > 0 && activeAbilityId(battleState.combatantStates[key]) === 'unnerve')) {
      return [{ probability:1, fractionalPriority:baseFractionalPriority, orderEvent:null }];
    }
    const hp = normalizeRange(combatantState?.hp || { min: 0, max: 0, maxHp: 0 });
    const gluttony = ability === "gluttony";
    const threshold = Math.floor(Number(hp.maxHp) / (gluttony ? 2 : 4));
    return hpThresholdAlternatives(combatantState, threshold).map(alternative => ({
      probability: alternative.probability,
      fractionalPriority: alternative.active ? 0.1 : baseFractionalPriority,
      hpDistribution: alternative.hpDistribution,
      hpRange: alternative.hpRange,
      consumeItem: alternative.active,
      orderEvent: orderEvent("custapberry", alternative.active, { threshold })
    }));
  }
  return [{ probability: 1, fractionalPriority: baseFractionalPriority, orderEvent: null }];
}

export function applyActionOrderState(state, entries) {
  const next = clone(state);
  const initialEvents = [];
  for (const entry of entries) {
    const alternative = entry.orderAlternative;
    if (!alternative) continue;
    const actorKey = entry.action.actorKey;
    const actorState = next.combatantStates[actorKey];
    if (alternative.hpDistribution) {
      const values = alternative.hpDistribution.map(item => Number(item.value));
      const total = alternative.hpDistribution.reduce((sum, item) => sum + Number(item.probability), 0) || 1;
      actorState.hpDistribution = alternative.hpDistribution.map(item => ({ value: Number(item.value), probability: Number(item.probability) / total }));
      actorState.hp = { min: Math.min(...values), max: Math.max(...values), maxHp: Number(actorState.hp.maxHp) };
    } else if (alternative.hpRange) {
      actorState.hp = clone(alternative.hpRange);
      delete actorState.hpDistribution;
    }
    if (alternative.consumeItem) {
      const previous = actorState.currentItemId;
      actorState.lastItemId = previous;
      actorState.currentItemId = "";
      actorState.itemState = "consumed";
      alternative.orderEvent.changes = [
        { path: `combatantStates.${actorKey}.currentItemId`, from: previous, to: "" },
        { path: `combatantStates.${actorKey}.itemState`, from: "held", to: "consumed" }
      ];
    }
    if (alternative.orderEvent) initialEvents.push({
      eventType: "order-modifier",
      actorKey,
      targetKey: null,
      moveId: entry.action.moveId || null,
      changes: clone(alternative.orderEvent.changes || []),
      metadata: clone(alternative.orderEvent)
    });
  }
  return { state: next, initialEvents };
}
