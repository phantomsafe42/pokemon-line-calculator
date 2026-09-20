import assert from 'node:assert/strict';
import test from 'node:test';
import { outcomePanelEvents, protectionEventDescription } from '../src/core/outcome_presentation.js';
import { resolveTurn } from '../src/core/resolver.js';
import { createEventTimeline } from '../src/core/event_timeline.js';
import { vw2rMoveSupport } from '../src/rulesets/vw2r_move_support.js';
import { damageAdapter, fixturePlan } from './helpers.mjs';

const move = (actorKey, moveId, targetKey) => ({
  actionType: 'move', actorKey, moveId, targetKeys: [targetKey],
  mechanicActivations: [], declaredAtStateHash: 'fixture'
});

for (const generation of [3, 4, 5]) for (const moveId of ['protect', 'detect']) {
  test(`Gen ${generation} ${moveId}: structured result appears once, without changing state or probability`, () => {
    const { plan, dataset, players, enemies } = fixturePlan();
    dataset.mechanics.damageGeneration = generation;
    const p = players[0].combatantKey, e = enemies[0].combatantKey;
    const root = plan.stateNodes[plan.initialStateNodeId];
    if (moveId === 'detect') dataset.indexes.moves.set('detect', {
      ...dataset.get('moves', 'protect'), id: 'detect', name: 'Detect', calcName: 'Detect'
    });
    plan.combatants[p].moves = [{ moveId, maxPp: 10 }];
    root.combatantStates[p].movePp[moveId] = 10;
    root.combatantStates[p].volatileConditions.protectStreak = 1;
    const outcomes = resolveTurn({
      plan, parentStateNodeId: plan.initialStateNodeId, dataset,
      actions: { player: move(p, moveId, p), enemy: move(e, 'tackle', p) },
      moveSupport: vw2rMoveSupport, damageAdapter: damageAdapter(() => [20]),
      capturePresentation: true
    });
    assert.ok(outcomes.some(entry => entry.events.some(event => event.eventType === 'protect' && event.metadata.success)));
    assert.ok(outcomes.some(entry => entry.events.some(event => event.eventType === 'protect' && !event.metadata.success)));
    const original = structuredClone(outcomes);
    for (const entry of outcomes) {
      const timeline = createEventTimeline(root, entry.events);
      const presented = outcomePanelEvents(entry.events);
      const protection = presented.filter(event => event.eventType === 'protect');
      assert.equal(protection.length, 1);
      assert.ok(entry.events.some(event => event.eventType === 'volatile-status' && event.metadata.volatileStatusId === 'protect'),
        'Reproduces the redundant structured volatile event, not just the simple fixture handler');
      assert.equal(presented.some(event => event.eventType === 'volatile-status' && event.metadata.volatileStatusId === 'protect'), false);
      assert.equal(protectionEventDescription(protection[0], { moveName: dataset.get('moves', moveId).name }),
        `${dataset.get('moves', moveId).name} · ${protection[0].metadata.success ? 'Protected' : 'Failed'}`);
      assert.equal(presented.some(event => event.eventType === 'move-blocked'), protection[0].metadata.success);
      assert.equal(presented.some(event => event.eventType === 'damage' && event.targetKey === p), !protection[0].metadata.success);
      assert.deepEqual(createEventTimeline(root, entry.events), timeline);
      assert.ok(presented.every(event => entry.events.includes(event)), 'Original event identity/hover indexing is retained');
      const reopened = JSON.parse(JSON.stringify(entry));
      assert.deepEqual(outcomePanelEvents(reopened.events), JSON.parse(JSON.stringify(presented)), 'Saved event streams use the same presentation');
    }
    assert.deepEqual(outcomes, original);
    assert.ok(Math.abs(outcomes.reduce((total, entry) => total + entry.outcome.probability, 0) - 1) < 1e-10);
  });
}

test('Protect filtering does not hide another actor, move, target, or unrelated volatile', () => {
  const result = { eventType: 'protect', actorKey: 'p', targetKey: 'p', moveId: 'protect', metadata: { success: true } };
  const duplicate = { eventType: 'volatile-status', actorKey: 'p', targetKey: 'p', moveId: 'protect', metadata: { volatileStatusId: 'protect' } };
  for (const other of [
    { ...duplicate, actorKey: 'other' }, { ...duplicate, targetKey: 'other' },
    { ...duplicate, moveId: 'detect' }, { ...duplicate, metadata: { volatileStatusId: 'confusion' } }
  ]) assert.deepEqual(outcomePanelEvents([result, other]), [result, other]);
  assert.deepEqual(outcomePanelEvents([duplicate]), [duplicate], 'Do not infer success from an orphan volatile record');
  assert.equal(protectionEventDescription({ ...result, metadata: {} }), null);
  assert.equal(protectionEventDescription({
    eventType: 'move-blocked', moveId: 'tackle', metadata: { reason: 'protect' }
  }, { moveName: 'Tackle', targetLabel: 'Slot 1' }), 'Slot 1 · Tackle · Blocked by Protect');
});
