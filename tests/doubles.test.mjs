import assert from "node:assert/strict";
import test from "node:test";
import { createDisplayProjection } from "../src/contracts/display_projection.js";
import { assertValidPlanDocument } from "../src/contracts/plan_contract.js";
import { parsePlan, serializePlan } from "../src/contracts/plan_file.js";
import { commitPreview, previewForcedReplacement, previewTurn, repairStaleLeafBattleEnd } from "../src/core/planner.js";
import { resolveForcedReplacement, resolveTurn } from "../src/core/resolver.js";
import { damageAdapter, fixtureDoublesPlan } from "./helpers.mjs";

function move(actorKey, moveId, targetKeys = []) {
  return { actionType: "move", actorKey, moveId, targetKeys, mechanicActivations: [], declaredAtStateHash: "fixture" };
}

function turnActions(players, enemies, overrides = {}) {
  return {
    player: [
      move(players[0].combatantKey, "tackle", [enemies[0].combatantKey]),
      move(players[1].combatantKey, "tackle", [enemies[1].combatantKey])
    ],
    enemy: [
      move(enemies[0].combatantKey, "tackle", [players[0].combatantKey]),
      move(enemies[1].combatantKey, "tackle", [players[1].combatantKey])
    ],
    ...overrides
  };
}

function setDistinctSpeeds(plan, players, enemies) {
  plan.combatants[players[0].combatantKey].calculatedStats.spe = 140;
  plan.combatants[players[1].combatantKey].calculatedStats.spe = 120;
  plan.combatants[enemies[0].combatantKey].calculatedStats.spe = 80;
  plan.combatants[enemies[1].combatantKey].calculatedStats.spe = 60;
}

test("Doubles format is dataset-derived and schema-v2 plans round-trip", () => {
  const { plan, players, enemies } = fixtureDoublesPlan();
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.game.battleFormat, "doubles");
  const root = plan.stateNodes[plan.initialStateNodeId];
  assert.deepEqual(root.active.playerCombatantKeys, players.slice(0, 2).map(mon => mon.combatantKey));
  assert.deepEqual(root.active.enemyCombatantKeys, enemies.slice(0, 2).map(mon => mon.combatantKey));
  assertValidPlanDocument(plan);
  assert.deepEqual(parsePlan(serializePlan(plan)), plan);
});

test("four active actions resolve in priority and speed order", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  setDistinctSpeeds(plan, players, enemies);
  const calls = [];
  const [outcome] = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: turnActions(players, enemies, {
      player: [move(players[0].combatantKey, "aquajet", [enemies[0].combatantKey]), move(players[1].combatantKey, "tackle", [enemies[1].combatantKey])]
    }),
    dataset,
    damageAdapter: damageAdapter(input => { calls.push(input.attacker.combatantKey); return [1]; })
  });
  assert.deepEqual(calls, [players[0].combatantKey, players[1].combatantKey, enemies[0].combatantKey, enemies[1].combatantKey]);
  assert.equal(outcome.events.filter(event => event.eventType === "damage").length, 4);
});

test("Revenge keeps negative priority and doubles only against the opponent that damaged its user", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  const user = players[0];
  plan.combatants[user.combatantKey].moves[0] = { moveId: "revenge", maxPp: dataset.get("moves", "revenge").pp };
  plan.stateNodes[plan.initialStateNodeId].combatantStates[user.combatantKey].movePp.revenge = dataset.get("moves", "revenge").pp;
  const powers = [];
  const attackOrder = [];
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: {
      player: [move(user.combatantKey, "revenge", [enemies[1].combatantKey]), move(players[1].combatantKey, "protect", [players[1].combatantKey])],
      enemy: [move(enemies[0].combatantKey, "tackle", [user.combatantKey]), move(enemies[1].combatantKey, "tackle", [players[1].combatantKey])]
    },
    dataset,
    damageAdapter: damageAdapter(input => {
      attackOrder.push(input.attacker.combatantKey);
      if (input.move.id === "revenge") powers.push(input.moveOverrides?.basePower);
      return [1];
    })
  });
  assert.equal(attackOrder.at(-1), user.combatantKey, "Revenge resolves after ordinary attacks despite the user's higher Speed");
  assert.ok(powers.length > 0 && powers.every(power => power === 60), "damage from the other opposing slot does not empower Revenge against its target");
  assert.ok(outcomes.every(outcome => {
    const revengeIndex = outcome.events.findIndex(event => event.eventType === "damage" && event.actorKey === user.combatantKey);
    const earlierEnemyDamage = outcome.events.findIndex(event => event.eventType === "damage" && event.actorKey === enemies[0].combatantKey);
    return earlierEnemyDamage >= 0 && revengeIndex > earlierEnemyDamage;
  }));
});

test("a single-target move was redirected when its opposing slot target fainted earlier in the turn", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  setDistinctSpeeds(plan, players, enemies);
  const actions = turnActions(players, enemies, {
    player: [
      move(players[0].combatantKey, "tackle", [enemies[0].combatantKey]),
      move(players[1].combatantKey, "tackle", [enemies[0].combatantKey])
    ]
  });
  const [outcome] = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions,
    dataset,
    damageAdapter: damageAdapter(({ attacker }) => attacker.combatantKey === players[0].combatantKey ? [999] : attacker.combatantKey === players[1].combatantKey ? [10] : [1])
  });
  const redirect = outcome.events.find(event => event.eventType === "move-redirected" && event.actorKey === players[1].combatantKey);
  assert.equal(redirect?.targetKey, enemies[1].combatantKey);
  assert.equal(redirect?.metadata?.reason, "target-fainted");
  assert.ok(outcome.events.some(event => event.eventType === "damage" && event.actorKey === players[1].combatantKey && event.targetKey === enemies[1].combatantKey));
  assert.equal(outcome.events.some(event => event.reason === "target-fainted-before-action"), false);
});

test("a queued single-target move failed when both opposing slots were empty but reserves remained", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  plan.combatants[players[1].combatantKey].calculatedStats.spe = 140;
  plan.combatants[players[0].combatantKey].calculatedStats.spe = 120;
  plan.combatants[enemies[0].combatantKey].calculatedStats.spe = 80;
  plan.combatants[enemies[1].combatantKey].calculatedStats.spe = 60;
  const actions = turnActions(players, enemies, {
    player: [
      move(players[0].combatantKey, "tackle", [enemies[0].combatantKey]),
      move(players[1].combatantKey, "surf", [enemies[0].combatantKey, enemies[1].combatantKey])
    ]
  });
  const [outcome] = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions,
    dataset,
    damageAdapter: damageAdapter(({ attacker }) => attacker.combatantKey === players[1].combatantKey ? [999] : [1])
  });
  assert.ok(outcome.events.some(event => event.eventType === "action-skipped" && event.actorKey === players[0].combatantKey && event.reason === "no-legal-target"));
  assert.equal(outcome.events.some(event => event.eventType === "move-redirected" && event.actorKey === players[0].combatantKey), false);
  assert.equal(outcome.state.battleEnded, false);
  assert.deepEqual(outcome.state.pendingReplacementSlots, [{ side: "enemy", slot: 0 }, { side: "enemy", slot: 1 }]);
});

test("Earthquake reaches the ally and both foes while Surf reaches only both foes", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  setDistinctSpeeds(plan, players, enemies);
  const observedFormats = [];
  const actions = turnActions(players, enemies, {
    player: [
      move(players[0].combatantKey, "earthquake", [players[1].combatantKey, enemies[0].combatantKey, enemies[1].combatantKey]),
      move(players[1].combatantKey, "surf", [enemies[0].combatantKey, enemies[1].combatantKey])
    ]
  });
  const [outcome] = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions,
    dataset,
    damageAdapter: damageAdapter(input => { observedFormats.push([input.battleFormat, input.spreadTargetCount]); return [1]; })
  });
  const quakeTargets = outcome.events.filter(event => event.eventType === "damage" && event.moveId === "earthquake").map(event => event.targetKey).sort();
  const surfTargets = outcome.events.filter(event => event.eventType === "damage" && event.moveId === "surf").map(event => event.targetKey).sort();
  assert.deepEqual(quakeTargets, [players[1].combatantKey, enemies[0].combatantKey, enemies[1].combatantKey].sort());
  assert.deepEqual(surfTargets, [enemies[0].combatantKey, enemies[1].combatantKey].sort());
  assert.ok(observedFormats.every(([format]) => format === "doubles"));
  assert.ok(observedFormats.some(([, count]) => count === 3));
  assert.ok(observedFormats.some(([, count]) => count === 2));
});

test("Protect blocks attacks into only the protected slot", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  setDistinctSpeeds(plan, players, enemies);
  const actions = turnActions(players, enemies, {
    player: [move(players[0].combatantKey, "protect", [players[0].combatantKey]), move(players[1].combatantKey, "tackle", [enemies[1].combatantKey])]
  });
  const [outcome] = resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [10]) });
  assert.ok(outcome.events.some(event => event.eventType === "move-blocked" && event.targetKey === players[0].combatantKey));
  assert.ok(outcome.events.some(event => event.eventType === "damage" && event.targetKey === players[1].combatantKey));
  assert.equal(outcome.events.some(event => event.eventType === "damage" && event.targetKey === players[0].combatantKey), false);
});

test("slot switching preserves benched HP and rejects duplicate destinations", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  setDistinctSpeeds(plan, players, enemies);
  const root = plan.stateNodes[plan.initialStateNodeId];
  root.combatantStates[players[0].combatantKey].hp = { ...root.combatantStates[players[0].combatantKey].hp, min: 64, max: 64 };
  root.combatantStates[players[2].combatantKey].hp = { ...root.combatantStates[players[2].combatantKey].hp, min: 77, max: 77 };
  delete root.combatantStates[players[0].combatantKey].hpDistribution;
  delete root.combatantStates[players[2].combatantKey].hpDistribution;
  const switchAction = { actionType: "switch", actorKey: players[0].combatantKey, switchToKey: players[2].combatantKey, switchKind: "voluntary", declaredAtStateHash: root.stateHash };
  const actions = turnActions(players, enemies, { player: [switchAction, move(players[1].combatantKey, "tackle", [enemies[1].combatantKey])] });
  const [outcome] = resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  assert.equal(outcome.state.active.playerCombatantKeys[0], players[2].combatantKey);
  assert.deepEqual(outcome.state.combatantStates[players[0].combatantKey].hp, { ...root.combatantStates[players[0].combatantKey].hp, min: 64, max: 64 });
  assert.equal(outcome.state.combatantStates[players[2].combatantKey].hp.max, 76, "the attack aimed at slot 1 reaches the switch-in");

  const duplicate = turnActions(players, enemies, { player: [switchAction, { ...switchAction, actorKey: players[1].combatantKey }] });
  assert.throws(() => resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions: duplicate, dataset, damageAdapter: damageAdapter(() => [1]) }), /same Pokémon/i);
});

test("two fainted slots require and accept distinct same-turn forced replacements", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  plan.combatants[players[0].combatantKey].calculatedStats.spe = 10;
  plan.combatants[players[1].combatantKey].calculatedStats.spe = 9;
  plan.combatants[enemies[0].combatantKey].calculatedStats.spe = 200;
  plan.combatants[enemies[1].combatantKey].calculatedStats.spe = 190;
  const root = plan.stateNodes[plan.initialStateNodeId];
  for (const player of players.slice(0, 2)) {
    root.combatantStates[player.combatantKey].hp = { ...root.combatantStates[player.combatantKey].hp, min: 5, max: 5 };
    delete root.combatantStates[player.combatantKey].hpDistribution;
  }
  const actions = turnActions(players, enemies);
  const [fainted] = resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [10]) });
  assert.deepEqual(fainted.state.pendingReplacementSlots, [{ side: "player", slot: 0 }, { side: "player", slot: 1 }]);
  assert.equal(fainted.state.battleEnded, false);
  assert.equal(fainted.state.fieldState.sides.player.retaliateReady, true);
  assert.equal(fainted.state.fieldState.sides.enemy.retaliateReady, false);
  plan.stateNodes.fainted = { ...fainted.state, stateNodeId: "fainted" };
  const replacements = { player: [
    { actionType: "replacement", side: "player", slot: 0, switchToKey: players[2].combatantKey, reason: "previous-active-fainted", consumesTurn: false },
    { actionType: "replacement", side: "player", slot: 1, switchToKey: players[3].combatantKey, reason: "previous-active-fainted", consumesTurn: false }
  ] };
  const [replaced] = resolveForcedReplacement({ plan, parentStateNodeId: "fainted", replacements, dataset });
  assert.deepEqual(replaced.state.active.playerCombatantKeys, [players[2].combatantKey, players[3].combatantKey]);
  assert.deepEqual(replaced.state.pendingReplacementSlots, []);
  assert.equal(replaced.state.turnNumber, fainted.state.turnNumber);
  assert.throws(() => resolveForcedReplacement({ plan, parentStateNodeId: "fainted", replacements: { player: [replacements.player[0], { ...replacements.player[1], switchToKey: players[2].combatantKey }] }, dataset }), /invalid/i);
});

test("Doubles empties an unfillable fainted slot and preserves the surviving slot identity", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  plan.combatants[players[0].combatantKey].calculatedStats.spe = 10;
  plan.combatants[players[1].combatantKey].calculatedStats.spe = 100;
  plan.combatants[enemies[0].combatantKey].calculatedStats.spe = 200;
  plan.combatants[enemies[1].combatantKey].calculatedStats.spe = 190;
  for (const player of [players[0], ...players.slice(2)]) {
    root.combatantStates[player.combatantKey].hp = { ...root.combatantStates[player.combatantKey].hp, min: 0, max: 0 };
    delete root.combatantStates[player.combatantKey].hpDistribution;
  }
  root.combatantStates[players[0].combatantKey].hp = { ...root.combatantStates[players[0].combatantKey].hp, min: 5, max: 5 };
  const actions = turnActions(players, enemies, {
    enemy: [
      move(enemies[0].combatantKey, "tackle", [players[0].combatantKey]),
      move(enemies[1].combatantKey, "tackle", [players[1].combatantKey])
    ]
  });
  const preview = previewTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions,
    dataset,
    damageAdapter: damageAdapter(({ defender }) => defender.combatantKey === players[0].combatantKey ? [999] : [1])
  });
  const committed = commitPreview(plan, preview, dataset, { commitSelectedOnly: true });
  const state = committed.plan.stateNodes[committed.cursorStateNodeId];
  assert.deepEqual(state.active.playerCombatantKeys, [null, players[1].combatantKey]);
  assert.deepEqual(state.pendingReplacementSlots, []);
  assert.equal(state.battleEnded, false);
  assert.ok(state.resolutionEventIds.map(id => committed.plan.resolutionEvents[id]).some(event => event.eventType === "slot-emptied" && event.metadata.slot === 0));
  assertValidPlanDocument(committed.plan);
  const projection = createDisplayProjection(committed.plan, [committed.cursorStateNodeId]);
  assert.equal(projection.columns[0].turns[0].players.length, 1);
  assert.equal(projection.columns[0].turns[0].players[0].slot, 1);
  state.active.playerCombatantKeys[0] = players[0].combatantKey;
  state.battleEnded = true;
  const staleBattleEventId = "event-stale-battle-ended";
  committed.plan.resolutionEvents[staleBattleEventId] = {
    eventId: staleBattleEventId,
    turnNumber: state.turnNumber,
    step: state.resolutionEventIds.length + 1,
    eventType: "battle-ended",
    actorKey: null,
    targetKey: null,
    moveId: null,
    metadata: { resultLabel: "Battle ended" }
  };
  state.resolutionEventIds.push(staleBattleEventId);
  const oldStateHash = state.stateHash;
  const repaired = repairStaleLeafBattleEnd(committed.plan, committed.cursorStateNodeId);
  assert.equal(repaired.changed, true);
  assert.equal(repaired.plan.stateNodes[committed.cursorStateNodeId].battleEnded, false);
  assert.notEqual(repaired.plan.stateNodes[committed.cursorStateNodeId].stateHash, oldStateHash);
  assert.equal(repaired.plan.resolutionEvents[staleBattleEventId], undefined);

  const next = previewTurn({
    plan: repaired.plan,
    parentStateNodeId: committed.cursorStateNodeId,
    actions: {
      player: [move(players[1].combatantKey, "tackle", [enemies[1].combatantKey])],
      enemy: [
        move(enemies[0].combatantKey, "tackle", [players[1].combatantKey]),
        move(enemies[1].combatantKey, "tackle", [players[1].combatantKey])
      ]
    },
    dataset,
    damageAdapter: damageAdapter(() => [1])
  });
  assert.equal(next.proposedTurnNumber, 2);
  assert.equal(next.outcomes[0].state.active.playerCombatantKeys[0], null);
  assert.equal(next.outcomes[0].state.active.playerCombatantKeys[1], players[1].combatantKey);
  assert.deepEqual(next.actions.player.map(action => action?.actorKey || null), [null, players[1].combatantKey]);
  const final = commitPreview(repaired.plan, next, dataset, { commitSelectedOnly: true });
  assertValidPlanDocument(final.plan);
  assert.deepEqual(final.plan.actionGroups[final.actionGroupId].actions.player.map(action => action?.actorKey || null), [null, players[1].combatantKey]);
});

test("committed Doubles turns project both slots for Overlay", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  setDistinctSpeeds(plan, players, enemies);
  const preview = previewTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions: turnActions(players, enemies), dataset, damageAdapter: damageAdapter(() => [1]) });
  const committed = commitPreview(plan, preview, dataset);
  const projection = createDisplayProjection(committed.plan, [committed.cursorStateNodeId], { projectionRevision: 1, sentAt: "2026-08-24T00:00:00.000Z" });
  assert.equal(projection.schemaVersion, 2);
  assert.equal(projection.columns[0].turns[0].players.length, 2);
  assert.equal(projection.columns[0].turns[0].enemies.length, 2);
  assert.ok(projection.columns[0].turns[0].players.every(entry => entry.action));
});

test("spread-move projection preserves a range label for every target", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  setDistinctSpeeds(plan, players, enemies);
  const preview = previewTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: turnActions(players, enemies, {
      player: [move(players[0].combatantKey, "earthquake", [players[1].combatantKey, enemies[0].combatantKey, enemies[1].combatantKey]), move(players[1].combatantKey, "protect", [players[1].combatantKey])]
    }),
    dataset,
    damageAdapter: damageAdapter(() => [8, 10])
  });
  const committed = commitPreview(plan, preview, dataset);
  const projectedAction = createDisplayProjection(committed.plan, [committed.cursorStateNodeId]).columns[0].turns[0].players[0].action;
  assert.equal(projectedAction.damagePercent, undefined);
  assert.match(projectedAction.resultLabel, /Fast B .*Slowmon A .*Slowmon B/);
  assert.match(projectedAction.resultLabel, /Fast B Blocked by Protect/);
  assert.equal((projectedAction.resultLabel.match(/%/g) || []).length, 2);
});

test("a committed Doubles switch is displayed on the incoming slot occupant", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  setDistinctSpeeds(plan, players, enemies);
  const root = plan.stateNodes[plan.initialStateNodeId];
  const switchAction = { actionType: "switch", actorKey: players[0].combatantKey, switchToKey: players[2].combatantKey, switchKind: "voluntary", declaredAtStateHash: root.stateHash };
  const preview = previewTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: turnActions(players, enemies, { player: [switchAction, move(players[1].combatantKey, "tackle", [enemies[1].combatantKey])] }),
    dataset,
    damageAdapter: damageAdapter(() => [1])
  });
  const committed = commitPreview(plan, preview, dataset);
  const snapshot = committed.plan.stateNodes[committed.cursorStateNodeId].displaySnapshot;
  assert.equal(snapshot.players[0].combatantKey, players[2].combatantKey);
  assert.equal(snapshot.players[0].action.actionType, "switch");
  assert.match(snapshot.players[0].action.resultLabel, /Switch to Bench A/);
});

test("forced-replacement planner preview keeps slot identity", () => {
  const { dataset, plan, players } = fixtureDoublesPlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  root.pendingReplacementSlots = [{ side: "player", slot: 1 }];
  root.pendingReplacementSides = ["player"];
  root.combatantStates[players[1].combatantKey].hp = { ...root.combatantStates[players[1].combatantKey].hp, min: 0, max: 0 };
  const replacement = { actionType: "replacement", side: "player", slot: 1, switchToKey: players[2].combatantKey, reason: "previous-active-fainted", consumesTurn: false };
  const preview = previewForcedReplacement({ plan, parentStateNodeId: plan.initialStateNodeId, replacements: { player: [replacement] }, dataset });
  assert.equal(preview.replacements.player[0].slot, 1);
  assert.equal(preview.outcomes[0].state.active.playerCombatantKeys[1], players[2].combatantKey);
});
