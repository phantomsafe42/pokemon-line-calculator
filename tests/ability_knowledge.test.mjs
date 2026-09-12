import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { initializeAbilityKnowledge, observeAbilityEvent, clearFaintedAbilityKnowledge, entryAbilityAnnouncement } from "../src/core/ability_knowledge.js";
import { updateStateHash, upgradeInitialEntryEffects } from "../src/core/plan.js";
import { createGen5QueryProvider } from "../src/adapters/trainer_ai.js";
import { resolveTurn } from "../src/core/resolver.js";
import { fixturePlan, damageAdapter } from "./helpers.mjs";

const policy = JSON.parse(fs.readFileSync(new URL("../src/generated/trainer-ai/gen5/trainer_ai.json", import.meta.url))).evaluator.constants.abilityKnowledge;
const fixture = () => ({ active: { playerCombatantKeys: ["a", "b", "c"], enemyCombatantKeys: ["e", null, null] },
  combatantStates: Object.fromEntries(["a", "b", "c", "e", "reserve"].map(key => [key, { hp: { min: 50, max: 50 }, currentAbilityId: key === "c" ? "sapsipper" : "pressure" }])) });

test("pinned Script 0 ability known answers preserve Sap Sipper, Storm Drain and Soundproof paths", () => {
  const profile = JSON.parse(fs.readFileSync(new URL("../src/generated/trainer-ai/gen5/trainer_ai.json", import.meta.url))).evaluator;
  const sandbox = { globalThis: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL("../src/generated/battle-mechanics/trainer_ai/trainer_ai_evaluator.js", import.meta.url), "utf8"), sandbox);
  const queries = createGen5QueryProvider({ plan: {}, state: {}, dataset: {} });
  const cases = profile.validationCases.filter(row => row.validatorKind === "gen5-source-ability-script");
  assert.equal(cases.length, 7);
  for (const row of cases) {
    const result = sandbox.globalThis.TrainerAiEvaluator.evaluate({ profile, request: row.request, queries: {
      "gen5.command.0x15": queries["gen5.command.0x15"],
      "gen5.command.0x16": queries["gen5.command.0x16"],
      "gen5.command.0x24": queries["gen5.command.0x24"],
      "gen5.command.0x25": queries["gen5.command.0x25"]
    } });
    assert.equal(result.status, row.expected.status, `${row.id}: ${JSON.stringify(result.diagnostics)}`);
    assert.deepEqual(JSON.parse(JSON.stringify(result.scoreDistributions)).map(({ candidateId, scores }) => ({ candidateId, scores })), row.expected.scoreDistributions, row.id);
    if (row.id.endsWith("one-of-three-sap-sipper")) {
      const reason = result.scoreAdjustments.find(reason => reason.delta === -12);
      assert.equal(reason.scoringProbability.numerator, "1");
      assert.equal(reason.scoringProbability.denominator, "3");
    }
  }
});

test("Gen 5 queries use species slots, revealed slot memory, trapping precedence and suppression without leaking the actual ability", () => {
  const state = fixture();
  initializeAbilityKnowledge(state, policy);
  const plan = { combatants: { c: { side: "player", speciesId: "gastrodon" }, e: { side: "enemy" } } };
  const slots = ["stickyhold", "stormdrain", "sandforce"];
  const dataset = { get: kind => kind === "species" ? { abilities: slots } : kind === "moves" ? { id: "energyball", type: "grass" } : { weak: ["grass"], resist: [], immune: [] } };
  state.combatantStates.c.currentTypeIds = ["water", "ground"];
  const provider = createGen5QueryProvider({ plan, state, dataset, actorEntry: { combatantKey: "e", side: "enemy", slot: 0 } });
  const metadata = { profile: JSON.parse(fs.readFileSync(new URL("../src/generated/trainer-ai/gen5/trainer_ai.json", import.meta.url))).evaluator, context: { candidate: { action: { canonicalMoveId: "energyball", targetCombatantKey: "c" } } } };
  const guesses = () => provider["gen5.command.0x2a.ability-options"]("target", metadata);
  assert.deepEqual(guesses().map(value => value.replaceAll("_", "")), ["ability.stickyhold", "ability.stormdrain", "ability.sandforce"]);
  assert.equal(provider["gen5.command.0x2c"]("0x", metadata), false);
  assert.equal(provider["gen5.command.0x2c"]("4x", metadata), true);
  state.trainerAiBelief.abilityByPosition.player[2] = "sapsipper";
  assert.deepEqual(guesses(), ["ability.sap_sipper"]);
  state.combatantStates.c.currentAbilityId = "shadowtag";
  assert.deepEqual(guesses(), ["ability.sap_sipper"], "stale memory precedes actual trapping ability");
  state.trainerAiBelief.abilityByPosition.player[2] = null;
  assert.deepEqual(guesses(), ["ability.shadow_tag"]);
  state.combatantStates.c.abilitySuppressed = true;
  assert.deepEqual(guesses(), ["ability.none"]);
  state.trainerAiBelief.abilityByPosition.enemy[0] = "sapsipper";
  assert.deepEqual(provider["gen5.command.0x2a.ability-options"]("user", metadata), ["ability.pressure"], "own ability precedes stale memory");
  state.combatantStates.c.abilitySuppressed = false;
  state.combatantStates.c.currentAbilityId = "sapsipper";
  slots.splice(0, slots.length, "waterabsorb", "waterabsorb", null);
  assert.deepEqual(guesses(), ["ability.water_absorb", "ability.water_absorb"], "duplicate slots are preserved; empty slots excluded");
});

test("unrevealed ability stays unknown; activation overwrites the physical slot and changes the state hash", () => {
  assert.ok(policy, "Generated Gen 5 memory policy is required");
  const state = fixture();
  initializeAbilityKnowledge(state, policy);
  const before = updateStateHash(state).stateHash;
  assert.deepEqual(state.trainerAiBelief.abilityByPosition.player, [null, null, null]);
  const event = { eventType: "move-immune", actorKey: "e", targetKey: "c", metadata: { abilityId: "sapsipper" } };
  observeAbilityEvent(state, event, policy);
  assert.deepEqual(state.trainerAiBelief.abilityByPosition.player, [null, null, "sapsipper"]);
  assert.notEqual(updateStateHash(state).stateHash, before);
  assert.deepEqual(event.metadata.abilityObservation, { side: "player", slot: 2, abilityId: "sapsipper" });
});

test("initial plan upgrade installs the Dataset policy and records only announced lead abilities", () => {
  const { plan, dataset } = fixturePlan();
  dataset.abilityKnowledgePolicy = policy;
  const before = plan.stateNodes[plan.initialStateNodeId].stateHash;
  const upgraded = upgradeInitialEntryEffects(plan, dataset);
  const root = upgraded.plan.stateNodes[upgraded.plan.initialStateNodeId];
  assert.equal(upgraded.changed, true);
  assert.equal(root.trainerAiBelief.modelId, policy.modelId);
  assert.deepEqual(root.trainerAiBelief.abilityByPosition, { player: ["pressure"], enemy: ["pressure"] });
  assert.notEqual(root.stateHash, before);
  assert.equal(upgradeInitialEntryEffects(upgraded.plan, dataset).changed, false);
});

test("AI damage omits the no-effect immunity event, retains formula modifiers, and ranks the minimum roll", () => {
  for (const [ability, type, expected] of [["sapsipper", "grass", "none"], ["stormdrain", "water", "none"], ["soundproof", "normal", "none"], ["dryskin", "water", "none"], ["dryskin", "fire", "dryskin"], ["thickfat", "ice", "thickfat"], ["levitate", "ground", "levitate"]]) {
    const state = fixture();
    state.combatantStates.c.currentAbilityId = ability;
    state.combatantStates.c.hp = { min: 45, max: 45 };
    const plan = { game: { battleFormat: "triples" }, combatants: { c: { side: "player" }, e: { side: "enemy" } } };
    const dataset = { abilityKnowledgePolicy: policy, get: () => ({ id: "probe", type, category: "special", basePower: 80 }) };
    let actual;
    const provider = createGen5QueryProvider({ plan, state, dataset, actorEntry: { combatantKey: "e" }, damageAdapter: { calculate: request => { actual = request.defenderState.currentAbilityId; return { status: "ok", damage: [40, 50] }; } } });
    const metadata = { context: { candidate: { action: { canonicalMoveId: "probe", targetCombatantKey: "c" } } } };
    assert.equal(provider["gen5.command.0x36"]("target", metadata), false, "a high-roll-only KO is not an AI minimum-roll KO");
    assert.equal(actual, expected, `${ability}/${type}`);
    assert.equal(state.combatantStates.c.currentAbilityId, ability, "actual ability must remain untouched");
  }
});

test("Shift, Ally Switch and normal switching retain memory at the field position; fainting clears only that position", () => {
  const state = fixture();
  initializeAbilityKnowledge(state, policy);
  observeAbilityEvent(state, { eventType: "move-immune", targetKey: "c", metadata: { abilityId: "sapsipper" } }, policy);
  [state.active.playerCombatantKeys[1], state.active.playerCombatantKeys[2]] = [state.active.playerCombatantKeys[2], state.active.playerCombatantKeys[1]];
  observeAbilityEvent(state, { eventType: "shift", actorKey: "c", metadata: { fromSlot: 2, toSlot: 1 } }, policy);
  assert.deepEqual(state.trainerAiBelief.abilityByPosition.player, [null, null, "sapsipper"]);
  state.active.playerCombatantKeys[2] = "reserve";
  observeAbilityEvent(state, { eventType: "switch", actorKey: "reserve" }, policy);
  assert.equal(state.trainerAiBelief.abilityByPosition.player[2], "sapsipper");
  state.combatantStates.reserve.hp = { min: 0, max: 0 };
  clearFaintedAbilityKnowledge(state, policy);
  assert.deepEqual(state.trainerAiBelief.abilityByPosition.player, [null, null, null]);
});

test("move names and mere presence do not reveal abilities; explicit entry announcements do", () => {
  const state = fixture();
  observeAbilityEvent(state, { eventType: "stat-stage-change", actorKey: "c", targetKey: "c", metadata: { cause: "swordsdance" } }, policy);
  assert.equal(state.trainerAiBelief.abilityByPosition.player[2], null);
  assert.equal(entryAbilityAnnouncement(state, "c", policy), null);
  observeAbilityEvent(state, entryAbilityAnnouncement(state, "a", policy), policy);
  assert.equal(state.trainerAiBelief.abilityByPosition.player[0], "pressure");
});

test("actual Grass immunity resolves normally and records Sap Sipper for the following AI pass", () => {
  const { plan, dataset, players, enemies } = fixturePlan();
  dataset.abilityKnowledgePolicy = policy;
  const state = plan.stateNodes[plan.initialStateNodeId];
  const playerKey = players[0].combatantKey;
  const enemyKey = enemies[0].combatantKey;
  state.combatantStates[playerKey].currentAbilityId = "sapsipper";
  dataset.indexes.moves.set("tackle", { ...dataset.get("moves", "tackle"), type: "grass" });
  initializeAbilityKnowledge(state, policy);
  const move = (actorKey, targetKey) => ({ actionType: "move", actorKey, moveId: "tackle", targetKeys: [targetKey], mechanicActivations: [], declaredAtStateHash: state.stateHash });
  const outcomes = resolveTurn({ plan, parentStateNodeId: state.stateNodeId, dataset, damageAdapter: damageAdapter(() => [10]), actions: { player: move(playerKey, enemyKey), enemy: move(enemyKey, playerKey) } });
  assert.ok(outcomes.length);
  for (const outcome of outcomes) {
    assert.equal(outcome.state.trainerAiBelief.abilityByPosition.player[0], "sapsipper");
    assert.equal(outcome.state.combatantStates[playerKey].hp.max, state.combatantStates[playerKey].hp.max);
    assert.equal(outcome.state.combatantStates[playerKey].statStages.atk, 1);
    assert.ok(outcome.events.some(event => event.metadata?.abilityObservation?.abilityId === "sapsipper"));
  }
  assert.equal(state.trainerAiBelief.abilityByPosition.player[0], null, "preview must not write parent memory");
});
