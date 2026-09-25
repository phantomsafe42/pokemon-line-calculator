import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const root=process.env.PLC_ITEM_REFERENCE_ROOT;
if(!root)throw Error('Set PLC_ITEM_REFERENCE_ROOT');
const ref=JSON.parse(fs.readFileSync(path.join(root,'held_item_damage_answers.json')));
const cartridge=JSON.parse(fs.readFileSync(path.join(root,'cartridge_item_rounding_answers.json')));
const window={},sandbox={window,console,require:()=>({display:()=>''})};vm.createContext(sandbox);
for(const file of ['data.production.min.js','engine.production.min.js'])vm.runInContext(fs.readFileSync(new URL(`../src/generated/battle-mechanics/vendor/smogon-calc-0.11.0/${file}`,import.meta.url),'utf8'),sandbox);
const calc=window.calc,failures=[],baselineDifferences=[],cartridgeResolved=[];let passed=0;
for(const row of ref.cases){
 try{
  const gen=calc.Generations.get(row.generation);
  const opts=item=>({level:100,ability:'',item,nature:'Hardy',evs:{hp:0,atk:0,def:0,spa:0,spd:0,spe:0},ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31}});
  const actor=new calc.Pokemon(gen,row.defender?'Mew':row.species,opts(row.defender?'':row.itemName));
  const target=new calc.Pokemon(gen,row.defender?row.species:'Mew',opts(row.defender?row.itemName:''));
  actor.ability='';target.ability='';
  const result=calc.calculate(gen,actor,target,new calc.Move(gen,row.move,{isCrit:false}));
  const actual=typeof result.damage==='number'?Array(16).fill(result.damage):Array.from(result.damage);
  if(JSON.stringify(actual)!==JSON.stringify(row.damage)) {
    actor.item='';target.item='';
    const baseline=calc.calculate(gen,actor,target,new calc.Move(gen,row.move,{isCrit:false})).damage;
    const actualBaseline=typeof baseline==='number'?Array(16).fill(baseline):Array.from(baseline);
    const witness=cartridge.cases.find(entry=>entry.generation===row.generation&&entry.itemId===row.itemId&&entry.move===row.move);
    if(witness&&JSON.stringify(actual)===JSON.stringify(witness.damage))cartridgeResolved.push({...row,actual,sourceId:witness.sourceId});
    else if(JSON.stringify(actual)===JSON.stringify(actualBaseline)&&JSON.stringify(row.damage)===JSON.stringify(row.baselineDamage))baselineDifferences.push({...row,actual,actualBaseline});
    else failures.push({...row,actual,actualBaseline});
  }else passed++;
 }catch(error){failures.push({...row,error:error.message});}
}
fs.mkdirSync('.codex-tmp',{recursive:true});fs.writeFileSync('.codex-tmp/held-item-damage-results.json',JSON.stringify({passed,total:ref.cases.length,failures,baselineDifferences,cartridgeResolved},null,2)+'\n');
console.log(JSON.stringify({passed,total:ref.cases.length,failed:failures.length,cartridgeResolved:cartridgeResolved.length,baselineDifferences:baselineDifferences.length,itemIds:[...new Set(failures.map(row=>row.itemId))]}));
if(failures.length)process.exitCode=1;
