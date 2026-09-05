import { canonicalStats, shortHash, stableStringify, toId } from "../core/primitives.js";

export const BATTLE_DATASET_SOURCES = Object.freeze([
  "species.json",
  "moves.json",
  "abilities.json",
  "items.json",
  "natures.json",
  "types.json",
  "trainers.json"
]);

export const TRAINER_NAVIGATION_SOURCES = Object.freeze([
  "trainer_order.json",
  "progression.json"
]);

export const SAVE_IDENTITY_SOURCES = Object.freeze([
  "save_id_maps.json"
]);

export const EXPERIENCE_SOURCES = Object.freeze([
  "experience_mechanics.json",
  "evolutions.json"
]);

export const REQUIRED_DATASET_SOURCES = Object.freeze([
  ...BATTLE_DATASET_SOURCES,
  ...TRAINER_NAVIGATION_SOURCES,
  ...EXPERIENCE_SOURCES,
  ...SAVE_IDENTITY_SOURCES
]);

export class DatasetReadinessError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatasetReadinessError";
  }
}

function requireDocument(documents, file, gameId, { records = true } = {}) {
  const document = documents[file];
  if (!document || document.schemaVersion !== 1 || document.gameId !== gameId || (records && !document.records)) {
    throw new DatasetReadinessError(`${file} is missing or does not match ${gameId}`);
  }
  return document;
}

function asMap(document) {
  return new Map(Object.entries(document.records || {}).map(([key, value]) => [String(key), value]));
}

function resolveTrainerVariant(trainer, trainerVariantId) {
  const variants = Array.isArray(trainer.mechanicsVariants) ? trainer.mechanicsVariants : [];
  if (!variants.length) return null;
  if (trainerVariantId === null || trainerVariantId === undefined || trainerVariantId === "") {
    throw new DatasetReadinessError(`${trainer.displayName || trainer.id} requires an exact ROM trainer variant`);
  }
  const variant = variants.find(entry =>
    String(entry.id) === String(trainerVariantId)
    || String(entry.finalRomTrainerId) === String(trainerVariantId)
  );
  if (!variant) throw new DatasetReadinessError(`Trainer variant ${trainerVariantId} is unavailable`);
  return variant;
}

function trainerNavigationGroups(trainerIndex, orderDocument, progressionDocument) {
  const orderRecords = Array.isArray(orderDocument?.records)
    ? [...orderDocument.records].sort((a, b) => Number(a.order) - Number(b.order))
    : [];
  if (!orderRecords.length) throw new DatasetReadinessError("Trainer order is unavailable");
  const declaredSplits = Array.isArray(progressionDocument?.consumerProfile?.splits)
    ? progressionDocument.consumerProfile.splits
    : Array.isArray(progressionDocument?.consumerProfile?.milestones)
      ? progressionDocument.consumerProfile.milestones
      : [];
  const splits = declaredSplits.length
    ? [...declaredSplits].sort((a, b) => Number(a.firstOrder ?? a.order) - Number(b.firstOrder ?? b.order))
    : [...new Set(orderRecords.map(entry => String(entry.splitId || "full-game")))].map(splitId => {
      const entries = orderRecords.filter(entry => String(entry.splitId || "full-game") === splitId);
      return {
        id: splitId,
        label: splitId === "full-game" ? "Full Game" : splitId,
        levelCap: null,
        firstOrder: Number(entries[0]?.order),
        lastOrder: Number(entries.at(-1)?.order)
      };
    });

  const seen = new Set();
  const groups = splits.map(split => {
    const trainers = orderRecords
      .filter(entry => String(entry.splitId || "full-game") === String(split.id) || (
        !entry.splitId
        && Number(entry.order) >= Number(split.firstOrder)
        && Number(entry.order) <= Number(split.lastOrder)
      ))
      .map(entry => trainerIndex.get(String(entry.trainerId)))
      .filter(Boolean);
    for (const trainer of trainers) seen.add(String(trainer.id));
    return {
      id: String(split.id),
      label: split.id === "full-game" || String(split.label).toLowerCase() === "full game"
        ? "Full Game"
        : `${split.label || split.id} Split`,
      levelCap: split.levelCap !== null && split.levelCap !== undefined && split.levelCap !== "" && Number.isFinite(Number(split.levelCap))
        ? Number(split.levelCap)
        : null,
      firstOrder: Number(split.firstOrder),
      lastOrder: Number(split.lastOrder),
      trainers
    };
  }).filter(group => group.trainers.length);

  const ungrouped = [...trainerIndex.values()]
    .filter(trainer => !seen.has(String(trainer.id)))
    .sort((a, b) => String(a.displayName || a.name || a.id).localeCompare(String(b.displayName || b.name || b.id)));
  if (ungrouped.length) groups.push({ id: "other", label: "Other Battles", levelCap: null, firstOrder: null, lastOrder: null, trainers: ungrouped });
  return groups;
}

export function trainerBattleFormat(trainer, mechanics) {
  const profileId = mechanics?.trainerBattleProfile;
  const raw = profileId ? trainer?.battleProfiles?.[profileId]?.format : null;
  const format = String(raw || "single").toLowerCase();
  if (format === "single" || format === "singles") return "singles";
  if (format === "double" || format === "doubles") return "doubles";
  if (format === "triple" || format === "triples") return "triples";
  if (format === "rotation" || format === "rotations") return "rotation";
  throw new DatasetReadinessError(`${trainer?.displayName || trainer?.id || "Trainer"} uses unsupported ${format || "unknown"} battle format`);
}

export function mergeTrainerTeam(trainer, trainerVariantId = null) {
  const variant = resolveTrainerVariant(trainer, trainerVariantId);
  if (!variant) return (trainer.team || []).map(member => ({ ...member }));
  return (trainer.team || []).map((member, index) => {
    const selected = variant.team?.find(entry => Number(entry.slot) === Number(member.slot)) || variant.team?.[index];
    return selected ? { ...member, ...selected } : { ...member };
  });
}

export function createDatasetContext({ manifest, mechanics, documents }) {
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.gameId) {
    throw new DatasetReadinessError("The standardized dataset manifest is missing or unsupported");
  }
  const gameId = manifest.gameId;
  if (!mechanics || mechanics.schemaVersion !== 1 || mechanics.gameId !== gameId) {
    throw new DatasetReadinessError("The battle mechanics contract does not match the manifest");
  }
  if (mechanics.validation?.status !== "passed" || Number(mechanics.validation?.unresolved) !== 0) {
    throw new DatasetReadinessError("The battle mechanics contract has not passed validation");
  }
  if (mechanics.experienceMechanicsSource !== "experience_mechanics.json") {
    throw new DatasetReadinessError("The battle mechanics contract does not link the independent experience mechanics contract");
  }
  const missingCoverage = BATTLE_DATASET_SOURCES.filter(file =>
    !(mechanics.validation?.sourceFiles || []).includes(file)
  );
  if (missingCoverage.length) {
    throw new DatasetReadinessError(`Battle mechanics coverage is missing ${missingCoverage.join(", ")}`);
  }

  const loaded = Object.fromEntries(BATTLE_DATASET_SOURCES.map(file => [file, requireDocument(documents, file, gameId)]));
  loaded["trainer_order.json"] = requireDocument(documents, "trainer_order.json", gameId);
  loaded["progression.json"] = requireDocument(documents, "progression.json", gameId, { records: false });
  loaded["experience_mechanics.json"] = requireDocument(documents, "experience_mechanics.json", gameId, { records: false });
  loaded["evolutions.json"] = requireDocument(documents, "evolutions.json", gameId);
  loaded["save_id_maps.json"] = requireDocument(documents, "save_id_maps.json", gameId);
  const experienceMechanics = loaded["experience_mechanics.json"];
  const experienceGeneration = experienceMechanics.experienceGeneration;
  if (!(experienceGeneration === "custom" || (Number.isInteger(Number(experienceGeneration)) && Number(experienceGeneration) >= 1 && Number(experienceGeneration) <= 9))) {
    throw new DatasetReadinessError("The experience mechanics contract has no supported formula generation");
  }
  if (experienceMechanics.validation?.status !== "passed" || Number(experienceMechanics.validation?.unresolved) !== 0
    || experienceMechanics.consumerActivation?.experienceProjectionReady !== true) {
    throw new DatasetReadinessError("The experience mechanics contract has not passed projection readiness");
  }
  const indexes = {
    species: asMap(loaded["species.json"]),
    moves: asMap(loaded["moves.json"]),
    abilities: asMap(loaded["abilities.json"]),
    items: asMap(loaded["items.json"]),
    natures: asMap(loaded["natures.json"]),
    types: asMap(loaded["types.json"]),
    trainers: asMap(loaded["trainers.json"])
  };
  indexes.evolutions = asMap(loaded["evolutions.json"]);

  const context = {
    gameId,
    displayName: manifest.displayName || gameId,
    manifest,
    mechanics,
    experienceMechanics,
    documents: loaded,
    indexes,
    get(kind, id) {
      return indexes[kind]?.get(String(id)) || indexes[kind]?.get(toId(id)) || null;
    },
    getBySaveNumericId(kind, numericId) {
      const canonicalId = loaded["save_id_maps.json"].records?.[kind]?.byNumericId?.[String(numericId)];
      return canonicalId ? this.get(kind, canonicalId) : null;
    },
    trainer(trainerId) {
      const direct = indexes.trainers.get(String(trainerId));
      if (direct) return direct;
      return [...indexes.trainers.values()].find(entry =>
        String(entry.consumerTrainerId) === String(trainerId)
        || String(entry.finalRomTrainerId) === String(trainerId)
        || (entry.finalRomTrainerIds || []).map(String).includes(String(trainerId))
      ) || null;
    },
    trainerTeam(trainerId, trainerVariantId = null) {
      const trainer = this.trainer(trainerId);
      if (!trainer) throw new DatasetReadinessError(`Trainer ${trainerId} is unavailable`);
      return mergeTrainerTeam(trainer, trainerVariantId);
    },
    trainerBattleFormat(trainerId) {
      const trainer = this.trainer(trainerId);
      if (!trainer) throw new DatasetReadinessError(`Trainer ${trainerId} is unavailable`);
      return trainerBattleFormat(trainer, mechanics);
    },
    trainerGroups() {
      return trainerNavigationGroups(indexes.trainers, loaded["trainer_order.json"], loaded["progression.json"]);
    },
    fingerprint: {
      engineId: mechanics.engine?.id || "unknown",
      engineVersion: mechanics.engine?.version || "unknown",
      damageGeneration: Number(mechanics.damageGeneration),
      canonicalDataGeneration: Number(mechanics.canonicalDataGeneration),
      mechanicsProfile: mechanics.mechanicsProfile || "unknown",
      experienceMechanicsProfile: experienceMechanics.mechanicsProfile || "unknown",
      datasetManifestHash: `plc-${shortHash(stableStringify(manifest))}`,
      battleMechanicsHash: `plc-${shortHash(stableStringify(mechanics))}`,
      experienceMechanicsHash: `plc-${shortHash(stableStringify(experienceMechanics))}`
    }
  };
  return context;
}

export async function loadStandardizedDataset({ baseUrl, fetchImpl = fetch }) {
  const root = String(baseUrl || "").replace(/\/$/, "");
  const read = async file => {
    const response = await fetchImpl(`${root}/${file}`, { cache: "no-store" });
    if (!response.ok) throw new DatasetReadinessError(`${file} returned HTTP ${response.status}`);
    return response.json();
  };
  const manifest = await read("dataset_manifest.json");
  const mechanics = await read("battle_mechanics.json");
  const documents = Object.fromEntries(await Promise.all(
    REQUIRED_DATASET_SOURCES.map(async file => [file, await read(file)])
  ));
  return createDatasetContext({ manifest, mechanics, documents });
}

export function canonicalTrainerMember(member, fallbackEvs = 0) {
  return {
    ...member,
    gender: ({ m: "M", male: "M", f: "F", female: "F", n: "N", genderless: "N" })[toId(member.gender)] ?? null,
    speciesId: toId(member.speciesId || member.species || member.displaySpecies),
    natureId: member.natureId ? toId(member.natureId) : null,
    abilityId: member.abilityId ? toId(member.abilityId) : null,
    itemId: member.itemId ? toId(member.itemId) : null,
    ivs: canonicalStats(member.ivs, NaN),
    evs: canonicalStats(member.evs, fallbackEvs),
    moveIds: (member.moveIds || member.moves || []).map(move => toId(move.id || move.moveId || move))
  };
}
