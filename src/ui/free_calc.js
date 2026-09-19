import { experienceForLevel, GROWTH_RATES } from '../rulesets/vw2r_experience.js';

// The UI edits progress within a level; the plan continues storing lifetime EXP.
export function freeCalcExperience(mon, current) {
  const level = Number(current.currentLevel ?? mon.level);
  if (!GROWTH_RATES.includes(mon.growthRate)) return null;
  const floor = experienceForLevel(level, mon.growthRate);
  const threshold = level < 100 ? experienceForLevel(level + 1, mon.growthRate) - floor : 0;
  return { floor, threshold, value: Number.isInteger(current.experience) ? Math.max(0, current.experience - floor) : '' };
}

export function freeCalcTotalExperience(mon, current, value) {
  const progress = freeCalcExperience(mon, current);
  if (!progress) throw new Error('EXP editing requires a known growth rate');
  const amount = Number(value);
  if (String(value).trim() === '' || !Number.isInteger(amount) || amount < 0 || amount > progress.threshold) {
    throw new Error(`Level EXP must be an integer from 0 to ${progress.threshold}`);
  }
  return progress.floor + amount;
}
