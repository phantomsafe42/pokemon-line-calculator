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

export function outcomePanelEvents(events) {
  return (events || []).filter(event => event?.eventType !== "experience-gain");
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
