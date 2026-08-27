import { calculatorFieldName } from "../rulesets/battle_rules.js?v=20260827-ability-state-events";
import { isHiddenPowerType } from "../core/hidden_power.js";

export function calculatorMoveName(move) {
  const type = String(move?.type || "").toLowerCase();
  if (move?.id === "hiddenpower" && isHiddenPowerType(type)) {
    return `Hidden Power ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
  }
  return move?.calcName || move?.name || move?.id;
}

function sideSource(combatant) {
  if (combatant.side !== "enemy") return {};
  return {
    trainerId: combatant.source?.consumerTrainerId ?? combatant.source?.trainerId,
    trainerVariantId: combatant.source?.trainerVariantId,
    slot: Math.max(0, Number(combatant.source?.trainerSlot || 1) - 1)
  };
}

function displayCombatant(combatant, state) {
  const hp = state.hp?.min === state.hp?.max ? state.hp.min : state.hp?.max;
  const roostTypes = state.volatileConditions?.roost
    ? state.currentTypeIds.filter(type => String(type).toLowerCase() !== "flying")
    : state.currentTypeIds;
  return {
    species: state.currentSpeciesId || combatant.formId || combatant.speciesId,
    level: Number(state.currentLevel ?? combatant.level),
    ability: state.currentAbilityId || "",
    abilityOn: Boolean(state.volatileConditions?.flashFire),
    item: Number(state.volatileConditions?.embargoTurns || 0) > 0 ? "" : state.currentItemId || "",
    nature: combatant.natureId,
    gender: combatant.gender || undefined,
    ivs: combatant.ivs,
    evs: combatant.evs,
    moves: (state.moveSetOverride || combatant.moves).map(move => move.moveId),
    status: state.majorStatus || undefined,
    toxicCounter: Number(state.toxicCounter || 0),
    currentHP: hp,
    boosts: state.statStages,
    typeOverrides: roostTypes.length ? roostTypes : ["normal"],
    statOverrides: state.calculatedStatOverrides
  };
}

export function createSharedDamageAdapter(runtime) {
  if (!runtime?.ready || typeof runtime.calculate !== "function") {
    throw new Error(runtime?.reason || "The shared damage calculator is unavailable");
  }
  return {
    supportsCriticalHits: true,
    calculate({ attacker, defender, attackerState, defenderState, move, fieldState, moveOverrides, moveHits, criticalHit, battleFormat = "singles", spreadTargetCount = null }) {
      let weather;
      let terrain;
      try {
        weather = calculatorFieldName("weather", fieldState?.global?.weather);
        terrain = calculatorFieldName("terrain", fieldState?.global?.terrain);
      } catch (error) {
        return { status: "unavailable", reason: error.message };
      }
      const attackerSource = sideSource(attacker);
      const defenderSource = sideSource(defender);
      const effectiveMoveName = calculatorMoveName(move);
      return runtime.calculate({
        attacker: displayCombatant(attacker, attackerState),
        defender: displayCombatant(defender, defenderState),
        moveName: effectiveMoveName,
        moveCandidates: [effectiveMoveName, move.name, move.id],
        moveOverrides,
        moveHits,
        criticalHit,
        attackerSide: attacker.side,
        defenderSide: defender.side,
        attackerTrainerId: attackerSource.trainerId,
        attackerTrainerVariantId: attackerSource.trainerVariantId,
        attackerSlot: attackerSource.slot,
        defenderTrainerId: defenderSource.trainerId,
        defenderTrainerVariantId: defenderSource.trainerVariantId,
        defenderSlot: defenderSource.slot,
        battleFormat: ["doubles", "triples"].includes(String(battleFormat).toLowerCase()) && Number(spreadTargetCount) !== 1 ? "double" : "single",
        isGravity: Number(fieldState?.global?.gravityTurns || 0) > 0,
        isMagicRoom: Number(fieldState?.global?.magicRoomTurns || 0) > 0,
        isWonderRoom: Number(fieldState?.global?.wonderRoomTurns || 0) > 0,
        attackerFieldState: fieldState?.sides?.[attacker.side],
        defenderFieldState: fieldState?.sides?.[defender.side],
        attackerState,
        defenderState,
        weather,
        terrain
      });
    }
  };
}
