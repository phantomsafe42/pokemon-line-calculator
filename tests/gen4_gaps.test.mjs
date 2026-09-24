import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fixtureDoublesPlan, fixturePlan, damageAdapter } from './helpers.mjs';
import { resolveTurn } from '../src/core/resolver.js';
import { activeEntries, setActiveKey } from '../src/core/battle_slots.js';
import { effectiveActionSpeed, gen4BattlerSpeedOrders } from '../src/rulesets/action_order.js';
import { initializeAbilityKnowledge, observeAbilityEvent } from '../src/core/ability_knowledge.js';
import { parsePlan, serializePlan } from '../src/contracts/plan_file.js';
import { updateStateHash } from '../src/core/plan.js';

const policy = JSON.parse(fs.readFileSync(new URL('../src/generated/trainer-ai/bootstrap.json', import.meta.url))).abilityKnowledgeProfiles['gen4-field-position-ability-memory-v1'];
const move = (actorKey, moveId, targetKeys = []) => ({ actionType: 'move', actorKey, moveId, targetKeys, mechanicActivations: [], declaredAtStateHash: 'fixture' });
function fixture() {
  const result = fixtureDoublesPlan();
  result.dataset.mechanics.damageGeneration = 4;
  const { plan, players, enemies } = result;
  const state = plan.stateNodes[plan.initialStateNodeId];
  const [p0, p1, e0, e1] = [players[0], players[1], enemies[0], enemies[1]].map(mon => mon.combatantKey);
  for (const [key, speed] of [[p0, 400], [p1, 300], [e0, 100], [e1, 200]]) {
    state.combatantStates[key].currentAbilityId = '';
    state.combatantStates[key].currentStats = { ...plan.combatants[key].calculatedStats, spe: speed };
  }
  return { ...result, state, p0, p1, e0, e1 };
}

test('Gen 4 spread damage follows speed order and counts surviving targets at each hit', () => {
  for (const generation of [4, 5]) {
    const { plan, dataset, p0, p1, e0, e1 } = fixture();
    dataset.mechanics.damageGeneration = generation;
    const calls = [];
    const outcomes = resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, dataset,
      actions: { player: [move(p0, 'earthquake'), move(p1, 'irondefense', [p1])], enemy: [move(e0, 'tackle', [p0]), move(e1, 'tackle', [p0])] },
      damageAdapter: damageAdapter(input => { if (input.move.id !== 'earthquake') return [0]; calls.push([input.defender.combatantKey, input.spreadTargetCount]); return [999]; }) });
    assert.equal(outcomes.length, 1);
    if (generation === 4) assert.deepEqual(calls, [[p1, 3], [e1, 2], [e0, 1]]);
    else assert.ok(calls.every(([, count]) => count === 3), 'Gen 5 retains its initial spread count');
  }
});

test('Gen 4 spread counts include surviving protected targets', () => {
  const { plan, dataset, p0, p1, e0, e1 } = fixture();
  const calls = [];
  resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, dataset,
    actions: { player: [move(p0, 'earthquake'), move(p1, 'protect', [p1])], enemy: [move(e0, 'tackle', [p0]), move(e1, 'tackle', [p0])] },
    damageAdapter: damageAdapter(input => { if (input.move.id !== 'earthquake') return [0]; calls.push([input.defender.combatantKey, input.spreadTargetCount]); return [999]; }) });
  assert.deepEqual(calls, [[e1, 3], [e0, 2]], 'Protect does not remove a living target from the count');
});

test('Gen 4 speed-order sort respects Trick Room, order items, Stall and source tie probabilities', () => {
  const { plan, state, p0, p1, e0, e1 } = fixture();
  const order = (options = {}) => gen4BattlerSpeedOrders({ plan, state, entries: activeEntries(state), ...options });
  state.fieldState.global.trickRoomTurns = 3;
  assert.deepEqual(order()[0].entries.map(row => row.combatantKey), [e0, e1, p1, p0]);
  state.combatantStates[p0].currentItemId = 'quickclaw'; state.combatantStates[p0].itemState = 'held';
  assert.deepEqual(order({ orderItems: { 'player:0': { quickclaw: true } } })[0].entries.map(row => row.combatantKey), [p0, e0, e1, p1]);
  state.combatantStates[p0].currentItemId = null;
  state.combatantStates[e0].currentAbilityId = 'stall';
  state.combatantStates[p0].currentItemId = 'laggingtail';
  assert.deepEqual(order()[0].entries.map(row => row.combatantKey), [e1, p1, e0, p0]);
  state.combatantStates[p0].currentItemId = null;
  state.combatantStates[e0].currentAbilityId = '';
  state.fieldState.global.trickRoomTurns = 0;
  const entries = activeEntries(state).filter(row => row.combatantKey !== p1);
  for (const entry of entries) state.combatantStates[entry.combatantKey].currentStats.spe = 100;
  const ties = gen4BattlerSpeedOrders({ plan, state, entries });
  assert.equal(ties.length, 6);
  assert.deepEqual(ties.map(row => row.probability).sort(), [0.125, 0.125, 0.125, 0.125, 0.25, 0.25]);
  assert.equal(ties.reduce((sum, row) => sum + row.probability, 0), 1);
});

test('Gen 4 empty slots retain fainted identity through plan serialization and clear it on replacement', () => {
  const { plan, state, dataset, players, enemies, p0, p1, e0, e1 } = fixture();
  for (const mon of enemies.slice(2)) state.combatantStates[mon.combatantKey].hp = { min: 0, max: 0, maxHp: 100 };
  const [outcome] = resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, dataset,
    actions: { player: [move(p0, 'tackle', [e1]), move(p1, 'irondefense', [p1])], enemy: [move(e0, 'tackle', [p0]), move(e1, 'tackle', [p0])] },
    damageAdapter: damageAdapter(input => input.attacker.combatantKey === p0 ? [999] : [0]) });
  assert.equal(outcome.state.active.enemyCombatantKeys[1], null);
  assert.equal(outcome.state.active.faintedCombatantKeysByPosition.enemy[1], e1);
  assert.equal(outcome.state.combatantStates[e1].statStages.spe, 0);
  assert.ok(!activeEntries(outcome.state).some(row => row.combatantKey === e1));
  plan.stateNodes[plan.initialStateNodeId] = outcome.state;
  const roundTrip = parsePlan(serializePlan(plan));
  const restored = roundTrip.stateNodes[plan.initialStateNodeId];
  assert.equal(restored.active.faintedCombatantKeysByPosition.enemy[1], e1);
  const before = updateStateHash(restored).stateHash;
  setActiveKey(restored, 'enemy', 1, e1);
  assert.equal(restored.active.faintedCombatantKeysByPosition.enemy[1], null);
  assert.notEqual(updateStateHash(restored).stateHash, before);
});

test('Gen 4 speed truncates source operations and applies Simple and raw speed-halving items', () => {
  const { plan, state, p0 } = fixture();
  const mon = state.combatantStates[p0];
  const speed = () => effectiveActionSpeed({ combatant: plan.combatants[p0], combatantState: mon, battleState: state, side: 'player', generation: 4 });
  mon.currentStats.spe = 101; mon.statStages.spe = -1; mon.currentItemId = 'choicescarf'; mon.itemState = 'held';
  assert.equal(speed(), 100, 'floor(101 * 2/3) is rounded before Choice Scarf');
  mon.currentAbilityId = 'simple'; mon.currentItemId = null;
  assert.equal(speed(), 50);
  mon.currentAbilityId = 'klutz'; mon.statStages.spe = 0; mon.currentItemId = 'ironball'; mon.volatileConditions.embargoTurns = 2;
  assert.equal(speed(), 50, 'raw speed-halving item effect survives Klutz and Embargo');
});

test('Gen 4 spread order does not transfer consumed Custap priority to a replacement', () => {
  const { plan, state, p0, e0 } = fixture();
  state.combatantStates[e0].currentStats.spe = 1000;
  const orders = gen4BattlerSpeedOrders({ plan, state, entries: activeEntries(state), orderItems: { 'player:0': { combatantKey: 'old-occupant', custapberry: true } } });
  assert.equal(orders[0].entries[0].combatantKey, e0);
  state.combatantStates[p0].currentItemId = 'custapberry'; state.combatantStates[p0].itemState = 'held';
  state.combatantStates[p0].hp = { min: 20, max: 30, maxHp: 100 };
  assert.throws(() => gen4BattlerSpeedOrders({ plan, state, entries: activeEntries(state) }), /requires resolved HP/);
});

test('Gen 4 switch clears revealed ability memory and a new entry announcement overwrites it', () => {
  for (const ability of ['', 'pressure']) {
    const { plan, dataset, players, enemies } = fixturePlan();
    dataset.mechanics.damageGeneration = 4; dataset.abilityKnowledgePolicy = policy;
    const state = plan.stateNodes[plan.initialStateNodeId];
    const [lead, reserve] = players.map(mon => mon.combatantKey), enemy = enemies[0].combatantKey;
    initializeAbilityKnowledge(state, policy);
    observeAbilityEvent(state, { eventType: 'ability-activated', actorKey: lead, metadata: { cause: 'pressure' } }, policy);
    assert.equal(state.trainerAiBelief.abilityByPosition.player[0], 'pressure');
    state.combatantStates[reserve].currentAbilityId = ability; plan.combatants[reserve].originalAbilityId = ability;
    const [outcome] = resolveTurn({ plan, parentStateNodeId: plan.initialStateNodeId, dataset,
      actions: { player: { actionType: 'switch', actorKey: lead, switchToKey: reserve }, enemy: move(enemy, 'tackle', [lead]) }, damageAdapter: damageAdapter(() => [0]) });
    assert.equal(outcome.state.trainerAiBelief.abilityByPosition.player[0], ability || null);
  }
});
