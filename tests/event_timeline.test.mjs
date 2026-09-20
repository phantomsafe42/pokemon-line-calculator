import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventTimeline, startEventTrace, captureEventTrace, displayCombatant } from '../src/core/event_timeline.js';
import { resolveTurn, resolveForcedReplacement } from '../src/core/resolver.js';
import { previewTurn, commitPreview, previewForcedReplacement, commitForcedReplacement } from '../src/core/planner.js';
import { upgradeInitialEntryEffects } from '../src/core/plan.js';
import { serializePlan, parsePlan } from '../src/contracts/plan_file.js';
import { fixturePlan, fixtureDoublesPlan, fixtureTriplePlan, fixtureRotationPlan, damageAdapter as fixtureDamageAdapter } from './helpers.mjs';
const damageAdapter = values => fixtureDamageAdapter(() => values);
const move = (actorKey, moveId, targetKey) => ({ actionType: 'move', actorKey, moveId, targetKeys: targetKey ? [targetKey] : [], mechanicActivations: [], declaredAtStateHash: 'fixture' });
const strip = values => values.map(value => { const next=structuredClone(value); for(const event of next.events)delete event.metadata.presentation;return next; });

for (const [format, factory] of [['singles',fixturePlan],['doubles',fixtureDoublesPlan],['triples',fixtureTriplePlan],['rotation',fixtureRotationPlan]]) {
  test(`event trace preserves ${format} mechanics and produces damage-time HP`, () => {
    const {plan,dataset}=factory();
    const base=plan.stateNodes[plan.initialStateNodeId];
    const p=base.active.playerCombatantKeys,e=base.active.enemyCombatantKeys;
    const actions={player:p.slice(0,format==='rotation'?1:p.length).map(key=>move(key,'tackle',format==='rotation'?e[0]:e[2]||e[1]||e[0])),enemy:e.slice(0,format==='rotation'?1:e.length).map(key=>move(key,'tackle',format==='rotation'?p[0]:p[1]||p[0]))};
    const before=JSON.stringify(plan);
    const args={plan,dataset,parentStateNodeId:plan.initialStateNodeId,actions,damageAdapter:damageAdapter([10])};
    const ordinary=resolveTurn(args), traced=resolveTurn({...args,capturePresentation:true});
    assert.deepEqual(strip(traced),ordinary);
    assert.equal(JSON.stringify(plan),before);
    for(const outcome of traced){
      const frames=createEventTimeline(base,outcome.events);
      for(const frame of frames.filter(frame=>frame.event.eventType==='damage')) {
        const prior=frame.event.metadata.targetHpBefore;
        assert.ok(frame.state.combatantStates[frame.event.targetKey].hp.max<prior.max);
      }
      assert.equal(frames.at(-1).state.stateNodeId,base.stateNodeId);
      assert.equal(Object.hasOwn(frames.at(-1).state,'childActionGroupIds'),false);
    }
  });
}

test('earlier damage does not reveal a later Triple shift',()=>{
  const {plan,dataset,players}=fixtureTriplePlan();const base=plan.stateNodes[plan.initialStateNodeId];
  const p=base.active.playerCombatantKeys,e=base.active.enemyCombatantKeys;
  const actions={player:[move(p[0],'aquajet',e[1]),move(p[1],'irondefense'),{actionType:'shift',actorKey:p[2]}],enemy:e.map(key=>move(key,'tackle',p[1]))};
  const result=resolveTurn({plan,dataset,parentStateNodeId:plan.initialStateNodeId,actions,damageAdapter:damageAdapter([5]),capturePresentation:true})[0];
  const frames=createEventTimeline(base,result.events);
  const attack=frames.find(frame=>frame.event.moveId==='aquajet'&&frame.event.eventType==='damage');
  assert.deepEqual(attack.state.active.playerCombatantKeys,p);
  const shifted=frames.find(frame=>frame.event.eventType==='shift');
  assert.equal(shifted.state.active.playerCombatantKeys[1],p[2]);
  assert.deepEqual(attack.state.active.playerCombatantKeys,p);
});

test('damage then recovery retains both event-time values; no input mutation',()=>{
  const {plan,dataset,players,enemies}=fixturePlan();const base=plan.stateNodes[plan.initialStateNodeId];
  const p=players[0].combatantKey,e=enemies[0].combatantKey;
  plan.combatants[e].moves=[{moveId:'recover',maxPp:10}];base.combatantStates[e].movePp.recover=10;
  const result=resolveTurn({plan,dataset,parentStateNodeId:plan.initialStateNodeId,actions:{player:move(p,'tackle',e),enemy:move(e,'recover')},damageAdapter:damageAdapter([10]),capturePresentation:true})[0];
  const original=JSON.stringify(result); const frames=createEventTimeline(base,result.events);
  const damaged=frames.find(frame=>frame.event.eventType==='damage'),healed=frames.find(frame=>frame.event.eventType==='heal');
  assert.equal(damaged.state.combatantStates[e].hp.max,base.combatantStates[e].hp.max-10);
  assert.equal(healed.state.combatantStates[e].hp.max,base.combatantStates[e].hp.max);
  assert.equal(JSON.stringify(result),original);
});

test('trace can be committed and imported without altering branch identity',()=>{
  const {plan,dataset,players,enemies}=fixturePlan();const p=players[0].combatantKey,e=enemies[0].combatantKey;
  const args={plan,dataset,parentStateNodeId:plan.initialStateNodeId,actions:{player:move(p,'tackle',e),enemy:move(e,'tackle',p)},damageAdapter:damageAdapter([10]),capturePresentation:true};
  const preview=previewTurn(args);const committed=commitPreview(plan,preview,dataset,{commitSelectedOnly:true});
  const imported=parsePlan(serializePlan(committed.plan));
  const replay=previewTurn({...args,plan:imported,expandExisting:true});
  assert.equal(replay.previewStatus,'existing-expanded');
  assert.ok(replay.savedPreviewOutcomeIds.length);
  assert.ok(Object.values(imported.resolutionEvents).some(event=>event.metadata.presentation));
});

test('switch snapshot and entry effects are separate, including saved replacement prefixes',()=>{
  const {plan,dataset,players,enemies}=fixturePlan();const base=plan.stateNodes[plan.initialStateNodeId];
  const p=players[0].combatantKey,incoming=players[1].combatantKey,e=enemies[0].combatantKey;
  plan.combatants[incoming].originalAbilityId='intimidate';base.combatantStates[incoming].currentAbilityId='intimidate';
  const args={plan,dataset,parentStateNodeId:plan.initialStateNodeId,actions:{player:{actionType:'switch',actorKey:p,switchToKey:incoming},enemy:move(e,'tackle',p)},damageAdapter:damageAdapter([5]),capturePresentation:true};
  const result=resolveTurn(args)[0],frames=createEventTimeline(base,result.events);
  const switched=frames.find(frame=>frame.event.eventType==='switch');
  const ability=frames.find(frame=>frame.event.eventType==='stat-stage-change');
  assert.equal(switched.state.active.playerCombatantKeys[0],incoming);
  assert.equal(switched.state.combatantStates[e].statStages.atk,0);
  assert.equal(ability.state.combatantStates[e].statStages.atk,-1);
  const prefix=result.events.slice(0,frames.indexOf(ability)+1).map(event=>({...event,metadata:{...event.metadata,phase:'start-of-turn-replacement'}}));
  const rewound=createEventTimeline(ability.state,prefix);
  assert.deepEqual(rewound[0].state.active,switched.state.active);
  assert.equal(rewound[0].state.combatantStates[e].statStages.atk,0);
});

test('untrusted trace paths cannot write prototypes',()=>{
  const {plan}=fixturePlan();const base=plan.stateNodes[plan.initialStateNodeId];
  createEventTimeline(base,[{metadata:{presentation:{version:1,changes:[{path:['combatantStates','__proto__'],after:{polluted:true}},{path:['__proto__','polluted'],after:true}]}},changes:[{path:'combatantStates.__proto__.polluted',to:true}]}]);
  assert.equal({}.polluted,undefined);
});

test('item announcement does not show damage from the following event',()=>{
  const {plan}=fixturePlan();const base=plan.stateNodes[plan.initialStateNodeId];const key=base.active.playerCombatantKeys[0];
  const branch={state:structuredClone(base),presentationTrace:startEventTrace(base)};
  branch.state.combatantStates[key].hp.min=1;branch.state.combatantStates[key].hp.max=1;branch.state.combatantStates[key].currentItemId='';
  const item={eventType:'item-consumed',targetKey:key,metadata:{}};captureEventTrace(branch,item);
  const damage={eventType:'damage',targetKey:key,metadata:{}};captureEventTrace(branch,damage);
  const frames=createEventTimeline(base,[item,damage]);
  assert.deepEqual(frames[0].state.combatantStates[key].hp,base.combatantStates[key].hp);
  assert.equal(frames[1].state.combatantStates[key].hp.max,1);
});

test('initial Intimidate and weather events rewind before replaying',()=>{
  const fixture=fixtureDoublesPlan();let {plan,dataset,players}=fixture;
  const base=plan.stateNodes[plan.initialStateNodeId];
  base.combatantStates[players[0].combatantKey].currentAbilityId='intimidate';
  base.combatantStates[players[1].combatantKey].currentAbilityId='drizzle';
  plan.initialEntryEffectsVersion=0;
  plan=upgradeInitialEntryEffects(plan,dataset).plan;
  const root=plan.stateNodes[plan.initialStateNodeId];
  const events=root.resolutionEventIds.map(id=>({...plan.resolutionEvents[id],metadata:{...plan.resolutionEvents[id].metadata,phase:'initial-entry'}}));
  const before=JSON.stringify(root),frames=createEventTimeline(root,events);
  const first=frames.find(frame=>frame.event.eventType==='stat-stage-change');
  assert.ok(first);
  assert.equal(first.state.combatantStates[first.event.targetKey].statStages.atk,-1);
  assert.equal(frames.at(-1).state.fieldState.global.weather.id,'rain');
  assert.equal(JSON.stringify(root),before);
});

test('legacy saved replacement is traced on review without mutating its node',()=>{
  const {plan,dataset,players,enemies}=fixturePlan();const p=players[0].combatantKey,e=enemies[0].combatantKey;
  const preview=previewTurn({plan,dataset,parentStateNodeId:plan.initialStateNodeId,actions:{player:move(p,'aquajet',e),enemy:move(e,'tackle',p)},damageAdapter:damageAdapter([999])});
  const ko=commitPreview(plan,preview,dataset,{commitSelectedOnly:true});
  const replacement=previewForcedReplacement({plan:ko.plan,dataset,parentStateNodeId:ko.cursorStateNodeId,replacements:{enemy:{actionType:'replacement',side:'enemy',slot:0,switchToKey:enemies[1].combatantKey,reason:'previous-active-fainted',consumesTurn:false}}});
  const replaced=commitForcedReplacement(ko.plan,replacement,dataset);
  const before=JSON.stringify(replaced.plan);
  const next=previewTurn({plan:replaced.plan,dataset,parentStateNodeId:replaced.cursorStateNodeId,actions:{player:move(p,'tackle',enemies[1].combatantKey),enemy:move(enemies[1].combatantKey,'tackle',p)},damageAdapter:damageAdapter([5]),capturePresentation:true});
  const entry=next.outcomes[0];
  assert.ok(entry.events.find(event=>event.eventType==='switch'&&event.metadata.phase==='start-of-turn-replacement').metadata.presentation);
  assert.ok(createEventTimeline(replaced.plan.stateNodes[replaced.cursorStateNodeId],entry.events).every(frame=>frame.available));
  assert.equal(JSON.stringify(replaced.plan),before);
});

test('rotation previews change fronts before attacks and preserve waiting HP',()=>{
  const {plan,dataset,players,enemies}=fixtureRotationPlan();const root=plan.stateNodes[plan.initialStateNodeId];
  const actions={player:[null,move(players[1].combatantKey,'tackle',enemies[0].combatantKey),null],enemy:[move(enemies[0].combatantKey,'tackle',players[0].combatantKey),null,null]};
  const result=resolveTurn({plan,dataset,parentStateNodeId:plan.initialStateNodeId,actions,damageAdapter:damageAdapter([5]),capturePresentation:true})[0];
  const frames=createEventTimeline(root,result.events),rotation=frames.find(frame=>frame.event.eventType==='rotation');
  assert.equal(rotation.state.rotation.frontSlots.player,1);
  for(const frame of frames)assert.deepEqual(frame.state.combatantStates[players[2].combatantKey].hp,root.combatantStates[players[2].combatantKey].hp);
});

test('untraced damage is not presented as an exact historical snapshot',()=>{
  const {plan}=fixturePlan();
  const frames=createEventTimeline(plan.stateNodes[plan.initialStateNodeId],[{eventType:'damage',metadata:{},changes:[]}]);
  assert.equal(frames[0].available,false);
});
