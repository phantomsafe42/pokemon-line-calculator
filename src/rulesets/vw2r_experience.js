import { calculateStats } from "../adapters/combatant_ingest.js?v=20260905-drafts-freecalc-partners-v1";
import { clone } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { activeKeys } from "../core/battle_slots.js?v=20260905-drafts-freecalc-partners-v1";

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

export function unboundExperienceAmount({
  trainerFactor = 10,
  tradeFactor = 10,
  baseExp,
  luckyEggFactor = 10,
  defeatedLevel,
  recipientLevel,
  passPowerFactor = 1,
  affectionFactor = 10,
  evolutionFactor = 10,
  distributionDivisor = 1,
  raid = false,
  hardCap = false,
} = {}) {
  if (hardCap) return 1;
  const a = Number(trainerFactor);
  const t = Number(tradeFactor);
  const b = Number(baseExp);
  const e = Number(luckyEggFactor);
  const defeated = Number(defeatedLevel);
  const recipient = Number(recipientLevel);
  const p = Number(passPowerFactor);
  const f = Number(affectionFactor);
  const v = Number(evolutionFactor);
  const s = Number(distributionDivisor);
  if (![a, t, b, e, defeated, recipient, p, f, v, s].every(Number.isFinite) || s <= 0) {
    throw new Error("Unbound EXP calculation requires complete finite inputs");
  }
  const upper = 2 * defeated + 10;
  const lower = defeated + recipient + 10;
  let amount = Math.floor(a * b * defeated / (10 * 5 * s));
  amount = Math.floor(amount * upper ** 2 / (lower ** 2 * Math.floor(Math.sqrt(lower))));
  amount = amount * Math.floor(Math.sqrt(upper)) + 1;
  amount = Math.floor(amount * t * e * v / 1000);
  amount = Math.floor(amount * p * f / 10);
  if (raid) amount *= 2;
  return Math.max(1, Math.min(1_640_000, amount));
}

function readyExperienceMechanics(dataset) {
  const profile = dataset?.experienceMechanics;
  return profile?.validation?.status === "passed"
    && Number(profile?.validation?.unresolved) === 0
    && profile?.consumerActivation?.experienceProjectionReady === true
    ? profile
    : null;
}

function hasAvailableLevelEvolution(plan, combatantKey, dataset, level) {
  const speciesId = plan.combatants?.[combatantKey]?.speciesId;
  if (!speciesId) return false;
  return [...(dataset?.indexes?.evolutions?.values?.() || [])].some(entry =>
    entry?.fromSpeciesId === speciesId
    && String(entry?.method || "").toLowerCase() === "level"
    && Number.isFinite(Number(entry?.parameter))
    && Number(entry.parameter) <= Number(level)
  );
}

function unboundRewards(plan, state, enemyKey, dataset, participants, playerKeys, enemy, enemyState) {
  const profile = dataset.experienceMechanics;
  if (profile?.trainerBattleFormula?.model !== "unbound-2.1.1.1-cfru-scaled-gen5-gen7") {
    return { available: false, reason: "experience-profile-unavailable", rewards: [] };
  }
  const enemyLevel = Number(enemyState.currentLevel ?? enemy.level);
  const rewards = [];
  for (const combatantKey of playerKeys.filter(key => live(state, key))) {
    const mon = plan.combatants[combatantKey];
    const monState = state.combatantStates[combatantKey];
    const recipientLevel = Number(monState.currentLevel ?? mon.level);
    if (recipientLevel >= 100) continue;
    const participant = participants.has(combatantKey);
    const luckyEgg = monState.currentItemId === LUCKY_EGG_ITEM_ID;
    const evolutionReady = hasAvailableLevelEvolution(plan, combatantKey, dataset, recipientLevel);
    const amount = unboundExperienceAmount({
      trainerFactor: Number(profile.knownFeatures?.trainerFactor?.trainerBeforeGameClear ?? 10),
      tradeFactor: 10,
      baseExp: enemy.baseExperienceYield,
      luckyEggFactor: luckyEgg ? Number(profile.knownFeatures?.luckyEgg?.level1 ?? 15) : Number(profile.knownFeatures?.luckyEgg?.withoutItem ?? 10),
      defeatedLevel: enemyLevel,
      recipientLevel,
      passPowerFactor: 1,
      affectionFactor: 10,
      evolutionFactor: evolutionReady ? 12 : 10,
      distributionDivisor: participant
        ? Number(profile.distribution?.participantDivisor ?? 1)
        : Number(profile.distribution?.nonParticipantExpShareDivisor ?? 2),
      raid: false,
      hardCap: false,
    });
    const fromExperience = Number.isInteger(monState.experience) ? monState.experience : null;
    const maximumExperience = experienceForLevel(100, mon.growthRate);
    const toExperience = fromExperience === null ? null : Math.min(maximumExperience, fromExperience + amount);
    const toLevel = toExperience === null ? recipientLevel : levelFromExperience(toExperience, mon.growthRate);
    rewards.push({
      combatantKey,
      enemyKey,
      amount,
      participant,
      expShare: !participant,
      luckyEgg,
      evolutionReady,
      fromExperience,
      toExperience,
      fromLevel: recipientLevel,
      toLevel,
      toNextLevel: toExperience === null ? null : experienceToNextLevel(toExperience, mon.growthRate, toLevel)
    });
  }
  return { available: true, enemyKey, generation: "custom", mechanicsProfile: profile.mechanicsProfile, rewards };
}

function rewardContext(plan, state, enemyKey, dataset) {
  const profile = readyExperienceMechanics(dataset);
  if (!profile) return { available: false, reason: "experience-profile-unavailable", rewards: [] };
  const generation = profile.experienceGeneration === "custom" ? "custom" : Number(profile.experienceGeneration);
  if (!(generation === "custom" || [3, 4, 5].includes(generation))) return { available: false, reason: "experience-generation-unavailable", rewards: [] };
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
  if (generation === "custom") return unboundRewards(plan, state, enemyKey, dataset, participants, playerKeys, enemy, enemyState);
  const shareHolders = new Set(playerKeys.filter(key => live(state, key) && state.combatantStates[key]?.currentItemId === EXP_SHARE_ITEM_ID));
  if (!participants.size && !shareHolders.size) return { available: true, enemyKey, basePool: 0, rewards: [] };

  const enemyLevel = Number(enemyState.currentLevel ?? enemy.level);
  let basePool = Math.floor(Number(enemy.baseExperienceYield) * enemyLevel / (generation === 5 ? 5 : 7));
  if (generation === 5) basePool = Math.floor(basePool * 3 / 2);
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
    if (generation <= 4) amount = Math.floor(amount * 3 / 2);
    else amount = scaledExperience(amount, enemyLevel, recipientLevel);
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
  return { available: true, enemyKey, basePool, generation, rewards };
}

export function projectExperience(plan, state, enemyKey, dataset) {
  return rewardContext(plan, state, enemyKey, dataset);
}

export function projectVw2rExperience(plan, state, enemyKey) {
  return projectExperience(plan, state, enemyKey, {
    experienceMechanics: {
      experienceGeneration: 5,
      validation: { status: "passed", unresolved: 0 },
      consumerActivation: { experienceProjectionReady: true }
    }
  });
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
  if (!readyExperienceMechanics(dataset) || !branch?.state?.experienceState) return branch;
  const tracking = experienceState(branch.state);
  const rewarded = new Set(tracking.rewardedEnemyKeys);
  for (const enemy of Object.values(plan.combatants).filter(mon => mon.side === "enemy")) {
    if (rewarded.has(enemy.combatantKey) || Number(branch.state.combatantStates[enemy.combatantKey]?.hp?.max) > 0) continue;
    const projection = rewardContext(plan, branch.state, enemy.combatantKey, dataset);
    if (!projection.available) continue;
    tracking.rewardedEnemyKeys.push(enemy.combatantKey);
    rewarded.add(enemy.combatantKey);
    for (const reward of projection.rewards) applyReward(branch, plan, dataset, reward);
  }
  return branch;
}
