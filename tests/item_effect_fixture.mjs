import fs from 'node:fs';
import { fixturePlan, fixtureDoublesPlan } from './helpers.mjs';
import { resolveTurn } from '../src/core/resolver.js';
import { vw2rMoveSupport } from '../src/rulesets/vw2r_move_support.js';

const source = name => JSON.parse(fs.readFileSync(new URL(`../src/generated/datasets/volt-white-2r/${name}.json`, import.meta.url))).records;
const moves = source('moves'), items = source('items');

export function shellBellFixture(spec = {}, generation = 5) {
  const f = spec.format === 'doubles' ? fixtureDoublesPlan() : fixturePlan();
  const root = f.plan.stateNodes[f.plan.initialStateNodeId];
  const playerKey = f.players[0].combatantKey, enemyKey = f.enemies[0].combatantKey;
  const moveId = spec.moveId || 'tackle';
  f.dataset.mechanics.damageGeneration = generation;
  for(const [id,item] of Object.entries(items)) f.dataset.indexes.items.set(id, structuredClone(item));
  for(const kind of ['types','natures']) for(const [id,record] of Object.entries(source(kind))) f.dataset.indexes[kind].set(id,structuredClone(record));
  for (const id of new Set([moveId, 'splash', 'protect'])) {
    f.dataset.indexes.moves.set(id, { ...moves[id], accuracy: id === moveId && spec.miss ? 0 : true,
      ...(id === 'surf' ? {target:generation===3?'allAdjacentFoes':'allAdjacent'} : {}) });
  }
  const actions = {player:[],enemy:[]};
  for (const [key, record] of Object.entries(f.plan.combatants)) {
    const mon = root.combatantStates[key];
    mon.hp = {min:100,max:100,maxHp:341};delete mon.hpDistribution;
    mon.currentAbilityId='';mon.currentItemId='';mon.itemState='none';mon.majorStatus=null;
    mon.currentTypeIds=['psychic'];
    record.originalTypeIds=['psychic'];
    record.calculatedStats.spe = key === playerKey ? 300 : key === enemyKey ? 100 : record.side==='player'?70:50;
    const id=key===playerKey?moveId:key===enemyKey&&spec.protect?'protect':'splash';
    record.moves=[{moveId:id,maxPp:40}];mon.movePp={[id]:40};
    if(root.active[`${record.side}CombatantKeys`].includes(key))actions[record.side].push({actionType:'move',actorKey:key,moveId:id,
      targetKeys:[key===playerKey&&moves[id].category!=='status'?enemyKey:key],mechanicActivations:[],declaredAtStateHash:root.stateHash});
  }
  const holder=root.combatantStates[playerKey];holder.hp.min=holder.hp.max=spec.hp??50;
  holder.currentItemId=spec.noItem?'':'shellbell';holder.itemState=spec.noItem?'none':'held';holder.currentAbilityId=spec.ability||'';
  if(spec.healBlock)holder.volatileConditions.healBlockTurns=3;
  if(spec.embargo)holder.volatileConditions.embargoTurns=3;
  if(spec.magicRoom)root.fieldState.global.magicRoomTurns=3;
  root.combatantStates[enemyKey].hp.min=root.combatantStates[enemyKey].hp.max=spec.targetHp??100;
  if(spec.targetAbility)root.combatantStates[enemyKey].currentAbilityId=spec.targetAbility;
  if(spec.substituteHp)root.combatantStates[enemyKey].volatileConditions.substituteHp=spec.substituteHp;
  if(spec.noReserve)for(const mon of Object.values(f.plan.combatants).filter(mon=>mon.side==='player'&&mon.combatantKey!==playerKey)){
    delete f.plan.combatants[mon.combatantKey];delete root.combatantStates[mon.combatantKey];
  }
  if(moveId==='uturn'&&!spec.noReserve)actions.player[0].mechanicActivations=[{id:'after-move-switch',switchToKey:f.players[1].combatantKey}];
  const run=()=>resolveTurn({plan:f.plan,parentStateNodeId:f.plan.initialStateNodeId,dataset:f.dataset,actions,moveSupport:vw2rMoveSupport,
    damageAdapter:{supportsCriticalHits:false,calculate:({attacker,moveHits})=>({status:'ok',damage:attacker.combatantKey===playerKey
      ? (spec.damageRolls||[spec.damage??40]).map(value=>value*(moveHits||1)) : [0]})}});
  return {...f,root,holder,playerKey,enemyKey,actions,run};
}
