// Move-name clicks toggle the move regardless of its target. A damage-slot
// click toggles only that exact move/target pair; another slot retargets it.
export function toggleMoveSelection(current, next, { targetClick = false, forced = false } = {}) {
  const selected = current?.type === 'move' && current.moveId === next.moveId
    && (!targetClick || current.targetKey === next.targetKey);
  return selected ? forced ? { ...current } : {} : { ...next };
}
