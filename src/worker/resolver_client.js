export class ResolverWorkerClient {
  constructor(url = new URL("./resolver_worker.js?v=20260905-drafts-freecalc-partners-v1", import.meta.url)) {
    this.url = url;
    this.worker = new Worker(url);
    this.trainerAiWorker = new Worker(url);
    this.initializationPayload = null;
    this.requestId = 0;
    this.latestPreviewRequest = 0;
    this.pending = new Map();
    this.bindWorker(this.worker, "resolver");
    this.bindWorker(this.trainerAiWorker, "trainer-ai");
  }

  bindWorker(worker, lane) {
    worker.addEventListener("message", event => {
      const entry = this.pending.get(event.data.requestId);
      if (!entry) return;
      this.pending.delete(event.data.requestId);
      if (event.data.ok) entry.resolve(event.data.result);
      else {
        const error = new Error(event.data.error?.message || "Resolver Worker failed");
        error.name = event.data.error?.name || "Error";
        entry.reject(error);
      }
    });
    worker.addEventListener("error", event => {
      const error = new Error(event.message || "Resolver Worker failed to load");
      for (const [requestId, entry] of this.pending) {
        if (entry.lane !== lane) continue;
        entry.reject(error);
        this.pending.delete(requestId);
      }
    });
    worker.addEventListener("messageerror", () => {
      const error = new Error("Resolver Worker returned an unreadable message");
      for (const [requestId, entry] of this.pending) {
        if (entry.lane !== lane) continue;
        entry.reject(error);
        this.pending.delete(requestId);
      }
    });
  }

  request(type, payload, worker = this.worker, lane = "resolver") {
    const requestId = ++this.requestId;
    const promise = new Promise((resolve, reject) => this.pending.set(requestId, { resolve, reject, lane }));
    worker.postMessage({ requestId, type, payload });
    return { requestId, promise };
  }

  async initialize(datasetBaseUrl, trainerAiBaseUrl, gameId) {
    const payload = { datasetBaseUrl, trainerAiBaseUrl, gameId };
    this.initializationPayload = payload;
    const [resolver] = await Promise.all([
      this.request("initialize", payload, this.worker, "resolver").promise,
      this.request("initialize", payload, this.trainerAiWorker, "trainer-ai").promise
    ]);
    return resolver;
  }

  async preview(payload) {
    const { requestId, promise } = this.request("preview", payload);
    this.latestPreviewRequest = requestId;
    const result = await promise;
    if (requestId !== this.latestPreviewRequest) {
      const error = new Error("A newer turn preview replaced this result");
      error.name = "StalePreviewError";
      throw error;
    }
    return result;
  }

  damagePreview(payload) {
    return this.request("damage-preview", payload).promise;
  }

  async trainerAi(payload) {
    const busy = [...this.pending.values()].some(entry => entry.lane === "trainer-ai");
    if (busy) {
      const error = new Error("A newer Trainer AI state replaced this analysis");
      error.name = "StaleTrainerAiError";
      for (const [requestId, entry] of this.pending) {
        if (entry.lane !== "trainer-ai") continue;
        entry.reject(error);
        this.pending.delete(requestId);
      }
      this.trainerAiWorker.terminate();
      this.trainerAiWorker = new Worker(this.url);
      this.bindWorker(this.trainerAiWorker, "trainer-ai");
      if (!this.initializationPayload) throw new Error("Resolver Worker has not been initialized");
      await this.request("initialize", this.initializationPayload, this.trainerAiWorker, "trainer-ai").promise;
    }
    return this.request("trainer-ai", payload, this.trainerAiWorker, "trainer-ai").promise;
  }

  terminate() {
    this.worker.terminate();
    this.trainerAiWorker.terminate();
    for (const entry of this.pending.values()) entry.reject(new Error("Resolver Worker stopped"));
    this.pending.clear();
  }
}
