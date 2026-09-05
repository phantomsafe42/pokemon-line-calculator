import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveTurn } from "../src/core/resolver.js";
import { vw2rMoveSupport } from "../src/rulesets/vw2r_move_support.js";
import { damageAdapter, fixturePlan } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const unboundMoves = JSON.parse(fs.readFileSync(
  path.join(here, "..", "src", "generated", "datasets", "pokemon-unbound", "moves.json"),
  "utf8"
)).records;

function action(actorKey, moveId, targetKeys = [], mechanicActivations = []) {
  return { actionType: "move", actorKey, moveId, targetKeys, mechanicActivations, declaredAtStateHash: "fixture" };
}

function unboundFixture(move) {
  const result = fixturePlan();
  result.dataset.gameId = "pokemon-unbound";
  result.dataset.mechanics.damageGeneration = 3;
  result.dataset.indexes.moves.set(move.id, move);
  const playerKey = result.players[0].combatantKey;
  const enemyKey = result.enemies[0].combatantKey;
  const benchKey = result.players[1].combatantKey;
  const combatant = result.plan.combatants[playerKey];
  const state = result.plan.stateNodes[result.plan.initialStateNodeId].combatantStates[playerKey];
  const removed = combatant.moves.pop();
  delete state.movePp[removed.moveId];
  combatant.moves.push({ moveId: move.id, maxPp: move.pp });
  state.movePp[move.id] = move.pp;
  return { ...result, playerKey, enemyKey, benchKey };
}

test("every calculation-applicable Unbound move enters the Singles resolver", () => {
  const failures = [];
  const applicable = Object.values(unboundMoves).filter(move => move.calculationApplicability !== "inapplicable-unused-engine-slot");
  for (const move of applicable) {
    try {
      const { dataset, plan, playerKey, enemyKey, benchKey } = unboundFixture(move);
      const support = vw2rMoveSupport(move, dataset);
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
        damageAdapter: damageAdapter(({ moveHits }) => [Math.max(0, Number(moveHits || 1))])
      });
      assert.ok(outcomes.length > 0);
    } catch (error) {
      failures.push(`${move.id}: ${error.message}`);
    }
  }
  assert.equal(applicable.length, 922);
  assert.deepEqual(failures, []);
});

test("Ion Deluge changes later Normal moves to Electric for the current turn", () => {
  const move = unboundMoves.iondeluge;
  const { dataset, plan, playerKey, enemyKey } = unboundFixture(move);
  const observedTypes = [];
  resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, move.id), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(({ move: selectedMove }) => {
      if (selectedMove.id === "tackle") observedTypes.push(selectedMove.type);
      return [1];
    })
  });
  assert.deepEqual(observedTypes, ["electric"]);
});

test("Fairy Lock carries through the next decision point and prevents switching", () => {
  const move = unboundMoves.fairylock;
  const { dataset, plan, playerKey, enemyKey, benchKey } = unboundFixture(move);
  const [firstTurn] = resolveTurn({
    plan,
    parentStateNodeId: plan.initialStateNodeId,
    actions: { player: action(playerKey, move.id), enemy: action(enemyKey, "tackle", [playerKey]) },
    dataset,
    damageAdapter: damageAdapter(() => [1])
  });
  assert.equal(firstTurn.state.fieldState.global.fairyLockTurns, 1);
  firstTurn.state.stateNodeId = "state-fairy-lock";
  plan.stateNodes[firstTurn.state.stateNodeId] = firstTurn.state;
  assert.throws(() => resolveTurn({
    plan,
    parentStateNodeId: firstTurn.state.stateNodeId,
    actions: {
      player: { actionType: "switch", actorKey: playerKey, switchToKey: benchKey, switchKind: "voluntary", declaredAtStateHash: "fixture" },
      enemy: action(enemyKey, "tackle", [playerKey])
    },
    dataset,
    damageAdapter: damageAdapter(() => [1])
  }), /Fairy Lock prevents switching/);
});
