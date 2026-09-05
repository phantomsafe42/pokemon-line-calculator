import assert from "node:assert/strict";
import test from "node:test";
import {
  compareTrackerTurns,
  LocalBattleTracker,
  trackerSessionSnapshot
} from "../src/integrations/local_battle_tracker.js";

const event = (id, kind, text, turn = null, details = {}) => ({ id, kind, text, turn, details, timeUtc: `2026-08-27T00:00:0${id}Z` });

test("tracker groups an observed battle into fixed turn nodes and marks completed turns", () => {
  const snapshot = trackerSessionSnapshot({
    active: true,
    state: { battleActive: true, turn: 2, lastEventId: 5 },
    events: [
      event(1, "battle", "Battle started."),
      event(2, "turn", "Turn 1", 1),
      event(3, "move", "Fastmon used Tackle!", 1, { moveId: 33 }),
      event(4, "turn", "Turn 2", 2),
      event(5, "move", "Slowmon used Tackle!", 2, { moveId: 33 }),
    ]
  });
  assert.equal(snapshot.battleId, "battle-log-1");
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[0].complete, true);
  assert.equal(snapshot.turns[1].complete, false);
});

test("tracker permits branch creation only for a unique decoded planned-state match", () => {
  const plan = {
    stateNodes: {
      turn1: { stateNodeId: "turn1", turnNumber: 1, parentActionGroupId: "group1" },
      other: { stateNodeId: "other", turnNumber: 2, parentActionGroupId: "group2" },
    },
    actionGroups: {
      group1: { actions: { player: [{ actionType: "move", moveId: "tackle" }], enemy: [{ actionType: "move", moveId: "tackle" }] } },
      group2: { actions: { player: [{ actionType: "move", moveId: "recover" }], enemy: [{ actionType: "move", moveId: "tackle" }] } },
    }
  };
  const dataset = { indexes: { moves: new Map([
    ["tackle", { id: "tackle", num: 33 }],
    ["recover", { id: "recover", num: 105 }],
  ]) } };
  const tracker = {
    turns: [{ turnNumber: 1, complete: true, events: [
      event(3, "move", "Fastmon used Tackle!", 1, { moveId: 33, actorCode: 0 }),
      event(4, "move", "Slowmon used Tackle!", 1, { moveId: 33, actorCode: 12 }),
    ] }]
  };
  const [match] = compareTrackerTurns(plan, tracker, dataset);
  assert.equal(match.status, "matched");
  assert.equal(match.matchedStateNodeId, "turn1");

  plan.stateNodes.duplicate = { stateNodeId: "duplicate", turnNumber: 1, parentActionGroupId: "group3" };
  plan.actionGroups.group3 = structuredClone(plan.actionGroups.group1);
  const [ambiguous] = compareTrackerTurns(plan, tracker, dataset);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.matchedStateNodeId, null);
});

test("tracker matching preserves player and enemy move ownership", () => {
  const plan = {
    stateNodes: { turn1: { stateNodeId: "turn1", turnNumber: 1, parentActionGroupId: "group1" } },
    actionGroups: {
      group1: { actions: { player: [{ actionType: "move", moveId: "recover" }], enemy: [{ actionType: "move", moveId: "tackle" }] } }
    }
  };
  const dataset = { indexes: { moves: new Map([
    ["tackle", { id: "tackle", num: 33 }],
    ["recover", { id: "recover", num: 105 }]
  ]) } };
  const tracker = { turns: [{ turnNumber: 1, complete: true, events: [
    event(3, "move", "Player used Tackle!", 1, { moveId: 33, actorCode: 0 }),
    event(4, "move", "Opponent used Recover!", 1, { moveId: 105, actorCode: 12 })
  ] }] };
  const [result] = compareTrackerTurns(plan, tracker, dataset);
  assert.equal(result.status, "unmatched");
  assert.equal(result.matchedStateNodeId, null);
});

test("local tracker baselines completed history and follows the next battle without replaying old events", async () => {
  let phase = "begin";
  const fetchImpl = async url => {
    const path = new URL(url, "http://local.test").pathname + new URL(url, "http://local.test").search;
    const json = value => ({ ok: true, status: 200, json: async () => value });
    if (path.endsWith("/capability")) return json({ available: true, gameId: "volt-white-2r", readOnly: true });
    if (path.endsWith("/state")) return json(phase === "begin"
      ? { battleActive: false, turn: 0, lastEventId: 3 }
      : { battleActive: true, turn: 1, lastEventId: 6 });
    if (path.endsWith("events?after=0")) return json({ events: [event(1, "battle", "Battle started."), event(2, "battle", "Battle ended."), event(3, "status", "Waiting")] });
    if (path.endsWith("events?after=3")) return json({ events: [event(4, "battle", "Battle started."), event(5, "turn", "Turn 1", 1), event(6, "move", "Fastmon used Tackle!", 1, { moveId: 33, actorCode: 0 })] });
    throw new Error(`unexpected ${path}`);
  };
  const tracker = new LocalBattleTracker({ fetchImpl, pollIntervalMs: 60_000 });
  const initial = await tracker.begin();
  assert.equal(initial.waitingForBattle, true);
  assert.equal(initial.lastEventId, 3);
  phase = "battle";
  await tracker.poll();
  const current = tracker.snapshot();
  assert.equal(current.battleId, "battle-log-4");
  assert.equal(current.turns.length, 1);
  tracker.stop();
});
