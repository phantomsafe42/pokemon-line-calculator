// Use the caller's existing player-view slot mapping; a missing side is not a player target.
export function forecastTargetLabel(distribution, slotNumber) {
  if (distribution.targetSlot == null) return "Field";
  if (!["player", "enemy"].includes(distribution.targetSide)
    || !Number.isInteger(distribution.targetSlot) || distribution.targetSlot < 0) return "Unknown target";
  return `Slot ${slotNumber(distribution.targetSide, distribution.targetSlot)}`;
}

// Presentation only: values come from the reached replacement-selection path.
export function replacementReasonLines(option, slotNumber) {
  const reasons = option.replacementReasons || [];
  const lines = reasons.map(reason => {
    const target = Number.isInteger(reason.targetSlot) ? ` · Slot ${slotNumber("player", reason.targetSlot)}` : "";
    const move = reason.moveName || reason.moveId;
    if (reason.generation === 5 && reason.kind === "power-times-effectiveness"
      && move && [reason.basePower, reason.multiplier, reason.score].every(Number.isFinite)) {
      const rounding = reason.basePower * reason.multiplier === reason.score ? "" : ", rounded down";
      return `${option.name}: ${move} (${reason.basePower} × ${reason.multiplier} = ${reason.score}${rounding})${target}`;
    }
    if (reason.generation === 4) {
      if (reason.kind === "post-ko-stage-one" && move && Number.isFinite(reason.score)) {
        return `${option.name}: Type score ${reason.score} · ${move} is super effective${target ? ` into${target.slice(2)}` : ""}`;
      }
      if (reason.kind === "post-ko-stage-two" && Number.isFinite(reason.score)) {
        return `${option.name}: ${move ? `${move} · ` : ""}AI damage score ${reason.score}${target}`;
      }
      if (reason.kind === "post-ko-party-order-fallback") return `${option.name}: First eligible Pokémon in party order`;
    }
    return null;
  }).filter(Boolean);
  return [...new Set(lines.length ? lines : [`${option.name}: Selection details unavailable`])];
}
