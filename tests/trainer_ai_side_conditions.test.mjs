import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createPlatinumQueryProvider, createGen5QueryProvider } from '../src/adapters/trainer_ai.js';

const gen4 = JSON.parse(fs.readFileSync(new URL('../src/generated/trainer-ai/gen4/trainer_ai.json', import.meta.url)));
const profiles = gen4.profiles.filter(p => ['platinum-retail', 'platinum-kaizo-nightmare-final', 'renegade-platinum-supported-build', 'sssg-pchal-supported-build'].includes(p.profileId));
function fixture(profile) {
  const plan = { combatants: { e: { side: 'enemy' }, p: { side: 'player' } } };
  const state = { active: { enemyCombatantKeys: ['e'], playerCombatantKeys: ['p'] }, combatantStates: { e: {}, p: {} },
    fieldState: { sides: { enemy: { hazards: {} }, player: { hazards: {} } }, global: { delayedAttacks: [] } } };
  const metadata = { profile, context: { candidate: { action: { targetCombatantKey: 'p', targetSlot: 0 } } }, locals: { calcTemp: 77 } };
  const options = { plan, state, actorEntry: { combatantKey: 'e', side: 'enemy', slot: 0 }, dataset: { get() { return null; } }, moves: [] };
  return { state, metadata, g4: createPlatinumQueryProvider(options), g5: createGen5QueryProvider(options) };
}

for (const { profileId, evaluator } of profiles) {
  test(`${profileId}: hazard presence and layers follow canonical state on both sides`, () => {
    const { state, metadata, g4 } = fixture(evaluator);
    for (const [selector, side] of [[0, 'player'], [1, 'enemy']]) {
      for (const [key, token, maximum] of [['spikes', 'SPIKES', 3], ['toxicSpikes', 'TOXIC_SPIKES', 2], ['stealthRock', 'STEALTH_ROCK', 1]]) {
        const mask = evaluator.constants.numericByToken[`SIDE_CONDITION_${token}`];
        for (const count of [0, 1, maximum, 0]) {
          state.fieldState.sides[side].hazards[key] = count;
          assert.equal(g4['platinum.command.IfSideCondition'](selector, mask, metadata), count > 0, `${side} ${key} ${count}`);
          if (key !== 'stealthRock') assert.equal(g4['platinum.command.LoadSpikesLayers'](selector, mask, metadata), count);
          assert.equal(g4['platinum.command.IfSideCondition'](1 - selector, mask, metadata), false, 'hazards must not leak to the opposite side');
        }
      }
      for (const [key, token] of [['reflectTurns', 'REFLECT'], ['lightScreenTurns', 'LIGHT_SCREEN'], ['safeguardTurns', 'SAFEGUARD'], ['mistTurns', 'MIST'], ['tailwindTurns', 'TAILWIND'], ['luckyChantTurns', 'LUCKY_CHANT']]) {
        state.fieldState.sides[side][key] = 3;
        assert.equal(g4['platinum.command.IfSideCondition'](selector, evaluator.constants.numericByToken[`SIDE_CONDITION_${token}`], metadata), true);
        state.fieldState.sides[side][key] = 0;
        assert.equal(g4['platinum.command.IfSideCondition'](selector, evaluator.constants.numericByToken[`SIDE_CONDITION_${token}`], metadata), false);
      }
    }
    assert.equal(g4['platinum.command.LoadSpikesLayers'](0, -1, metadata), 77, 'retail unknown condition leaves the accumulator unchanged');
  });

  test(`${profileId}: delayed attacks use the source side-wide flag, including the other Doubles slot`, () => {
    const { state, metadata, g4 } = fixture(evaluator);
    const mask = evaluator.constants.numericByToken.SIDE_CONDITION_FUTURE_SIGHT;
    for (const moveId of ['futuresight', 'doomdesire']) for (const [selector, side] of [[0, 'player'], [1, 'enemy']]) {
      state.fieldState.global.delayedAttacks = [{ side, slot: 1, moveId, remainingTurns: 2 }];
      assert.equal(g4['platinum.command.IfSideCondition'](selector, mask, metadata), true);
      assert.equal(g4['platinum.command.IfSideCondition'](1 - selector, mask, metadata), false);
      state.fieldState.global.delayedAttacks[0].remainingTurns = 0;
      assert.equal(g4['platinum.command.IfSideCondition'](selector, mask, metadata), false);
      state.fieldState.global.delayedAttacks = [];
      assert.equal(g4['platinum.command.IfSideCondition'](selector, mask, metadata), false);
    }
  });
}

test('Gen 5 hazard presence, absence and layer queries agree after setting and clearing each hazard', () => {
  const { state, metadata, g5 } = fixture(profiles[0].evaluator);
  for (const [selector, side] of [[0, 'player'], [1, 'enemy']]) {
    for (const [key, token, maximum] of [['spikes', 'spikes', 3], ['toxicSpikes', 'toxic_spikes', 2], ['stealthRock', 'stealth_rock', 1]]) {
      for (const count of [0, 1, maximum, 0]) {
        state.fieldState.sides[side].hazards[key] = count;
        assert.equal(g5['gen5.command.0x57'](selector, `side_status.${token}`, metadata), count);
        assert.equal(g5['gen5.command.0x11'](selector, `side_status.${token}`, metadata), count > 0);
        assert.equal(g5['gen5.command.0x12'](selector, `side_status.${token}`, metadata), count === 0);
        assert.equal(g5['gen5.command.0x57'](1 - selector, `side_status.${token}`, metadata), 0);
      }
    }
  }
});

// Run exact source-script slices with the real side-condition adapter. These
// are scoring known answers, independent of the hidden-seed selection ensemble.
const sandbox = { globalThis: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../src/generated/battle-mechanics/trainer_ai/trainer_ai_evaluator.js', import.meta.url), 'utf8'), sandbox);
const engine = sandbox.globalThis.TrainerAiEvaluator;

function sourceScore(original, flag, entryLine, configure, seed = 0) {
  const profile = structuredClone(original);
  const program = profile.programs.find(p => p.id === `platinum-flag-${flag}`);
  program.entryPc = `source-line-${entryLine}`;
  const { state, g4 } = fixture(profile);
  state.turnNumber = 1;
  state.combatantStates.p = { enteredTurnNumber: 1, statStages: { evasion: -6 }, hp: { min: 100, max: 100, maxHp: 100 } };
  configure(state);
  const request = { schemaVersion: 'trainer-ai-evaluation-request/v1alpha1',
    evaluationScope: { startPhaseId: 'move-target-selection' },
    state: { battle: { format: 'singles', kind: 'trainer' }, random: { g4LcrngSeed: seed } },
    trainer: { aiFlagIds: [] }, phaseInputs: { 'move-target-selection': { disposition: 'evaluate', mode: 'scoring', programIds: [program.id],
      candidates: [{ id: 'probe', initialScore: 100, action: { type: 'move', moveId: 46, moveSlot: 0, target: 0, targetCombatantKey: 'p', targetSlot: 0 } }] } } };
  const result = engine.evaluate({ profile, request, queries: { ...g4,
    'platinum.command.CountAlivePartyBattlers': () => 2,
    'platinum.command.LoadCurrentWeather': () => profile.constants.numericByToken.AI_WEATHER_CLEAR || 0
  } });
  assert.equal(result.diagnostics.length, 0, JSON.stringify(result.diagnostics));
  return result.scoreDistributions[0].scores[0].score;
}

for (const { profileId, evaluator } of profiles) test(`${profileId}: source scoring applies hazard caps, Defog and delayed-attack penalties`, () => {
  const cases = [
    [709, 'spikes', 3], [1447, 'toxicSpikes', 2], [1542, 'stealthRock', 1]
  ];
  for (const [line, key, cap] of cases) {
    assert.equal(sourceScore(evaluator, 0, line, () => {}), 100);
    assert.equal(sourceScore(evaluator, 0, line, s => { s.fieldState.sides.player.hazards[key] = cap; }), 90);
  }
  assert.equal(sourceScore(evaluator, 0, 1479, () => {}), 90);
  for (const key of ['spikes', 'toxicSpikes', 'stealthRock']) {
    assert.equal(sourceScore(evaluator, 0, 1479, s => { s.fieldState.sides.player.hazards[key] = 1; }), 100);
  }
  assert.equal(sourceScore(evaluator, 0, 825, () => {}), 100);
  for (const side of ['player', 'enemy']) assert.equal(sourceScore(evaluator, 0, 825, s => {
    s.fieldState.global.delayedAttacks = [{ side, slot: 1, moveId: 'futuresight', remainingTurns: 2 }];
  }), 88);
  assert.equal(sourceScore(evaluator, 2, 2586, () => {}), 97);
  for (const key of ['spikes', 'toxicSpikes', 'stealthRock']) {
    const scores = new Set(Array.from({ length: 16 }, (_, seed) => sourceScore(evaluator, 2, 2586,
      s => { s.fieldState.sides.player.hazards[key] = 1; }, seed)));
    assert.deepEqual([...scores].sort(), [100, 102], 'source Roar/Whirlwind branch must never apply -3 with hazards');
  }
});
