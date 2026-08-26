import assert from "node:assert/strict";
import test from "node:test";
import { createBranchEventModel } from "../src/core/branch_events.js";
import { resolveTurn } from "../src/core/resolver.js";
import { effectiveActionSpeed } from "../src/rulesets/action_order.js";
import { damageAdapter, fixturePlan } from "./helpers.mjs";

function move(actorKey, moveId, targetKey) {
  return { actionType: "move", actorKey, moveId, targetKeys: [targetKey], mechanicActivations: [], declaredAtStateHash: "fixture" };
}

const lethalAdapter = () => damageAdapter(() => [999]);

test("Prankster raises status priority and Trick Room only reverses Speed", () => {
  const first = fixturePlan();
  const playerKey = first.players[0].combatantKey;
  const enemyKey = first.enemies[0].combatantKey;
  const root = first.plan.stateNodes[first.plan.initialStateNodeId];
  root.combatantStates[playerKey].currentAbilityId = "prankster";
  root.combatantStates[playerKey].currentStats = { ...first.players[0].calculatedStats, spe: 1 };
  root.combatantStates[enemyKey].currentStats = { ...first.enemies[0].calculatedStats, spe: 999 };
  const actions = { player: move(playerKey, "irondefense", playerKey), enemy: move(enemyKey, "tackle", playerKey) };
  const [prankster] = resolveTurn({ plan: first.plan, parentStateNodeId: first.plan.initialStateNodeId, actions, dataset: first.dataset, damageAdapter: damageAdapter(() => [10]) });
  assert.equal(prankster.events.find(event => ["stat-stage-change", "damage"].includes(event.eventType))?.eventType, "stat-stage-change");

  const second = fixturePlan();
  const fastKey = second.players[0].combatantKey;
  const slowKey = second.enemies[0].combatantKey;
  second.plan.stateNodes[second.plan.initialStateNodeId].fieldState.global.trickRoomTurns = 3;
  const normalPriority = { player: move(fastKey, "tackle", slowKey), enemy: move(slowKey, "tackle", fastKey) };
  const [trickRoom] = resolveTurn({ plan: second.plan, parentStateNodeId: second.plan.initialStateNodeId, actions: normalPriority, dataset: second.dataset, damageAdapter: lethalAdapter() });
  assert.equal(trickRoom.state.combatantStates[fastKey].hp.max, 0, "the slower enemy moved first inside Trick Room");
  const priorityMove = { player: move(fastKey, "aquajet", slowKey), enemy: move(slowKey, "tackle", fastKey) };
  const [priorityInTrickRoom] = resolveTurn({ plan: second.plan, parentStateNodeId: second.plan.initialStateNodeId, actions: priorityMove, dataset: second.dataset, damageAdapter: lethalAdapter() });
  assert.equal(priorityInTrickRoom.state.combatantStates[slowKey].hp.max, 0, "Trick Room did not reverse priority brackets");
});

test("Quick Claw creates selectable 20/80 action-order branches", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const playerKey = players[0].combatantKey;
  const enemyKey = enemies[0].combatantKey;
  const root = plan.stateNodes[plan.initialStateNodeId];
  root.combatantStates[playerKey].currentStats = { ...players[0].calculatedStats, spe: 1 };
  root.combatantStates[enemyKey].currentStats = { ...enemies[0].calculatedStats, spe: 999 };
  root.combatantStates[playerKey].currentItemId = "quickclaw";
  root.combatantStates[playerKey].itemState = "held";
  const actions = { player: move(playerKey, "tackle", enemyKey), enemy: move(enemyKey, "tackle", playerKey) };
  const outcomes = resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, actions, dataset, damageAdapter: lethalAdapter() });
  assert.equal(outcomes.length, 2);
  const activated = outcomes.find(outcome => outcome.events.some(event => event.eventType === "order-modifier" && event.metadata.activated));
  const inactive = outcomes.find(outcome => outcome.events.some(event => event.eventType === "order-modifier" && !event.metadata.activated));
  assert.equal(activated.outcome.probability, 0.2);
  assert.equal(inactive.outcome.probability, 0.8);
  assert.equal(activated.state.combatantStates[enemyKey].hp.max, 0);
  assert.equal(inactive.state.combatantStates[playerKey].hp.max, 0);
  const model = createBranchEventModel({ outcomes, actions, defaultOutcomeId: inactive.previewOutcomeId });
  const quickClaw = model.dimensions.find(dimension => dimension.kind === "order-modifier");
  assert.deepEqual(quickClaw.options.map(option => option.id).sort(), ["activated", "not-activated"]);
});

test("Custap consumes at its threshold while Stall and late items move last within a bracket", () => {
  const custap = fixturePlan();
  const playerKey = custap.players[0].combatantKey;
  const enemyKey = custap.enemies[0].combatantKey;
  const root = custap.plan.stateNodes[custap.plan.initialStateNodeId];
  root.combatantStates[playerKey].currentStats = { ...custap.players[0].calculatedStats, spe: 1 };
  root.combatantStates[enemyKey].currentStats = { ...custap.enemies[0].calculatedStats, spe: 999 };
  root.combatantStates[playerKey].currentItemId = "custapberry";
  root.combatantStates[playerKey].itemState = "held";
  root.combatantStates[playerKey].hp = { min: 1, max: 1, maxHp: root.combatantStates[playerKey].hp.maxHp };
  root.combatantStates[playerKey].hpDistribution = [{ value: 1, probability: 1 }];
  const actions = { player: move(playerKey, "tackle", enemyKey), enemy: move(enemyKey, "tackle", playerKey) };
  const [outcome] = resolveTurn({ plan: custap.plan, parentStateNodeId: custap.plan.initialStateNodeId, actions, dataset: custap.dataset, damageAdapter: lethalAdapter() });
  assert.equal(outcome.state.combatantStates[enemyKey].hp.max, 0);
  assert.equal(outcome.state.combatantStates[playerKey].itemState, "consumed");
  assert.ok(outcome.events.some(event => event.eventType === "order-modifier" && event.metadata.modifierId === "custapberry"));

  for (const prepare of [
    state => { state.currentAbilityId = "stall"; },
    state => { state.currentItemId = "laggingtail"; state.itemState = "held"; },
    state => { state.currentItemId = "fullincense"; state.itemState = "held"; }
  ]) {
    const fixture = fixturePlan();
    const fastKey = fixture.players[0].combatantKey;
    const slowKey = fixture.enemies[0].combatantKey;
    prepare(fixture.plan.stateNodes[fixture.plan.initialStateNodeId].combatantStates[fastKey]);
    const [late] = resolveTurn({ plan: fixture.plan, parentStateNodeId: fixture.plan.initialStateNodeId, actions: { player: move(fastKey, "tackle", slowKey), enemy: move(slowKey, "tackle", fastKey) }, dataset: fixture.dataset, damageAdapter: lethalAdapter() });
    assert.equal(late.state.combatantStates[fastKey].hp.max, 0);
  }
});

test("effective Speed includes Gen 5 status, weather, side, ability, and item modifiers", () => {
  const { players, plan } = fixturePlan();
  const combatant = players[0];
  const state = plan.stateNodes[plan.initialStateNodeId];
  const monState = state.combatantStates[combatant.combatantKey];
  const baseSpeed = Number(combatant.calculatedStats.spe);
  const speed = overrides => effectiveActionSpeed({ combatant, combatantState: { ...monState, ...overrides }, battleState: state, side: "player", generation: 5 });
  assert.equal(speed({ statStages: { ...monState.statStages, spe: 2 } }), baseSpeed * 2);
  assert.equal(speed({ majorStatus: "par" }), Math.floor(baseSpeed * 0.25));
  assert.equal(speed({ majorStatus: "par", currentAbilityId: "quickfeet" }), Math.floor(baseSpeed * 1.5));
  assert.equal(speed({ currentItemId: "choicescarf", itemState: "held" }), Math.floor(baseSpeed * 1.5));
  assert.equal(speed({ currentItemId: "ironball", itemState: "held" }), Math.floor(baseSpeed * 0.5));
  state.fieldState.global.weather = { id: "sun", source: "manual", durationMode: "permanent", remainingTurns: null };
  assert.equal(speed({ currentAbilityId: "chlorophyll" }), baseSpeed * 2);
  state.fieldState.sides.player.tailwindTurns = 2;
  assert.equal(speed({ currentAbilityId: "pressure" }), baseSpeed * 2);
  assert.equal(speed({ currentAbilityId: "slowstart", enteredTurnNumber: 0 }), baseSpeed);
  assert.equal(speed({ currentAbilityId: "unburden", itemState: "consumed", lastItemId: "sitrusberry" }), baseSpeed * 4);
});
