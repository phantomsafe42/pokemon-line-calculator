import { toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { activeAbilityId } from "./ability_rules.js?v=20260905-drafts-freecalc-partners-v1";

const STATE_CONDITIONS = new Set(['battleGenerations', 'hpThreshold', 'gluttonyHpThreshold', 'requiresHealingAllowed', 'blockedByOpponentAbilityIds', 'anyStatusIds', 'requiresDepletedMovePp', 'requiresNegativeStages', 'anyVolatileIds']);
const STATE_EFFECTS = new Set(['heal', 'cure-status', 'restore-pp', 'stat-stages', 'nature-confusion', 'volatile', 'random-stat-stages', 'reset-negative-stages', 'clear-volatiles']);

export const ITEM_VOLATILE_FIELDS = Object.freeze({attract:['attractSourceKey'],taunt:['tauntTurns'],encore:['encoreTurns','encoredMoveId'],torment:['torment'],disable:['disableTurns','disabledMoveId'],healblock:['healBlockTurns']});

function validEffect(effect) {
  if (!STATE_EFFECTS.has(effect.kind)) return false;
  const fields = {
    heal: ['kind', 'amount', 'numerator', 'denominator'],
    'cure-status': ['kind', 'statusIds'],
    'restore-pp': ['kind', 'amount', 'selection'],
    'stat-stages': ['kind', 'stages'],
    'nature-confusion':['kind','dislikedStat'], volatile:['kind','id'],
    'random-stat-stages':['kind','amount'], 'reset-negative-stages':['kind'], 'clear-volatiles':['kind','ids']
  }[effect.kind];
  if (Object.keys(effect).some(key => !fields.includes(key))) return false;
  if (effect.kind === 'nature-confusion') return ['atk','def','spa','spd','spe'].includes(effect.dislikedStat);
  if (effect.kind === 'volatile') return ['focusenergy','micleberry'].includes(effect.id);
  if (effect.kind === 'random-stat-stages') return effect.amount === 2;
  if (effect.kind === 'reset-negative-stages') return true;
  if (effect.kind === 'clear-volatiles') return Array.isArray(effect.ids) && effect.ids.every(id => ITEM_VOLATILE_FIELDS[id]);
  if (effect.kind === 'heal') return Number.isInteger(effect.amount) && effect.amount > 0
    || effect.amount === undefined && Number.isInteger(effect.numerator) && effect.numerator > 0 && Number.isInteger(effect.denominator) && effect.denominator > 0;
  if (effect.kind === 'restore-pp') return Number.isInteger(effect.amount) && effect.amount > 0 && effect.selection === 'first-depleted-move';
  if (effect.kind === 'cure-status') return Array.isArray(effect.statusIds) && effect.statusIds.length > 0
    && effect.statusIds.every(id => ['brn', 'par', 'psn', 'tox', 'slp', 'frz', 'confusion'].includes(id));
  return effect.stages && Object.keys(effect.stages).length > 0 && Object.entries(effect.stages).every(([stat, value]) =>
    ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'].includes(stat) && Number.isInteger(value) && value > 0 && value <= 6);
}

// This is an interpreter for Dataset rules, not an item-name registry. Unknown
// executable conditions/effects must never silently turn into an unconditional
// consumption. The resolver partitions HP probability mass at hpThreshold.
export function heldStateItemActivation({ dataset, state, activeItemId, generation, timing = 'state-update', opposingStates = [], moves = [] }) {
  if (!state || state.itemState !== 'held' || Number(state.hp?.max) <= 0 || !activeItemId) return null;
  const itemId = toId(state.currentItemId);
  if (itemId !== toId(activeItemId)) return null;
  const item = dataset?.get('items', itemId);
  const mechanics = item?.heldItemMechanics;
  if (mechanics?.schemaVersion !== 'held-item-mechanics/v1' || mechanics.activationStatus !== 'modeled') return null;
  const rules = (mechanics.activations || []).filter(rule => rule.trigger === 'holder-state' && rule.timing === timing);
  for (const rule of rules) {
    if (rule.consumeOnActivation !== true || !rule.effects?.length
      || !Array.isArray(rule.conditions?.battleGenerations) || !rule.conditions.battleGenerations.length
      || rule.conditions.battleGenerations.some(value => !Number.isInteger(value) || value < 1 || value > 9)
      || Object.keys(rule.conditions).some(key => !STATE_CONDITIONS.has(key))
      || rule.effects.some(effect => !validEffect(effect))) throw new Error(`${item.name}: unsupported held-item activation contract`);
    if (!rule.conditions.battleGenerations.includes(generation)) continue;
    const conditions = rule.conditions;
    if (conditions.requiresNegativeStages && !Object.values(state.statStages || {}).some(stage => stage < 0)) continue;
    if (conditions.anyVolatileIds && !conditions.anyVolatileIds.some(id => ITEM_VOLATILE_FIELDS[id]?.some(field => state.volatileConditions?.[field]))) continue;
    if (opposingStates.some(mon => Number(mon?.hp?.max) > 0 && conditions.blockedByOpponentAbilityIds?.includes(activeAbilityId(mon)))) continue;
    if (generation >= 5 && conditions.requiresHealingAllowed && Number(state.volatileConditions?.healBlockTurns || 0) > 0) continue;
    const confused = Number(state.volatileConditions?.confusionTurns || 0) > 0
      || state.volatileConditions?.confusionCounterDistribution?.some(entry => entry.value > 0);
    if (conditions.anyStatusIds && !conditions.anyStatusIds.some(id => id === 'confusion' ? confused : state.majorStatus === id)) continue;
    const depletedMove = moves.find(move => Number(state.movePp?.[move.moveId]) === 0 && Number(move.maxPp) > 0);
    if (conditions.requiresDepletedMovePp && !depletedMove) continue;
    const threshold = activeAbilityId(state) === 'gluttony' && conditions.gluttonyHpThreshold
      ? conditions.gluttonyHpThreshold : conditions.hpThreshold;
    const hpThreshold = threshold ? Number(state.hp.maxHp) * threshold.numerator / threshold.denominator : null;
    if (threshold && (!Number.isFinite(hpThreshold) || threshold.denominator <= 0)) throw new Error(`${item.name}: invalid HP threshold`);
    if (hpThreshold !== null && Number(state.hp.min) > hpThreshold) continue;
    return { itemId, itemName: item.name || itemId, activationId: rule.id, consumptionMethod: mechanics.consumptionMethod,
      effects: rule.effects, hpThreshold, depletedMove };
  }
  return null;
}

function appliedIds(value) {
  return new Set((Array.isArray(value) ? value : [value]).map(toId).filter(Boolean));
}

// Only recognized declarative battle-event effects may execute. The item
// identities and generation-specific values remain in Dataset authority.
export function heldBattleItemRules({dataset,state,activeItemId,generation,trigger}) {
  if (!activeItemId || state?.itemState !== 'held') return [];
  const item=dataset?.get('items',activeItemId), mechanics=item?.heldItemMechanics;
  if(mechanics?.schemaVersion!=='held-item-mechanics/v1'||mechanics.activationStatus!=='modeled')return [];
  const conditions=new Set(['battleGenerations','requiresContact','allowsFaintedHolder','moveTypeId','moveCategory','moveIds','moveIdsWithSheerForce','requiresSuperEffective','requiresHealingAllowed','blockedByOpponentAbilityIds','requiresAttackerIndirectDamage','blockedBySheerForce']);
  const fields={
    'major-status':['kind','statusId'], 'damage-holder':['kind','numerator','denominator'],
    'damage-attacker':['kind','numerator','denominator'], 'transfer-to-empty-attacker':['kind'],
    'stat-stages':['kind','stages'], heal:['kind','numerator','denominator'], 'remove-held-item':['kind'],
    'flinch-target':['kind','chance','sereneGraceMultiplier'], 'modify-trap':['kind','durationTurns','damageDivisor'], 'reflect-attraction':['kind'],
    'switch-after-hit':['kind','recipient','selection'], 'restrict-transfer':['kind','always','allowedMoveIds','blockedSpeciesNums']
  };
  return (mechanics.activations||[]).filter(rule=>rule.trigger===trigger).filter(rule=>{
    if(typeof rule.consumeOnActivation !== 'boolean'
      || rule.consumeOnActivation !== (mechanics.lifecycle === 'consumable')
      || !['persistent','consumable'].includes(mechanics.lifecycle)
      || mechanics.lifecycle === 'persistent' && mechanics.consumptionMethod !== 'none'
      || !Array.isArray(rule.conditions?.battleGenerations)
      || !rule.conditions.battleGenerations.length
      || !rule.conditions.battleGenerations.every(value => Number.isInteger(value) && value >= 3 && value <= 5)
      || Object.keys(rule.conditions).some(key=>!conditions.has(key))
      || Object.entries(rule.conditions).some(([key,value]) => /^(requires|allows|blockedBySheerForce)/.test(key) && typeof value !== 'boolean')
      || rule.conditions.moveCategory !== undefined && !['physical','special'].includes(rule.conditions.moveCategory)
      || rule.conditions.blockedByOpponentAbilityIds !== undefined && (!Array.isArray(rule.conditions.blockedByOpponentAbilityIds) || !rule.conditions.blockedByOpponentAbilityIds.every(id => typeof id === 'string'))
      || ['moveIds','moveIdsWithSheerForce'].some(key => rule.conditions[key] !== undefined && (!Array.isArray(rule.conditions[key]) || !rule.conditions[key].every(id => typeof id === 'string')))
      ||!rule.effects?.length||rule.effects.some(effect=>!fields[effect.kind]||Object.keys(effect).some(key=>!fields[effect.kind].includes(key))
        ||['heal','damage-holder','damage-attacker'].includes(effect.kind)&&(!Number.isInteger(effect.numerator)||effect.numerator<1||!Number.isInteger(effect.denominator)||effect.denominator<1)
        ||effect.kind==='major-status'&&!['brn','tox'].includes(effect.statusId)
        ||effect.kind==='flinch-target'&&(!(effect.chance > 0 && effect.chance <= 1)||effect.sereneGraceMultiplier !== 2)
        ||effect.kind==='switch-after-hit'&&(!['attacker','holder'].includes(effect.recipient)||!['random','choice'].includes(effect.selection))
        ||effect.kind==='restrict-transfer'&&(!(effect.always === true || Array.isArray(effect.allowedMoveIds) || Array.isArray(effect.blockedSpeciesNums))
          ||effect.blockedSpeciesNums?.some(num=>!Number.isInteger(num)||num<1))
        ||effect.kind==='modify-trap'&&(!['durationTurns','damageDivisor'].some(key => effect[key] !== undefined)
          || ['durationTurns','damageDivisor'].some(key => effect[key] !== undefined && (!Number.isInteger(effect[key]) || effect[key] < 1 || effect[key] > 16)))
        ||effect.kind==='stat-stages'&&!validEffect(effect)))throw Error(`${item.name}: unsupported battle item contract`);
    return rule.conditions.battleGenerations.includes(generation);
  }).map(rule=>({...rule,itemId:activeItemId,itemName:item.name,consumptionMethod:mechanics.consumptionMethod}));
}

// Repeatable effects are distinct from consumption. Unknown contracts fail
// closed rather than being treated as an unconditional heal.
export function afterMoveDamageItemRule({ dataset, state, activeItemId, generation }) {
  if (!activeItemId || state?.itemState !== 'held') return null;
  const item = dataset.get('items', activeItemId);
  const mechanics = item?.heldItemMechanics;
  if (mechanics?.schemaVersion !== 'held-item-mechanics/v1' || mechanics.activationStatus !== 'modeled'
    || mechanics.lifecycle !== 'persistent') return null;
  for (const rule of mechanics.activations || []) {
    if (rule.trigger !== 'holder-dealt-move-damage') continue;
    const effect = rule.effects?.[0];
    if (rule.consumeOnActivation !== false || mechanics.consumptionMethod !== 'none'
      || rule.timing !== 'after-move-secondary-self' || rule.effects?.length !== 1
      || !Array.isArray(rule.conditions?.battleGenerations)
      || !rule.conditions.battleGenerations.length
      || !rule.conditions.battleGenerations.every(value => Number.isInteger(value) && value >= 3 && value <= 5)
      || typeof rule.conditions.requiresHealingAllowed !== 'boolean'
      || typeof rule.conditions.blockedBySheerForce !== 'boolean'
      || Object.keys(rule.conditions).some(key => !['battleGenerations', 'requiresHealingAllowed', 'blockedBySheerForce'].includes(key))
      || effect?.kind !== 'heal-from-move-damage' || effect.rounding !== 'floor'
      || !['last-target', 'all-targets'].includes(effect.aggregation) || effect.includesSubstituteDamage !== false
      || !Number.isInteger(effect.numerator) || effect.numerator <= 0
      || !Number.isInteger(effect.denominator) || effect.denominator <= 0
      || !Number.isInteger(effect.minimum) || effect.minimum < 1
      || Object.keys(effect).some(key => !['kind', 'numerator', 'denominator', 'minimum', 'rounding', 'aggregation', 'includesSubstituteDamage'].includes(key))) {
      throw new Error(`${item.name}: unsupported persistent item activation contract`);
    }
    if (rule.conditions.battleGenerations.includes(generation)) return {
      itemId: activeItemId, itemName: item.name, activationId: rule.id, conditions: rule.conditions, effect
    };
  }
  return null;
}

export function damageReductionItemActivation({ dataset, defenderState, appliedDefenderItemIds }) {
  if (!dataset || defenderState?.itemState !== "held") return null;
  const itemId = toId(defenderState.currentItemId);
  if (!itemId || !appliedIds(appliedDefenderItemIds).has(itemId)) return null;
  const item = dataset.get("items", itemId);
  const mechanics = item?.heldItemMechanics;
  if (mechanics?.schemaVersion !== "held-item-mechanics/v1"
    || mechanics.lifecycle !== "consumable"
    || mechanics.activationStatus !== "modeled") return null;
  const activation = mechanics.activations?.find(entry => entry.trigger === "incoming-damaging-move"
    && entry.consumeOnActivation === true
    && entry.effects?.some(effect => effect.kind === "damage-multiplier"));
  if (!activation) return null;
  return {
    itemId,
    itemName: item.name || item.calcName || itemId,
    activationId: activation.id,
    consumptionMethod: mechanics.consumptionMethod,
  };
}

export function afterDamagingMoveItemActivation({ dataset, defenderState, activeItemId, damage, throughSubstitute = false }) {
  if (!dataset || defenderState?.itemState !== "held" || Number(damage) <= 0) return null;
  const itemId = toId(defenderState.currentItemId);
  if (!itemId || itemId !== toId(activeItemId)) return null;
  const item = dataset.get("items", itemId);
  const mechanics = item?.heldItemMechanics;
  if (mechanics?.schemaVersion !== "held-item-mechanics/v1"
    || !["consumable", "breakable"].includes(mechanics.lifecycle)
    || mechanics.activationStatus !== "modeled") return null;
  const activation = mechanics.activations?.find(entry => entry.trigger === "after-damaging-move"
    && entry.consumeOnActivation === true
    && entry.effects?.some(effect => effect.kind === "remove-held-item")
    && (!throughSubstitute || entry.conditions?.blockedBySubstitute !== true));
  if (!activation) return null;
  return {
    itemId,
    itemName: item.name || item.calcName || itemId,
    activationId: activation.id,
    consumptionMethod: mechanics.consumptionMethod,
  };
}
