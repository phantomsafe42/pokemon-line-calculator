import test from 'node:test';
import assert from 'node:assert/strict';
import { replacementReasonLines, replacementForecastLines } from '../src/ui/ai_forecast.js';

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

test('Gen 4 type score spells out both typed terms, including single-type repetition and byte wrap', () => {
  const reason = { generation: 4, kind: 'post-ko-stage-one', score: 120, moveName: 'Mega Drain', targetSlot: 0,
    typeComponents: [{type:'grass', multiplier:2}, {type:'poison', multiplier:1}] };
  assert.equal(render([reason])[0], 'Bulbasaur: Type score (Grass: 40 × 2) + (Poison: 40 × 1) = 120 · Mega Drain is super effective into Slot 1');
  assert.match(render([{...reason, score:64, typeComponents:[{type:'fire', multiplier:4},{type:'fire', multiplier:4}]}])[0],
    /\(Fire: 40 × 4\) \+ \(Fire: 40 × 4\) = 320 → 64 \(8-bit wrap\)/);
});

test('all generations sort flattened replacement rows by displayed target slot without mutating options', () => {
  const typeReason = {generation:4, kind:'post-ko-stage-two', score:42, moveName:'Tackle', targetSlot:1};
  const powerReason = {generation:5, kind:'power-times-effectiveness', basePower:40, multiplier:2, score:80, moveName:'Mega Drain', targetSlot:0};
  for (const reason of [typeReason, powerReason]) {
    const options = [
      {name:'First', replacementReasons:[{...reason, targetSlot:1}, {...reason, targetSlot:0}]},
      {name:'Second', replacementReasons:[{...reason, targetSlot:0}]},
      {name:'Fallback', replacementReasons:[{generation:4,kind:'post-ko-party-order-fallback'}]}
    ];
    const before = JSON.stringify(options);
    const lines = replacementForecastLines(options, slotNumber);
    assert.deepEqual(lines.slice(0, 3).map(line => line.match(/Slot (\d+)/)[1]), ['1','1','2']);
    assert.match(lines[0], /^First:/);
    assert.match(lines[1], /^Second:/);
    assert.match(lines[3], /^Fallback:/);
    assert.equal(JSON.stringify(options), before);
    const remapped = replacementForecastLines(options, (_side, slot) => [3,1][slot]);
    assert.deepEqual(remapped.slice(0,3).map(line => line.match(/Slot (\d+)/)[1]), ['1','3','3']);
  }
});
