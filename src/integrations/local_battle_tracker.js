const ENDPOINT_ROOT = "/__stream-tools/vw2r-battle-log";
const POLL_INTERVAL_MS = 500;

async function readJson(path, fetchImpl = fetch) {
  const response = await fetchImpl(`${ENDPOINT_ROOT}${path}`, { cache: "no-store" });
  if (!response.ok) {
    let message = `Battle tracker returned HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch { /* keep HTTP fallback */ }
    throw new Error(message);
  }
  return response.json();
}

export async function detectLocalBattleTrackerCapability(fetchImpl = fetch) {
  try {
    const capability = await readJson("/capability", fetchImpl);
    return capability?.available && capability?.gameId === "volt-white-2r" && capability?.readOnly === true
      ? capability
      : null;
  } catch {
    return null;
  }
}

function isBattleStart(event) {
  return event?.kind === "battle" && /battle started/i.test(event.text || "");
}

function isBattleEnd(event) {
  return event?.kind === "battle" && /battle ended/i.test(event.text || "");
}

function groupTurns(events, state) {
  const byTurn = new Map();
  for (const event of events) {
    const turn = Number(event?.turn);
    if (!Number.isInteger(turn) || turn < 1) continue;
    if (!byTurn.has(turn)) byTurn.set(turn, []);
    byTurn.get(turn).push(event);
  }
  const ended = events.some(isBattleEnd);
  const currentTurn = Number(state?.turn || 0);
  return [...byTurn.entries()].sort(([left], [right]) => left - right).map(([turnNumber, turnEvents]) => ({
    turnNumber,
    events: turnEvents,
    complete: ended || currentTurn > turnNumber || byTurn.has(turnNumber + 1),
  }));
}

export function trackerSessionSnapshot({ active, state, events, startedAt = null }) {
  const battleStart = events.find(isBattleStart) || null;
  const battleEnd = [...events].reverse().find(isBattleEnd) || null;
  const firstTurnEvent = events.find(event => Number(event?.turn) >= 1);
  return {
    active: Boolean(active),
    state: state || null,
    battleId: battleStart ? `battle-log-${battleStart.id}` : null,
    startedAt: battleStart?.timeUtc || startedAt,
    endedAt: battleEnd?.timeUtc || null,
    waitingForBattle: !battleStart,
    openingEvents: events.filter(event => !Number.isInteger(Number(event?.turn)) || Number(event.turn) < 1)
      .filter(event => event !== battleStart && event !== battleEnd),
    turns: groupTurns(events, state),
    lastEventId: Math.max(0, ...events.map(event => Number(event?.id) || 0), Number(state?.lastEventId) || 0),
    firstTurnEventId: firstTurnEvent?.id || null,
  };
}

function canonicalMoveIdentity(dataset, event) {
  const numeric = Number(event?.details?.moveId);
  const actorCode = Number(event?.details?.actorCode);
  if (!Number.isInteger(numeric) || !Number.isInteger(actorCode)) return null;
  const side = actorCode <= 3 ? "player" : "enemy";
  for (const move of dataset?.indexes?.moves?.values?.() || []) {
    if (Number(move?.num) === numeric) return `${side}:${move.id}`;
  }
  return null;
}

function orderedGroupMoveIds(group) {
  return ["player", "enemy"].flatMap(side => {
    const actions = Array.isArray(group?.actions?.[side]) ? group.actions[side] : group?.actions?.[side] ? [group.actions[side]] : [];
    return actions.filter(action => action?.actionType === "move").map(action => `${side}:${String(action.moveId)}`);
  }).sort();
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function compareTrackerTurns(plan, trackerSnapshot, dataset) {
  if (!plan || !trackerSnapshot) return [];
  const results = [];
  for (const turn of trackerSnapshot.turns || []) {
    const decodedMoveIds = turn.events.map(event => canonicalMoveIdentity(dataset, event)).filter(Boolean).sort();
    if (!turn.complete) {
      results.push({ ...turn, status: "in-progress", matchedStateNodeId: null, explanation: "This live turn is still collecting battle events." });
      continue;
    }
    if (!decodedMoveIds.length) {
      results.push({ ...turn, status: "insufficient", matchedStateNodeId: null, explanation: "The tracker did not decode enough move identity to bind this turn to one planned state." });
      continue;
    }
    const candidates = Object.values(plan.stateNodes || {}).filter(state => {
      if (Number(state?.turnNumber) !== Number(turn.turnNumber) || !state?.parentActionGroupId) return false;
      const group = plan.actionGroups?.[state.parentActionGroupId];
      return sameValues(orderedGroupMoveIds(group), decodedMoveIds);
    });
    if (candidates.length === 1) {
      results.push({ ...turn, status: "matched", matchedStateNodeId: candidates[0].stateNodeId, explanation: "Decoded move identities uniquely match this planned outcome state." });
    } else if (candidates.length > 1) {
      results.push({ ...turn, status: "ambiguous", matchedStateNodeId: null, explanation: `${candidates.length} planned states use the decoded move combination; branching stays disabled until the outcome is unique.` });
    } else {
      results.push({ ...turn, status: "unmatched", matchedStateNodeId: null, explanation: "No planned state uses the decoded move combination for this turn." });
    }
  }
  return results;
}

export class LocalBattleTracker {
  constructor({ fetchImpl = fetch, pollIntervalMs = POLL_INTERVAL_MS, onUpdate = () => {}, onError = () => {} } = {}) {
    this.fetchImpl = fetchImpl;
    this.pollIntervalMs = pollIntervalMs;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.active = false;
    this.state = null;
    this.events = [];
    this.lastEventId = 0;
    this.startedAt = null;
    this.timer = null;
  }

  snapshot() {
    return trackerSessionSnapshot({ active: this.active, state: this.state, events: this.events, startedAt: this.startedAt });
  }

  async begin() {
    if (this.active) return this.snapshot();
    const capability = await detectLocalBattleTrackerCapability(this.fetchImpl);
    if (!capability) throw new Error("The private VW2R Battle Log is unavailable.");
    this.state = await readJson("/state", this.fetchImpl);
    const history = await readJson("/events?after=0", this.fetchImpl);
    const allEvents = Array.isArray(history?.events) ? history.events : [];
    const lastStartIndex = allEvents.findLastIndex(isBattleStart);
    const currentBattleEvents = lastStartIndex >= 0 ? allEvents.slice(lastStartIndex) : [];
    const endedAfterStart = currentBattleEvents.some(isBattleEnd);
    this.events = this.state.battleActive && !endedAfterStart ? currentBattleEvents : [];
    this.lastEventId = Math.max(Number(this.state.lastEventId) || 0, ...allEvents.map(event => Number(event?.id) || 0));
    this.startedAt = new Date().toISOString();
    this.active = true;
    this.onUpdate(this.snapshot());
    this.schedule();
    return this.snapshot();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.onUpdate(this.snapshot());
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.active) return;
    this.timer = setTimeout(() => this.poll().catch(error => this.onError(error)), this.pollIntervalMs);
  }

  async poll() {
    if (!this.active) return;
    try {
      const [state, payload] = await Promise.all([
        readJson("/state", this.fetchImpl),
        readJson(`/events?after=${this.lastEventId}`, this.fetchImpl),
      ]);
      this.state = state;
      for (const event of Array.isArray(payload?.events) ? payload.events : []) {
        this.lastEventId = Math.max(this.lastEventId, Number(event?.id) || 0);
        if (isBattleStart(event)) this.events = [event];
        else if (this.events.length) this.events.push(event);
      }
      this.onUpdate(this.snapshot());
    } finally {
      this.schedule();
    }
  }
}
