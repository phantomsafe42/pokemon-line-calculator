import assert from "node:assert/strict";
import test from "node:test";
import { updateStateHash } from "../src/core/plan.js";
import { resolveTurn } from "../src/core/resolver.js";
import {
  applyDefeatedEnemyExperience,
  experienceForLevel,
  experienceToNextLevel,
  levelFromExperience,
  projectVw2rExperience,
  registerSwitchExperienceParticipation
} from "../src/rulesets/vw2r_experience.js";
import { damageAdapter, fixtureDoublesPlan, fixturePlan } from "./helpers.mjs";

function enableExperience(plan, players, enemies) {
  plan.game.gameId = "volt-white-2r";
  for (const player of players) {
    const planned = plan.combatants[player.combatantKey];
    planned.growthRate = "Medium Fast";
    planned.experience = experienceForLevel(planned.level, planned.growthRate);
    player.growthRate = planned.growthRate;
    player.experience = planned.experience;
    const state = plan.stateNodes[plan.initialStateNodeId].combatantStates[player.combatantKey];
    state.experience = planned.experience;
  }
  for (const enemy of enemies) {
    plan.combatants[enemy.combatantKey].baseExperienceYield = 100;
    enemy.baseExperienceYield = 100;
  }
  const root = plan.stateNodes[plan.initialStateNodeId];
  root.experienceState = {
    participantsByEnemyKey: Object.fromEntries(root.active.enemyCombatantKeys.map(enemyKey => [enemyKey, [...root.active.playerCombatantKeys]])),
    rewardedEnemyKeys: []
  };
  updateStateHash(root);
  return root;
}

function move(actorKey, moveId, targetKey, stateHash) {
  return { actionType: "move", actorKey, moveId, targetKeys: [targetKey], mechanicActivations: [], declaredAtStateHash: stateHash };
}

test("all six growth curves expose exact level thresholds and to-next values", () => {
  const expectedAt50 = {
    "Medium Fast": 125000,
    Erratic: 125000,
    Fluctuating: 142500,
    "Medium Slow": 117360,
    Fast: 100000,
    Slow: 156250
  };
  for (const [growthRate, experience] of Object.entries(expectedAt50)) {
    assert.equal(experienceForLevel(1, growthRate), 0);
    assert.equal(experienceForLevel(50, growthRate), experience);
    assert.equal(levelFromExperience(experience, growthRate), 50);
    assert.equal(experienceToNextLevel(experience, growthRate, 50), experienceForLevel(51, growthRate) - experience);
  }
});

test("VW2R Gen 5 trainer EXP applies exact split, Exp. Share, and Lucky Egg rounding", () => {
  const { plan, players, enemies } = fixturePlan();
  const root = enableExperience(plan, players, enemies);
  let projection = projectVw2rExperience(plan, root, enemies[0].combatantKey);
  assert.deepEqual(projection.rewards.map(entry => [entry.combatantKey, entry.amount]), [[players[0].combatantKey, 1501]]);

  root.combatantStates[players[1].combatantKey].currentItemId = "expshare";
  projection = projectVw2rExperience(plan, root, enemies[0].combatantKey);
  assert.deepEqual(projection.rewards.map(entry => [entry.combatantKey, entry.amount, entry.participant, entry.expShare]), [
    [players[0].combatantKey, 751, true, false],
    [players[1].combatantKey, 751, false, true]
  ]);

  root.experienceState.participantsByEnemyKey[enemies[0].combatantKey].push(players[1].combatantKey);
  projection = projectVw2rExperience(plan, root, enemies[0].combatantKey);
  assert.deepEqual(projection.rewards.map(entry => [entry.combatantKey, entry.amount]), [
    [players[0].combatantKey, 376],
    [players[1].combatantKey, 1126]
  ]);

  root.combatantStates[players[1].combatantKey].currentItemId = null;
  root.experienceState.participantsByEnemyKey[enemies[0].combatantKey] = [players[0].combatantKey];
  root.combatantStates[players[0].combatantKey].currentItemId = "luckyegg";
  projection = projectVw2rExperience(plan, root, enemies[0].combatantKey);
  assert.equal(projection.rewards[0].amount, 2251);
  assert.equal(projection.rewards[0].luckyEgg, true);
});

test("switch participation persists on the benched Pokémon and both participants receive the later payout", () => {
  const { dataset, plan, players, enemies } = fixturePlan();
  let state = enableExperience(plan, players, enemies);
  const turnOne = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: {
      player: { actionType: "switch", actorKey: players[0].combatantKey, switchToKey: players[1].combatantKey, switchKind: "voluntary", declaredAtStateHash: state.stateHash },
      enemy: move(enemies[0].combatantKey, "tackle", players[0].combatantKey, state.stateHash)
    },
    dataset,
    damageAdapter: damageAdapter(() => [0])
  })[0];
  state = turnOne.state;
  assert.deepEqual(state.experienceState.participantsByEnemyKey[enemies[0].combatantKey], [players[0].combatantKey, players[1].combatantKey]);

  plan.stateNodes.switchResult = { ...state, stateNodeId: "switchResult" };
  const turnTwo = resolveTurn({
    plan,
    parentStateNodeId: "switchResult",
    actions: {
      player: move(players[1].combatantKey, "tackle", enemies[0].combatantKey, state.stateHash),
      enemy: move(enemies[0].combatantKey, "tackle", players[1].combatantKey, state.stateHash)
    },
    dataset,
    damageAdapter: damageAdapter(({ attacker }) => attacker.side === "player" ? [9999] : [0])
  })[0];
  const rewards = turnTwo.events.filter(entry => entry.eventType === "experience-gain");
  assert.equal(rewards.length, 2);
  assert.deepEqual(new Set(rewards.map(entry => entry.targetKey)), new Set(players.map(entry => entry.combatantKey)));
  assert.ok(turnTwo.state.combatantStates[players[0].combatantKey].experience > players[0].experience);
  assert.ok(turnTwo.state.combatantStates[players[1].combatantKey].experience > players[1].experience);
});

test("a payout levels the recipient, raises current stats and HP, and cannot be awarded twice", () => {
  const { dataset, plan, players, enemies } = fixturePlan();
  const root = enableExperience(plan, players, enemies);
  const playerKey = players[0].combatantKey;
  const enemyKey = enemies[0].combatantKey;
  const nextThreshold = experienceForLevel(51, "Medium Fast");
  root.combatantStates[playerKey].experience = nextThreshold - 100;
  root.combatantStates[enemyKey].hp = { min: 0, max: 0, maxHp: root.combatantStates[enemyKey].hp.maxHp };
  const previousHp = root.combatantStates[playerKey].hp.maxHp;
  const branch = { state: structuredClone(root), events: [] };
  applyDefeatedEnemyExperience(branch, plan, dataset);
  const reward = branch.events.find(entry => entry.eventType === "experience-gain");
  assert.ok(reward);
  assert.equal(reward.metadata.levelUp, true);
  assert.equal(branch.state.combatantStates[playerKey].currentLevel, 51);
  assert.ok(branch.state.combatantStates[playerKey].currentStats.hp > previousHp);
  assert.equal(branch.state.combatantStates[playerKey].hp.maxHp, branch.state.combatantStates[playerKey].currentStats.hp);
  assert.ok(reward.changes.some(change => change.path.endsWith(".currentLevel")));
  assert.ok(reward.changes.some(change => change.path.endsWith(".currentStats.atk")));
  const eventCount = branch.events.length;
  applyDefeatedEnemyExperience(branch, plan, dataset);
  assert.equal(branch.events.length, eventCount);
});

test("Doubles tracks participation and rewards independently for each enemy", () => {
  const { plan, players, enemies } = fixtureDoublesPlan();
  const root = enableExperience(plan, players, enemies);
  registerSwitchExperienceParticipation(root, "player", players[2].combatantKey);
  for (const enemy of enemies.slice(0, 2)) {
    assert.deepEqual(root.experienceState.participantsByEnemyKey[enemy.combatantKey], [players[0].combatantKey, players[1].combatantKey, players[2].combatantKey]);
  }
  root.combatantStates[enemies[0].combatantKey].hp = { min: 0, max: 0, maxHp: root.combatantStates[enemies[0].combatantKey].hp.maxHp };
  const branch = { state: structuredClone(root), events: [] };
  applyDefeatedEnemyExperience(branch, plan, fixtureDoublesPlan().dataset);
  assert.deepEqual(branch.state.experienceState.rewardedEnemyKeys, [enemies[0].combatantKey]);
  assert.equal(projectVw2rExperience(plan, branch.state, enemies[0].combatantKey).available, false);
  assert.equal(projectVw2rExperience(plan, branch.state, enemies[1].combatantKey).available, true);
});
