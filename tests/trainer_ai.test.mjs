import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { analyzeTrainerAi, createPlatinumQueryProvider, loadTrainerAiDocumentation } from "../src/adapters/trainer_ai.js";
import { loadStandardizedDataset } from "../src/adapters/standardized_dataset.js";
import { normalizePlayerCollection, normalizeTrainerRoster, snapshotFingerprint } from "../src/adapters/combatant_ingest.js";
import { createPlanDocument } from "../src/core/plan.js";
import { fixturePlan, fixtureRotationPlan } from "./helpers.mjs";
import { trappingAbilityBlocksSwitch } from "../src/rulesets/ability_rules.js";

const generatedRoot = fileURLToPath(new URL("../src/generated/trainer-ai/", import.meta.url));
const generatedDatasetRoot = fileURLToPath(new URL("../src/generated/datasets/renegade-platinum/", import.meta.url));
const generatedVw2rDatasetRoot = fileURLToPath(new URL("../src/generated/datasets/volt-white-2r/", import.meta.url));

function generatedEvaluator() {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/generated/battle-mechanics/trainer_ai/trainer_ai_evaluator.js", import.meta.url)), "utf8");
  const sandbox = { globalThis: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "trainer_ai_evaluator.js" });
  return sandbox.globalThis.TrainerAiEvaluator;
}

async function generatedFetch(url) {
  const relative = new URL(url).pathname.replace(/^.*\/trainer-ai\//, "");
  const file = path.join(generatedRoot, ...relative.split("/"));
  return { ok: fs.existsSync(file), status: fs.existsSync(file) ? 200 : 404, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
}

async function generatedDatasetFetch(url) {
  const file = path.join(generatedDatasetRoot, path.basename(new URL(url).pathname));
  return { ok: fs.existsSync(file), status: fs.existsSync(file) ? 200 : 404, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
}

async function generatedVw2rDatasetFetch(url) {
  const file = path.join(generatedVw2rDatasetRoot, path.basename(new URL(url).pathname));
  return { ok: fs.existsSync(file), status: fs.existsSync(file) ? 200 : 404, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
}

function createVw2rAiPlan(dataset, trainerId, playerCount = 1) {
  const players = normalizePlayerCollection({
    collection: Array.from({ length: playerCount }, (_, index) => ({
      uniqueKey: `gen5-query-player-${index + 1}`,
      speciesId: "snivy",
      species: "Snivy",
      displayName: "Snivy",
      level: 10,
      nature: "Hardy",
      ability: "Overgrow",
      item: null,
      ivs: { hp: 31, at: 31, df: 31, sa: 31, sd: 31, sp: 31 },
      evs: { hp: 0, at: 0, df: 0, sa: 0, sd: 0, sp: 0 },
      moves: ["tackle", "growl"],
      storage: "party",
      slot: index + 1
    }))
  }, dataset);
  const enemies = normalizeTrainerRoster(trainerId, null, dataset);
  return createPlanDocument({
    dataset,
    trainerId,
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: snapshotFingerprint(players, enemies, "2026-09-03T00:00:00.000Z"),
    now: "2026-09-03T00:00:00.000Z"
  });
}

function createRenegadeAiPlan(dataset, trainerId = "renegade-platinum-trainer-0529") {
  const players = normalizePlayerCollection({
    collection: [{
      uniqueKey: "platinum-query-player",
      speciesId: "chimchar",
      species: "Chimchar",
      displayName: "Chimchar",
      level: 33,
      nature: "Hardy",
      ability: "Blaze",
      item: null,
      ivs: { hp: 31, at: 31, df: 31, sa: 31, sd: 31, sp: 31 },
      evs: { hp: 0, at: 0, df: 0, sa: 0, sd: 0, sp: 0 },
      moves: ["scratch", "leer"],
      storage: "party",
      slot: 1
    }]
  }, dataset);
  const enemies = normalizeTrainerRoster(trainerId, null, dataset);
  return createPlanDocument({
    dataset,
    trainerId,
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: snapshotFingerprint(players, enemies, "2026-09-03T00:00:00.000Z"),
    now: "2026-09-03T00:00:00.000Z"
  });
}

async function simpleActionFixture(format = "doubles") {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/vw2r", fetchImpl: generatedVw2rDatasetFetch });
  const trainerId = "vw2r-trainer-0073";
  const battleProfile = dataset.trainer(trainerId).battleProfiles[dataset.mechanics.trainerBattleProfile];
  battleProfile.format = format === "triples" ? "triple" : "double";
  battleProfile.aiMask = 0;
  battleProfile.aiFlagIds = [];
  const plan = createVw2rAiPlan(dataset, trainerId, format === "triples" ? 3 : 2);
  const state = plan.stateNodes[plan.initialStateNodeId];
  for (const key of state.active.enemyCombatantKeys) {
    const mon = state.combatantStates[key];
    mon.moveSetOverride = [{ moveId: "tackle", maxPp: 35 }, { moveId: "growl", maxPp: 40 }];
    mon.movePp = { tackle: 35, growl: 40 };
    mon.volatileConditions.noSwitch = true;
  }
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", fetchImpl: generatedFetch });
  return { plan, state, dataset, ai, battleProfile, evaluator: generatedEvaluator(),
    damageAdapter: { calculate: ({ move }) => move.category === "status" ? { status: "status" } : { status: "ok", damage: [10] } } };
}

test("forecast-only midpoint HP is rounded down, disclosed, and never mutates planner ranges", async () => {
  const fixture = await simpleActionFixture();
  const key = fixture.state.active.playerCombatantKeys[0];
  fixture.state.combatantStates[key].hp = { min: 78, max: 81, maxHp: 90 };
  fixture.state.combatantStates[key].hpDistribution = [{ value: 78, probability: 0.9 }, { value: 81, probability: 0.1 }];
  const before = JSON.stringify(fixture.plan);
  const result = analyzeTrainerAi(fixture);
  assert.equal(JSON.stringify(fixture.plan), before);
  assert.equal(result.assumptions[0].assumedHp, 79);
  assert.match(result.assumptionNote, /78–81/);
  assert.match(result.assumptionNote, /including Guaranteed/);
  assert.equal(result.exactActionProbabilities, false);
  assert.ok(result.actors.every(actor => actor.forecastStatus === "available"));
  assert.ok(result.actors.every(actor => actor.forecastBasis.hpAssumptions[0].assumedHp === 79));
  assert.ok(result.replacementForecasts.every(row => row.basis.hpAssumptions[0].assumedHp === 79));
  fixture.state.combatantStates[key].hp = { min: 79, max: 79, maxHp: 90 };
  assert.equal(analyzeTrainerAi(fixture).assumptionNote, undefined);
});

test("choice lock restricts moves but does not preempt trainer items; recharge emits no malformed move", async () => {
  const fixture = await simpleActionFixture();
  const key = fixture.state.active.enemyCombatantKeys[1];
  const mon = fixture.state.combatantStates[key];
  mon.currentItemId = "choicescarf";
  mon.itemState = "held";
  mon.volatileConditions.choiceLockedMoveId = "tackle";
  mon.hp = { min: 1, max: 1, maxHp: 100 };
  mon.hpDistribution = [{ value: 1, probability: 1 }];
  fixture.battleProfile.bagItemIds = ["superpotion"];
  let actor = analyzeTrainerAi(fixture).actors.find(actor => actor.combatantKey === key);
  assert.equal(actor.actions[0].action.type, "item");
  fixture.battleProfile.bagItemIds = [];
  actor = analyzeTrainerAi(fixture).actors.find(actor => actor.combatantKey === key);
  assert.deepEqual([...new Set(actor.actions.map(row => row.action.moveId))], ["tackle"]);
  mon.volatileConditions.rechargeRequired = true;
  mon.movePp.tackle = 0;
  fixture.battleProfile.bagItemIds = ["superpotion"];
  actor = analyzeTrainerAi(fixture).actors.find(actor => actor.combatantKey === key);
  assert.equal(actor.actions.length, 1);
  assert.equal(actor.actions[0].action.type, "recharge");
  assert.equal(actor.actions[0].action.moveId, undefined);
  assert.equal(actor.actions[0].turnLikelihood.label, "Guaranteed");
  delete mon.volatileConditions.rechargeRequired;
  delete mon.volatileConditions.noSwitch;
  mon.volatileConditions.choiceLockedMoveId = "growl";
  fixture.battleProfile.bagItemIds = [];
  actor = analyzeTrainerAi(fixture).actors.find(actor => actor.combatantKey === key);
  assert.equal(actor.forecastStatus, "available");
  const switchWeight = actor.actions.filter(row => row.action.type === "switch").reduce((sum, row) => sum + row.turnProbability, 0);
  assert.equal(switchWeight, 0.5, "choice-lock status switching must be evaluated before the remaining move outcomes");
});

test("trapping checks distinguish grounded, airborne, Steel, same-ability and suppressed states", () => {
  const target = { currentTypeIds: ["normal"], currentAbilityId: "runaway", itemState: "held", volatileConditions: {} };
  const block = (ability, overrides = {}, sourceOverrides = {}) => trappingAbilityBlocksSwitch({
    sourceState: { currentAbilityId: ability, ...sourceOverrides }, targetState: { ...target, ...overrides }, fieldState: { global: {} }
  });
  assert.equal(block("arenatrap"), "arenatrap");
  assert.equal(block("arenatrap", { currentTypeIds: ["flying"] }), null);
  assert.equal(block("arenatrap", { currentAbilityId: "levitate" }), null);
  assert.equal(block("arenatrap", { currentItemId: "airballoon" }), null);
  assert.equal(block("arenatrap", { currentItemId: "ironball", currentTypeIds: ["flying"] }), "arenatrap");
  assert.equal(block("arenatrap", { currentItemId: "ironball", currentTypeIds: ["flying"], currentAbilityId: "klutz" }), null);
  assert.equal(block("arenatrap", { currentItemId: "airballoon", volatileConditions: { embargoTurns: 2 } }), "arenatrap");
  assert.equal(block("arenatrap", { volatileConditions: { magnetRiseTurns: 2 } }), null);
  assert.equal(block("arenatrap", { volatileConditions: { telekinesisTurns: 2 } }), null);
  assert.equal(block("magnetpull"), null);
  assert.equal(block("magnetpull", { currentTypeIds: ["steel"] }), "magnetpull");
  assert.equal(block("shadowtag", { currentAbilityId: "shadowtag" }), null);
  assert.equal(block("shadowtag", {}, { abilitySuppressed: true }), null);
});

test("Gen 5 forecasts evaluate trapping legality instead of returning a blanket forecast error", async () => {
  const fixture = await simpleActionFixture();
  const key = fixture.state.active.enemyCombatantKeys[1];
  const mon = fixture.state.combatantStates[key];
  delete mon.volatileConditions.noSwitch;
  mon.volatileConditions.perishTurns = 1;
  mon.currentTypeIds = ["flying"];
  fixture.state.combatantStates[fixture.state.active.playerCombatantKeys[0]].currentAbilityId = "arenatrap";
  let actor = analyzeTrainerAi(fixture).actors.find(actor => actor.combatantKey === key);
  assert.equal(actor.forecastStatus, "available");
  assert.ok(actor.actions.every(row => row.action.type === "switch"));
  mon.currentTypeIds = ["normal"];
  actor = analyzeTrainerAi(fixture).actors.find(actor => actor.combatantKey === key);
  assert.ok(actor.actions.every(row => row.action.type === "move"));
  mon.currentItemId = "shedshell";
  mon.itemState = "held";
  actor = analyzeTrainerAi(fixture).actors.find(actor => actor.combatantKey === key);
  assert.ok(actor.actions.every(row => row.action.type === "switch"));
});

test("Triples item priority follows positions, not reverse PLC slot numbers", async () => {
  const fixture = await simpleActionFixture("triples");
  assert.equal(fixture.plan.game.battleFormat, "triples");
  fixture.battleProfile.bagItemIds = ["superpotion"];
  for (const key of fixture.state.active.enemyCombatantKeys) {
    const mon = fixture.state.combatantStates[key];
    mon.hp = { min: 1, max: 1, maxHp: 100 };
    mon.hpDistribution = [{ value: 1, probability: 1 }];
  }
  const result = analyzeTrainerAi(fixture);
  assert.equal(result.status, "exact");
  const recipients = result.actors.filter(actor => actor.actions.some(row => row.action.type === "item"));
  assert.deepEqual(recipients.map(actor => actor.slot), [0], "enemy slot 0 is the rightmost Triple position");
});

test("simultaneous fainted slots reserve distinct replacements in every joint outcome", async () => {
  const fixture = await simpleActionFixture();
  for (const key of fixture.state.active.enemyCombatantKeys) {
    fixture.state.combatantStates[key].hp = { min: 0, max: 0, maxHp: 100 };
  }
  const result = analyzeTrainerAi(fixture);
  assert.equal(result.replacementForecasts.length, 2);
  assert.ok(result.replacementForecasts.every(row => row.status === "available"));
  assert.ok(result.jointReplacementOutcomes.length > 0);
  let total = 0;
  for (const outcome of result.jointReplacementOutcomes) {
    assert.equal(new Set(outcome.actions.map(action => action.partySlot)).size, 2);
    total += outcome.probability.decimal;
  }
  assert.ok(Math.abs(total - 1) < 1e-12);
});

test("flag 4 explains the reached first-turn damage branch, not its historical rival-battle label", async () => {
  const fixture = await simpleActionFixture();
  fixture.battleProfile.aiMask = 16;
  fixture.battleProfile.aiFlagIds = ["flag4"];
  let result = analyzeTrainerAi(fixture);
  for (const actor of result.actors) {
    const move = actor.moves.find(move => move.moveId === "tackle");
    assert.match(move.explanation, /First-turn preference for damaging moves/);
    assert.doesNotMatch(move.explanation, /Bianca|Cheren/);
    assert.ok(move.incentiveLedger.adjustments.some(reason => reason.delta === 1 && reason.reasonCode === "gen5-first-turn-damaging-move"));
    assert.ok(move.incentiveLedger.adjustments.every(reason => reason.probability));
    assert.ok(move.incentiveLedger.adjustments.some(reason => reason.title === 'First-Turn Preference'));
    assert.ok(move.incentiveLedger.finalScoreDistributions.length > 0);
    assert.ok(move.incentiveLedger.finalScoreDistributions.every(distribution => distribution.scores.every(score => score.modeledWeight)));
    assert.ok(move.incentiveLedger.finalScoreDistributions.some(distribution => distribution.influencesLikelihood));
    assert.equal(move.evaluatorStatus, "exact");
  }
  fixture.state.turnNumber = 1;
  result = analyzeTrainerAi(fixture);
  assert.ok(result.actors.every(actor => actor.moves.every(move => !/First-turn preference/.test(move.explanation))));
});

test('every generated Gen 4 and Gen 5 score instruction carries a specific educational description', async () => {
  for (const gameId of ['volt-white-2r', 'renegade-platinum', 'platinum-kaizo']) {
    const ai = await loadTrainerAiDocumentation({ baseUrl: 'http://fixture/trainer-ai', gameId, fetchImpl: generatedFetch });
    const evaluator = ai.evaluatorProfile;
    assert.ok(evaluator, gameId);
    const instructions = evaluator.programs.flatMap(program => program.instructions).filter(row => row.operation?.kind === 'adjust-score');
    assert.ok(instructions.length > 400, gameId);
    assert.equal(evaluator.scoreReasonCoverage.missingDescriptions, 0);
    for (const instruction of instructions) {
      assert.ok(instruction.reasonCode && instruction.summary, `${gameId}:${instruction.pc}`);
      assert.match(instruction.title, /^\S+(?: \S+){0,2}$/);
      assert.doesNotMatch(instruction.summary, /An enabled AI scoring rule|previously checked value/);
      assert.doesNotMatch(instruction.summary, /\brandom check\b|\bfresh\b|\d+\/256|\busually\b/i);
      for (const variant of instruction.reasonVariants || []) {
        assert.ok(variant.summary && typeof variant.branchTaken === 'boolean');
        assert.match(variant.title, /^\S+(?: \S+){0,2}$/);
        assert.doesNotMatch(variant.summary, /\brandom check\b|\bfresh\b|\d+\/256|\busually\b/i);
      }
    }
  }
});

test('random incentive descriptions use Chance to while retaining conditions and numeric probability semantics', async () => {
  const ai = await loadTrainerAiDocumentation({ baseUrl: 'http://fixture/trainer-ai', gameId: 'volt-white-2r', fetchImpl: generatedFetch });
  const instructions = ai.evaluatorProfile.programs.flatMap(program => program.instructions);
  const resisted = instructions.find(row => row.reasonCode === 'gen5-resisted-half-damage');
  assert.equal(resisted.title, 'Resisted Damage');
  assert.match(resisted.summary, /^Chance to subtract 1 point because the target takes half damage and is not expected to faint, while another opponent remains active\.$/);
  const status = instructions.find(row => row.reasonCode === 'gen5-status-target-half-hp');
  assert.match(status.summary, /^Chance to add 1 point.*non-damaging move.*half HP or less/);
  const deterministic = instructions.find(row => row.reasonCode === 'gen5-first-turn-damaging-move');
  assert.equal(deterministic.summary, 'First-turn preference for damaging moves.');
  assert.ok(instructions.some(row => row.operation.kind === 'branch-random' && Object.values(row.arguments).some(argument => argument.value === 192)), 'exact random threshold stays in executable data');
});

test("generated VW2R AI binding, Gen 5 profile, and semantic layer load as one checked contract", async () => {
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", fetchImpl: generatedFetch });
  assert.equal(ai.binding.gameId, "volt-white-2r");
  assert.equal(ai.binding.inheritance.profileId, ai.profile.profileId);
  assert.equal(ai.semantics.profileId, ai.profile.profileId);
  assert.equal(ai.binding.predictionReadiness.exactActionProbabilities, true);
  assert.equal(ai.binding.predictionReadiness.unresolvedActiveOpcodeCount, 0);
  assert.deepEqual(ai.binding.predictionReadiness.unclassifiedActiveTrainerItemNumericIds, []);
  assert.equal(ai.binding.consumerActivation.enabled, true);
});

test("generation-shared AI bindings load for added games while exact predictions remain fail closed", async () => {
  const ai = await loadTrainerAiDocumentation({
    baseUrl: "http://fixture/trainer-ai",
    gameId: "fire-red-omega",
    generation: 3,
    fetchImpl: generatedFetch,
  });
  assert.equal(ai.binding.gameId, "fire-red-omega");
  assert.equal(ai.profile.profileId, ai.binding.inheritance.baseProfile);
  assert.equal(ai.semantics, null);
  assert.equal(ai.binding.predictionReadiness.exactActionProbabilities, false);
  assert.ok(ai.profile.predictionReadiness.blockers.length > 0);
});

function aiFixture() {
  return {
    binding: { predictionReadiness: { exactActionProbabilities: false, blockers: ["Some active engine commands remain unresolved."] } },
    profile: {
      predictionReadiness: { exactActionProbabilities: false },
      actionModel: { moveSelection: { initialScorePerMoveTarget: 100 } },
      scripts: [{ id: "flag0", name: "No Effect", summary: "Discourages moves that fail or have no effect." }]
    },
    semantics: {}
  };
}

test("AI analysis keeps unsupported semantics as forecast errors instead of expected probability gaps", () => {
  const { plan, dataset } = fixturePlan();
  dataset.trainer(plan.game.trainerId).battleProfiles = { challenge: { aiMask: 0, aiFlagIds: [] } };
  const state = plan.stateNodes[plan.initialStateNodeId];
  const enemyKey = state.active.enemyCombatantKeys[0];
  const oneMove = analyzeTrainerAi({ plan, state, dataset, ai: aiFixture() });
  assert.equal(oneMove.actors[0].moves[0].conditionalProbability, 1);
  assert.match(oneMove.actors[0].moves[0].explanation, /only usable move/i);

  plan.combatants[enemyKey].moves.push({ moveId: "protect", maxPp: 10 });
  state.combatantStates[enemyKey].movePp.protect = 10;
  const uniform = analyzeTrainerAi({ plan, state, dataset, ai: aiFixture() });
  assert.deepEqual(uniform.actors[0].moves.map(move => move.conditionalProbability), [0.5, 0.5]);

  dataset.trainer(plan.game.trainerId).battleProfiles.challenge = { aiMask: 1, aiFlagIds: ["flag0"] };
  const unresolved = analyzeTrainerAi({ plan, state, dataset, ai: aiFixture() });
  assert.deepEqual(unresolved.actors[0].moves.map(move => move.conditionalProbability), [null, null]);
  assert.equal(unresolved.status, "error");
  assert.match(unresolved.actors[0].moves[0].explanation, /could not be evaluated/i);
  assert.match(unresolved.scripts[0].summary, /fail or have no effect/i);
});

test("Rotation AI notes separate the exact actor lottery from conditional move scoring", () => {
  const { plan, dataset } = fixtureRotationPlan();
  dataset.trainer(plan.game.trainerId).battleProfiles.challenge = { aiMask: 0, aiFlagIds: [] };
  const state = plan.stateNodes[plan.initialStateNodeId];
  const result = analyzeTrainerAi({ plan, state, dataset, ai: aiFixture() });
  assert.equal(result.rotation.livingFieldCount, 3);
  assert.equal(result.rotation.actorProbability, 1 / 3);
  assert.equal(result.actors.length, 3);
  assert.ok(result.actors.every(actor => actor.actorProbability === 1 / 3));
  assert.match(result.rotation.explanation, /equally likely to act/i);
});

test("the generated Gen 5 profile executes through the copied Battle Mechanics evaluator", async () => {
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", fetchImpl: generatedFetch });
  const { plan, dataset } = fixturePlan();
  dataset.trainer(plan.game.trainerId).battleProfiles = { challenge: { aiMask: 0, aiFlagIds: [], bagItemIds: [] } };
  const state = plan.stateNodes[plan.initialStateNodeId];
  const enemyKey = state.active.enemyCombatantKeys[0];
  plan.combatants[enemyKey].moves.push({ moveId: "protect", maxPp: 10 });
  state.combatantStates[enemyKey].movePp.protect = 10;

  const result = analyzeTrainerAi({ plan, state, dataset, ai, evaluator: generatedEvaluator() });
  assert.equal(ai.evaluatorProfile.profileId, "gen5-b2w2-trainer-ai-evaluator-v1alpha1");
  assert.equal(result.status, "exact");
  assert.equal(result.exactActionProbabilities, true);
  assert.deepEqual(result.actors[0].moves.map(move => move.conditionalProbability), [0.5, 0.5]);
  assert.ok(result.actors[0].moves.every(move => move.evaluatorStatus === "exact"));
  assert.ok(result.actors[0].moves.every(move => move.turnLikelihood.label === "Likely"));
  assert.ok(result.actors[0].moves.every(move => move.equalLikelihood.count === 2));
  assert.match(result.actors[0].moves[0].explanation, /Starts at 100/i);
});

test("every executable generated Gen 4 and Gen 5 Dataset known answer passes the shared evaluator", () => {
  const evaluator = generatedEvaluator();
  const generation4 = JSON.parse(fs.readFileSync(path.join(generatedRoot, "gen4", "trainer_ai.json"), "utf8"));
  const generation5 = JSON.parse(fs.readFileSync(path.join(generatedRoot, "gen5", "trainer_ai.json"), "utf8"));
  const profiles = [generation5.evaluator, ...generation4.profiles.map(profileEntry => profileEntry.evaluator)];
  const expectedCaseCounts = new Map([
    ["gen5-b2w2-trainer-ai-evaluator-v1alpha1", 8],
    ["gen4-platinum-trainer-ai-evaluator-v1alpha1", 9],
    ["gen4-renegade-platinum-trainer-ai-evaluator-v1alpha1", 10],
    ["gen4-hgss-trainer-ai-evaluator-v1alpha1", 1]
  ]);
  for (const profile of profiles) {
    const validation = evaluator.runValidationCases({ profile });
    assert.equal(validation.total, expectedCaseCounts.get(profile.profileId), profile.profileId);
    assert.equal(validation.passed, true, JSON.stringify(validation.results.filter(result => !result.passed), null, 2));
  }
});

test("the PLC Gen 5 query bridge executes a real VW2R flag0/flag1/flag2 trainer program", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/vw2r", fetchImpl: generatedVw2rDatasetFetch });
  const trainerId = "vw2r-trainer-0011";
  const plan = createVw2rAiPlan(dataset, trainerId);
  const state = plan.stateNodes[plan.initialStateNodeId];
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", fetchImpl: generatedFetch });
  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: () => ({ status: "ok", damage: [10] }) }
  });
  assert.equal(result.status, "exact");
  assert.equal(result.exactActionProbabilities, true);
  const probabilities = result.actors[0].moves.map(move => move.conditionalProbability);
  assert.deepEqual(probabilities.map(value => Math.round(value * 3)), [1, 1, 0, 1]);
  assert.ok(result.actors[0].moves.every(move => move.evaluatorStatus === "exact"));
});

test("the PLC full Gen 5 action forecast gives a usable trainer item precedence over every move", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/vw2r", fetchImpl: generatedVw2rDatasetFetch });
  const plan = createVw2rAiPlan(dataset, "vw2r-trainer-0044");
  const state = plan.stateNodes[plan.initialStateNodeId];
  const actorKey = state.active.enemyCombatantKeys[0];
  const maximumHp = state.combatantStates[actorKey].hp.maxHp;
  const currentHp = Math.floor(maximumHp / 4);
  state.combatantStates[actorKey].hp = { min: currentHp, max: currentHp, maxHp: maximumHp };
  state.combatantStates[actorKey].hpDistribution = [{ value: currentHp, probability: 1 }];
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", fetchImpl: generatedFetch });
  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: () => ({ status: "ok", damage: [10] }) }
  });
  assert.equal(result.status, "exact");
  assert.equal(result.actors[0].actions.length, 1);
  assert.equal(result.actors[0].actions[0].action.type, "item");
  assert.equal(result.actors[0].actions[0].action.itemToken, "superpotion");
  assert.equal(result.actors[0].actions[0].turnProbability, 1);
  assert.ok(result.actors[0].moves.every(move => move.turnProbability === 0));
});

test("the PLC full Gen 5 action forecast gives a final Perish Song switch precedence over items and moves", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/vw2r", fetchImpl: generatedVw2rDatasetFetch });
  const plan = createVw2rAiPlan(dataset, "vw2r-trainer-0011");
  const state = plan.stateNodes[plan.initialStateNodeId];
  const actorKey = state.active.enemyCombatantKeys[0];
  state.combatantStates[actorKey].volatileConditions.perishTurns = 1;
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", fetchImpl: generatedFetch });
  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: () => ({ status: "ok", damage: [10] }) }
  });
  assert.equal(result.status, "exact");
  assert.equal(result.actors[0].actions.length, 1);
  assert.equal(result.actors[0].actions[0].action.type, "switch");
  assert.equal(result.actors[0].actions[0].action.reason, "perish-song");
  assert.equal(result.actors[0].actions[0].turnProbability, 1);
  assert.ok(result.actors[0].moves.every(move => move.turnProbability === 0));
});

test("the PLC presents Gen 5 post-faint replacement selection separately from turn actions", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/vw2r", fetchImpl: generatedVw2rDatasetFetch });
  const plan = createVw2rAiPlan(dataset, "vw2r-trainer-0011");
  const state = plan.stateNodes[plan.initialStateNodeId];
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", fetchImpl: generatedFetch });
  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: () => ({ status: "ok", damage: [10] }) }
  });
  assert.equal(result.replacementForecasts.length, 1);
  assert.equal(result.replacementForecasts[0].status, "available");
  assert.equal(result.replacementForecasts[0].options.length, 1);
  assert.equal(result.replacementForecasts[0].options[0].name, "Houndour");
  assert.equal(result.replacementForecasts[0].options[0].likelihood.label, "Guaranteed");
});

test("VW2R replacement scoring treats zero-base-power Physical and Special moves as damaging", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/vw2r", fetchImpl: generatedVw2rDatasetFetch });
  const players = normalizePlayerCollection({
    collection: [
      {
        uniqueKey: "burgh-cryogonal",
        speciesId: "cryogonal",
        displayName: "Cryogonal",
        level: 29,
        nature: "Hardy",
        ability: "Levitate",
        item: null,
        ivs: { hp: 31, at: 31, df: 31, sa: 31, sd: 31, sp: 31 },
        evs: { hp: 0, at: 0, df: 0, sa: 0, sd: 0, sp: 0 },
        moves: ["icebeam"],
        storage: "party",
        slot: 1
      },
      {
        uniqueKey: "burgh-clefable",
        speciesId: "clefable",
        displayName: "Clefable",
        level: 29,
        nature: "Hardy",
        ability: "Magic Guard",
        item: null,
        ivs: { hp: 31, at: 31, df: 31, sa: 31, sd: 31, sp: 31 },
        evs: { hp: 0, at: 0, df: 0, sa: 0, sd: 0, sp: 0 },
        moves: ["nastyplot"],
        storage: "party",
        slot: 2
      }
    ]
  }, dataset);
  const trainerId = "vw2r-trainer-0073";
  const enemies = normalizeTrainerRoster(trainerId, null, dataset);
  const plan = createPlanDocument({
    dataset,
    trainerId,
    playerCombatants: players,
    enemyCombatants: enemies,
    sourceSnapshot: snapshotFingerprint(players, enemies, "2026-09-04T00:00:00.000Z"),
    now: "2026-09-04T00:00:00.000Z"
  });
  const state = plan.stateNodes[plan.initialStateNodeId];
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", fetchImpl: generatedFetch });
  const metalBurst = dataset.get("moves", "metalburst");
  assert.equal(metalBurst.basePower, 0);
  assert.equal(metalBurst.category, "physical");

  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: ({ move }) => move.category === "status" ? { status: "status" } : { status: "ok", damage: [10] } }
  });
  assert.equal(result.status, "exact");
  assert.deepEqual(result.actorSelectionPass, {
    activePokemonOrder: "right-to-left",
    switchReservationsModeled: true,
    trainerItemConsumptionModeled: true
  });
  assert.ok(result.actors.every(actor => actor.forecastStatus === "available"));
  const mothimReplacement = result.replacementForecasts.find(entry => entry.name === "Mothim");
  assert.equal(mothimReplacement.status, "available");
  assert.deepEqual(
    mothimReplacement.options.map(option => ({ name: option.name, weight: option.modeledWeight, equalCount: option.equalLikelihood.count })),
    [
      { name: "Escavalier", weight: 0.5, equalCount: 2 },
      { name: "Vespiquen", weight: 0.5, equalCount: 2 }
    ]
  );
  assert.deepEqual(
    mothimReplacement.options.map(option => ({
      name: option.name,
      references: option.highestDamageReferences.map(reference => ({ move: reference.moveName, slot: reference.targetSlot + 1 }))
    })),
    [
      { name: "Escavalier", references: [{ move: "Metal Burst", slot: 2 }] },
      { name: "Vespiquen", references: [{ move: "Power Gem", slot: 1 }] }
    ]
  );

  for (const actorKey of state.active.enemyCombatantKeys) state.combatantStates[actorKey].volatileConditions.perishTurns = 1;
  const forcedSwitches = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: ({ move }) => move.category === "status" ? { status: "status" } : { status: "ok", damage: [10] } }
  });
  const selectedPartySlots = forcedSwitches.actors.map(actor => actor.actions.find(action => action.action?.type === "switch")?.action.partySlot);
  assert.equal(forcedSwitches.status, "exact");
  assert.equal(new Set(selectedPartySlots).size, 2, "later actors must exclude party slots reserved by earlier switches");
});

test("the VW2R active-Pokemon pass consumes trainer items once in right-to-left order", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/vw2r", fetchImpl: generatedVw2rDatasetFetch });
  const trainerId = "vw2r-trainer-0073";
  const plan = createVw2rAiPlan(dataset, trainerId, 2);
  const state = plan.stateNodes[plan.initialStateNodeId];
  const battleProfile = dataset.trainer(trainerId).battleProfiles[dataset.mechanics.trainerBattleProfile];
  battleProfile.bagItemIds = ["superpotion"];
  battleProfile.aiMask = 0;
  battleProfile.aiFlagIds = [];
  for (const actorKey of state.active.enemyCombatantKeys) {
    const actorState = state.combatantStates[actorKey];
    const maximumHp = actorState.hp.maxHp;
    const currentHp = Math.floor(maximumHp / 4);
    actorState.hp = { min: currentHp, max: currentHp, maxHp: maximumHp };
    actorState.hpDistribution = [{ value: currentHp, probability: 1 }];
    actorState.volatileConditions.noSwitch = true;
    actorState.moveSetOverride = [{ moveId: "tackle", maxPp: 35 }];
    actorState.movePp = { tackle: 35 };
  }
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", fetchImpl: generatedFetch });
  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: ({ move }) => move.category === "status" ? { status: "status" } : { status: "ok", damage: [10] } }
  });
  const right = result.actors.find(actor => actor.slot === 1);
  const left = result.actors.find(actor => actor.slot === 0);
  assert.equal(result.status, "exact");
  assert.equal(right.actions.filter(action => action.action?.type === "item").length, 1);
  assert.equal(right.actions.find(action => action.action?.type === "item").action.itemToken, "superpotion");
  assert.equal(left.actions.filter(action => action.action?.type === "item").length, 0);
});

test("the full VW2R Rotation forecast resolves all three actors without blocking calculator work", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/vw2r", fetchImpl: generatedVw2rDatasetFetch });
  const plan = createVw2rAiPlan(dataset, "vw2r-trainer-0196", 3);
  const state = plan.stateNodes[plan.initialStateNodeId];
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", fetchImpl: generatedFetch });
  const started = performance.now();
  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: () => ({ status: "ok", damage: [10] }) }
  });
  assert.equal(result.status, "exact");
  assert.equal(result.exactActionProbabilities, true);
  assert.equal(result.actors.length, 3);
  assert.match(result.rotation.explanation, /equally likely to act/i);
  assert.ok(performance.now() - started < 5000, "Rotation Trainer AI evaluation exceeded the interactive budget");
});

test("the generated Renegade Platinum profile and every executable Dataset known answer run through the copied evaluator", async () => {
  const ai = await loadTrainerAiDocumentation({
    baseUrl: "http://fixture/trainer-ai",
    gameId: "renegade-platinum",
    generation: 4,
    fetchImpl: generatedFetch
  });
  const evaluator = generatedEvaluator();
  assert.equal(ai.evaluatorProfile.profileId, "gen4-renegade-platinum-trainer-ai-evaluator-v1alpha1");
  const validation = evaluator.runValidationCases({ profile: ai.evaluatorProfile });
  assert.equal(validation.total, 10);
  assert.equal(validation.passed, true, JSON.stringify(validation.results.filter(result => !result.passed), null, 2));
});

test("the PLC Platinum query provider binds canonical moves to numeric AI identity and answers state-backed damage ranking", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/rp", fetchImpl: generatedDatasetFetch });
  const trainerId = "renegade-platinum-trainer-0529";
  const plan = createRenegadeAiPlan(dataset, trainerId);
  const state = plan.stateNodes[plan.initialStateNodeId];
  const actorEntry = { slot: 0, combatantKey: state.active.enemyCombatantKeys[0] };
  const targetKey = state.active.playerCombatantKeys[0];
  const moves = plan.combatants[actorEntry.combatantKey].moves;
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", gameId: "renegade-platinum", generation: 4, fetchImpl: generatedFetch });
  const move = dataset.get("moves", "magicalleaf");
  const metadata = {
    profile: ai.evaluatorProfile,
    context: {
      candidate: {
        action: {
          type: "move",
          moveId: move.trainerAi.numericId,
          canonicalMoveId: move.id,
          target: 0,
          targetCombatantKey: targetKey,
          targetSlot: 0
        }
      }
    },
    locals: {}
  };
  const damageAdapter = { calculate: ({ move: selectedMove }) => selectedMove.id === "magicalleaf" ? { status: "ok", damage: [30] } : selectedMove.basePower ? { status: "ok", damage: [10] } : { status: "status" } };
  const queries = createPlatinumQueryProvider({ plan, state, dataset, actorEntry, moves, damageAdapter });
  metadata.evaluateQueryProgram = (programId, input) => generatedEvaluator().evaluateQueryProgram({ profile: ai.evaluatorProfile, programId, state: input });
  assert.equal(queries["platinum.command.IfMoveEqualTo"](move.trainerAi.numericId, metadata), true);
  assert.equal(queries["platinum.command.LoadCurrentMoveEffect"](metadata), move.trainerAi.effectId);
  assert.equal(queries["platinum.command.FlagMoveDamageScore"](0, metadata), 1, 'source AI damage ranks STAB Draining Kiss above Magical Leaf; the ordinary damage stub is not authority');
  assert.equal(queries["platinum.command.LoadBattlerAbility"](1, metadata), dataset.get("abilities", "cutecharm").romId);
  assert.equal(queries["platinum.command.LoadCurrentWeather"](metadata), 0, 'a normalized clear-weather object is source AI_WEATHER_CLEAR, not an unresolved object token');
  assert.equal(queries["platinum.command.CountAlivePartyBattlers"](1, metadata), Object.values(plan.combatants).filter(mon => mon.side === 'enemy').length - 1, 'the active actor is excluded from the party reserve count');
  assert.equal(queries["platinum.command.CheckIfHighestDamageWithPartner"](0, metadata), 1, 'own better move exits before querying the absent partner or consuming its random damage draws');
  metadata.context.candidate.action.canonicalMoveId = 'leer';
  metadata.context.candidate.action.moveId = dataset.get('moves', 'leer').trainerAi.numericId;
  assert.equal(queries["platinum.command.IfCurrentMoveKills"](0, metadata), false);
  assert.equal(queries["platinum.command.IfCurrentMoveDoesNotKill"](0, metadata), false, 'excluded status moves satisfy neither source damage branch');
});

test("Platinum post-KO fallback executes outgoing-stat damage without PP filtering and preserves both byte boundaries", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/rp", fetchImpl: generatedDatasetFetch });
  const plan = createRenegadeAiPlan(dataset, "renegade-platinum-trainer-0246");
  const state = plan.stateNodes[plan.initialStateNodeId];
  const actorEntry = { slot: 0, combatantKey: state.active.enemyCombatantKeys[0] };
  const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", gameId: "renegade-platinum", generation: 4, fetchImpl: generatedFetch });
  const engine = generatedEvaluator();
  const reserves = Object.values(plan.combatants).filter(mon => mon.side === "enemy" && mon.combatantKey !== actorEntry.combatantKey);
  assert.ok(reserves.length >= 2);
  for (const mon of Object.values(plan.combatants)) {
    const current = state.combatantStates[mon.combatantKey];
    current.currentTypeIds = ["normal"];
    current.currentAbilityId = "";
    current.currentItemId = null;
    current.itemState = "none";
    current.currentStats = { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 };
    current.moveSetOverride = [{ moveId: "growl", maxPp: 40 }];
  }
  plan.combatants[actorEntry.combatantKey].level = 50;
  state.combatantStates[reserves[1].combatantKey].moveSetOverride = [{ moveId: "tackle", maxPp: 35 }];
  state.combatantStates[reserves[1].combatantKey].movePp.tackle = 0;
  // Reserve stats must not enter the source bug's damage calculation.
  state.combatantStates[reserves[1].combatantKey].currentStats.atk = 1;
  const metadata = { profile: ai.evaluatorProfile, context: { state: { actor: { hp: 0 } } },
    evaluateQueryProgram: (programId, input) => engine.evaluateQueryProgram({ profile: ai.evaluatorProfile, programId, state: input }) };
  const queries = createPlatinumQueryProvider({ plan, state, dataset, actorEntry, moves: [], damageAdapter: { calculate() { throw new Error("Final damage calculator must not be used for this source bug"); } } });
  const result = queries["platinum.action.result"]("post-ko-replacement", metadata);
  assert.equal(result.reason, "post-ko-stage-two");
  assert.equal(result.partySlot, Number(reserves[1].source.trainerSlot) - 1);
  // Independently isolate the two C assignment boundaries. These mock raw
  // query results do not purport to be damage-formula known answers.
  metadata.evaluateQueryProgram = (_id, input) => input.move.id === 'tackle' ? 300 : 100;
  assert.equal(queries['platinum.action.result']('post-ko-replacement', metadata).partySlot, Number(reserves[0].source.trainerSlot) - 1, '300 truncates to 44 BEFORE STAB: 66 loses to 150');
  metadata.evaluateQueryProgram = (_id, input) => input.move.id === 'tackle' ? 100 : 200;
  assert.equal(queries['platinum.action.result']('post-ko-replacement', metadata).partySlot, Number(reserves[1].source.trainerSlot) - 1, '200 becomes 300 with STAB and truncates to 44 AFTER type calculation');
  const target = state.combatantStates[state.active.playerCombatantKeys[0]];
  target.currentTypeIds = ['grass', 'steel'];
  for (const reserve of reserves) state.combatantStates[reserve.combatantKey].moveSetOverride = [{ moveId: 'ember', maxPp: 25 }];
  state.combatantStates[reserves[0].combatantKey].currentTypeIds = ['fire'];
  state.combatantStates[reserves[1].combatantKey].currentTypeIds = ['ground'];
  const stageOne = queries['platinum.action.result']('post-ko-replacement', metadata);
  assert.equal(stageOne.reason, 'post-ko-stage-one');
  assert.equal(stageOne.partySlot, Number(reserves[1].source.trainerSlot) - 1, 'duplicate Fire typing scores 320 -> 64, below Ground 80');
});

test("the PLC full Renegade Platinum forecast resolves retail action precedence into qualitative guidance", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/rp", fetchImpl: generatedDatasetFetch });
  const plan = createRenegadeAiPlan(dataset);
  const state = plan.stateNodes[plan.initialStateNodeId];
  const ai = await loadTrainerAiDocumentation({
    baseUrl: "http://fixture/trainer-ai",
    gameId: "renegade-platinum",
    generation: 4,
    fetchImpl: generatedFetch
  });
  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: ({ move }) => Number(move.basePower) > 0 ? { status: "ok", damage: [10] } : { status: "status" } }
  });
  assert.ok(["exact", "modeled"].includes(result.status), JSON.stringify(result.actors));
  assert.equal(result.actors[0].actions.length, 4);
  assert.ok(result.actors[0].actions.every(action => action.action.type === "move"));
  assert.ok(Math.abs(result.actors[0].actions.reduce((sum, action) => sum + Number(action.modeledWeight.decimal), 0) - 1) < 1e-12);
  assert.ok(result.actors[0].moves.every(move => move.turnLikelihood?.label));
  assert.ok(result.actors[0].moves.every(move => /Starts at 100/i.test(move.explanation)));
});

test("Renegade Platinum random-correlated scoring becomes modeled hidden-RNG guidance", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/rp", fetchImpl: generatedDatasetFetch });
  const plan = createRenegadeAiPlan(dataset, "renegade-platinum-trainer-0001");
  const state = plan.stateNodes[plan.initialStateNodeId];
  const ai = await loadTrainerAiDocumentation({
    baseUrl: "http://fixture/trainer-ai",
    gameId: "renegade-platinum",
    generation: 4,
    fetchImpl: generatedFetch
  });
  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: ({ move }) => Number(move.basePower) > 0 ? { status: "ok", damage: [10] } : { status: "status" } }
  });
  assert.equal(result.status, "modeled", JSON.stringify(result.actors));
  assert.equal(result.exactActionProbabilities, false);
  assert.equal(result.actors[0].fullEvaluatorStatus, "modeled");
  assert.equal(result.actors[0].forecastBasis.kind, "deterministic-g4-seed-ensemble");
  assert.equal(result.actors[0].unresolvedActionProbability, 0);
  assert.ok(result.actors[0].moves.every(move => move.turnLikelihood?.label));
  assert.ok(result.actors[0].moves.every(move => /Starts at 100/i.test(move.explanation)));
});

test("the PLC presents an exact Renegade Platinum stage-one post-KO replacement forecast", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/rp", fetchImpl: generatedDatasetFetch });
  const plan = createRenegadeAiPlan(dataset, "renegade-platinum-trainer-0246");
  const state = plan.stateNodes[plan.initialStateNodeId];
  const ai = await loadTrainerAiDocumentation({
    baseUrl: "http://fixture/trainer-ai",
    gameId: "renegade-platinum",
    generation: 4,
    fetchImpl: generatedFetch
  });
  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: ({ move }) => Number(move.basePower) > 0 ? { status: "ok", damage: [10] } : { status: "status" } }
  });
  assert.equal(result.replacementForecasts[0].status, "available");
  assert.equal(result.replacementForecasts[0].options.length, 1);
  assert.equal(result.replacementForecasts[0].options[0].likelihood.label, "Guaranteed");
  assert.ok(result.replacementForecasts[0].options[0].name !== "Pokémon");
});

test('Platinum query bindings retain source volatile flags and Gyro Ball speed-cache values', async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: 'http://fixture/rp', fetchImpl: generatedDatasetFetch });
  const plan = createRenegadeAiPlan(dataset), state = plan.stateNodes[plan.initialStateNodeId];
  const actorEntry = { slot: 0, combatantKey: state.active.enemyCombatantKeys[0] }, targetKey = state.active.playerCombatantKeys[0];
  const ai = await loadTrainerAiDocumentation({ baseUrl: 'http://fixture/trainer-ai', gameId: 'renegade-platinum', generation: 4, fetchImpl: generatedFetch });
  const move = dataset.get('moves', 'gyroball');
  const metadata = { profile: ai.evaluatorProfile, context: { candidate: { action: { moveId: move.trainerAi.numericId, canonicalMoveId: 'gyroball', target: 0, targetCombatantKey: targetKey, targetSlot: 0 } } }, readMemory: id => ({ 'platinum.monSpeedValues.0': 160, 'platinum.monSpeedValues.1': 80 })[id] };
  const queries = createPlatinumQueryProvider({ plan, state, dataset, actorEntry, moves: [] });
  let power;
  metadata.evaluateQueryProgram = (_, input) => { power = input.move.power; return 1; };
  queries['platinum.command.IfCurrentMoveKills'](0, metadata);
  assert.equal(power, 51, '1 + floor(25 * cached target speed / cached actor speed)');
  const mon = state.combatantStates[actorEntry.combatantKey];
  for (const [field, token] of [['foresight', 'FORESIGHT'], ['defensecurl', 'DEFENSE_CURL'], ['thrashTurns', 'THRASH'], ['attractSourceKey', 'ATTRACT'], ['confusionCounterDistribution', 'CONFUSION']]) {
    mon.volatileConditions = { [field]: field === 'confusionCounterDistribution' ? [{ value: 2, probability: 1 }] : 1 };
    const mask = ai.evaluatorProfile.constants.numericByToken[`VOLATILE_CONDITION_${token}`];
    assert.equal(queries['platinum.command.IfVolatileStatus'](1, mask, metadata), true, field);
    assert.equal(queries['platinum.command.IfNotVolatileStatus'](1, mask, metadata), false, field);
  }
  mon.volatileConditions = { stockpileLayers: 2, mudsport: true };
  assert.equal(queries['platinum.command.LoadStockpileCount'](1, metadata), 2);
  assert.equal(queries['platinum.command.IfMoveEffect'](1, ai.evaluatorProfile.constants.numericByToken.MOVE_EFFECT_MUD_SPORT, metadata), true);
});

test("Platinum preserves the retail AI's naive Arena Trap gate even for Flying and Shed Shell", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/rp", fetchImpl: generatedDatasetFetch });
  const plan = createRenegadeAiPlan(dataset, "renegade-platinum-trainer-0246");
  const state = plan.stateNodes[plan.initialStateNodeId];
  const actorEntry = { slot: 0, combatantKey: state.active.enemyCombatantKeys[0] };
  const actor = state.combatantStates[actorEntry.combatantKey];
  actor.currentTypeIds = ["flying"];
  actor.currentItemId = "shedshell";
  actor.itemState = "held";
  actor.volatileConditions.perishTurns = 0;
  const opponent = state.combatantStates[state.active.playerCombatantKeys[0]];
  opponent.currentAbilityId = "arenatrap";
  const query = () => createPlatinumQueryProvider({ plan, state, dataset, actorEntry, moves: plan.combatants[actorEntry.combatantKey].moves,
    damageAdapter: { calculate: () => ({ status: "ok", damage: [10] }) } })["platinum.action.decision"]("voluntary-switch", {});
  assert.equal(query(), false, "the source AI declines a legal escape because of its naive gate");
  opponent.abilitySuppressed = true;
  assert.equal(query(), true, "suppressed abilities do not count; the Perish Song branch is then reached");
});

test("the PLC full Renegade Platinum forecast uses a qualifying trainer item after the switch check", async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: "http://fixture/rp", fetchImpl: generatedDatasetFetch });
  const plan = createRenegadeAiPlan(dataset);
  dataset.trainer(plan.game.trainerId).battleProfiles.default.bagItemIds = ["potion", null, null, null];
  const state = plan.stateNodes[plan.initialStateNodeId];
  const actorKey = state.active.enemyCombatantKeys[0];
  const maximumHp = state.combatantStates[actorKey].hp.maxHp;
  const currentHp = Math.max(1, maximumHp - 21);
  state.combatantStates[actorKey].hp = { min: currentHp, max: currentHp, maxHp: maximumHp };
  state.combatantStates[actorKey].hpDistribution = [{ value: currentHp, probability: 1 }];
  const ai = await loadTrainerAiDocumentation({
    baseUrl: "http://fixture/trainer-ai",
    gameId: "renegade-platinum",
    generation: 4,
    fetchImpl: generatedFetch
  });
  const result = analyzeTrainerAi({
    plan,
    state,
    dataset,
    ai,
    evaluator: generatedEvaluator(),
    damageAdapter: { calculate: ({ move }) => Number(move.basePower) > 0 ? { status: "ok", damage: [10] } : { status: "status" } }
  });
  assert.equal(result.status, "exact");
  assert.equal(result.actors[0].actions.length, 1);
  assert.equal(result.actors[0].actions[0].action.type, "item");
  assert.equal(result.actors[0].actions[0].action.itemToken, "potion");
  assert.equal(result.actors[0].actions[0].turnProbability, 1);
});

test('Platinum forced controllers preempt items, while Encore and Struggle follow them without incentive scores', async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: 'http://fixture/rp', fetchImpl: generatedDatasetFetch });
  const plan = createRenegadeAiPlan(dataset);
  const state = plan.stateNodes[plan.initialStateNodeId];
  const actorKey = state.active.enemyCombatantKeys[0], mon = state.combatantStates[actorKey];
  dataset.trainer(plan.game.trainerId).battleProfiles.default.bagItemIds = ['potion'];
  mon.hp = { min: 1, max: 1, maxHp: 100 };
  mon.volatileConditions.rechargeRequired = true;
  const ai = await loadTrainerAiDocumentation({ baseUrl: 'http://fixture/trainer-ai', gameId: 'renegade-platinum', generation: 4, fetchImpl: generatedFetch });
  const engine = generatedEvaluator();
  const evaluator = { ...engine, forecast: options => engine.forecast({ ...options, request: { ...options.request, state: { ...options.request.state, random: { g4LcrngSeed: 0 } } } }) };
  const run = () => analyzeTrainerAi({ plan, state, dataset, ai, evaluator, damageAdapter: { calculate() { throw new Error('Gen 4 AI may not use the normal damage calculator'); } } });
  assert.equal(run().actors[0].actions[0].action.type, 'recharge');
  mon.volatileConditions.rechargeRequired = false;
  mon.volatileConditions.chargingMoveId = 'fly';
  let forecast = run().actors[0];
  assert.equal(forecast.actions[0].action.canonicalMoveId, 'fly');
  assert.equal(forecast.moves.find(move => move.moveId === 'fly').turnLikelihood.label, 'Guaranteed');
  assert.equal(forecast.moves.find(move => move.moveId === 'fly').incentiveLedger, null);
  mon.volatileConditions.chargingMoveId = null;
  mon.volatileConditions.encoredMoveId = plan.combatants[actorKey].moves[0].moveId;
  assert.equal(run().actors[0].actions[0].action.type, 'item');
  dataset.trainer(plan.game.trainerId).battleProfiles.default.bagItemIds = [];
  forecast = run().actors[0];
  assert.equal(forecast.actions[0].action.canonicalMoveId, mon.volatileConditions.encoredMoveId);
  assert.equal(forecast.actions[0].action.targetSelection.timing, 'execution');
  for (const move of plan.combatants[actorKey].moves) mon.movePp[move.moveId] = 0;
  forecast = run().actors[0];
  assert.equal(forecast.actions[0].action.canonicalMoveId, 'struggle');
  assert.equal(forecast.moves.find(move => move.moveId === 'struggle').turnLikelihood.label, 'Guaranteed');
});

test('Platinum item loop retains consumed holes, initial count and stale use classification', async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: 'http://fixture/rp', fetchImpl: generatedDatasetFetch });
  const plan = createRenegadeAiPlan(dataset), state = plan.stateNodes[plan.initialStateNodeId];
  const actorEntry = { slot: 0, combatantKey: state.active.enemyCombatantKeys[0] };
  const mon = state.combatantStates[actorEntry.combatantKey];
  mon.hp = { min: 70, max: 70, maxHp: 100 };
  for (const other of Object.values(plan.combatants).filter(row => row.side === 'enemy' && row.combatantKey !== actorEntry.combatantKey)) state.combatantStates[other.combatantKey].hp = { min: 0, max: 0, maxHp: 100 };
  const ai = await loadTrainerAiDocumentation({ baseUrl: 'http://fixture/trainer-ai', gameId: 'renegade-platinum', generation: 4, fetchImpl: generatedFetch });
  const query = createPlatinumQueryProvider({ plan, state, dataset, actorEntry, moves: [] })['platinum.action.result'];
  dataset.trainer(plan.game.trainerId).battleProfiles.default.bagItemIds = ['potion', 'fullrestore'];
  let result = query('trainer-item', { profile: ai.evaluatorProfile });
  assert.equal(result.itemToken, 'fullrestore', 'unusable later Full Restore overwrites the qualifying Potion');
  assert.deepEqual(result.consumedBagSlots, [0, 1]);
  assert.equal(result.usedItemType, 'fixed-hp-restore', 'later unusable recognized class does not reset the earlier category');
  state.trainerAi = { g4Bags: { 0: { initialCount: 2, slots: [0, 17, 0, 0] } } };
  result = query('trainer-item', { profile: ai.evaluatorProfile });
  assert.equal(result.bagSlot, 1, 'consumed slot zero stays empty; remaining items are not recompressed');
  assert.equal(result.initialBagCount, 2);
  state.trainerAi.g4Bags[0] = { initialCount: 1, slots: [57, 0, 0, 0] };
  mon.enteredTurnNumber = state.turnNumber;
  result = query('trainer-item', { profile: ai.evaluatorProfile });
  assert.equal(result.usedItemCondition, 1, 'X Attack uses the source BATTLE_STAT_ATTACK numeric binding');
});

test('Platinum Doubles serializes switch and fainted replacement reservations and keeps per-battler bags', async () => {
  const dataset = await loadStandardizedDataset({ baseUrl: 'http://fixture/rp', fetchImpl: generatedDatasetFetch });
  const plan = createRenegadeAiPlan(dataset, 'renegade-platinum-trainer-0246'), state = plan.stateNodes[plan.initialStateNodeId];
  const enemyKeys = Object.values(plan.combatants).filter(mon => mon.side === 'enemy').map(mon => mon.combatantKey);
  assert.ok(enemyKeys.length >= 4);
  plan.game.battleFormat = 'doubles';
  state.active.enemyCombatantKeys = enemyKeys.slice(0, 2);
  for (const key of enemyKeys) {
    const mon = state.combatantStates[key];
    mon.currentTypeIds = ['fire']; mon.currentAbilityId = ''; mon.currentItemId = null;
    mon.moveSetOverride = [{ moveId: 'ember', maxPp: 25 }];
  }
  state.combatantStates[state.active.playerCombatantKeys[0]].currentTypeIds = ['grass'];
  state.combatantStates[state.active.playerCombatantKeys[0]].currentAbilityId = '';
  for (const key of enemyKeys.slice(0, 2)) state.combatantStates[key].volatileConditions.perishTurns = 0;
  const ai = await loadTrainerAiDocumentation({ baseUrl: 'http://fixture/trainer-ai', gameId: 'renegade-platinum', generation: 4, fetchImpl: generatedFetch });
  const engine = generatedEvaluator(), evaluator = { ...engine, forecast: options => engine.forecast({ ...options, request: { ...options.request, state: { ...options.request.state, random: { g4LcrngSeed: 0 } } } }) };
  const run = () => analyzeTrainerAi({ plan, state, dataset, ai, evaluator });
  let result = run();
  assert.deepEqual(result.actors.map(row => row.actions[0].action.partySlot), [2, 3]);
  assert.equal(result.jointTurnOutcomes.length, 1);
  for (const key of enemyKeys.slice(0, 2)) state.combatantStates[key].hp = { min: 0, max: 0, maxHp: 100 };
  result = run();
  assert.deepEqual(result.replacementForecasts.map(row => row.options[0].partySlot), [2, 3]);
  assert.deepEqual(Array.from(result.jointReplacementOutcomes[0].actions, row => row.partySlot), [2, 3]);
  for (const key of enemyKeys.slice(0, 2)) {
    state.combatantStates[key].hp = { min: 1, max: 1, maxHp: 100 };
    delete state.combatantStates[key].volatileConditions.perishTurns;
  }
  // Arena Trap exits the voluntary-switch check, isolating source item bags.
  state.combatantStates[state.active.playerCombatantKeys[0]].currentAbilityId = 'arenatrap';
  dataset.trainer(plan.game.trainerId).battleProfiles.default.bagItemIds = ['potion'];
  result = run();
  assert.deepEqual(result.actors.map(row => [row.actions[0].action.itemToken, row.actions[0].action.bagOwner]), [['potion', 0], ['potion', 1]]);
});
