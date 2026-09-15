export class ResolverWorkerClient {
  constructor(url = new URL(
    typeof __PLC_RESOLVER_WORKER_FILE__ !== "undefined"
      ? __PLC_RESOLVER_WORKER_FILE__
      : "./resolver_worker.js?v=20260914-hosted-datasets-v1",
    import.meta.url
  )) {
    this.url = url;
    this.worker = new Worker(url);
    this.trainerAiWorker = new Worker(url);
    this.requestId = 0;
    this.latestPreviewRequest = 0;
    this.pending = new Map();
    this.trainerAiInitializationPayload = null;
    this.trainerAiReady = null;
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

  async initialize(configuration, legacyTrainerAiBaseUrl = null, legacyGameId = null) {
    const {
      datasetBaseUrl,
      datasetHostedPrefix = null,
      trainerAiBaseUrl,
      trainerAiHostedPrefix = null,
      gameId
    } = typeof configuration === "string"
      ? { datasetBaseUrl: configuration, trainerAiBaseUrl: legacyTrainerAiBaseUrl, gameId: legacyGameId }
      : configuration;
    const shared = { datasetBaseUrl, datasetHostedPrefix, trainerAiBaseUrl, trainerAiHostedPrefix, gameId };
    this.trainerAiInitializationPayload = { ...shared, role: "trainer-ai" };
    const trainerAiReady = this.request("initialize", this.trainerAiInitializationPayload, this.trainerAiWorker, "trainer-ai").promise;
    this.trainerAiReady = trainerAiReady;
    const [resolver, trainerAiLane] = await Promise.all([
      this.request("initialize", { ...shared, role: "resolver" }, this.worker, "resolver").promise,
      trainerAiReady
    ]);
    if (this.trainerAiReady === trainerAiReady) this.trainerAiReady = null;
    return trainerAiLane?.trainerAiMetadata
      ? { ...resolver, trainerAiMetadata: trainerAiLane.trainerAiMetadata }
      : resolver;
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
    if (this.trainerAiReady) await this.trainerAiReady;
    return this.request("trainer-ai", payload, this.trainerAiWorker, "trainer-ai").promise;
  }

  resetTrainerAiLaneIfBusy() {
    const busy = [...this.pending.values()].some(entry => entry.lane === "trainer-ai");
    if (!busy) return false;
    const error = new Error("A new planning context replaced this Trainer AI analysis");
    error.name = "StaleTrainerAiError";
    for (const [requestId, entry] of this.pending) {
      if (entry.lane !== "trainer-ai") continue;
      entry.reject(error);
      this.pending.delete(requestId);
    }
    this.trainerAiWorker.terminate();
    this.trainerAiWorker = new Worker(this.url);
    this.bindWorker(this.trainerAiWorker, "trainer-ai");
    if (!this.trainerAiInitializationPayload) throw new Error("Trainer AI Worker has not been initialized");
    const ready = this.request("initialize", this.trainerAiInitializationPayload, this.trainerAiWorker, "trainer-ai").promise;
    this.trainerAiReady = ready;
    ready.then(() => {
      if (this.trainerAiReady === ready) this.trainerAiReady = null;
    }, () => {});
    return true;
  }

  terminate() {
    this.worker.terminate();
    this.trainerAiWorker.terminate();
    for (const entry of this.pending.values()) entry.reject(new Error("Resolver Worker stopped"));
    this.pending.clear();
  }
}
