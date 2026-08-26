import assert from "node:assert/strict";
import test from "node:test";
import {
  collapsedOutcomeEntries,
  formatDamageRollCounts,
  isCriticalOhkoOutcome,
  isHighRollKoOutcome,
  outcomePanelEvents,
  sortOutcomeEntries
} from "../src/core/outcome_presentation.js";

test("damage roll display collapses duplicates into superscript occurrence counts", () => {
  assert.equal(formatDamageRollCounts([18, 18, 19, 19, 19, 21, 22, 22]), "18², 19³, 21¹, 22²");
  assert.equal(formatDamageRollCounts([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]), "100¹⁰");
});

test("Possible Outcomes omits EXP events while leaving them in resolver state", () => {
  const events = [
    { eventType: "damage", moveId: "tackle" },
    { eventType: "experience-gain", targetKey: "player", metadata: { amount: 250 } },
    { eventType: "level-up", targetKey: "player", metadata: { toLevel: 26 } }
  ];
  assert.deepEqual(outcomePanelEvents(events), [events[0], events[2]]);
  assert.equal(events.length, 3);
});

function damage(thresholdOutcome, overrides = {}) {
  return {
    eventType: "damage",
    actorKey: "player",
    targetKey: "enemy",
    moveId: "tackle",
    damageHp: { min: 90, max: 100 },
    metadata: { thresholdOutcome, targetHpBefore: { min: 100, max: 100, maxHp: 100 }, ...overrides }
  };
}

function outcome(id, probability, events = []) {
  return { previewOutcomeId: id, outcome: { probability, probabilityStatus: "known", label: id }, events };
}

test("collapsed outcomes sort most probable first and retain notable low-probability KOs", () => {
  const ordinary = outcome("ordinary", 0.7, [damage("survive")]);
  const miss = outcome("miss", 0.1, [{ eventType: "miss", moveId: "tackle" }]);
  const highRoll = outcome("high-roll", 0.15, [damage("ko")]);
  const critical = outcome("critical", 0.05, [damage("ko", { criticalHit: true })]);
  const entries = [miss, critical, ordinary, highRoll];

  assert.equal(isHighRollKoOutcome(highRoll, entries), true);
  assert.equal(isCriticalOhkoOutcome(critical), true);
  assert.deepEqual(sortOutcomeEntries(entries, "ordinary").map(entry => entry.previewOutcomeId), ["ordinary", "high-roll", "miss", "critical"]);
  const presentation = collapsedOutcomeEntries(entries, "ordinary");
  assert.deepEqual(presentation.visible.map(entry => entry.previewOutcomeId), ["ordinary", "high-roll", "critical"]);
  assert.equal(presentation.hiddenCount, 1);
});

test("20-percent, unknown, and default outcomes stay visible while ordinary lower chances collapse", () => {
  const entries = [
    outcome("low-default", 0.05),
    outcome("threshold", 0.2),
    outcome("low", 0.19),
    { previewOutcomeId: "unknown", outcome: { probability: null, probabilityStatus: "unknown", label: "unknown" }, events: [] }
  ];
  const presentation = collapsedOutcomeEntries(entries, "low-default");
  assert.deepEqual(presentation.visible.map(entry => entry.previewOutcomeId), ["threshold", "low-default", "unknown"]);
  assert.equal(presentation.hiddenCount, 1);
});

test("the selected default wins a probability tie without changing resolver data", () => {
  const first = outcome("first", 0.5);
  const selected = outcome("selected", 0.5);
  assert.deepEqual(sortOutcomeEntries([first, selected], "selected").map(entry => entry.previewOutcomeId), ["selected", "first"]);
  assert.equal(first.outcome.probability, 0.5);
});
