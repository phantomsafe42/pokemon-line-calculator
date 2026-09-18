// Pre-damage and explicit overrides are absolute HP, not percentages.
export function hasManualStartingHp(initial, maxHp) {
  return Boolean(initial?.currentHpEdited)
    || (initial?.currentHp != null && Number(initial.currentHp) !== maxHp);
}
