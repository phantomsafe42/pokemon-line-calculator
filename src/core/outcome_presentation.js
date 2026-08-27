export const COLLAPSED_OUTCOME_PROBABILITY = 0.2;

const SUPERSCRIPT_DIGITS = Object.freeze({
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹"
});

export function formatDamageRollCounts(values) {
  const counts = new Map();
  for (const rawValue of values || []) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => {
    const exponent = String(count).split("").map(digit => SUPERSCRIPT_DIGITS[digit]).join("");
    return `${value}${exponent}`;
  }).join(", ");
}

export function readableMechanicName(value) {
  const compact = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const known = {
    baddreams: "Bad Dreams", cursedbody: "Cursed Body", dryskin: "Dry Skin", effectspore: "Effect Spore",
    flamebody: "Flame Body", flashfire: "Flash Fire", icebody: "Ice Body", ironbarbs: "Iron Barbs",
    lightningrod: "Lightning Rod", motordrive: "Motor Drive", poisonpoint: "Poison Point", raindish: "Rain Dish",
    roughskin: "Rough Skin", sapsipper: "Sap Sipper", shedskin: "Shed Skin", solarpower: "Solar Power",
    speedboost: "Speed Boost", stormdrain: "Storm Drain", waterabsorb: "Water Absorb", weakarmor: "Weak Armor"
  }[compact];
  if (known) return known;
  return String(value || "Recovery")
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function numericRange(value) {
  const min = Number(value?.min);
  const max = Number(value?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

function healingPercentRange(event, maxHp) {
  const declared = numericRange(event?.healingPercent);
  if (declared) return declared;
  const healing = numericRange(event?.healingHp);
  const maximum = Number(maxHp);
  if (!healing || !Number.isFinite(maximum) || maximum <= 0) return null;
  return { min: healing.min / maximum * 100, max: healing.max / maximum * 100 };
}

function rangeLabel(range, formatter, separator = "–") {
  if (!range) return null;
  const min = formatter(range.min);
  const max = formatter(range.max);
  return range.min === range.max ? min : `${min}${separator}${max}`;
}

export function healingEventDescription(event, { moveName = null, maxHp = null } = {}) {
  if (!["heal", "residual-heal", "switch-heal"].includes(event?.eventType)) return null;
  const healing = numericRange(event.healingHp);
  if (!healing) return null;
  const source = moveName || readableMechanicName(event.metadata?.cause);
  const verb = event.metadata?.cause === "drain" ? "Drained" : "Healed";
  const hp = rangeLabel(healing, value => String(Math.round(value)));
  const percent = rangeLabel(healingPercentRange(event, maxHp), value => `${value.toFixed(1)}%`, " - ");
  return `${source} · ${verb} ${hp} HP${percent ? ` (${percent})` : ""}`;
}

export function outcomePanelEvents(events) {
  return (events || []).filter(event => {
    if (event?.metadata?.hiddenFromOutcomes === true) return false;
    if (["experience-gain", "replacement-required"].includes(event?.eventType)) return false;
    if (event?.eventType !== "action-skipped") return true;
    return !["actor-fainted-before-moving", "target-fainted-before-action"].includes(event.reason);
  });
}

function outcomeFor(entry) {
  return entry?.outcome || entry || {};
}

export function outcomeEntryId(entry) {
  return entry?.previewOutcomeId || entry?.state?.stateNodeId || entry?.stateNodeId || null;
}

export function outcomeProbability(entry) {
  const raw = outcomeFor(entry).probability;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function damageBranchKey(event) {
  return [event?.actorKey, event?.targetKey, event?.moveId].map(value => String(value || "")).join("|");
}

function isCriticalDamage(event) {
  return event?.criticalHit === true
    || event?.metadata?.criticalHit === true
    || event?.metadata?.isCritical === true
    || event?.metadata?.crit === true;
}

function isFullHpKo(event) {
  if (event?.eventType !== "damage" || event?.metadata?.thresholdOutcome !== "ko") return false;
  const before = event.metadata?.targetHpBefore || {};
  const current = Number(before.min ?? before.max);
  const max = Number(before.maxHp);
  return Number.isFinite(current) && Number.isFinite(max) && current === max;
}

export function isCriticalOhkoOutcome(entry) {
  return (entry?.events || []).some(event => isCriticalDamage(event) && isFullHpKo(event));
}

export function isHighRollKoOutcome(entry, allEntries) {
  const koKeys = new Set((entry?.events || [])
    .filter(event => event.eventType === "damage" && event.metadata?.thresholdOutcome === "ko")
    .map(damageBranchKey));
  if (!koKeys.size) return false;
  return (allEntries || []).some(candidate => candidate !== entry && (candidate?.events || []).some(event =>
    event.eventType === "damage"
      && event.metadata?.thresholdOutcome === "survive"
      && koKeys.has(damageBranchKey(event))
  ));
}

export function sortOutcomeEntries(entries, defaultOutcomeId = null) {
  return (entries || []).map((entry, index) => ({ entry, index })).sort((left, right) => {
    const leftProbability = outcomeProbability(left.entry);
    const rightProbability = outcomeProbability(right.entry);
    if (leftProbability !== null || rightProbability !== null) {
      if (leftProbability === null) return 1;
      if (rightProbability === null) return -1;
      if (rightProbability !== leftProbability) return rightProbability - leftProbability;
    }
    const leftDefault = outcomeEntryId(left.entry) === defaultOutcomeId;
    const rightDefault = outcomeEntryId(right.entry) === defaultOutcomeId;
    if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
    return left.index - right.index;
  }).map(({ entry }) => entry);
}

export function collapsedOutcomeEntries(entries, defaultOutcomeId = null, threshold = COLLAPSED_OUTCOME_PROBABILITY) {
  const sorted = sortOutcomeEntries(entries, defaultOutcomeId);
  const visible = sorted.filter(entry => {
    if (outcomeEntryId(entry) === defaultOutcomeId) return true;
    const probability = outcomeProbability(entry);
    if (probability === null || probability >= threshold) return true;
    return isCriticalOhkoOutcome(entry) || isHighRollKoOutcome(entry, sorted);
  });
  return { sorted, visible, hiddenCount: sorted.length - visible.length };
}
