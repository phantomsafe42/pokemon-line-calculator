import assert from "node:assert/strict";
import test from "node:test";
import { createSharedDamageAdapter } from "../src/adapters/shared_damage_adapter.js";
import { trainerBattleFormat } from "../src/adapters/standardized_dataset.js";
import { validatePlanDocument } from "../src/contracts/plan_contract.js";
import { parsePlan, serializePlan } from "../src/contracts/plan_file.js";
import { previewCombatantMove } from "../src/core/combatant_moves.js";
import { upgradeInitialEntryEffects } from "../src/core/plan.js";
import { commitPreview, previewTurn } from "../src/core/planner.js";
import { resolveForcedReplacement, resolveTurn, validateTurnActions } from "../src/core/resolver.js";
import { areSlotsAdjacent, canSelectShift, shiftWithCenter, triplePositionForSlot, tripleSlotForPosition } from "../src/rulesets/triple_battle.js";
import { damageAdapter, fixtureTriplePlan } from "./helpers.mjs";

const action = (actorKey, moveId, targetKeys = []) => ({
  actionType: "move",
  actorKey,
  moveId,
  targetKeys,
  mechanicActivations: [],
  declaredAtStateHash: "fixture"
});

const shift = actorKey => ({ actionType: "shift", actorKey, declaredAtStateHash: "fixture" });

function installMove(dataset, plan, state, combatantKey, move) {
  dataset.indexes.moves.set(move.id, move);
  const combatant = plan.combatants[combatantKey];
  combatant.moves = [...combatant.moves.filter(entry => entry.moveId !== move.id), { moveId: move.id, maxPp: move.pp }];
  state.combatantStates[combatantKey].movePp[move.id] = move.pp;
}

function setSpeed(plan, state, combatantKey, speed) {
  plan.combatants[combatantKey].calculatedStats.spe = speed;
  state.combatantStates[combatantKey].currentStats = {
    ...(state.combatantStates[combatantKey].currentStats || plan.combatants[combatantKey].calculatedStats),
    spe: speed
  };
}

function setExactHp(state, combatantKey, hp) {
  const monState = state.combatantStates[combatantKey];
  monState.hp = { min: hp, max: hp, maxHp: monState.hp.maxHp };
  monState.hpDistribution = [{ value: hp, probability: 1 }];
}

const vw2rMove = (id, name, overrides = {}) => ({
  id,
  name,
  calcName: name,
  type: "normal",
  category: "status",
  basePower: 0,
  accuracy: true,
  pp: 10,
  priority: 0,
  target: "self",
  ...overrides
});

function ordinaryActions(players, enemies) {
  return {
    player: [
      action(players[0].combatantKey, "tackle", [enemies[1].combatantKey]),
      action(players[1].combatantKey, "tackle", [enemies[2].combatantKey]),
      action(players[2].combatantKey, "tackle", [enemies[0].combatantKey])
    ],
    enemy: [
      action(enemies[0].combatantKey, "tackle", [players[2].combatantKey]),
      action(enemies[1].combatantKey, "tackle", [players[0].combatantKey]),
      action(enemies[2].combatantKey, "tackle", [players[1].combatantKey])
    ]
  };
}

test("Triple plans use schema v3, three active slots, and player-view top-down adjacency", () => {
  const { plan } = fixtureTriplePlan();
  assert.equal(trainerBattleFormat({ battleProfiles: { challenge: { format: "triple" } } }, { trainerBattleProfile: "challenge" }), "triples");
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.game.battleFormat, "triples");
  const root = plan.stateNodes[plan.initialStateNodeId];
  assert.equal(root.active.playerCombatantKeys.length, 3);
  assert.equal(root.active.enemyCombatantKeys.length, 3);
  assert.equal(validatePlanDocument(plan).valid, true);
  const schemaTwoTriple = structuredClone(plan);
  schemaTwoTriple.schemaVersion = 2;
  assert.equal(validatePlanDocument(schemaTwoTriple).valid, false);

  assert.deepEqual([0, 1, 2].map(slot => triplePositionForSlot(plan, "enemy", slot)), [2, 0, 1]);
  assert.deepEqual([0, 1, 2].map(position => tripleSlotForPosition(plan, "enemy", position)), [1, 2, 0]);
  assert.equal(areSlotsAdjacent(plan, "player", 0, "enemy", 0), false);
  assert.equal(areSlotsAdjacent(plan, "player", 0, "enemy", 1), true);
  assert.equal(areSlotsAdjacent(plan, "player", 0, "enemy", 2), true);
  assert.equal(areSlotsAdjacent(plan, "player", 1, "enemy", 0), true);
  assert.equal(areSlotsAdjacent(plan, "player", 1, "enemy", 2), true);
  assert.equal(areSlotsAdjacent(plan, "player", 2, "enemy", 0), true);
  assert.equal(areSlotsAdjacent(plan, "player", 2, "enemy", 1), false);
  assert.equal(areSlotsAdjacent(plan, "player", 2, "enemy", 2), true);
  assert.equal(areSlotsAdjacent(plan, "player", 0, "player", 1), true);
  assert.equal(areSlotsAdjacent(plan, "player", 0, "player", 2), false);
});

test("Triple target validation rejects a far corner but permits an explicit distance move", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const actions = ordinaryActions(players, enemies);
  actions.player[0].targetKeys = [enemies[0].combatantKey];
  assert.throws(() => validateTurnActions({ plan, parentState: root, actions, dataset }), /legal active target/);

  const distanceSupport = move => ({
    supported: true,
    effectId: "direct-damage",
    target: "target",
    targetMode: "normal",
    flags: { distance: 1 },
    moveId: move.id
  });
  assert.equal(validateTurnActions({ plan, parentState: root, actions, dataset, moveSupport: distanceSupport }).ready, true);
});

test("original Flying and pulse moves reach a far corner but Flying Hidden Power does not", () => {
  for (const move of [
    vw2rMove("wingattack", "Wing Attack", { type: "flying", category: "physical", basePower: 60, target: "normal" }),
    vw2rMove("waterpulse", "Water Pulse", { type: "water", category: "special", basePower: 60, target: "normal" })
  ]) {
    const { dataset, players, enemies, plan } = fixtureTriplePlan();
    dataset.gameId = "volt-white-2r";
    const root = plan.stateNodes[plan.initialStateNodeId];
    const actorKey = players[0].combatantKey;
    installMove(dataset, plan, root, actorKey, move);
    const actions = ordinaryActions(players, enemies);
    actions.player[0] = action(actorKey, move.id, [enemies[0].combatantKey]);
    assert.equal(validateTurnActions({ plan, parentState: root, actions, dataset }).ready, true);
  }

  const hiddenPower = fixtureTriplePlan();
  hiddenPower.dataset.gameId = "volt-white-2r";
  const hiddenRoot = hiddenPower.plan.stateNodes[hiddenPower.plan.initialStateNodeId];
  const actorKey = hiddenPower.players[0].combatantKey;
  installMove(hiddenPower.dataset, hiddenPower.plan, hiddenRoot, actorKey,
    vw2rMove("hiddenpower", "Hidden Power", { type: "flying", category: "special", basePower: 70, target: "normal" }));
  const actions = ordinaryActions(hiddenPower.players, hiddenPower.enemies);
  actions.player[0] = action(actorKey, "hiddenpower", [hiddenPower.enemies[0].combatantKey]);
  assert.throws(
    () => validateTurnActions({ plan: hiddenPower.plan, parentState: hiddenRoot, actions, dataset: hiddenPower.dataset }),
    /legal active target/
  );
});

test("a distance-enabled move resolves against a living far-corner target", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const actions = ordinaryActions(players, enemies);
  const actorKey = players[0].combatantKey;
  const targetKey = enemies[0].combatantKey;
  actions.player[0].targetKeys = [targetKey];
  setSpeed(plan, root, actorKey, 500);
  const distanceSupport = move => ({
    supported: true,
    effectId: "direct-damage",
    target: "target",
    targetMode: "normal",
    flags: { distance: 1 },
    moveId: move.id
  });

  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: root.stateNodeId,
    actions,
    dataset,
    moveSupport: distanceSupport,
    damageAdapter: damageAdapter(() => [1])
  });
  for (const outcome of outcomes) {
    assert.ok(outcome.events.some(event => event.eventType === "damage" && event.actorKey === actorKey && event.targetKey === targetKey));
  }
});

test("Shift resolves at priority zero, preserves state, and can make the displaced center move fail", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const leftKey = players[0].combatantKey;
  const centerKey = players[1].combatantKey;
  plan.combatants[leftKey].calculatedStats.spe = 200;
  plan.combatants[centerKey].calculatedStats.spe = 100;
  root.combatantStates[leftKey].statStages.atk = 2;
  root.combatantStates[leftKey].majorStatus = "slp";
  root.combatantStates[leftKey].volatileConditions.sleepCounterDistribution = [{ value: 3, probability: 1 }];
  const tacklePp = root.combatantStates[leftKey].movePp.tackle;
  const actions = ordinaryActions(players, enemies);
  actions.player[0] = shift(leftKey);
  actions.player[1] = action(centerKey, "tackle", [enemies[0].combatantKey]);
  const illegalCenterShift = ordinaryActions(players, enemies);
  illegalCenterShift.player[1] = shift(centerKey);
  assert.throws(() => validateTurnActions({ plan, parentState: root, actions: illegalCenterShift, dataset }), /center position/);

  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  assert.ok(outcomes.length >= 1);
  for (const outcome of outcomes) {
    assert.deepEqual(outcome.state.active.playerCombatantKeys, [centerKey, leftKey, players[2].combatantKey]);
    assert.equal(outcome.state.combatantStates[leftKey].statStages.atk, 2);
    assert.equal(outcome.state.combatantStates[leftKey].majorStatus, "slp");
    assert.deepEqual(outcome.state.combatantStates[leftKey].volatileConditions.sleepCounterDistribution, [{ value: 3, probability: 1 }]);
    assert.equal(outcome.state.combatantStates[leftKey].movePp.tackle, tacklePp);
    assert.ok(outcome.events.some(event => event.eventType === "shift" && event.actorKey === leftKey));
    assert.equal(outcome.events.some(event => event.eventType === "switch" && event.actorKey === leftKey), false);
    assert.ok(outcome.events.some(event => event.eventType === "action-skipped" && event.actorKey === centerKey && event.reason === "no-legal-target"));
  }
});

test("both edge Pokemon may Shift sequentially in the same turn", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const [leftKey, centerKey, rightKey] = players.map(mon => mon.combatantKey);
  plan.combatants[leftKey].calculatedStats.spe = 200;
  plan.combatants[rightKey].calculatedStats.spe = 150;
  plan.combatants[centerKey].calculatedStats.spe = 100;
  const actions = ordinaryActions(players, enemies);
  actions.player = [shift(leftKey), action(centerKey, "protect"), shift(rightKey)];

  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  for (const outcome of outcomes) {
    assert.deepEqual(outcome.state.active.playerCombatantKeys, [centerKey, rightKey, leftKey]);
    assert.equal(outcome.events.filter(event => event.eventType === "shift").length, 2);
  }
});

test("enemy Shift controls use player-view left, center, and right positions", () => {
  const { enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  assert.equal(canSelectShift(plan, root, "enemy", enemies[1].combatantKey), true);
  assert.equal(canSelectShift(plan, root, "enemy", enemies[2].combatantKey), false);
  assert.equal(canSelectShift(plan, root, "enemy", enemies[0].combatantKey), true);
  assert.deepEqual(shiftWithCenter(root, "enemy", enemies[1].combatantKey), {
    fromSlot: 1,
    centerSlot: 2,
    centerKey: enemies[2].combatantKey
  });
});

test("Shift stays in the zero-priority Speed bracket under Trick Room and does not activate held-item move ordering", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const [leftKey, centerKey, rightKey] = players.map(mon => mon.combatantKey);
  setSpeed(plan, root, leftKey, 200);
  setSpeed(plan, root, centerKey, 150);
  setSpeed(plan, root, rightKey, 100);
  root.fieldState.global.trickRoomTurns = 3;
  root.combatantStates[leftKey].currentItemId = "quickclaw";
  root.combatantStates[leftKey].itemState = "held";
  const actions = ordinaryActions(players, enemies);
  actions.player = [shift(leftKey), action(centerKey, "protect"), shift(rightKey)];

  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  for (const outcome of outcomes) {
    assert.deepEqual(outcome.state.active.playerCombatantKeys, [rightKey, leftKey, centerKey]);
    assert.equal(outcome.state.combatantStates[leftKey].currentItemId, "quickclaw");
    assert.equal(outcome.state.combatantStates[leftKey].itemState, "held");
    assert.equal(outcome.events.some(event => event.eventType === "order-modifier" && event.actorKey === leftKey), false);
  }
});

test("an ally-targeted move fails when an earlier Shift makes its declared target the user", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  dataset.gameId = "volt-white-2r";
  const root = plan.stateNodes[plan.initialStateNodeId];
  const [leftKey, centerKey] = players.map(mon => mon.combatantKey);
  installMove(dataset, plan, root, centerKey, vw2rMove("acupressure", "Acupressure", { type: "normal", target: "adjacentAllyOrSelf", pp: 30 }));
  setSpeed(plan, root, leftKey, 300);
  setSpeed(plan, root, centerKey, 100);
  const actions = ordinaryActions(players, enemies);
  actions.player[0] = shift(leftKey);
  actions.player[1] = action(centerKey, "acupressure", [leftKey]);

  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  for (const outcome of outcomes) {
    assert.ok(outcome.events.some(event => event.eventType === "action-skipped" && event.actorKey === centerKey && event.reason === "no-legal-target"));
    assert.deepEqual(outcome.state.combatantStates[centerKey].statStages, root.combatantStates[centerKey].statStages);
  }
});

test("Triple Ally Switch swaps opposite edges and fails from the center", () => {
  const edge = fixtureTriplePlan();
  edge.dataset.gameId = "volt-white-2r";
  const edgeRoot = edge.plan.stateNodes[edge.plan.initialStateNodeId];
  const [leftKey, centerKey, rightKey] = edge.players.map(mon => mon.combatantKey);
  installMove(edge.dataset, edge.plan, edgeRoot, leftKey, vw2rMove("allyswitch", "Ally Switch", { type: "psychic", priority: 1, pp: 15 }));
  setSpeed(edge.plan, edgeRoot, leftKey, 500);
  const edgeActions = ordinaryActions(edge.players, edge.enemies);
  edgeActions.player[0] = action(leftKey, "allyswitch");
  const edgeOutcomes = resolveTurn({ plan: edge.plan, parentStateNodeId: edgeRoot.stateNodeId, actions: edgeActions, dataset: edge.dataset, damageAdapter: damageAdapter(() => [1]) });
  for (const outcome of edgeOutcomes) {
    assert.deepEqual(outcome.state.active.playerCombatantKeys, [rightKey, centerKey, leftKey]);
    assert.ok(outcome.events.some(event => event.eventType === "special-move-effect" && event.actorKey === leftKey && event.metadata?.handlerId === "ally-switch" && !event.metadata?.failed));
  }

  const center = fixtureTriplePlan();
  center.dataset.gameId = "volt-white-2r";
  const centerRoot = center.plan.stateNodes[center.plan.initialStateNodeId];
  const centerActorKey = center.players[1].combatantKey;
  installMove(center.dataset, center.plan, centerRoot, centerActorKey, vw2rMove("allyswitch", "Ally Switch", { type: "psychic", priority: 1, pp: 15 }));
  setSpeed(center.plan, centerRoot, centerActorKey, 500);
  const centerActions = ordinaryActions(center.players, center.enemies);
  centerActions.player[1] = action(centerActorKey, "allyswitch");
  const centerOutcomes = resolveTurn({ plan: center.plan, parentStateNodeId: centerRoot.stateNodeId, actions: centerActions, dataset: center.dataset, damageAdapter: damageAdapter(() => [1]) });
  for (const outcome of centerOutcomes) {
    assert.deepEqual(outcome.state.active.playerCombatantKeys, center.players.slice(0, 3).map(mon => mon.combatantKey));
    assert.ok(outcome.events.some(event => event.eventType === "special-move-effect" && event.actorKey === centerActorKey && event.metadata?.failed));
  }

  const faintedEdge = fixtureTriplePlan();
  faintedEdge.dataset.gameId = "volt-white-2r";
  const faintedRoot = faintedEdge.plan.stateNodes[faintedEdge.plan.initialStateNodeId];
  const faintedActorKey = faintedEdge.players[0].combatantKey;
  const oppositeEdgeKey = faintedEdge.players[2].combatantKey;
  installMove(faintedEdge.dataset, faintedEdge.plan, faintedRoot, faintedActorKey, vw2rMove("allyswitch", "Ally Switch", { type: "psychic", priority: 1, pp: 15 }));
  setExactHp(faintedRoot, oppositeEdgeKey, 0);
  setSpeed(faintedEdge.plan, faintedRoot, faintedActorKey, 500);
  const faintedActions = ordinaryActions(faintedEdge.players, faintedEdge.enemies);
  faintedActions.player = [action(faintedActorKey, "allyswitch"), faintedActions.player[1]];
  faintedActions.enemy[0].targetKeys = [faintedEdge.players[1].combatantKey];
  faintedActions.enemy[2].targetKeys = [faintedEdge.players[1].combatantKey];
  const faintedOutcomes = resolveTurn({ plan: faintedEdge.plan, parentStateNodeId: faintedRoot.stateNodeId, actions: faintedActions, dataset: faintedEdge.dataset, damageAdapter: damageAdapter(() => [1]) });
  for (const outcome of faintedOutcomes) {
    assert.equal(outcome.state.active.playerCombatantKeys[0], faintedActorKey);
    assert.ok(outcome.events.some(event => event.eventType === "special-move-effect" && event.actorKey === faintedActorKey && event.metadata?.failed));
  }
});

test("attention redirection only applies when the redirector is reachable", () => {
  for (const { redirectSlot, expectedSlot } of [
    { redirectSlot: 0, expectedSlot: 1 },
    { redirectSlot: 2, expectedSlot: 2 }
  ]) {
    const { dataset, players, enemies, plan } = fixtureTriplePlan();
    const root = plan.stateNodes[plan.initialStateNodeId];
    const actorKey = players[0].combatantKey;
    const declaredTargetKey = enemies[1].combatantKey;
    const redirectorKey = enemies[redirectSlot].combatantKey;
    root.combatantStates[redirectorKey].volatileConditions.followme = true;
    setSpeed(plan, root, actorKey, 500);
    const actions = ordinaryActions(players, enemies);
    actions.player[0] = action(actorKey, "tackle", [declaredTargetKey]);
    const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
    for (const outcome of outcomes) {
      const hit = outcome.events.find(event => event.eventType === "damage" && event.actorKey === actorKey);
      assert.equal(hit?.targetKey, enemies[expectedSlot].combatantKey);
      assert.equal(outcome.events.some(event => event.eventType === "move-redirected" && event.actorKey === actorKey), redirectSlot === 2);
    }
  }
});

test("Triple spread targets are filtered by the actor's current position", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const actions = ordinaryActions(players, enemies);
  actions.player[1] = action(players[1].combatantKey, "surf");
  const observed = [];
  resolveTurn({
    plan,
    parentStateNodeId: root.stateNodeId,
    actions,
    dataset,
    damageAdapter: damageAdapter(input => {
      if (input.move.id === "surf") observed.push({ target: input.defender.displayName, count: input.spreadTargetCount, format: input.battleFormat });
      return [1];
    })
  });
  assert.deepEqual(new Set(observed.map(entry => entry.target)), new Set(enemies.slice(0, 3).map(mon => mon.displayName)));
  assert.deepEqual(new Set(observed.map(entry => entry.count)), new Set([3]));
  assert.deepEqual(new Set(observed.map(entry => entry.format)), new Set(["triples"]));
});

test("an edge spread move reaches only its adjacent opponents", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const actorKey = players[0].combatantKey;
  installMove(dataset, plan, root, actorKey, dataset.get("moves", "surf"));
  setSpeed(plan, root, actorKey, 500);
  const actions = ordinaryActions(players, enemies);
  actions.player[0] = action(actorKey, "surf");
  const observed = [];
  resolveTurn({
    plan,
    parentStateNodeId: root.stateNodeId,
    actions,
    dataset,
    damageAdapter: damageAdapter(input => {
      if (input.move.id === "surf" && input.attacker.combatantKey === actorKey) observed.push({ key: input.defender.combatantKey, count: input.spreadTargetCount });
      return [1];
    })
  });
  assert.deepEqual(new Set(observed.map(entry => entry.key)), new Set([enemies[1].combatantKey, enemies[2].combatantKey]));
  assert.deepEqual(new Set(observed.map(entry => entry.count)), new Set([2]));
});

test("the shared damage adapter uses spread damage only when multiple execution targets remain", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const formats = [];
  const adapter = createSharedDamageAdapter({
    ready: true,
    calculate(input) {
      formats.push(input.battleFormat);
      return { status: "ok", damage: [1] };
    }
  });
  const base = {
    attacker: players[1],
    defender: enemies[1],
    attackerState: root.combatantStates[players[1].combatantKey],
    defenderState: root.combatantStates[enemies[1].combatantKey],
    move: dataset.get("moves", "surf"),
    fieldState: root.fieldState,
    battleFormat: "triples"
  };
  adapter.calculate({ ...base, spreadTargetCount: 3 });
  adapter.calculate({ ...base, spreadTargetCount: 2 });
  adapter.calculate({ ...base, spreadTargetCount: 1 });
  assert.deepEqual(formats, ["double", "double", "single"]);
});

test("the static Triple damage preview detects a lone spread target", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const actorKey = players[1].combatantKey;
  installMove(dataset, plan, root, actorKey, dataset.get("moves", "surf"));
  for (const enemy of [enemies[0], enemies[2]]) setExactHp(root, enemy.combatantKey, 0);
  const observed = [];
  const result = previewCombatantMove({
    plan,
    stateNodeId: root.stateNodeId,
    actorKey,
    targetKey: enemies[1].combatantKey,
    moveId: "surf",
    dataset,
    damageAdapter: {
      calculate(input) {
        observed.push(input.spreadTargetCount);
        return { status: "ok", label: "1.0–1.0%", minPercent: 1, maxPercent: 1, damage: [1] };
      }
    }
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(observed, [1]);
});

test("Flame Burst damages only adjacent allies of its target, including through Substitute", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  dataset.gameId = "volt-white-2r";
  const root = plan.stateNodes[plan.initialStateNodeId];
  const actorKey = players[1].combatantKey;
  const targetKey = enemies[2].combatantKey;
  const protectedAllyKey = enemies[0].combatantKey;
  const damagedAllyKey = enemies[1].combatantKey;
  installMove(dataset, plan, root, actorKey, vw2rMove("flameburst", "Flame Burst", {
    type: "fire",
    category: "special",
    basePower: 70,
    accuracy: 100,
    pp: 15,
    target: "normal"
  }));
  root.combatantStates[targetKey].volatileConditions.substituteHp = 20;
  root.combatantStates[protectedAllyKey].currentAbilityId = "magicguard";
  setSpeed(plan, root, actorKey, 500);
  const actions = ordinaryActions(players, enemies);
  actions.player[1] = action(actorKey, "flameburst", [targetKey]);

  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  for (const outcome of outcomes) {
    const collateral = outcome.events.filter(event => event.eventType === "collateral-damage" && event.metadata?.cause === "flame-burst");
    assert.deepEqual(collateral.map(event => event.targetKey), [damagedAllyKey]);
    assert.equal(collateral[0].damageHp.min, Math.max(1, Math.floor(root.combatantStates[damagedAllyKey].hp.maxHp / 16)));
    assert.equal(outcome.events.some(event => event.eventType === "substitute-damage" && event.targetKey === targetKey), true);
    assert.equal(outcome.events.some(event => event.eventType === "collateral-damage" && event.targetKey === protectedAllyKey), false);
  }
});

test("starting Intimidate from a Triple edge affects only its two adjacent opponents", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const actorKey = players[0].combatantKey;
  plan.combatants[actorKey].originalAbilityId = "intimidate";
  root.combatantStates[actorKey].currentAbilityId = "intimidate";
  plan.initialEntryEffectsVersion = 0;
  plan.resolutionEvents = {};
  root.resolutionEventIds = [];

  const upgraded = upgradeInitialEntryEffects(plan, dataset).plan;
  const events = upgraded.stateNodes[upgraded.initialStateNodeId].resolutionEventIds.map(id => upgraded.resolutionEvents[id]);
  const targets = events.filter(event => event.metadata?.cause === "intimidate" && event.eventType === "stat-stage-change").map(event => event.targetKey);
  assert.deepEqual(new Set(targets), new Set([enemies[1].combatantKey, enemies[2].combatantKey]));
  assert.equal(upgraded.stateNodes[upgraded.initialStateNodeId].combatantStates[enemies[0].combatantKey].statStages.atk, 0);
});

test("an Intimidate switch-in on a Triple edge affects only adjacent opponents", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const outgoingKey = players[0].combatantKey;
  const enteringKey = players[3].combatantKey;
  plan.combatants[enteringKey].originalAbilityId = "intimidate";
  root.combatantStates[enteringKey].currentAbilityId = "intimidate";
  const actions = ordinaryActions(players, enemies);
  actions.player[0] = {
    actionType: "switch",
    actorKey: outgoingKey,
    switchToKey: enteringKey,
    switchKind: "voluntary",
    declaredAtStateHash: "fixture"
  };

  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  for (const outcome of outcomes) {
    assert.equal(outcome.state.combatantStates[enemies[1].combatantKey].statStages.atk, -1);
    assert.equal(outcome.state.combatantStates[enemies[2].combatantKey].statStages.atk, -1);
    assert.equal(outcome.state.combatantStates[enemies[0].combatantKey].statStages.atk, 0);
  }
});

test("weather created by an edge move or entry Ability is global", () => {
  const moved = fixtureTriplePlan();
  const movedRoot = moved.plan.stateNodes[moved.plan.initialStateNodeId];
  const actorKey = moved.players[0].combatantKey;
  installMove(moved.dataset, moved.plan, movedRoot, actorKey, moved.dataset.get("moves", "raindance"));
  setSpeed(moved.plan, movedRoot, actorKey, 500);
  const moveActions = ordinaryActions(moved.players, moved.enemies);
  moveActions.player[0] = action(actorKey, "raindance");
  const seenWeather = [];
  const moveOutcomes = resolveTurn({
    plan: moved.plan,
    parentStateNodeId: movedRoot.stateNodeId,
    actions: moveActions,
    dataset: moved.dataset,
    damageAdapter: damageAdapter(input => {
      seenWeather.push(input.fieldState.global.weather?.id || null);
      return [1];
    })
  });
  assert.ok(seenWeather.length > 0);
  assert.equal(seenWeather.every(weather => weather === "rain"), true);
  assert.equal(moveOutcomes.every(outcome => outcome.state.fieldState.global.weather?.id === "rain"), true);

  const entered = fixtureTriplePlan();
  const enteredRoot = entered.plan.stateNodes[entered.plan.initialStateNodeId];
  const weatherActorKey = entered.players[0].combatantKey;
  entered.plan.combatants[weatherActorKey].originalAbilityId = "drizzle";
  enteredRoot.combatantStates[weatherActorKey].currentAbilityId = "drizzle";
  entered.plan.initialEntryEffectsVersion = 0;
  entered.plan.resolutionEvents = {};
  enteredRoot.resolutionEventIds = [];
  const upgraded = upgradeInitialEntryEffects(entered.plan, entered.dataset).plan;
  assert.equal(upgraded.stateNodes[upgraded.initialStateNodeId].fieldState.global.weather?.id, "rain");
});

test("Triple forced replacement chooses which fainted slot receives the final reserve", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const [leftKey, centerKey, rightKey, benchKey] = players.map(mon => mon.combatantKey);
  setExactHp(root, leftKey, 1);
  setExactHp(root, rightKey, 1);
  [...players.slice(0, 3), ...enemies.slice(0, 3)].forEach((combatant, index) => setSpeed(plan, root, combatant.combatantKey, combatant.side === "enemy" ? 500 - index : 100 - index));
  const actions = ordinaryActions(players, enemies);
  actions.enemy = [
    action(enemies[0].combatantKey, "tackle", [rightKey]),
    action(enemies[1].combatantKey, "tackle", [leftKey]),
    action(enemies[2].combatantKey, "tackle", [centerKey])
  ];
  const [fainted] = resolveTurn({
    plan,
    parentStateNodeId: root.stateNodeId,
    actions,
    dataset,
    damageAdapter: damageAdapter(input => input.attacker.combatantKey === enemies[0].combatantKey || input.attacker.combatantKey === enemies[1].combatantKey ? [999] : [1])
  });
  assert.deepEqual(fainted.state.pendingReplacementSlots, [{ side: "player", slot: 0 }, { side: "player", slot: 2 }]);
  assert.deepEqual(fainted.state.active.playerCombatantKeys, [leftKey, centerKey, rightKey]);
  plan.stateNodes["triple-fainted"] = { ...fainted.state, stateNodeId: "triple-fainted" };
  const replacements = { player: [{
    actionType: "replacement",
    side: "player",
    slot: 2,
    switchToKey: benchKey,
    reason: "previous-active-fainted",
    consumesTurn: false
  }] };
  const [replaced] = resolveForcedReplacement({ plan, parentStateNodeId: "triple-fainted", replacements, dataset });
  assert.deepEqual(replaced.state.active.playerCombatantKeys, [null, centerKey, benchKey]);
  assert.deepEqual(replaced.state.pendingReplacementSlots, []);
});

test("a committed Triple action group remains schema-valid with all three slot decisions", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const actions = ordinaryActions(players, enemies);
  actions.player[0] = shift(players[0].combatantKey);
  const preview = previewTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  assert.equal(preview.previewStatus, "ready");
  const committed = commitPreview(plan, preview, dataset, { selectedPreviewOutcomeId: preview.defaultPreviewOutcomeId, commitSelectedOnly: true });
  assert.equal(validatePlanDocument(committed.plan).valid, true);
  assert.equal(committed.plan.actionGroups[committed.actionGroupId].actions.player.length, 3);
  assert.equal(committed.plan.actionGroups[committed.actionGroupId].actions.enemy.length, 3);
  assert.equal(committed.plan.actionGroups[committed.actionGroupId].actions.player[0].actionType, "shift");
  const roundTrip = parsePlan(serializePlan(committed.plan));
  assert.equal(roundTrip.schemaVersion, 3);
  assert.equal(roundTrip.actionGroups[committed.actionGroupId].actions.player[0].actionType, "shift");
});

test("the final non-adjacent opponents automatically move to their center slots", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const playerKey = players[0].combatantKey;
  const enemyKey = enemies[0].combatantKey;
  root.active.playerCombatantKeys = [playerKey, null, null];
  root.active.enemyCombatantKeys = [enemyKey, null, null];
  root.active.playerCombatantKey = playerKey;
  root.active.enemyCombatantKey = enemyKey;
  for (const combatant of [...players.slice(1), ...enemies.slice(1)]) {
    root.combatantStates[combatant.combatantKey].hp = { min: 0, max: 0, maxHp: root.combatantStates[combatant.combatantKey].hp.maxHp };
    root.combatantStates[combatant.combatantKey].hpDistribution = [{ value: 0, probability: 1 }];
  }
  const actions = {
    player: [action(playerKey, "protect")],
    enemy: [action(enemyKey, "protect")]
  };
  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  for (const outcome of outcomes) {
    assert.deepEqual(outcome.state.active.playerCombatantKeys, [null, playerKey, null]);
    assert.deepEqual(outcome.state.active.enemyCombatantKeys, [null, null, enemyKey]);
    assert.equal(outcome.events.filter(event => event.eventType === "automatic-center").length, 2);
  }
});

test("six equal-speed Triple actions resolve exactly without eager factorial order expansion", () => {
  const { dataset, players, enemies, plan } = fixtureTriplePlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const active = [...players.slice(0, 3), ...enemies.slice(0, 3)];
  for (const combatant of active) {
    plan.combatants[combatant.combatantKey].calculatedStats.spe = 100;
    plan.combatants[combatant.combatantKey].moves = [{ moveId: "raindance", maxPp: 5 }];
    root.combatantStates[combatant.combatantKey].movePp.raindance = 5;
  }
  const actions = {
    player: players.slice(0, 3).map(mon => action(mon.combatantKey, "raindance")),
    enemy: enemies.slice(0, 3).map(mon => action(mon.combatantKey, "raindance"))
  };
  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome.probability, 1);
  assert.equal(outcomes[0].state.fieldState.global.weather.id, "rain");
});
