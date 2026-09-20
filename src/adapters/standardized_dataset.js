import { canonicalStats, shortHash, stableStringify, toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { installTrainerEncounters, encounterNavigation } from './trainer_encounters.js?v=20260917-partners-release-v1';
import { readDatasetJsonFiles } from "./hosted_dataset.js?v=20260920-held-item-release-v3";
import { starterNavigationInputs, validateStarterSelection } from './starter_selection.js?v=20260918-starter-selection-v1';

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
  "trainer_battle_groups.json",
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

export function battleMechanicsSourceReady(mechanics, gameId = null) {
  if (!mechanics || mechanics.schemaVersion !== 1 || mechanics.kind !== "battle-mechanics") return false;
  if (gameId && mechanics.gameId !== gameId) return false;
  if (mechanics.validation?.status === "passed" && Number(mechanics.validation?.unresolved || 0) === 0) return true;
  return String(mechanics.sourceReadiness?.status || "").startsWith("passed")
    && Number(mechanics.sourceReadiness?.unresolved || 0) === 0
    && Number(mechanics.gateOwnership?.dataset?.unresolved || 0) === 0
    && mechanics.gateOwnership?.consumer?.sourceOmission !== true;
}

export function experienceProjectionReady(experienceMechanics, gameId = null) {
  if (!experienceMechanics || ![1, 2].includes(Number(experienceMechanics.schemaVersion))) return false;
  if (gameId && experienceMechanics.gameId !== gameId) return false;
  return experienceMechanics.validation?.status === "passed"
    && Number(experienceMechanics.validation?.unresolved || 0) === 0
    && experienceMechanics.consumerActivation?.experienceProjectionReady === true;
}

function requireDocument(documents, file, gameId, { records = true, schemaVersions = [1] } = {}) {
  const document = documents[file];
  if (!document || !schemaVersions.includes(Number(document.schemaVersion)) || document.gameId !== gameId || (records && !document.records)) {
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
  const progressionRecords = Array.isArray(progressionDocument?.records)
    ? progressionDocument.records
    : Object.values(progressionDocument?.records || {});
  const progressionById = new Map(progressionRecords
    .filter(record => record?.id)
    .map(record => [String(record.id), record]));
  const declaredSplits = Array.isArray(progressionDocument?.consumerProfile?.splits)
    ? progressionDocument.consumerProfile.splits
    : Array.isArray(progressionDocument?.consumerProfile?.milestones)
      ? progressionDocument.consumerProfile.milestones
      : [];
  const splits = declaredSplits.length
    ? [...declaredSplits].sort((a, b) => Number(a.firstOrder ?? a.order) - Number(b.firstOrder ?? b.order))
    : [...new Set(orderRecords.map(entry => String(entry.splitId || "full-game")))].map(splitId => {
      const entries = orderRecords.filter(entry => String(entry.splitId || "full-game") === splitId);
      const progression = progressionById.get(splitId);
      return {
        id: splitId,
        label: splitId === "full-game" ? "Full Game" : progression?.name || progression?.label || splitId,
        levelCap: progression?.levelCap ?? null,
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
      .flatMap(entry => (Array.isArray(entry.participantTrainerIds) && entry.participantTrainerIds.length
        ? entry.participantTrainerIds
        : [entry.trainerId]
      ).map(trainerId => trainerIndex.get(String(trainerId))))
      .filter(Boolean);
    for (const trainer of trainers) seen.add(String(trainer.id));
    const label = String(split.label || split.id);
    return {
      id: String(split.id),
      label: split.id === "full-game" || label.toLowerCase() === "full game"
        ? "Full Game"
        : /\s+split$/i.test(label) ? label : `${label} Split`,
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

function uniqueTrainers(trainers = []) {
  const seen = new Set();
  return trainers.filter(trainer => {
    const id = String(trainer?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
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

export function canonicalSpeciesDisplayName(dataset, member, fallback = "Pokémon") {
  const speciesId = member?.speciesId || member?.species || member?.displaySpecies;
  return dataset?.get("species", speciesId)?.name
    || member?.displaySpecies
    || String(speciesId || fallback);
}

export function createDatasetContext({ manifest, mechanics, documents }) {
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.gameId) {
    throw new DatasetReadinessError("The standardized dataset manifest is missing or unsupported");
  }
  const gameId = manifest.gameId;
  if (!mechanics || mechanics.schemaVersion !== 1 || mechanics.gameId !== gameId) {
    throw new DatasetReadinessError("The battle mechanics contract does not match the manifest");
  }
  if (!battleMechanicsSourceReady(mechanics, gameId)) {
    throw new DatasetReadinessError("The battle mechanics source contract has not passed validation");
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
  loaded['trainer_battle_groups.json'] = documents['trainer_battle_groups.json'] || { schemaVersion: 1, gameId, records: {} };
  loaded["progression.json"] = requireDocument(documents, "progression.json", gameId, { records: false });
  loaded["experience_mechanics.json"] = requireDocument(documents, "experience_mechanics.json", gameId, { records: false, schemaVersions: [1, 2] });
  loaded["evolutions.json"] = requireDocument(documents, "evolutions.json", gameId, { schemaVersions: [1, 2] });
  loaded["save_id_maps.json"] = requireDocument(documents, "save_id_maps.json", gameId);
  const experienceMechanics = loaded["experience_mechanics.json"];
  const experienceGeneration = experienceMechanics.experienceGeneration;
  if (!(experienceGeneration === "custom" || (Number.isInteger(Number(experienceGeneration)) && Number(experienceGeneration) >= 1 && Number(experienceGeneration) <= 9))) {
    throw new DatasetReadinessError("The experience mechanics contract has no supported formula generation");
  }
  if (experienceMechanics.validation?.status !== "passed" || Number(experienceMechanics.validation?.unresolved) !== 0) {
    throw new DatasetReadinessError("The experience mechanics source contract has not passed validation");
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

  const encounters = installTrainerEncounters(indexes.trainers, loaded['trainer_battle_groups.json'], mechanics.trainerBattleProfile);

  const context = {
    gameId,
    displayName: manifest.displayName || gameId,
    manifest,
    mechanics,
    experienceMechanics,
    capabilities: Object.freeze({
      battleSourceReady: true,
      calculationReady: mechanics.consumerActivation?.calculationReady === true,
      consumerGates: Object.freeze([...(mechanics.gateOwnership?.consumer?.records || [])]),
      experienceProjectionReady: experienceProjectionReady(experienceMechanics, gameId)
    }),
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
    trainerBattleChoices(trainerId) {
      const trainer = this.trainer(trainerId);
      if (!trainer) return [];
      if (trainer.encounter) return [{
        id: `multi:${trainer.id}`,
        trainerId: trainer.id,
        format: 'doubles',
        battleKind: 'multi',
        label: 'Multi',
        locked: true
      }];
      const paired = encounters.byMember.get(trainer.id);
      if (paired?.encounter.formatChoice === 'single-or-double') {
        const defaultPartnerTrainerId = paired.encounter.enemyTrainerIds.find(id => String(id) !== String(trainer.id)) || null;
        const binding = paired.playerPartnerBinding;
        return [
          { id: `singles:${trainer.id}`, trainerId: trainer.id, format: 'singles', battleKind: 'single', label: 'Singles', withoutPlayerPartner: true },
          { id: `doubles:${trainer.id}`, trainerId: trainer.id, format: 'doubles', battleKind: 'double', label: 'Doubles', withoutPlayerPartner: true },
          ...(binding ? [{ id: `allied:${paired.id}`, trainerId: paired.id, format: 'doubles', battleKind: 'multi', label: `Multi · with ${binding.partnerOptions[0].label.split(' · ')[0]}` }] : []),
          ...(binding?.allowWithoutPartner ? [{ id: `unallied:${paired.id}`, trainerId: paired.id, format: 'doubles', battleKind: 'multi', label: 'Multi · without escort', withoutPlayerPartner: true }] : []),
          { id: `multi:${trainer.id}`, trainerId: trainer.id, format: 'doubles', battleKind: 'multi', label: binding ? 'Custom Multi' : 'Multi', requiresPartner: true, defaultPartnerTrainerId, withoutPlayerPartner: true }
        ];
      }
      if (paired?.encounter.formatChoice === 'double-only') return [
        { id: `multi:${paired.id}`, trainerId: paired.id, format: 'doubles', battleKind: 'multi', label: 'Multi', locked: true }
      ];
      const escort = trainer.playerPartnerBinding;
      if (escort?.formatChoice === 'single-or-double') return [
        { id: `singles:${trainer.id}`, trainerId: trainer.id, format: 'singles', battleKind: 'single', label: 'Singles', withoutPlayerPartner: true },
        { id: `doubles:${trainer.id}`, trainerId: trainer.id, format: 'doubles', battleKind: 'double', label: 'Doubles', withoutPlayerPartner: true },
        { id: `allied:${trainer.id}`, trainerId: trainer.id, format: 'doubles', battleKind: 'multi', label: `Multi · with ${escort.partnerOptions[0].label.split(' · ')[0]}` },
        { id: `multi:${trainer.id}`, trainerId: trainer.id, format: 'doubles', battleKind: 'multi', label: 'Custom Multi', requiresPartner: true, withoutPlayerPartner: true }
      ];
      const format = this.trainerBattleFormat(trainer.id);
      if (format !== 'singles') return [{
        id: `${format}:${trainer.id}`,
        trainerId: trainer.id,
        format,
        battleKind: format === 'doubles' ? 'double' : format,
        label: format === 'rotation' ? 'Rotation' : format === 'triples' ? 'Triples' : 'Doubles',
        locked: true
      }];
      return [
        { id: `singles:${trainer.id}`, trainerId: trainer.id, format: 'singles', battleKind: 'single', label: 'Singles' },
        { id: `doubles:${trainer.id}`, trainerId: trainer.id, format: 'doubles', battleKind: 'double', label: 'Doubles' },
        { id: `multi:${trainer.id}`, trainerId: trainer.id, format: 'doubles', battleKind: 'multi', label: 'Multi', requiresPartner: true }
      ];
    },
    trainerPartnerGroups(trainerId, starterId = null) {
      const selectedId = String(trainerId || '');
      const navigation = starterNavigationInputs(indexes.trainers, loaded['trainer_order.json'], context.starterSelection, starterId);
      const sourceGroups = trainerNavigationGroups(navigation.trainers, navigation.order, loaded["progression.json"]);
      const selectedGroupId = sourceGroups.find(group => group.trainers.some(trainer => String(trainer.id) === selectedId))?.id;
      const groups = sourceGroups
        .map(group => ({
          ...group,
          trainers: uniqueTrainers(group.trainers).filter(trainer => String(trainer.id) !== selectedId && !encounters.syntheticIds.has(trainer.id) && !encounters.allyIds.has(trainer.id))
        }))
        .filter(group => group.trainers.length || String(group.id) === String(selectedGroupId));
      const selectedGroupIndex = groups.findIndex(group => String(group.id) === String(selectedGroupId));
      if (selectedGroupIndex <= 0) return groups;
      return [groups[selectedGroupIndex], ...groups.slice(0, selectedGroupIndex), ...groups.slice(selectedGroupIndex + 1)];
    },
    trainerGroups(starterId = null) {
      const navigation = starterNavigationInputs(indexes.trainers, loaded['trainer_order.json'], context.starterSelection, starterId);
      const groups = trainerNavigationGroups(navigation.trainers, navigation.order, loaded["progression.json"]);
      return encounterNavigation(groups, encounters);
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
  context.starterSelection = documents['starter_selection.json']
    ? validateStarterSelection(documents['starter_selection.json'], gameId, indexes.trainers, indexes.species)
    : null;
  return context;
}

export async function loadStandardizedDataset({ baseUrl, hostedPrefix = null, hostedRelease, fetchImpl = fetch, cacheStorage = globalThis.caches }) {
  const paths = ["dataset_manifest.json", "battle_mechanics.json", ...REQUIRED_DATASET_SOURCES, "starter_selection.json"];
  let loaded;
  if (hostedPrefix) {
    loaded = await readDatasetJsonFiles({
      fallbackBaseUrl: baseUrl,
      hostedPrefix,
      paths,
      release: hostedRelease,
      fetchImpl,
      cacheStorage
    });
  } else {
    const root = String(baseUrl || "").replace(/\/$/u, "");
    const entries = await Promise.all(paths.map(async file => {
      const response = await fetchImpl(`${root}/${file}`);
      if (!response.ok) throw new DatasetReadinessError(`${file} returned HTTP ${response.status}`);
      return [file, await response.json()];
    }));
    loaded = { documents: Object.fromEntries(entries), delivery: Object.freeze({ mode: "direct" }) };
  }
  const { "dataset_manifest.json": manifest, "battle_mechanics.json": mechanics, ...documents } = loaded.documents;
  const context = createDatasetContext({ manifest, mechanics, documents });
  context.delivery = loaded.delivery;
  return context;
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
