import fs from 'node:fs';
import path from 'node:path';
import {shellBellFixture} from '../tests/item_effect_fixture.mjs';
import {vw2rMoveSupport} from '../src/rulesets/vw2r_move_support.js';
import {resolveTurn} from '../src/core/resolver.js';
const root=process.env.PLC_ITEM_REFERENCE_ROOT;
if(!root)throw Error('Set PLC_ITEM_REFERENCE_ROOT');
const ref=JSON.parse(fs.readFileSync(path.join(root,'held_item_known_answers.json')));
const source=name=>JSON.parse(fs.readFileSync(new URL(`../src/generated/datasets/volt-white-2r/${name}.json`,import.meta.url))).records;
const failures=[];let passed=0;
for(const spec of ref.cases){
  const f=shellBellFixture({...spec,noItem:true,hp:200,targetHp:200},spec.generation);
  for(const kind of ['types','natures'])for(const [id,record] of Object.entries(source(kind)))f.dataset.indexes[kind].set(id,record);
  const holderKey=spec.defender?f.enemyKey:f.playerKey,holder=f.root.combatantStates[holderKey];
  holder.hp.min=holder.hp.max=spec.hp??200;holder.currentItemId=spec.itemId;holder.itemState='held';
  if(spec.types)holder.currentTypeIds=spec.types.map(x=>x.toLowerCase());
  if(spec.status){holder.majorStatus=spec.status;holder.toxicCounter=1;if(spec.status==='slp')holder.volatileConditions.sleepTurns=3;}
  if(spec.boosts)Object.assign(holder.statStages,spec.boosts);
  if(spec.volatile==='confusion')holder.volatileConditions.confusionTurns=3;
  if(spec.volatile==='attract')holder.volatileConditions.attractSourceKey=spec.defender?f.playerKey:f.enemyKey;
  if(spec.suppression==='embargo')holder.volatileConditions.embargoTurns=3;
  if(spec.suppression==='magicroom')f.root.fieldState.global.magicRoomTurns=3;
  if(spec.suppression==='klutz')holder.currentAbilityId='klutz';
  if(spec.pp===0){
    holder.movePp.splash=0;holder.movePp.tackle=40;f.plan.combatants[holderKey].moves.push({moveId:'tackle',maxPp:40});
    f.dataset.indexes.moves.set('tackle',{...source('moves').tackle,accuracy:true});
    f.actions.player[0].moveId='tackle';f.actions.player[0].targetKeys=[f.enemyKey];
  }
  const snapshot=(state,active)=>({hp:state.hp.min,item:state.currentItemId||'',status:state.majorStatus||null,boosts:state.statStages,active:active&&state.hp.max>0,
    focusenergy:!!state.volatileConditions.focusenergy,confusion:!!state.volatileConditions.confusionTurns,
    micleberry:!!state.volatileConditions.micleberry,choice:state.volatileConditions.choiceLockedMoveId||null});
  try{
    const rows=resolveTurn({plan:f.plan,parentStateNodeId:f.plan.initialStateNodeId,dataset:f.dataset,actions:f.actions,
      moveSupport:(move,dataset)=>{const d=vw2rMoveSupport(move,dataset);return spec.noSecondary?{...d,operations:d.operations?.filter(op=>op.chance===undefined||op.chance>=100)}:d;},
      damageAdapter:{supportsCriticalHits:false,calculate:({attacker})=>({status:'ok',damage:[attacker.combatantKey===f.playerKey?spec.damage??40:0]})}}).filter(row=>row.outcome.probability!==0);
    const actual=rows.map(row=>({actor:snapshot(row.state.combatantStates[f.playerKey],row.state.active.playerCombatantKeys.includes(f.playerKey)),target:snapshot(row.state.combatantStates[f.enemyKey],row.state.active.enemyCombatantKeys.includes(f.enemyKey))}));
    // A seeded reference sample must be present among PLC's exact random branches.
    if(!actual.some(row=>JSON.stringify(row)===JSON.stringify(spec.expected)))failures.push({generation:spec.generation,id:spec.id,expected:spec.expected,actual});else passed++;
  }catch(error){failures.push({generation:spec.generation,id:spec.id,error:error.message});}
}
fs.mkdirSync('.codex-tmp',{recursive:true});
fs.writeFileSync('.codex-tmp/held-item-sweep-results.json',JSON.stringify({passed,total:ref.cases.length,failures},null,2)+'\n');
console.log(JSON.stringify({passed,total:ref.cases.length,failures:failures.map(({generation,id,error})=>({generation,id,error}))}));
if(failures.length)process.exitCode=1;
