import assert from 'node:assert/strict';
import test from 'node:test';
import { forecastTargetLabel } from '../src/ui/ai_forecast.js';
import { triplePositionForSlot } from '../src/rulesets/triple_battle.js';

test('forecast captions use the same side-aware slot mapper as the action panels', () => {
  const doublesSlot = (side, slot) => slot + 1 + (side === 'enemy' ? 2 : 0);
  assert.equal(forecastTargetLabel({ targetSide: 'enemy', targetSlot: 1 }, doublesSlot), 'Slot 4');
  assert.equal(forecastTargetLabel({ targetSide: 'enemy', targetSlot: 0 }, doublesSlot), 'Slot 3');
  assert.equal(forecastTargetLabel({ targetSide: 'player', targetSlot: 1 }, doublesSlot), 'Slot 2');
  assert.equal(forecastTargetLabel({ targetSlot: null }, doublesSlot), 'Field');
  for (const targetSide of [null, undefined, 'unknown']) {
    assert.equal(forecastTargetLabel({ targetSide, targetSlot: 1 }, doublesSlot), 'Unknown target');
  }
  assert.equal(forecastTargetLabel({ targetSide: 'enemy', targetSlot: -1 }, doublesSlot), 'Unknown target');
  const tripleSlot = (side, slot) => triplePositionForSlot('triples', side, slot) + 1 + (side === 'enemy' ? 3 : 0);
  assert.deepEqual([0, 1, 2].map(targetSlot => forecastTargetLabel({ targetSide: 'enemy', targetSlot }, tripleSlot)),
    ['Slot 6', 'Slot 4', 'Slot 5'], 'actor headings and target tables retain the established Triple player-view mapping');
});
