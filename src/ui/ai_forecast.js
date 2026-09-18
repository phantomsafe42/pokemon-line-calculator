// Use the caller's existing player-view slot mapping; a missing side is not a player target.
export function forecastTargetLabel(distribution, slotNumber) {
  if (distribution.targetSlot == null) return "Field";
  if (!["player", "enemy"].includes(distribution.targetSide)
    || !Number.isInteger(distribution.targetSlot) || distribution.targetSlot < 0) return "Unknown target";
  return `Slot ${slotNumber(distribution.targetSide, distribution.targetSlot)}`;
}
