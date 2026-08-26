function experienceForLevel(level, growthRate) {
  const n = level;
  switch (growthRate) {
    case "Fast": return Math.floor((4 * n ** 3) / 5);
    case "Medium Fast": return n ** 3;
    case "Medium Slow": return Math.floor((6 / 5) * n ** 3 - 15 * n ** 2 + 100 * n - 140);
    case "Slow": return Math.floor((5 * n ** 3) / 4);
    case "Erratic":
      if (n <= 50) return Math.floor((n ** 3 * (100 - n)) / 50);
      if (n <= 68) return Math.floor((n ** 3 * (150 - n)) / 100);
      if (n <= 98) return Math.floor((n ** 3 * Math.floor((1911 - 10 * n) / 3)) / 500);
      return Math.floor((n ** 3 * (160 - n)) / 100);
    case "Fluctuating":
      if (n <= 15) return Math.floor((n ** 3 * (Math.floor((n + 1) / 3) + 24)) / 50);
      if (n <= 36) return Math.floor((n ** 3 * (n + 14)) / 50);
      return Math.floor((n ** 3 * (Math.floor(n / 2) + 32)) / 50);
    default: return n ** 3;
  }
}

export function levelFromRunHistoryExperience(experience, growthRate) {
  let level = 1;
  for (let candidate = 1; candidate <= 100; candidate += 1) {
    if (experienceForLevel(candidate, growthRate) <= experience) level = candidate;
    else break;
  }
  return level;
}
