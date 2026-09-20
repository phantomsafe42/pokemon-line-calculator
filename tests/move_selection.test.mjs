import assert from 'node:assert/strict';
import test from 'node:test';
import { toggleMoveSelection } from '../src/ui/move_selection.js';

const move = (moveId = 'tackle', targetKey = 'enemy-0') => ({ type: 'move', moveId, targetKey, mechanicValue: null });
test('clicking a selected move clears the entire draft including mechanic selections', () => {
  const current = {...move(), mechanicValue:'old-choice'};
  assert.deepEqual(toggleMoveSelection(current,move()),{});
  assert.deepEqual(toggleMoveSelection(move('tackle','enemy-1'),move()),{});
  assert.equal(current.mechanicValue,'old-choice');
  assert.deepEqual(toggleMoveSelection({},move()),move());
  assert.deepEqual(toggleMoveSelection(move(),move('protect','player-0')),move('protect','player-0'));
  assert.deepEqual(toggleMoveSelection({type:'switch'},move()),move());
});
test('target clicks deselect the same pair but retarget without clearing another pair', () => {
  assert.deepEqual(toggleMoveSelection(move(),move(),{targetClick:true}),{});
  assert.deepEqual(toggleMoveSelection(move(),move('tackle','enemy-1'),{targetClick:true}),move('tackle','enemy-1'));
  assert.deepEqual(toggleMoveSelection(move(),move('surf'),{targetClick:true}),move('surf'));
});
test('forced continuations cannot be deselected and retain their configuration', () => {
  const current={...move('dig'),mechanicValue:'preserved'};
  assert.deepEqual(toggleMoveSelection(current,move('dig'),{forced:true}),current);
  assert.deepEqual(toggleMoveSelection(current,move('dig'),{forced:true,targetClick:true}),current);
  assert.deepEqual(toggleMoveSelection(current,move('dig','enemy-1'),{forced:true,targetClick:true}),move('dig','enemy-1'));
});
