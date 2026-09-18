import assert from 'node:assert/strict';
import test from 'node:test';
import { forecastTargetLabel } from '../src/ui/ai_forecast.js';

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
});
