import assert from "node:assert/strict";
import test from "node:test";
import { commitForcedReplacement, commitPreview, previewForcedReplacement, previewTurn, refreshUnknownCommittedProbabilities } from "../src/core/planner.js";
import { planTreeOrder } from "../src/core/graph.js";
import { createPlanDocument } from "../src/core/plan.js";
import { ResolutionError, resolveTurn } from "../src/core/resolver.js";
import { damageAdapter, fixturePlan } from "./helpers.mjs";

function move(actorKey, moveId, targetKey) {
  return { actionType: "move", actorKey, moveId, targetKeys: [targetKey], mechanicActivations: [], declaredAtStateHash: "fixture" };
}

function teach(plan, combatantKey, moveId, maxPp) {
  const combatant = plan.combatants[combatantKey];
  const state = plan.stateNodes["state-root"].combatantStates[combatantKey];
  if (!combatant.moves.some(entry => entry.moveId === moveId)) {
    if (combatant.moves.length >= 4) {
      const removed = combatant.moves.pop();
      delete state.movePp[removed.moveId];
    }
    combatant.moves.push({ moveId, maxPp });
  }
  state.movePp[moveId] = maxPp;
}

test("initial status, weather, and terrain inputs normalize into portable battle state", () => {
  const { dataset, players, enemies } = fixturePlan();
  const playerKey = players[0].combatantKey;
  const plan = createPlanDocument({
    dataset,
    trainerId: "trainer",
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: { fixture: true },
    initialConditions: {
      weather: "Rain Dance",
      terrain: { id: "Grassy Terrain", source: "map", durationMode: "permanent" },
      combatants: { [playerKey]: { majorStatus: "Badly Poisoned", toxicCounter: 3 } }
    }
  });
  const root = plan.stateNodes[plan.initialStateNodeId];
  assert.deepEqual(root.fieldState.global.weather, { id: "rain", source: "manual", durationMode: "permanent", remainingTurns: null });
  assert.deepEqual(root.fieldState.global.terrain, { id: "grassy", source: "map", durationMode: "permanent", remainingTurns: null });
  assert.equal(root.combatantStates[playerKey].majorStatus, "tox");
  assert.equal(root.combatantStates[playerKey].toxicCounter, 3);
  assert.throws(() => createPlanDocument({
    dataset,
    trainerId: "trainer",
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: { fixture: true },
    initialConditions: { weather: "Monsoon" }
  }), /unsupported weather condition/i);
});

test("priority move KOs first and the fainted opponent action is skipped", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = {
    player: move(players[0].combatantKey, "aquajet", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const outcomes = resolveTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: damageAdapter(({ attacker }) => attacker.side === "player" ? [999] : [20]) });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].state.combatantStates[enemies[0].combatantKey].hp.max, 0);
  assert.ok(outcomes[0].events.some(entry => entry.eventType === "action-skipped" && entry.reason === "actor-fainted-before-moving"));
  assert.deepEqual(outcomes[0].state.pendingReplacementSides, ["enemy"]);
});

test("a faster defense boost changes the defender state used by the slower attack", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = {
    player: move(players[0].combatantKey, "irondefense", players[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  let observedDefenseStage = null;
  const adapter = damageAdapter(input => {
    observedDefenseStage = input.defenderState.statStages.def;
    return [10];
  });
  const preview = previewTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: adapter });
  assert.equal(observedDefenseStage, 2, "the later damage calculation receives the already-applied Defense stage");
  assert.equal(preview.outcomes[0].state.combatantStates[players[0].combatantKey].statStages.def, 2);
  assert.equal(preview.outcomes[0].events[0].eventType, "stat-stage-change");
  assert.equal(preview.outcomes[0].events[0].changes[0].appliedDelta, 2);
  const committed = commitPreview(plan, preview, dataset);
  assert.equal(committed.plan.stateNodes[committed.cursorStateNodeId].displaySnapshot.player.action.resultLabel, "Defense +2");
});

test("Revenge doubles only after the current target damages the user earlier that turn", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = {
    player: move(players[0].combatantKey, "revenge", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  let revengePower = null;
  const adapter = damageAdapter(input => {
    if (input.attacker.side === "player") revengePower = input.moveOverrides?.basePower;
    return [10];
  });
  const [outcome] = resolveTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: adapter });
  assert.equal(revengePower, 120);
  const revengeDamage = outcome.events.find(entry => entry.eventType === "damage" && entry.actorKey === players[0].combatantKey);
  assert.equal(revengeDamage.metadata.powerConditionMet, true);
  assert.equal(revengeDamage.metadata.effectiveBasePower, 120);
});

test("Revenge remains at base power when the opponent switches instead of damaging the user", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = {
    player: move(players[0].combatantKey, "revenge", enemies[1].combatantKey),
    enemy: { actionType: "switch", actorKey: enemies[0].combatantKey, switchToKey: enemies[1].combatantKey, switchKind: "voluntary", declaredAtStateHash: "fixture" }
  };
  let revengePower = null;
  const adapter = damageAdapter(input => {
    revengePower = input.moveOverrides?.basePower;
    return [10];
  });
  const [outcome] = resolveTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: adapter });
  assert.equal(outcome.state.active.enemyCombatantKey, enemies[1].combatantKey);
  assert.equal(revengePower, 60);
  const revengeDamage = outcome.events.find(entry => entry.eventType === "damage");
  assert.equal(revengeDamage.metadata.powerConditionMet, false);
  assert.equal(revengeDamage.metadata.effectiveBasePower, 60);
});

test("self-healing updates an existing HP distribution before the opponent moves", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  teach(plan, players[0].combatantKey, "recover", 10);
  const playerState = plan.stateNodes["state-root"].combatantStates[players[0].combatantKey];
  const maxHp = playerState.hp.maxHp;
  const startingHp = maxHp - 100;
  playerState.hp = { min: startingHp, max: startingHp, maxHp };
  playerState.hpDistribution = [{ value: startingHp, probability: 1 }];
  const actions = {
    player: move(players[0].combatantKey, "recover", players[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const [outcome] = resolveTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: damageAdapter(() => [10]) });
  const expectedAfterRecover = Math.min(maxHp, startingHp + Math.floor(maxHp / 2));
  assert.equal(outcome.state.combatantStates[players[0].combatantKey].hp.max, expectedAfterRecover - 10);
  const heal = outcome.events.find(entry => entry.eventType === "heal");
  assert.equal(heal.metadata.requestedHp, Math.floor(maxHp / 2));
  assert.deepEqual(heal.healingHp, { min: expectedAfterRecover - startingHp, max: expectedAfterRecover - startingHp });
});

test("Protect blocks the later opposing move and repeated use branches by its Gen 5 success chance", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  teach(plan, players[0].combatantKey, "protect", 10);
  const actions = {
    player: move(players[0].combatantKey, "protect", players[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const adapter = damageAdapter(() => [10]);
  const firstPreview = previewTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: adapter });
  assert.equal(firstPreview.outcomes.length, 1);
  assert.equal(firstPreview.outcomes[0].state.combatantStates[players[0].combatantKey].hp.max, players[0].calculatedStats.hp);
  assert.ok(firstPreview.outcomes[0].events.some(entry => entry.eventType === "move-blocked"));
  const first = commitPreview(plan, firstPreview, dataset);
  assert.equal(first.plan.stateNodes[first.cursorStateNodeId].displaySnapshot.player.action.resultLabel, "Protected");

  const secondActions = {
    player: move(players[0].combatantKey, "protect", players[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const secondPreview = previewTurn({ plan: first.plan, parentStateNodeId: first.cursorStateNodeId, actions: secondActions, dataset, damageAdapter: adapter });
  assert.equal(secondPreview.outcomes.length, 2);
  assert.deepEqual(secondPreview.outcomes.map(entry => entry.outcome.probability).sort(), [0.5, 0.5]);
  assert.ok(secondPreview.outcomes.some(entry => entry.events.some(event => event.eventType === "protect" && event.metadata.success === false)));
  assert.ok(secondPreview.outcomes.some(entry => entry.events.some(event => event.eventType === "move-blocked")));
});

test("Protect fails when a higher-priority switch leaves it as the final action", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  teach(plan, players[0].combatantKey, "protect", 10);
  const actions = {
    player: move(players[0].combatantKey, "protect", players[0].combatantKey),
    enemy: { actionType: "switch", actorKey: enemies[0].combatantKey, switchToKey: enemies[1].combatantKey, switchKind: "voluntary", declaredAtStateHash: "fixture" }
  };
  const [outcome] = resolveTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: damageAdapter(() => [10]) });
  const protect = outcome.events.find(entry => entry.eventType === "protect");
  assert.equal(protect.metadata.success, false);
  assert.equal(protect.metadata.reason, "last-action");
  assert.equal(outcome.state.combatantStates[players[0].combatantKey].volatileConditions.protectStreak, 0);
});

test("paralysis applied before the target acts creates hit, miss, and full-paralysis outcomes", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  teach(plan, players[0].combatantKey, "thunderwave", 20);
  const actions = {
    player: move(players[0].combatantKey, "thunderwave", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const preview = previewTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: damageAdapter(() => [10]) });
  assert.equal(preview.outcomes.length, 3);
  const probabilities = preview.outcomes.map(entry => Number(entry.outcome.probability.toFixed(3))).sort((a, b) => a - b);
  assert.deepEqual(probabilities, [0.1, 0.225, 0.675]);
  const unable = preview.outcomes.find(entry => entry.events.some(event => event.reason === "full-paralysis"));
  assert.ok(unable);
  assert.equal(unable.state.combatantStates[enemies[0].combatantKey].majorStatus, "par");
  assert.equal(unable.state.combatantStates[enemies[0].combatantKey].movePp.tackle, 35, "full paralysis does not spend PP");
});

test("a burn applied first is present in the slower physical attack calculation", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  teach(plan, players[0].combatantKey, "willowisp", 15);
  const actions = {
    player: move(players[0].combatantKey, "willowisp", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const observedStatuses = new Set();
  const preview = previewTurn({
    plan,
    parentStateNodeId: "state-root",
    actions,
    dataset,
    damageAdapter: damageAdapter(input => { if (input.attacker.side === "enemy") observedStatuses.add(input.attackerState.majorStatus); return [10]; })
  });
  assert.ok(observedStatuses.has("brn"));
  assert.ok(observedStatuses.has(null));
  assert.ok(preview.outcomes.some(entry => entry.events.some(event => event.eventType === "residual-damage" && event.metadata.cause === "burn")));
});

test("bad poison applies escalating deterministic residual damage across committed turns", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  teach(plan, players[0].combatantKey, "toxic", 10);
  const firstActions = {
    player: move(players[0].combatantKey, "toxic", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const adapter = damageAdapter(() => [1]);
  const firstPreview = previewTurn({ plan, parentStateNodeId: "state-root", actions: firstActions, dataset, damageAdapter: adapter });
  const first = commitPreview(plan, firstPreview, dataset);
  const firstState = first.plan.stateNodes[first.cursorStateNodeId].combatantStates[enemies[0].combatantKey];
  assert.equal(firstState.majorStatus, "tox");
  assert.equal(firstState.toxicCounter, 2);
  const firstResidual = first.plan.stateNodes[first.cursorStateNodeId].resolutionEventIds
    .map(id => first.plan.resolutionEvents[id])
    .find(entry => entry.eventType === "residual-damage" && entry.metadata.cause === "bad-poison");
  assert.equal(firstResidual.damageHp.min, Math.max(1, Math.floor(firstState.hp.maxHp / 16)));

  const secondActions = {
    player: move(players[0].combatantKey, "tackle", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const second = previewTurn({ plan: first.plan, parentStateNodeId: first.cursorStateNodeId, actions: secondActions, dataset, damageAdapter: adapter });
  const secondDefault = second.outcomes.find(entry => entry.previewOutcomeId === second.defaultPreviewOutcomeId);
  assert.equal(secondDefault.state.combatantStates[enemies[0].combatantKey].toxicCounter, 3);
  const secondResidual = secondDefault.events.find(entry => entry.eventType === "residual-damage" && entry.metadata.cause === "bad-poison");
  assert.equal(secondResidual.damageHp.min, Math.max(1, Math.floor(firstState.hp.maxHp * 2 / 16)));
});

test("weather set by the first action reaches later damage and resolves duration and sand chip", () => {
  const rainFixture = fixturePlan();
  teach(rainFixture.plan, rainFixture.players[0].combatantKey, "raindance", 5);
  const rainActions = {
    player: move(rainFixture.players[0].combatantKey, "raindance", rainFixture.players[0].combatantKey),
    enemy: move(rainFixture.enemies[0].combatantKey, "tackle", rainFixture.players[0].combatantKey)
  };
  let observedWeather = null;
  const [rainOutcome] = resolveTurn({
    plan: rainFixture.plan,
    parentStateNodeId: "state-root",
    actions: rainActions,
    dataset: rainFixture.dataset,
    damageAdapter: damageAdapter(input => { observedWeather = input.fieldState.global.weather.id; return [10]; })
  });
  assert.equal(observedWeather, "rain");
  assert.equal(rainOutcome.state.fieldState.global.weather.remainingTurns, 4);

  const sandFixture = fixturePlan();
  teach(sandFixture.plan, sandFixture.players[0].combatantKey, "sandstorm", 10);
  const sandActions = {
    player: move(sandFixture.players[0].combatantKey, "sandstorm", sandFixture.players[0].combatantKey),
    enemy: move(sandFixture.enemies[0].combatantKey, "tackle", sandFixture.players[0].combatantKey)
  };
  const [sandOutcome] = resolveTurn({ plan: sandFixture.plan, parentStateNodeId: "state-root", actions: sandActions, dataset: sandFixture.dataset, damageAdapter: damageAdapter(() => [10]) });
  const sandEvents = sandOutcome.events.filter(entry => entry.eventType === "residual-damage" && entry.metadata.cause === "sand");
  assert.equal(sandEvents.length, 2);
  assert.equal(sandOutcome.state.fieldState.global.weather.remainingTurns, 4);
});

test("damage rolls crossing the KO threshold create known KO and survival branches", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = {
    player: move(players[0].combatantKey, "tackle", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const adapter = damageAdapter(({ attacker }) => attacker.side === "player" ? [999, 999, 999, ...Array(13).fill(1)] : [10]);
  const preview = previewTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: adapter });
  assert.equal(preview.outcomes.length, 2);
  const probabilities = preview.outcomes.map(entry => entry.outcome.probability).sort((a, b) => a - b);
  assert.deepEqual(probabilities, [0.1875, 0.8125]);
  const committed = commitPreview(plan, preview, dataset);
  assert.equal(committed.plan.actionGroups[committed.actionGroupId].outcomeStateNodeIds.length, 2);
  assert.equal(committed.cursorStateNodeId, committed.plan.actionGroups[committed.actionGroupId].defaultOutcomeStateNodeId);
  assert.match(committed.plan.stateNodes[committed.cursorStateNodeId].outcome.label, /survive/i);
});

test("range-only HP preserves known probability when damage guarantees the threshold result", () => {
  for (const scenario of [
    { name: "KO", damage: [105, 124], expectedHp: { min: 0, max: 0 } },
    { name: "survival", damage: [10, 12], expectedHp: { min: 67, max: 72 } }
  ]) {
    const { dataset, players, enemies, plan } = fixturePlan();
    const playerKey = players[0].combatantKey;
    const enemyKey = enemies[0].combatantKey;
    const target = plan.stateNodes[plan.initialStateNodeId].combatantStates[enemyKey];
    target.hp = { min: 79, max: 82, maxHp: target.hp.maxHp };
    delete target.hpDistribution;

    const outcomes = resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: { player: move(playerKey, "tackle", enemyKey), enemy: move(enemyKey, "tackle", playerKey) },
      dataset,
      damageAdapter: damageAdapter(({ attacker }) => attacker.combatantKey === playerKey ? scenario.damage : [0])
    });

    assert.equal(outcomes.length, 1, `${scenario.name} is the only possible threshold result`);
    assert.equal(outcomes[0].outcome.probability, 1, `${scenario.name} keeps the incoming known probability`);
    assert.notEqual(outcomes[0].outcome.probabilityStatus, "unknown");
    assert.deepEqual(
      { min: outcomes[0].state.combatantStates[enemyKey].hp.min, max: outcomes[0].state.combatantStates[enemyKey].hp.max },
      scenario.expectedHp
    );
  }
});

test("range-only HP remains unknown when damage can cross the KO threshold", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const playerKey = players[0].combatantKey;
  const enemyKey = enemies[0].combatantKey;
  const target = plan.stateNodes[plan.initialStateNodeId].combatantStates[enemyKey];
  target.hp = { min: 79, max: 82, maxHp: target.hp.maxHp };
  delete target.hpDistribution;

  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: move(playerKey, "tackle", enemyKey), enemy: move(enemyKey, "tackle", playerKey) },
    dataset,
    damageAdapter: damageAdapter(({ attacker }) => attacker.combatantKey === playerKey ? [80] : [0])
  });

  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every(outcome => outcome.outcome.probability === null));
  assert.ok(outcomes.every(outcome => outcome.outcome.probabilityStatus === "unknown"));
});

test("Focus Sash consumes at full HP and leaves the holder at exactly 1 HP", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const playerKey = players[0].combatantKey;
  const enemyKey = enemies[0].combatantKey;
  const root = plan.stateNodes[plan.initialStateNodeId];
  const target = root.combatantStates[enemyKey];
  target.currentItemId = "focussash";
  target.itemState = "held";
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: move(playerKey, "tackle", enemyKey), enemy: move(enemyKey, "tackle", playerKey) },
    dataset,
    damageAdapter: damageAdapter(({ attacker }) => attacker.combatantKey === playerKey ? [999] : [0])
  });

  assert.equal(outcomes.length, 1);
  const [outcome] = outcomes;
  assert.deepEqual(outcome.state.combatantStates[enemyKey].hp, { min: 1, max: 1, maxHp: target.hp.maxHp });
  assert.equal(outcome.state.combatantStates[enemyKey].currentItemId, "");
  assert.equal(outcome.state.combatantStates[enemyKey].itemState, "consumed");
  const sashIndex = outcome.events.findIndex(entry => entry.eventType === "item-consumed" && entry.metadata?.itemId === "focussash");
  const damageIndex = outcome.events.findIndex(entry => entry.eventType === "damage" && entry.actorKey === playerKey && entry.targetKey === enemyKey);
  assert.ok(sashIndex >= 0 && sashIndex < damageIndex, "Focus Sash resolves before the damage event");
  assert.equal(outcome.events[damageIndex].metadata.thresholdOutcome, "survive");
  assert.equal(outcome.events[damageIndex].metadata.focusSashActivated, true);
});

test("Focus Sash does not activate below full HP or while its effects are suppressed", () => {
  const scenarios = [
    { name: "damaged", prepare: state => { state.hp.max -= 1; state.hp.min -= 1; state.hpDistribution = [{ value: state.hp.max, probability: 1 }]; } },
    { name: "Magic Room", prepare: (_state, root) => { root.fieldState.global.magicRoomTurns = 3; } },
    { name: "Embargo", prepare: state => { state.volatileConditions.embargoTurns = 3; } },
    { name: "Klutz", prepare: state => { state.currentAbilityId = "klutz"; } }
  ];
  for (const scenario of scenarios) {
    const { dataset, players, enemies, plan } = fixturePlan();
    const playerKey = players[0].combatantKey;
    const enemyKey = enemies[0].combatantKey;
    const root = plan.stateNodes[plan.initialStateNodeId];
    const target = root.combatantStates[enemyKey];
    target.currentItemId = "focussash";
    target.itemState = "held";
    scenario.prepare(target, root);
    const outcomes = resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: { player: move(playerKey, "tackle", enemyKey), enemy: move(enemyKey, "tackle", playerKey) },
      dataset,
      damageAdapter: damageAdapter(({ attacker }) => attacker.combatantKey === playerKey ? [999] : [0])
    });
    assert.ok(outcomes.every(outcome => outcome.state.combatantStates[enemyKey].hp.max === 0), `${scenario.name} must not activate Focus Sash`);
    assert.ok(outcomes.every(outcome => outcome.state.combatantStates[enemyKey].itemState === "held"), `${scenario.name} leaves the unused item held`);
    assert.ok(outcomes.every(outcome => !outcome.events.some(entry => entry.metadata?.itemId === "focussash")), `${scenario.name} emits no Focus Sash event`);
  }
});

test("Focus Sash branches correctly when only part of an HP distribution is at full health", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const playerKey = players[0].combatantKey;
  const enemyKey = enemies[0].combatantKey;
  const target = plan.stateNodes[plan.initialStateNodeId].combatantStates[enemyKey];
  const maxHp = target.hp.maxHp;
  target.hp = { min: maxHp - 1, max: maxHp, maxHp };
  target.hpDistribution = [{ value: maxHp - 1, probability: 0.5 }, { value: maxHp, probability: 0.5 }];
  target.currentItemId = "focussash";
  target.itemState = "held";
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: move(playerKey, "tackle", enemyKey), enemy: move(enemyKey, "tackle", playerKey) },
    dataset,
    damageAdapter: damageAdapter(({ attacker }) => attacker.combatantKey === playerKey ? [999] : [0])
  });
  const sash = outcomes.find(outcome => outcome.events.some(entry => entry.metadata?.itemId === "focussash"));
  const fainted = outcomes.find(outcome => outcome.state.combatantStates[enemyKey].hp.max === 0);
  assert.equal(sash?.outcome.probability, 0.5);
  assert.equal(sash?.state.combatantStates[enemyKey].hp.max, 1);
  assert.equal(fainted?.outcome.probability, 0.5);
  assert.equal(fainted?.state.combatantStates[enemyKey].itemState, "held");
});

test("Focus Sash does not prevent move-independent residual damage", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const playerKey = players[0].combatantKey;
  const enemyKey = enemies[0].combatantKey;
  const target = plan.stateNodes[plan.initialStateNodeId].combatantStates[playerKey];
  target.hp = { min: 1, max: 1, maxHp: 1 };
  target.hpDistribution = [{ value: 1, probability: 1 }];
  target.majorStatus = "psn";
  target.currentItemId = "focussash";
  target.itemState = "held";
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: move(playerKey, "irondefense", playerKey), enemy: move(enemyKey, "tackle", playerKey) },
    dataset,
    damageAdapter: damageAdapter(() => [0])
  });
  assert.ok(outcomes.every(outcome => outcome.state.combatantStates[playerKey].hp.max === 0));
  assert.ok(outcomes.every(outcome => outcome.state.combatantStates[playerKey].itemState === "held"));
  assert.ok(outcomes.every(outcome => !outcome.events.some(entry => entry.metadata?.itemId === "focussash")));
});

test("crafted outcome commit adds only the user-selected resolver result", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = {
    player: move(players[0].combatantKey, "tackle", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const preview = previewTurn({
    plan,
    parentStateNodeId: "state-root",
    actions,
    dataset,
    damageAdapter: damageAdapter(({ attacker }) => attacker.side === "player" ? [999, ...Array(15).fill(1)] : [1])
  });
  const selected = preview.outcomes.find(entry => entry.events.some(event => event.eventType === "damage" && event.metadata?.thresholdOutcome === "ko"));
  const committed = commitPreview(plan, preview, dataset, { selectedPreviewOutcomeId: selected.previewOutcomeId, commitSelectedOnly: true });
  const group = committed.plan.actionGroups[committed.actionGroupId];
  assert.equal(group.outcomeStateNodeIds.length, 1);
  assert.equal(committed.cursorStateNodeId, group.outcomeStateNodeIds[0]);
  assert.match(committed.plan.stateNodes[committed.cursorStateNodeId].outcome.label, /faints/i);

  const expanded = previewTurn({
    plan: committed.plan,
    parentStateNodeId: "state-root",
    actions,
    dataset,
    damageAdapter: damageAdapter(({ attacker }) => attacker.side === "player" ? [999, ...Array(15).fill(1)] : [1]),
    expandExisting: true
  });
  assert.equal(expanded.previewStatus, "existing-expanded");
  assert.equal(expanded.savedPreviewOutcomeIds.length, 1);
  assert.equal(expanded.savedOutcomeStateNodeIdByPreviewOutcomeId[expanded.savedPreviewOutcomeIds[0]], committed.cursorStateNodeId);
  const alternate = expanded.outcomes.find(entry => !expanded.savedPreviewOutcomeIds.includes(entry.previewOutcomeId));
  const appended = commitPreview(committed.plan, expanded, dataset, { selectedPreviewOutcomeId: alternate.previewOutcomeId, commitSelectedOnly: true });
  assert.equal(appended.outcomeAdded, true);
  assert.equal(appended.plan.actionGroups[appended.actionGroupId].outcomeStateNodeIds.length, 2);
});

test("reviewing an existing action group rehydrates every saved resolution event", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = {
    player: move(players[0].combatantKey, "tackle", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const adapter = damageAdapter(() => [10]);
  const fresh = previewTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: adapter });
  const committed = commitPreview(plan, fresh, dataset);
  const existing = previewTurn({ plan: committed.plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: adapter });
  assert.equal(existing.previewStatus, "existing");
  for (const outcome of existing.outcomes) {
    assert.deepEqual(outcome.events.map(event => event.eventId), outcome.resolutionEventIds);
    assert.ok(outcome.events.some(event => event.actorKey === players[0].combatantKey));
    assert.ok(outcome.events.some(event => event.actorKey === enemies[0].combatantKey));
  }
});

test("a fresh resolver preview repairs stale unknown graph probability metadata without replacing the node", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = {
    player: move(players[0].combatantKey, "tackle", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const adapter = damageAdapter(({ attacker }) => attacker.side === "player" ? [8, 9, 10, 11] : [4]);
  const fresh = previewTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: adapter });
  const committed = commitPreview(plan, fresh, dataset, { commitSelectedOnly: true });
  const stalePlan = structuredClone(committed.plan);
  const staleState = stalePlan.stateNodes[committed.cursorStateNodeId];
  const originalStateHash = staleState.stateHash;
  const originalEventIds = [...staleState.resolutionEventIds];
  staleState.outcome.probability = null;
  staleState.outcome.probabilityStatus = "unknown";

  const expanded = previewTurn({
    plan: stalePlan,
    parentStateNodeId: "state-root",
    actions,
    dataset,
    damageAdapter: adapter,
    expandExisting: true
  });
  const repaired = refreshUnknownCommittedProbabilities(stalePlan, expanded);
  const repairedState = repaired.plan.stateNodes[committed.cursorStateNodeId];
  const matchingPreview = expanded.outcomes.find(outcome => outcome.state.stateHash === originalStateHash);

  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.refreshedStateNodeIds, [committed.cursorStateNodeId]);
  assert.equal(repairedState.outcome.probability, matchingPreview.outcome.probability);
  assert.equal(repairedState.outcome.probabilityStatus, matchingPreview.outcome.probabilityStatus);
  assert.equal(repairedState.stateHash, originalStateHash);
  assert.deepEqual(repairedState.resolutionEventIds, originalEventIds);
  assert.deepEqual(repairedState.childActionGroupIds, staleState.childActionGroupIds);
  assert.deepEqual(repaired.plan.actionGroups, stalePlan.actionGroups);
});

test("probability repair can match a stable resolver state after event presentation semantics improve", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = {
    player: move(players[0].combatantKey, "tackle", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  const adapter = damageAdapter(() => [5]);
  const fresh = previewTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: adapter });
  const committed = commitPreview(plan, fresh, dataset, { commitSelectedOnly: true });
  const stalePlan = structuredClone(committed.plan);
  const staleState = stalePlan.stateNodes[committed.cursorStateNodeId];
  const firstEvent = stalePlan.resolutionEvents[staleState.resolutionEventIds[0]];
  firstEvent.eventType = "move-immune";
  firstEvent.reason = "legacy-presentation";
  staleState.outcome.probability = null;
  staleState.outcome.probabilityStatus = "unknown";

  const expanded = previewTurn({ plan: stalePlan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: adapter, expandExisting: true });
  const repaired = refreshUnknownCommittedProbabilities(stalePlan, expanded);

  assert.equal(repaired.changed, true);
  assert.equal(repaired.plan.stateNodes[committed.cursorStateNodeId].outcome.probability, 1);
  assert.equal(repaired.plan.resolutionEvents[firstEvent.eventId].eventType, "move-immune", "probability repair does not rewrite historical events");
});

test("voluntary switch happens before an opposing move and the switch-in takes damage", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const actions = {
    player: { actionType: "switch", actorKey: players[0].combatantKey, switchToKey: players[1].combatantKey, switchKind: "voluntary", declaredAtStateHash: "fixture" },
    enemy: move(enemies[0].combatantKey, "tackle", players[1].combatantKey)
  };
  const [outcome] = resolveTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: damageAdapter(() => [25]) });
  assert.equal(outcome.state.active.playerCombatantKey, players[1].combatantKey);
  assert.equal(outcome.state.combatantStates[players[1].combatantKey].hp.max, players[1].calculatedStats.hp - 25);
  assert.equal(outcome.state.combatantStates[players[0].combatantKey].hp.max, players[0].calculatedStats.hp);
});

test("Download activates once when switching in during a turn", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  plan.combatants[players[1].combatantKey].originalAbilityId = "download";
  plan.combatants[enemies[0].combatantKey].calculatedStats.def = 80;
  plan.combatants[enemies[0].combatantKey].calculatedStats.spd = 120;
  const actions = {
    player: { actionType: "switch", actorKey: players[0].combatantKey, switchToKey: players[1].combatantKey, switchKind: "voluntary", declaredAtStateHash: "fixture" },
    enemy: move(enemies[0].combatantKey, "tackle", players[1].combatantKey)
  };
  const [outcome] = resolveTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: damageAdapter(() => [25]) });
  assert.equal(outcome.state.combatantStates[players[1].combatantKey].statStages.atk, 1);
  assert.equal(outcome.events.filter(event => event.actorKey === players[1].combatantKey && event.metadata?.cause === "download").length, 1);
});

test("forced replacement is folded into the following visible turn node", () => {
  const { plan, dataset, players, enemies } = fixturePlan();
  const adapter = damageAdapter(({ attacker }) => attacker.side === "player" ? [999] : [10]);
  const firstPreview = previewTurn({
    plan,
    parentStateNodeId: "state-root",
    actions: {
      player: move(players[0].combatantKey, "aquajet", enemies[0].combatantKey),
      enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
    },
    dataset,
    damageAdapter: adapter
  });
  const turnOne = commitPreview(plan, firstPreview, dataset);
  const replacementAction = {
    actionType: "replacement",
    side: "enemy",
    switchToKey: enemies[1].combatantKey,
    reason: "previous-active-fainted",
    consumesTurn: false
  };
  const replacementPreview = previewForcedReplacement({
    plan: turnOne.plan,
    parentStateNodeId: turnOne.cursorStateNodeId,
    replacements: { enemy: replacementAction },
    dataset
  });
  const replaced = commitForcedReplacement(turnOne.plan, replacementPreview, dataset);
  const state = replaced.plan.stateNodes[replaced.cursorStateNodeId];
  assert.equal(state.turnNumber, 1);
  assert.equal(state.transitionKind, "replacement");
  assert.deepEqual(state.pendingReplacementSides, []);
  assert.equal(state.active.enemyCombatantKey, enemies[1].combatantKey);
  const next = previewTurn({
    plan: replaced.plan,
    parentStateNodeId: replaced.cursorStateNodeId,
    actions: {
      player: move(players[0].combatantKey, "tackle", enemies[1].combatantKey),
      enemy: move(enemies[1].combatantKey, "tackle", players[0].combatantKey)
    },
    dataset,
    damageAdapter: damageAdapter(() => [10])
  });
  assert.equal(next.proposedTurnNumber, 2);
  assert.ok(next.outcomes.every(outcome => outcome.events.some(event => event.eventType === "switch" && event.metadata?.phase === "start-of-turn-replacement")));
  const turnTwo = commitPreview(replaced.plan, next, dataset, { commitSelectedOnly: true });
  const turnTwoState = turnTwo.plan.stateNodes[turnTwo.cursorStateNodeId];
  assert.equal(turnTwoState.transitionKind, undefined);
  const visible = planTreeOrder(turnTwo.plan, { includeReplacementStates: false }).map(entry => entry.state.stateNodeId);
  assert.equal(visible.includes(replaced.cursorStateNodeId), false);
  assert.equal(visible.includes(turnTwo.cursorStateNodeId), true);
  const events = turnTwoState.resolutionEventIds.map(id => turnTwo.plan.resolutionEvents[id]);
  const replacementEvent = events.find(event => event.eventType === "switch" && event.metadata?.phase === "start-of-turn-replacement");
  assert.ok(replacementEvent);
  assert.equal(replacementEvent.turnNumber, 2);
  assert.equal(replacementEvent.step, 1);
});

test("moves without a structured resolver effect fail closed", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  players[0].moves.push({ moveId: "crunch", maxPp: 15 });
  plan.combatants[players[0].combatantKey].moves.push({ moveId: "crunch", maxPp: 15 });
  plan.stateNodes["state-root"].combatantStates[players[0].combatantKey].movePp.crunch = 15;
  const actions = {
    player: move(players[0].combatantKey, "crunch", enemies[0].combatantKey),
    enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey)
  };
  assert.throws(() => resolveTurn({ plan, parentStateNodeId: "state-root", actions, dataset, damageAdapter: damageAdapter(() => [10]) }), ResolutionError);
});

test("adding a second decision from an earlier node preserves the first branch", () => {
  const { dataset, players, enemies, plan } = fixturePlan();
  const adapter = damageAdapter(() => [10]);
  const firstActions = { player: move(players[0].combatantKey, "tackle", enemies[0].combatantKey), enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey) };
  const first = commitPreview(plan, previewTurn({ plan, parentStateNodeId: "state-root", actions: firstActions, dataset, damageAdapter: adapter }), dataset);
  const switchActions = { player: { actionType: "switch", actorKey: players[0].combatantKey, switchToKey: players[1].combatantKey, switchKind: "voluntary", declaredAtStateHash: "fixture" }, enemy: move(enemies[0].combatantKey, "tackle", players[1].combatantKey) };
  const second = commitPreview(first.plan, previewTurn({ plan: first.plan, parentStateNodeId: "state-root", actions: switchActions, dataset, damageAdapter: adapter }), dataset);
  assert.equal(second.plan.stateNodes["state-root"].childActionGroupIds.length, 2);
  assert.ok(second.plan.actionGroups[first.actionGroupId]);
  assert.ok(second.plan.actionGroups[second.actionGroupId]);
});
