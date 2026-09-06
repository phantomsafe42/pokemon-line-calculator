// Read-only real-Dataset/real-evaluator integration corpus. No service or live state writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadStandardizedDataset } from '../src/adapters/standardized_dataset.js';
import { normalizePlayerCollection, normalizeTrainerRoster, snapshotFingerprint } from '../src/adapters/combatant_ingest.js';
import { createPlanDocument } from '../src/core/plan.js';
import { analyzeTrainerAi } from '../src/adapters/trainer_ai.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const staged = process.argv.includes('--staged-authority');
const gameArg = process.argv.find(value => value.startsWith('--game='))?.split('=')[1];
const limit = Number(process.argv.find(value => value.startsWith('--limit='))?.split('=')[1] || Infinity);
const trainerArg = process.argv.find(value => value.startsWith('--trainer='))?.split('=')[1];
const reportArg = process.argv.find(value => value.startsWith('--report='))?.slice('--report='.length);
const seedArg = process.argv.find(value => value.startsWith('--seed='))?.split('=')[1];
const eachPartySlot = process.argv.includes('--each-party-slot');
const lowHp = process.argv.includes('--low-hp');
const workspace = path.resolve(root, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
await import('../src/generated/battle-mechanics/trainer_ai/trainer_ai_evaluator.js');
const engine = globalThis.TrainerAiEvaluator;
const evaluator = seedArg === undefined ? engine : { ...engine, forecast: options => engine.forecast({ ...options,
  request: { ...options.request, state: { ...options.request.state, random: { ...options.request.state.random,
    g4LcrngSeed: options.request.state.random?.g4LcrngSeed ?? Number(seedArg) } } } }) };
const configurations = [
  ['platinum-kaizo', 'Platinum Kaizo', 'platinum-kaizo-nightmare-final'],
  ['storm-silver', 'Storm Silver', 'sssg-pchal-supported-build'],
];
let failed = 0;
const reports = [];
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const [gameId, folder, profileId] of configurations.filter(row => !gameArg || row[0] === gameArg)) {
  const source = staged ? path.join(workspace, 'Datasets', folder, 'source-data') : path.join(root, 'src/generated/datasets', gameId);
  const dataset = await loadStandardizedDataset({ baseUrl: 'http://fixture/dataset/', fetchImpl: async url => {
    const file = path.join(source, path.basename(new URL(url).pathname));
    return { ok: fs.existsSync(file), status: fs.existsSync(file) ? 200 : 404, json: async () => read(file) };
  } });
  const shared = read(staged ? path.join(workspace, 'Datasets/Gen 4/source-data/trainer_ai.json') : path.join(root, 'src/generated/trainer-ai/gen4/trainer_ai.json'));
  const binding = read(staged ? path.join(source, 'trainer_ai.json') : path.join(root, 'src/generated/trainer-ai', gameId, 'trainer_ai.json'));
  const profile = shared.profiles.find(row => row.profileId === profileId);
  if (!profile?.evaluator) throw new Error(`Missing candidate profile ${profileId}`);
  if (!staged && (!binding.consumerActivation?.enabled || binding.inheritance.baseProfile !== profileId)) throw new Error(`Game binding not activated: ${gameId}`);
  const ai = { binding, shared, profile, evaluatorProfile: profile.evaluator, semantics: null, generation: 4 };
  const trainers = Object.values(read(path.join(source, 'trainers.json')).records).filter(row => row.team?.length && row.battleProfiles?.[dataset.mechanics.trainerBattleProfile]?.aiMask != null && (!trainerArg || trainerArg.split(',').includes(row.id))).slice(0, limit);
  if (!trainers.length) throw new Error(`Empty requested trainer corpus: ${gameId}`);
  const sourceHashes = Object.fromEntries(fs.readdirSync(source).filter(file => ['battle_mechanics.json', 'species.json', 'moves.json', 'items.json', 'abilities.json', 'natures.json', 'trainers.json'].includes(file)).sort().map(file => [file, digest(path.join(source, file))]));
  sourceHashes.evaluator = digest(path.join(root, 'src/generated/battle-mechanics/trainer_ai/trainer_ai_evaluator.js'));
  sourceHashes.adapter = digest(path.join(root, 'src/adapters/trainer_ai.js'));
  sourceHashes.profile = crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex');
  const totalCases = eachPartySlot ? trainers.reduce((sum, trainer) => sum + trainer.team.length, 0) : trainers.length;
  let checked = 0;
  const errors = [];
  for (const trainer of trainers) {
    const errorCount = errors.length;
    const level = Math.max(...trainer.team.map(mon => mon.level));
    const players = normalizePlayerCollection({ collection: [1, 2].map(slot => ({
      uniqueKey: `priority-corpus-player-${slot}`, speciesId: 'gyarados', species: 'Gyarados', displayName: 'Gyarados',
      level, gender: 'M', friendship: 255, nature: 'Hardy', ability: 'Intimidate', item: null,
      ivs: { hp: 31, at: 31, df: 31, sa: 31, sd: 31, sp: 31 }, evs: { hp: 0, at: 0, df: 0, sa: 0, sd: 0, sp: 0 },
      moves: ['waterfall', 'bite', 'dragondance', 'protect'], storage: 'party', slot,
    })) }, dataset);
    try {
      const enemies = normalizeTrainerRoster(trainer.id, null, dataset);
      const plan = createPlanDocument({ dataset, trainerId: trainer.id, playerCombatants: players, enemyCombatants: enemies,
        sourceSnapshot: snapshotFingerprint(players, enemies, '2026-09-05T00:00:00.000Z'), now: '2026-09-05T00:00:00.000Z' });
      const state = plan.stateNodes[plan.initialStateNodeId];
      const partyKeys = Object.values(plan.combatants).filter(mon => mon.side === 'enemy').map(mon => mon.combatantKey);
      const scenarios = eachPartySlot ? partyKeys : [null];
      for (const key of scenarios) {
      const scenarioState = structuredClone(state);
      if (key) {
        scenarioState.active.enemyCombatantKeys = [key, ...partyKeys.filter(other => other !== key)].slice(0, state.active.enemyCombatantKeys.length);
        for (const activeKey of scenarioState.active.enemyCombatantKeys) scenarioState.combatantStates[activeKey].enteredTurnNumber = scenarioState.turnNumber;
      }
      if (lowHp) for (const activeKey of scenarioState.active.enemyCombatantKeys) {
        const hp = scenarioState.combatantStates[activeKey].hp;
        scenarioState.combatantStates[activeKey].hp = { ...hp, min: 1, max: 1 };
        scenarioState.combatantStates[activeKey].hpDistribution = [{ value: 1, probability: 1 }];
      }
      const before = JSON.stringify(plan);
      const beforeState = JSON.stringify(scenarioState);
      const result = analyzeTrainerAi({ plan, state: scenarioState, dataset, ai, evaluator, damageAdapter: { calculate() { throw new Error('Gen 4 AI must execute the Dataset AI damage program, not normal damage'); } } });
      if (JSON.stringify(plan) !== before) throw new Error('Forecast mutated the plan');
      if (JSON.stringify(scenarioState) !== beforeState) throw new Error('Forecast mutated the caller state');
      if (result?.actors.length !== scenarioState.active.enemyCombatantKeys.length || result.replacementForecasts.length !== result.actors.length) throw new Error('Forecast omitted an active actor or replacement domain');
      if (result.actors.some(actor => !actor.actions.length)) throw new Error('Available forecast omitted every action');
      const badActors = result.actors.filter(row => row.forecastStatus !== 'available');
      const badReplacements = result.replacementForecasts.filter(row => !['available', 'not-applicable'].includes(row.status));
      if (badActors.length || badReplacements.length) errors.push({ trainerId: trainer.id, partyKey: key, actors: badActors.map(row => ({ name: row.name, error: row.forecastError })), replacements: badReplacements });
      checked++;
      }
    } catch (error) { errors.push({ trainerId: trainer.id, error: error.message }); }
    if (errors.length > errorCount) process.stderr.write(JSON.stringify(errors.at(-1)) + '\n');
    if (checked % 25 === 0) process.stderr.write(`${gameId}: ${checked}/${totalCases}, ${errors.length} failed\n`);
  }
  failed += errors.length;
  const report = { gameId, staged, seed: seedArg ?? null, eachPartySlot, lowHp, trainers: trainers.length, checked, failed: errors.length, sourceHashes, errors };
  reports.push(report);
  console.log(JSON.stringify(report, null, 2));
}
if (reportArg) {
  const target = path.resolve(root, reportArg);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ schemaVersion: 'plc-trainer-ai-corpus-verification/v1', status: failed ? 'failed' : 'passed', reports }, null, 2) + '\n');
}
process.exitCode = failed ? 1 : 0;
