import { calculateStats, normalizePlayerCollection, normalizeTrainerRoster, snapshotFingerprint } from "./adapters/combatant_ingest.js?v=20260912-vanilla-display-names-v1";
import { setPokemonAssetImage } from "./adapters/pokemon_assets.js?v=20260909-public-release-v2";
import { canonicalSpeciesDisplayName, loadStandardizedDataset } from "./adapters/standardized_dataset.js?v=20260912-vanilla-display-names-v1";
import { loadTrainerAiDocumentation } from "./adapters/trainer_ai.js?v=20260911-ability-storage-reimp-v1";
import { createDraftRecord, destructiveTransitionNotice, IndexedDbDraftStore, markExported, updateDraftRecord } from "./cache/active_draft.js?v=20260909-public-release-v2";
import { TrainerAiForecastCache } from "./cache/trainer_ai_forecast.js?v=20260909-public-release-v2";
import { SavedDraftStore, savedDraftSnapshot } from "./cache/saved_drafts.js?v=20260911-ability-storage-reimp-v1";
import { reorderCards } from "./ui/reorder_cards.js?v=20260909-public-release-v2";
import { addFreeCalcBranch, editFreeCalcCombatant, replaceFreeCalcSlot, freeCalcAsNewPlan } from './core/free_calc.js?v=20260911-ability-storage-reimp-v1';
import { eligibleReserves } from './core/party_ownership.js?v=20260909-public-release-v2';
import { downloadPlan, exportSelectedPlan, migratePlanDocument, parsePlan } from "./contracts/plan_file.js?v=20260911-ability-storage-reimp-v1";
import { assertValidPlanDocument } from "./contracts/plan_contract.js?v=20260911-ability-storage-reimp-v1";
import { mechanicsCompatibility, validatePlanReferences } from "./contracts/plan_compatibility.js?v=20260911-ability-storage-reimp-v1";
import { actionList, activeKey, activeKeys, activeSlotEntries, actorSlot, pendingReplacementSlots, setActiveKey, slotsPerSide } from "./core/battle_slots.js?v=20260909-public-release-v2";
import { createBranchEventModel, selectBranchEventOutcome, selectedBranchChoices } from "./core/branch_events.js?v=20260909-public-release-v2";
import { boundedSlotDamageLabel, highestDamageCandidateKeys, resolvedCombatantMovePreview } from "./core/combatant_moves.js?v=20260909-public-release-v2";
import { exportBranchGroups, planTreeOrder, planTurnTreeOrder, preferredImportedReviewStateId, stateLineage, turnNodeVisuals } from "./core/graph.js?v=20260911-ability-storage-reimp-v1";
import { HIDDEN_POWER_TYPES, hiddenPowerTypeFromIvs, resolvedHiddenPowerType } from "./core/hidden_power.js?v=20260909-public-release-v2";
import { forcedTurnAction } from "./core/forced_actions.js?v=20260909-public-release-v2";
import { formatDamageRollCounts, healingEventDescription, isCriticalOhkoOutcome, isHighRollKoOutcome, outcomePanelEvents, readableMechanicName } from "./core/outcome_presentation.js?v=20260909-public-release-v2";
import { createPlanDocument, planHasWork, setStateNodeNote, upgradeInitialEntryEffects } from "./core/plan.js?v=20260911-ability-storage-reimp-v1";
import { commitForcedReplacement, commitLabel, commitPreview, previewForcedReplacement, refreshUnknownCommittedProbabilities, repairStaleLeafBattleEnd, replacementCommitLabel } from "./core/planner.js?v=20260911-ability-storage-reimp-v1";
import { recalculatePlanDocument } from "./core/recalculation.js?v=20260911-ability-storage-reimp-v1";
import { upgradeImportedPlanForEditing } from "./core/import_upgrade.js?v=20260911-ability-storage-reimp-v1";
import { moveSupport } from "./rulesets/core_move_support.js?v=20260909-public-release-v2";
import { effectiveActionSpeed } from "./rulesets/action_order.js?v=20260909-public-release-v2";
import { areSlotsAdjacent, canSelectShift, shiftWithCenter, triplePositionForSlot, tripleSlotForPosition } from "./rulesets/triple_battle.js?v=20260909-public-release-v2";
import { rotationFrontKey, rotationFrontSlot } from "./rulesets/rotation_battle.js?v=20260909-public-release-v2";
import { experienceForLevel, experienceToNextLevel, projectExperience } from "./rulesets/vw2r_experience.js?v=20260909-public-release-v2";
import { ResolverWorkerClient } from "./worker/resolver_client.js?v=20260911-ability-storage-reimp-v1";
import { battleCompletionState } from "./core/battle_completion.js?v=20260909-public-release-v2";
import {
  addBox, addParty, boxesForGame, createEmptyBoxLibrary, exportBoxLibrary, IndexedDbBoxLibraryStore,
  mergeBoxLibrary, parseBoxLibrary, removeBox, removeParty, removePokemon, renameBox, updateParty, upsertPokemon
} from "./boxes/library.js?v=20260909-public-release-v2";
import { addImportedPlanParty, bindPlanPlayerPartyToImportedBox } from "./boxes/plan_import.js?v=20260909-public-release-v2";
import { applyBranchProgressionToLibrary, branchProgressionSnapshot } from "./boxes/progression.js?v=20260909-public-release-v2";
import { exportShowdown, parseShowdown } from "./boxes/showdown.js?v=20260909-public-release-v2";
import { parseSave, selectSavePokemon } from "./boxes/save_import.js?v=20260909-public-release-v2";

function vanillaGame(gameId, name, generation) {
  return Object.freeze({
    name,
    credit: "by Game Freak",
    expectedDamageGeneration: generation,
    activationReady: true,
    datasetBaseUrl: new URL(`./generated/datasets/${gameId}`, import.meta.url).href,
    trainerAiBaseUrl: null,
    capabilities: Object.freeze({ saveImport: false })
  });
}

const GAME_REGISTRY = Object.freeze({
  "fire-red-omega": {
    name: "Fire Red Omega",
    credit: "by Drayano",
    expectedDamageGeneration: 3,
    activationReady: true,
    datasetBaseUrl: new URL("./generated/datasets/fire-red-omega", import.meta.url).href,
    trainerAiBaseUrl: new URL("./generated/trainer-ai", import.meta.url).href,
    capabilities: Object.freeze({ saveImport: true })
  },
  "pokemon-unbound": {
    name: "Unbound",
    credit: "by Skeli",
    expectedDamageGeneration: 3,
    activationReady: true,
    datasetBaseUrl: new URL("./generated/datasets/pokemon-unbound", import.meta.url).href,
    trainerAiBaseUrl: new URL("./generated/trainer-ai", import.meta.url).href,
    capabilities: Object.freeze({ saveImport: true })
  },
  "platinum-kaizo": {
    name: "Platinum Kaizo",
    credit: "by SHF",
    expectedDamageGeneration: 4,
    activationReady: true,
    datasetBaseUrl: new URL("./generated/datasets/platinum-kaizo", import.meta.url).href,
    trainerAiBaseUrl: new URL("./generated/trainer-ai", import.meta.url).href,
    capabilities: Object.freeze({ saveImport: true })
  },
  "renegade-platinum": {
    name: "Renegade Platinum",
    credit: "by Drayano",
    expectedDamageGeneration: 4,
    activationReady: true,
    datasetBaseUrl: new URL("./generated/datasets/renegade-platinum", import.meta.url).href,
    trainerAiBaseUrl: new URL("./generated/trainer-ai", import.meta.url).href,
    capabilities: Object.freeze({ saveImport: true })
  },
  "storm-silver": {
    name: "Storm Silver",
    credit: "by Drayano",
    expectedDamageGeneration: 4,
    activationReady: true,
    datasetBaseUrl: new URL("./generated/datasets/storm-silver", import.meta.url).href,
    trainerAiBaseUrl: new URL("./generated/trainer-ai", import.meta.url).href,
    capabilities: Object.freeze({ saveImport: true })
  },
  "volt-white-2r": {
    name: "Volt White 2 Redux - Challenge Mode",
    credit: "by AphexCubed and Drayano",
    expectedDamageGeneration: 5,
    activationReady: true,
    datasetBaseUrl: new URL("./generated/datasets/volt-white-2r", import.meta.url).href,
    trainerAiBaseUrl: new URL("./generated/trainer-ai", import.meta.url).href,
    capabilities: Object.freeze({ saveImport: true })
  },
  "pokemon-ruby": vanillaGame("pokemon-ruby", "Ruby", 3),
  "pokemon-sapphire": vanillaGame("pokemon-sapphire", "Sapphire", 3),
  "pokemon-emerald": vanillaGame("pokemon-emerald", "Emerald", 3),
  "pokemon-firered": vanillaGame("pokemon-firered", "FireRed", 3),
  "pokemon-leafgreen": vanillaGame("pokemon-leafgreen", "LeafGreen", 3),
  "pokemon-diamond": vanillaGame("pokemon-diamond", "Diamond", 4),
  "pokemon-pearl": vanillaGame("pokemon-pearl", "Pearl", 4),
  "pokemon-platinum": vanillaGame("pokemon-platinum", "Platinum", 4),
  "pokemon-heartgold": vanillaGame("pokemon-heartgold", "HeartGold", 4),
  "pokemon-soulsilver": vanillaGame("pokemon-soulsilver", "SoulSilver", 4),
  "pokemon-black": vanillaGame("pokemon-black", "Black", 5),
  "pokemon-white": vanillaGame("pokemon-white", "White", 5),
  "pokemon-black-2": vanillaGame("pokemon-black-2", "Black 2", 5),
  "pokemon-white-2": vanillaGame("pokemon-white-2", "White 2", 5)
});
const pokemonAssetResolver = globalThis.PokemonAssets?.createResolver();
const SELECTED_GAME_KEY = "plc-selected-game-v1";
const STAT_KEYS = Object.freeze(["hp", "atk", "def", "spa", "spd", "spe"]);
const STAT_LABELS = Object.freeze({ hp: "HP", atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe" });
const STATUS_LABELS = Object.freeze({ brn: "Burn", par: "Paralysis", psn: "Poison", tox: "Badly Poisoned", slp: "Sleep", frz: "Freeze" });
const byId = id => document.getElementById(id);
const ui = Object.fromEntries([
  "game-select", "game-credit", "app-status", "game-gate", "app-tabs", "plc-tab", "boxes-tab", "plc-panel", "boxes-panel",
  "plan-toolbar-label", "commit-turn", "save-plan", "new-plan", "workspace", "empty-plan",
  "node-tree", "turn-label", "revision-label", "battle-workspace", "player-action-panel", "enemy-action-panel", "field-state",
  "readiness", "preview-outcomes", "ai-forecast-toggle", "ai-forecast-body", "ai-notes", "notes-toggle", "notes-body", "node-notes", "notes-status", "boxes-list", "save-import", "save-import-dialog", "save-import-filename",
  "save-import-party-summary", "save-import-pc-boxes", "save-import-status", "select-all-save-boxes", "clear-save-boxes",
  "confirm-save-import", "showdown-open", "new-box", "export-boxes", "import-boxes",
  "plan-context-dialog", "trainer-select", "battle-format", "battle-format-choice", "variant-field", "variant-select", "plan-name",
  "initial-weather", "initial-terrain", "context-box-select", "party-source-mode", "saved-party-field",
  "context-party-select", "context-pokemon-grid", "save-party-selection", "party-selector-controls",
  "enemy-team-summary", "party-selection-summary", "edit-party-selection", "edge-party-exp", "context-status", "begin-plan", "pokemon-editor-dialog",
  "pokemon-editor-form", "pokemon-editor-title", "editor-sprite-preview", "editor-box-id", "editor-pokemon-id", "editor-context", "editor-species",
  "editor-nickname", "editor-level", "editor-gender", "editor-nature", "editor-ability", "editor-item", "editor-hidden-power-type",
  "editor-hp-field", "editor-starting-hp", "editor-status-field", "editor-starting-status", "editor-stats",
  "editor-moves", "editor-error", "save-pokemon", "showdown-dialog", "showdown-text", "showdown-destination",
  "showdown-status", "copy-showdown", "import-showdown", "output-dialog", "export-selection", "select-all-export", "output-plan",
  "recalculate-plan", "import-plan", "file-status",
  "progression-dialog", "progression-summary", "destructive-dialog", "destructive-message", "destructive-output", "destructive-discard"
].map(id => [id, byId(id)]));

const draftStore = new IndexedDbDraftStore();
const savedDraftStore = new SavedDraftStore();
const boxStore = new IndexedDbBoxLibraryStore();
let selectedGameId = null;
let dataset = null;
let trainerAi = null;
let worker = null;
let boxLibrary = createEmptyBoxLibrary();
let plan = null;
let freeCalcSession = null;
let draftTreeObservers = [];
let draftRecord = null;
let cursorStateNodeId = null;
let currentPreview = null;
let branchEventModel = null;
let selectedPreviewOutcomeId = null;
let reviewOutcomeStateNodeId = null;
let needsRecalculation = false;
let previewGeneration = 0;
let damageGeneration = 0;
let exportSelection = new Set();
let activeTab = "plc";
let destructiveResolver = null;
let editorMoveRows = [];
let actionDraft = emptyActionDraft();
let notesPersistTimer = null;
let trainerAiAnalysisCache = new TrainerAiForecastCache();
let aiForecastExpanded = false;
let notesExpanded = false;
let contextSelection = emptyContextSelection();
let pendingSaveImport = null;
let progressionResolver = null;

function emptyActionDraft() {
  return { player: [{}, {}, {}], enemy: [{}, {}, {}] };
}

function emptyContextSelection() {
  return { boxId: null, partyId: null, pokemonIds: [], saved: false, initialConditions: {} };
}

function setStatus(message, error = false) {
  ui["app-status"].textContent = message;
  ui["app-status"].classList.toggle("error", error);
}

function renderGameCredit(gameId) {
  ui["game-credit"].textContent = GAME_REGISTRY[gameId]?.credit || "";
}

function option(value, label, { disabled = false } = {}) {
  const node = document.createElement("option");
  node.value = value ?? "";
  node.textContent = label;
  node.disabled = disabled;
  return node;
}

async function generatedGameIsReady(config) {
  if (config.activationReady !== true) return false;
  try {
    const root = String(config.datasetBaseUrl).replace(/\/$/, "");
    const [manifestResponse, mechanicsResponse, experienceResponse] = await Promise.all([
      fetch(`${root}/dataset_manifest.json`, { cache: "no-store" }),
      fetch(`${root}/battle_mechanics.json`, { cache: "no-store" }),
      fetch(`${root}/experience_mechanics.json`, { cache: "no-store" })
    ]);
    if (!manifestResponse.ok || !mechanicsResponse.ok || !experienceResponse.ok) return false;
    const [manifest, mechanics, experience] = await Promise.all([manifestResponse.json(), mechanicsResponse.json(), experienceResponse.json()]);
    const damageGeneration = Number(mechanics?.damageGeneration);
    return manifest?.gameId === mechanics?.gameId
      && Number.isInteger(damageGeneration)
      && damageGeneration >= 1
      && damageGeneration <= 9
      && (config.expectedDamageGeneration === undefined || damageGeneration === Number(config.expectedDamageGeneration))
      && mechanics?.validation?.status === "passed"
      && Number(mechanics?.validation?.unresolved) === 0
      && experience?.gameId === manifest?.gameId
      && experience?.validation?.status === "passed"
      && Number(experience?.validation?.unresolved) === 0
      && experience?.consumerActivation?.experienceProjectionReady === true;
  } catch {
    return false;
  }
}

async function populateGameOptions() {
  const availability = await Promise.all(Object.entries(GAME_REGISTRY).map(async ([gameId, config]) => [
    gameId,
    await generatedGameIsReady(config)
  ]));
  const readyByGame = new Map(availability);
  ui["game-select"].replaceChildren(option("", "Select game…"));
  for (const [gameId, config] of Object.entries(GAME_REGISTRY)) {
    const ready = readyByGame.get(gameId) === true;
    ui["game-select"].append(option(gameId, ready ? config.name : `${config.name} — standardization pending`, { disabled: !ready }));
  }
}

function button(label, className = "") {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.className = className;
  return node;
}

function sprite(record, alt = "") {
  const image = document.createElement("img");
  image.alt = alt || record?.displayName || "Pokémon";
  image.loading = "lazy";
  if (pokemonAssetResolver) {
    void setPokemonAssetImage(pokemonAssetResolver, image, record, dataset).then(result => {
      if (result.status !== "ok") image.classList.add("sprite-unavailable");
    });
  } else {
    image.classList.add("sprite-unavailable");
    image.hidden = true;
  }
  return image;
}

function recordName(record) {
  return record?.nickname || record?.displayName || record?.speciesId || "Pokémon";
}

function currentSpriteRecord(record, state) {
  if (!record || !state) return record;
  return {
    ...record,
    speciesId: state.currentSpeciesId || record.speciesId,
    formId: null,
    spriteId: state.currentSpriteId || record.speciesId
  };
}

function selectedGameBoxes() {
  return selectedGameId ? boxesForGame(boxLibrary, selectedGameId) : [];
}

function selectedBox(boxId) {
  return selectedGameBoxes().find(entry => entry.id === boxId) || null;
}

async function saveLibrary(message = null) {
  await boxStore.save(boxLibrary);
  renderBoxes();
  refreshContextBoxSelect();
  if (message) setStatus(message);
}

function requestProgressionSave(entries) {
  const changed = entries.filter(entry => entry.changed);
  if (changed.length) {
    ui["progression-summary"].replaceChildren(...changed.map(entry => {
      const row = document.createElement("div");
      row.className = "progression-change";
      const name = document.createElement("strong"); name.textContent = entry.displayName;
      const details = [];
      if (entry.experience !== entry.initialExperience) details.push(`EXP ${entry.initialExperience?.toLocaleString() ?? "—"} → ${entry.experience?.toLocaleString() ?? "—"}`);
      if (entry.level !== entry.initialLevel) details.push(`Level ${entry.initialLevel ?? "—"} → ${entry.level ?? "—"}`);
      const summary = document.createElement("span"); summary.textContent = details.join(" · ");
      row.append(name, summary);
      return row;
    }));
  } else {
    ui["progression-summary"].replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty",
      textContent: "This branch has no EXP or level changes. Saving will restore the tracked party records to this plan's starting totals."
    }));
  }
  ui["progression-dialog"].returnValue = "";
  ui["progression-dialog"].showModal();
  return new Promise(resolve => { progressionResolver = resolve; });
}

function resolveProgressionPrompt() {
  const resolve = progressionResolver;
  progressionResolver = null;
  resolve?.(ui["progression-dialog"].returnValue === "yes");
}

function downloadText(text, filename, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function setTab(name) {
  if (freeCalcSession && name !== 'plc') { setStatus('Finish Free Calc with Close, Add, or Save as Draft first.', true); return; }
  activeTab = ["boxes", "drafts"].includes(name) ? name : "plc";
  ui["plc-tab"].setAttribute("aria-selected", String(activeTab === "plc"));
  ui["boxes-tab"].setAttribute("aria-selected", String(activeTab === "boxes"));
  ui["plc-panel"].hidden = activeTab !== "plc";
  ui["boxes-panel"].hidden = activeTab !== "boxes";
  byId("drafts-tab").setAttribute("aria-selected", String(activeTab === "drafts"));
  byId("drafts-panel").hidden = activeTab !== "drafts";
  if (activeTab === "drafts") renderSavedDrafts().catch(error => setStatus(error.message, true));
}

async function saveNamedDraft() {
  if (!plan) return false;
  const editor = { cursorStateNodeId, reviewOutcomeStateNodeId, actionDraft, selectedPreviewOutcomeId, needsRecalculation };
  await savedDraftStore.save(savedDraftSnapshot(plan, editor));
  setStatus('Line saved to Drafts.');
  return true;
}

function startFreeCalc() {
  if (!plan || freeCalcSession) return;
  freeCalcSession = { plan, cursorStateNodeId, reviewOutcomeStateNodeId, actionDraft: structuredClone(actionDraft), currentPreview, branchEventModel, selectedPreviewOutcomeId, needsRecalculation };
  const result = addFreeCalcBranch(plan, cursorStateNodeId);
  plan = result.plan; cursorStateNodeId = result.stateId; reviewOutcomeStateNodeId = null;
  actionDraft = emptyActionDraft(); currentPreview = null; branchEventModel = null; selectedPreviewOutcomeId = null;
  previewGeneration++; renderWorkspace();
}

function closeFreeCalc() {
  if (!freeCalcSession) return;
  const session = freeCalcSession; freeCalcSession = null;
  ({ plan, cursorStateNodeId, reviewOutcomeStateNodeId, actionDraft, currentPreview, branchEventModel, selectedPreviewOutcomeId, needsRecalculation } = session);
  previewGeneration++; renderWorkspace();
  persistDraft().catch(error => setStatus(`Restored line could not be cached: ${error.message}`, true));
}

async function addFreeCalc() {
  if (!freeCalcSession) return;
  assertValidPlanDocument(plan);
  await draftStore.save(createDraftRecord(plan, cursorStateNodeId));
  freeCalcSession = null;
  await persistDraft(); renderWorkspace();
  setStatus('Free Calc added as a manual branch. Original nodes and Box records were preserved.');
}

async function saveFreeCalcDraft() {
  if (!freeCalcSession) return;
  const name = prompt('Line name', `${plan.name} · Free Calc`);
  if (!name?.trim()) return;
  if (name.trim().length > 240) throw new Error('Line names must be at most 240 characters');
  const savedPlan = freeCalcAsNewPlan(plan, cursorStateNodeId, name);
  const imported = addImportedPlanParty(boxLibrary, savedPlan, dataset);
  imported.library = renameBox(imported.library, selectedGameId, imported.boxId, name.trim());
  bindPlanPlayerPartyToImportedBox(savedPlan, imported);
  // Save the new Box before the draft so a saved draft never points at an absent Box.
  await boxStore.save(imported.library); boxLibrary = imported.library;
  await savedDraftStore.save(savedDraftSnapshot(savedPlan, { cursorStateNodeId: savedPlan.initialStateNodeId, actionDraft: structuredClone(actionDraft) }));
  closeFreeCalc(); renderBoxes(); setStatus('Free Calc saved as a new Turn 1 draft with its own Box and Party.');
}

function renderFreeCalcEditor(side, slot, actorKey) {
  const panel = document.createElement('fieldset'); panel.className = 'free-calc-editor';
  const legend = document.createElement('legend'); legend.textContent = 'Free Calc'; panel.append(legend);
  const state = selectedState(); const mon = plan.combatants[actorKey]; const current = state.combatantStates[actorKey];
  const apply = changes => {
    try { editFreeCalcCombatant(plan, cursorStateNodeId, actorKey, changes, dataset); currentPreview = null; branchEventModel = null; selectedPreviewOutcomeId = null; previewGeneration++; renderWorkspace(); }
    catch (error) { setStatus(error.message, true); renderWorkspace(); }
  };
  const field = (label, control) => { const row = document.createElement('label'); row.textContent = label; row.append(control); panel.append(row); return control; };
  const select = field('Pokémon', document.createElement('select')); select.setAttribute('aria-label', `Free Calc ${side} slot ${slot + 1} Pokémon`);
  const candidates = Object.values(plan.combatants).filter(entry => entry.side === side && !state.freeCalcRemovedKeys?.includes(entry.combatantKey));
  const byKey = new Map(candidates.map(entry => [entry.combatantKey, entry]));
  if (side === 'player') {
    const boxIds = new Set(Object.values(plan.combatants).filter(entry => entry.side === 'player').map(entry => entry.source?.boxId).filter(Boolean));
    for (const boxId of boxIds) {
      const box = selectedBox(boxId); if (!box) continue;
      for (const id of box.pokemonOrder) {
        if (candidates.some(entry => entry.source?.boxId === boxId && entry.source?.uniqueKey === id)) continue;
        const [entry] = normalizePlayerCollection({ party: [boxRecordToSnapshot(box.pokemon[id], boxId)] }, dataset);
        if (byKey.has(entry.combatantKey)) continue;
        byKey.set(entry.combatantKey, entry);
      }
    }
  }
  for (const entry of byKey.values()) {
    const opt = option(entry.combatantKey, recordName(entry));
    opt.disabled = activeKeys(state, side).includes(entry.combatantKey) && entry.combatantKey !== actorKey;
    select.append(opt);
  }
  select.value = actorKey;
  select.addEventListener('change', () => {
    try { replaceFreeCalcSlot(plan, cursorStateNodeId, side, slot, byKey.get(select.value)); actionDraft[side][slot] = {}; currentPreview = null; previewGeneration++; renderWorkspace(); }
    catch (error) { setStatus(error.message, true); }
  });
  if (!current || !mon) return panel;
  for (const [label, key, value, min, max] of [['HP', 'hp', current.hp.max, 0, current.hp.maxHp], ['Level', 'level', current.currentLevel ?? mon.level, 1, 100], ['Total EXP', 'experience', current.experience ?? mon.experience ?? '', 0, 10000000]]) {
    const input = field(label, document.createElement('input')); input.type = 'number'; input.min = min; input.max = max; input.step = '1'; input.value = value;
    input.setAttribute('aria-label', `Free Calc ${side} slot ${slot + 1} ${label}`);
    if (value === '') input.placeholder = 'Unknown';
    input.addEventListener('change', () => apply({ [key]: input.value }));
  }
  for (const [label, key, kind, value] of [['Ability', 'abilityId', 'abilities', current.currentAbilityId], ['Item', 'itemId', 'items', current.currentItemId]]) {
    const control = field(label, document.createElement('select')); fillSelect(control, sortedRecords(kind), key === 'itemId' ? { blank: 'None' } : {}); control.value = value || '';
    control.addEventListener('change', () => apply({ [key]: control.value || null }));
  }
  const status = field('Status', document.createElement('select'));
  for (const [id, label] of [['', 'Healthy'], ['brn', 'Burned'], ['par', 'Paralyzed'], ['psn', 'Poisoned'], ['tox', 'Badly Poisoned'], ['slp', 'Asleep'], ['frz', 'Frozen']]) status.append(option(id, label));
  status.value = current.majorStatus || ''; status.addEventListener('change', () => apply({ status: status.value }));
  const stages = document.createElement('div'); stages.className = 'free-calc-stages';
  for (const key of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion']) {
    const row = document.createElement('div'); const down = button('−', 'secondary'); const up = button('+', 'secondary');
    const value = Number(current.statStages[key] || 0); const text = document.createElement('span'); text.textContent = `${({atk:'Atk',def:'Def',spa:'SpA',spd:'SpD',spe:'Spe',accuracy:'Acc',evasion:'Eva'})[key]} ${value > 0 ? '+' : ''}${value}`;
    for (const [control, delta] of [[down, -1], [up, 1]]) { control.disabled = value + delta < -6 || value + delta > 6; control.setAttribute('aria-label', `${key} ${delta > 0 ? 'up' : 'down'}`); control.addEventListener('click', () => apply({ statStages: { [key]: value + delta } })); }
    row.append(down, text, up); stages.append(row);
  }
  panel.append(stages);
  const moves = (current.moveSetOverride || mon.moves).map(entry => entry.moveId);
  for (let index = 0; index < 4; index++) {
    const control = field(`Move ${index + 1}`, document.createElement('select')); fillSelect(control, sortedRecords('moves'), { blank: 'None' }); control.value = moves[index] || '';
    control.addEventListener('change', () => { const next = Array.from({ length: 4 }, (_, i) => moves[i] || ''); next[index] = control.value; actionDraft[side][slot] = {}; apply({ moves: next.filter(Boolean) }); });
  }
  return panel;
}

async function openSavedDraft(record) {
  if (!(await confirmDestructive('Opening a draft'))) return;
  if (record.gameId !== selectedGameId) throw new Error('Select this draft’s game first.');
  assertValidPlanDocument(record.document);
  validatePlanReferences(record.document, dataset);
  const restored = structuredClone(record.document);
  const editor = structuredClone(record.editor || {});
  plan = restored;
  cursorStateNodeId = plan.stateNodes[editor.cursorStateNodeId] ? editor.cursorStateNodeId : plan.initialStateNodeId;
  reviewOutcomeStateNodeId = editor.reviewOutcomeStateNodeId || null;
  actionDraft = editor.actionDraft || emptyActionDraft();
  selectedPreviewOutcomeId = editor.selectedPreviewOutcomeId || null;
  currentPreview = null; branchEventModel = null;
  needsRecalculation = mechanicsCompatibility(plan, dataset).needsRecalculation || Boolean(editor.needsRecalculation);
  draftRecord = createDraftRecord(plan, cursorStateNodeId);
  await persistDraft();
  setTab('plc'); renderWorkspace();
}

async function renderSavedDrafts() {
  const container = byId('drafts-list');
  const gameId = selectedGameId;
  const records = await savedDraftStore.list(gameId);
  if (gameId !== selectedGameId) return;
  draftTreeObservers.forEach(observer => observer.disconnect()); draftTreeObservers = [];
  container.replaceChildren();
  for (const record of records) {
    const card = document.createElement('section'); card.className = 'panel saved-line';
    const heading = document.createElement('h2'); heading.textContent = record.name;
    const actions = document.createElement('div'); actions.className = 'toolbar-actions';
    const open = button('Open in PLC');
    open.addEventListener('click', () => openSavedDraft(record).catch(error => setStatus(error.message, true)));
    const erase = button('Delete', 'danger');
    erase.addEventListener('click', async () => {
      if (!confirm(`Delete draft “${record.name}”? The open line and Boxes are unchanged.`)) return;
      try { await savedDraftStore.delete(record.id); await renderSavedDrafts(); } catch (error) { setStatus(error.message, true); }
    });
    actions.append(open, erase);
    const tree = document.createElement('div'); tree.className = 'saved-line-tree';
    const links = [];
    const entries = planTurnTreeOrder(record.document);
    const columns = [...new Set(entries.map(entry => entry.columnKey))];
    for (const entry of entries) {
      const state = record.document.stateNodes[entry.outcomeStateNodeId || entry.decisionStateNodeId];
      const node = document.createElement('div'); node.className = 'saved-line-node';
      node.style.gridColumn = String(columns.indexOf(entry.columnKey) + 1); node.style.gridRow = String(entry.lane + 1);
      const label = document.createElement('div'); label.textContent = entry.transitionKind === 'replacement' ? 'Replace' : `${state.freeCalc ? 'Free Calc · ' : ''}Turn ${entry.turnNumber}`;
      node.append(label);
      if (entry.kind === 'committed' && entry.transitionKind !== 'replacement') {
        const probability = document.createElement('small'); probability.textContent = state.outcome?.probability == null ? '—' : `${(state.outcome.probability * 100).toFixed(1)}%`; node.append(probability);
      }
      for (const key of activeKeys(state, 'player').concat(activeKeys(state, 'enemy'))) {
        const mon = record.document.combatants[key]; if (mon) node.append(sprite(mon));
      }
      tree.append(node);
      links.push({ entry, node });
    }
    card.append(heading, actions, tree); container.append(card);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('saved-line-links'); svg.setAttribute('aria-hidden', 'true'); tree.append(svg);
    const draw = () => {
      const bounds = tree.getBoundingClientRect(); svg.setAttribute('width', tree.scrollWidth); svg.setAttribute('height', tree.clientHeight); svg.replaceChildren();
      for (const child of links) {
        let parentId = child.entry.decisionStateNodeId;
        const manual = record.document.stateNodes[parentId]?.parentManualTransitionId;
        if (manual) parentId = record.document.manualTransitions[manual].parentStateNodeId;
        const parent = links.find(row => row !== child && row.entry.outcomeStateNodeId === parentId);
        if (!parent) continue;
        const from = parent.node.getBoundingClientRect(), to = child.node.getBoundingClientRect();
        const x1 = from.right - bounds.left + tree.scrollLeft, x2 = to.left - bounds.left + tree.scrollLeft;
        const y1 = from.top + from.height/2 - bounds.top, y2 = to.top + to.height/2 - bounds.top;
        const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', `M ${x1} ${y1} H ${(x1+x2)/2} V ${y2} H ${x2}`); svg.append(path);
      }
    };
    const observer = new ResizeObserver(draw); observer.observe(tree); draftTreeObservers.push(observer); requestAnimationFrame(draw);
  }
  if (!records.length) container.textContent = 'No saved drafts for this game.';
}

function partyMemberCell(record) {
  const cell = document.createElement("div");
  cell.className = "party-member";
  if (record) {
    cell.append(sprite(record));
    const name = document.createElement("small");
    name.textContent = recordName(record);
    cell.append(name);
  }
  return cell;
}

function renderParty(box, party) {
  const card = document.createElement("div");
  card.className = "party-card";
  const name = document.createElement("input");
  name.className = "party-name";
  name.value = party.name;
  name.setAttribute("aria-label", "Party name");
  name.addEventListener("change", async () => {
    try {
      boxLibrary = updateParty(boxLibrary, selectedGameId, box.id, party.id, { name: name.value });
      await saveLibrary("Party renamed.");
    } catch (error) { setStatus(error.message, true); renderBoxes(); }
  });
  const members = document.createElement("div");
  members.className = "party-card-grid";
  for (const pokemonId of party.pokemonIds) {
    const record = box.pokemon[pokemonId];
    if (!record) continue;
    const member = contextPokemonCard(box, record, true, false, { forContext: false });
    member.dataset.pokemonId = record.id;
    const actions = document.createElement('div'); actions.className = 'context-pokemon-actions';
    const removeMember = button('Remove', 'secondary');
    removeMember.addEventListener('click', async () => {
      boxLibrary = updateParty(boxLibrary, selectedGameId, box.id, party.id, { pokemonIds: selectedBox(box.id).parties[party.id].pokemonIds.filter(id => id !== record.id) });
      await saveLibrary('Party member removed.');
    });
    actions.append(removeMember);
    member.append(actions); members.append(member);
  }
  reorderCards(members, async pokemonIds => {
    boxLibrary = updateParty(boxLibrary, selectedGameId, box.id, party.id, { pokemonIds });
    await boxStore.save(boxLibrary);
  });
  const deleteParty = button('Delete Party', 'danger');
  deleteParty.addEventListener('click', async () => {
    if (!confirm(`Delete ${party.name}? Pokémon stay in the Box.`)) return;
    boxLibrary = removeParty(boxLibrary, selectedGameId, box.id, party.id); await saveLibrary('Party deleted.');
  });
  card.append(name, members, deleteParty);
  return card;
}

function renderBoxPokemon(box, record) {
  const card = document.createElement("article");
  card.className = "box-pokemon-card";
  card.append(sprite(record));
  const body = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = recordName(record);
  const detail = document.createElement("p");
  const species = dataset.get("species", record.speciesId);
  const expDetail = Number.isInteger(record.experience)
    ? ` · ${record.experience.toLocaleString()} EXP · ${experienceToNextLevel(record.experience, species?.growthRate, record.level).toLocaleString()} to next`
    : "";
  detail.textContent = `${record.displayName} · Lv. ${record.level}${expDetail} · ${record.moves.map(move => move.name).join(", ") || "No moves"}`;
  const actions = document.createElement("div");
  actions.className = "box-card-actions";
  const edit = button("Edit", "secondary");
  edit.addEventListener("click", () => openPokemonEditor(box.id, record.id));
  const exportOne = button("Showdown", "secondary");
  exportOne.addEventListener("click", () => openShowdownExport([record]));
  const erase = button("Erase", "danger");
  erase.addEventListener("click", async () => {
    if (!confirm(`Erase ${recordName(record)} from ${box.name} and every Party in it?`)) return;
    boxLibrary = removePokemon(boxLibrary, selectedGameId, box.id, record.id);
    await saveLibrary("Pokémon erased from its Box and Party references.");
  });
  actions.append(edit, exportOne, erase);
  body.append(heading, detail, actions);
  card.append(body);
  const membership = document.createElement("div");
  membership.className = "party-membership";
  for (const partyId of box.partyOrder) {
    const party = box.parties[partyId];
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = party.pokemonIds.includes(record.id);
    input.addEventListener("change", async () => {
      let ids = [...selectedBox(box.id).parties[party.id].pokemonIds];
      if (input.checked && ids.length >= 6) { input.checked = false; setStatus(`${party.name} already has six Pokémon.`, true); return; }
      ids = input.checked ? [...ids, record.id] : ids.filter(id => id !== record.id);
      boxLibrary = updateParty(boxLibrary, selectedGameId, box.id, party.id, { pokemonIds: ids });
      await saveLibrary("Party membership updated.");
    });
    label.append(input, document.createTextNode(party.name));
    membership.append(label);
  }
  card.append(membership);
  return card;
}

function renderBox(box) {
  const section = document.createElement("section");
  section.className = "box-card";
  const header = document.createElement("div");
  header.className = "box-card-header";
  const name = document.createElement("input");
  name.className = "box-name-input";
  name.value = box.name;
  name.setAttribute("aria-label", "Box name");
  name.addEventListener("change", async () => {
    try { boxLibrary = renameBox(boxLibrary, selectedGameId, box.id, name.value); await saveLibrary("Box renamed."); }
    catch (error) { setStatus(error.message, true); renderBoxes(); }
  });
  const actions = document.createElement("div");
  actions.className = "toolbar-actions";
  const addPokemonButton = button("Add Pokémon", "secondary");
  addPokemonButton.addEventListener("click", () => openPokemonEditor(box.id));
  const addPartyButton = button("Add Party", "secondary");
  addPartyButton.addEventListener("click", async () => {
    const result = addParty(boxLibrary, selectedGameId, box.id);
    boxLibrary = result.library;
    await saveLibrary("Party added.");
  });
  const exportBox = button("Showdown Export", "secondary");
  exportBox.addEventListener("click", () => openShowdownExport(box.pokemonOrder.map(id => box.pokemon[id])));
  const deleteBoxButton = button("Delete Box", "danger");
  deleteBoxButton.addEventListener("click", async () => {
    if (!confirm(`Delete ${box.name}, all of its Pokémon, and all of its Parties?`)) return;
    boxLibrary = removeBox(boxLibrary, selectedGameId, box.id);
    await saveLibrary("Box deleted.");
  });
  actions.append(addPokemonButton, addPartyButton, exportBox, deleteBoxButton);
  header.append(name, actions);
  const parties = document.createElement("div");
  parties.className = "party-shelf";
  if (!box.partyOrder.length) parties.append(Object.assign(document.createElement("p"), { className: "empty", textContent: "No Parties in this Box yet." }));
  else for (const partyId of box.partyOrder) parties.append(renderParty(box, box.parties[partyId]));
  const grid = document.createElement("div");
  grid.className = "box-pokemon-grid";
  if (!box.pokemonOrder.length) grid.append(Object.assign(document.createElement("p"), { className: "empty", textContent: "This Box is empty. Add a Pokémon or import Showdown sets." }));
  else for (const pokemonId of box.pokemonOrder) grid.append(renderBoxPokemon(box, box.pokemon[pokemonId]));
  section.append(header, parties, grid);
  return section;
}

function renderBoxes() {
  if (!selectedGameId) return;
  const boxes = selectedGameBoxes();
  if (!boxes.length) {
    ui["boxes-list"].replaceChildren(Object.assign(document.createElement("section"), {
      className: "panel empty-plan", innerHTML: "<h2>No Boxes yet</h2><p>Import a .sav or .dsv, paste Showdown sets, or create an empty Box.</p>"
    }));
    return;
  }
  ui["boxes-list"].replaceChildren(...boxes.map(renderBox));
}

function sortedRecords(kind) {
  return [...dataset.indexes[kind].values()].sort((a, b) => String(a.name || a.displayName).localeCompare(String(b.name || b.displayName)));
}

function speciesDexNumber(record) {
  const value = Number(record?.num);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function sortedSpeciesRecords() {
  return [...dataset.indexes.species.values()].sort((a, b) => {
    const aNumber = speciesDexNumber(a);
    const bNumber = speciesDexNumber(b);
    if (aNumber === null && bNumber !== null) return 1;
    if (aNumber !== null && bNumber === null) return -1;
    if (aNumber !== bNumber) return aNumber - bNumber;
    const formOrder = Number(Boolean(a.baseSpecies)) - Number(Boolean(b.baseSpecies));
    if (formOrder) return formOrder;
    const nameOrder = String(a.name || a.displayName || a.id).localeCompare(String(b.name || b.displayName || b.id));
    return nameOrder || String(a.id).localeCompare(String(b.id));
  });
}

function speciesSelectLabel(record) {
  const name = record.name || record.displayName || record.id;
  const dexNumber = speciesDexNumber(record);
  return dexNumber === null ? name : `#${String(dexNumber).padStart(3, "0")} ${name}`;
}

function fillSelect(select, records, { blank = null, labelFor = null } = {}) {
  select.replaceChildren();
  if (blank !== null) select.append(option("", blank));
  for (const record of records) select.append(option(record.id, labelFor?.(record) || record.name || record.displayName || record.id));
}

function defaultEditorRecord(speciesId = null) {
  const species = dataset.get("species", speciesId) || sortedSpeciesRecords()[0];
  const nature = dataset.get("natures", "serious") || sortedRecords("natures")[0];
  const abilityId = species.abilities?.[0] || sortedRecords("abilities")[0]?.id;
  return {
    speciesId: species.id, displayName: species.name, nickname: "", level: 50, gender: null,
    natureId: nature.id, abilityId, itemId: null, hiddenPowerTypeOverride: null, baseStats: { ...species.baseStats },
    ivs: Object.fromEntries(STAT_KEYS.map(key => [key, 31])), evs: Object.fromEntries(STAT_KEYS.map(key => [key, 0])), moves: []
  };
}

function readEditorDraft() {
  const species = dataset.get("species", ui["editor-species"].value);
  const hiddenPowerType = resolvedHiddenPowerType(
    Object.fromEntries(STAT_KEYS.map(stat => [stat, Number(byId(`editor-iv-${stat}`).value)])),
    ui["editor-hidden-power-type"].value || null,
    { generation: dataset.mechanics.damageGeneration }
  );
  return {
    id: ui["editor-pokemon-id"].value || undefined,
    speciesId: species?.id,
    formId: null,
    displayName: species?.name || ui["editor-species"].value,
    nickname: ui["editor-nickname"].value.trim(),
    level: Number(ui["editor-level"].value),
    gender: ui["editor-gender"].value || null,
    natureId: ui["editor-nature"].value,
    abilityId: ui["editor-ability"].value,
    itemId: ui["editor-item"].value || null,
    hiddenPowerTypeOverride: ui["editor-hidden-power-type"].value || null,
    baseStats: Object.fromEntries(STAT_KEYS.map(stat => [stat, Number(byId(`editor-base-${stat}`).value)])),
    ivs: Object.fromEntries(STAT_KEYS.map(stat => [stat, Number(byId(`editor-iv-${stat}`).value)])),
    evs: Object.fromEntries(STAT_KEYS.map(stat => [stat, Number(byId(`editor-ev-${stat}`).value)])),
    moves: editorMoveRows.map(row => {
      const move = dataset.get("moves", row.move.value);
      return move ? {
        moveId: move.id,
        name: move.name,
        basePower: Number(row.bp.value),
        pp: Number(row.pp.value),
        type: move.id === "hiddenpower" ? hiddenPowerType : row.type.value
      } : null;
    }).filter(Boolean),
    source: { kind: "manual" }
  };
}

function refreshEditorActualStats() {
  try {
    const draft = readEditorDraft();
    const calculated = calculateStats({ ...draft, displayName: draft.displayName }, dataset);
    for (const stat of STAT_KEYS) byId(`editor-actual-${stat}`).textContent = calculated[stat];
    if (ui["editor-context"].value === "plan") ui["editor-starting-hp"].max = calculated.hp;
    ui["editor-error"].textContent = "";
  } catch (error) { ui["editor-error"].textContent = error.message; }
}

function editorTypeName(typeId) {
  return dataset.get("types", typeId)?.name || typeId.charAt(0).toUpperCase() + typeId.slice(1);
}

function refreshEditorHiddenPower() {
  try {
    const ivs = Object.fromEntries(STAT_KEYS.map(stat => [stat, Number(byId(`editor-iv-${stat}`).value)]));
    const derivedType = hiddenPowerTypeFromIvs(ivs, { generation: dataset.mechanics.damageGeneration });
    const autoOption = ui["editor-hidden-power-type"].options[0];
    autoOption.textContent = `Auto — ${editorTypeName(derivedType)} (from IVs)`;
    const effectiveType = ui["editor-hidden-power-type"].value || derivedType;
    for (const row of editorMoveRows) {
      const isHiddenPower = row.move.value === "hiddenpower";
      row.type.disabled = isHiddenPower;
      if (isHiddenPower) row.type.value = effectiveType;
    }
  } catch (error) {
    const autoOption = ui["editor-hidden-power-type"].options[0];
    if (autoOption) autoOption.textContent = "Auto — enter valid IVs";
    ui["editor-error"].textContent = error.message;
  }
}

function loadEditorRecord(record) {
  ui["editor-sprite-preview"].replaceChildren(sprite(record, `${record.displayName || record.speciesId} sprite`));
  ui["editor-species"].value = record.speciesId;
  ui["editor-nickname"].value = record.nickname || "";
  ui["editor-level"].value = record.level;
  ui["editor-gender"].value = record.gender || "";
  ui["editor-nature"].value = record.natureId;
  ui["editor-ability"].value = record.abilityId || "";
  ui["editor-item"].value = record.itemId || "";
  ui["editor-hidden-power-type"].value = record.hiddenPowerTypeOverride || "";
  for (const stat of STAT_KEYS) {
    byId(`editor-base-${stat}`).value = record.baseStats[stat];
    byId(`editor-iv-${stat}`).value = record.ivs[stat];
    byId(`editor-ev-${stat}`).value = record.evs[stat];
  }
  editorMoveRows.forEach((row, index) => {
    const entry = record.moves[index];
    row.move.value = entry?.moveId || "";
    const move = entry ? dataset.get("moves", entry.moveId) : null;
    row.bp.value = entry?.basePower ?? move?.basePower ?? 0;
    row.pp.value = entry?.pp ?? move?.pp ?? 0;
    row.type.value = entry?.type || move?.type || "normal";
  });
  refreshEditorHiddenPower();
  refreshEditorActualStats();
}

function initializePokemonEditor() {
  fillSelect(ui["editor-species"], sortedSpeciesRecords(), { labelFor: speciesSelectLabel });
  fillSelect(ui["editor-nature"], sortedRecords("natures"));
  fillSelect(ui["editor-ability"], sortedRecords("abilities"));
  fillSelect(ui["editor-item"], sortedRecords("items"), { blank: "No item" });
  ui["editor-hidden-power-type"].replaceChildren(
    option("", "Auto — from IVs"),
    ...HIDDEN_POWER_TYPES.map(typeId => option(typeId, editorTypeName(typeId)))
  );
  ui["editor-hidden-power-type"].addEventListener("change", refreshEditorHiddenPower);
  const rows = STAT_KEYS.map(stat => {
    const row = document.createElement("tr");
    const label = document.createElement("th"); label.scope = "row"; label.textContent = STAT_LABELS[stat];
    const inputs = [["base", 1, 255], ["iv", 0, 31], ["ev", 0, 255]].map(([kind, min, max]) => {
      const cell = document.createElement("td");
      const input = document.createElement("input"); input.type = "number"; input.min = min; input.max = max; input.id = `editor-${kind}-${stat}`;
      input.addEventListener("input", () => {
        refreshEditorActualStats();
        if (kind === "iv") refreshEditorHiddenPower();
      });
      cell.append(input); return cell;
    });
    const actual = document.createElement("td"); actual.className = "actual-stat"; actual.id = `editor-actual-${stat}`;
    row.append(label, ...inputs, actual); return row;
  });
  ui["editor-stats"].replaceChildren(...rows);
  const moves = sortedRecords("moves");
  const types = sortedRecords("types");
  ui["editor-moves"].replaceChildren();
  editorMoveRows = Array.from({ length: 4 }, () => {
    const row = document.createElement("div"); row.className = "move-editor-row";
    const move = document.createElement("select"); fillSelect(move, moves, { blank: "No move" });
    const bp = document.createElement("input"); bp.type = "number"; bp.min = 0; bp.max = 1000; bp.placeholder = "BP"; bp.setAttribute("aria-label", "Move base power");
    const pp = document.createElement("input"); pp.type = "number"; pp.min = 0; pp.max = 99; pp.placeholder = "PP"; pp.setAttribute("aria-label", "Move PP");
    const type = document.createElement("select"); fillSelect(type, types);
    move.addEventListener("change", () => {
      const value = dataset.get("moves", move.value);
      bp.value = value?.basePower ?? 0;
      pp.value = value?.pp ?? 0;
      type.value = value?.type || "normal";
      refreshEditorHiddenPower();
    });
    row.append(move, bp, pp, type); ui["editor-moves"].append(row); return { row, move, bp, pp, type };
  });
  ui["editor-species"].onchange = () => {
    const current = readEditorDraft();
    const defaults = defaultEditorRecord(ui["editor-species"].value);
    const preservedAbilityId = dataset.get("abilities", current.abilityId)?.id || defaults.abilityId;
    loadEditorRecord({
      ...current,
      speciesId: defaults.speciesId,
      displayName: defaults.displayName,
      baseStats: defaults.baseStats,
      abilityId: preservedAbilityId
    });
  };
  for (const id of ["editor-level", "editor-nature"]) ui[id].oninput = refreshEditorActualStats;
}

function openPokemonEditor(boxId, pokemonId = null, context = false) {
  const box = selectedBox(boxId);
  const record = pokemonId ? box?.pokemon[pokemonId] : defaultEditorRecord();
  if (!box || !record) return;
  ui["editor-box-id"].value = boxId;
  ui["editor-pokemon-id"].value = pokemonId || "";
  ui["editor-context"].value = context ? "plan" : "box";
  ui["pokemon-editor-title"].textContent = pokemonId ? `Edit ${recordName(record)}` : "Add Pokémon";
  ui["editor-hp-field"].hidden = !context;
  ui["editor-status-field"].hidden = !context;
  loadEditorRecord(record);
  if (context) {
    const initial = contextSelection.initialConditions[pokemonId] || {};
    const stats = calculateStats(record, dataset);
    ui["editor-starting-hp"].value = initial.currentHp ?? stats.hp;
    ui["editor-starting-hp"].max = stats.hp;
    ui["editor-starting-status"].value = initial.majorStatus || "";
  }
  ui["pokemon-editor-dialog"].showModal();
}

async function savePokemonEditor() {
  try {
    const boxId = ui["editor-box-id"].value;
    const existingId = ui["editor-pokemon-id"].value || null;
    const draft = readEditorDraft();
    const existing = existingId ? selectedBox(boxId)?.pokemon?.[existingId] : null;
    if (existing) {
      draft.source = existing.source;
      if (Number.isInteger(existing.experience)) {
        const species = dataset.get("species", draft.speciesId);
        draft.experience = existing.speciesId === draft.speciesId && existing.level === draft.level
          ? existing.experience
          : experienceForLevel(draft.level, species?.growthRate);
      }
    }
    if (ui["editor-context"].value === "plan") draft.majorStatus = ui["editor-starting-status"].value || null;
    const result = upsertPokemon(boxLibrary, selectedGameId, boxId, draft);
    boxLibrary = result.library;
    if (ui["editor-context"].value === "plan") {
      const record = selectedBox(boxId).pokemon[result.pokemonId];
      const maxHp = calculateStats(record, dataset).hp;
      const hp = Math.max(0, Math.min(maxHp, Number(ui["editor-starting-hp"].value)));
      contextSelection.initialConditions[result.pokemonId] = { ...contextSelection.initialConditions[result.pokemonId], currentHp: hp, majorStatus: ui["editor-starting-status"].value || null, itemId: record.itemId || null };
      if (existingId && !contextSelection.pokemonIds.includes(existingId)) contextSelection.pokemonIds.push(existingId);
    }
    await saveLibrary("Pokémon saved. Every Party in this Box now uses the updated record.");
    ui["pokemon-editor-dialog"].close();
    renderContextPokemonGrid();
    if (contextSelection.saved) renderPartySummary();
  } catch (error) { ui["editor-error"].textContent = error.message; }
}

function refreshShowdownDestinations() {
  const previous = ui["showdown-destination"].value;
  ui["showdown-destination"].replaceChildren(option("new", "Create a new Box"));
  for (const box of selectedGameBoxes()) ui["showdown-destination"].append(option(box.id, `Add to ${box.name}`));
  if ([...ui["showdown-destination"].options].some(entry => entry.value === previous)) ui["showdown-destination"].value = previous;
}

function openShowdownExport(records) {
  refreshShowdownDestinations();
  ui["showdown-text"].value = exportShowdown(records, dataset);
  ui["showdown-status"].textContent = `Exported ${records.length} Pokémon. Copy the text or replace it with sets to import.`;
  ui["showdown-dialog"].showModal();
}

async function importShowdownText() {
  try {
    const records = parseShowdown(ui["showdown-text"].value, dataset);
    const destination = ui["showdown-destination"].value;
    if (destination === "new") {
      const result = addBox(boxLibrary, selectedGameId, { pokemon: records, partyPokemonIds: records.slice(0, 6).map(record => record.id), source: { kind: "showdown-import" } });
      boxLibrary = result.library;
    } else {
      for (const record of records) boxLibrary = upsertPokemon(boxLibrary, selectedGameId, destination, record).library;
    }
    await saveLibrary(`Imported ${records.length} Showdown Pokémon.`);
    ui["showdown-status"].textContent = `Imported ${records.length} Pokémon successfully.`;
    ui["showdown-dialog"].close();
  } catch (error) { ui["showdown-status"].textContent = error.message; }
}

function selectedSavePcBoxes() {
  return [...ui["save-import-pc-boxes"].querySelectorAll('input[type="checkbox"]:checked')].map(input => Number(input.value));
}

function updateSaveImportStatus() {
  if (!pendingSaveImport) return;
  const selected = new Set(selectedSavePcBoxes());
  const count = pendingSaveImport.imported.pcBoxes
    .filter(box => selected.has(Number(box.boxNumber)))
    .reduce((sum, box) => sum + Number(box.pokemonCount), 0);
  ui["save-import-status"].textContent = selected.size
    ? `${selected.size} PC Box${selected.size === 1 ? "" : "es"} selected · ${count} boxed Pokémon plus the mandatory ${pendingSaveImport.imported.partyCount}-Pokémon party.`
    : `No PC Boxes selected. The ${pendingSaveImport.imported.partyCount}-Pokémon active party will still be imported.`;
}

function renderSaveImportSelection(fileName, imported) {
  ui["save-import-filename"].textContent = fileName;
  ui["save-import-party-summary"].textContent = `Active party · ${imported.partyCount} Pokémon · always imported`;
  const options = imported.pcBoxes.map(box => {
    const label = document.createElement("label"); label.className = "save-box-option";
    const input = document.createElement("input"); input.type = "checkbox"; input.value = box.boxNumber; input.dataset.pokemonCount = box.pokemonCount;
    input.addEventListener("change", updateSaveImportStatus);
    const copy = document.createElement("span");
    const name = document.createElement("strong"); name.textContent = `PC Box ${box.boxNumber}`;
    const count = document.createElement("small"); count.textContent = `${box.pokemonCount} Pokémon`;
    copy.append(name, count); label.append(input, copy); return label;
  });
  ui["save-import-pc-boxes"].replaceChildren(...options);
  updateSaveImportStatus();
}

async function prepareSaveImport(file) {
  if (!file) return;
  try {
    if (!/\.(sav|dsv)$/i.test(file.name)) {
      throw new Error("Save import accepts .sav and .dsv files only");
    }
    setStatus(`Reading ${file.name} without modifying it…`);
    const imported = parseSave(await file.arrayBuffer(), dataset, { sourceName: file.name });
    pendingSaveImport = { fileName: file.name, imported };
    renderSaveImportSelection(file.name, imported);
    ui["save-import-dialog"].returnValue = "";
    ui["save-import-dialog"].showModal();
    setStatus(`Save read successfully. Select the PC Boxes to import; the active party is mandatory.`);
  } catch (error) { setStatus(error.message, true); }
  finally { ui["save-import"].value = ""; }
}

async function confirmSaveImport() {
  if (!pendingSaveImport) return;
  try {
    const selected = selectSavePokemon(pendingSaveImport.imported, selectedSavePcBoxes());
    const result = addBox(boxLibrary, selectedGameId, {
      name: pendingSaveImport.fileName.replace(/\.(sav|dsv)$/i, ""),
      pokemon: selected.pokemon,
      partyPokemonIds: selected.partyPokemonIds,
      source: { kind: "save-import", sourceName: pendingSaveImport.fileName, selectedPcBoxNumbers: selected.selectedPcBoxNumbers }
    });
    boxLibrary = result.library;
    const selectedLabel = selected.selectedPcBoxNumbers.length ? ` from PC Box${selected.selectedPcBoxNumbers.length === 1 ? "" : "es"} ${selected.selectedPcBoxNumbers.join(", ")}` : "";
    await saveLibrary(`Imported the ${selected.partyCount}-Pokémon active party and ${selected.boxCount} boxed Pokémon${selectedLabel} from a read-only save snapshot.`);
    pendingSaveImport = null;
    ui["save-import-dialog"].close("imported");
    setTab("boxes");
  } catch (error) { ui["save-import-status"].textContent = error.message; }
}

function trainerLabel(trainer) {
  let team = [];
  try { team = dataset.trainerTeam(trainer.id, null); }
  catch { team = trainer.team || []; }
  const members = team.map(member => `${canonicalSpeciesDisplayName(dataset, member)} Lv. ${member.level}`).join(", ");
  return `${trainer.displayName || trainer.name || trainer.id}${members ? ` · ${members}` : ""}`;
}

function fillTrainerSelect() {
  ui["trainer-select"].replaceChildren(option("", "Select trainer…"));
  for (const group of dataset.trainerGroups()) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const trainer of group.trainers) optgroup.append(option(trainer.id, trainerLabel(trainer)));
    ui["trainer-select"].append(optgroup);
  }
}

function contextTrainerId() { return ui["battle-format-choice"]?.value || ui["trainer-select"].value; }

function updateVariantSelect() {
  const choices = dataset?.trainerBattleChoices(ui["trainer-select"].value) || [];
  const choice = ui["battle-format-choice"];
  choice.replaceChildren(...choices.map(row => option(row.trainerId, row.label)));
  choice.hidden = choices.length < 2;
  ui["battle-format"].hidden = choices.length > 1;
  updateContextTrainer();
}

function updateContextTrainer() {
  const trainer = dataset?.trainer(contextTrainerId());
  const variants = trainer?.mechanicsVariants || [];
  ui["variant-field"].hidden = !variants.length;
  ui["variant-select"].replaceChildren();
  for (const variant of variants) ui["variant-select"].append(option(variant.id, variant.displayName || variant.name || `Variant ${variant.id}`));
  if (trainer) {
    try {
      const format = dataset.trainerBattleFormat(trainer.id);
      ui["battle-format"].value = format === "rotation" ? "Rotation" : format === "triples" ? "Triples" : format === "doubles" ? "Doubles" : "Singles";
    }
    catch (error) { ui["battle-format"].value = error.message; }
    ui["plan-name"].value = `${trainer.displayName || trainer.name} Plan`;
  } else ui["battle-format"].value = "Select a trainer";
  renderEnemyTeamSummary();
  updateBeginAvailability();
}

function enemyTeamPreviewRecord(member) {
  const speciesId = member.speciesId || member.species || member.displaySpecies;
  return {
    speciesId,
    formId: member.form ? String(member.form) : null,
    displayName: canonicalSpeciesDisplayName(dataset, member),
    nickname: "",
    level: Number(member.level),
    itemId: member.itemId || null
  };
}

function renderEnemyTeamSummary() {
  const trainer = dataset?.trainer(contextTrainerId());
  if (!trainer) {
    ui["enemy-team-summary"].replaceChildren();
    return;
  }
  let members;
  try { members = dataset.trainerTeam(trainer.id, ui["variant-select"].value || null); }
  catch { members = trainer.team || []; }
  const records = members.map(enemyTeamPreviewRecord);
  if (!records.length) {
    ui["enemy-team-summary"].replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "This trainer has no available team data." }));
    return;
  }
  ui["enemy-team-summary"].replaceChildren(...records.map(record => contextPokemonCard(null, record, true, false, { editable: false })));
}

function refreshContextBoxSelect() {
  const previous = contextSelection.boxId || ui["context-box-select"].value;
  ui["context-box-select"].replaceChildren(option("", "Select Box…"));
  for (const box of selectedGameBoxes()) ui["context-box-select"].append(option(box.id, `${box.name} · ${box.pokemonOrder.length} Pokémon`));
  if ([...ui["context-box-select"].options].some(entry => entry.value === previous)) ui["context-box-select"].value = previous;
  refreshContextPartySelect();
}

function refreshContextPartySelect() {
  const box = selectedBox(ui["context-box-select"].value);
  const previous = contextSelection.partyId || ui["context-party-select"].value;
  ui["context-party-select"].replaceChildren(option("", "Select Party…"));
  for (const partyId of box?.partyOrder || []) {
    const party = box.parties[partyId];
    ui["context-party-select"].append(option(party.id, `${party.name} · ${party.pokemonIds.length} Pokémon`));
  }
  if ([...ui["context-party-select"].options].some(entry => entry.value === previous)) ui["context-party-select"].value = previous;
  ui["saved-party-field"].hidden = ui["party-source-mode"].value !== "party";
}

function ensureContextInitial(record) {
  if (contextSelection.initialConditions[record.id]) return;
  contextSelection.initialConditions[record.id] = { currentHp: calculateStats(record, dataset).hp, majorStatus: record.majorStatus || null };
}

function contextPokemonCard(box, record, selected, manual, { editable = true, forContext = true } = {}) {
  const card = document.createElement("article");
  card.className = `context-pokemon${selected ? " is-selected" : ""}`;
  card.dataset.pokemonId = record.id || '';
  card.append(sprite(record));
  const body = document.createElement("div");
  const name = document.createElement("strong"); name.textContent = recordName(record);
  const detail = document.createElement("small"); detail.textContent = `${record.displayName} · Lv. ${record.level}`;
  body.append(name, detail); card.append(body);
  const item = document.createElement("small");
  item.className = "context-held-item";
  const startingItem = editable && forContext && Object.hasOwn(contextSelection.initialConditions[record.id] || {}, "itemId")
    ? contextSelection.initialConditions[record.id].itemId : record.itemId;
  item.textContent = startingItem ? dataset.get("items", startingItem)?.name || startingItem : "None";
  body.append(item);
  if (editable && forContext) {
    ensureContextInitial(record);
    const initial = contextSelection.initialConditions[record.id];
    const maxHp = calculateStats(record, dataset).hp;
    if (initial.currentHp < maxHp) {
      const hp = document.createElement("small");
      hp.className = "context-starting-hp";
      hp.textContent = `HP ${initial.currentHp} / ${maxHp}`;
      body.append(hp);
    }
  }
  const actions = document.createElement("div"); actions.className = "context-pokemon-actions";
  if (manual) {
    const choose = button(selected ? "Remove" : "Select", selected ? "" : "secondary");
    choose.addEventListener("click", () => {
      if (selected) contextSelection.pokemonIds = contextSelection.pokemonIds.filter(id => id !== record.id);
      else if (contextSelection.pokemonIds.length < 6) contextSelection.pokemonIds.push(record.id);
      else { setStatus("Select no more than six Pokémon.", true); return; }
      contextSelection.saved = false;
      renderContextPokemonGrid();
    });
    actions.append(choose);
  }
  if (editable) {
    const edit = button("Edit", "secondary");
    edit.addEventListener("click", () => { if (forContext) ensureContextInitial(record); openPokemonEditor(box.id, record.id, forContext); });
    actions.append(edit);
    const status = document.createElement("select");
    status.className = "context-pre-status";
    status.setAttribute("aria-label", `Pre-status for ${recordName(record)}`);
    for (const [value, label] of [["", "No Status"], ["brn", "Burned"], ["par", "Paralyzed"], ["psn", "Poisoned"], ["tox", "Badly Poisoned"], ["slp", "Asleep"], ["frz", "Frozen"]]) status.append(option(value, label));
    status.value = (forContext ? contextSelection.initialConditions[record.id].majorStatus : record.majorStatus) || "";
    status.addEventListener("change", async () => {
      try {
        await persistPartyRecordFields(box.id, record.id, { majorStatus: status.value || null });
      } catch (error) { setStatus(error.message, true); }
    });
    const heldItem = document.createElement("select");
    heldItem.className = "context-pre-item";
    heldItem.setAttribute("aria-label", `Item for ${recordName(record)}`);
    fillSelect(heldItem, sortedRecords("items"), { blank: "None" });
    const initial = forContext ? contextSelection.initialConditions[record.id] : record;
    heldItem.value = Object.hasOwn(initial, "itemId") ? initial.itemId || "" : record.itemId || "";
    heldItem.addEventListener("change", async () => {
      item.textContent = heldItem.selectedOptions[0]?.textContent || "None";
      try {
        await persistPartyRecordFields(box.id, record.id, { itemId: heldItem.value || null });
      } catch (error) { setStatus(error.message, true); }
    });
    actions.append(heldItem, status);
  }
  if (actions.childElementCount) card.append(actions);
  return card;
}

async function persistPartyRecordFields(boxId, pokemonId, fields) {
  boxLibrary = upsertPokemon(boxLibrary, selectedGameId, boxId, { ...selectedBox(boxId).pokemon[pokemonId], ...fields }).library;
  if (contextSelection.boxId === boxId && contextSelection.initialConditions[pokemonId]) {
    Object.assign(contextSelection.initialConditions[pokemonId], fields);
  }
  await boxStore.save(boxLibrary);
  renderBoxes();
}

function selectedContextRecords() {
  const box = selectedBox(contextSelection.boxId);
  return contextSelection.pokemonIds.map(id => box?.pokemon[id]).filter(Boolean);
}

function renderContextPokemonGrid() {
  const box = selectedBox(ui["context-box-select"].value);
  contextSelection.boxId = box?.id || null;
  const manual = ui["party-source-mode"].value === "manual";
  if (!box) {
    ui["context-pokemon-grid"].replaceChildren();
    ui["save-party-selection"].disabled = true;
    return;
  }
  if (!manual) {
    const party = box.parties[ui["context-party-select"].value];
    contextSelection.partyId = party?.id || null;
    contextSelection.pokemonIds = party ? [...party.pokemonIds] : [];
  }
  const records = manual ? box.pokemonOrder.map(id => box.pokemon[id]) : contextSelection.pokemonIds.map(id => box.pokemon[id]).filter(Boolean);
  if (!records.length) ui["context-pokemon-grid"].replaceChildren();
  else ui["context-pokemon-grid"].replaceChildren(...records.map(record => contextPokemonCard(box, record, contextSelection.pokemonIds.includes(record.id), manual)));
  if (!manual) reorderCards(ui["context-pokemon-grid"], saveContextOrder);
  ui["save-party-selection"].disabled = contextSelection.pokemonIds.length < 1 || contextSelection.pokemonIds.length > 6;
  updateBeginAvailability();
}

function renderPartySummary() {
  const records = selectedContextRecords();
  ui["party-selection-summary"].replaceChildren(...records.map(record => {
    ensureContextInitial(record);
    const card = contextPokemonCard(selectedBox(contextSelection.boxId), record, true, false);
    return card;
  }));
  reorderCards(ui["party-selection-summary"], saveContextOrder);
  ui["party-selector-controls"].hidden = true;
  ui["party-selection-summary"].hidden = false;
  ui["edit-party-selection"].hidden = false;
  ui["edge-party-exp"].hidden = false;
}

async function saveContextOrder(pokemonIds) {
  contextSelection.pokemonIds = pokemonIds;
  if (contextSelection.partyId) {
    boxLibrary = updateParty(boxLibrary, selectedGameId, contextSelection.boxId, contextSelection.partyId, { pokemonIds });
    await boxStore.save(boxLibrary); renderBoxes();
  }
}

async function edgePartyExperience() {
  try {
    const records = selectedContextRecords().filter(record => record.level < 100);
    let nextLibrary = boxLibrary;
    for (const record of records) {
      const growthRate = dataset.get("species", record.speciesId)?.growthRate;
      if (!growthRate) throw new Error(`Missing EXP growth rate for ${recordName(record)}.`);
      nextLibrary = upsertPokemon(nextLibrary, selectedGameId, contextSelection.boxId, {
        ...record, experience: experienceForLevel(record.level + 1, growthRate) - 1
      }).library;
    }
    boxLibrary = nextLibrary;
    await saveLibrary("Selected party edged to 1 EXP before the next level. Level 100 Pokémon were unchanged.");
    renderPartySummary();
    ui["context-status"].textContent = records.length ? "Selected party is 1 EXP from leveling up." : "Selected party is already at level 100.";
  } catch (error) { ui["context-status"].textContent = error.message; }
}

function savePartySelection() {
  const records = selectedContextRecords();
  if (!records.length) return;
  for (const record of records) ensureContextInitial(record);
  contextSelection.saved = true;
  renderPartySummary();
  updateBeginAvailability();
}

function updateBeginAvailability() {
  const trainer = dataset?.trainer(contextTrainerId());
  let required = 1;
  let format = "singles";
  if (trainer) {
    try {
      format = dataset.trainerBattleFormat(trainer.id);
      required = slotsPerSide(format);
    } catch {
      required = 1;
      format = "singles";
    }
  }
  const enough = contextSelection.saved && selectedContextRecords().length >= required;
  const variantReady = !trainer?.mechanicsVariants?.length || Boolean(ui["variant-select"].value);
  ui["begin-plan"].disabled = !(trainer && enough && variantReady);
  ui["context-status"].textContent = !trainer ? "Select a trainer."
    : !contextSelection.saved ? "Choose and save a player party."
      : !enough ? `${ui["battle-format"].value} requires at least ${required} player Pokémon.`
        : "Trainer and player party are ready.";
}

function openPlanContext({ reset = true } = {}) {
  if (!dataset) return;
  if (reset) contextSelection = emptyContextSelection();
  refreshContextBoxSelect();
  ui["party-selector-controls"].hidden = false;
  ui["party-selection-summary"].hidden = true;
  ui["edit-party-selection"].hidden = true;
  ui["edge-party-exp"].hidden = true;
  ui["party-source-mode"].value = "party";
  updateVariantSelect();
  renderContextPokemonGrid();
  if (!ui["plan-context-dialog"].open) ui["plan-context-dialog"].showModal();
}

function boxRecordToSnapshot(record, boxId = null) {
  const hiddenPowerType = record.moves.some(move => move.moveId === "hiddenpower")
    ? resolvedHiddenPowerType(record.ivs, record.hiddenPowerTypeOverride, { generation: dataset.mechanics.damageGeneration })
    : null;
  return {
    uniqueKey: record.id,
    speciesId: record.speciesId,
    formId: record.formId,
    displayName: record.displayName,
    nickname: record.nickname,
    level: record.level,
    experience: record.experience,
    gender: record.gender,
    ...(Number.isInteger(record.friendship) ? { friendship: record.friendship } : {}),
    natureId: record.natureId,
    abilityId: record.abilityId,
    itemId: record.itemId,
    baseStats: record.baseStats,
    ivs: record.ivs,
    evs: record.evs,
    moves: record.moves.map(move => ({
      moveId: move.moveId,
      maxPp: move.pp,
      basePower: move.basePower,
      type: move.moveId === "hiddenpower" ? hiddenPowerType : move.type
    })),
    source: { kind: "boxes-library", boxId }
  };
}

function initialConditionsForPlan(players) {
  const combatants = {};
  players.forEach((combatant, index) => {
    const recordId = contextSelection.pokemonIds[index];
    const initial = contextSelection.initialConditions[recordId] || {};
    combatants[combatant.combatantKey] = {
      currentHp: initial.currentHp ?? combatant.calculatedStats.hp,
      majorStatus: initial.majorStatus || null
    };
  });
  return { weather: ui["initial-weather"].value || null, terrain: ui["initial-terrain"].value || null, combatants };
}

async function beginPlanFromContext() {
  if (ui["begin-plan"].disabled) return;
  if (plan && !(await confirmDestructive("Beginning a clean plan"))) return;
  try {
    const trainer = dataset.trainer(contextTrainerId());
    const variantId = trainer.mechanicsVariants?.length ? ui["variant-select"].value : null;
    const records = selectedContextRecords();
    const players = normalizePlayerCollection({ party: records.map(record => {
      const initial = contextSelection.initialConditions[record.id];
      return boxRecordToSnapshot(initial && Object.hasOwn(initial, "itemId") ? { ...record, itemId: initial.itemId } : record, contextSelection.boxId);
    }) }, dataset);
    const enemies = normalizeTrainerRoster(trainer.id, variantId, dataset);
    const sourceSnapshot = snapshotFingerprint(players, enemies, boxLibrary.updatedAt);
    plan = createPlanDocument({
      name: ui["plan-name"].value.trim() || `${trainer.displayName} Plan`,
      dataset,
      trainerId: trainer.id,
      trainerVariantId: variantId,
      playerCombatants: players,
      enemyCombatants: enemies,
      battleFormat: dataset.trainerBattleFormat(trainer.id),
      sourceSnapshot,
      initialConditions: initialConditionsForPlan(players)
    });
    cursorStateNodeId = plan.initialStateNodeId;
    currentPreview = null;
    branchEventModel = null;
    selectedPreviewOutcomeId = null;
    reviewOutcomeStateNodeId = null;
    actionDraft = emptyActionDraft();
    exportSelection.clear();
    needsRecalculation = false;
    draftRecord = createDraftRecord(plan, cursorStateNodeId);
    await draftStore.save(draftRecord);
    ui["plan-context-dialog"].close();
    setTab("plc");
    renderWorkspace();
    const formatLabel = battleFormatLabel(plan.game.battleFormat);
    setStatus(`Clean ${formatLabel} plan ready for ${trainer.displayName}. Nothing has been sent to Overlay.`);
  } catch (error) { setStatus(error.message, true); }
}

function selectedState() {
  return plan?.stateNodes?.[cursorStateNodeId] || null;
}

function selectedNoteTarget() {
  if (!plan) return null;
  if (reviewOutcomeStateNodeId && plan.stateNodes[reviewOutcomeStateNodeId]) {
    return { stateNodeId: reviewOutcomeStateNodeId, field: "notes", turnNumber: displayTurnNumber(plan.stateNodes[reviewOutcomeStateNodeId]), committed: true };
  }
  const state = selectedState();
  if (!state) return null;
  if (battleActuallyEnded(state)) return { stateNodeId: state.stateNodeId, field: "notes", turnNumber: Number(state.turnNumber), committed: true };
  return { stateNodeId: state.stateNodeId, field: "draftNote", turnNumber: Number(state.turnNumber) + 1, committed: false };
}

function displayTurnNumber(state) {
  return Number(state?.turnNumber || 0) + (state?.parentReplacementTransitionId ? 1 : 0);
}

function setNotesExpanded(expanded) {
  notesExpanded = Boolean(expanded);
  ui["notes-body"].hidden = !notesExpanded;
  ui["notes-toggle"].textContent = notesExpanded ? "▾" : "▸";
  ui["notes-toggle"].setAttribute("aria-expanded", String(notesExpanded));
  ui["notes-toggle"].setAttribute("aria-label", `${notesExpanded ? "Collapse" : "Expand"} Notes`);
}

function setAiForecastExpanded(expanded) {
  aiForecastExpanded = Boolean(expanded);
  ui["ai-forecast-toggle"].checked = aiForecastExpanded;
  ui["ai-forecast-toggle"].setAttribute("aria-expanded", String(aiForecastExpanded));
  ui["ai-forecast-body"].hidden = !aiForecastExpanded;
}

function aiProbabilityLabel(weight) {
  const probability = Number(weight?.decimal ?? weight);
  if (!Number.isFinite(probability)) return "—";
  return `${(probability * 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;
}

function aiIncentiveDescription(summary) {
  return String(summary || "")
    .replace(/;?\s*(?:its|this move's)\s+(?:fresh|independent)\s+128\/256 incentive check passed\.?/gi, ".")
    .replace(/\s+passed\s+(?:a|another|its)\s+(?:fresh|independent)\s+128\/256(?:\s+incentive)?\s+check\.?/gi, ".")
    .replace(/\s+passed\s+its\s+fresh\s+128\/256\s+check\.?/gi, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+\./g, ".")
    .trim();
}

function appendAiMoveLedger(container, move) {
  const ledger = move.incentiveLedger;
  if (!ledger) return;
  const highlightsLikelihoodSource = new Set(["likely", "very-likely", "guaranteed"]).has(move.turnLikelihood?.id);

  const distributions = ledger.finalScoreDistributions || [];
  for (const distribution of distributions) {
  const table = document.createElement("table");
  table.className = "ai-incentive-table";
  if (highlightsLikelihoodSource && distribution.influencesLikelihood) table.classList.add("is-likelihood-source");
  const caption = document.createElement("caption");
  caption.textContent = Number.isInteger(distribution.targetSlot)
    ? `Slot ${battleSlotNumber(distribution.targetSide || "player", distribution.targetSlot)}` : "Field";
  table.append(caption);
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Probability", "Points", "AI Behaviour"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  const adjustmentProbability = adjustment => {
    const weight = adjustment.probability || adjustment.modeledWeight;
    const value = weight == null ? NaN : Number(weight.decimal ?? weight);
    return Number.isFinite(value) ? value : -1;
  };
  const adjustments = (ledger.adjustments || []).filter(adjustment => !adjustment.candidateId || adjustment.candidateId === distribution.candidateId).sort((left, right) =>
    adjustmentProbability(right) - adjustmentProbability(left)
    || Math.sign(Number(right.delta)) - Math.sign(Number(left.delta)));
  for (const adjustment of adjustments) {
    const row = document.createElement("tr");
    const probability = document.createElement("td");
    probability.textContent = aiProbabilityLabel(adjustment.probability || adjustment.modeledWeight);
    const points = document.createElement("td");
    points.className = Number(adjustment.delta) > 0 ? "is-positive" : Number(adjustment.delta) < 0 ? "is-negative" : "";
    points.textContent = `${Number(adjustment.delta) > 0 ? "+" : ""}${Number(adjustment.delta)}`;
    const reason = document.createElement("td");
    const ruleTitle = document.createElement("span");
    ruleTitle.className = "ai-rule-title";
    ruleTitle.textContent = adjustment.title || "AI rule";
    ruleTitle.title = aiIncentiveDescription(adjustment.summary);
    ruleTitle.tabIndex = 0;
    ruleTitle.setAttribute("aria-label", `${ruleTitle.textContent}: ${ruleTitle.title}`);
    reason.append(ruleTitle);
    row.append(probability, points, reason);
    body.append(row);
  }
  table.append(head, body);
  const footer = document.createElement("tfoot");
  for (const outcome of [...(distribution.scores || [])].sort((left, right) => adjustmentProbability(right) - adjustmentProbability(left))) {
    const row = document.createElement("tr");
    const probability = document.createElement("td");
    probability.textContent = aiProbabilityLabel(outcome.probability);
    const score = document.createElement("td");
    score.textContent = String(outcome.score);
    score.setAttribute("aria-label", `Final score ${outcome.score}`);
    row.append(probability, score, document.createElement("td"));
    footer.append(row);
  }
  table.append(footer);
  container.append(table);
  }
}

function renderNotes() {
  const target = selectedNoteTarget();
  renderTrainerAiNotes(target?.stateNodeId ? plan?.stateNodes?.[target.stateNodeId] : selectedState());
  ui["node-notes"].disabled = !target || needsRecalculation;
  if (!target) {
    ui["node-notes"].value = "";
    ui["notes-status"].textContent = "Open a plan to add node notes.";
    return;
  }
  const value = String(plan.stateNodes[target.stateNodeId]?.[target.field] || "");
  const sameTarget = ui["node-notes"].dataset.stateNodeId === target.stateNodeId && ui["node-notes"].dataset.noteField === target.field;
  if (document.activeElement !== ui["node-notes"] || !sameTarget) ui["node-notes"].value = value;
  ui["node-notes"].dataset.stateNodeId = target.stateNodeId;
  ui["node-notes"].dataset.noteField = target.field;
  ui["notes-status"].textContent = `${target.committed ? "Committed" : "Draft"} Turn ${target.turnNumber} note · saved in plan files and restored on import.`;
}

function renderTrainerAiNotes(state) {
  const container = ui["ai-notes"];
  if (!container) return;
  const forecastSupported = trainerAi?.binding?.consumerActivation?.enabled === true && !selectedState()?.freeCalc;
  container.closest(".ai-forecast-panel").hidden = !forecastSupported;
  if (!forecastSupported) return;
  if (!plan || !state || !dataset || !trainerAi || !worker) {
    container.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "Enemy AI documentation is unavailable for this node." }));
    return;
  }
  const analysis = trainerAiAnalysisCache.get(plan, state);
  if (!analysis) {
    container.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "Evaluating the enemy AI from this battle state…" }));
    trainerAiAnalysisCache.resolve(plan, state, () => worker.trainerAi({ plan, state })).then(() => {
      const target = selectedNoteTarget();
      const displayedState = target?.stateNodeId ? plan?.stateNodes?.[target.stateNodeId] : selectedState();
      if (trainerAiAnalysisCache.key(plan, displayedState) === trainerAiAnalysisCache.key(plan, state)) renderTrainerAiNotes(displayedState);
    }).catch(error => {
      const target = selectedNoteTarget();
      const displayedState = target?.stateNodeId ? plan?.stateNodes?.[target.stateNodeId] : selectedState();
      if (trainerAiAnalysisCache.key(plan, displayedState) === trainerAiAnalysisCache.key(plan, state)) {
        container.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: `Enemy AI evaluation failed: ${error.message || String(error)}` }));
      }
    });
    return;
  }
  const nodes = [];
  const turnHeading = document.createElement("h4"); turnHeading.className = "ai-section-title"; turnHeading.textContent = "Move Selection"; nodes.push(turnHeading);
  for (const actor of analysis.actors) {
    const article = document.createElement("details"); article.className = "ai-actor-note";
    const title = document.createElement("summary");
    title.textContent = `${actor.name} · Slot ${slotsPerSide(plan) + actor.slot + 1}${plan.game.battleFormat === "rotation" ? actor.front ? " · currently front" : " · waiting" : ""}`;
    if (actor.forecastStatus === "available") {
      const overview = document.createElement("span");
      overview.className = "ai-collapsed-moves";
      for (const move of actor.moves || []) {
        const line = document.createElement("span"); line.className = "ai-collapsed-move";
        const likelihood = document.createElement("strong");
        likelihood.textContent = move.turnLikelihood?.label || "Forecast error";
        line.append(document.createTextNode(`${move.name}: `), likelihood);
        overview.append(line);
      }
      title.append(overview);
    }
    article.append(title);
    if (actor.forecastStatus !== "available") {
      const error = document.createElement("p");
      error.className = "ai-error-note";
      error.textContent = `Forecast error: ${actor.forecastError || "the complete turn-action pipeline could not be evaluated from this state."}`;
      article.append(error);
      nodes.push(article);
      continue;
    }
    for (const action of actor.actions || []) {
      if (action.action?.type === "move") continue;
      const line = document.createElement("p");
      line.className = `ai-forecast-option likelihood-${action.turnLikelihood?.id || "error"}`;
      const likelihood = document.createElement("strong");
      likelihood.textContent = action.turnLikelihood?.label || "Forecast error";
      const equal = action.equalLikelihood?.labels?.length ? ` Equally likely with ${action.equalLikelihood.labels.join(", ")}.` : "";
      line.append(document.createTextNode(`${action.displayName}: `), likelihood, document.createTextNode(`. ${action.explanation}${equal}`));
      article.append(line);
    }
    for (const move of actor.moves) {
      const option = document.createElement("section");
      option.className = `ai-forecast-option ai-move-forecast likelihood-${move.turnLikelihood?.id || "error"}`;
      const line = document.createElement("p");
      line.className = "ai-move-forecast-heading";
      const likelihood = document.createElement("strong");
      likelihood.textContent = move.turnLikelihood?.label || "Forecast error";
      const equal = move.equalLikelihood?.labels?.length ? ` Equally likely with ${move.equalLikelihood.labels.join(", ")}.` : "";
      line.append(document.createTextNode(`${move.name}: `), likelihood, document.createTextNode(`.${equal}`));
      option.append(line);
      appendAiMoveLedger(option, move);
      if (!move.incentiveLedger && move.evaluatorStatus === "error" && move.explanation) {
        option.append(Object.assign(document.createElement("p"), { className: "ai-error-note", textContent: move.explanation }));
      }
      article.append(option);
    }
    if (!actor.moves.length) article.append(Object.assign(document.createElement("p"), { textContent: "No usable move remains; the game will use Struggle if this Pokémon acts." }));
    nodes.push(article);
  }
  const replacementHeading = document.createElement("h4");
  replacementHeading.className = "ai-section-title";
  replacementHeading.textContent = "Replace on Faint";
  nodes.push(replacementHeading);
  for (const replacement of analysis.replacementForecasts || []) {
    const article = document.createElement("article");
    article.className = "ai-replacement-note";
    const title = document.createElement("h4");
    title.textContent = `If ${replacement.name} faints`;
    article.append(title);
    if (replacement.status === "error") {
      article.append(Object.assign(document.createElement("p"), { className: "ai-error-note", textContent: `Forecast error: ${replacement.error}` }));
    } else if (replacement.status !== "not-applicable") {
      for (const option of replacement.options) {
        const line = document.createElement("p");
        line.className = `ai-forecast-option likelihood-${option.likelihood.id}`;
        const likelihood = document.createElement("strong");
        likelihood.textContent = option.likelihood.label;
        const references = option.highestDamageReferences?.length
          ? option.highestDamageReferences
          : option.highestDamageReference ? [option.highestDamageReference] : [];
        const referencesBySlot = new Map();
        for (const reference of references) {
          const targetSlot = Number(reference.targetSlot);
          if (!Number.isInteger(targetSlot)) continue;
          const moveNames = referencesBySlot.get(targetSlot) || [];
          if (reference.moveName && !moveNames.includes(reference.moveName)) moveNames.push(reference.moveName);
          referencesBySlot.set(targetSlot, moveNames);
        }
        const reasons = [...referencesBySlot.entries()].map(([targetSlot, moveNames]) => {
          if (!moveNames.length) return null;
          return `${moveNames.join(" / ")} ${moveNames.length === 1 ? "is" : "are"} highest damage into Slot ${battleSlotNumber("player", targetSlot)}`;
        }).filter(Boolean);
        line.append(document.createTextNode(`${option.name}: `), likelihood);
        if (reasons.length) line.append(document.createTextNode(` · ${reasons.join(" · ")}`));
        article.append(line);
      }
    }
    nodes.push(article);
  }
  container.replaceChildren(...nodes);
}

function scheduleNotesPersistence() {
  clearTimeout(notesPersistTimer);
  notesPersistTimer = setTimeout(async () => {
    notesPersistTimer = null;
    try {
      await persistDraft();
      if (ui["notes-status"]) ui["notes-status"].textContent = `${ui["notes-status"].textContent.replace(/ · (Saving…|Saved)$/, "")} · Saved`;
    } catch (error) { setStatus(`Notes could not be saved: ${error.message}`, true); }
  }, 300);
}

function updateSelectedNote() {
  const target = selectedNoteTarget();
  if (!target || needsRecalculation) return;
  setStateNodeNote(plan, target.stateNodeId, target.field, ui["node-notes"].value);
  ui["revision-label"].textContent = `Draft r${plan.documentRevision}`;
  ui["notes-status"].textContent = `${target.committed ? "Committed" : "Draft"} Turn ${target.turnNumber} note · Saving…`;
  scheduleNotesPersistence();
}

function defaultPreviewEntry() {
  if (!currentPreview || currentPreview.baseStateNodeId !== cursorStateNodeId) return null;
  const outcomes = currentPreview.outcomes || [];
  return outcomes.find(entry => {
    const state = entry.state || entry;
    return entry.previewOutcomeId === selectedPreviewOutcomeId || state.stateNodeId === selectedPreviewOutcomeId;
  }) || outcomes[0] || null;
}

function renderedStateContext() {
  const committedState = selectedState();
  const entry = defaultPreviewEntry();
  if (!entry) return { state: committedState, committedState, events: null, previewing: false };
  return { state: entry.state || entry, committedState, events: entry.events || entry.state?.events || [], previewing: true };
}

function combatantFor(side, slot = 0) {
  const key = activeKey(selectedState(), side, slot);
  return key ? plan.combatants[key] : null;
}

function currentTrainerName() {
  const trainer = plan && dataset?.trainer(plan.game.trainerId);
  return trainer?.displayName || trainer?.name || plan?.game?.trainerId || "Trainer";
}

function canonicalTarget(move) {
  return String(move?.target || "normal").toLowerCase().replace(/[^a-z]/g, "");
}

function battleFormatLabel(format = plan?.game?.battleFormat) {
  return format === "rotation" ? "Rotation" : format === "triples" ? "Triples" : format === "doubles" ? "Doubles" : "Singles";
}

function legalTargets(state, side, actorKey, targetMode, support = null) {
  const own = activeKeys(state, side).filter(key => Number(state.combatantStates[key]?.hp?.max) > 0);
  const otherSide = side === "player" ? "enemy" : "player";
  const opposing = activeKeys(state, otherSide).filter(key => Number(state.combatantStates[key]?.hp?.max) > 0);
  if (plan?.game?.battleFormat === "rotation") {
    const selectedSlot = actionDraft[otherSide].findIndex(entry => entry?.type === "move");
    const opposingFront = selectedSlot >= 0 ? activeKey(state, otherSide, selectedSlot) : rotationFrontKey(state, otherSide);
    if (targetMode === "adjacentally") return [];
    if (targetMode === "adjacentallyorself") return [actorKey];
    return opposingFront && Number(state.combatantStates[opposingFront]?.hp?.max) > 0 ? [opposingFront] : [];
  }
  if (plan?.game?.battleFormat !== "triples") {
    if (targetMode === "adjacentally") return own.filter(key => key !== actorKey);
    if (targetMode === "adjacentallyorself") return own;
    if (targetMode === "any") return [...opposing, ...own.filter(key => key !== actorKey)];
    return opposing;
  }
  const actorPosition = actorSlot(state, side, actorKey);
  const distanceMove = Boolean(support?.flags?.distance);
  const adjacentOwn = own.filter(key => key !== actorKey && areSlotsAdjacent(plan, side, actorPosition, side, actorSlot(state, side, key)));
  const reachableOpposing = opposing.filter(key => distanceMove || areSlotsAdjacent(plan, side, actorPosition, otherSide, actorSlot(state, otherSide, key)));
  if (targetMode === "adjacentally") return adjacentOwn;
  if (targetMode === "adjacentallyorself") return [actorKey, ...adjacentOwn];
  if (targetMode === "any") return [...reachableOpposing, ...adjacentOwn];
  return reachableOpposing;
}

function battleSlotNumber(side, slot) {
  return battleSlotNumberForPosition(side, triplePositionForSlot(plan, side, slot));
}

function battleSlotNumberForPosition(side, position) {
  return side === "player" ? position + 1 : position + 1 + slotsPerSide(plan);
}

function slotPositionLabel(slot) {
  return ["Left", "Center", "Right"][slot] || "";
}

function tripleFormationPreviewState(state) {
  if (!state || plan?.game?.battleFormat !== "triples") return state;
  const preview = structuredClone(state);
  const shifts = [];
  for (const side of ["player", "enemy"]) {
    for (const entry of activeSlotEntries(state, side)) {
      if (actionForSlot(side, entry.slot).type !== "shift") continue;
      const combatantState = state.combatantStates[entry.combatantKey];
      shifts.push({
        side,
        originalSlot: entry.slot,
        actorKey: entry.combatantKey,
        speed: effectiveActionSpeed({
          combatant: plan.combatants[entry.combatantKey],
          combatantState,
          battleState: state,
          side,
          generation: Number(dataset.mechanics?.damageGeneration || 5)
        })
      });
    }
  }
  const trickRoom = Number(state.fieldState?.global?.trickRoomTurns || 0) > 0;
  shifts.sort((left, right) => (trickRoom ? left.speed - right.speed : right.speed - left.speed)
    || (left.side === right.side ? 0 : left.side === "player" ? -1 : 1)
    || left.originalSlot - right.originalSlot);
  for (const entry of shifts) {
    const shift = shiftWithCenter(preview, entry.side, entry.actorKey);
    if (!shift) continue;
    setActiveKey(preview, entry.side, shift.fromSlot, shift.centerKey);
    setActiveKey(preview, entry.side, shift.centerSlot, entry.actorKey);
  }
  return preview;
}

function targetSlotLabel(state, combatantKey) {
  for (const side of ["player", "enemy"]) {
    const slot = actorSlot(state, side, combatantKey);
    if (slot >= 0) return `Slot ${battleSlotNumber(side, slot)}`;
  }
  return recordName(plan?.combatants?.[combatantKey]);
}

function outcomeTargetSlotLabel(combatantKey) {
  const previewEntry = defaultPreviewEntry();
  const states = [previewEntry?.state || previewEntry, selectedState()].filter(Boolean);
  for (const state of states) {
    for (const side of ["player", "enemy"]) {
      const slot = actorSlot(state, side, combatantKey);
      if (slot >= 0) return `Slot ${battleSlotNumber(side, slot)}`;
    }
  }
  for (const side of ["player", "enemy"]) {
    const actions = Array.isArray(currentPreview?.actions?.[side]) ? currentPreview.actions[side] : [];
    const slot = actions.findIndex(action => action?.switchToKey === combatantKey);
    if (slot >= 0) return `Slot ${battleSlotNumber(side, slot)}`;
  }
  return "Target";
}

function pendingSwitchTargetKey(state, targetKey) {
  for (const side of ["player", "enemy"]) {
    const slot = actorSlot(state, side, targetKey);
    if (slot < 0) continue;
    const draft = actionForSlot(side, slot);
    if (draft.type === "switch" && (draft.switchToKey || draft.previewSwitchToKey)) return draft.switchToKey || draft.previewSwitchToKey;
  }
  return targetKey;
}

function possibleSwitches(state, side, slot = null) {
  if (slot !== null) return eligibleReserves(plan, state, side, slot);
  const active = new Set(activeKeys(state, side));
  return Object.values(plan.combatants).filter(mon => mon.side === side && !active.has(mon.combatantKey) && Number(state.combatantStates[mon.combatantKey]?.hp?.max) > 0);
}

function stateEvents(state, suppliedEvents = null) {
  if (Array.isArray(suppliedEvents)) return suppliedEvents;
  return (state?.resolutionEventIds || []).map(id => plan.resolutionEvents[id]).filter(Boolean);
}

function pathWasChanged(state, path, targetKey = null, suppliedEvents = null) {
  return stateEvents(state, suppliedEvents).some(event => (event.changes || []).some(change => String(change.path).includes(path))
    || (targetKey && event.targetKey === targetKey && path.endsWith(".hp") && ["damage", "heal", "residual-damage", "residual-heal", "recoil"].includes(event.eventType))
    || (targetKey && event.actorKey === targetKey && path.includes(".movePp.") && event.moveId === path.split(".movePp.")[1]));
}

function valueTone(state, key, path, changedFromRoot, { previewChanged = false, events = null } = {}) {
  const initialEntryChange = state?.stateNodeId === plan?.initialStateNodeId && pathWasChanged(state, path, key);
  if (previewChanged || initialEntryChange || (Array.isArray(events) && pathWasChanged(state, path, key, events))) return "value-current";
  return changedFromRoot ? "value-persisted" : "";
}

function stageMultiplier(stage) {
  const value = Number(stage || 0);
  return value >= 0 ? (2 + value) / 2 : 2 / (2 - value);
}

function effectiveStat(base, stage) {
  return Math.floor(Number(base) * stageMultiplier(stage));
}

function formatHpRemaining(hp) {
  const min = Number(hp?.min || 0);
  const max = Number(hp?.max || 0);
  const maxHp = Math.max(1, Number(hp?.maxHp || 1));
  const fraction = min === max ? `${min} / ${maxHp}` : `${min}–${max} / ${maxHp}`;
  const percent = value => `${(value / maxHp * 100).toFixed(1)}%`;
  return `${fraction} (${min === max ? percent(min) : `${percent(min)}–${percent(max)}`})`;
}

function rootCombatantState(key) {
  return plan.stateNodes[plan.initialStateNodeId].combatantStates[key] || selectedState().combatantStates[key];
}

function initialStageBaseline(key, stat) {
  const root = plan.stateNodes[plan.initialStateNodeId];
  const path = `combatantStates.${key}.statStages.${stat}`;
  const initialChange = stateEvents(root).flatMap(event => event.changes || []).find(change => change.path === path);
  return initialChange ? Number(initialChange.from || 0) : Number(root.combatantStates[key]?.statStages?.[stat] || 0);
}

function staticDetail(label, value, className = "") {
  const cell = document.createElement("div"); cell.className = "static-detail";
  if (label) {
    const small = document.createElement("small"); small.textContent = label;
    cell.append(small);
  }
  const strong = document.createElement("strong"); strong.textContent = value; if (className) strong.className = className;
  cell.append(strong); return cell;
}

function actionForSlot(side, slot) {
  actionDraft[side][slot] ||= {};
  return actionDraft[side][slot];
}

function setDraft(side, slot, next) {
  const previous = { ...actionForSlot(side, slot) };
  const preserveRenderedPreview = Boolean(currentPreview
    && previous.type === "move"
    && next.type === "move"
    && previous.moveId === next.moveId
    && previous.targetKey !== next.targetKey
    && previous.mechanicValue === next.mechanicValue);
  if (plan?.game?.battleFormat === "rotation" && next?.type) {
    actionDraft[side] = actionDraft[side].map((entry, index) => index === slot ? entry : {});
  }
  actionDraft[side][slot] = next;
  reviewOutcomeStateNodeId = null;
  if (preserveRenderedPreview) {
    refreshPreview();
    return;
  }
  currentPreview = null;
  branchEventModel = null;
  selectedPreviewOutcomeId = null;
  renderTree();
  renderField();
  renderActionPanels();
  refreshPreview();
}

function configureMoveDraft(side, slot, actorKey, move, support) {
  const state = selectedState();
  const targetMode = support.targetMode || canonicalTarget(move);
  const candidates = legalTargets(state, side, actorKey, targetMode, support);
  const targetKey = support.target === "self" ? actorKey : support.target === "target" ? candidates[0] || null : null;
  setDraft(side, slot, { type: "move", moveId: move.id, targetKey, mechanicValue: null });
}

function chooseBranchEvent(dimensionId, optionId, selectionModel = branchEventModel) {
  if (!currentPreview || !branchEventModel) return;
  reviewOutcomeStateNodeId = null;
  selectedPreviewOutcomeId = selectBranchEventOutcome(
    selectionModel,
    selectedPreviewOutcomeId,
    dimensionId,
    optionId,
    currentPreview.outcomes || []
  );
  renderPreview(currentPreview);
  renderField();
  renderActionPanels();
  renderTree();
  const selected = defaultPreviewEntry();
  ui["commit-turn"].textContent = previewCommitLabel();
  ui.readiness.textContent = selected ? `Crafted outcome ready · ${probabilityLabel(selected.outcome || selected)}` : "Crafted outcome ready.";
}

function renderBranchControl(dimension) {
  const choices = selectedBranchChoices(branchEventModel, selectedPreviewOutcomeId);
  const selected = choices[dimension.id]?.id;
  const control = document.createElement("div"); control.className = "branch-control";
  const label = document.createElement("small"); label.className = "branch-control-label";
  const target = dimension.targetKey ? ` · ${targetSlotLabel(selectedState(), dimension.targetKey)}` : "";
  label.textContent = `${dimension.label}${target}`;
  const buttons = document.createElement("div"); buttons.className = "branch-option-buttons";
  for (const entry of dimension.options) {
    const optionButton = button(entry.label, "branch-option");
    optionButton.setAttribute("aria-pressed", String(entry.id === selected));
    optionButton.addEventListener("click", () => chooseBranchEvent(dimension.id, entry.id));
    buttons.append(optionButton);
  }
  control.append(label, buttons);
  return control;
}

function renderMoveBranchControls(container, actorKey, moveId) {
  const dimensions = (branchEventModel?.dimensions || []).filter(entry => entry.scope === "move" && entry.actorKey === actorKey && entry.moveId === moveId);
  if (!dimensions.length) return;
  const wrapper = document.createElement("div"); wrapper.className = "move-branch-controls";
  const choices = selectedBranchChoices(branchEventModel, selectedPreviewOutcomeId);
  const critical = dimensions.find(entry => entry.kind === "critical");
  const kills = dimensions.filter(entry => entry.kind === "damage-result");
  const addToggle = (label, requirements, fallback) => {
    const matching = required => branchEventModel.outcomeIds.filter(id => {
      const candidate = branchEventModel.choicesByOutcome.get(id) || {};
      return Object.entries(required).every(([key, value]) => candidate[key]?.id === value);
    });
    const outcomeIds = matching(requirements);
    if (!outcomeIds.length) return;
    const selected = Object.entries(requirements).every(([key, value]) => choices[key]?.id === value);
    const control = button(label, "branch-option");
    control.setAttribute("aria-pressed", String(selected));
    control.addEventListener("click", () => {
      const ids = selected ? matching(fallback) : outcomeIds;
      if (!ids.length) return;
      const id = "move-display-selection";
      chooseBranchEvent(id, "selected", { ...branchEventModel, dimensions: [...branchEventModel.dimensions, { id, options: [{ id: "selected", outcomeIds: ids }] }] });
    });
    wrapper.append(control);
  };
  const survive = Object.fromEntries(kills.map(entry => [entry.id, "survive"]));
  if (critical) addToggle("Crit", { [critical.id]: "critical", ...survive }, { [critical.id]: "normal", ...survive });
  for (const dimension of kills) {
    const suffix = kills.length > 1 ? ` · ${targetSlotLabel(selectedState(), dimension.targetKey)}` : "";
    const normal = critical ? { [critical.id]: "normal" } : {};
    addToggle(`Kill${suffix}`, { ...normal, [dimension.id]: "ko" }, { ...normal, [dimension.id]: "survive" });
    if (critical) addToggle(`Crit Kill${suffix}`, { [critical.id]: "critical", [dimension.id]: "ko" }, { [critical.id]: "normal", [dimension.id]: "survive" });
  }
  for (const dimension of dimensions) {
    if (dimension.kind === "accuracy") addToggle("Misses", { [dimension.id]: "miss" }, { [dimension.id]: "hit" });
    if (dimension.kind === "secondary") {
      const applied = dimension.options.find(entry => entry.id === "applied");
      if (applied) addToggle(applied.label, { [dimension.id]: "applied" }, { [dimension.id]: "not-applied" });
    }
  }
  container.append(wrapper);
}

function renderActionAux(container, side, slot, actorKey, move, support, draft) {
  const state = selectedState();
  const targetMode = support.targetMode || canonicalTarget(move);
  const candidates = legalTargets(state, side, actorKey, targetMode, support);
  const opposingTargets = opposingMovePreviewEntries(state, side, actorKey, move, support);
  const opposingKeys = new Set(opposingTargets.map(entry => entry.combatantKey));
  const usesSlotSelection = support.target === "target"
    && candidates.length > 1
    && candidates.every(key => opposingKeys.has(key));
  const aux = document.createElement("div"); aux.className = "action-aux";
  if (support.target === "target" && candidates.length > 1 && !usesSlotSelection) {
    const label = document.createElement("label"); label.textContent = "Target";
    const select = document.createElement("select");
    for (const key of candidates) select.append(option(key, targetSlotLabel(state, key)));
    select.value = candidates.includes(draft.targetKey) ? draft.targetKey : candidates[0];
    if (select.value !== draft.targetKey) draft.targetKey = select.value;
    select.addEventListener("change", () => setDraft(side, slot, { ...draft, targetKey: select.value }));
    label.append(select); aux.append(label);
  }
  const handlerId = support.specialHandlerId;
  const selfSwitch = support.operations?.some(operation => operation.kind === "self-switch");
  const needsCalledMove = ["call-party-move", "call-random-move", "sleep-talk"].includes(handlerId);
  const needsConversion = handlerId === "conversion-2";
  if (selfSwitch || needsCalledMove || needsConversion) {
    const label = document.createElement("label");
    label.textContent = selfSwitch ? "Switch in after move" : needsConversion ? "Resulting type" : "Called move";
    const select = document.createElement("select");
    select.append(option("", "Select…"));
    if (selfSwitch) {
      for (const mon of possibleSwitches(state, side, slot)) select.append(option(mon.combatantKey, recordName(mon)));
    } else if (needsConversion) {
      for (const type of sortedRecords("types")) select.append(option(type.id, type.name));
    } else {
      let moves;
      if (handlerId === "sleep-talk") moves = (plan.combatants[actorKey].moves || []).map(entry => dataset.get("moves", entry.moveId)).filter(entry => entry && entry.id !== "sleeptalk");
      else if (handlerId === "call-party-move") moves = Object.values(plan.combatants).filter(mon => mon.side === side && mon.combatantKey !== actorKey).flatMap(mon => mon.moves.map(entry => dataset.get("moves", entry.moveId))).filter(Boolean);
      else moves = sortedRecords("moves").filter(entry => entry.id !== move.id && moveSupport(entry, dataset).supported);
      for (const candidate of [...new Map(moves.map(entry => [entry.id, entry])).values()]) select.append(option(candidate.id, candidate.name));
    }
    select.value = draft.mechanicValue || "";
    select.addEventListener("change", () => setDraft(side, slot, { ...draft, mechanicValue: select.value }));
    label.append(select); aux.append(label);
  }
  renderMoveBranchControls(aux, actorKey, move.id);
  if (aux.childElementCount) container.append(aux);
}

function previewLabel(result, boundedSlotRange) {
  if (boundedSlotRange) {
    const bounded = boundedSlotDamageLabel(result?.minPercent, result?.maxPercent);
    if (bounded) return bounded;
  }
  return result?.label || (result?.status === "status" ? "Status" : "—");
}

function updateEnemyThreatHighlights(card) {
  if (!card) return;
  const elements = [...card.querySelectorAll("[data-enemy-threat-candidate]")];
  const targetGroups = new Map();
  for (const element of elements) {
    const targetKey = element.dataset.damageTargetKey;
    if (!targetKey) continue;
    if (!targetGroups.has(targetKey)) targetGroups.set(targetKey, []);
    targetGroups.get(targetKey).push(element);
  }
  const candidates = [];
  for (const [targetKey, group] of targetGroups) {
    if (group.some(element => element.dataset.damageResolved !== "true")) continue;
    for (const element of group) candidates.push({
      candidateKey: element.dataset.enemyThreatCandidate,
      targetKey,
      maxPercent: element.dataset.damageMaxPercent
    });
  }
  const highest = highestDamageCandidateKeys(candidates);
  for (const element of elements) {
    const selected = highest.has(element.dataset.enemyThreatCandidate);
    element.classList.toggle("enemy-highest-damage", selected);
    if (selected) {
      element.title = "Highest damage move for this target";
      element.setAttribute("aria-label", `${element.textContent} — highest damage move for this target`);
    } else {
      element.removeAttribute("title");
      element.removeAttribute("aria-label");
    }
  }
}

function applyDamageLabel(span, result, boundedSlotRange) {
  span.textContent = previewLabel(result, boundedSlotRange);
  span.dataset.damageResolved = "true";
  const maximum = Number(result?.maxPercent);
  if (result?.status === "ok" && Number.isFinite(maximum)) span.dataset.damageMaxPercent = String(maximum);
  else delete span.dataset.damageMaxPercent;
  updateEnemyThreatHighlights(span.closest(".combatant-card"));
}

function selectedCriticalPreview(actorKey, moveId) {
  const dimension = branchEventModel?.dimensions?.find(entry => entry.kind === "critical" && entry.actorKey === actorKey && entry.moveId === moveId);
  if (!dimension) return undefined;
  const selected = selectedBranchChoices(branchEventModel, selectedPreviewOutcomeId)[dimension.id]?.id;
  if (selected === "critical") return true;
  if (selected === "normal") return false;
  return undefined;
}

function requestDamageLabel(span, actorKey, targetKey, moveId, { boundedSlotRange = false, enemyThreat = false, positionActorKey = actorKey } = {}) {
  const generation = damageGeneration;
  if (!targetKey) { span.textContent = "Field"; span.dataset.damageResolved = "true"; return; }
  const previewTargetKey = pendingSwitchTargetKey(selectedState(), targetKey);
  span.dataset.damageTargetKey = previewTargetKey;
  if (enemyThreat) span.dataset.enemyThreatCandidate = `${actorKey}|${moveId}|${previewTargetKey}`;
  const previewEntry = defaultPreviewEntry();
  const resolvedPreview = resolvedCombatantMovePreview({
    events: previewEntry?.events || previewEntry?.state?.events || [],
    actorKey,
    targetKey: previewTargetKey,
    moveId
  });
  if (resolvedPreview) {
    applyDamageLabel(span, resolvedPreview, boundedSlotRange);
    return;
  }
  worker.damagePreview({
    plan,
    stateNodeId: cursorStateNodeId,
    actorKey,
    positionActorKey,
    targetKey: previewTargetKey,
    moveId,
    criticalHit: selectedCriticalPreview(actorKey, moveId)
  }).then(result => {
    if (generation === damageGeneration && span.isConnected) applyDamageLabel(span, result, boundedSlotRange);
  }).catch(error => {
    if (generation !== damageGeneration || !span.isConnected) return;
    applyDamageLabel(span, { status: "unavailable", label: error.message.includes("unsupported") ? "Unsupported" : "—" }, boundedSlotRange);
  });
}

function opposingMovePreviewEntries(state, side, actorKey, move, support) {
  if (slotsPerSide(plan) < 2) return [];
  if (["self", "field"].includes(support.target)) return [];
  const opposingSide = side === "player" ? "enemy" : "player";
  const opposing = activeSlotEntries(state, opposingSide)
    .filter(entry => Number(state.combatantStates[entry.combatantKey]?.hp?.max) > 0)
    .sort((left, right) => triplePositionForSlot(plan, opposingSide, left.slot) - triplePositionForSlot(plan, opposingSide, right.slot));
  const targetMode = support.targetMode || canonicalTarget(move);
  const declared = new Set(legalTargets(state, side, actorKey, targetMode, support));
  const formationState = tripleFormationPreviewState(state);
  const previewReachable = new Set(legalTargets(formationState, side, actorKey, targetMode, support));
  return opposing.map(entry => ({
    combatantKey: entry.combatantKey,
    declaredReachable: declared.has(entry.combatantKey),
    previewReachable: previewReachable.has(entry.combatantKey)
  }));
}

function renderDamagePreview(moveButton, side, actorKey, targetKey, moveId, { positionActorKey = actorKey } = {}) {
  const damage = document.createElement("span");
  damage.className = "damage-label";
  damage.textContent = "…";
  moveButton.append(damage);
  requestDamageLabel(damage, actorKey, targetKey, moveId, { enemyThreat: side === "enemy", positionActorKey });
}

function renderSlotDamagePreviews(container, side, slot, actorKey, move, opposingTargets, draft, selectable, { positionActorKey = actorKey } = {}) {
  for (const target of opposingTargets) {
    const opposingKey = target.combatantKey;
    const canSelect = selectable && target.declaredReachable;
    const section = canSelect ? button("", "damage-slot") : document.createElement("span");
    section.className = "damage-slot";
    const slotName = targetSlotLabel(selectedState(), opposingKey);
    section.dataset.slotLabel = slotName;
    const label = document.createElement("small"); label.className = "damage-slot-label"; label.textContent = slotName;
    const value = document.createElement("span"); value.className = "damage-slot-value"; value.textContent = "…";
    section.append(label, value);
    section.classList.toggle("is-out-of-range", !target.previewReachable);
    if (canSelect) {
      section.setAttribute("aria-label", `${move.name} targeting ${slotName}`);
      section.setAttribute("aria-pressed", String(draft.type === "move" && draft.moveId === move.id && draft.targetKey === opposingKey));
      section.addEventListener("click", () => {
        for (const sibling of section.parentElement.querySelectorAll("button.damage-slot")) sibling.setAttribute("aria-pressed", String(sibling === section));
        setDraft(side, slot, { type: "move", moveId: move.id, targetKey: opposingKey, mechanicValue: null });
      });
    }
    container.append(section);
    if (!target.previewReachable) {
      value.textContent = "Out of range";
      value.dataset.damageResolved = "true";
    } else {
      requestDamageLabel(value, actorKey, opposingKey, move.id, { boundedSlotRange: true, enemyThreat: side === "enemy", positionActorKey });
    }
  }
}

function renderSwitchStrip(container, side, slot, actorKey, draft, { replacement = false } = {}) {
  const state = selectedState();
  const strip = document.createElement("div"); strip.className = "switch-strip";
  const current = plan.combatants[actorKey];
  const currentCanStay = current && Number(state.combatantStates[actorKey]?.hp?.max) > 0;
  const candidates = [...(currentCanStay ? [current] : []), ...possibleSwitches(state, side, slot)];
  const previewKey = draft.switchToKey || draft.previewSwitchToKey || (currentCanStay ? actorKey : null);
  for (const mon of candidates) {
    const target = button("", "switch-target");
    target.append(sprite(mon));
    const isCurrent = mon.combatantKey === actorKey;
    const name = document.createElement("span"); name.textContent = `${recordName(mon)}${isCurrent ? " · Current" : ""}`; target.append(name);
    target.classList.toggle("is-current", isCurrent);
    target.setAttribute("aria-label", `${recordName(mon)}${isCurrent ? " (current Pokémon; preview staying in)" : ""}`);
    target.setAttribute("aria-pressed", String(previewKey === mon.combatantKey));
    target.addEventListener("click", () => {
      if (replacement && !isCurrent) {
        const sameSidePending = pendingReplacementSlots(state).filter(entry => entry.side === side);
        const required = replacementRequirement(state, side);
        for (const entry of sameSidePending) {
          if (entry.slot === slot) continue;
          const sibling = actionForSlot(side, entry.slot);
          if (required === 1 || sibling.switchToKey === mon.combatantKey) actionDraft[side][entry.slot] = { type: "switch", actorKey: activeKey(state, side, entry.slot) };
        }
      }
      setDraft(side, slot, isCurrent
        ? { type: "switch", actorKey, previewSwitchToKey: actorKey }
        : { type: "switch", actorKey, switchToKey: mon.combatantKey, previewSwitchToKey: mon.combatantKey });
    });
    strip.append(target);
  }
  if (!candidates.length) strip.append(Object.assign(document.createElement("p"), { className: "empty", textContent: "No healthy bench Pokémon are available." }));
  container.append(strip);
}

function replacementSelectionReady(state) {
  const pending = pendingReplacementSlots(state);
  if (!pending.length) return false;
  return ["player", "enemy"].every(side => {
    const required = replacementRequirement(state, side);
    const selected = pending.filter(entry => entry.side === side).map(entry => actionForSlot(side, entry.slot).switchToKey).filter(Boolean);
    return selected.length === required && new Set(selected).size === selected.length;
  });
}

function replacementRequirement(state, side) {
  const pendingCount = pendingReplacementSlots(state).filter(entry => entry.side === side).length;
  return Math.min(pendingCount, possibleSwitches(state, side).length);
}

function renderCombatantCard(side, slot, { displaySlot = slot } = {}) {
  const { state, committedState, events: previewEvents, previewing } = renderedStateContext();
  const actorKey = activeKey(committedState, side, slot);
  const original = plan.combatants[actorKey];
  const pending = pendingReplacementSlots(committedState).some(entry => entry.side === side && entry.slot === slot);
  let draft = actionForSlot(side, slot);
  const forcedAction = pending ? null : forcedTurnAction(committedState.combatantStates[actorKey]);
  if (forcedAction && draft.type && (draft.type !== "move" || draft.moveId !== forcedAction.moveId)) {
    actionDraft[side][slot] = {};
    draft = actionDraft[side][slot];
  }
  if (draft.type === "shift" && !canSelectShift(plan, committedState, side, actorKey)) {
    actionDraft[side][slot] = {};
    draft = actionDraft[side][slot];
  }
  if (pending && draft.type !== "switch") Object.assign(draft, { type: "switch", actorKey });
  const displayKey = draft.type === "switch" && (draft.switchToKey || draft.previewSwitchToKey) ? draft.switchToKey || draft.previewSwitchToKey : actorKey;
  const mon = plan.combatants[displayKey] || original;
  const committedMonState = committedState.combatantStates[displayKey];
  const monState = state.combatantStates[displayKey] || committedMonState;
  const rootState = rootCombatantState(displayKey);
  const card = document.createElement("article"); card.className = `combatant-card slot-position-${displaySlot}`;
  const rotation = plan.game?.battleFormat === "rotation";
  const rotationFront = rotation && slot === rotationFrontSlot(committedState, side);
  card.classList.toggle("is-rotation-front", rotationFront);
  card.classList.toggle("will-rotate", rotation && draft.type === "move" && !rotationFront);
  card.dataset.side = side;
  card.dataset.actionSlot = String(slot);
  card.dataset.displaySlot = String(displaySlot);
  if (slotsPerSide(plan) > 1) {
    const slotHeading = document.createElement("div");
    slotHeading.className = "combatant-slot-heading";
    const rotationRole = rotation ? ` · ${rotationFront ? "Front" : "Waiting"}` : "";
    slotHeading.textContent = `Slot ${battleSlotNumberForPosition(side, displaySlot)}${plan.game?.battleFormat === "triples" ? ` · ${slotPositionLabel(displaySlot)}` : rotationRole}`;
    card.append(slotHeading);
  }
  const header = document.createElement("div"); header.className = "combatant-header";
  const spriteBox = document.createElement("div"); spriteBox.className = "combatant-sprite"; spriteBox.append(sprite(currentSpriteRecord(mon, monState)));
  const identity = document.createElement("div");
  const name = document.createElement("h3"); name.className = "combatant-name"; name.textContent = recordName(mon);
  if (mon.gender === "M" || mon.gender === "F") {
    const gender = document.createElement("span");
    gender.className = `combatant-gender gender-${mon.gender.toLowerCase()}`;
    gender.textContent = mon.gender === "M" ? "♂" : "♀";
    gender.setAttribute("aria-label", mon.gender === "M" ? "Male" : "Female");
    name.append(" ", gender);
  }
  if (side === "player" && mon.nickname) {
    const species = document.createElement("span"); species.className = "combatant-species"; species.textContent = mon.displayName;
    name.append(" ", species);
  }
  const meta = document.createElement("div"); meta.className = "meta-row";
  const typeIcons = document.createElement("div"); typeIcons.className = "combatant-types";
  const typeChanged = JSON.stringify(monState.currentTypeIds) !== JSON.stringify(rootState.currentTypeIds);
  const typePreviewChanged = previewing && JSON.stringify(monState.currentTypeIds) !== JSON.stringify(committedMonState.currentTypeIds);
  for (const type of monState.currentTypeIds) {
    const chip = document.createElement("span"); chip.className = `combatant-type ${valueTone(state, displayKey, `combatantStates.${displayKey}.currentTypeIds`, typeChanged, { previewChanged: typePreviewChanged, events: previewEvents })}`.trim();
    const label = dataset.get("types", type)?.name || type;
    const icon = document.createElement("img"); icon.alt = label; icon.title = label; icon.width = 85; icon.height = 17;
    chip.append(icon); typeIcons.append(chip);
    if (pokemonAssetResolver) void pokemonAssetResolver.setAssetImage(icon, { kind: "type-icon", presentation: "name", style: "home", locale: "en", type }, { onUnavailable: () => { chip.textContent = label; } });
    else chip.textContent = label;
  }
  meta.append(typeIcons);
  const currentLevel = Number(monState.currentLevel ?? mon.level);
  const rootLevel = Number(rootState.currentLevel ?? mon.level);
  const committedLevel = Number(committedMonState.currentLevel ?? mon.level);
  const levelChip = document.createElement("span");
  levelChip.className = `combatant-level ${valueTone(state, displayKey, `combatantStates.${displayKey}.currentLevel`, currentLevel !== rootLevel, { previewChanged: previewing && currentLevel !== committedLevel, events: previewEvents })}`.trim();
  const nature = dataset.get("natures", mon.natureId) || {};
  const natureBoostedStat = nature?.boostedStat;
  const natureNerfedStat = nature?.nerfedStat;
  let levelText = `Lv. ${currentLevel}`;
  if (side === "player" && Number.isInteger(monState.experience) && mon.growthRate) {
    const levelThreshold = experienceForLevel(currentLevel, mon.growthRate);
    const nextLevelThreshold = currentLevel < 100 ? experienceForLevel(currentLevel + 1, mon.growthRate) : null;
    const levelExperience = Math.max(0, monState.experience - levelThreshold);
    const nextLevelExperience = nextLevelThreshold === null ? "Max" : `${levelExperience.toLocaleString()}/${(nextLevelThreshold - levelThreshold).toLocaleString()}`;
    levelText = `${levelText} · ${nextLevelExperience}`;
  }
  levelChip.textContent = levelText;
  meta.append(levelChip);
  identity.append(name, meta); header.append(spriteBox, identity); card.append(header);
  const details = document.createElement("div"); details.className = "static-details";
  const ability = dataset.get("abilities", monState.currentAbilityId)?.name || "—";
  const item = monState.currentItemId ? dataset.get("items", monState.currentItemId)?.name || monState.currentItemId : "None";
  const hpChanged = monState.hp.min !== rootState.hp.min || monState.hp.max !== rootState.hp.max;
  const statusChanged = monState.majorStatus !== rootState.majorStatus;
  const abilityChanged = monState.currentAbilityId !== rootState.currentAbilityId;
  const itemChanged = monState.currentItemId !== rootState.currentItemId;
  const statCornerStack = document.createElement("div");
  statCornerStack.className = "combatant-corner-stats";
  const hpCell = staticDetail("", formatHpRemaining(monState.hp), valueTone(state, displayKey, `combatantStates.${displayKey}.hp`, hpChanged, { previewChanged: previewing && (monState.hp.min !== committedMonState.hp.min || monState.hp.max !== committedMonState.hp.max || monState.hp.maxHp !== committedMonState.hp.maxHp), events: previewEvents }));
  const statusCell = staticDetail("", monState.majorStatus ? STATUS_LABELS[monState.majorStatus] || monState.majorStatus : "Healthy", valueTone(state, displayKey, `combatantStates.${displayKey}.majorStatus`, statusChanged, { previewChanged: previewing && monState.majorStatus !== committedMonState.majorStatus, events: previewEvents }));
  hpCell.classList.add("combatant-detail-corner");
  statusCell.classList.add("combatant-detail-corner", "combatant-status-detail");
  statusCell.dataset.status = monState.majorStatus || "healthy";
  statCornerStack.append(hpCell, statusCell);
  header.append(statCornerStack);
  details.append(
    staticDetail("Ability", ability, valueTone(state, displayKey, `combatantStates.${displayKey}.currentAbilityId`, abilityChanged, { previewChanged: previewing && monState.currentAbilityId !== committedMonState.currentAbilityId, events: previewEvents })),
    staticDetail("Item", item, valueTone(state, displayKey, `combatantStates.${displayKey}.currentItemId`, itemChanged, { previewChanged: previewing && monState.currentItemId !== committedMonState.currentItemId, events: previewEvents }))
  );
  card.append(details);
  const table = document.createElement("table"); table.className = "stat-table";
  const head = document.createElement("thead"); head.innerHTML = "<tr><th>Stat</th><th>Actual</th><th>Stage</th></tr>"; table.append(head);
  const body = document.createElement("tbody");
  for (const stat of STAT_KEYS.filter(key => key !== "hp")) {
    const stage = Number(monState.statStages[stat] || 0);
    const rootStage = initialStageBaseline(displayKey, stat);
    const committedStage = Number(committedMonState.statStages[stat] || 0);
    const row = document.createElement("tr");
    const label = document.createElement("th"); label.scope = "row"; label.textContent = STAT_LABELS[stat];
    if (natureBoostedStat && natureNerfedStat && natureBoostedStat !== natureNerfedStat) {
      if (stat === natureBoostedStat) label.classList.add("combatant-stat-name-buff");
      if (stat === natureNerfedStat) label.classList.add("combatant-stat-name-debuff");
    }
    const currentBaseStat = Number(monState.currentStats?.[stat] ?? mon.calculatedStats[stat]);
    const rootBaseStat = Number(rootState.currentStats?.[stat] ?? mon.calculatedStats[stat]);
    const committedBaseStat = Number(committedMonState.currentStats?.[stat] ?? mon.calculatedStats[stat]);
    const actual = document.createElement("td"); actual.textContent = effectiveStat(currentBaseStat, stage);
    const changedThisTurn = previewing && (currentBaseStat !== committedBaseStat || stage !== committedStage
      || pathWasChanged(state, `combatantStates.${displayKey}.currentStats.${stat}`, displayKey, previewEvents)
      || pathWasChanged(state, `combatantStates.${displayKey}.statStages.${stat}`, displayKey, previewEvents))
      || state.stateNodeId === plan.initialStateNodeId && (
        pathWasChanged(state, `combatantStates.${displayKey}.currentStats.${stat}`, displayKey)
        || pathWasChanged(state, `combatantStates.${displayKey}.statStages.${stat}`, displayKey)
      );
    actual.className = changedThisTurn ? "value-current" : currentBaseStat !== rootBaseStat || stage !== rootStage ? "value-persisted" : "";
    const stageCell = document.createElement("td"); stageCell.textContent = stage ? `${stage > 0 ? "+" : ""}${stage}` : "—"; stageCell.className = actual.className;
    row.append(label, actual, stageCell); body.append(row);
  }
  table.append(body); card.append(table);
  const moveActions = document.createElement("div"); moveActions.className = "move-actions";
  const moves = committedMonState.moveSetOverride || mon.moves;
  for (const entry of moves) {
      const move = dataset.get("moves", entry.moveId);
      const support = moveSupport(move, dataset);
      const moveButton = button("", "move-button");
      moveButton.dataset.moveType = String(entry.typeOverride || move?.type || "unknown").toLowerCase();
      const positionSelected = draft.type === "switch" || draft.type === "shift";
      const isForcedMove = Boolean(forcedAction?.moveId && forcedAction.moveId === entry.moveId);
      const forcedDisabled = Boolean(forcedAction && (forcedAction.kind === "recharge" || !isForcedMove));
      moveButton.disabled = positionSelected || forcedDisabled || !support.supported || Number(committedMonState.movePp?.[entry.moveId] ?? entry.maxPp) <= 0;
      moveButton.title = forcedAction?.kind === "recharge"
        ? "This Pokémon must recharge"
        : forcedAction && !isForcedMove
          ? `This Pokémon must continue ${dataset.get("moves", forcedAction.moveId)?.name || forcedAction.moveId}`
          : draft.type === "switch" ? "Switch is selected for this slot" : draft.type === "shift" ? "Shift is selected for this slot" : support.supported ? "" : support.reason;
      moveButton.setAttribute("aria-pressed", String((draft.type === "move" && draft.moveId === entry.moveId) || (forcedAction?.kind === "recharge" && isForcedMove)));
      const copy = document.createElement("span"); copy.className = "move-copy";
      const moveName = document.createElement("strong"); moveName.textContent = move?.name || entry.moveId;
      const currentPp = monState.movePp?.[entry.moveId] ?? entry.maxPp;
      const rootPp = rootState.movePp?.[entry.moveId] ?? entry.maxPp;
      const moveBp = move?.basePower ?? move?.bp;
      const moveAccuracy = move?.accuracy;
      const metaParts = [];
      if (moveBp && moveBp !== 0 && moveBp !== "0") metaParts.push(`${moveBp} BP`);
      if (moveAccuracy && moveAccuracy !== true && moveAccuracy !== "true") metaParts.push(`${moveAccuracy} AC`);
      metaParts.push(`${currentPp} PP`);
      const moveMeta = document.createElement("small");
      moveMeta.textContent = `${metaParts.join(" · ")}${support.supported ? "" : " · unsupported"}`;
      moveMeta.className = valueTone(state, displayKey, `combatantStates.${displayKey}.movePp.${entry.moveId}`, currentPp !== rootPp, { previewChanged: previewing && currentPp !== Number(committedMonState.movePp?.[entry.moveId] ?? entry.maxPp), events: previewEvents });
      copy.append(moveName, moveMeta);
      moveButton.append(copy);
      moveButton.addEventListener("click", () => configureMoveDraft(side, slot, actorKey, move, support));
      if (forcedAction?.kind === "recharge" && isForcedMove) {
        const damage = document.createElement("span"); damage.className = "damage-label"; damage.textContent = "Recharge"; moveButton.append(damage);
        moveActions.append(moveButton);
      } else if (support.supported) {
        const targetMode = support.targetMode || canonicalTarget(move);
        const candidates = legalTargets(committedState, side, actorKey, targetMode, support);
        const targetKey = support.target === "self" ? actorKey : support.target === "field" ? null : draft.moveId === move.id && draft.targetKey ? draft.targetKey : candidates[0];
        const opposingTargets = opposingMovePreviewEntries(committedState, side, actorKey, move, support);
        const opposingKeys = new Set(opposingTargets.map(target => target.combatantKey));
        const selectableSlots = !positionSelected
          && support.target === "target"
          && candidates.length > 0
          && candidates.every(key => opposingKeys.has(key));
        if (opposingTargets.length) {
          const group = document.createElement("div"); group.className = "move-button-group";
          group.append(moveButton);
          renderSlotDamagePreviews(group, side, slot, displayKey, move, opposingTargets, draft, selectableSlots, { positionActorKey: actorKey });
          moveActions.append(group);
        } else {
          renderDamagePreview(moveButton, side, displayKey, targetKey, move.id, { positionActorKey: actorKey });
          moveActions.append(moveButton);
        }
      } else {
        const damage = document.createElement("span"); damage.className = "damage-label"; damage.textContent = "Unsupported"; moveButton.append(damage);
        moveActions.append(moveButton);
      }
    if (draft.type === "move" && draft.moveId === entry.moveId) renderActionAux(moveActions, side, slot, actorKey, move, support, draft);
  }
  if (!pending && !forcedAction && canSelectShift(plan, committedState, side, actorKey)) {
    const shiftButton = button(`Shift with Slot ${battleSlotNumberForPosition(side, 1)}`, "shift-button");
    shiftButton.setAttribute("aria-pressed", String(draft.type === "shift"));
    shiftButton.addEventListener("click", () => draft.type === "shift"
      ? setDraft(side, slot, {})
      : setDraft(side, slot, { type: "shift", actorKey }));
    moveActions.append(shiftButton);
  }
  if (pending) {
    const replacementCount = replacementRequirement(committedState, side);
    const prompt = document.createElement("p");
    prompt.className = "replacement-prompt";
    prompt.textContent = `Choose Replacement${replacementCount > 1 ? "s" : ""}`;
    moveActions.append(prompt);
    renderSwitchStrip(moveActions, side, slot, actorKey, draft, { replacement: true });
  } else {
    const switchButton = button("Switch", "switch-button");
    switchButton.setAttribute("aria-pressed", String(draft.type === "switch"));
    switchButton.disabled = Boolean(forcedAction) || (rotation && !rotationFront);
    if (forcedAction?.kind === "recharge") switchButton.title = "This Pokémon must recharge";
    else if (forcedAction) switchButton.title = `This Pokémon must continue ${dataset.get("moves", forcedAction.moveId)?.name || forcedAction.moveId}`;
    else if (switchButton.disabled) switchButton.title = "Rotate this Pokémon to the front before switching it out";
    switchButton.addEventListener("click", () => {
      if (draft.type === "switch") setDraft(side, slot, {});
      else setDraft(side, slot, { type: "switch", actorKey });
    });
    moveActions.append(switchButton);
    if (draft.type === "switch") renderSwitchStrip(moveActions, side, slot, actorKey, draft);
  }
  card.append(moveActions);
  if (freeCalcSession) card.append(renderFreeCalcEditor(side, slot, actorKey));
  if (side === "enemy") updateEnemyThreatHighlights(card);
  return card;
}

function slotIsEmpty(state, side, slot) {
  const key = activeKey(state, side, slot);
  if (!key) return true;
  const pending = pendingReplacementSlots(state).some(entry => entry.side === side && entry.slot === slot);
  return !pending && Number(state.combatantStates[key]?.hp?.max) <= 0;
}

function renderEmptyCombatantSlot(side, slot, { displaySlot = triplePositionForSlot(plan, side, slot) } = {}) {
  const card = document.createElement("article");
  card.className = `combatant-card empty-combatant-slot slot-position-${displaySlot}`;
  card.dataset.side = side;
  card.dataset.actionSlot = String(slot);
  card.dataset.displaySlot = String(displaySlot);
  const slotHeading = document.createElement("div");
  slotHeading.className = "combatant-slot-heading";
  const rotationRole = plan.game?.battleFormat === "rotation" ? ` · ${slot === rotationFrontSlot(selectedState(), side) ? "Front" : "Waiting"}` : "";
  slotHeading.textContent = `Slot ${battleSlotNumberForPosition(side, displaySlot)}${plan.game?.battleFormat === "triples" ? ` · ${slotPositionLabel(displaySlot)}` : rotationRole}`;
  const empty = document.createElement("p");
  empty.className = "empty-slot-label";
  empty.textContent = "Empty slot";
  card.append(slotHeading, empty);
  if (freeCalcSession) card.append(renderFreeCalcEditor(side, slot, activeKey(selectedState(), side, slot)));
  return card;
}

function renderActionPanel(side) {
  const panel = ui[`${side}-action-panel`];
  const doubles = plan.game.battleFormat === "doubles";
  const triples = plan.game.battleFormat === "triples";
  const rotation = plan.game.battleFormat === "rotation";
  panel.classList.toggle("is-doubles", doubles);
  panel.classList.toggle("is-triples", triples);
  panel.classList.toggle("is-rotation", rotation);
  panel.classList.toggle("is-player", side === "player");
  panel.classList.toggle("is-enemy", side === "enemy");
  const heading = document.createElement("div"); heading.className = "action-panel-title";
  const title = document.createElement("h2"); title.textContent = `${side === "player" ? "Player" : "Enemy"} Action`;
  const format = document.createElement("span"); format.className = "pill"; format.textContent = battleFormatLabel();
  heading.append(title, format);
  const state = selectedState();
  const formationState = triples ? tripleFormationPreviewState(state) : state;
  const slots = Array.from({ length: slotsPerSide(plan) }, (_, slot) => slot);
  const cards = slots.map(displaySlot => {
    const formationSlot = triples ? tripleSlotForPosition(plan, side, displaySlot) : displaySlot;
    if (slotIsEmpty(formationState, side, formationSlot)) return renderEmptyCombatantSlot(side, formationSlot, { displaySlot });
    const displayKey = activeKey(formationState, side, formationSlot);
    const actionSlot = actorSlot(state, side, displayKey);
    return renderCombatantCard(side, actionSlot >= 0 ? actionSlot : formationSlot, { displaySlot });
  });
  const cardGrid = document.createElement("div"); cardGrid.className = "action-panel-cards"; cardGrid.append(...cards);
  panel.replaceChildren(heading, cardGrid);
}

function renderActionPanels() {
  if (!plan) return;
  damageGeneration += 1;
  renderActionPanel("player");
  renderActionPanel("enemy");
}

function actionFromDraft(side, slot) {
  const state = selectedState();
  const actorKey = activeKey(state, side, slot);
  const draft = actionForSlot(side, slot);
  const pending = pendingReplacementSlots(state).some(entry => entry.side === side && entry.slot === slot);
  if (pending) return draft.switchToKey ? { actionType: "replacement", side, slot, switchToKey: draft.switchToKey, reason: "previous-active-fainted", consumesTurn: false } : null;
  const forcedAction = forcedTurnAction(state.combatantStates[actorKey]);
  if (forcedAction?.kind === "recharge") {
    return forcedAction.moveId
      ? { actionType: "move", actorKey, moveId: forcedAction.moveId, targetKeys: [], mechanicActivations: [], declaredAtStateHash: state.stateHash }
      : null;
  }
  if (draft.type === "switch") return draft.switchToKey ? { actionType: "switch", actorKey, switchToKey: draft.switchToKey, switchKind: "voluntary", declaredAtStateHash: state.stateHash } : null;
  if (draft.type === "shift") return { actionType: "shift", actorKey, declaredAtStateHash: state.stateHash };
  if (draft.type !== "move" || !draft.moveId) return null;
  const move = dataset.get("moves", draft.moveId);
  const support = moveSupport(move, dataset);
  if (!support.supported) return null;
  const mode = support.targetMode || canonicalTarget(move);
  const opponent = side === "player" ? "enemy" : "player";
  const targetKeys = support.target === "self" ? [actorKey]
    : support.target === "field" ? []
      : support.target === "automatic" && plan.game?.battleFormat === "rotation" ? [rotationFrontKey(state, opponent)].filter(Boolean)
      : support.target === "automatic" ? mode === "alladjacent" ? [...activeKeys(state, opponent), ...activeKeys(state, side).filter(key => key !== actorKey)]
        : mode === "all" ? [...activeKeys(state, "player"), ...activeKeys(state, "enemy")] : activeKeys(state, opponent)
        : draft.targetKey ? [draft.targetKey] : [];
  const selfSwitch = support.operations?.some(operation => operation.kind === "self-switch");
  const special = ["call-party-move", "call-random-move", "sleep-talk", "conversion-2"].includes(support.specialHandlerId);
  if ((selfSwitch || special) && !draft.mechanicValue) return null;
  const mechanicActivations = selfSwitch ? [{ id: "after-move-switch", switchToKey: draft.mechanicValue }]
    : support.specialHandlerId === "conversion-2" ? [{ id: "conversion-type", typeId: draft.mechanicValue }]
      : special ? [{ id: "called-move", moveId: draft.mechanicValue, ...(targetKeys[0] ? { targetKey: targetKeys[0] } : {}) }] : [];
  return { actionType: "move", actorKey, moveId: draft.moveId, targetKeys, mechanicActivations, declaredAtStateHash: state.stateHash };
}

function actionsFromDraft() {
  const state = selectedState();
  const pending = pendingReplacementSlots(state);
  if (pending.length) {
    const replacements = { player: [], enemy: [] };
    for (const entry of pending) {
      const replacement = actionFromDraft(entry.side, entry.slot);
      if (replacement) replacements[entry.side].push(replacement);
    }
    const ready = ["player", "enemy"].every(side => replacements[side].length === replacementRequirement(state, side));
    return ready ? replacements : null;
  }
  const actions = { player: [], enemy: [] };
  for (const side of ["player", "enemy"]) {
    const sideActions = activeSlotEntries(state, side)
      .filter(entry => Number(state.combatantStates[entry.combatantKey]?.hp?.max) > 0)
      .map(entry => actionFromDraft(side, entry.slot));
    actions[side] = plan.game?.battleFormat === "rotation" ? sideActions.filter(Boolean) : sideActions;
  }
  if (plan.game?.battleFormat === "rotation") return actions.player.length === 1 && actions.enemy.length === 1 ? actions : null;
  return [...actions.player, ...actions.enemy].every(Boolean) ? actions : null;
}

function selectedReplacementDraftActions() {
  const state = selectedState();
  const replacements = { player: [], enemy: [] };
  for (const entry of pendingReplacementSlots(state)) {
    const replacement = actionFromDraft(entry.side, entry.slot);
    if (replacement) replacements[entry.side].push(replacement);
  }
  return replacements;
}

function probabilityLabel(outcome) {
  if (!Number.isFinite(outcome?.probability)) return "Probability unknown";
  const suffix = outcome.probabilityStatus === "tied" ? " · tied" : "";
  return `${(outcome.probability * 100).toFixed(2).replace(/\.00$/, "")}%${suffix}`;
}

function battleActuallyEnded(state) {
  return battleCompletionState(plan, state).ended;
}

function battleVictory(state) {
  return battleCompletionState(plan, state).victory;
}

function selectedPreviewState() {
  const entry = defaultPreviewEntry();
  return entry?.state || entry || null;
}

function selectedPreviewBattleEnded() {
  const state = selectedPreviewState();
  return Boolean(state?.battleEnded) || battleCompletionState(plan, state).ended;
}

function previewCommitLabel() {
  if (!currentPreview) return "Next Turn";
  if (currentPreview.previewKind === "replacement") return replacementCommitLabel(plan, cursorStateNodeId, currentPreview.replacements);
  if (selectedPreviewBattleEnded()) return battleCompletionState(plan, selectedPreviewState()).commitLabel;
  if (currentPreview.previewStatus === "existing-expanded") {
    return currentPreview.savedPreviewOutcomeIds?.includes(selectedPreviewOutcomeId) ? "Open Branch" : "New Branch";
  }
  return commitLabel(plan, cursorStateNodeId, currentPreview.actions);
}

function koChance(rolls, hp, hits) {
  let distribution = new Map([[0, 1]]);
  for (let count = 0; count < hits; count += 1) {
    const next = new Map();
    for (const [total, frequency] of distribution) {
      for (const roll of rolls) next.set(total + roll, (next.get(total + roll) || 0) + frequency);
    }
    distribution = next;
  }
  const all = [...distribution.values()].reduce((sum, value) => sum + value, 0);
  const successful = [...distribution.entries()].filter(([total]) => total >= hp).reduce((sum, [, value]) => sum + value, 0);
  return successful / all;
}

function koDescription(rolls, targetHp) {
  const values = rolls.map(Number).filter(Number.isFinite);
  const hp = Number(targetHp);
  if (!values.length || !Number.isFinite(hp) || hp <= 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (let hits = 1; hits <= 9; hits += 1) {
    if (max * hits < hp) continue;
    const label = hits === 1 ? "OHKO" : `${hits}HKO`;
    if (min * hits >= hp) return `Guaranteed ${label}`;
    if (hits <= 4) {
      const chance = koChance(values, hp, hits) * 100;
      return `${chance.toFixed(chance < 1 ? 2 : 1).replace(/\.0$/, "")}% chance to ${label}`;
    }
    return `Possible ${label}`;
  }
  return "More than 9 hits to KO";
}

function eventDescription(event) {
  const move = dataset.get("moves", event.moveId || event.metadata?.moveId);
  const healingTargetKey = event.targetKey || event.actorKey;
  const healingStates = [defaultPreviewEntry()?.state || defaultPreviewEntry(), selectedState()].filter(Boolean);
  const healingMaxHp = healingStates.map(state => Number(state.combatantStates?.[healingTargetKey]?.hp?.maxHp)).find(Number.isFinite);
  const healing = healingEventDescription(event, { moveName: move?.name || null, maxHp: healingMaxHp });
  if (healing) return { line: healing };
  const targetPrefix = event.targetKey && event.targetKey !== event.actorKey ? outcomeTargetSlotLabel(event.targetKey) : null;
  if (event.eventType === "shift") {
    const actor = plan.combatants[event.actorKey];
    const side = actor?.side || "player";
    const slot = Number(event.metadata?.toSlot);
    return { line: `Shifted to Slot ${battleSlotNumber(side, Number.isInteger(slot) ? slot : 1)}` };
  }
  if (event.eventType === "damage") {
    const damage = event.damageHp || {};
    const percent = event.damagePercent || {};
    const rolls = (event.metadata?.damageRolls || []).map(Number).filter(Number.isFinite);
    const hpBefore = Number(event.metadata?.targetHpBefore?.max ?? event.metadata?.targetHpBefore?.min);
    const ko = koDescription(rolls.length ? rolls : [damage.min, damage.max], hpBefore);
    const critical = event.metadata?.criticalHit === true ? " · Critical hit" : "";
    return {
      line: [targetPrefix, move?.name || event.moveId, `${damage.min}-${damage.max} (${Number(percent.min).toFixed(1)} - ${Number(percent.max).toFixed(1)}%)${critical}`].filter(Boolean).join(" · "),
      trailing: [ko || null, rolls.length ? `Possible damage amounts: (${formatDamageRollCounts(rolls)})` : null].filter(Boolean)
    };
  }
  if (event.eventType === "move-redirected") return { line: [`Redirected to ${outcomeTargetSlotLabel(event.targetKey)}`, move?.name || event.moveId].filter(Boolean).join(" · ") };
  if (event.eventType === "switch") {
    const slotLabel = outcomeTargetSlotLabel(event.targetKey);
    const forced = event.metadata?.switchKind === "forced" || event.metadata?.phase === "start-of-turn-replacement";
    if (forced) return { line: `Entered ${slotLabel}` };
    return { line: `${slotLabel} · Switched to ${recordName(plan.combatants[event.targetKey])}` };
  }
  if (event.eventType === "combatant-fainted") return { line: `${outcomeTargetSlotLabel(event.targetKey)} · Fainted` };
  if (event.eventType === "stat-stage-change" && move) {
    return {
      line: [targetPrefix, move.name].filter(Boolean).join(" · "),
      subline: event.metadata?.resultLabel || "Stats changed"
    };
  }
  const parts = [targetPrefix, move?.name, event.metadata?.resultLabel || event.reason || event.eventType].filter(Boolean);
  return { line: parts.join(" · ") };
}

function outcomeEventGroupKey(event, index) {
  if (event.eventType === "switch") return `switch:${index}`;
  if (event.eventType === "combatant-fainted") return `fainted:${event.targetKey}:${index}`;
  if (event.moveId && event.actorKey) return `move:${event.actorKey}:${event.moveId}`;
  if (event.metadata?.cause && event.actorKey) return `cause:${event.actorKey}:${event.metadata.cause}`;
  if (event.eventType === "battle-ended") return `battle-ended:${index}`;
  return `${event.eventType}:${event.actorKey || event.targetKey || "field"}`;
}

function outcomeGroupSpriteKeys(group) {
  const first = group.events[0];
  if (!first) return [];
  if (first.eventType === "switch") {
    const forced = first.metadata?.switchKind === "forced" || first.metadata?.phase === "start-of-turn-replacement";
    return forced ? [first.targetKey] : [first.actorKey, first.targetKey].filter(Boolean);
  }
  if (first.eventType === "combatant-fainted") return [first.targetKey].filter(Boolean);
  return [first.actorKey || first.targetKey].filter(Boolean);
}

function outcomeActionGroups(events) {
  const groups = [];
  for (const [index, event] of events.entries()) {
    const groupKey = outcomeEventGroupKey(event, index);
    const previous = groups.at(-1);
    if (previous && previous.groupKey === groupKey) previous.events.push(event);
    else groups.push({ groupKey, events: [event] });
  }
  const presented = [];
  for (const group of groups) {
    group.spriteKeys = outcomeGroupSpriteKeys(group);
    presented.push(group);
    const faintedKeys = [...new Set(group.events
      .filter(event => ["damage", "residual-damage"].includes(event.eventType) && event.metadata?.thresholdOutcome === "ko")
      .map(event => event.targetKey)
      .filter(Boolean))];
    for (const targetKey of faintedKeys) {
      presented.push({
        groupKey: `fainted:${targetKey}`,
        spriteKeys: [targetKey],
        events: [{ eventType: "combatant-fainted", actorKey: null, targetKey, moveId: null, metadata: {} }]
      });
    }
  }
  return presented;
}

function renderOutcomeAction(group, fallbackLabel = null) {
  const item = document.createElement("li"); item.className = "outcome-action";
  const spriteBox = document.createElement("div"); spriteBox.className = "outcome-action-sprite";
  const spriteKeys = [...new Set(group.spriteKeys || [])];
  item.classList.toggle("has-two-sprites", spriteKeys.length > 1);
  for (const combatantKey of spriteKeys) {
    const mon = plan.combatants[combatantKey];
    if (mon) spriteBox.append(sprite(mon, `${recordName(mon)} sprite`));
  }
  if (!spriteBox.childElementCount) spriteBox.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div"); copy.className = "outcome-action-copy";
  const appendLine = (text, className = "event-line") => {
    const line = document.createElement("p"); line.className = className; line.textContent = text;
    copy.append(line);
    return line;
  };
  const abilityStatEvents = group.events.length && group.events.every(event =>
    event.eventType === "stat-stage-change" && !event.moveId && event.metadata?.cause === group.events[0].metadata?.cause
  );
  if (abilityStatEvents) {
    appendLine(readableMechanicName(group.events[0].metadata.cause));
    for (const event of group.events) {
      const target = event.targetKey && event.targetKey !== event.actorKey ? outcomeTargetSlotLabel(event.targetKey) : null;
      appendLine([target, event.metadata?.resultLabel || "Stats changed"].filter(Boolean).join(" · "), "outcome-effect-line");
    }
  } else {
    let pendingDamage = null;
    const flushDamageDetails = () => {
      if (!pendingDamage) return;
      for (const trailing of pendingDamage.trailing) {
        const amounts = document.createElement("p"); amounts.className = "damage-amounts"; amounts.textContent = trailing;
        pendingDamage.detail.append(amounts);
      }
      pendingDamage = null;
    };
    for (const event of group.events) {
      const extendsDamage = event.eventType === "stat-stage-change"
        && event.moveId
        && pendingDamage?.event.moveId === event.moveId
        && pendingDamage.event.targetKey === event.targetKey;
      if (extendsDamage) {
        const effect = document.createElement("p"); effect.className = "outcome-effect-line";
        effect.textContent = event.metadata?.resultLabel || "Stats changed";
        pendingDamage.detail.append(effect);
        continue;
      }
      flushDamageDetails();
      const description = eventDescription(event);
      const detail = document.createElement("div"); detail.className = "outcome-event-detail";
      const line = document.createElement("p"); line.className = "event-line"; line.textContent = description.line;
      if (event.eventType === "battle-ended") line.classList.add("battle-ended-text");
      detail.append(line);
      if (description.subline) {
        const effect = document.createElement("p"); effect.className = "outcome-effect-line"; effect.textContent = description.subline;
        detail.append(effect);
      }
      copy.append(detail);
      if (event.eventType === "damage") pendingDamage = { event, detail, trailing: description.trailing || [] };
      else for (const trailing of description.trailing || []) {
        const amounts = document.createElement("p"); amounts.className = "damage-amounts"; amounts.textContent = trailing;
        detail.append(amounts);
      }
    }
    flushDamageDetails();
  }
  if (!group.events.length && fallbackLabel) {
    appendLine(fallbackLabel);
  }
  item.append(spriteBox, copy);
  return item;
}

function outcomeSplitReason(entry, allEntries) {
  const outcome = entry.outcome || entry;
  const events = outcomePanelEvents(entry.events || []);
  const orderModifier = events.find(event => event.eventType === "order-modifier" && event.metadata?.activated === true);
  if (orderModifier) return orderModifier.metadata.resultLabel || `${orderModifier.metadata.sourceName || "Action order"} activated`;
  const criticalOhko = isCriticalOhkoOutcome(entry);
  const highRollKo = isHighRollKoOutcome(entry, allEntries);
  if (criticalOhko) return "Critical-hit OHKO";
  if (highRollKo) return "Damage high roll caused a KO";
  const miss = events.find(event => event.eventType === "miss");
  if (miss) return `${dataset.get("moves", miss.moveId)?.name || miss.moveId} missed`;
  const skipped = events.find(event => event.eventType === "action-skipped");
  if (skipped) return skipped.metadata?.resultLabel || skipped.reason || "Action skipped";
  const noSecondary = events.find(event => event.eventType === "secondary-effect-missed");
  if (noSecondary) return `${dataset.get("moves", noSecondary.moveId)?.name || noSecondary.moveId}: no secondary effect`;
  const critical = events.find(event => event.eventType === "damage" && event.metadata?.criticalHit === true);
  if (critical) return `${dataset.get("moves", critical.moveId)?.name || critical.moveId} landed a critical hit`;
  const branchingEffect = events.find(event => [
    "ability-change", "form-change", "major-status", "volatile-status", "status-failed", "volatile-status-failed", "move-blocked", "move-immune",
    "protect", "stat-stage-change", "heal", "field-change", "confusion-self-hit"
  ].includes(event.eventType) && event.metadata?.resultLabel);
  if (branchingEffect) return branchingEffect.metadata.resultLabel;
  const ko = events.find(event => event.eventType === "damage" && event.metadata?.thresholdOutcome === "ko");
  if (ko) return `${recordName(plan.combatants[ko.targetKey])} fainted`;
  const conditions = (outcome.conditions || []).map(condition => condition.expression).filter(Boolean);
  if (conditions.length) return conditions.map(condition => condition.startsWith("speed-tie:") ? "Speed-tie order" : condition).join(" · ");
  return outcome.label || entry.displaySnapshot?.outcomeLabel || "Resolved outcome";
}

function renderPreview(preview) {
  const entry = defaultPreviewEntry();
  if (!entry) {
    ui["preview-outcomes"].replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "No crafted outcome is available." }));
    return;
  }
  const nodes = [];
  const centralDimensions = (branchEventModel?.dimensions || []).filter(dimension => dimension.scope !== "move");
  if (centralDimensions.length) {
    const controls = document.createElement("section"); controls.className = "branch-event-controls";
    const heading = document.createElement("h3"); heading.textContent = "Action checks";
    controls.append(heading);
    for (const dimension of centralDimensions) controls.append(renderBranchControl(dimension));
    nodes.push(controls);
  }
  const outcome = entry.outcome || entry;
  const events = outcomePanelEvents(entry.events || []);
  const card = document.createElement("article"); card.className = "outcome crafted-outcome";
  const victory = battleVictory(entry.state || entry);
  card.classList.toggle("battle-victory", victory);
  const reason = document.createElement("p"); reason.className = "outcome-reason"; reason.textContent = outcomeSplitReason(entry, preview.outcomes || []);
  const list = document.createElement("ul"); list.className = "outcome-events";
  for (const group of outcomeActionGroups(events)) list.append(renderOutcomeAction(group));
  if (!list.childElementCount) {
    list.append(renderOutcomeAction({ displayKey: null, events: [] }, outcome.label || entry.displaySnapshot?.outcomeLabel || "Resolved outcome"));
  }
  if (victory && !events.some(event => event.eventType === "battle-ended")) {
    const endedItem = renderOutcomeAction({ displayKey: null, events: [] }, "Battle ended");
    endedItem.querySelector(".event-line")?.classList.add("battle-ended-text");
    list.append(endedItem);
  }
  const probability = document.createElement("p"); probability.className = "outcome-probability"; probability.textContent = `Crafted outcome probability · ${probabilityLabel(outcome)}`;
  card.append(reason, list, probability);
  nodes.push(card);
  ui["preview-outcomes"].replaceChildren(...nodes);
}

function clearPreview(message = "Complete every active Pokémon's action to calculate the turn.") {
  const hadPreview = Boolean(currentPreview);
  currentPreview = null;
  branchEventModel = null;
  selectedPreviewOutcomeId = null;
  ui["commit-turn"].disabled = true;
  ui["preview-outcomes"].replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: message }));
  if (hadPreview && plan) { renderTree(); renderField(); renderActionPanels(); }
}

async function refreshPreview() {
  if (!plan || !worker || needsRecalculation) return;
  const battleEndRepair = repairStaleLeafBattleEnd(plan, cursorStateNodeId);
  if (battleEndRepair.changed) {
    plan = battleEndRepair.plan;
    await persistDraft();
  }
  const generation = ++previewGeneration;
  const priorOutcomeId = selectedPreviewOutcomeId;
  const actions = actionsFromDraft();
  const replacement = pendingReplacementSlots(selectedState()).length > 0;
  if (!actions) {
    ui.readiness.textContent = replacement ? "Select every required replacement." : "Choose an action for every active Pokémon.";
    clearPreview();
    return;
  }
  ui.readiness.textContent = "Resolving every supported outcome…";
  ui["commit-turn"].disabled = true;
  try {
    const preview = replacement
      ? { ...previewForcedReplacement({ plan, parentStateNodeId: cursorStateNodeId, replacements: actions, dataset }), previewKind: "replacement" }
      : await worker.preview({ plan, parentStateNodeId: cursorStateNodeId, actions, expandExisting: true });
    if (generation !== previewGeneration) return;
    currentPreview = preview;
    branchEventModel = createBranchEventModel({ outcomes: preview.outcomes || [], actions: preview.actions || actions, defaultOutcomeId: preview.defaultPreviewOutcomeId });
    selectedPreviewOutcomeId = branchEventModel.outcomeIds.includes(priorOutcomeId) ? priorOutcomeId : branchEventModel.selectedOutcomeId;
    if (reviewOutcomeStateNodeId && preview.savedOutcomeStateNodeIdByPreviewOutcomeId) {
      const reviewed = Object.entries(preview.savedOutcomeStateNodeIdByPreviewOutcomeId).find(([, stateId]) => stateId === reviewOutcomeStateNodeId)?.[0];
      if (reviewed) selectedPreviewOutcomeId = reviewed;
      else reviewOutcomeStateNodeId = null;
    }
    renderPreview(preview);
    renderField();
    renderActionPanels();
    renderTree();
    ui.readiness.textContent = preview.previewStatus.startsWith("existing")
      ? "This exact action set already exists."
      : `${preview.outcomes.length} resolver possibilities condensed into one crafted outcome.`;
    ui["commit-turn"].textContent = previewCommitLabel();
    ui["commit-turn"].disabled = false;
  } catch (error) {
    if (error.name === "StalePreviewError" || generation !== previewGeneration) return;
    ui.readiness.textContent = error.message;
    clearPreview(error.message);
  }
}

function renderField() {
  const { state, committedState, events: previewEvents, previewing } = renderedStateContext();
  const rootState = plan.stateNodes[plan.initialStateNodeId];
  const wrapper = document.createElement("div"); wrapper.className = "field-summary";
  const identity = document.createElement("div"); identity.className = "field-identity";
  const trainer = document.createElement("strong"); trainer.textContent = currentTrainerName();
  const format = document.createElement("span"); format.textContent = battleFormatLabel();
  identity.append(trainer, format); wrapper.append(identity);
  const battleProfile = dataset.trainer(plan.game.trainerId)?.battleProfiles?.[dataset.mechanics.trainerBattleProfile];
  const flags = document.createElement("div"); flags.className = "field-ai-flags";
  for (const flag of battleProfile?.aiFlagIds || []) {
    if (trainerAi?.generation === 5 && flag === "flag5"
      && !Object.values(plan.combatants).some(mon => mon.side === "enemy" && ["reshiram", "zekrom"].includes(mon.speciesId))) continue;
    const chip = document.createElement("span"); chip.className = "field-effect";
    const script = trainerAi?.profile?.scripts?.find(entry => entry.id === flag);
    const descriptiveNames = { "No Effect": "Avoid Ineffective Moves", Evaluate: "Evaluate Attacks", Expert: "Expert Move Effects", Status: "Setup / Status", "Vs Rivals First Battles": "Turn 1 Damage", "Double/Triple Battle": "Doubles / Triples Strategy", "HP-Based": "Check HP" };
    const name = script?.name || String(flag).replace(/^AI_FLAG_/, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
    chip.textContent = descriptiveNames[name] || name;
    chip.title = script?.summary ? `${flag}: ${script.summary}` : String(flag);
    flags.append(chip);
  }
  identity.insertBefore(flags, format);
  const effects = [];
  const global = state.fieldState.global;
  if (!global.weather?.id) effects.push({ label: "No Weather" });
  if (!global.terrain?.id) effects.push({ label: "No Terrain" });
  for (const [key, verb] of [["delayedAttacks", "Hits"], ["delayedHeals", "Heals"]]) {
    for (const entry of global[key] || []) {
      const turns = Number(entry.remainingTurns);
      const name = entry.moveId ? dataset.get("moves", entry.moveId)?.name || entry.moveId : "Wish";
      effects.push({ label: `${name} · ${verb} Slot ${battleSlotNumber(entry.side, entry.slot)} ${turns <= 1 ? "next turn" : `in ${turns} turns`}` });
    }
  }
  if (global.weather?.id) effects.push({ label: `Weather · ${global.weather.id}${global.weather.remainingTurns ? ` (${global.weather.remainingTurns})` : ""}`, current: previewing && JSON.stringify(global.weather) !== JSON.stringify(committedState.fieldState.global.weather), persisted: JSON.stringify(global.weather) !== JSON.stringify(rootState.fieldState.global.weather) });
  if (global.terrain?.id) effects.push({ label: `Terrain · ${global.terrain.id}${global.terrain.remainingTurns ? ` (${global.terrain.remainingTurns})` : ""}`, current: previewing && JSON.stringify(global.terrain) !== JSON.stringify(committedState.fieldState.global.terrain), persisted: JSON.stringify(global.terrain) !== JSON.stringify(rootState.fieldState.global.terrain) });
  for (const key of ["trickRoomTurns", "gravityTurns", "magicRoomTurns", "wonderRoomTurns"]) if (Number(global[key]) > 0) effects.push({ label: `${key.replace(/Turns$/, "").replace(/([A-Z])/g, " $1")} · ${global[key]}`, current: previewing && Number(global[key]) !== Number(committedState.fieldState.global[key]), persisted: Number(global[key]) !== Number(rootState.fieldState.global[key]) });
  for (const side of ["player", "enemy"]) {
    const sideState = state.fieldState.sides[side];
    const committedSideState = committedState.fieldState.sides[side];
    const rootSideState = rootState.fieldState.sides[side];
    for (const key of ["reflectTurns", "lightScreenTurns", "auroraVeilTurns", "tailwindTurns", "safeguardTurns", "mistTurns", "luckyChantTurns"]) if (Number(sideState[key]) > 0) effects.push({ label: `${side} ${key.replace(/Turns$/, "").replace(/([A-Z])/g, " $1")} · ${sideState[key]}`, current: previewing && Number(sideState[key]) !== Number(committedSideState[key]), persisted: Number(sideState[key]) !== Number(rootSideState[key]) });
    for (const [hazard, layers] of Object.entries(sideState.hazards || {})) if (Number(layers) > 0) effects.push({ label: `${side} ${hazard} · ${layers}`, current: previewing && Number(layers) !== Number(committedSideState.hazards?.[hazard] || 0), persisted: Number(layers) !== Number(rootSideState.hazards?.[hazard] || 0) });
  }
  if (effects.length) {
    const effectGrid = document.createElement("div"); effectGrid.className = "field-effects";
    for (const entry of effects) { const effect = document.createElement("span"); effect.className = `field-effect${entry.current ? " value-current" : entry.persisted ? " value-persisted" : ""}`; effect.textContent = entry.label; effectGrid.append(effect); }
    wrapper.append(effectGrid);
  }
  const actualExperience = previewing
    ? stateEvents(state, previewEvents).filter(entry => entry.eventType === "experience-gain")
    : stateLineage(plan, state.stateNodeId)
      .map(stateId => plan.stateNodes[stateId])
      .filter(lineageState => Number(lineageState.turnNumber) === Number(state.turnNumber))
      .flatMap(lineageState => stateEvents(lineageState))
      .filter(entry => entry.eventType === "experience-gain");
  if (actualExperience.length) {
    const section = document.createElement("section"); section.className = "field-exp"; section.dataset.expActual = "true";
    const heading = document.createElement("strong"); heading.textContent = "EXP gained this turn"; section.append(heading);
    for (const entry of actualExperience) {
      const line = document.createElement("span"); line.className = `field-exp-line ${previewing ? "value-current" : "value-persisted"}`;
      const mon = plan.combatants[entry.targetKey];
      line.textContent = `${recordName(mon)} +${Number(entry.metadata?.amount || 0).toLocaleString()} EXP${entry.metadata?.levelUp ? ` · Lv. ${entry.metadata.toLevel}` : ""}`;
      section.append(line);
    }
    wrapper.append(section);
  }
  const projections = activeKeys(state, "enemy")
    .filter(enemyKey => Number(state.combatantStates[enemyKey]?.hp?.max) > 0)
    .map(enemyKey => ({ enemyKey, projection: projectExperience(plan, state, enemyKey, dataset) }))
    .filter(entry => entry.projection.available && entry.projection.rewards.length);
  for (const { enemyKey, projection } of projections) {
    const section = document.createElement("section"); section.className = "field-exp"; section.dataset.expProjection = enemyKey;
    const heading = document.createElement("strong"); heading.textContent = `If ${recordName(plan.combatants[enemyKey])} faints`;
    section.append(heading);
    for (const reward of projection.rewards) {
      const line = document.createElement("span"); line.className = "field-exp-line";
      const notes = [reward.expShare ? "Exp. Share" : null, reward.luckyEgg ? "Lucky Egg" : null, reward.toLevel > reward.fromLevel ? `Lv. ${reward.toLevel}` : null].filter(Boolean);
      line.textContent = `${recordName(plan.combatants[reward.combatantKey])} +${reward.amount.toLocaleString()} EXP${notes.length ? ` · ${notes.join(" · ")}` : ""}`;
      section.append(line);
    }
    wrapper.append(section);
  }
  ui["field-state"].replaceChildren(wrapper);
}

function nodeActionSummary(state) {
  if (state.stateNodeId === plan.initialStateNodeId) return "Declared pre-battle state";
  const group = state.parentActionGroupId ? plan.actionGroups[state.parentActionGroupId] : state.parentReplacementTransitionId ? plan.replacementTransitions[state.parentReplacementTransitionId] : null;
  if (!group) return state.outcome.label;
  const entries = [];
  if (state.parentActionGroupId) {
    let parent = plan.stateNodes[group.parentStateNodeId];
    const replacementGroups = [];
    while (parent?.parentReplacementTransitionId) {
      const transition = plan.replacementTransitions?.[parent.parentReplacementTransitionId];
      if (!transition) break;
      replacementGroups.unshift(transition);
      parent = plan.stateNodes[transition.parentStateNodeId];
    }
    for (const transition of replacementGroups) {
      for (const side of ["player", "enemy"]) {
        const actions = actionList(transition.actions, side);
        for (const action of actions) entries.push(`${side === "player" ? "P" : "E"}: Send out ${recordName(plan.combatants[action.switchToKey])}`);
      }
    }
  }
  for (const side of ["player", "enemy"]) {
    const actions = actionList(group.actions, side);
    for (const action of actions) {
      const actor = plan.combatants[action.actorKey] || plan.combatants[action.switchToKey];
      const result = action.actionType === "move" ? dataset.get("moves", action.moveId)?.name || action.moveId
        : action.actionType === "shift" ? "Shifted position"
          : `Switch to ${recordName(plan.combatants[action.switchToKey])}`;
      entries.push(`${side === "player" ? "P" : "E"}: ${recordName(actor)} · ${result}`);
    }
  }
  return entries.join(" | ") || state.outcome.label;
}

function selectStateNode(stateId, { prefill = false } = {}) {
  if (!plan.stateNodes[stateId]) return;
  cursorStateNodeId = stateId;
  reviewOutcomeStateNodeId = null;
  actionDraft = emptyActionDraft();
  if (prefill) prefillActions();
  currentPreview = null;
  branchEventModel = null;
  selectedPreviewOutcomeId = null;
  renderWorkspace();
  persistDraft();
}

function selectTurnOutcome(stateId) {
  const state = plan.stateNodes[stateId];
  const group = state?.parentActionGroupId ? plan.actionGroups[state.parentActionGroupId] : null;
  if (!state || !group) return;
  cursorStateNodeId = group.parentStateNodeId;
  reviewOutcomeStateNodeId = stateId;
  actionDraft = emptyActionDraft();
  prefillActions(group);
  currentPreview = null;
  branchEventModel = null;
  selectedPreviewOutcomeId = null;
  renderWorkspace();
  persistDraft();
}

function selectReplacementOutcome(stateId) {
  const state = plan.stateNodes[stateId];
  const transition = state?.parentReplacementTransitionId ? plan.replacementTransitions?.[state.parentReplacementTransitionId] : null;
  if (!state || !transition) return;
  cursorStateNodeId = transition.parentStateNodeId;
  reviewOutcomeStateNodeId = stateId;
  actionDraft = emptyActionDraft();
  prefillReplacementActions(transition);
  currentPreview = null;
  branchEventModel = null;
  selectedPreviewOutcomeId = null;
  renderWorkspace();
  persistDraft();
}

function renderTree() {
  const currentState = selectedState();
  const selectedCommittedStateNodeId = reviewOutcomeStateNodeId || (battleActuallyEnded(currentState) ? cursorStateNodeId : null);
  const selectedLineage = new Set(stateLineage(plan, selectedCommittedStateNodeId || cursorStateNodeId));
  const additionalDraftStateNodeIds = !reviewOutcomeStateNodeId && !battleActuallyEnded(currentState) ? [cursorStateNodeId] : [];
  const ordered = planTurnTreeOrder(plan, { additionalDraftStateNodeIds });
  const groups = new Map();
  for (const entry of ordered) {
    if (!groups.has(entry.columnKey)) groups.set(entry.columnKey, {
      entries: [],
      order: Number(entry.columnOrder),
      title: entry.columnTitle,
      turnNumber: Number(entry.turnNumber)
    });
    groups.get(entry.columnKey).entries.push(entry);
  }
  const orderedGroups = [...groups.entries()].sort(([, left], [, right]) => left.order - right.order);
  const columnIndexByKey = new Map(orderedGroups.map(([key], index) => [key, index]));
  const entryByOutcomeStateId = new Map(ordered.filter(entry => entry.outcomeStateNodeId).map(entry => [entry.outcomeStateNodeId, entry]));
  const columns = orderedGroups.map(([, group], columnIndex) => {
    const { entries, turnNumber: turn } = group;
    const column = document.createElement("div"); column.className = "node-column"; column.dataset.column = columnIndex;
    const title = document.createElement("p"); title.className = "node-column-title"; title.textContent = group.title || "\u00a0";
    if (!group.title) { title.classList.add("is-placeholder"); title.setAttribute("aria-hidden", "true"); }
    column.append(title);
    const previousSiblingLaneByDecision = new Map();
    entries.forEach((entry, rowIndex) => {
      const state = entry.kind === "committed" ? plan.stateNodes[entry.outcomeStateNodeId] : plan.stateNodes[entry.decisionStateNodeId];
      const draftPreview = entry.kind === "draft"
        && !reviewOutcomeStateNodeId
        && entry.decisionStateNodeId === cursorStateNodeId
        && (entry.transitionKind === "replacement" ? currentPreview?.previewKind === "replacement" : currentPreview?.previewKind !== "replacement")
        && currentPreview?.baseStateNodeId === cursorStateNodeId
        ? defaultPreviewEntry()
        : null;
      const replacementNode = entry.transitionKind === "replacement";
      const outcome = replacementNode ? null : entry.kind === "committed" ? state.outcome : draftPreview?.outcome || null;
      const node = button("", "node-button");
      node.disabled = Boolean(freeCalcSession) && state.stateNodeId !== cursorStateNodeId;
      if (state.freeCalc) node.title = 'Free Calc · manual battle state';
      node.dataset.column = columnIndex; node.dataset.row = rowIndex; node.dataset.lane = entry.lane; node.style.gridColumn = "1"; node.style.gridRow = String(Number(entry.lane) + 2); node.setAttribute("role", "treeitem");
      node.dataset.kind = entry.kind;
      node.dataset.stateNodeId = entry.outcomeStateNodeId || entry.decisionStateNodeId;
      node.dataset.parentStateNodeId = entry.decisionStateNodeId;
      const selected = entry.kind === "committed"
        ? entry.outcomeStateNodeId === selectedCommittedStateNodeId
        : !reviewOutcomeStateNodeId && entry.decisionStateNodeId === cursorStateNodeId && !battleActuallyEnded(state);
      node.setAttribute("aria-selected", String(selected));
      node.classList.toggle("is-draft", entry.kind === "draft");
      node.classList.toggle("is-replacement", replacementNode);
      node.classList.toggle("is-ancestor", entry.kind === "committed" && selectedLineage.has(entry.outcomeStateNodeId) && !selected);
      const parentEntry = entryByOutcomeStateId.get(entry.decisionStateNodeId);
      const parentColumnIndex = parentEntry ? columnIndexByKey.get(parentEntry.columnKey) : null;
      const incomingColumnSpan = Number.isInteger(parentColumnIndex) ? columnIndex - parentColumnIndex : 1;
      node.dataset.incomingColumnSpan = String(incomingColumnSpan);
      if (incomingColumnSpan > 1) {
        const currentInset = replacementNode ? "(var(--node-column-width) - 100%) / 2 + " : "";
        node.style.setProperty(
          "--incoming-connector-length",
          `calc(${currentInset}${incomingColumnSpan - 1} * (var(--node-column-width) + var(--node-column-gap)) + var(--node-column-gap))`
        );
      }
      const previousSiblingLane = previousSiblingLaneByDecision.get(entry.decisionStateNodeId);
      const branchRiseRows = Number.isFinite(previousSiblingLane) ? Number(entry.lane) - previousSiblingLane : 0;
      if (branchRiseRows > 0 && columnIndex > 0) {
        node.classList.add("is-branch-start");
        node.style.setProperty("--branch-rise-rows", String(branchRiseRows));
        const rise = document.createElement("span");
        rise.className = "node-branch-rise";
        rise.setAttribute("aria-hidden", "true");
        node.append(rise);
      }
      previousSiblingLaneByDecision.set(entry.decisionStateNodeId, Number(entry.lane));
      const probability = outcome ? probabilityLabel(outcome) : "—";
      const visibleProbability = document.createElement("span"); visibleProbability.className = "node-probability"; visibleProbability.textContent = probability;
      const visualOutcomeState = entry.kind === "committed" ? state : draftPreview?.state || draftPreview || null;
      const visualActions = entry.kind === "committed"
        ? replacementNode ? plan.replacementTransitions[state.parentReplacementTransitionId]?.actions : plan.actionGroups[state.parentActionGroupId]?.actions
        : draftPreview ? replacementNode ? currentPreview?.replacements : currentPreview?.actions : replacementNode ? selectedReplacementDraftActions() : null;
      const visuals = turnNodeVisuals(plan, entry.decisionStateNodeId, visualOutcomeState, visualActions);
      node.classList.toggle("has-faint", visuals.hasFaint);
      const sprites = document.createElement("span"); sprites.className = "node-sprites";
      const sixSlotNode = ["triples", "rotation"].includes(plan.game?.battleFormat);
      if (sixSlotNode) sprites.classList.add("is-triples");
      const nodePositionState = visualOutcomeState || state;
      const nodeCombatantKeys = replacementNode
        ? visuals.combatantKeys
        : sixSlotNode
        ? ["player", "enemy"].flatMap(side => Array.from({ length: 3 }, (_, position) => activeKey(nodePositionState, side, plan.game?.battleFormat === "triples" ? tripleSlotForPosition(plan, side, position) : position)))
        : visuals.combatantKeys;
      for (const combatantKey of nodeCombatantKeys) {
        if (!combatantKey) {
          const emptyHolder = document.createElement("span");
          emptyHolder.className = "node-sprite is-empty";
          emptyHolder.setAttribute("aria-hidden", "true");
          sprites.append(emptyHolder);
          continue;
        }
        const mon = plan.combatants[combatantKey];
        const holder = document.createElement("span"); holder.className = "node-sprite";
        const fainted = visuals.faintedCombatantKeys.has(combatantKey);
        const switchedIn = visuals.switchedInCombatantKeys.has(combatantKey);
        holder.classList.toggle("has-switch-in", switchedIn);
        holder.classList.toggle("has-faint", fainted);
        holder.title = `${recordName(mon)}${switchedIn ? " switched in" : ""}${fainted ? " fainted" : ""}`;
        holder.append(sprite(currentSpriteRecord(mon, nodePositionState?.combatantStates?.[combatantKey]))); sprites.append(holder);
      }
      const summary = entry.kind === "committed"
        ? `${state.outcome.label} · ${nodeActionSummary(state)}`
        : draftPreview ? `${(draftPreview.outcome || draftPreview).label || "Crafted outcome"}` : replacementNode ? "Awaiting replacement selection" : "Awaiting turn actions";
      const faintSummary = visuals.hasFaint ? ` · Fainted: ${[...visuals.faintedCombatantKeys].map(key => recordName(plan.combatants[key])).join(", ")}` : "";
      node.setAttribute("aria-label", replacementNode ? `Replacement before Turn ${turn} · ${summary}${faintSummary}` : `Turn ${turn} · ${probability} · ${summary}${faintSummary}`);
      if (!replacementNode) node.append(visibleProbability);
      if (sprites.childElementCount) node.append(sprites);
      node.addEventListener("click", () => entry.kind === "committed"
        ? replacementNode ? selectReplacementOutcome(entry.outcomeStateNodeId) : selectTurnOutcome(entry.outcomeStateNodeId)
        : selectStateNode(entry.decisionStateNodeId));
      node.addEventListener("keydown", event => {
        const cols = [...ui["node-tree"].querySelectorAll(".node-column")];
        let target = null;
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const siblings = [...column.querySelectorAll(".node-button")].sort((left, right) => Number(left.dataset.lane) - Number(right.dataset.lane));
          const siblingIndex = siblings.indexOf(node);
          target = siblings[siblingIndex + (event.key === "ArrowDown" ? 1 : -1)];
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const targetColumn = cols[columnIndex + (event.key === "ArrowRight" ? 1 : -1)];
          const nodes = targetColumn ? [...targetColumn.querySelectorAll(".node-button")] : [];
          target = nodes.find(candidate => Number(candidate.dataset.lane) === Number(entry.lane))
            || nodes.sort((left, right) => Math.abs(Number(left.dataset.lane) - Number(entry.lane)) - Math.abs(Number(right.dataset.lane) - Number(entry.lane)))[0];
        } else if (event.key === "Home") target = ui["node-tree"].querySelector(".node-button");
        else if (event.key === "End") target = [...ui["node-tree"].querySelectorAll(".node-button")].at(-1);
        if (target) { event.preventDefault(); target.focus(); }
      });
      column.append(node);
    });
    return column;
  });
  ui["node-tree"].replaceChildren(...columns);
}

function prefillActions(suppliedGroup = null) {
  const state = selectedState();
  const first = suppliedGroup || (state.childActionGroupIds || []).map(id => plan.actionGroups[id]).filter(Boolean).sort((a, b) => a.createdOrder - b.createdOrder)[0];
  if (!first) return;
  for (const side of ["player", "enemy"]) {
    const saved = actionList(first.actions, side);
    saved.forEach(action => {
      const slot = actorSlot(state, side, action.actorKey);
      if (slot < 0) return;
      actionDraft[side][slot] = action.actionType === "switch"
        ? { type: "switch", actorKey: action.actorKey, switchToKey: action.switchToKey, previewSwitchToKey: action.switchToKey }
        : action.actionType === "shift" ? { type: "shift", actorKey: action.actorKey }
          : { type: "move", moveId: action.moveId, targetKey: action.targetKeys?.[0] || null, mechanicValue: action.mechanicActivations?.[0]?.switchToKey || action.mechanicActivations?.[0]?.typeId || action.mechanicActivations?.[0]?.moveId || null };
    });
  }
}

function prefillReplacementActions(transition) {
  const state = selectedState();
  if (!state || !transition) return;
  for (const side of ["player", "enemy"]) {
    for (const action of actionList(transition.actions, side)) {
      const slot = Number(action.slot ?? 0);
      if (!Number.isInteger(slot) || slot < 0 || slot >= actionDraft[side].length) continue;
      actionDraft[side][slot] = {
        type: "switch",
        actorKey: activeKey(state, side, slot),
        switchToKey: action.switchToKey,
        previewSwitchToKey: action.switchToKey
      };
    }
  }
}

function renderExportSelection() {
  if (!plan) {
    ui["export-selection"].replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "No active plan. Import a plan file or begin a clean plan." }));
    ui["select-all-export"].disabled = true;
    ui["output-plan"].disabled = true;
    return;
  }
  const visibleEntries = planTreeOrder(plan, { includeReplacementStates: false }).filter(entry => entry.state.turnNumber > 0 || entry.state.freeCalc || Object.keys(plan.stateNodes).length === 1);
  const visibleIds = new Set(visibleEntries.map(entry => entry.state.stateNodeId));
  for (const stateId of exportSelection) if (!visibleIds.has(stateId)) exportSelection.delete(stateId);
  const byId = new Map(visibleEntries.map(({ state }) => [state.stateNodeId, state]));
  const branchGroups = exportBranchGroups(plan);
  const nodes = branchGroups.map(group => {
    const section = document.createElement("section"); section.className = "export-branch";
    const header = document.createElement("label"); header.className = "export-branch-header";
    const branchCheckbox = document.createElement("input"); branchCheckbox.type = "checkbox";
    const selectedCount = group.stateNodeIds.filter(stateId => exportSelection.has(stateId)).length;
    branchCheckbox.checked = selectedCount === group.stateNodeIds.length;
    branchCheckbox.indeterminate = selectedCount > 0 && selectedCount < group.stateNodeIds.length;
    branchCheckbox.addEventListener("change", () => {
      const preserve = branchCheckbox.checked
        ? []
        : branchGroups.filter(other => other.branchNumber !== group.branchNumber && other.stateNodeIds.every(stateId => exportSelection.has(stateId)));
      for (const stateId of group.stateNodeIds) branchCheckbox.checked ? exportSelection.add(stateId) : exportSelection.delete(stateId);
      for (const other of preserve) for (const stateId of other.stateNodeIds) exportSelection.add(stateId);
      renderExportSelection();
    });
    const branchText = document.createElement("strong"); branchText.textContent = `Branch ${group.branchNumber}`;
    header.append(branchCheckbox, branchText);
    const turns = document.createElement("div"); turns.className = "export-branch-turns";
    for (const stateId of group.stateNodeIds) {
      const state = byId.get(stateId);
      if (!state) continue;
      const label = document.createElement("label");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = exportSelection.has(stateId);
      checkbox.addEventListener("change", () => { checkbox.checked ? exportSelection.add(stateId) : exportSelection.delete(stateId); renderExportSelection(); });
      const text = document.createElement("span"); text.textContent = `Turn ${state.parentActionGroupId ? state.turnNumber : state.turnNumber + 1} · ${state.outcome.label} · ${nodeActionSummary(state)}`;
      label.append(checkbox, text); turns.append(label);
    }
    section.append(header, turns);
    return section;
  });
  if (!nodes.length) nodes.push(Object.assign(document.createElement("p"), { className: "empty", textContent: "Commit at least one turn before saving a plan." }));
  ui["export-selection"].replaceChildren(...nodes);
  ui["output-plan"].disabled = needsRecalculation || !exportSelection.size;
  ui["select-all-export"].disabled = !visibleIds.size;
}

function renderWorkspace() {
  for (const id of ['commit-turn', 'free-calc', 'save-plan']) byId(id).hidden = Boolean(freeCalcSession);
  for (const id of ['free-calc-close', 'free-calc-add', 'free-calc-save']) byId(id).hidden = !freeCalcSession;
  byId('free-calc').disabled = !plan || needsRecalculation;
  for (const id of ['new-plan', 'export-line', 'import-plan', 'game-select']) if (byId(id)) byId(id).disabled = Boolean(freeCalcSession);
  const hasPlan = Boolean(plan);
  ui.workspace.hidden = !hasPlan;
  ui["empty-plan"].hidden = hasPlan;
  ui["battle-workspace"].classList.toggle("is-doubles", hasPlan && plan.game.battleFormat === "doubles");
  ui["battle-workspace"].classList.toggle("is-triples", hasPlan && plan.game.battleFormat === "triples");
  ui["battle-workspace"].classList.toggle("is-rotation", hasPlan && plan.game.battleFormat === "rotation");
  ui["plan-toolbar-label"].textContent = hasPlan ? `${plan.name} · ${currentTrainerName()} · ${battleFormatLabel()}` : "No battle plan open";
  ui["commit-turn"].disabled = true;
  ui["recalculate-plan"].hidden = !hasPlan || !needsRecalculation;
  if (!hasPlan) return;
  ui["revision-label"].textContent = `Draft r${plan.documentRevision}`;
  const selected = selectedState();
  const reviewed = reviewOutcomeStateNodeId ? plan.stateNodes[reviewOutcomeStateNodeId] : null;
  const replacementPhase = Boolean(reviewed?.parentReplacementTransitionId) || (!reviewed && pendingReplacementSlots(selected).length > 0);
  const turnNumber = reviewed ? displayTurnNumber(reviewed) : battleActuallyEnded(selected) ? Number(selected.turnNumber) : Number(selected.turnNumber) + 1;
  ui["turn-label"].textContent = `Turn ${turnNumber}${replacementPhase ? " · Replacement" : ""}`;
  ui["commit-turn"].textContent = battleCompletionState(plan, selected).commitLabel;
  renderTree(); renderField(); renderActionPanels(); renderNotes(); renderExportSelection();
  if (battleActuallyEnded(selectedState())) { ui.readiness.textContent = "The battle has ended."; clearPreview("The battle has ended."); }
  else if (needsRecalculation) { ui.readiness.textContent = "Recalculation is required."; clearPreview("This imported plan needs recalculation under the current mechanics fingerprint."); }
  else refreshPreview();
}

async function persistDraft() {
  if (!plan || freeCalcSession) return;
  draftRecord = draftRecord ? updateDraftRecord(draftRecord, plan, cursorStateNodeId) : createDraftRecord(plan, cursorStateNodeId);
  await draftStore.save(draftRecord);
}

async function commitCurrentPreview() {
  if (!currentPreview || !plan) return;
  try {
    const replacementCommit = currentPreview.previewKind === "replacement";
    const lockingBattleEnd = !replacementCommit && selectedPreviewBattleEnded();
    const result = currentPreview.previewKind === "replacement"
      ? commitForcedReplacement(plan, currentPreview, dataset)
      : commitPreview(plan, currentPreview, dataset, { selectedPreviewOutcomeId, commitSelectedOnly: true });
    plan = result.plan;
    cursorStateNodeId = result.cursorStateNodeId;
    reviewOutcomeStateNodeId = null;
    currentPreview = null;
    branchEventModel = null;
    selectedPreviewOutcomeId = null;
    actionDraft = emptyActionDraft();
    await persistDraft();
    renderWorkspace();
    setStatus(lockingBattleEnd ? "Battle-ending branch locked in the local draft." : replacementCommit ? "Replacement prepared for the next turn." : result.outcomeAdded ? "Crafted outcome branch added to the local draft." : result.created ? "Turn committed to the local draft." : "Opened the existing branch.");
    if (lockingBattleEnd) {
      const progression = branchProgressionSnapshot(plan, cursorStateNodeId);
      if (progression.length && await requestProgressionSave(progression)) {
        const saved = applyBranchProgressionToLibrary(boxLibrary, plan, cursorStateNodeId);
        boxLibrary = saved.library;
        await saveLibrary();
        const skipped = saved.skipped.length ? ` ${saved.skipped.length} record${saved.skipped.length === 1 ? " was" : "s were"} not updated because the Box identity could not be resolved.` : "";
        setStatus(`Saved absolute EXP and levels for ${saved.updated.length} party Pokémon. The active plan still uses its original starting snapshot; the saved values apply when a new plan begins.${skipped}`, saved.updated.length === 0);
      }
    }
  } catch (error) { setStatus(error.message, true); }
}

async function outputPlan() {
  try {
    if (!plan) throw new Error("No active plan is available to output");
    if (needsRecalculation) throw new Error("Recalculate this plan before outputting it");
    const selected = [...exportSelection];
    const { plan: output } = exportSelectedPlan(plan, selected);
    downloadPlan(output);
    const all = exportBranchGroups(plan).flatMap(group => group.stateNodeIds);
    const complete = all.every(id => exportSelection.has(id));
    draftRecord = markExported(draftRecord, { complete, selectedStateNodeIds: selected });
    await draftStore.save(draftRecord);
    ui["file-status"].textContent = complete ? "The full current draft was downloaded." : "The selected branch subset was downloaded; omitted branches remain in the local draft.";
  } catch (error) { ui["file-status"].textContent = error.message; }
}

async function importPlanFile(file) {
  if (!file || !dataset) return;
  if (plan && !(await confirmDestructive("Importing another plan"))) return;
  try {
    let imported = parsePlan(await file.text());
    assertValidPlanDocument(imported);
    if (imported.game.gameId !== selectedGameId) throw new Error(`This plan belongs to ${imported.game.gameId}; select that game first`);
    setStatus("Updating the imported line for the current PLC mechanics…");
    const importUpgrade = await upgradeImportedPlanForEditing(imported, {
      dataset,
      previewTurnFn: request => worker.preview(request)
    });
    imported = importUpgrade.plan;
    needsRecalculation = false;
    const probabilityRepair = await repairUnknownGraphProbabilities(imported);
    plan = probabilityRepair.plan;
    const importedParty = addImportedPlanParty(boxLibrary, plan, dataset);
    bindPlanPlayerPartyToImportedBox(plan, importedParty);
    const importedReviewStateId = preferredImportedReviewStateId(plan);
    const importedReviewState = importedReviewStateId ? plan.stateNodes[importedReviewStateId] : null;
    const importedReviewGroup = importedReviewState?.parentActionGroupId ? plan.actionGroups[importedReviewState.parentActionGroupId] : null;
    cursorStateNodeId = importedReviewGroup?.parentStateNodeId || plan.initialStateNodeId;
    reviewOutcomeStateNodeId = importedReviewGroup ? importedReviewStateId : null;
    actionDraft = emptyActionDraft();
    if (importedReviewGroup) prefillActions(importedReviewGroup);
    exportSelection.clear();
    draftRecord = createDraftRecord(plan, cursorStateNodeId);
    draftRecord.needsRecalculation = needsRecalculation;
    await draftStore.save(draftRecord);
    boxLibrary = importedParty.library;
    await boxStore.save(boxLibrary);
    renderBoxes();
    refreshContextBoxSelect();
    renderWorkspace();
    if (ui["output-dialog"].open) ui["output-dialog"].close();
    setStatus(`Plan imported into the local draft${importUpgrade.replayed ? " and updated to the current PLC mechanics" : ""}. Player party added to Boxes as Import ${importedParty.importNumber}.${probabilityRepair.refreshedStateNodeIds.length ? ` Repaired ${probabilityRepair.refreshedStateNodeIds.length} stale graph ${probabilityRepair.refreshedStateNodeIds.length === 1 ? "probability" : "probabilities"}.` : ""} Nothing has been sent to Overlay.`);
  } catch (error) { setStatus(error.message, true); }
  finally { ui["import-plan"].value = ""; }
}

async function recalculateImportedPlan() {
  if (!plan || !needsRecalculation || !worker) return;
  const original = plan;
  ui["recalculate-plan"].disabled = true;
  setStatus("Replaying saved branches under the selected game's current mechanics…");
  try {
    plan = await recalculatePlanDocument(original, { dataset, previewTurnFn: request => worker.preview(request) });
    cursorStateNodeId = plan.initialStateNodeId;
    reviewOutcomeStateNodeId = null;
    needsRecalculation = false;
    actionDraft = emptyActionDraft();
    exportSelection.clear();
    draftRecord = createDraftRecord(plan, cursorStateNodeId);
    await draftStore.save(draftRecord);
    renderWorkspace();
    setStatus("Recalculation completed. Review the rebuilt branches before output.");
  } catch (error) { plan = original; setStatus(`Recalculation stopped without replacing the imported plan: ${error.message}`, true); }
  finally { ui["recalculate-plan"].disabled = false; }
}

async function confirmDestructive(actionLabel) {
  if (freeCalcSession) { setStatus('Close, Add, or Save as Draft to finish Free Calc first.', true); return false; }
  if (!plan) return true;
  ui["destructive-message"].textContent = "You have a line already open. Please select how to proceed.";
  ui["destructive-output"].hidden = false;
  ui["destructive-discard"].textContent = "Discard";
  return new Promise(resolve => {
    destructiveResolver = resolve;
    ui["destructive-dialog"].showModal();
  });
}

async function resolveDestructive(choice) {
  if (!destructiveResolver) return;
  const resolve = destructiveResolver; destructiveResolver = null;
  if (choice === "draft") {
    try { resolve(await saveNamedDraft()); } catch (error) { setStatus(`Draft could not be saved: ${error.message}`, true); resolve(false); }
  } else if (choice === "output") {
    try {
      const all = Object.keys(plan.stateNodes);
      const { plan: output } = exportSelectedPlan(plan, all);
      downloadPlan(output);
      draftRecord = markExported(draftRecord, { complete: true, selectedStateNodeIds: all });
      await draftStore.save(draftRecord);
      resolve(true);
    } catch (error) { setStatus(`Output failed; change cancelled: ${error.message}`, true); resolve(false); }
  } else resolve(choice === "discard");
}

async function clearActiveContext() {
  plan = null; draftRecord = null; cursorStateNodeId = null; currentPreview = null; branchEventModel = null; selectedPreviewOutcomeId = null; reviewOutcomeStateNodeId = null; needsRecalculation = false;
  actionDraft = emptyActionDraft(); exportSelection.clear();
  await draftStore.clear();
  renderWorkspace();
}

async function repairUnknownGraphProbabilities(sourcePlan) {
  let repairedPlan = sourcePlan;
  const refreshedStateNodeIds = [];
  const groups = Object.values(sourcePlan.actionGroups || {}).filter(group =>
    (group.outcomeStateNodeIds || []).some(stateId => {
      const outcome = sourcePlan.stateNodes[stateId]?.outcome;
      const probability = outcome?.probability;
      return outcome?.probabilityStatus === "unknown"
        || probability === null
        || probability === undefined
        || probability === ""
        || !Number.isFinite(Number(probability));
    })
  );
  for (const group of groups) {
    try {
      const preview = await worker.preview({
        plan: repairedPlan,
        parentStateNodeId: group.parentStateNodeId,
        actions: group.actions,
        expandExisting: true
      });
      const repaired = refreshUnknownCommittedProbabilities(repairedPlan, preview);
      repairedPlan = repaired.plan;
      refreshedStateNodeIds.push(...repaired.refreshedStateNodeIds);
    } catch {
      // A stale derived label must never prevent the underlying draft from loading.
    }
  }
  return { plan: repairedPlan, refreshedStateNodeIds };
}

async function restoreDraft() {
  const cached = await draftStore.load();
  if (!cached?.document) return false;
  try {
    let restored = migratePlanDocument(cached.document);
    assertValidPlanDocument(restored);
    if (restored.game.gameId !== selectedGameId) return false;
    const initialUpgrade = upgradeInitialEntryEffects(restored, dataset);
    restored = initialUpgrade.plan;
    const hasResolvedBranches = Object.keys(restored.actionGroups || {}).length > 0 || Object.keys(restored.replacementTransitions || {}).length > 0;
    needsRecalculation = Boolean(cached.needsRecalculation)
      || mechanicsCompatibility(restored, dataset).needsRecalculation
      || (initialUpgrade.changed && hasResolvedBranches);
    const probabilityRepair = needsRecalculation ? { plan: restored, refreshedStateNodeIds: [] } : await repairUnknownGraphProbabilities(restored);
    restored = probabilityRepair.plan;
    plan = restored;
    draftRecord = { ...cached, document: restored };
    cursorStateNodeId = plan.stateNodes[cached.workingCursorStateNodeId] ? cached.workingCursorStateNodeId : plan.initialStateNodeId;
    reviewOutcomeStateNodeId = null;
    draftRecord.needsRecalculation = needsRecalculation;
    if (initialUpgrade.changed || probabilityRepair.refreshedStateNodeIds.length) await draftStore.save(draftRecord);
    actionDraft = emptyActionDraft();
    prefillActions();
    renderWorkspace();
    return true;
  } catch { return false; }
}

async function selectGame(gameId) {
  if (!gameId) { renderGameCredit(""); return; }
  if (selectedGameId && selectedGameId !== gameId && plan && !(await confirmDestructive("Changing games"))) {
    ui["game-select"].value = selectedGameId;
    renderGameCredit(selectedGameId);
    return;
  }
  const config = GAME_REGISTRY[gameId];
  if (!config) { setStatus(`No PLC adapter is registered for ${gameId}.`, true); return; }
  try {
    setStatus(`Loading ${config.name} data and battle mechanics…`);
    if (selectedGameId && selectedGameId !== gameId) await clearActiveContext();
    worker?.terminate();
    [dataset, trainerAi] = await Promise.all([
      loadStandardizedDataset({ baseUrl: config.datasetBaseUrl }),
      config.trainerAiBaseUrl
        ? loadTrainerAiDocumentation({ baseUrl: config.trainerAiBaseUrl, gameId })
        : Promise.resolve(null)
    ]);
    dataset.abilityKnowledgePolicy = trainerAi?.evaluatorProfile?.constants?.abilityKnowledge || null;
    worker = new ResolverWorkerClient();
    await worker.initialize(config.datasetBaseUrl, config.trainerAiBaseUrl, gameId);
    trainerAiAnalysisCache.clear();
    selectedGameId = gameId;
    renderGameCredit(gameId);
    const saveImportControl = ui["save-import"]?.closest("label");
    if (saveImportControl) saveImportControl.hidden = config.capabilities?.saveImport !== true;
    localStorage.setItem(SELECTED_GAME_KEY, gameId);
    ui["game-gate"].hidden = true;
    ui["app-tabs"].hidden = false;
    fillTrainerSelect();
    initializePokemonEditor();
    renderBoxes();
    refreshContextBoxSelect();
    setTab(activeTab);
    const restored = await restoreDraft();
    setStatus(restored ? `Recovered the active ${config.name} draft. Nothing has been sent to Overlay.` : `${config.name} is ready. Add or select a Box party to begin.`);
    if (!restored) queueMicrotask(() => openPlanContext());
  } catch (error) {
    setStatus(error.message, true);
    ui["game-select"].value = selectedGameId || "";
    renderGameCredit(selectedGameId);
  }
}

function wireEvents() {
  ui["game-select"].addEventListener("change", () => {
    renderGameCredit(ui["game-select"].value);
    selectGame(ui["game-select"].value);
  });
  ui["plc-tab"].addEventListener("click", () => setTab("plc"));
  ui["boxes-tab"].addEventListener("click", () => setTab("boxes"));
  ui["new-box"].addEventListener("click", async () => { const result = addBox(boxLibrary, selectedGameId); boxLibrary = result.library; await saveLibrary("Box added."); });
  ui["save-import"].addEventListener("change", () => prepareSaveImport(ui["save-import"].files?.[0]));
  ui["select-all-save-boxes"].addEventListener("click", () => {
    for (const input of ui["save-import-pc-boxes"].querySelectorAll('input[type="checkbox"]')) input.checked = true;
    updateSaveImportStatus();
  });
  ui["clear-save-boxes"].addEventListener("click", () => {
    for (const input of ui["save-import-pc-boxes"].querySelectorAll('input[type="checkbox"]')) input.checked = false;
    updateSaveImportStatus();
  });
  ui["confirm-save-import"].addEventListener("click", confirmSaveImport);
  ui["save-import-dialog"].addEventListener("close", () => {
    if (ui["save-import-dialog"].returnValue !== "imported") pendingSaveImport = null;
    ui["save-import-pc-boxes"].replaceChildren();
  });
  ui["showdown-open"].addEventListener("click", () => { refreshShowdownDestinations(); ui["showdown-text"].value = ""; ui["showdown-status"].textContent = "Paste one or more Showdown sets."; ui["showdown-dialog"].showModal(); });
  ui["import-showdown"].addEventListener("click", importShowdownText);
  ui["copy-showdown"].addEventListener("click", async () => { try { await navigator.clipboard.writeText(ui["showdown-text"].value); ui["showdown-status"].textContent = "Copied Showdown text."; } catch { ui["showdown-text"].select(); ui["showdown-status"].textContent = "Text selected; press Ctrl+C to copy."; } });
  ui["export-boxes"].addEventListener("click", () => downloadText(exportBoxLibrary(boxLibrary, selectedGameId), `${selectedGameId}-plc-boxes.json`));
  ui["import-boxes"].addEventListener("change", async () => {
    const file = ui["import-boxes"].files?.[0]; if (!file) return;
    try { boxLibrary = mergeBoxLibrary(boxLibrary, parseBoxLibrary(await file.text())); await saveLibrary("Portable Boxes JSON imported and merged."); }
    catch (error) { setStatus(error.message, true); }
    finally { ui["import-boxes"].value = ""; }
  });
  ui["trainer-select"].addEventListener("change", updateVariantSelect);
  ui["battle-format-choice"].addEventListener("change", updateContextTrainer);
  ui["variant-select"].addEventListener("change", () => { renderEnemyTeamSummary(); updateBeginAvailability(); });
  ui["context-box-select"].addEventListener("change", () => { contextSelection = { ...emptyContextSelection(), boxId: ui["context-box-select"].value || null }; refreshContextPartySelect(); renderContextPokemonGrid(); });
  ui["party-source-mode"].addEventListener("change", () => { contextSelection.pokemonIds = []; contextSelection.partyId = null; contextSelection.saved = false; refreshContextPartySelect(); renderContextPokemonGrid(); });
  ui["context-party-select"].addEventListener("change", () => { contextSelection.partyId = ui["context-party-select"].value || null; contextSelection.saved = false; renderContextPokemonGrid(); });
  ui["save-party-selection"].addEventListener("click", savePartySelection);
  ui["edge-party-exp"].addEventListener("click", edgePartyExperience);
  ui["edit-party-selection"].addEventListener("click", () => { contextSelection.saved = false; ui["party-selector-controls"].hidden = false; ui["party-selection-summary"].hidden = true; ui["edit-party-selection"].hidden = true; ui["edge-party-exp"].hidden = true; renderContextPokemonGrid(); });
  ui["begin-plan"].addEventListener("click", beginPlanFromContext);
  ui["save-pokemon"].addEventListener("click", savePokemonEditor);
  ui["new-plan"].addEventListener("click", () => openPlanContext());
  ui["commit-turn"].addEventListener("click", commitCurrentPreview);
  ui["save-plan"].addEventListener("click", () => saveNamedDraft().catch(error => setStatus(error.message, true)));
  byId('free-calc').addEventListener('click', startFreeCalc);
  byId('free-calc-close').addEventListener('click', closeFreeCalc);
  byId('free-calc-add').addEventListener('click', () => addFreeCalc().catch(error => setStatus(error.message, true)));
  byId('free-calc-save').addEventListener('click', () => saveFreeCalcDraft().catch(error => setStatus(error.message, true)));
  byId("export-line").addEventListener("click", () => { renderExportSelection(); ui["output-dialog"].showModal(); });
  byId("drafts-tab").addEventListener("click", () => setTab('drafts'));
  ui["select-all-export"].addEventListener("click", () => {
    if (!plan) return;
    for (const group of exportBranchGroups(plan)) for (const id of group.stateNodeIds) exportSelection.add(id);
    renderExportSelection();
  });
  ui["output-plan"].addEventListener("click", outputPlan);
  ui["import-plan"].addEventListener("change", () => importPlanFile(ui["import-plan"].files?.[0]));
  ui["notes-toggle"].addEventListener("click", () => setNotesExpanded(!notesExpanded));
  ui["ai-forecast-toggle"].addEventListener("change", () => setAiForecastExpanded(ui["ai-forecast-toggle"].checked));
  ui["node-notes"].addEventListener("input", updateSelectedNote);
  ui["node-notes"].addEventListener("change", () => {
    if (!notesPersistTimer) return;
    clearTimeout(notesPersistTimer);
    notesPersistTimer = null;
    persistDraft().catch(error => setStatus(`Notes could not be saved: ${error.message}`, true));
  });
  ui["recalculate-plan"].addEventListener("click", recalculateImportedPlan);
  ui["destructive-dialog"].addEventListener("close", () => resolveDestructive(ui["destructive-dialog"].returnValue));
  ui["progression-dialog"].addEventListener("close", resolveProgressionPrompt);
  window.addEventListener("beforeunload", () => { clearTimeout(notesPersistTimer); worker?.terminate(); });
}

async function start() {
  wireEvents();
  document.addEventListener('reordererror', event => setStatus(`Party order could not be saved: ${event.detail?.message || event.detail}`, true));
  setAiForecastExpanded(false);
  try {
    await populateGameOptions();
    boxLibrary = await boxStore.load() || createEmptyBoxLibrary();
    setStatus("Select a game to load its Boxes, trainers, and mechanics.");
  } catch (error) { setStatus(`Boxes storage could not be opened: ${error.message}`, true); }
}

start();
