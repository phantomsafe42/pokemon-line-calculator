import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { resolveTurn } from '../src/core/resolver.js';
import { heldStateItemActivation } from '../src/rulesets/item_rules.js';
import { fixturePlan } from './helpers.mjs';

// Synthetic contracts deliberately exercise the interpreter independently of
// the Dataset exporter; real-game projection tests remain a separate gate.
function setup({ conditions = {}, effects = [{ kind: 'heal', amount: 25 }], timing = 'state-update', hp = 100, generation = 5 } = {}) {
  const f = fixturePlan();
  const player = f.players[0].combatantKey;
  const enemy = f.enemies[0].combatantKey;
  const root = f.plan.stateNodes[f.plan.initialStateNodeId];
  for (const key of [player, enemy]) {
    root.combatantStates[key].hp = { min: hp, max: hp, maxHp: 100 };
    delete root.combatantStates[key].hpDistribution;
    root.combatantStates[key].currentAbilityId = '';
    root.combatantStates[key].currentItemId = '';
    root.combatantStates[key].itemState = 'none';
    f.plan.combatants[key].calculatedStats.spe = key === player ? 120 : 40;
  }
  const holder = root.combatantStates[enemy];
  holder.currentItemId = 'testberry';
  holder.itemState = 'held';
  f.dataset.mechanics.damageGeneration = generation;
  f.dataset.indexes.items.set('testberry', { id: 'testberry', name: 'Test Berry', heldItemMechanics: {
    schemaVersion: 'held-item-mechanics/v1', sourceProfile: 'test', lifecycle: 'consumable', consumptionMethod: 'eat', activationStatus: 'modeled',
    activations: [{ id: 'test-activation', trigger: 'holder-state', timing,
      conditions: { battleGenerations: [generation], hpThreshold: { numerator: 1, denominator: 2 }, requiresHealingAllowed: true, blockedByOpponentAbilityIds: ['unnerve'], ...conditions }, effects, consumeOnActivation: true }]
  } });
  const actions = Object.fromEntries([['player', player, enemy], ['enemy', enemy, player]].map(([side, key, target]) => [side, {
    actionType: 'move', actorKey: key, moveId: 'tackle', targetKeys: [target], mechanicActivations: [], declaredAtStateHash: 'fixture'
  }]));
  const run = (damage = [60], capturePresentation = false, overrides = {}) => resolveTurn({ plan: f.plan, parentStateNodeId: f.plan.initialStateNodeId,
    actions, dataset: f.dataset, capturePresentation,
    damageAdapter: { supportsCriticalHits: false, calculate: ({ attacker }) => ({ status: 'ok', damage: attacker.combatantKey === player ? damage : [0] }) }, ...overrides });
  return { ...f, player, enemy, root, holder, actions, run };
}

test('state berry heals after damage, consumes once, and survives serialization', () => {
  const f = setup();
  const outcomes = f.run();
  assert.ok(outcomes.length);
  for (const outcome of outcomes) {
    const state = outcome.state.combatantStates[f.enemy];
    assert.equal(state.hp.min, 65);
    assert.equal(state.currentItemId, '');
    assert.equal(state.lastItemId, 'testberry');
    assert.equal(state.itemState, 'consumed');
    assert.equal(outcome.events.filter(e => e.eventType === 'item-consumed').length, 1);
    assert.ok(outcome.events.findIndex(e => e.eventType === 'damage') < outcome.events.findIndex(e => e.eventType === 'item-consumed'));
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  }
});

test('consumption and healed HP persist into the next turn without consuming twice', () => {
  const f = setup();
  const first = f.run()[0];
  f.plan.stateNodes[f.plan.initialStateNodeId] = JSON.parse(JSON.stringify(first.state));
  const second = f.run([10])[0];
  assert.equal(second.state.combatantStates[f.enemy].hp.min, 55);
  assert.equal(second.state.combatantStates[f.enemy].itemState, 'consumed');
  assert.equal(second.events.filter(e => e.eventType === 'item-consumed').length, 0);
});

test('HP threshold splits weighted rolls, not an averaged HP value', () => {
  const f = setup();
  const outcomes = f.run([49, 49, 50, 60]);
  const used = outcomes.filter(o => o.state.combatantStates[f.enemy].itemState === 'consumed');
  const held = outcomes.filter(o => o.state.combatantStates[f.enemy].itemState === 'held');
  assert.equal(used.reduce((sum, o) => sum + o.outcome.probability, 0), 0.5);
  assert.equal(held.reduce((sum, o) => sum + o.outcome.probability, 0), 0.5);
  assert.deepEqual(used[0].state.combatantStates[f.enemy].hpDistribution, [{ value: 65, probability: 0.5 }, { value: 75, probability: 0.5 }]);
});

for (const suppression of ['klutz', 'embargo', 'magicroom', 'unnerve', 'healblock']) test(`${suppression} prevents consumption`, () => {
  const f = setup();
  if (suppression === 'klutz') f.holder.currentAbilityId = 'klutz';
  if (suppression === 'embargo') f.holder.volatileConditions.embargoTurns = 3;
  if (suppression === 'magicroom') f.root.fieldState.global.magicRoomTurns = 3;
  if (suppression === 'unnerve') f.root.combatantStates[f.player].currentAbilityId = 'unnerve';
  if (suppression === 'healblock') f.holder.volatileConditions.healBlockTurns = 3;
  assert.ok(f.run().every(o => o.state.combatantStates[f.enemy].itemState === 'held'));
});

test('KO does not activate a healing berry', () => {
  const f = setup();
  assert.ok(f.run([100]).every(o => o.state.combatantStates[f.enemy].itemState === 'held'));
});

test('Substitute damage does not trigger an HP threshold berry', () => {
  const f = setup();
  f.holder.volatileConditions.substituteHp = 70;
  assert.ok(f.run([60]).every(o => o.state.combatantStates[f.enemy].itemState === 'held'));
});

test('Gen 3 residual checkpoint is not run between attacks', () => {
  const f = setup({ generation: 3, timing: 'item-residual', effects: [{ kind: 'heal', amount: 30 }] });
  const o = f.run()[0];
  assert.equal(o.state.combatantStates[f.enemy].hp.min, 70);
  assert.ok(o.events.findIndex(e => e.eventType === 'damage' && e.actorKey === f.enemy) < o.events.findIndex(e => e.eventType === 'item-consumed'));
});

test('status berry clears badly poisoned state and counters before acting', () => {
  const f = setup({ conditions: { hpThreshold: undefined, anyStatusIds: ['psn', 'tox'] }, effects: [{ kind: 'cure-status', statusIds: ['psn', 'tox'] }] });
  f.holder.majorStatus = 'tox';
  f.holder.toxicCounter = 5;
  const o = f.run([0])[0];
  assert.equal(o.state.combatantStates[f.enemy].majorStatus, null);
  assert.equal(o.state.combatantStates[f.enemy].toxicCounter, 0);
});

test('PP restoration caps at maximum and consumes after the final PP is spent', () => {
  const f = setup({ conditions: { hpThreshold: undefined, requiresDepletedMovePp: true }, effects: [{ kind: 'restore-pp', amount: 10, selection: 'first-depleted-move' }] });
  f.plan.combatants[f.enemy].moves = [{ moveId: 'tackle', maxPp: 5 }];
  f.holder.movePp.tackle = 1;
  const o = f.run([0])[0];
  assert.equal(o.state.combatantStates[f.enemy].movePp.tackle, 5);
  assert.equal(o.state.combatantStates[f.enemy].itemState, 'consumed');
});

test('unknown executable conditions fail closed instead of consuming', () => {
  const f = setup({ conditions: { undocumentedCondition: true } });
  assert.throws(() => f.run(), /unsupported held-item activation contract/);
});

test('unmodeled records never infer behavior from their name', () => {
  const f = setup();
  f.dataset.indexes.items.get('testberry').heldItemMechanics.activationStatus = 'unmodeled';
  assert.equal(heldStateItemActivation({ dataset: f.dataset, state: f.holder, activeItemId: 'testberry', generation: 5 }), null);
});

test('healing occurs between multi-hit strikes and can avert the summed-roll KO', () => {
  const f = setup();
  const outcomes = f.run([60], true, { moveSupport: () => ({ supported: true, effectId: 'structured-move',
    target: 'opponent', targetMode: 'normal', flags: {}, operations: [{ kind: 'damage', multihit: 2 }] }) });
  for (const o of outcomes) {
    assert.equal(o.state.combatantStates[f.enemy].hp.min, 5);
    const meaningful = o.events.filter(e => e.targetKey === f.enemy && ['damage', 'item-consumed', 'residual-heal'].includes(e.eventType));
    assert.deepEqual(meaningful.map(e => e.eventType), ['damage', 'item-consumed', 'residual-heal', 'damage']);
  }
});

test('pinch stat berry honors Gluttony and persists its stage change', () => {
  const f = setup({ conditions: { hpThreshold: { numerator: 1, denominator: 4 }, gluttonyHpThreshold: { numerator: 1, denominator: 2 } },
    effects: [{ kind: 'stat-stages', stages: { atk: 1 } }] });
  assert.ok(f.run([60]).every(o => o.state.combatantStates[f.enemy].itemState === 'held'));
  f.holder.currentAbilityId = 'gluttony';
  assert.ok(f.run([60]).every(o => o.state.combatantStates[f.enemy].statStages.atk === 1));
});

test('held berry consumed at a residual threshold before the following residual source', () => {
  const f = setup({ hp: 55 });
  f.holder.majorStatus = 'brn';
  const o = f.run([0])[0];
  assert.equal(o.state.combatantStates[f.enemy].hp.min, 68);
  assert.equal(o.state.combatantStates[f.enemy].itemState, 'consumed');
});

test('stat berry still consumes at its HP threshold when the stat is maximized', () => {
  const f = setup({ hp: 20, effects: [{ kind: 'stat-stages', stages: { atk: 1 } }] });
  f.holder.statStages.atk = 6;
  const holder = f.run([0])[0].state.combatantStates[f.enemy];
  assert.equal(holder.itemState, 'consumed');
  assert.equal(holder.statStages.atk, 6);
});

test('unknown effect fields and missing generation gates are rejected', () => {
  for (const edit of [rule => rule.effects[0].undocumentedChance = 0.5, rule => delete rule.conditions.battleGenerations]) {
    const f = setup();
    edit(f.dataset.indexes.items.get('testberry').heldItemMechanics.activations[0]);
    assert.throws(() => f.run(), /unsupported held-item activation contract/);
  }
});

test('pinned Dataset contracts execute with generation-specific recovery', () => {
  for (const [game, generation, heal] of [['fire-red-omega', 3, 30], ['pokemon-emerald', 3, 30], ['renegade-platinum', 4, 25], ['volt-white-2r', 5, 25]]) {
    const document = JSON.parse(fs.readFileSync(new URL(`../src/generated/datasets/${game}/items.json`, import.meta.url)));
    const f = setup({ generation });
    f.dataset.indexes.items.set('sitrusberry', document.records.sitrusberry);
    f.holder.currentItemId = 'sitrusberry';
    const result = f.run([60])[0];
    assert.equal(result.state.combatantStates[f.enemy].hp.min, 40 + heal, game);
    assert.equal(result.state.combatantStates[f.enemy].itemState, 'consumed', game);
    assert.equal(result.events.filter(e => e.eventType === 'item-consumed').length, 1, game);
  }
});

test('a resistance berry only reduces the first strike of a multi-hit move', () => {
  const f = setup();
  f.dataset.indexes.items.get('testberry').heldItemMechanics.activations = [{ id: 'resist', trigger: 'incoming-damaging-move', consumeOnActivation: true,
    effects: [{ kind: 'damage-multiplier', numerator: 1, denominator: 2 }] }];
  const result = f.run([0], false, {
    moveSupport: () => ({ supported: true, effectId: 'structured-move', target: 'opponent', targetMode: 'normal', flags: {}, operations: [{ kind: 'damage', multihit: 2 }] }),
    damageAdapter: { supportsCriticalHits: false, calculate: ({ attacker, defenderState }) => ({ status: 'ok',
      damage: attacker.combatantKey !== f.player ? [0] : defenderState.itemState === 'held' ? [20] : [40],
      appliedDefenderItemIds: attacker.combatantKey === f.player && defenderState.itemState === 'held' ? ['testberry'] : [] }) }
  })[0];
  assert.equal(result.state.combatantStates[f.enemy].hp.min, 40);
  assert.equal(result.events.filter(e => e.eventType === 'item-consumed').length, 1);
});
