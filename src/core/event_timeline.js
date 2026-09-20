// Presentation-only trace. Never used for damage, probabilities, graph identity,
// or AI. Store deltas, not full battle/plan snapshots, at resolver event boundaries.
const MON_FIELDS = ['hp', 'majorStatus', 'statStages', 'currentTypeIds', 'currentAbilityId',
  'currentItemId', 'currentSpeciesId', 'currentSpriteId', 'currentStats', 'calculatedStatOverrides',
  'currentLevel', 'experience', 'movePp', 'moveSetOverride', 'volatileConditions'];
const copy = value => value === undefined ? null : structuredClone(value);
const safeKey = key => typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key);

export function displayCombatant(state, cloneValues = true) {
  return Object.fromEntries(MON_FIELDS.filter(key => state?.[key] !== undefined).map(key => [key, cloneValues ? copy(state[key]) : state[key]]));
}

export function startEventTrace(state) {
  return {
    active: JSON.stringify(state.active), rotation: JSON.stringify(state.rotation ?? null),
    fieldState: JSON.stringify(state.fieldState),
    mons: Object.fromEntries(Object.entries(state.combatantStates).map(([key, mon]) => [key, JSON.stringify(displayCombatant(mon, false))]))
  };
}

export function captureEventTrace(branch, event, { append = false } = {}) {
  const previous = branch.presentationTrace;
  if (!previous) return;
  const changes = [];
  const record = (path, value, container, key) => {
    const text = JSON.stringify(value);
    if (text !== container[key]) {
      changes.push({ path, before: container[key] === undefined ? null : JSON.parse(container[key]), after: copy(value) });
      container[key] = text;
    }
  };
  for (const field of ['active', 'rotation', 'fieldState']) record([field], branch.state[field] ?? null, previous, field);
  // Include every combatant: spread, aura, and field effects may change someone
  // other than the named actor/target. Unchanged records create no delta.
  for (const [key, mon] of Object.entries(branch.state.combatantStates)) {
    const view = displayCombatant(mon, false);
    // Damage buckets update HP before announcing resist berries/Sash/Sturdy.
    // Their item/ability row must not reveal the following damage row early.
    if (previous.mons[key] && (event.eventType === 'item-consumed' || event.eventType === 'ability-activated' && event.metadata?.cause === 'sturdy')) {
      view.hp = JSON.parse(previous.mons[key]).hp;
    }
    record(['combatantStates', key], view, previous.mons, key);
  }
  event.metadata = { ...event.metadata, presentation: { version: 1, changes: [...(append ? event.metadata?.presentation?.changes || [] : []), ...changes] } };
}

function applyPresentation(state, changes, reverse = false) {
  if (!Array.isArray(changes)) return;
  for (const change of reverse ? [...changes].reverse() : changes) {
    const path = change?.path;
    if (!Array.isArray(path) || !path.every(safeKey)) continue;
    const value = copy(change[reverse ? 'before' : 'after']);
    if (path.length === 1 && ['active', 'rotation', 'fieldState'].includes(path[0])) state[path[0]] = value;
    else if (path.length === 2 && path[0] === 'combatantStates' && Object.hasOwn(state.combatantStates, path[1]) && value) {
      state.combatantStates[path[1]] = displayCombatant(value);
    }
  }
}

function applyLegacyChanges(state, event, reverse = false) {
  for (const change of reverse ? [...(event.changes || [])].reverse() : event.changes || []) {
    const path = String(change.path || '').split('.');
    if (!path.every(safeKey) || !['active', 'rotation', 'fieldState', 'combatantStates'].includes(path[0])) continue;
    const field = reverse ? 'from' : 'to';
    if (!Object.hasOwn(change, field)) continue;
    let target = state;
    for (const key of path.slice(0, -1)) {
      if (!target || !Object.hasOwn(target, key)) { target = null; break; }
      target = target[key];
    }
    if (target && typeof target === 'object') target[path.at(-1)] = copy(change[field]);
  }
}

const leading = event => ['initial-entry', 'start-of-turn-replacement'].includes(event.metadata?.phase);

export function createEventTimeline(baseState, events) {
  const start = {
    stateNodeId: baseState.stateNodeId, turnNumber: baseState.turnNumber,
    active: copy(baseState.active), rotation: copy(baseState.rotation), fieldState: copy(baseState.fieldState),
    combatantStates: Object.fromEntries(Object.entries(baseState.combatantStates).map(([key, state]) => [key, displayCombatant(state)]))
  };
  // The selected state already includes entry/replacement effects. Rewind those
  // prefixed events once, so they are not applied twice or shown ahead of time.
  for (const event of [...events].reverse().filter(leading)) {
    if (event.metadata?.presentation?.version === 1) applyPresentation(start, event.metadata.presentation.changes, true);
    else applyLegacyChanges(start, event, true);
  }
  const frames = [];
  let state = start;
  const incompleteLegacyEntry = events.some(event => leading(event) && !event.metadata?.presentation
    && ['switch', 'ability-change'].includes(event.eventType) && !(event.changes || []).length);
  const lastLeadingIndex = events.findLastIndex(leading);
  let available = !incompleteLegacyEntry;
  for (const [index, event] of events.entries()) {
    if (index === lastLeadingIndex + 1 && incompleteLegacyEntry) { state = { ...start, active: copy(baseState.active), rotation: copy(baseState.rotation), fieldState: copy(baseState.fieldState), combatantStates: Object.fromEntries(Object.entries(baseState.combatantStates).map(([key, mon]) => [key, displayCombatant(mon)])) }; available = true; }
    const traced = event.metadata?.presentation?.version === 1 && Array.isArray(event.metadata.presentation.changes);
    if (!traced && !leading(event) && ['damage', 'heal', 'residual-damage', 'residual-heal', 'switch', 'confusion-self-hit'].includes(event.eventType)) available = false;
    const next = traced ? { ...state, combatantStates: { ...state.combatantStates } } : structuredClone(state);
    if (traced) applyPresentation(next, event.metadata.presentation.changes);
    else applyLegacyChanges(next, event);
    const keys = new Set([event.targetKey].filter(Boolean));
    for (const change of traced ? event.metadata.presentation.changes : []) {
      if (change?.path?.[0] === 'combatantStates' && MON_FIELDS.some(field => field !== 'movePp' && JSON.stringify(change.before?.[field]) !== JSON.stringify(change.after?.[field]))) keys.add(change.path[1]);
      if (change?.path?.[0] === 'fieldState' && ['field-change', 'field-expired', 'hazard-cleared'].includes(event.eventType)) {
        for (const side of ['player', 'enemy']) {
          if (JSON.stringify(change.before?.global) !== JSON.stringify(change.after?.global) || JSON.stringify(change.before?.sides?.[side]) !== JSON.stringify(change.after?.sides?.[side])) {
            const active = next.active[`${side}CombatantKeys`] || [];
            const affected = next.rotation ? [active[next.rotation.frontSlots[side]]] : active;
            for (const key of affected.filter(Boolean)) keys.add(key);
          }
        }
      }
    }
    for (const change of event.changes || []) if (change.path?.startsWith('combatantStates.')) keys.add(change.path.split('.')[1]);
    frames.push({ index, state: next, event, available, actorKeys: event.actorKey ? [event.actorKey] : [], affectedKeys: [...keys] });
    state = next;
  }
  return frames;
}
