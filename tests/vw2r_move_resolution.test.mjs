import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { boundedSlotDamageLabel, highestDamageCandidateKeys, previewCombatantMove, resolvedCombatantMovePreview } from "../src/core/combatant_moves.js";
import { createPlanDocument } from "../src/core/plan.js";
import { resolveTurn } from "../src/core/resolver.js";
import { vw2rMoveSupport } from "../src/rulesets/vw2r_move_support.js";
import { damageAdapter, fixtureDoublesPlan, fixturePlan } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const vw2rMoves = JSON.parse(fs.readFileSync(
  path.join(here, "..", "src", "generated", "datasets", "volt-white-2r", "moves.json"),
  "utf8"
)).records;
const vw2rTypes = JSON.parse(fs.readFileSync(
  path.join(here, "..", "src", "generated", "datasets", "volt-white-2r", "types.json"),
  "utf8"
)).records;

test("enemy threat ranking selects the highest maximum separately per target and preserves ties", () => {
  assert.deepEqual([...highestDamageCandidateKeys([
    { candidateKey: "move-a-slot-1", targetKey: "slot-1", maxPercent: 42 },
    { candidateKey: "move-b-slot-1", targetKey: "slot-1", maxPercent: 55 },
    { candidateKey: "move-c-slot-1", targetKey: "slot-1", maxPercent: 55 },
    { candidateKey: "move-a-slot-2", targetKey: "slot-2", maxPercent: 20 },
    { candidateKey: "status-slot-2", targetKey: "slot-2", maxPercent: null }
  ])], ["move-b-slot-1", "move-c-slot-1", "move-a-slot-2"]);
});

function action(actorKey, moveId, targetKeys = [], mechanicActivations = []) {
  return { actionType: "move", actorKey, moveId, targetKeys, mechanicActivations, declaredAtStateHash: "fixture" };
}

function vw2rFixture(moveId) {
  const result = fixturePlan();
  result.dataset.gameId = "volt-white-2r";
  result.dataset.indexes.moves.set(moveId, vw2rMoves[moveId]);
  const playerKey = result.players[0].combatantKey;
  const combatant = result.plan.combatants[playerKey];
  const state = result.plan.stateNodes[result.plan.initialStateNodeId].combatantStates[playerKey];
  const removed = combatant.moves.pop();
  delete state.movePp[removed.moveId];
  combatant.moves.push({ moveId, maxPp: vw2rMoves[moveId].pp });
  state.movePp[moveId] = vw2rMoves[moveId].pp;
  return { ...result, playerKey, enemyKey: result.enemies[0].combatantKey };
}

test("Doubles slot damage labels use two decimals and cap display at 999.99 percent", () => {
  assert.equal(boundedSlotDamageLabel(5, 7.456), "5.00–7.46%");
  assert.equal(boundedSlotDamageLabel(117.647, 141.176), "117.65–141.18%");
  assert.equal(boundedSlotDamageLabel(999.994, 1400), "999.99–999.99%");
  assert.equal(boundedSlotDamageLabel(null, undefined), null);
});

test("VW2R drain and secondary stat effects execute from the Showdown reference", () => {
  {
    const { dataset, plan, playerKey, enemyKey } = vw2rFixture("megadrain");
    plan.stateNodes[plan.initialStateNodeId].combatantStates[playerKey].hp = { min: 40, max: 40, maxHp: 175 };
    plan.stateNodes[plan.initialStateNodeId].combatantStates[playerKey].hpDistribution = [{ value: 40, probability: 1 }];
    const outcomes = resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: { player: action(playerKey, "megadrain", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
      dataset,
      damageAdapter: damageAdapter(({ move }) => move.id === "megadrain" ? [20] : [0])
    });
    assert.ok(outcomes.every(outcome => outcome.events.some(entry => entry.eventType === "heal" && entry.metadata.cause === "drain" && entry.healingHp.min === 10)));
  }

  {
    const { dataset, plan, playerKey, enemyKey } = vw2rFixture("snarl");
    const outcomes = resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: { player: action(playerKey, "snarl", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
      dataset,
      damageAdapter: damageAdapter(() => [10])
    });
    assert.ok(outcomes.some(outcome => outcome.state.combatantStates[enemyKey].statStages.spa === -1));
  }
});

test("VW2R Sludge Bomb branches its 30 percent poison chance", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("sludgebomb");
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, "sludgebomb", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(() => [10])
  });
  assert.ok(outcomes.some(outcome => outcome.events.some(entry => entry.eventType === "major-status" && entry.metadata.statusId === "psn")));
  assert.ok(outcomes.some(outcome => outcome.events.some(entry => entry.eventType === "secondary-effect-missed")));
});

test("VW2R type immunity suppresses damage rolls and Psybeam confusion after a switch", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("psybeam");
  dataset.indexes.types.set("dark", vw2rTypes.dark);
  dataset.indexes.types.set("steel", vw2rTypes.steel);
  dataset.indexes.types.set("psychic", vw2rTypes.psychic);
  const root = plan.stateNodes[plan.initialStateNodeId];
  const benchKey = Object.values(plan.combatants).find(entry => entry.side === "player" && entry.combatantKey !== playerKey).combatantKey;
  plan.combatants[benchKey].originalTypeIds = ["dark", "steel"];
  root.combatantStates[benchKey].currentTypeIds = ["dark", "steel"];
  plan.combatants[enemyKey].moves = [{ moveId: "psybeam", maxPp: vw2rMoves.psybeam.pp }];
  root.combatantStates[enemyKey].movePp = { psybeam: vw2rMoves.psybeam.pp };

  const preview = previewCombatantMove({
    plan,
    stateNodeId: plan.initialStateNodeId,
    actorKey: enemyKey,
    targetKey: benchKey,
    moveId: "psybeam",
    dataset,
    damageAdapter: { calculate: () => { throw new Error("immune preview must not call the damage adapter"); } }
  });
  assert.deepEqual(preview, { status: "immune", label: "Immune", reason: "type-immunity" });

  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: {
      player: { actionType: "switch", actorKey: playerKey, switchToKey: benchKey, declaredAtStateHash: "fixture" },
      enemy: action(enemyKey, "psybeam", [benchKey])
    },
    dataset,
    damageAdapter: { calculate: () => { throw new Error("immune move must not call the damage adapter"); } }
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].events.filter(entry => entry.eventType === "move-immune" && entry.moveId === "psybeam").length, 1);
  assert.equal(outcomes[0].events.some(entry => entry.eventType === "damage" && entry.moveId === "psybeam"), false);
  assert.equal(outcomes[0].events.some(entry => entry.eventType === "secondary-effect-missed" && entry.moveId === "psybeam"), false);
  assert.equal(outcomes[0].state.combatantStates[benchKey].volatileConditions.confusionTurns, null);
});

test("VW2R Soundproof classifies Boomburst as immune before damage resolution", () => {
  const { dataset, plan, players, enemies } = fixtureDoublesPlan();
  dataset.gameId = "volt-white-2r";
  dataset.indexes.moves.set("boomburst", vw2rMoves.boomburst);
  const root = plan.stateNodes[plan.initialStateNodeId];
  const loudredKey = enemies[0].combatantKey;
  const bouffalantKey = enemies[1].combatantKey;
  plan.combatants[loudredKey].moves = [{ moveId: "boomburst", maxPp: vw2rMoves.boomburst.pp }];
  root.combatantStates[loudredKey].movePp = { boomburst: vw2rMoves.boomburst.pp };
  plan.combatants[bouffalantKey].originalAbilityId = "soundproof";
  root.combatantStates[bouffalantKey].currentAbilityId = "soundproof";

  const preview = previewCombatantMove({
    plan,
    stateNodeId: plan.initialStateNodeId,
    actorKey: loudredKey,
    targetKey: bouffalantKey,
    moveId: "boomburst",
    dataset,
    damageAdapter: { calculate: () => { throw new Error("Soundproof preview must not call the damage adapter"); } }
  });
  assert.deepEqual(preview, { status: "immune", label: "Immune", reason: "ability-immunity", abilityId: "soundproof" });

  const calls = [];
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: {
      player: [
        action(players[0].combatantKey, "tackle", [loudredKey]),
        action(players[1].combatantKey, "tackle", [bouffalantKey])
      ],
      enemy: [
        action(loudredKey, "boomburst"),
        action(bouffalantKey, "tackle", [players[0].combatantKey])
      ]
    },
    dataset,
    damageAdapter: damageAdapter(input => { calls.push([input.attacker.combatantKey, input.defender.combatantKey, input.move.id]); return [1]; })
  });
  assert.ok(outcomes.length > 0);
  assert.ok(outcomes.every(outcome => outcome.events.some(event => event.eventType === "move-immune"
    && event.actorKey === loudredKey && event.targetKey === bouffalantKey && event.moveId === "boomburst"
    && event.metadata?.abilityId === "soundproof")));
  assert.ok(outcomes.every(outcome => !outcome.events.some(event => event.eventType === "damage"
    && event.actorKey === loudredKey && event.targetKey === bouffalantKey && event.moveId === "boomburst")));
  assert.equal(calls.some(([attackerKey, defenderKey, moveId]) => attackerKey === loudredKey && defenderKey === bouffalantKey && moveId === "boomburst"), false);
});

test("VW2R same-turn Soak makes Psybeam damage a switched-in Dark type and drives the resolved preview", () => {
  const { dataset, plan } = fixtureDoublesPlan();
  dataset.gameId = "volt-white-2r";
  for (const typeId of ["dark", "steel", "water", "psychic"]) dataset.indexes.types.set(typeId, vw2rTypes[typeId]);
  for (const moveId of ["soak", "psybeam"]) dataset.indexes.moves.set(moveId, vw2rMoves[moveId]);

  const root = plan.stateNodes[plan.initialStateNodeId];
  const [playerOne, playerTwo] = root.active.playerCombatantKeys;
  const [psybeamUser, soakUser] = root.active.enemyCombatantKeys;
  const benchKey = Object.values(plan.combatants).find(entry => entry.side === "player" && !root.active.playerCombatantKeys.includes(entry.combatantKey)).combatantKey;
  plan.combatants[benchKey].originalTypeIds = ["dark", "steel"];
  root.combatantStates[benchKey].currentTypeIds = ["dark", "steel"];
  plan.combatants[psybeamUser].moves = [{ moveId: "psybeam", maxPp: vw2rMoves.psybeam.pp }];
  root.combatantStates[psybeamUser].movePp = { psybeam: vw2rMoves.psybeam.pp };
  plan.combatants[soakUser].moves = [{ moveId: "soak", maxPp: vw2rMoves.soak.pp }];
  root.combatantStates[soakUser].movePp = { soak: vw2rMoves.soak.pp };
  plan.combatants[soakUser].calculatedStats.spe = 200;
  plan.combatants[psybeamUser].calculatedStats.spe = 150;

  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: {
      player: [
        { actionType: "switch", actorKey: playerOne, switchToKey: benchKey, declaredAtStateHash: "fixture" },
        action(playerTwo, "protect", [playerTwo])
      ],
      enemy: [
        action(psybeamUser, "psybeam", [benchKey]),
        action(soakUser, "soak", [benchKey])
      ]
    },
    dataset,
    damageAdapter: damageAdapter(({ move }) => move.id === "psybeam" ? [28, 34] : [0])
  });
  const outcome = outcomes.find(entry => entry.events.some(event => event.eventType === "damage" && event.moveId === "psybeam"));
  assert.ok(outcome, "Psybeam resolves as damage after the faster Soak");
  assert.equal(outcome.events.some(event => event.eventType === "move-immune" && event.moveId === "psybeam"), false);
  assert.deepEqual(outcome.state.combatantStates[benchKey].currentTypeIds, ["water"]);
  const soakIndex = outcome.events.findIndex(event => event.moveId === "soak" && event.eventType === "special-move-effect");
  const psybeamIndex = outcome.events.findIndex(event => event.moveId === "psybeam" && event.eventType === "damage");
  assert.ok(soakIndex >= 0 && psybeamIndex > soakIndex, "Soak resolves before Psybeam");

  const preview = resolvedCombatantMovePreview({
    events: outcome.events,
    actorKey: psybeamUser,
    targetKey: benchKey,
    moveId: "psybeam"
  });
  assert.equal(preview.status, "ok");
  assert.notEqual(preview.label, "Immune");
  assert.match(preview.label, /^\d+\.\d–\d+\.\d%$/);
});

test("VW2R starting Drizzle makes Hurricane bypass its miss branch", () => {
  const fixture = fixturePlan();
  fixture.dataset.gameId = "volt-white-2r";
  fixture.dataset.indexes.moves.set("hurricane", vw2rMoves.hurricane);
  fixture.players[0].originalAbilityId = "drizzle";
  fixture.players[0].moves[0] = { moveId: "hurricane", maxPp: vw2rMoves.hurricane.pp };
  const plan = createPlanDocument({
    dataset: fixture.dataset,
    trainerId: "trainer",
    playerCombatants: fixture.players,
    enemyCombatants: fixture.enemies,
    sourceSnapshot: fixture.plan.sourceSnapshot,
    now: "2026-08-25T00:00:00.000Z"
  });
  const root = plan.stateNodes[plan.initialStateNodeId];
  const playerKey = root.active.playerCombatantKey;
  const enemyKey = root.active.enemyCombatantKey;
  assert.equal(root.fieldState.global.weather.id, "rain");
  assert.equal(root.fieldState.global.weather.source, "ability:drizzle");

  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, "hurricane", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset: fixture.dataset,
    damageAdapter: damageAdapter(() => [10])
  });
  assert.ok(outcomes.length > 0);
  assert.ok(outcomes.every(outcome => outcome.events.some(entry => entry.eventType === "damage" && entry.moveId === "hurricane")));
  assert.ok(outcomes.every(outcome => !outcome.events.some(entry => entry.eventType === "miss" && entry.moveId === "hurricane")));
});

test("VW2R Hurricane branches its Gen 5 critical hit and preserves the critical KO", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("hurricane");
  const root = plan.stateNodes[plan.initialStateNodeId];
  root.fieldState.global.weather = { id: "rain", source: "fixture", durationMode: "turns", remainingTurns: 5 };
  root.combatantStates[enemyKey].hp = { min: 85, max: 85, maxHp: 85 };
  root.combatantStates[enemyKey].hpDistribution = [{ value: 85, probability: 1 }];
  const adapter = {
    supportsCriticalHits: true,
    calculate(input) {
      const selectedDamage = input.move.id === "hurricane" ? (input.criticalHit ? [132] : [78]) : [0];
      return { status: "ok", damage: selectedDamage, criticalHit: input.move.id === "hurricane" && input.criticalHit === true };
    }
  };
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, "hurricane", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: adapter
  });
  const criticalKo = outcomes.find(outcome => outcome.events.some(entry =>
    entry.eventType === "damage"
      && entry.moveId === "hurricane"
      && entry.metadata?.criticalHit === true
      && entry.metadata?.thresholdOutcome === "ko"
  ));
  assert.ok(criticalKo, "the critical Hurricane KO remains a distinct outcome");
  assert.equal(criticalKo.outcome.probability, 1 / 16);
  assert.equal(criticalKo.events.some(entry => entry.eventType === "volatile-status" && entry.moveId === "hurricane"), false, "a fainted target cannot receive Hurricane confusion");
});

test("VW2R Spore stores hidden sleep duration and branches only when the sleeper checks its action", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("spore");
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, "spore", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(() => [10])
  });
  assert.equal(outcomes.length, 1);
  const sleeping = outcomes[0].state.combatantStates[enemyKey].volatileConditions;
  assert.equal(sleeping.sleepTurns, null);
  assert.deepEqual(sleeping.sleepCounterDistribution, [1, 2, 3, 4].map(value => ({ value, probability: 0.25 })));
  const application = outcomes[0].events.find(entry => entry.eventType === "major-status" && entry.moveId === "spore");
  assert.equal(application.metadata.sleepTurns, undefined);
  assert.ok(outcomes.every(outcome => outcome.events.some(entry => entry.reason === "sleep")));

  const nextState = structuredClone(outcomes[0].state);
  nextState.stateNodeId = "sleep-turn-one";
  plan.stateNodes[nextState.stateNodeId] = nextState;
  const next = resolveTurn({
    plan,
    parentStateNodeId: nextState.stateNodeId,
    actions: { player: action(playerKey, "tackle", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(() => [1])
  });
  assert.equal(next.length, 2);
  assert.ok(next.some(outcome => outcome.events.some(entry => entry.eventType === "status-cleared" && entry.metadata?.cause === "wake")));
  assert.ok(next.some(outcome => outcome.events.some(entry => entry.eventType === "action-skipped" && entry.reason === "sleep")));
  assert.deepEqual(next.map(outcome => outcome.outcome.probability).sort((left, right) => left - right), [0.25, 0.75]);
});

test("VW2R confusion branches on application, then on the affected Pokemon's action check", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("psybeam");
  const first = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, "psybeam", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(() => [1])
  });
  assert.equal(first.length, 3);
  assert.ok(first.some(outcome => outcome.events.some(entry => entry.eventType === "secondary-effect-missed" && entry.moveId === "psybeam")));
  assert.ok(first.some(outcome => outcome.events.some(entry => entry.eventType === "confusion-self-hit" && entry.actorKey === enemyKey)));
  const acted = first.find(outcome => outcome.events.some(entry => entry.eventType === "confusion-check" && entry.actorKey === enemyKey));
  assert.ok(acted);
  assert.equal(first.some(outcome => outcome.events.some(entry => entry.eventType === "volatile-status-cleared" && entry.metadata?.volatileStatusId === "confusion")), false);
  const application = acted.events.find(entry => entry.eventType === "volatile-status" && entry.moveId === "psybeam");
  assert.equal(application.metadata.durationTurns, undefined);
  assert.deepEqual(acted.state.combatantStates[enemyKey].volatileConditions.confusionCounterDistribution, [1, 2, 3, 4].map(value => ({ value, probability: 0.25 })));

  const nextState = structuredClone(acted.state);
  nextState.stateNodeId = "confusion-turn-one";
  plan.stateNodes[nextState.stateNodeId] = nextState;
  const next = resolveTurn({
    plan,
    parentStateNodeId: nextState.stateNodeId,
    actions: { player: action(playerKey, "tackle", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(() => [1])
  });
  assert.ok(next.some(outcome => outcome.events.some(entry => entry.eventType === "volatile-status-cleared" && entry.actorKey === enemyKey)));
  assert.ok(next.some(outcome => outcome.events.some(entry => entry.eventType === "confusion-self-hit" && entry.actorKey === enemyKey)));
  assert.ok(next.some(outcome => outcome.events.some(entry => entry.eventType === "confusion-check" && entry.actorKey === enemyKey)));
  assert.deepEqual(next.map(outcome => outcome.outcome.probability).sort((left, right) => left - right), [0.25, 0.375, 0.375]);
});

test("VW2R Toxic Spikes updates the opposing side hazard state without a target", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("toxicspikes");
  const [outcome] = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, "toxicspikes"), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(() => [10])
  });
  assert.equal(outcome.state.fieldState.sides.enemy.hazards.toxicSpikes, 1);
});

test("VW2R variable multi-hit moves branch by the Gen 5 hit-count distribution", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("bulletseed");
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, "bulletseed", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(({ move, moveHits }) => move.id === "bulletseed" ? [moveHits * 4] : [0])
  });
  const hitBranches = outcomes.map(outcome => ({
    hits: outcome.events.find(entry => entry.eventType === "damage" && entry.moveId === "bulletseed")?.metadata.moveHits,
    probability: outcome.outcome.probability
  })).sort((left, right) => left.hits - right.hits);
  assert.deepEqual(hitBranches.map(entry => entry.hits), [2, 3, 4, 5]);
  assert.deepEqual(hitBranches.map(entry => entry.probability), [3 / 8, 3 / 8, 1 / 8, 1 / 8]);
});

test("VW2R Knock Off triggers a full-HP Shedinja Focus Sash before item removal", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("knockoff");
  const target = plan.stateNodes[plan.initialStateNodeId].combatantStates[enemyKey];
  target.hp = { min: 1, max: 1, maxHp: 1 };
  target.hpDistribution = [{ value: 1, probability: 1 }];
  target.currentItemId = "focussash";
  target.itemState = "held";
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, "knockoff", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(({ move }) => move.id === "knockoff" ? [84, 98] : [0])
  });
  assert.ok(outcomes.every(outcome => outcome.state.combatantStates[enemyKey].hp.min === 1 && outcome.state.combatantStates[enemyKey].hp.max === 1));
  assert.ok(outcomes.every(outcome => outcome.state.combatantStates[enemyKey].itemState === "consumed"));
  assert.ok(outcomes.every(outcome => outcome.events.some(entry => entry.eventType === "item-consumed" && entry.metadata?.itemId === "focussash")));
  assert.ok(outcomes.every(outcome => !outcome.events.some(entry => entry.eventType === "special-move-effect" && entry.metadata?.handlerId === "remove-item")));
});

test("VW2R multi-hit damage can consume Focus Sash on hit one and still KO on a later hit", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("bulletseed");
  const target = plan.stateNodes[plan.initialStateNodeId].combatantStates[enemyKey];
  target.hp = { min: 1, max: 1, maxHp: 1 };
  target.hpDistribution = [{ value: 1, probability: 1 }];
  target.currentItemId = "focussash";
  target.itemState = "held";
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, "bulletseed", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(({ move, moveHits }) => move.id === "bulletseed" ? [Number(moveHits || 1) * 4] : [0])
  });
  assert.ok(outcomes.every(outcome => outcome.state.combatantStates[enemyKey].hp.max === 0));
  assert.ok(outcomes.every(outcome => outcome.state.combatantStates[enemyKey].itemState === "consumed"));
  assert.ok(outcomes.every(outcome => outcome.events.some(entry => entry.eventType === "item-consumed" && entry.metadata?.itemId === "focussash")));
  assert.deepEqual(outcomes.map(outcome => outcome.outcome.probability), [1], "equivalent faint states merge after every hit-count branch consumes the Sash");
});

test("VW2R multi-hit damage does not consume Focus Sash when the first hit is nonlethal", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("bulletseed");
  const target = plan.stateNodes[plan.initialStateNodeId].combatantStates[enemyKey];
  target.hp = { min: 10, max: 10, maxHp: 10 };
  target.hpDistribution = [{ value: 10, probability: 1 }];
  target.currentItemId = "focussash";
  target.itemState = "held";
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, "bulletseed", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(({ move, moveHits }) => move.id === "bulletseed" ? [Number(moveHits || 1) * 4] : [0])
  });
  const twoHits = outcomes.find(outcome => outcome.events.some(entry => entry.moveId === "bulletseed" && entry.metadata?.moveHits === 2));
  const laterKo = outcomes.filter(outcome => outcome.events.some(entry => entry.moveId === "bulletseed" && Number(entry.metadata?.moveHits) >= 3));
  assert.equal(twoHits?.state.combatantStates[enemyKey].hp.max, 2);
  assert.equal(twoHits?.state.combatantStates[enemyKey].itemState, "held");
  assert.ok(laterKo.every(outcome => outcome.state.combatantStates[enemyKey].hp.max === 0));
  assert.ok(laterKo.every(outcome => outcome.state.combatantStates[enemyKey].itemState === "held"));
  assert.ok(outcomes.every(outcome => !outcome.events.some(entry => entry.metadata?.itemId === "focussash")));
});

test("VW2R Sleep Talk executes the explicitly declared called move while asleep", () => {
  const { dataset, plan, playerKey, enemyKey } = vw2rFixture("sleeptalk");
  const root = plan.stateNodes[plan.initialStateNodeId];
  root.combatantStates[playerKey].majorStatus = "slp";
  root.combatantStates[playerKey].volatileConditions.sleepTurns = 2;
  const outcomes = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: {
      player: action(playerKey, "sleeptalk", [playerKey], [{ id: "called-move", moveId: "tackle", targetKey: enemyKey }]),
      enemy: action(enemyKey, "tackle", [playerKey])
    },
    dataset,
    damageAdapter: damageAdapter(({ move }) => move.id === "tackle" ? [7] : [0])
  });
  assert.ok(outcomes.every(outcome => outcome.events.some(entry => entry.eventType === "move-called" && entry.metadata.calledMoveId === "tackle")));
  assert.ok(outcomes.every(outcome => outcome.events.some(entry => entry.eventType === "damage" && entry.moveId === "tackle" && entry.targetKey === enemyKey)));
});

test("Showdown callback moves preserve delayed, nonlethal, and Baton Pass state", () => {
  {
    const { dataset, plan, playerKey, enemyKey } = vw2rFixture("falseswipe");
    const root = plan.stateNodes[plan.initialStateNodeId];
    root.combatantStates[enemyKey].hp = { min: 5, max: 5, maxHp: root.combatantStates[enemyKey].hp.maxHp };
    root.combatantStates[enemyKey].hpDistribution = [{ value: 5, probability: 1 }];
    const outcomes = resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: { player: action(playerKey, "falseswipe", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
      dataset,
      damageAdapter: damageAdapter(({ move }) => move.id === "falseswipe" ? [50] : [0])
    });
    assert.ok(outcomes.every(outcome => outcome.state.combatantStates[enemyKey].hp.min === 1));
  }

  {
    const { dataset, plan, playerKey, enemyKey } = vw2rFixture("futuresight");
    const adapter = damageAdapter(({ move }) => move.id === "futuresight" ? [12] : [0]);
    const first = resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: { player: action(playerKey, "futuresight", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
      dataset,
      damageAdapter: adapter
    })[0];
    assert.equal(first.events.some(entry => entry.eventType === "damage" && entry.moveId === "futuresight"), false);
    plan.stateNodes.delayed1 = { ...first.state, stateNodeId: "delayed1" };
    const second = resolveTurn({
      plan,
      parentStateNodeId: "delayed1",
      actions: { player: action(playerKey, "tackle", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
      dataset,
      damageAdapter: adapter
    })[0];
    plan.stateNodes.delayed2 = { ...second.state, stateNodeId: "delayed2" };
    const third = resolveTurn({
      plan,
      parentStateNodeId: "delayed2",
      actions: { player: action(playerKey, "tackle", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
      dataset,
      damageAdapter: adapter
    })[0];
    assert.ok(third.events.some(entry => entry.eventType === "delayed-attack" && entry.moveId === "futuresight"));
    assert.ok(third.events.some(entry => entry.eventType === "damage" && entry.moveId === "futuresight" && entry.damageHp.min === 12));
  }

  {
    const { dataset, plan, playerKey } = vw2rFixture("batonpass");
    const root = plan.stateNodes[plan.initialStateNodeId];
    const benchKey = Object.values(plan.combatants).find(entry => entry.side === "player" && entry.combatantKey !== playerKey).combatantKey;
    root.combatantStates[playerKey].statStages.atk = 3;
    root.combatantStates[playerKey].volatileConditions.substituteHp = 25;
    const [outcome] = resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: {
        player: action(playerKey, "batonpass", [playerKey], [{ id: "after-move-switch", switchToKey: benchKey }]),
        enemy: action(Object.values(plan.combatants).find(entry => entry.side === "enemy").combatantKey, "tackle", [playerKey])
      },
      dataset,
      damageAdapter: damageAdapter(() => [0])
    });
    assert.equal(outcome.state.active.playerCombatantKeys[0], benchKey);
    assert.equal(outcome.state.combatantStates[benchKey].statStages.atk, 3);
    assert.equal(outcome.state.combatantStates[benchKey].volatileConditions.substituteHp, 25);
  }
});

test("Doubles order control and redirection follow Showdown targeting", () => {
  {
    const { dataset, plan, players, enemies } = fixtureDoublesPlan();
    dataset.gameId = "volt-white-2r";
    dataset.indexes.moves.set("quash", vw2rMoves.quash);
    const actorKey = players[0].combatantKey;
    plan.combatants[actorKey].moves[0] = { moveId: "quash", maxPp: vw2rMoves.quash.pp };
    const root = plan.stateNodes[plan.initialStateNodeId];
    root.combatantStates[actorKey].movePp.quash = vw2rMoves.quash.pp;
    plan.combatants[players[0].combatantKey].calculatedStats.spe = 200;
    plan.combatants[players[1].combatantKey].calculatedStats.spe = 150;
    plan.combatants[enemies[0].combatantKey].calculatedStats.spe = 100;
    plan.combatants[enemies[1].combatantKey].calculatedStats.spe = 50;
    const calls = [];
    resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: {
        player: [action(actorKey, "quash", [enemies[0].combatantKey]), action(players[1].combatantKey, "tackle", [enemies[1].combatantKey])],
        enemy: [action(enemies[0].combatantKey, "tackle", [players[0].combatantKey]), action(enemies[1].combatantKey, "tackle", [players[1].combatantKey])]
      },
      dataset,
      damageAdapter: damageAdapter(({ attacker }) => { calls.push(attacker.combatantKey); return [0]; })
    });
    assert.deepEqual(calls, [players[1].combatantKey, enemies[1].combatantKey, enemies[0].combatantKey]);
  }

  {
    const { dataset, plan, players, enemies } = fixtureDoublesPlan();
    dataset.gameId = "volt-white-2r";
    dataset.indexes.moves.set("followme", vw2rMoves.followme);
    const actorKey = players[0].combatantKey;
    plan.combatants[actorKey].moves[0] = { moveId: "followme", maxPp: vw2rMoves.followme.pp };
    plan.stateNodes[plan.initialStateNodeId].combatantStates[actorKey].movePp.followme = vw2rMoves.followme.pp;
    const [outcome] = resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: {
        player: [action(actorKey, "followme", [actorKey]), action(players[1].combatantKey, "tackle", [enemies[1].combatantKey])],
        enemy: [action(enemies[0].combatantKey, "tackle", [players[1].combatantKey]), action(enemies[1].combatantKey, "tackle", [players[1].combatantKey])]
      },
      dataset,
      damageAdapter: damageAdapter(() => [1])
    });
    const enemyHits = outcome.events.filter(entry => entry.eventType === "damage" && enemies.some(enemy => enemy.combatantKey === entry.actorKey));
    assert.ok(enemyHits.every(entry => entry.targetKey === actorKey));
  }
});

test("Showdown dynamic-power conditions are passed to the shared calculator", () => {
  {
    const { dataset, plan, playerKey, enemyKey } = vw2rFixture("brine");
    const targetState = plan.stateNodes[plan.initialStateNodeId].combatantStates[enemyKey];
    const half = Math.floor(targetState.hp.maxHp / 2);
    targetState.hp = { min: half, max: half, maxHp: targetState.hp.maxHp };
    targetState.hpDistribution = [{ value: half, probability: 1 }];
    const observed = [];
    resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: { player: action(playerKey, "brine", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
      dataset,
      damageAdapter: damageAdapter(input => { if (input.move.id === "brine") observed.push(input.moveOverrides.basePower); return [0]; })
    });
    assert.deepEqual(observed, [Number(vw2rMoves.brine.basePower) * 2]);
  }

  {
    const { dataset, plan, playerKey, enemyKey } = vw2rFixture("storedpower");
    const actorState = plan.stateNodes[plan.initialStateNodeId].combatantStates[playerKey];
    actorState.statStages.atk = 2;
    actorState.statStages.def = 1;
    const observed = [];
    resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: { player: action(playerKey, "storedpower", [enemyKey]), enemy: action(enemyKey, "tackle", [playerKey]) },
      dataset,
      damageAdapter: damageAdapter(input => { if (input.move.id === "storedpower") observed.push(input.moveOverrides.basePower); return [0]; })
    });
    assert.deepEqual(observed, [80]);
  }
});

test("Wide Guard protects both allied slots and Ally Switch does not cancel the queued ally", () => {
  {
    const { dataset, plan, players, enemies } = fixtureDoublesPlan();
    dataset.gameId = "volt-white-2r";
    dataset.indexes.moves.set("wideguard", vw2rMoves.wideguard);
    const guardKey = players[0].combatantKey;
    plan.combatants[guardKey].moves[0] = { moveId: "wideguard", maxPp: vw2rMoves.wideguard.pp };
    plan.stateNodes[plan.initialStateNodeId].combatantStates[guardKey].movePp.wideguard = vw2rMoves.wideguard.pp;
    plan.combatants[enemies[0].combatantKey].moves[0] = { moveId: "earthquake", maxPp: dataset.get("moves", "earthquake").pp };
    plan.stateNodes[plan.initialStateNodeId].combatantStates[enemies[0].combatantKey].movePp.earthquake = dataset.get("moves", "earthquake").pp;
    const [outcome] = resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: {
        player: [action(guardKey, "wideguard"), action(players[1].combatantKey, "tackle", [enemies[1].combatantKey])],
        enemy: [action(enemies[0].combatantKey, "earthquake"), action(enemies[1].combatantKey, "tackle", [players[1].combatantKey])]
      },
      dataset,
      damageAdapter: damageAdapter(() => [1])
    });
    const quakeHits = outcome.events.filter(entry => entry.eventType === "damage" && entry.moveId === "earthquake");
    assert.equal(quakeHits.some(entry => players.some(player => player.combatantKey === entry.targetKey)), false);
    assert.ok(outcome.events.filter(entry => entry.eventType === "move-blocked" && entry.metadata.reason === "wide-guard").length >= 2);
  }

  {
    const { dataset, plan, players, enemies } = fixtureDoublesPlan();
    dataset.gameId = "volt-white-2r";
    dataset.indexes.moves.set("allyswitch", vw2rMoves.allyswitch);
    const actorKey = players[0].combatantKey;
    plan.combatants[actorKey].moves[0] = { moveId: "allyswitch", maxPp: vw2rMoves.allyswitch.pp };
    plan.stateNodes[plan.initialStateNodeId].combatantStates[actorKey].movePp.allyswitch = vw2rMoves.allyswitch.pp;
    const [outcome] = resolveTurn({
      plan,
      parentStateNodeId: plan.initialStateNodeId,
      actions: {
        player: [action(actorKey, "allyswitch", [actorKey]), action(players[1].combatantKey, "tackle", [enemies[1].combatantKey])],
        enemy: [action(enemies[0].combatantKey, "tackle", [players[0].combatantKey]), action(enemies[1].combatantKey, "tackle", [players[1].combatantKey])]
      },
      dataset,
      damageAdapter: damageAdapter(() => [1])
    });
    assert.ok(outcome.events.some(entry => entry.eventType === "damage" && entry.actorKey === players[1].combatantKey));
    assert.equal(outcome.events.some(entry => entry.reason === "actor-no-longer-active" && entry.actorKey === players[1].combatantKey), false);
  }
});

test("every VW2R move can enter the Singles resolver without an unsupported failure", () => {
  const failures = [];
  for (const move of Object.values(vw2rMoves)) {
    try {
      const { dataset, plan, playerKey, enemyKey } = vw2rFixture(move.id);
      const support = vw2rMoveSupport(move);
      const benchKey = Object.values(plan.combatants).find(entry => entry.side === "player" && entry.combatantKey !== playerKey)?.combatantKey;
      const targetKeys = support.target === "self" || support.targetMode === "adjacentallyorself"
        ? [playerKey]
        : support.target === "target" && support.targetMode !== "adjacentally" ? [enemyKey] : [];
      const mechanicActivations = [];
      if (["call-party-move", "call-random-move", "sleep-talk"].includes(support.specialHandlerId)) mechanicActivations.push({ id: "called-move", moveId: "tackle", targetKey: enemyKey });
      if (support.specialHandlerId === "conversion-2") mechanicActivations.push({ id: "conversion-type", typeId: "water" });
      if (support.operations?.some(operation => operation.kind === "self-switch")) mechanicActivations.push({ id: "after-move-switch", switchToKey: benchKey });
      const outcomes = resolveTurn({
        plan,
        parentStateNodeId: plan.initialStateNodeId,
        actions: { player: action(playerKey, move.id, targetKeys, mechanicActivations), enemy: action(enemyKey, "tackle", [playerKey]) },
        dataset,
        damageAdapter: damageAdapter(({ move: selectedMove, moveHits }) => [Math.max(0, Number(moveHits || 1))])
      });
      assert.ok(outcomes.length > 0);
    } catch (error) {
      failures.push(`${move.id}: ${error.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("every VW2R move can enter the Doubles resolver without an unsupported failure", () => {
  const failures = [];
  for (const move of Object.values(vw2rMoves)) {
    try {
      const { dataset, plan, players, enemies } = fixtureDoublesPlan();
      dataset.gameId = "volt-white-2r";
      dataset.indexes.moves.set(move.id, move);
      const actorKey = players[0].combatantKey;
      const allyKey = players[1].combatantKey;
      const enemyKey = enemies[0].combatantKey;
      const benchKey = players[2].combatantKey;
      const removed = plan.combatants[actorKey].moves.pop();
      delete plan.stateNodes[plan.initialStateNodeId].combatantStates[actorKey].movePp[removed.moveId];
      plan.combatants[actorKey].moves.push({ moveId: move.id, maxPp: move.pp });
      plan.stateNodes[plan.initialStateNodeId].combatantStates[actorKey].movePp[move.id] = move.pp;
      plan.combatants[players[0].combatantKey].calculatedStats.spe = 200;
      plan.combatants[players[1].combatantKey].calculatedStats.spe = 150;
      plan.combatants[enemies[0].combatantKey].calculatedStats.spe = 100;
      plan.combatants[enemies[1].combatantKey].calculatedStats.spe = 50;
      const support = vw2rMoveSupport(move);
      const targetKeys = support.target === "self" || support.targetMode === "adjacentallyorself"
        ? [actorKey]
        : support.targetMode === "adjacentally"
          ? [allyKey]
          : support.target === "target"
            ? [enemyKey]
            : [];
      const mechanicActivations = [];
      if (["call-party-move", "call-random-move", "sleep-talk"].includes(support.specialHandlerId)) mechanicActivations.push({ id: "called-move", moveId: "tackle", targetKey: enemyKey });
      if (support.specialHandlerId === "conversion-2") mechanicActivations.push({ id: "conversion-type", typeId: "water" });
      if (support.operations?.some(operation => operation.kind === "self-switch")) mechanicActivations.push({ id: "after-move-switch", switchToKey: benchKey });
      const outcomes = resolveTurn({
        plan,
        parentStateNodeId: plan.initialStateNodeId,
        actions: {
          player: [action(actorKey, move.id, targetKeys, mechanicActivations), action(allyKey, "tackle", [enemies[1].combatantKey])],
          enemy: [action(enemyKey, "tackle", [actorKey]), action(enemies[1].combatantKey, "tackle", [allyKey])]
        },
        dataset,
        damageAdapter: damageAdapter(({ moveHits }) => [Math.max(0, Number(moveHits || 1))])
      });
      assert.ok(outcomes.length > 0);
    } catch (error) {
      failures.push(`${move.id}: ${error.message}`);
    }
  }
  assert.deepEqual(failures, []);
});
