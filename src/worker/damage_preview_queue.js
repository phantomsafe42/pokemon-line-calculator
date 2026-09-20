import { stableStringify } from '../core/primitives.js';

const stale = () => Object.assign(new Error('A newer view replaced this damage preview'), { name: 'StalePreviewError' });

// Display damage needs field geometry and combatants, never historical nodes,
// events, notes, AI forecasts, or the export graph. Keep every battle-state field
// on the combatants: items, volatiles and conditional-power flags all matter.
export function damagePreviewSnapshot(plan, stateNodeId) {
  const state = plan.stateNodes[stateNodeId];
  if (!state) throw new Error('Damage preview references unavailable battle state');
  return {
    game: plan.game,
    combatants: Object.fromEntries(Object.keys(state.combatantStates).map(key => [key, plan.combatants[key]])),
    stateNodes: { [stateNodeId]: {
      active: state.active, rotation: state.rotation, fieldState: state.fieldState,
      combatantStates: state.combatantStates
    } }
  };
}

// One in-flight batch and one current view. Obsolete queued work never reaches
// the Worker. A small, content-keyed cache also survives harmless DOM rerenders.
export class DamagePreviewQueue {
  constructor(send) {
    this.send = send;
    this.generation = 0;
    this.jobs = [];
    this.busy = false;
    this.cache = new Map();
    this.contextKey = null;
  }
  reset({ clearCache = false } = {}) {
    this.generation++;
    for (const job of this.jobs) job.reject(stale());
    this.jobs = [];
    if (clearCache) { this.contextKey = null; this.cache.clear(); }
  }
  request(payload) {
    return new Promise((resolve, reject) => {
      this.jobs.push({ payload, resolve, reject, generation: this.generation });
      queueMicrotask(() => this.flush());
    });
  }
  async flush() {
    if (this.busy || !this.jobs.length) return;
    const jobs = this.jobs.splice(0);
    const generation = this.generation;
    this.busy = true;
    try {
      // A render submits one context. Partition defensively for non-UI callers.
      const first = jobs[0].payload;
      const selected = jobs.filter(job => job.payload.plan === first.plan && job.payload.stateNodeId === first.stateNodeId);
      this.jobs.unshift(...jobs.filter(job => !selected.includes(job)));
      const snapshot = damagePreviewSnapshot(first.plan, first.stateNodeId);
      const contextKey = stableStringify(snapshot);
      if (contextKey !== this.contextKey) { this.contextKey = contextKey; this.cache.clear(); }
      const groups = new Map();
      for (const job of selected) {
        const { plan, ...request } = job.payload;
        const key = stableStringify(request);
        if (this.cache.has(key)) { job.resolve(this.cache.get(key)); continue; }
        if (!groups.has(key)) groups.set(key, { request, jobs: [] });
        groups.get(key).jobs.push(job);
      }
      if (groups.size) {
        const entries = [...groups];
        const results = await this.send({ plan: snapshot, requests: entries.map(([, group]) => group.request) });
        entries.forEach(([key, group], index) => {
          const result = results[index];
          const error = generation !== this.generation ? stale() : result?.error
            ? Object.assign(new Error(result.error.message), { name: result.error.name }) : null;
          if (!error && result?.ok) {
            this.cache.set(key, result.value);
            while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
          }
          for (const job of group.jobs) error || !result?.ok
            ? job.reject(error || new Error('Invalid damage preview response')) : job.resolve(result.value);
        });
      }
    } catch (error) { for (const job of jobs) job.reject(error); }
    finally { this.busy = false; if (this.jobs.length) queueMicrotask(() => this.flush()); }
  }
}
