import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadStandardizedDataset } from "../src/adapters/standardized_dataset.js";
import { createSharedDamageAdapter } from "../src/adapters/shared_damage_adapter.js";
import { loadTrainerAiDocumentation, analyzeTrainerAi } from "../src/adapters/trainer_ai.js";

// Explicit, read-only diagnostic input. No live-state writes or private snapshot
// contents are copied into the repository or the public build.
const input = process.argv[2];
if (!input) throw new Error("Usage: node tools/replay_trainer_ai_snapshot.mjs <output-state.json>");
const bytes = fs.readFileSync(input);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const snapshot = JSON.parse(bytes);
const plan = snapshot.plan;
const state = plan?.stateNodes?.[snapshot.app?.cursorStateNodeId || plan.initialStateNodeId];
if (!state) throw new Error("Snapshot does not identify a readable current plan state.");
const root = fileURLToPath(new URL("../src/generated/", import.meta.url));
const fetchImpl = async url => {
  const relative = new URL(url).pathname.replace(/^\//, "");
  const file = path.resolve(root, relative);
  const containment = path.relative(root, file);
  if (containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw new Error("Generated path escapes root");
  return { ok: fs.existsSync(file), status: fs.existsSync(file) ? 200 : 404, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
};
const dataset = await loadStandardizedDataset({ baseUrl: `http://fixture/datasets/${plan.game.gameId}`, fetchImpl });
const ai = await loadTrainerAiDocumentation({ baseUrl: "http://fixture/trainer-ai", gameId: plan.game.gameId, fetchImpl });
const sandbox = { console, require: name => { if (name === "./desc") return { display: () => "" }; throw new Error(`Unexpected module ${name}`); } };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const relative of ["vendor/smogon-calc-0.11.0/data.production.min.js", "vendor/smogon-calc-0.11.0/engine.production.min.js", "shared_damage_calculator.js", "trainer_ai/trainer_ai_evaluator.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "battle-mechanics", relative), "utf8"), sandbox, { filename: relative });
}
const runtime = sandbox.SharedDamageCalculator.createFromDocuments({ gameId: dataset.gameId }, sandbox.calc, dataset.mechanics, dataset.documents);
const started = performance.now();
const result = analyzeTrainerAi({ plan, state, dataset, ai, evaluator: sandbox.TrainerAiEvaluator, damageAdapter: createSharedDamageAdapter(runtime) });
if (digest(fs.readFileSync(input)) !== digest(bytes)) throw new Error("Input snapshot changed during replay");
console.log(JSON.stringify({
  snapshotSha256: digest(bytes), inputUnchanged: true, capturedAt: snapshot.capturedAt,
  elapsedMs: Math.round(performance.now() - started), status: result.status,
  actors: result.actors.map(actor => ({ name: actor.name, status: actor.forecastStatus, error: actor.forecastError,
    moves: actor.moves.map(move => ({ name: move.name, likelihood: move.turnLikelihood?.label, explanation: move.explanation, incentiveLedger: move.incentiveLedger })) })),
  replacements: result.replacementForecasts
}, null, 2));
if (result.actors.some(actor => actor.forecastStatus !== "available") || result.replacementForecasts.some(row => row.status === "error")) process.exitCode = 1;
