import assert from 'node:assert/strict';
import test from 'node:test';
import { shellBellFixture } from './item_effect_fixture.mjs';

test('Shell Bell heals from actual damage, caps HP, and stays held across turns', () => {
  const f=shellBellFixture();
  const outcomes=f.run();assert.ok(outcomes.length);
  for(const outcome of outcomes){
    assert.equal(outcome.state.combatantStates[f.playerKey].hp.min,55);
    assert.equal(outcome.state.combatantStates[f.playerKey].currentItemId,'shellbell');
    assert.equal(outcome.state.combatantStates[f.playerKey].itemState,'held');
    assert.ok(outcome.events.some(e=>e.eventType==='heal'&&e.metadata.itemId==='shellbell'));
    assert.equal(outcome.events.some(e=>e.eventType==='item-consumed'),false);
  }
  for(const [spec,hp] of [[{targetHp:10,damage:80},51],[{hp:339},341],[{damage:7},51]]) {
    const item=shellBellFixture(spec);for(const o of item.run())assert.equal(o.state.combatantStates[item.playerKey].hp.min,hp);
  }
  f.plan.stateNodes[f.plan.initialStateNodeId] = structuredClone(outcomes[0].state);
  for (const action of Object.values(f.actions).flat()) action.declaredAtStateHash = outcomes[0].state.stateHash;
  for (const outcome of f.run()) {
    assert.equal(outcome.state.combatantStates[f.playerKey].hp.min,60);
    assert.equal(outcome.state.combatantStates[f.playerKey].itemState,'held');
  }
});

test('a called move uses its own secondary effects for Sheer Force suppression', () => {
  const f=shellBellFixture({moveId:'flamethrower',ability:'sheerforce'});
  f.dataset.gameId='volt-white-2r';
  f.dataset.indexes.moves.set('metronome',{id:'metronome',name:'Metronome',category:'status',type:'normal',target:'self',accuracy:true,pp:10});
  f.plan.combatants[f.playerKey].moves=[{moveId:'metronome',maxPp:10}];
  f.holder.movePp.metronome=10;
  Object.assign(f.actions.player[0],{moveId:'metronome',targetKeys:[f.playerKey],mechanicActivations:[{id:'called-move',moveId:'flamethrower',targetKey:f.enemyKey}]});
  for(const outcome of f.run()) {
    assert.ok(outcome.events.some(event=>event.eventType==='move-called'),JSON.stringify(outcome.events));
    assert.equal(outcome.state.combatantStates[f.playerKey].hp.min,50);
  }
});

test('damage-roll outcomes retain correlated defender HP and Shell Bell recovery', () => {
  const f=shellBellFixture({damageRolls:[8,40]});
  const rows=f.run();assert.equal(rows.length,2);
  assert.deepEqual(rows.map(o=>[o.state.combatantStates[f.playerKey].hp.min,o.state.combatantStates[f.enemyKey].hp.min,o.outcome.probability]).sort((a,b)=>a[0]-b[0]),[[51,92,.5],[55,60,.5]]);
});

test('Shell Bell does not infer damage from ranges without a probability distribution', () => {
  const f=shellBellFixture();f.root.combatantStates[f.enemyKey].hp.min=50;
  assert.throws(f.run,/exact target HP distribution/);
});

test('persistent item contracts reject unknown effects and conditions', () => {
  for(const mutate of [rule=>rule.conditions.guessedCondition=true,rule=>rule.effects[0].kind='unknown',rule=>rule.consumeOnActivation=true]){
    const f=shellBellFixture();mutate(f.dataset.get('items','shellbell').heldItemMechanics.activations[0]);
    assert.throws(f.run,/unsupported persistent item activation contract/);
  }
});
