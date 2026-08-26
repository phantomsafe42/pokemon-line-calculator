const BASE = "/__stream-tools/battle-plan-live";

function loopbackHost() {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(location.hostname);
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Live-edit endpoint HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function detectLocalLiveEditCapability() {
  if (!loopbackHost()) return null;
  try {
    const capability = await jsonRequest(`${BASE}/capability`);
    return capability.available === true ? capability : null;
  } catch {
    return null;
  }
}

export class LocalLiveEditWriter {
  constructor({ heartbeatMs = 5000, onError = () => {} } = {}) {
    this.heartbeatMs = heartbeatMs;
    this.onError = onError;
    this.session = null;
    this.heartbeatTimer = null;
    this.flushChain = Promise.resolve();
  }

  get active() { return Boolean(this.session); }

  async begin(plan, resume = {}) {
    if (this.active) return this.session;
    const result = await jsonRequest(`${BASE}/writer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan,
        resumeSessionId: resume.sessionId || null,
        resumeLeaseId: resume.writerLeaseId || null
      })
    });
    this.session = result;
    this.startHeartbeat();
    return result;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch(error => this.onError(error));
    }, this.heartbeatMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async heartbeat() {
    if (!this.session) return null;
    return jsonRequest(`${BASE}/session/${this.session.sessionId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "writer", leaseId: this.session.writerLeaseId })
    });
  }

  flush(plan) {
    if (!this.session) return Promise.resolve(null);
    this.flushChain = this.flushChain.then(async () => {
      const result = await jsonRequest(`${BASE}/session/${this.session.sessionId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leaseId: this.session.writerLeaseId,
          expectedRevision: this.session.liveRevision,
          plan
        })
      });
      this.session = { ...this.session, ...result };
      return result;
    });
    return this.flushChain;
  }

  async stop(plan = null) {
    if (!this.session) return null;
    if (plan) await this.flush(plan);
    const session = this.session;
    this.stopHeartbeat();
    await jsonRequest(`${BASE}/session/${session.sessionId}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "writer", leaseId: session.writerLeaseId })
    });
    this.session = null;
    this.flushChain = Promise.resolve();
    return session;
  }
}
