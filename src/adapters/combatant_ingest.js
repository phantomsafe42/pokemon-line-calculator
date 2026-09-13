import { canonicalStats, shortHash, stableStringify, toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { canonicalSpeciesDisplayName, canonicalTrainerMember, DatasetReadinessError } from "./standardized_dataset.js?v=20260912-vanilla-display-names-v2";

const NATURE_MULTIPLIER_DENOMINATOR = 10;
const NATURE_BOOST_NUMERATOR = 11;
const NATURE_NERF_NUMERATOR = 9;

function finiteLevel(value, maximum = 100) {
  const level = Number(value);
  if (!Number.isInteger(level) || level < 1 || level > maximum) throw new DatasetReadinessError(`Invalid level ${value}`);
  return level;
}

function displayedLevelStatBug(dataset) {
  const feature = dataset?.mechanics?.features?.challengeModeDisplayedLevelStatBug;
  return feature?.enabled === true ? feature : null;
}

function trainerStatCalculationLevelDelta(member, dataset, displayedLevel, maximum) {
  const feature = displayedLevelStatBug(dataset);
  if (!feature) return 0;
  const memberField = String(feature.statLevelDeltaMemberField || "").trim();
  if (!memberField) throw new DatasetReadinessError("The displayed-level stat adjustment is missing its trainer-member field contract");
  const rawDelta = member?.[memberField];
  // Static/wild scripted encounters do not pass through the trainer-party level
  // loader, so the trainer-only field is intentionally absent for those records.
  if (rawDelta === null || rawDelta === undefined || rawDelta === "") return 0;
  const delta = Number(rawDelta);
  if (!Number.isInteger(delta)) throw new DatasetReadinessError(`${member.displaySpecies || member.speciesId} has an invalid ${memberField}`);
  finiteLevel(displayedLevel + delta, maximum);
  return delta;
}

function requireCompleteStats(stats, label, { min = 0, max = 255 } = {}) {
  for (const [key, value] of Object.entries(stats)) {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new DatasetReadinessError(`${label} ${key} is unavailable or invalid`);
    }
  }
  return stats;
}

export function calculateStats(combatant, dataset) {
  const species = dataset.get("species", combatant.speciesId);
  if (!species?.baseStats) throw new DatasetReadinessError(`Species ${combatant.speciesId} has no base stats`);
  const nature = combatant.natureId ? dataset.get("natures", combatant.natureId) : null;
  if (!nature) throw new DatasetReadinessError(`${combatant.displayName} requires a nature`);
  const displayedLevel = finiteLevel(combatant.level, Number(dataset.mechanics?.levelRules?.maximumBattleLevel ?? 100));
  const delta = displayedLevelStatBug(dataset) && combatant.side === "enemy"
    ? Number(combatant.statCalculationLevelDelta ?? 0)
    : 0;
  if (!Number.isInteger(delta)) throw new DatasetReadinessError(`${combatant.displayName} has an invalid stat-calculation level adjustment`);
  const level = finiteLevel(displayedLevel + delta, Number(dataset.mechanics?.levelRules?.maximumBattleLevel ?? 100));
  const output = {};
  for (const stat of ["hp", "atk", "def", "spa", "spd", "spe"]) {
    const base = Number(combatant.baseStats?.[stat] ?? species.baseStats[stat]);
    const iv = Number(combatant.ivs[stat]);
    const ev = Number(combatant.evs[stat]);
    const scaled = Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100);
    if (stat === "hp") {
      output.hp = base === 1 ? 1 : scaled + level + 10;
      continue;
    }
    let natureNumerator = NATURE_MULTIPLIER_DENOMINATOR;
    if (nature.boostedStat === stat && nature.nerfedStat !== stat) natureNumerator = NATURE_BOOST_NUMERATOR;
    if (nature.nerfedStat === stat && nature.boostedStat !== stat) natureNumerator = NATURE_NERF_NUMERATOR;
    output[stat] = Math.floor((scaled + 5) * natureNumerator / NATURE_MULTIPLIER_DENOMINATOR);
  }
  return output;
}

function normalizeMoves(moveValues, dataset) {
  return (moveValues || []).slice(0, 4).map(value => {
    const moveId = toId(value?.moveId || value?.id || value?.name || value);
    const move = dataset.get("moves", moveId);
    if (!move) throw new DatasetReadinessError(`Move ${moveId || value} is unavailable`);
    const suppliedPp = value && typeof value === "object" ? value.maxPp ?? value.pp : null;
    const suppliedPower = value && typeof value === "object" ? value.basePowerOverride ?? value.basePower ?? value.bp : null;
    const suppliedType = value && typeof value === "object" ? value.typeOverride ?? value.type : null;
    return {
      moveId,
      maxPp: Number(suppliedPp ?? move.pp ?? 0),
      ...(suppliedPower !== null && suppliedPower !== undefined && Number(suppliedPower) !== Number(move.basePower || 0) ? { basePowerOverride: Number(suppliedPower) } : {}),
      ...(suppliedType && toId(suppliedType) !== toId(move.type) ? { typeOverride: toId(suppliedType) } : {})
    };
  });
}

function normalizeBaseExperienceYield(species) {
  const value = species?.baseExp ?? species?.baseExperienceYield;
  return Number.isInteger(value) && value >= 1 && value <= 0xffff ? value : null;
}

function finalizeCombatant(record, dataset) {
  if (!dataset.get("species", record.speciesId)) throw new DatasetReadinessError(`Species ${record.speciesId} is unavailable`);
  if (record.baseStats) record.baseStats = requireCompleteStats(canonicalStats(record.baseStats, NaN), `${record.displayName} base stat`, { min: 1, max: 255 });
  record.ivs = requireCompleteStats(canonicalStats(record.ivs, NaN), `${record.displayName} IV`, { min: 0, max: 31 });
  record.evs = requireCompleteStats(canonicalStats(record.evs, NaN), `${record.displayName} EV`, { min: 0, max: 255 });
  record.calculatedStats = calculateStats(record, dataset);
  return record;
}

export function normalizePlayerCollection(payload, dataset) {
  const collection = Array.isArray(payload?.collection) ? payload.collection : null;
  const records = Array.isArray(payload) ? payload
    : Array.isArray(payload?.party) ? payload.party
      : collection ? (collection.some(mon => mon?.storage) ? collection.filter(mon => mon?.storage === "party") : collection)
        : Array.isArray(payload?.team) ? payload.team
          : [];
  if (!records.length) throw new DatasetReadinessError("The player snapshot has no Pokémon");
  const evFallback = dataset.mechanics.features?.playerEvGainDisabled === true ? 0 : NaN;
  return records.map((mon, index) => {
    const identity = mon.uniqueKey || (mon.pid !== null && mon.pid !== undefined ? `pid:${mon.pid}` : `slot:${index + 1}`);
    const speciesId = toId(mon.speciesId || mon.id || mon.species || mon.displayName);
    const species = dataset.get("species", speciesId);
    const combatant = {
      combatantKey: `player:${mon.uniqueKey ? "unique" : mon.pid !== null && mon.pid !== undefined ? "pid" : "snapshot"}:${toId(identity) || index + 1}`,
      side: "player",
      source: {
        kind: mon.source?.kind || mon.sourceKind || "save-tracker",
        pid: mon.pid ?? null,
        uniqueKey: mon.uniqueKey ?? null,
        boxId: mon.source?.boxId ?? null,
        trainerId: null,
        trainerVariantId: null,
        trainerSlot: null,
        storage: mon.storage ?? null,
        box: mon.box ?? null,
        slot: mon.slot ?? index + 1
      },
      speciesId,
      formId: mon.formId ? toId(mon.formId) : null,
      displayName: mon.displayName || mon.species || species?.name || speciesId,
      nickname: mon.nickname || "",
      level: finiteLevel(mon.level),
      ...(mon.experience === null || mon.experience === undefined ? {} : { experience: Math.max(0, Math.floor(Number(mon.experience))) }),
      growthRate: species?.growthRate || null,
      baseExperienceYield: normalizeBaseExperienceYield(species),
      gender: mon.gender ?? null,
      ...(Number.isInteger(mon.friendship) && mon.friendship >= 0 && mon.friendship <= 255 ? { friendship: mon.friendship } : {}),
      natureId: mon.nature ? toId(mon.nature) : mon.natureId ? toId(mon.natureId) : null,
      ivs: canonicalStats(mon.ivs, NaN),
      evs: canonicalStats(mon.evs, evFallback),
      baseStats: canonicalStats(mon.baseStats || species?.baseStats, NaN),
      originalAbilityId: mon.ability ? toId(mon.ability) : mon.abilityId ? toId(mon.abilityId) : null,
      originalItemId: mon.item ? toId(mon.item) : mon.itemId ? toId(mon.itemId) : null,
      originalTypeIds: (mon.types || species?.types || []).map(toId),
      moves: normalizeMoves(mon.moves, dataset)
    };
    return finalizeCombatant(combatant, dataset);
  });
}

export function normalizeTrainerRoster(trainerId, trainerVariantId, dataset, runtimeInputs = {}) {
  const trainer = dataset.trainer(trainerId);
  if (!trainer) throw new DatasetReadinessError(`Trainer ${trainerId} is unavailable`);
  const members = dataset.trainerTeam(trainerId, trainerVariantId);
  const maximumBattleLevel = Number(dataset.mechanics?.levelRules?.maximumBattleLevel ?? 100);
  return members.map((raw, index) => {
    const member = canonicalTrainerMember(raw);
    const observed = runtimeInputs[String(member.slot ?? index + 1)] || {};
    const natureId = observed.nature ? toId(observed.nature) : member.natureId;
    const ivs = observed.ivs || member.ivs;
    if (raw.naturePolicy === "runtime-observed-required" && !observed.nature) {
      throw new DatasetReadinessError(`${raw.displaySpecies || member.speciesId} requires an observed nature`);
    }
    if (raw.ivPolicy === "runtime-observed-required" && !observed.ivs) {
      throw new DatasetReadinessError(`${raw.displaySpecies || member.speciesId} requires six observed IVs`);
    }
    const species = dataset.get("species", member.speciesId);
    const slot = Number(member.slot ?? index + 1);
    const level = finiteLevel(member.level, maximumBattleLevel);
    const statCalculationLevelDelta = trainerStatCalculationLevelDelta(member, dataset, level, maximumBattleLevel);
    return finalizeCombatant({
      combatantKey: `enemy:trainer:${toId(trainer.id)}:variant:${toId(trainerVariantId || "base")}:slot:${slot}`,
      side: "enemy",
      source: {
        kind: "standardized-trainer",
        pid: null,
        uniqueKey: null,
        trainerId: raw.ownerTrainerId || trainer.id,
        partyOwnerId: raw.ownerTrainerId || null,
        ownerPartySlot: raw.ownerPartySlot ?? null,
        consumerTrainerId: raw.ownerConsumerTrainerId ?? trainer.consumerTrainerId ?? null,
        trainerVariantId: trainerVariantId ?? null,
        trainerSlot: raw.ownerPartySlot ?? slot,
        encounterSlot: slot
      },
      speciesId: member.speciesId,
      formId: raw.form ? String(raw.form) : null,
      displayName: canonicalSpeciesDisplayName(dataset, member),
      nickname: "",
      level,
      ...(statCalculationLevelDelta ? { statCalculationLevelDelta } : {}),
      growthRate: species?.growthRate || null,
      baseExperienceYield: normalizeBaseExperienceYield(species),
      gender: member.gender ?? null,
      ...(Number.isInteger(member.initialFriendship) ? { friendship: member.initialFriendship } : {}),
      natureId,
      ivs,
      evs: member.evs,
      originalAbilityId: member.abilityId,
      originalItemId: member.itemId,
      originalTypeIds: (species?.types || []).map(toId),
      moves: normalizeMoves(member.moveIds, dataset)
    }, dataset);
  });
}

export function snapshotFingerprint(playerCombatants, trainerCombatants, updatedAt = null) {
  return {
    playerCollectionUpdatedAt: updatedAt,
    playerRosterHash: `plc-${shortHash(stableStringify(playerCombatants))}`,
    trainerSnapshotHash: `plc-${shortHash(stableStringify(trainerCombatants))}`
  };
}
