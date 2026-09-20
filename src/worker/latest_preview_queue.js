const stale = () => Object.assign(new Error('A newer turn preview replaced this result'), { name: 'StalePreviewError' });

// Coalesce rapid changes before posting; while one calculation runs, retain only
// the newest pending request. This does not interrupt a calculation mid-turn.
export class LatestPreviewQueue {
  constructor(send) { this.send = send; this.pending = null; this.busy = false; this.generation = 0; }
  cancel() { this.generation++; this.pending?.reject(stale()); this.pending = null; }
  request(payload) {
    this.cancel();
    return new Promise((resolve, reject) => {
      this.pending = { payload, resolve, reject, generation: this.generation };
      queueMicrotask(() => this.flush());
    });
  }
  async flush() {
    if (this.busy || !this.pending) return;
    const job = this.pending; this.pending = null; this.busy = true;
    try {
      const result = await this.send(job.payload);
      if (job.generation !== this.generation) job.reject(stale());
      else job.resolve(result);
    } catch (error) { job.reject(error); }
    finally { this.busy = false; if (this.pending) queueMicrotask(() => this.flush()); }
  }
}
