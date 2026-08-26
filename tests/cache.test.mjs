import assert from "node:assert/strict";
import test from "node:test";
import { createDraftRecord, destructiveTransitionNotice, markExported, MemoryDraftStore, updateDraftRecord } from "../src/cache/active_draft.js";
import { fixturePlan } from "./helpers.mjs";

test("single active draft store restores the working document and cursor", async () => {
  const { plan } = fixturePlan();
  const store = new MemoryDraftStore();
  const record = createDraftRecord(plan);
  await store.save(record);
  const restored = await store.load();
  assert.equal(restored.document.planId, plan.planId);
  assert.equal(restored.workingCursorStateNodeId, "state-root");
  restored.document.name = "mutated copy";
  assert.notEqual((await store.load()).document.name, "mutated copy");
});

test("export freshness and destructive-transition copy distinguish current output", () => {
  const { plan } = fixturePlan();
  plan.actionGroups.placeholder = {};
  plan.documentRevision = 2;
  let record = createDraftRecord(plan);
  assert.match(destructiveTransitionNotice(record, "Changing trainers").message, /No up-to-date output file exists/);
  record = markExported(record);
  assert.match(destructiveTransitionNotice(record, "Changing trainers").message, /latest output file matches/);
  const changed = structuredClone(plan);
  changed.documentRevision = 3;
  record = updateDraftRecord(record, changed, "state-root");
  assert.equal(record.dirty, true);
});
