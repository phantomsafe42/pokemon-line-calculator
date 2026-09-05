import test from "node:test";
import assert from "node:assert/strict";
import { validatePlanDocument } from "../src/contracts/plan_contract.js";
import { resolveTurn, validateTurnActions } from "../src/core/resolver.js";
import { trainerBattleFormat } from "../src/adapters/standardized_dataset.js";
import { rotationFrontKey, rotationFrontSlot } from "../src/rulesets/rotation_battle.js";
import { damageAdapter, fixtureRotationPlan } from "./helpers.mjs";

const move = (actorKey, moveId, targetKey) => ({
  actionType: "move",
  actorKey,
  moveId,
  targetKeys: targetKey ? [targetKey] : [],
  mechanicActivations: [],
  declaredAtStateHash: "fixture"
});

test("Dataset Rotation flags create schema-v4 plans with three field positions and one front per side", () => {
  const { plan } = fixtureRotationPlan();
  assert.equal(trainerBattleFormat({ battleProfiles: { challenge: { format: "rotation" } } }, { trainerBattleProfile: "challenge" }), "rotation");
  assert.equal(plan.schemaVersion, 4);
  assert.equal(plan.game.battleFormat, "rotation");
  const root = plan.stateNodes[plan.initialStateNodeId];
  assert.deepEqual(root.rotation.frontSlots, { player: 0, enemy: 0 });
  assert.equal(root.active.playerCombatantKeys.length, 3);
  assert.equal(root.active.enemyCombatantKeys.length, 3);
  assert.equal(validatePlanDocument(plan).valid, true);
  const oldSchema = structuredClone(plan);
  oldSchema.schemaVersion = 3;
  assert.equal(validatePlanDocument(oldSchema).valid, false);
});

test("each side selects exactly one action and a reserve move rotates at priority +6 before attacks", () => {
  const { dataset, players, enemies, plan } = fixtureRotationPlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const actions = {
    player: [null, move(players[1].combatantKey, "tackle", enemies[0].combatantKey), null],
    enemy: [null, null, move(enemies[2].combatantKey, "tackle", players[0].combatantKey)]
  };
  assert.equal(validateTurnActions({ plan, parentState: root, actions, dataset }).ready, true);
  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [5]) });
  assert.ok(outcomes.length > 0);
  for (const outcome of outcomes) {
    assert.equal(rotationFrontSlot(outcome.state, "player"), 1);
    assert.equal(rotationFrontSlot(outcome.state, "enemy"), 2);
    assert.equal(rotationFrontKey(outcome.state, "player"), players[1].combatantKey);
    assert.equal(rotationFrontKey(outcome.state, "enemy"), enemies[2].combatantKey);
    const rotations = outcome.events.filter(event => event.eventType === "rotation");
    assert.deepEqual(rotations.map(event => [event.actorKey, event.metadata.priority]), [
      [players[1].combatantKey, 6],
      [enemies[2].combatantKey, 6]
    ]);
    assert.ok(outcome.events.some(event => event.eventType === "damage" && event.actorKey === players[1].combatantKey && event.targetKey === enemies[2].combatantKey));
    assert.ok(outcome.events.some(event => event.eventType === "damage" && event.actorKey === enemies[2].combatantKey && event.targetKey === players[1].combatantKey));
    assert.equal(outcome.events.some(event => event.eventType === "switch"), false);
  }
});

test("Rotation spread moves and residual phases affect only the two front participants", () => {
  const { dataset, players, enemies, plan } = fixtureRotationPlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  root.combatantStates[players[2].combatantKey].majorStatus = "brn";
  const inactiveHp = structuredClone(root.combatantStates[players[2].combatantKey].hp);
  const actions = {
    player: [null, move(players[1].combatantKey, "surf", enemies[0].combatantKey), null],
    enemy: [move(enemies[0].combatantKey, "tackle", players[0].combatantKey), null, null]
  };
  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [3]) });
  for (const outcome of outcomes) {
    const surfTargets = outcome.events.filter(event => event.eventType === "damage" && event.actorKey === players[1].combatantKey).map(event => event.targetKey);
    assert.deepEqual([...new Set(surfTargets)], [enemies[0].combatantKey]);
    assert.deepEqual(outcome.state.combatantStates[players[2].combatantKey].hp, inactiveHp);
    assert.equal(outcome.events.some(event => event.eventType === "residual-damage" && event.targetKey === players[2].combatantKey), false);
  }
});

test("a regular switch can replace only the current front position", () => {
  const { dataset, players, enemies, plan } = fixtureRotationPlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const illegal = {
    player: [{ actionType: "switch", actorKey: players[1].combatantKey, switchToKey: players[3].combatantKey, switchKind: "voluntary" }],
    enemy: [move(enemies[0].combatantKey, "tackle", players[0].combatantKey)]
  };
  assert.throws(() => validateTurnActions({ plan, parentState: root, actions: illegal, dataset }), /front Pokémon/);
});

test("Rotation delayed attacks and Wish follow the front position instead of an inactive card slot", () => {
  const { dataset, players, enemies, plan } = fixtureRotationPlan();
  const root = plan.stateNodes[plan.initialStateNodeId];
  const playerNext = root.combatantStates[players[1].combatantKey];
  playerNext.hp.min = playerNext.hp.max = playerNext.hp.maxHp - 20;
  root.fieldState.global.delayedAttacks = [{
    side: "enemy",
    slot: 0,
    rotationFront: true,
    sourceKey: players[0].combatantKey,
    moveId: "tackle",
    remainingTurns: 1
  }];
  root.fieldState.global.delayedHeals = [{
    side: "player",
    slot: 0,
    rotationFront: true,
    sourceKey: players[0].combatantKey,
    amount: 10,
    remainingTurns: 1
  }];
  const actions = {
    player: [null, move(players[1].combatantKey, "tackle", enemies[0].combatantKey), null],
    enemy: [null, null, move(enemies[2].combatantKey, "tackle", players[0].combatantKey)]
  };
  const outcomes = resolveTurn({ plan, parentStateNodeId: root.stateNodeId, actions, dataset, damageAdapter: damageAdapter(() => [1]) });
  for (const outcome of outcomes) {
    const delayedAttack = outcome.events.find(event => event.eventType === "delayed-attack");
    const delayedHeal = outcome.events.find(event => event.eventType === "delayed-heal");
    assert.equal(delayedAttack?.targetKey, enemies[2].combatantKey);
    assert.equal(delayedHeal?.targetKey, players[1].combatantKey);
    assert.notEqual(delayedAttack?.targetKey, enemies[0].combatantKey);
    assert.notEqual(delayedHeal?.targetKey, players[0].combatantKey);
  }
});
