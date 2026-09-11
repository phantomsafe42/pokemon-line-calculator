import { asBytes } from "../../../../core/src/binary/little-endian.js";
import { createSaveSnapshot } from "../../../../core/src/contracts/save-snapshot.js";
import { decodeGen3PokemonRecord } from "../../../../core/src/gba/pokemon.js";
import { decodeGen3Text } from "../../../../core/src/gba/text.js";
import { locateGbaPokemonRecords } from "../../../../core/src/gba/layouts/index.js";
import { readGbaPlayerTrainerIdentity } from "../../../../core/src/gba/player-trainer-identity.js";
import { levelFromExperience } from "../../interpretation/experience.js";

function requireContext(context) {
  for (const method of ["resolveSpecies", "resolveMove", "resolveItem", "resolveNature", "resolveAbility"]) {
    if (typeof context?.[method] !== "function") throw new Error(`GBA standardized Dataset context is missing ${method}`);
  }
}

function genderFromPersonality(personalityValue, species) {
  const threshold = Number(species?.genderThresholdRaw);
  if (!Number.isFinite(threshold)) return undefined;
  if (threshold === 255) return "N";
  if (threshold === 254) return "F";
  if (threshold === 0) return "M";
  return (personalityValue & 0xff) < threshold ? "F" : "M";
}

function shinyFromIds(originalTrainerNumericId, personalityValue) {
  return (((originalTrainerNumericId & 0xffff) ^ (originalTrainerNumericId >>> 16)
    ^ (personalityValue & 0xffff) ^ (personalityValue >>> 16)) & 0xffff) < 8;
}

function parseRecord(record, config, context, options) {
  const decoded = (options.decodeRecord || decodeGen3PokemonRecord)(record.bytes);
  if (!decoded.speciesNumericId) return undefined;
  if (options.rejectInvalidPokemonChecksums && !decoded.checksumValid) {
    throw new Error(`${config.gameId} ${record.storage} Pokémon at ${record.box ?? 0}:${record.slot} has an invalid checksum`);
  }
  const species = context.resolveSpecies(decoded.speciesNumericId);
  if (!species?.id || !species?.name) {
    throw new Error(`${config.gameId} has an unmapped species ID ${decoded.speciesNumericId}`);
  }
  const item = decoded.heldItemNumericId ? context.resolveItem(decoded.heldItemNumericId) : undefined;
  const natureNumericId = decoded.personalityValue % 25;
  const nature = context.resolveNature(natureNumericId);
  const abilitySlot = Number(decoded.abilitySlot ?? decoded.abilityBit ?? 0);
  const ability = context.resolveAbility({
    species,
    speciesNumericId: decoded.speciesNumericId,
    abilitySlot,
    abilityBit: abilitySlot,
  });
  const experience = Number(decoded.experience ?? decoded.experienceRaw);
  const level = decoded.partyLevel && decoded.partyLevel >= 1 && decoded.partyLevel <= 100
    ? decoded.partyLevel
    : typeof context.levelFromExperience === "function"
      ? context.levelFromExperience({ species, speciesNumericId: decoded.speciesNumericId, experience })
      : levelFromExperience(experience, species.growthRate);
  const moves = decoded.moveNumericIds.map((numericId, index) => {
    const move = numericId ? context.resolveMove(numericId) : undefined;
    const slot = { slot: index + 1, numericId, currentPp: decoded.movePp[index] };
    if (move?.id) slot.id = move.id;
    if (move?.name) slot.name = move.calcName || move.name;
    return slot;
  });
  const pokemon = {
    storage: record.storage,
    slot: record.slot,
    personalityValue: decoded.personalityValue,
    originalTrainerNumericId: decoded.originalTrainerNumericId,
    speciesNumericId: decoded.speciesNumericId,
    speciesId: species.id,
    speciesName: species.name,
    nickname: decoded.nickname ?? decodeGen3Text(record.bytes.subarray(0x08, 0x12), { stopBytes: [0x00, 0xff], trim: "both" }),
    experience,
    level,
    friendship: decoded.friendship,
    abilitySlot,
    natureNumericId,
    isEgg: decoded.isEgg,
    isShiny: shinyFromIds(decoded.originalTrainerNumericId, decoded.personalityValue),
    heldItemNumericId: decoded.heldItemNumericId,
    moveNumericIds: decoded.moveNumericIds.slice(),
    movePp: decoded.movePp.slice(),
    movePpUps: decoded.ppUps?.slice() || [decoded.packedPpUps & 3, (decoded.packedPpUps >>> 2) & 3, (decoded.packedPpUps >>> 4) & 3, (decoded.packedPpUps >>> 6) & 3],
    moves,
    ivs: { ...decoded.ivs },
    evs: { ...decoded.evs },
    checksumValid: decoded.checksumValid,
  };
  if (decoded.experienceUpperBits !== undefined) pokemon.experienceUpperBits = Number(decoded.experienceUpperBits) >>> 0;
  if (decoded.ballNumericId !== undefined) pokemon.ballNumericId = Number(decoded.ballNumericId);
  if (decoded.movePpHighBits) pokemon.movePpHighBits = decoded.movePpHighBits.slice();
  if (decoded.contest) pokemon.contest = decoded.contest.slice();
  if (decoded.sheen !== undefined) pokemon.sheen = Number(decoded.sheen);
  pokemon.displayName = pokemon.nickname || pokemon.speciesName;
  if (record.storage === "box") pokemon.box = record.box;
  const gender = genderFromPersonality(decoded.personalityValue, species);
  if (gender) pokemon.gender = gender;
  if (item?.id) pokemon.heldItemId = item.id;
  if (item?.name) pokemon.heldItemName = item.calcName || item.name;
  if (nature?.id) pokemon.natureId = nature.id;
  if (nature?.name) pokemon.natureName = nature.name;
  if (ability?.id) pokemon.abilityId = ability.id;
  if (ability?.name) pokemon.abilityName = ability.calcName || ability.name;
  return pokemon;
}

export function parseStandardGbaSave(value, config, {
  context,
  sourceName = "Selected save",
  observedAt,
  rejectInvalidPokemonChecksums = false,
  requireReadableParty = false,
  decodeRecord,
} = {}) {
  requireContext(context);
  const bytes = asBytes(value, { label: `${config.gameId} save` });
  const located = locateGbaPokemonRecords(bytes, config.formatId, { requireReadableParty });
  const parse = record => parseRecord(record, config, context, { rejectInvalidPokemonChecksums, decodeRecord });
  return createSaveSnapshot({
    gameId: config.gameId,
    platformId: "gba",
    generation: 3,
    formatId: config.formatId,
    source: { name: String(sourceName).slice(0, 240), bytes: bytes.byteLength, containerFormat: "sav" },
    selection: located.selection,
    playerTrainerIdentity: readGbaPlayerTrainerIdentity(located.saveBlock2),
    storage: { boxCount: located.boxes.length / 30, slotsPerBox: 30 },
    party: located.party.map(parse).filter(Boolean),
    boxes: located.boxes.map(parse).filter(Boolean),
    diagnostics: [],
    observedAt,
  });
}
