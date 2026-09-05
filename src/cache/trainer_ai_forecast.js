function cacheKey(plan, state) {
  if (!plan?.planId || !state?.stateNodeId || !state?.stateHash) return null;
  return `${plan.planId}:${state.stateNodeId}:${state.stateHash}`;
}

export class TrainerAiForecastCache {
  constructor() {
    this.completed = new Map();
    this.pending = new Map();
  }

  clear() {
    this.completed.clear();
    this.pending.clear();
  }

  key(plan, state) {
    return cacheKey(plan, state);
  }

  get(plan, state) {
    const key = cacheKey(plan, state);
    return key ? this.completed.get(key) || null : null;
  }

  resolve(plan, state, factory) {
    const key = cacheKey(plan, state);
    if (!key) return Promise.reject(new Error("Trainer AI forecast requires a saved state node"));
    if (this.completed.has(key)) return Promise.resolve(this.completed.get(key));
    if (this.pending.has(key)) return this.pending.get(key);

    const pending = Promise.resolve()
      .then(factory)
      .then(analysis => {
        this.completed.set(key, analysis);
        return analysis;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }
}
