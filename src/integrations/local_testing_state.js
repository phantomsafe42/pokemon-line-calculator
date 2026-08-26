import { formatTestingStateSnapshot, TESTING_STATE_KIND, TESTING_STATE_SCHEMA_VERSION } from "../testing/state_snapshot.js";

const CAPABILITY_URL = "/__stream-tools/plc-testing-state/capability";
const OUTPUT_URL = "/__stream-tools/plc-testing-state";

export async function detectLocalTestingStateCapability(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(CAPABILITY_URL, { cache: "no-store" });
    if (!response.ok) return null;
    const capability = await response.json();
    return capability?.available === true
      && capability.kind === TESTING_STATE_KIND
      && Number(capability.schemaVersion) === TESTING_STATE_SCHEMA_VERSION
      ? capability
      : null;
  } catch {
    return null;
  }
}

export async function storeLocalTestingState(snapshot, fetchImpl = fetch) {
  const response = await fetchImpl(OUTPUT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: formatTestingStateSnapshot(snapshot)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Local testing-state output failed (${response.status})`);
  return result;
}
