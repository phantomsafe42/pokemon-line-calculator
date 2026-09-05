import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadStandardizedDataset } from '../src/adapters/standardized_dataset.js';
import { normalizePlayerCollection, normalizeTrainerRoster, snapshotFingerprint } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';
import { analyzeTrainerAi, loadTrainerAiDocumentation } from '../src/adapters/trainer_ai.js';

// Generated-input-only smoke coverage. This is an error-discovery corpus, NOT
// an independent known-answer suite or proof that every source path is covered.
const root = fileURLToPath(new URL('../src/generated/', import.meta.url));
const fetchImpl = async url => {
  const relative = new URL(url).pathname.slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root)) throw new Error('Input escaped generated root');
  return { ok: fs.existsSync(file), status: fs.existsSync(file) ? 200 : 404, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};
const dataset = await loadStandardizedDataset({ baseUrl: 'http://fixture/datasets/renegade-platinum', fetchImpl });
const ai = await loadTrainerAiDocumentation({ baseUrl: 'http://fixture/trainer-ai', gameId: 'renegade-platinum', generation: 4, fetchImpl });
const sandbox = { globalThis: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'battle-mechanics/trainer_ai/trainer_ai_evaluator.js'), 'utf8'), sandbox);
const engine = sandbox.globalThis.TrainerAiEvaluator;
const seededSmoke = process.argv.includes('--seeded-smoke');
const evaluator = { ...engine, forecast: options => engine.forecast({ ...options,
  request: seededSmoke ? { ...options.request, state: { ...options.request.state, random: { g4LcrngSeed: 0 } } } : options.request,
  forecast: { g4SeedSampleSize: 16 } }) };
const trainers = JSON.parse(fs.readFileSync(path.join(root, 'datasets/renegade-platinum/trainers.json'))).records;
const offset = Number(process.argv[2] || 0), limit = Number(process.argv[3] || 20);
const ids = Object.keys(trainers).sort().slice(offset, offset + limit);
const errors = [];
for (const [index, trainerId] of ids.entries()) {
  try {
    const enemies = normalizeTrainerRoster(trainerId, null, dataset);
    if (!enemies.length) continue;
    const players = normalizePlayerCollection({ collection: [0, 1].map(index => ({ uniqueKey: `source-audit-${index}`, speciesId: 'chimchar', species: 'Chimchar', displayName: 'Chimchar', level: 50, nature: 'Hardy', ability: 'Blaze', item: null, gender: 'M', ivs: { hp: 31, at: 31, df: 31, sa: 31, sd: 31, sp: 31 }, evs: { hp: 0, at: 0, df: 0, sa: 0, sd: 0, sp: 0 }, moves: ['scratch', 'leer'], storage: 'party', slot: index + 1 })) }, dataset);
    const plan = createPlanDocument({ dataset, trainerId, playerCombatants: players, enemyCombatants: enemies, sourceSnapshot: snapshotFingerprint(players, enemies, '2026-09-04T00:00:00.000Z'), now: '2026-09-04T00:00:00.000Z' });
    const state = plan.stateNodes[plan.initialStateNodeId];
    const result = analyzeTrainerAi({ plan, state, dataset, ai, evaluator, damageAdapter: { calculate() { throw new Error('Gen 4 source AI must not use normal final damage'); } } });
    const issues = [...result.actors.filter(row => row.forecastStatus !== 'available').map(row => ({ phase: 'turn', pokemon: row.name, error: row.forecastError })), ...result.replacementForecasts.filter(row => row.status === 'error').map(row => ({ phase: 'replacement', error: row.reason || row.error || row.diagnostics }))];
    if (issues.length) { const row = { trainerId, issues }; errors.push(row); console.log(JSON.stringify(row)); }
  } catch (error) { const row = { trainerId, error: error.message }; errors.push(row); console.log(JSON.stringify(row)); }
  if ((index + 1) % 10 === 0) console.log(JSON.stringify({ checked: index + 1, errors: errors.length }));
}
console.log(JSON.stringify({ kind: 'source-query-smoke-not-known-answer', randomMode: seededSmoke ? 'single-explicit-seed-zero-not-all-paths' : '16-hidden-seed-samples-not-all-paths', checked: ids.length, offset, errors }, null, 2));
if (errors.length) process.exitCode = 1;
