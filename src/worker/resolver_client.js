export class ResolverWorkerClient {
  constructor(url = new URL("./resolver_worker.js?v=20260826-turn-nodes", import.meta.url)) {
    this.worker = new Worker(url);
    this.requestId = 0;
    this.latestPreviewRequest = 0;
    this.pending = new Map();
    this.worker.addEventListener("message", event => {
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
    this.worker.addEventListener("error", event => {
      const error = new Error(event.message || "Resolver Worker failed to load");
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
    this.worker.addEventListener("messageerror", () => {
      const error = new Error("Resolver Worker returned an unreadable message");
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
  }

  request(type, payload) {
    const requestId = ++this.requestId;
    const promise = new Promise((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    this.worker.postMessage({ requestId, type, payload });
    return { requestId, promise };
  }

  initialize(datasetBaseUrl) {
    return this.request("initialize", { datasetBaseUrl }).promise;
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

  terminate() {
    this.worker.terminate();
    for (const entry of this.pending.values()) entry.reject(new Error("Resolver Worker stopped"));
    this.pending.clear();
  }
}
