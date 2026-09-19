import test from 'node:test';
import assert from 'node:assert/strict';
import { replacementReasonLines } from '../src/ui/ai_forecast.js';

const slotNumber = (_side, slot) => slot + 1;
const render = replacementReasons => replacementReasonLines({ name: 'Bulbasaur', replacementReasons }, slotNumber);

test('Gen 5 replacement explanations show actual scoring inputs and separate reference slots', () => {
  const reason = { generation: 5, kind: 'power-times-effectiveness', moveName: 'Mega Drain', basePower: 40, multiplier: 2, score: 80, targetSlot: 0 };
  assert.deepEqual(render([reason, reason, { ...reason, multiplier: 0.5, score: 20, targetSlot: 1 }]), [
    'Bulbasaur: Mega Drain (40 × 2 = 80) · Slot 1',
    'Bulbasaur: Mega Drain (40 × 0.5 = 20) · Slot 2'
  ]);
  assert.equal(render([{ ...reason, moveName: 'Low Kick', basePower: 60, multiplier: 1, score: 60 }])[0],
    'Bulbasaur: Low Kick (60 × 1 = 60) · Slot 1');
  assert.equal(render([{ ...reason, basePower: 35, multiplier: 0.5, score: 17 }])[0],
    'Bulbasaur: Mega Drain (35 × 0.5 = 17, rounded down) · Slot 1');
});

test('Gen 4 replacement explanations distinguish type score, damage score and party-order fallback', () => {
  assert.deepEqual(render([
    { generation: 4, kind: 'post-ko-stage-one', score: 160, moveName: 'Mega Drain', targetSlot: 0 },
    { generation: 4, kind: 'post-ko-stage-two', score: 42, moveName: 'Tackle', targetSlot: 1 },
    { generation: 4, kind: 'post-ko-party-order-fallback' }
  ]), [
    'Bulbasaur: Type score 160 · Mega Drain is super effective into Slot 1',
    'Bulbasaur: Tackle · AI damage score 42 · Slot 2',
    'Bulbasaur: First eligible Pokémon in party order'
  ]);
});

test('missing selection evidence never becomes invented scores or likelihood labels', () => {
  assert.deepEqual(render([]), ['Bulbasaur: Selection details unavailable']);
  assert.deepEqual(render([{ generation: 5, kind: 'power-times-effectiveness', score: null }]), ['Bulbasaur: Selection details unavailable']);
  assert.deepEqual(render([{ generation: 4, kind: 'post-ko-stage-two', score: 80, targetSlot: 0 }]),
    ['Bulbasaur: AI damage score 80 · Slot 1']);
});
