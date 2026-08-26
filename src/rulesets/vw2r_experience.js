import { calculateStats } from "../adapters/combatant_ingest.js";
import { clone } from "../core/primitives.js";
import { activeKeys } from "../core/battle_slots.js";

const VW2R_GAME_ID = "volt-white-2r";
const EXP_SHARE_ITEM_ID = "expshare";
const LUCKY_EGG_ITEM_ID = "luckyegg";

export const GROWTH_RATES = Object.freeze(["Medium Fast", "Erratic", "Fluctuating", "Medium Slow", "Fast", "Slow"]);

export function experienceForLevel(levelValue, growthRate) {
  const level = Math.max(1, Math.min(100, Math.floor(Number(levelValue) || 1)));
  if (level === 1) return 0;
  if (growthRate === "Fast") return Math.floor(4 * level ** 3 / 5);
  if (growthRate === "Medium Slow") return Math.floor(6 * level ** 3 / 5 - 15 * level ** 2 + 100 * level - 140);
  if (growthRate === "Slow") return Math.floor(5 * level ** 3 / 4);
  if (growthRate === "Erratic") {
    if (level <= 50) return Math.floor(level ** 3 * (100 - level) / 50);
    if (level <= 68) return Math.floor(level ** 3 * (150 - level) / 100);
    if (level <= 98) return Math.floor(level ** 3 * Math.floor((1911 - 10 * level) / 3) / 500);
    return Math.floor(level ** 3 * (160 - level) / 100);
  }
  if (growthRate === "Fluctuating") {
    if (level <= 15) return Math.floor(level ** 3 * (Math.floor((level + 1) / 3) + 24) / 50);
    if (level <= 36) return Math.floor(level ** 3 * (level + 14) / 50);
    return Math.floor(level ** 3 * (Math.floor(level / 2) + 32) / 50);
  }
  return level ** 3;
}

export function levelFromExperience(experienceValue, growthRate) {
  const experience = Math.max(0, Math.floor(Number(experienceValue) || 0));
  let level = 1;
  for (let candidate = 2; candidate <= 100; candidate += 1) {
    if (experienceForLevel(candidate, growthRate) <= experience) level = candidate;
    else break;
  }
  return level;
}

export function experienceToNextLevel(experienceValue, growthRate, levelValue = null) {
  const experience = Math.max(0, Math.floor(Number(experienceValue) || 0));
  const level = levelValue === null ? levelFromExperience(experience, growthRate) : Math.max(1, Math.min(100, Math.floor(Number(levelValue) || 1)));
  if (level >= 100) return 0;
  return Math.max(0, experienceForLevel(level + 1, growthRate) - experience);
}

function live(state, key) {
  return Number(state.combatantStates?.[key]?.hp?.max) > 0;
}

function experienceState(state) {
  state.experienceState ||= { participantsByEnemyKey: {}, rewardedEnemyKeys: [] };
  state.experienceState.participantsByEnemyKey ||= {};
  state.experienceState.rewardedEnemyKeys ||= [];
  return state.experienceState;
}

function appendParticipant(state, enemyKey, playerKey) {
  const tracking = experienceState(state);
  const participants = tracking.participantsByEnemyKey[enemyKey] ||= [];
  if (!participants.includes(playerKey)) participants.push(playerKey);
}

export function createInitialExperienceState(combatants, playerActiveKeys, enemyActiveKeys) {
  if (!Object.values(combatants || {}).some(mon => mon.side === "enemy" && Number.isInteger(mon.baseExperienceYield))) return null;
  return {
    participantsByEnemyKey: Object.fromEntries(enemyActiveKeys.map(enemyKey => [enemyKey, [...playerActiveKeys]])),
    rewardedEnemyKeys: []
  };
}

export function registerSwitchExperienceParticipation(state, side, enteringKey) {
  if (!state?.experienceState) return;
  if (side === "player") {
    for (const enemyKey of activeKeys(state, "enemy")) {
      if (live(state, enemyKey)) appendParticipant(state, enemyKey, enteringKey);
    }
    return;
  }
  if (side === "enemy") {
    for (const playerKey of activeKeys(state, "player")) {
      if (live(state, playerKey)) appendParticipant(state, enteringKey, playerKey);
    }
  }
}

function scaledFactor(index) {
  return Math.floor(index ** 2.5 / 4);
}

function scaledExperience(amount, faintedLevel, recipientLevel) {
  const numerator = scaledFactor(2 * faintedLevel + 10);
  const denominator = scaledFactor(faintedLevel + recipientLevel + 10);
  return Math.floor(amount * numerator / denominator) + 1;
}

function rewardContext(plan, state, enemyKey) {
  if (plan?.game?.gameId !== VW2R_GAME_ID) return { available: false, reason: "not-vw2r", rewards: [] };
  const enemy = plan.combatants?.[enemyKey];
  const enemyState = state?.combatantStates?.[enemyKey];
  if (!enemy || enemy.side !== "enemy" || !enemyState) return { available: false, reason: "enemy-unavailable", rewards: [] };
  if (!Number.isInteger(enemy.baseExperienceYield) || enemy.baseExperienceYield < 1) {
    return { available: false, reason: "base-experience-yield-unavailable", rewards: [] };
  }
  const tracking = state.experienceState;
  if (!tracking || (tracking.rewardedEnemyKeys || []).includes(enemyKey)) return { available: false, reason: "already-rewarded", rewards: [] };
  const playerKeys = Object.values(plan.combatants).filter(mon => mon.side === "player").map(mon => mon.combatantKey);
  const participants = new Set((tracking.participantsByEnemyKey?.[enemyKey] || []).filter(key => playerKeys.includes(key) && live(state, key)));
  const shareHolders = new Set(playerKeys.filter(key => live(state, key) && state.combatantStates[key]?.currentItemId === EXP_SHARE_ITEM_ID));
  if (!participants.size && !shareHolders.size) return { available: true, enemyKey, basePool: 0, rewards: [] };

  const enemyLevel = Number(enemyState.currentLevel ?? enemy.level);
  let basePool = Math.floor(Number(enemy.baseExperienceYield) * enemyLevel / 5);
  basePool = Math.floor(basePool * 3 / 2);
  const participantShare = shareHolders.size
    ? Math.max(1, Math.floor(Math.floor(basePool / 2) / Math.max(1, participants.size)))
    : Math.max(1, Math.floor(basePool / Math.max(1, participants.size)));
  const holderShare = shareHolders.size ? Math.max(1, Math.floor(Math.floor(basePool / 2) / shareHolders.size)) : 0;
  const recipientKeys = [...new Set([...participants, ...shareHolders])];
  const rewards = [];
  for (const combatantKey of recipientKeys) {
    const mon = plan.combatants[combatantKey];
    const monState = state.combatantStates[combatantKey];
    const recipientLevel = Number(monState.currentLevel ?? mon.level);
    if (recipientLevel >= 100) continue;
    const participant = participants.has(combatantKey);
    const expShare = shareHolders.has(combatantKey);
    let amount = (participant ? participantShare : 0) + (expShare ? holderShare : 0);
    const luckyEgg = monState.currentItemId === LUCKY_EGG_ITEM_ID;
    if (luckyEgg) amount = Math.floor(amount * 3 / 2);
    amount = scaledExperience(amount, enemyLevel, recipientLevel);
    const fromExperience = Number.isInteger(monState.experience) ? monState.experience : null;
    const maximumExperience = experienceForLevel(100, mon.growthRate);
    const toExperience = fromExperience === null ? null : Math.min(maximumExperience, fromExperience + amount);
    const toLevel = toExperience === null ? recipientLevel : levelFromExperience(toExperience, mon.growthRate);
    rewards.push({
      combatantKey,
      enemyKey,
      amount,
      participant,
      expShare,
      luckyEgg,
      fromExperience,
      toExperience,
      fromLevel: recipientLevel,
      toLevel,
      toNextLevel: toExperience === null ? null : experienceToNextLevel(toExperience, mon.growthRate, toLevel)
    });
  }
  return { available: true, enemyKey, basePool, rewards };
}

export function projectVw2rExperience(plan, state, enemyKey) {
  return rewardContext(plan, state, enemyKey);
}

function event(branch, details) {
  const next = { ...details, source: "planned", changes: details.changes || [], metadata: details.metadata || {} };
  branch.events.push(next);
  return next;
}

function applyReward(branch, plan, dataset, reward) {
  const mon = plan.combatants[reward.combatantKey];
  const monState = branch.state.combatantStates[reward.combatantKey];
  const changes = [];
  if (reward.fromExperience !== null) {
    monState.experience = reward.toExperience;
    changes.push({ path: `combatantStates.${reward.combatantKey}.experience`, from: reward.fromExperience, to: reward.toExperience });
  }
  if (reward.toLevel > reward.fromLevel) {
    const previousStats = clone(monState.currentStats || mon.calculatedStats);
    const nextStats = calculateStats({ ...mon, level: reward.toLevel }, dataset);
    monState.currentLevel = reward.toLevel;
    monState.currentStats = nextStats;
    changes.push({ path: `combatantStates.${reward.combatantKey}.currentLevel`, from: reward.fromLevel, to: reward.toLevel });
    for (const stat of ["hp", "atk", "def", "spa", "spd", "spe"]) {
      if (previousStats[stat] !== nextStats[stat]) changes.push({ path: `combatantStates.${reward.combatantKey}.currentStats.${stat}`, from: previousStats[stat], to: nextStats[stat] });
    }
    const hpGain = Number(nextStats.hp) - Number(previousStats.hp);
    if (hpGain) {
      const previousHp = clone(monState.hp);
      monState.hp = {
        min: Math.min(nextStats.hp, Number(monState.hp.min) + hpGain),
        max: Math.min(nextStats.hp, Number(monState.hp.max) + hpGain),
        maxHp: nextStats.hp
      };
      monState.hpDistribution = (monState.hpDistribution || []).map(entry => ({ ...entry, value: Math.min(nextStats.hp, Number(entry.value) + hpGain) }));
      changes.push({ path: `combatantStates.${reward.combatantKey}.hp`, from: previousHp, to: clone(monState.hp) });
    }
  }
  event(branch, {
    eventType: "experience-gain",
    actorKey: reward.enemyKey,
    targetKey: reward.combatantKey,
    moveId: null,
    metadata: {
      amount: reward.amount,
      participant: reward.participant,
      expShare: reward.expShare,
      luckyEgg: reward.luckyEgg,
      fromExperience: reward.fromExperience,
      toExperience: reward.toExperience,
      fromLevel: reward.fromLevel,
      toLevel: reward.toLevel,
      toNextLevel: reward.toNextLevel,
      levelUp: reward.toLevel > reward.fromLevel,
      resultLabel: `${mon.nickname || mon.displayName} +${reward.amount} EXP`
    },
    changes
  });
}

export function applyDefeatedEnemyExperience(branch, plan, dataset) {
  if (plan?.game?.gameId !== VW2R_GAME_ID || !branch?.state?.experienceState) return branch;
  const tracking = experienceState(branch.state);
  const rewarded = new Set(tracking.rewardedEnemyKeys);
  for (const enemy of Object.values(plan.combatants).filter(mon => mon.side === "enemy")) {
    if (rewarded.has(enemy.combatantKey) || Number(branch.state.combatantStates[enemy.combatantKey]?.hp?.max) > 0) continue;
    const projection = rewardContext(plan, branch.state, enemy.combatantKey);
    if (!projection.available) continue;
    tracking.rewardedEnemyKeys.push(enemy.combatantKey);
    rewarded.add(enemy.combatantKey);
    for (const reward of projection.rewards) applyReward(branch, plan, dataset, reward);
  }
  return branch;
}
