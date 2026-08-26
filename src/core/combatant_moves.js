import { damagingMoveImmunity } from "../rulesets/switch_rules.js";

export function boundedSlotDamageLabel(minPercent, maxPercent) {
  if (minPercent === null || minPercent === undefined || maxPercent === null || maxPercent === undefined) return null;
  const min = Number(minPercent);
  const max = Number(maxPercent);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const bounded = value => Math.min(999.99, Math.max(0, value));
  return `${bounded(min).toFixed(2)}–${bounded(max).toFixed(2)}%`;
}

export function highestDamageCandidateKeys(candidates) {
  const maximumByTarget = new Map();
  for (const candidate of candidates || []) {
    const maximum = Number(candidate?.maxPercent);
    if (!candidate?.candidateKey || !candidate?.targetKey || !Number.isFinite(maximum)) continue;
    maximumByTarget.set(candidate.targetKey, Math.max(maximumByTarget.get(candidate.targetKey) ?? -Infinity, maximum));
  }
  return new Set((candidates || []).filter(candidate =>
    candidate?.candidateKey
      && Number.isFinite(Number(candidate.maxPercent))
      && Number(candidate.maxPercent) === maximumByTarget.get(candidate.targetKey)
  ).map(candidate => candidate.candidateKey));
}

export function combatantMoveEntry(combatant, combatantState, moveId) {
  const entries = combatantState?.moveSetOverride || combatant?.moves || [];
  return entries.find(entry => entry.moveId === moveId) || null;
}

export function effectiveCombatantMove(dataset, combatant, combatantState, moveId) {
  const base = dataset.get("moves", moveId);
  if (!base) return null;
  const entry = combatantMoveEntry(combatant, combatantState, moveId);
  if (!entry) return base;
  return {
    ...base,
    ...(Number.isInteger(Number(entry.basePowerOverride)) ? { basePower: Number(entry.basePowerOverride) } : {}),
    ...(entry.typeOverride ? { type: String(entry.typeOverride) } : {})
  };
}

export function resolvedCombatantMovePreview({ events = [], actorKey, targetKey, moveId }) {
  const matching = events.filter(event => event.actorKey === actorKey
    && event.targetKey === targetKey
    && event.moveId === moveId);
  if (!matching.length) return null;

  const damage = matching.find(event => event.eventType === "damage" && event.damagePercent);
  if (damage) {
    const minPercent = Number(damage.damagePercent.min);
    const maxPercent = Number(damage.damagePercent.max);
    if (Number.isFinite(minPercent) && Number.isFinite(maxPercent)) {
      return {
        status: "ok",
        label: `${minPercent.toFixed(1)}–${maxPercent.toFixed(1)}%`,
        minPercent,
        maxPercent,
        damage: damage.damageHp || null
      };
    }
  }

  if (matching.some(event => event.eventType === "move-immune")) return { status: "immune", label: "Immune" };
  if (matching.some(event => event.eventType === "miss")) return { status: "miss", label: "Miss" };
  const stopped = matching.find(event => ["move-blocked", "move-failed"].includes(event.eventType));
  if (stopped) return { status: stopped.eventType, label: stopped.metadata?.resultLabel || "No effect" };
  return null;
}

export function previewCombatantMove({ plan, stateNodeId, actorKey, targetKey, moveId, dataset, damageAdapter }) {
  const state = plan?.stateNodes?.[stateNodeId];
  const actor = plan?.combatants?.[actorKey];
  const target = plan?.combatants?.[targetKey];
  const actorState = state?.combatantStates?.[actorKey];
  const targetState = state?.combatantStates?.[targetKey];
  if (!state || !actor || !target || !actorState || !targetState) throw new Error("Damage preview references unavailable battle state");
  const move = effectiveCombatantMove(dataset, actor, actorState, moveId);
  if (!move) throw new Error(`Move ${moveId} is unavailable`);
  const immunity = damagingMoveImmunity({
    dataset,
    move,
    attackerState: actorState,
    defenderState: targetState,
    fieldState: state.fieldState,
    attackerSide: actor.side,
    defenderSide: target.side
  });
  if (immunity) return {
    status: "immune",
    label: "Immune",
    reason: immunity.reason,
    ...(immunity.abilityId ? { abilityId: immunity.abilityId } : {})
  };
  const result = damageAdapter.calculate({
    attacker: actor,
    defender: target,
    attackerState: actorState,
    defenderState: targetState,
    move,
    fieldState: state.fieldState,
    battleFormat: plan.game?.battleFormat || "singles"
  });
  if (result.status === "ok") return { status: "ok", label: result.label, minPercent: result.minPercent, maxPercent: result.maxPercent, damage: result.damage };
  if (result.status === "status") return { status: "status", label: "Status" };
  return { status: result.status || "unavailable", label: result.label || "Unavailable", reason: result.reason || null };
}
