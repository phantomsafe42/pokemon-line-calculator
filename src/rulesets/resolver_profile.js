// Increment this value whenever PLC resolver behavior changes in a way that can alter
// committed states or outcome branches without changing standardized Dataset inputs.
export const PLC_RESOLVER_RULESET_VERSION = "plc-resolver-v7-ability-form-events";

export function currentMechanicsFingerprint(dataset) {
  if (!dataset?.fingerprint) throw new Error("A Dataset mechanics fingerprint is required");
  return {
    ...structuredClone(dataset.fingerprint),
    plcResolverRulesetVersion: PLC_RESOLVER_RULESET_VERSION
  };
}
