import assert from 'node:assert/strict';
import test from 'node:test';
import { freeCalcExperience, freeCalcTotalExperience } from '../src/ui/free_calc.js';
import { experienceForLevel, GROWTH_RATES } from '../src/rulesets/vw2r_experience.js';
import { fixturePlan } from './helpers.mjs';
import { addFreeCalcBranch, editFreeCalcCombatant } from '../src/core/free_calc.js';

test('Free Calc level EXP converts to lifetime EXP for every supported growth curve', () => {
  for (const growthRate of GROWTH_RATES) {
    const mon = { level: 30, growthRate };
    const floor = experienceForLevel(30, growthRate);
    const state = { experience: floor + 250 };
    assert.equal(freeCalcExperience(mon, state).value, 250);
    assert.equal(freeCalcTotalExperience(mon, state, '0'), floor);
    assert.equal(freeCalcTotalExperience(mon, state, '250'), floor + 250);
    const threshold = experienceForLevel(31, growthRate) - floor;
    assert.equal(freeCalcExperience(mon, state).threshold, threshold);
    assert.equal(freeCalcTotalExperience(mon, state, threshold), floor + threshold);
    for (const invalid of ['', '-1', '1.5', 'no', threshold + 1]) assert.throws(() => freeCalcTotalExperience(mon, state, invalid));
  }
});

test('Free Calc EXP handles level overrides, unknown amounts and level 100 without invented data', () => {
  const mon = { level: 30, growthRate: 'Medium Fast' };
  assert.equal(freeCalcExperience(mon, {}).value, '');
  assert.equal(freeCalcExperience({}, {}), null);
  assert.throws(() => freeCalcTotalExperience({}, {}, 0), /growth rate/);
  assert.deepEqual(freeCalcExperience(mon, { currentLevel: 100, experience: 1000000 }), { floor: 1000000, threshold: 0, value: 0 });
  assert.equal(freeCalcTotalExperience(mon, { currentLevel: 31 }, 0), 31 ** 3);
});

test('Per-level Free Calc edits level up once and remain isolated from the source line', () => {
  const { plan: original, dataset, players } = fixturePlan();
  const key = players[0].combatantKey;
  original.combatants[key].growthRate = 'Medium Fast';
  const baseline = structuredClone(original);
  const { plan, stateId } = addFreeCalcBranch(original, original.initialStateNodeId);
  editFreeCalcCombatant(plan, stateId, key, { level: 30 }, dataset);
  const mon = plan.combatants[key];
  let state = plan.stateNodes[stateId].combatantStates[key];
  assert.equal(freeCalcExperience(mon, state).value, 0);
  const progress = freeCalcExperience(mon, state);
  editFreeCalcCombatant(plan, stateId, key, { experience: freeCalcTotalExperience(mon, state, progress.threshold) }, dataset);
  state = plan.stateNodes[stateId].combatantStates[key];
  assert.equal(state.currentLevel, 31);
  assert.equal(freeCalcExperience(mon, state).value, 0);
  assert.deepEqual(original, baseline);
});
