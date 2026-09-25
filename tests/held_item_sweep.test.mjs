import assert from 'node:assert/strict';
import test from 'node:test';
import { shellBellFixture } from './item_effect_fixture.mjs';
import { createSharedDamageAdapter } from '../src/adapters/shared_damage_adapter.js';

function fixture(item, spec = {}, generation = 5) {
  const f = shellBellFixture({ noItem: true, hp: 200, targetHp: 200, ...spec }, generation);
  Object.assign(f.holder, { currentItemId: item, itemState: 'held' });
  return f;
}
function advance(f, outcome) {
  const state = structuredClone(outcome.state);
  state.turnNumber = Number(state.turnNumber || 0) + 1;
  f.plan.stateNodes[f.plan.initialStateNodeId] = state;
  for (const action of Object.values(f.actions).flat()) action.declaredAtStateHash = state.stateHash;
  return state.combatantStates[f.playerKey];
}

test('Metronome tracks successful repeats, resets after a miss, and survives serialization', () => {
  const f = fixture('metronome', { damage: 1 });
  let outcome = f.run()[0];
  assert.equal(outcome.state.combatantStates[f.playerKey].volatileConditions.metronome.repeats, 0);
  advance(f, outcome);
  outcome = f.run()[0];
  assert.equal(outcome.state.combatantStates[f.playerKey].volatileConditions.metronome.repeats, 1);
  advance(f, outcome);
  f.dataset.indexes.moves.get('tackle').accuracy = 0;
  outcome = f.run().find(row => row.outcome.probability === 1);
  assert.equal(outcome.state.combatantStates[f.playerKey].volatileConditions.metronome.successful, false);
  advance(f, outcome);
  f.dataset.indexes.moves.get('tackle').accuracy = true;
  assert.equal(f.run()[0].state.combatantStates[f.playerKey].volatileConditions.metronome.repeats, 0);
});

test('the PLC damage adapter forwards the Metronome count without a base-power approximation', () => {
  const f = fixture('metronome');
  f.holder.volatileConditions.metronome = { repeats: 3 };
  let received;
  const adapter = createSharedDamageAdapter({ready: true, calculate(request) {
    received = request;
    return { status: 'unavailable', reason: 'captured request' };
  }});
  adapter.calculate({attacker: f.plan.combatants[f.playerKey], defender: f.plan.combatants[f.enemyKey],
    attackerState: f.holder, defenderState: f.root.combatantStates[f.enemyKey],
    move: f.dataset.get('moves', 'tackle'), fieldState: f.root.fieldState});
  assert.equal(received.timesUsedWithMetronome, 3);
  assert.equal(received.moveOverrides, undefined);
});

test('Micle Berry boosts one accuracy check and expires when no move is attempted', () => {
  const f = fixture('', { damage: 1 });
  f.holder.volatileConditions.micleberry = true;
  f.holder.volatileConditions.micleBerryTurns = 1;
  f.dataset.indexes.moves.get('tackle').accuracy = 50;
  const outcomes = f.run();
  assert.ok(Math.abs(outcomes.filter(row => row.events.some(e => e.eventType === 'damage' && e.actorKey === f.playerKey))
    .reduce((sum, row) => sum + row.outcome.probability, 0) - .6) < 1e-9);
  for (const row of outcomes) assert.equal(Boolean(row.state.combatantStates[f.playerKey].volatileConditions.micleberry), false);
  const resting = fixture('');
  resting.holder.volatileConditions.micleberry = true;
  resting.holder.volatileConditions.micleBerryTurns = 1;
  resting.holder.volatileConditions.rechargeRequired = true;
  resting.holder.lastMoveId = 'tackle';
  for (const row of resting.run()) assert.equal(Boolean(row.state.combatantStates[resting.playerKey].volatileConditions.micleberry), false);
});

test('Focus Band has a ten-percent survival branch and remains held', () => {
  const f = fixture('', { damage: 300 });
  Object.assign(f.root.combatantStates[f.enemyKey], { currentItemId: 'focusband', itemState: 'held' });
  const rows = f.run();
  const survivors = rows.filter(row => row.state.combatantStates[f.enemyKey].hp.max > 0);
  assert.ok(Math.abs(survivors.reduce((sum,row) => sum + row.outcome.probability,0) - .1) < 1e-9);
  for (const row of survivors) {
    assert.equal(row.state.combatantStates[f.enemyKey].hp.min, 1);
    assert.equal(row.state.combatantStates[f.enemyKey].currentItemId, 'focusband');
  }
});

test('Starf Berry enumerates every eligible stat with equal probability', () => {
  const f = fixture('starfberry', { hp: 40, moveId: 'splash', damage: 0 });
  f.holder.statStages.atk = 6;
  const rows = f.run();
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.outcome.probability, .25);
    assert.equal(row.state.combatantStates[f.playerKey].currentItemId, '');
    assert.equal(Object.values(row.state.combatantStates[f.playerKey].statStages).filter(value => value === 2).length, 1);
  }
});

test('King\'s Rock uses generation-specific move eligibility and independent hit chances', () => {
  for (const [generation, moveId, ability, expected] of [[3,'tackle','',.1],[4,'icebeam','',0],[5,'icebeam','',.1],
    [5,'tackle','serenegrace',.2],[5,'icebeam','sheerforce',.1],[5,'doublehit','',.19]]) {
    for (const item of generation >= 4 ? ['kingsrock','razorfang'] : ['kingsrock']) {
    const f = fixture(item, {moveId, ability, damage:1}, generation);
    const rows = f.run();
    const chance = rows.filter(row => row.events.some(e => e.eventType === 'action-skipped' && e.actorKey === f.enemyKey && e.reason === 'flinch'))
      .reduce((sum,row) => sum + row.outcome.probability,0);
    assert.ok(Math.abs(chance - expected) < 1e-9, `${generation}/${moveId}/${ability}: ${chance}`);
    }
  }
});

test('Grip Claw fixes the trapping duration; Binding Band records its damage multiplier', () => {
  for (const [gen,item,expectedTurns,damage] of [[4,'gripclaw',[4],21],[5,'gripclaw',[6],21],[5,'bindingband',[3,4],42],
    [4,'',[1,2,3,4],21],[5,'',[3,4],21]]) {
    const f = fixture(item, {moveId:'bind',damage:1},gen);
    const rows = f.run();
    assert.deepEqual([...new Set(rows.map(row => row.state.combatantStates[f.enemyKey].volatileConditions.partiallyTrappedTurns))].sort(),expectedTurns);
    for (const row of rows) assert.equal(row.state.combatantStates[f.enemyKey].hp.min, 199 - damage);
  }
});

test('Destiny Knot reflects Attract, but suppression leaves only the original infatuation', () => {
  for (const suppressed of [false,true]) {
    const f = fixture('', {moveId:'attract'});
    f.actions.player[0].targetKeys = [f.enemyKey];
    f.plan.combatants[f.playerKey].gender = 'M';
    f.plan.combatants[f.enemyKey].gender = 'F';
    const target = f.root.combatantStates[f.enemyKey];
    Object.assign(target,{currentItemId:'destinyknot',itemState:'held'});
    if (suppressed) target.volatileConditions.embargoTurns = 3;
    for (const row of f.run()) {
      assert.equal(row.state.combatantStates[f.enemyKey].volatileConditions.attractSourceKey,f.playerKey);
      assert.equal(Boolean(row.state.combatantStates[f.playerKey].volatileConditions.attractSourceKey),!suppressed);
    }
  }
});

test('Unnerve prevents Custap Berry activation without consuming it', () => {
  const f = fixture('custapberry', {hp:40,moveId:'splash'});
  f.root.combatantStates[f.enemyKey].currentAbilityId = 'unnerve';
  for (const row of f.run()) assert.equal(row.state.combatantStates[f.playerKey].currentItemId,'custapberry');
});

test('Thief cannot destroy an item when the attacker already holds one', () => {
  const f = fixture('leftovers',{moveId:'thief',damage:1});
  Object.assign(f.root.combatantStates[f.enemyKey],{currentItemId:'shellbell',itemState:'held'});
  for (const row of f.run()) assert.equal(row.state.combatantStates[f.enemyKey].currentItemId,'shellbell');
});

test('transfer restrictions remain active during item suppression', () => {
  for (const generation of [4,5]) {
    const f = fixture('',{moveId:'thief',damage:1},generation);
    const target = f.root.combatantStates[f.enemyKey];
    Object.assign(target,{currentItemId:'griseousorb',itemState:'held'});
    target.volatileConditions.embargoTurns = 3;
    const speciesId = f.plan.combatants[f.enemyKey].speciesId;
    f.dataset.indexes.species.get(speciesId).num = 487;
    for (const row of f.run()) assert.equal(row.state.combatantStates[f.enemyKey].currentItemId,'griseousorb');
  }
});

test('Shed Shell permits escape from trapping abilities only while active', () => {
  for (const suppressed of [false,true]) {
    const f = fixture('shedshell');
    f.root.combatantStates[f.enemyKey].currentAbilityId = 'shadowtag';
    if (suppressed) f.holder.volatileConditions.embargoTurns = 3;
    f.actions.player[0] = {actionType:'switch',actorKey:f.playerKey,switchToKey:f.players[1].combatantKey,declaredAtStateHash:f.root.stateHash};
    if (suppressed) assert.throws(f.run,/prevents.*switching/);
    else for (const row of f.run()) assert.ok(row.state.active.playerCombatantKeys.includes(f.players[1].combatantKey));
  }
});

test('Genesect drives cannot be transferred away from their holder', () => {
  for (const item of ['burndrive','chilldrive','dousedrive','shockdrive']) {
    const f = fixture('',{moveId:'thief',damage:1});
    Object.assign(f.root.combatantStates[f.enemyKey],{currentItemId:item,itemState:'held'});
    f.dataset.indexes.species.get(f.plan.combatants[f.enemyKey].speciesId).num=649;
    for(const row of f.run()) assert.equal(row.state.combatantStates[f.enemyKey].currentItemId,item);
  }
});

test('Bestow respects held-item transfer restrictions on both participants', () => {
  for (const protectedSide of ['holder','recipient',null]) {
    const f=fixture('burndrive',{moveId:'bestow',damage:0});
    f.actions.player[0].targetKeys=[f.enemyKey];
    for (const [key,num] of [[f.playerKey,protectedSide==='holder'?649:151],[f.enemyKey,protectedSide==='recipient'?649:151]]) {
      const id=f.plan.combatants[key].speciesId;
      f.dataset.indexes.species.set(id,{...f.dataset.indexes.species.get(id),num});
    }
    for(const row of f.run()) {
      assert.equal(row.state.combatantStates[f.playerKey].currentItemId,protectedSide?'burndrive':'');
      assert.equal(row.state.combatantStates[f.enemyKey].currentItemId,protectedSide?'':'burndrive');
    }
  }
});
