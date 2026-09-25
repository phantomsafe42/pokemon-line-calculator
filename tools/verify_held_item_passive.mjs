import fs from 'node:fs';
import path from 'node:path';
import {shellBellFixture} from '../tests/item_effect_fixture.mjs';
import {effectiveActionSpeed} from '../src/rulesets/action_order.js';
import {effectiveAccuracy,criticalHitProbability} from '../src/rulesets/battle_rules.js';
const root=process.env.PLC_ITEM_REFERENCE_ROOT;if(!root)throw Error('Set PLC_ITEM_REFERENCE_ROOT');
const ref=JSON.parse(fs.readFileSync(path.join(root,'held_item_passive_answers.json'))), failures=[],cartridgeResolved=[];
const cartridge=JSON.parse(fs.readFileSync(path.join(root,'cartridge_item_rounding_answers.json')));
for(const row of ref.cases){
 const f=shellBellFixture({noItem:true},row.generation),actor=f.holder,target=f.root.combatantStates[f.enemyKey];
 const holder=row.defender?target:actor;
 Object.assign(holder,{currentItemId:row.itemId,itemState:'held'});
 actor.currentSpeciesId=row.species.toLowerCase().replace(/[^a-z0-9]/g,'');
 f.plan.combatants[f.playerKey].speciesId=actor.currentSpeciesId;
 f.plan.combatants[f.playerKey].calculatedStats.spe=236;
 if(row.suppression==='embargo')holder.volatileConditions.embargoTurns=3;
 if(row.suppression==='klutz')holder.currentAbilityId='klutz';
 if(row.suppression==='magicroom')f.root.fieldState.global.magicRoomTurns=3;
 target.turnFlags.hasMoved=true;
 const actual=row.kind==='speed'?effectiveActionSpeed({combatant:f.plan.combatants[f.playerKey],combatantState:actor,battleState:f.root,side:'player',generation:row.generation})
  :row.kind==='accuracy'?effectiveAccuracy({move:{id:'tackle',category:'physical',accuracy:73},attackerState:actor,defenderState:target,fieldState:f.root.fieldState,generation:row.generation})
  :criticalHitProbability({generation:row.generation,descriptor:{critRatio:1},attacker:f.plan.combatants[f.playerKey],attackerState:actor,defenderState:target,fieldState:f.root.fieldState});
 if(Math.abs(actual-row.expected)>1e-8) {
  // HG CheckSortSpeed reads raw item effects for these speed penalties, bypassing
  // Embargo/Klutz (pinned source SHA and URL in cartridge rounding evidence).
  const witness=cartridge.passiveCases.find(entry=>['generation','kind','itemId','suppression'].every(key=>entry[key]===row[key]));
  if(witness&&actual===witness.expected)cartridgeResolved.push({...row,actual,source:witness.sourceId,sourceLines:witness.sourceLines});
  else failures.push({...row,actual});
 }
}
fs.writeFileSync('.codex-tmp/held-item-passive-results.json',JSON.stringify({total:ref.cases.length,passed:ref.cases.length-failures.length-cartridgeResolved.length,failures,cartridgeResolved},null,2)+'\n');
console.log(JSON.stringify({total:ref.cases.length,failed:failures.length,cartridgeResolved:cartridgeResolved.length,failures}));
if(failures.length)process.exitCode=1;
