import { calculateStats, normalizePlayerCollection, normalizeTrainerRoster, snapshotFingerprint } from "./adapters/combatant_ingest.js";
import { showdownSpriteUrl } from "./adapters/showdown_sprites.js?v=20260825-form-compatibility";
import { loadStandardizedDataset } from "./adapters/standardized_dataset.js";
import { createDraftRecord, destructiveTransitionNotice, IndexedDbDraftStore, markExported, markLiveFlushed, setLocalLiveEdit, updateDraftRecord } from "./cache/active_draft.js";
import { downloadPlan, exportSelectedPlan, migratePlanDocument, parsePlan } from "./contracts/plan_file.js";
import { assertValidPlanDocument } from "./contracts/plan_contract.js";
import { mechanicsCompatibility, validatePlanReferences } from "./contracts/plan_compatibility.js";
import { actionList, activeKey, activeKeys, activeSlotEntries, actorSlot, pendingReplacementSlots } from "./core/battle_slots.js";
import { createBranchEventModel, selectBranchEventOutcome, selectedBranchChoices } from "./core/branch_events.js";
import { boundedSlotDamageLabel, highestDamageCandidateKeys, resolvedCombatantMovePreview } from "./core/combatant_moves.js?v=20260826-node-visuals";
import { planTreeOrder, planTurnTreeOrder, stateLineage, turnNodeVisuals } from "./core/graph.js?v=20260826-node-lanes";
import { HIDDEN_POWER_TYPES, hiddenPowerTypeFromIvs, resolvedHiddenPowerType } from "./core/hidden_power.js";
import { formatDamageRollCounts, isCriticalOhkoOutcome, isHighRollKoOutcome, outcomePanelEvents } from "./core/outcome_presentation.js?v=20260826-hp-immunity";
import { createPlanDocument, planHasWork, upgradeInitialEntryEffects } from "./core/plan.js?v=20260825-download";
import { commitForcedReplacement, commitLabel, commitPreview, previewForcedReplacement, refreshUnknownCommittedProbabilities, repairStaleLeafBattleEnd } from "./core/planner.js?v=20260826-turn-nodes";
import { recalculatePlanDocument } from "./core/recalculation.js";
import { moveSupport } from "./rulesets/core_move_support.js";
import { experienceForLevel, experienceToNextLevel, projectVw2rExperience } from "./rulesets/vw2r_experience.js";
import { ResolverWorkerClient } from "./worker/resolver_client.js?v=20260826-turn-nodes";
import { battleCompletionState } from "./core/battle_completion.js?v=20260826-turn-nodes";
import {
  addBox, addParty, boxesForGame, createEmptyBoxLibrary, exportBoxLibrary, IndexedDbBoxLibraryStore,
  mergeBoxLibrary, parseBoxLibrary, removeBox, removeParty, removePokemon, renameBox, updateParty, upsertPokemon
} from "./boxes/library.js?v=20260825-hidden-power";
import { exportShowdown, parseShowdown } from "./boxes/showdown.js?v=20260825-hidden-power-v2";
import { parseVw2rSave, selectVw2rSavePokemon } from "./boxes/vw2r_save_import.js";

const GAME_REGISTRY = Object.freeze({
  "volt-white-2r": {
    name: "Pokémon Volt White 2 Redux Egglocke",
    datasetBaseUrl: new URL("./generated/datasets/volt-white-2r", import.meta.url).href
  }
});
const PUBLIC_BUILD = document.querySelector('meta[name="plc-build-profile"]')?.content === "public";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SELECTED_GAME_KEY = "plc-selected-game-v1";
const STAT_KEYS = Object.freeze(["hp", "atk", "def", "spa", "spd", "spe"]);
const STAT_LABELS = Object.freeze({ hp: "HP", atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe" });
const STATUS_LABELS = Object.freeze({ brn: "Burn", par: "Paralysis", psn: "Poison", tox: "Bad poison", slp: "Sleep", frz: "Freeze" });
const byId = id => document.getElementById(id);
const ui = Object.fromEntries([
  "game-select", "app-status", "game-gate", "app-tabs", "plc-tab", "boxes-tab", "plc-panel", "boxes-panel",
  "plan-toolbar-label", "output-state-anchor", "commit-turn", "save-plan", "new-plan", "live-edit-anchor", "workspace", "empty-plan",
  "node-tree", "turn-label", "revision-label", "battle-workspace", "player-action-panel", "enemy-action-panel", "field-state",
  "readiness", "preview-outcomes", "boxes-list", "save-import", "save-import-dialog", "save-import-filename",
  "save-import-party-summary", "save-import-pc-boxes", "save-import-status", "select-all-save-boxes", "clear-save-boxes",
  "confirm-save-import", "showdown-open", "new-box", "export-boxes", "import-boxes",
  "plan-context-dialog", "trainer-select", "battle-format", "variant-field", "variant-select", "plan-name",
  "initial-weather", "initial-terrain", "context-box-select", "party-source-mode", "saved-party-field",
  "context-party-select", "context-pokemon-grid", "save-party-selection", "party-selector-controls",
  "party-selection-summary", "edit-party-selection", "context-status", "begin-plan", "pokemon-editor-dialog",
  "pokemon-editor-form", "pokemon-editor-title", "editor-sprite-preview", "editor-box-id", "editor-pokemon-id", "editor-context", "editor-species",
  "editor-nickname", "editor-level", "editor-gender", "editor-nature", "editor-ability", "editor-item", "editor-hidden-power-type",
  "editor-hp-field", "editor-starting-hp", "editor-status-field", "editor-starting-status", "editor-stats",
  "editor-moves", "editor-error", "save-pokemon", "showdown-dialog", "showdown-text", "showdown-destination",
  "showdown-status", "copy-showdown", "import-showdown", "output-dialog", "export-selection", "output-plan",
  "recalculate-plan", "import-plan", "file-status", "live-stop-dialog", "live-save-quit", "live-keep-editing",
  "destructive-dialog", "destructive-message", "destructive-output", "destructive-discard"
].map(id => [id, byId(id)]));

const draftStore = new IndexedDbDraftStore();
const boxStore = new IndexedDbBoxLibraryStore();
let selectedGameId = null;
let dataset = null;
let worker = null;
let boxLibrary = createEmptyBoxLibrary();
let plan = null;
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
let liveWriter = null;
let liveButton = null;
let outputStateButton = null;
let localTestingStateApi = null;
let createLocalTestingStateSnapshot = null;
let activeTab = "plc";
let destructiveResolver = null;
let editorMoveRows = [];
let actionDraft = emptyActionDraft();
let contextSelection = emptyContextSelection();
let pendingSaveImport = null;

function emptyActionDraft() {
  return { player: [{}, {}], enemy: [{}, {}] };
}

function emptyContextSelection() {
  return { boxId: null, partyId: null, pokemonIds: [], saved: false, initialConditions: {} };
}

function setStatus(message, error = false) {
  ui["app-status"].textContent = message;
  ui["app-status"].classList.toggle("error", error);
}

function option(value, label, { disabled = false } = {}) {
  const node = document.createElement("option");
  node.value = value ?? "";
  node.textContent = label;
  node.disabled = disabled;
  return node;
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
  image.src = showdownSpriteUrl(record, dataset);
  image.alt = alt || record?.displayName || "Pokémon";
  image.loading = "lazy";
  image.addEventListener("error", () => {
    image.classList.add("sprite-unavailable");
    image.alt = "";
  }, { once: true });
  return image;
}

function recordName(record) {
  return record?.nickname || record?.displayName || record?.speciesId || "Pokémon";
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

function testingControlState() {
  const controls = {};
  for (const control of document.querySelectorAll("input[id], select[id], textarea[id]")) {
    if (control.type === "file" || control.type === "password") continue;
    controls[control.id] = {
      tag: control.tagName.toLowerCase(),
      type: control.type || null,
      value: control.value,
      checked: "checked" in control ? Boolean(control.checked) : null,
      disabled: Boolean(control.disabled),
      hidden: Boolean(control.hidden || control.closest("[hidden]"))
    };
  }
  return controls;
}

function testingViewState() {
  const elementScroll = {};
  for (const element of document.querySelectorAll("[id]")) {
    if (element.scrollLeft || element.scrollTop) elementScroll[element.id] = { left: element.scrollLeft, top: element.scrollTop };
  }
  return {
    path: location.pathname,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio
    },
    document: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight
    },
    windowScroll: { x: window.scrollX, y: window.scrollY },
    elementScroll,
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  };
}

function currentTestingState() {
  if (!createLocalTestingStateSnapshot) throw new Error("Local testing-state support is unavailable");
  const focused = document.activeElement && document.activeElement !== document.body
    ? { id: document.activeElement.id || null, tag: document.activeElement.tagName.toLowerCase() }
    : null;
  return createLocalTestingStateSnapshot({
    selectedGameId,
    activeTab,
    plan,
    boxLibrary,
    cursorStateNodeId,
    actionDraft,
    currentPreview,
    selectedPreviewOutcomeId,
    reviewOutcomeStateNodeId,
    outcomesExpanded: false,
    needsRecalculation,
    exportSelection,
    contextSelection,
    view: testingViewState(),
    controls: testingControlState(),
    openDialogIds: [...document.querySelectorAll("dialog[open][id]")].map(dialog => dialog.id),
    focusedElement: focused,
    liveEditActive: Boolean(liveWriter?.active)
  });
}

async function outputTestingState() {
  try {
    const snapshot = currentTestingState();
    outputStateButton.disabled = true;
    const receipt = await localTestingStateApi.storeLocalTestingState(snapshot);
    setStatus(`Testing state saved for Codex at ${receipt.storedAt}. No file-location prompt was opened.`);
  } catch (error) {
    setStatus(`Testing state output failed: ${error.message}`, true);
  } finally {
    outputStateButton.disabled = false;
  }
}

async function installTestingStateOutput() {
  if (PUBLIC_BUILD || !LOOPBACK_HOSTS.has(location.hostname) || !ui["output-state-anchor"]) return;
  const [testingApi, snapshotApi] = await Promise.all([
    import("./integrations/local_testing_state.js"),
    import("./testing/state_snapshot.js")
  ]);
  const capability = await testingApi.detectLocalTestingStateCapability();
  if (!capability) return;
  localTestingStateApi = testingApi;
  createLocalTestingStateSnapshot = snapshotApi.createTestingStateSnapshot;
  outputStateButton = button("Output State", "secondary");
  outputStateButton.id = "output-state";
  outputStateButton.title = "Save a testing snapshot of the current PLC and incomplete action selections for Codex";
  outputStateButton.addEventListener("click", outputTestingState);
  ui["output-state-anchor"].append(outputStateButton);
  Object.defineProperty(globalThis, "__PLC_TESTING_STATE__", {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ capture: currentTestingState })
  });
}

function setTab(name) {
  activeTab = name === "boxes" ? "boxes" : "plc";
  ui["plc-tab"].setAttribute("aria-selected", String(activeTab === "plc"));
  ui["boxes-tab"].setAttribute("aria-selected", String(activeTab === "boxes"));
  ui["plc-panel"].hidden = activeTab !== "plc";
  ui["boxes-panel"].hidden = activeTab !== "boxes";
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
  members.className = "party-members";
  for (let index = 0; index < 6; index += 1) members.append(partyMemberCell(box.pokemon[party.pokemonIds[index]]));
  const edit = button("Edit Party", "secondary");
  const editor = document.createElement("div");
  editor.className = "party-membership";
  editor.hidden = true;
  const renderMembership = () => {
    editor.replaceChildren();
    for (const pokemonId of box.pokemonOrder) {
      const record = box.pokemon[pokemonId];
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = party.pokemonIds.includes(pokemonId);
      input.addEventListener("change", async () => {
        const current = selectedBox(box.id)?.parties?.[party.id];
        let ids = [...(current?.pokemonIds || [])];
        if (input.checked && !ids.includes(pokemonId)) ids.push(pokemonId);
        if (!input.checked) ids = ids.filter(id => id !== pokemonId);
        if (ids.length > 6) { input.checked = false; setStatus("A Party can contain no more than six Pokémon.", true); return; }
        boxLibrary = updateParty(boxLibrary, selectedGameId, box.id, party.id, { pokemonIds: ids });
        await saveLibrary("Party membership updated.");
      });
      label.append(input, document.createTextNode(recordName(record)));
      editor.append(label);
    }
    const remove = button("Delete Party", "danger");
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete ${party.name}? The Pokémon records will remain in ${box.name}.`)) return;
      boxLibrary = removeParty(boxLibrary, selectedGameId, box.id, party.id);
      await saveLibrary("Party deleted; its Pokémon remain in the Box.");
    });
    editor.append(remove);
  };
  edit.addEventListener("click", () => { editor.hidden = !editor.hidden; edit.textContent = editor.hidden ? "Edit Party" : "Done"; if (!editor.hidden) renderMembership(); });
  card.append(name, members, edit, editor);
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
      className: "panel empty-plan", innerHTML: "<h2>No Boxes yet</h2><p>Import a .sav, paste Showdown sets, or create an empty Box.</p>"
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
    const result = upsertPokemon(boxLibrary, selectedGameId, boxId, draft);
    boxLibrary = result.library;
    if (ui["editor-context"].value === "plan") {
      const record = selectedBox(boxId).pokemon[result.pokemonId];
      const maxHp = calculateStats(record, dataset).hp;
      const hp = Math.max(0, Math.min(maxHp, Number(ui["editor-starting-hp"].value)));
      contextSelection.initialConditions[result.pokemonId] = { currentHp: hp, majorStatus: ui["editor-starting-status"].value || null };
      if (existingId && !contextSelection.pokemonIds.includes(existingId)) contextSelection.pokemonIds.push(existingId);
    }
    await saveLibrary("Pokémon saved. Every Party in this Box now uses the updated record.");
    ui["pokemon-editor-dialog"].close();
    renderContextPokemonGrid();
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
    setStatus(`Reading ${file.name} without modifying it…`);
    const imported = parseVw2rSave(await file.arrayBuffer(), dataset, { sourceName: file.name });
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
    const selected = selectVw2rSavePokemon(pendingSaveImport.imported, selectedSavePcBoxes());
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
  const members = team.map(member => `${member.displaySpecies || dataset.get("species", member.speciesId)?.name || member.speciesId} Lv. ${member.level}`).join(", ");
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

function updateVariantSelect() {
  const trainer = dataset?.trainer(ui["trainer-select"].value);
  const variants = trainer?.mechanicsVariants || [];
  ui["variant-field"].hidden = !variants.length;
  ui["variant-select"].replaceChildren();
  for (const variant of variants) ui["variant-select"].append(option(variant.id, variant.displayName || variant.name || `Variant ${variant.id}`));
  if (trainer) {
    try { ui["battle-format"].value = dataset.trainerBattleFormat(trainer.id) === "doubles" ? "Doubles" : "Singles"; }
    catch (error) { ui["battle-format"].value = error.message; }
    ui["plan-name"].value = `${trainer.displayName || trainer.name} Plan`;
  } else ui["battle-format"].value = "Select a trainer";
  updateBeginAvailability();
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
  contextSelection.initialConditions[record.id] = { currentHp: calculateStats(record, dataset).hp, majorStatus: null };
}

function contextPokemonCard(box, record, selected, manual) {
  const card = document.createElement("article");
  card.className = `context-pokemon${selected ? " is-selected" : ""}`;
  card.append(sprite(record));
  const body = document.createElement("div");
  const name = document.createElement("strong"); name.textContent = recordName(record);
  const detail = document.createElement("small"); detail.textContent = `${record.displayName} · Lv. ${record.level}`;
  body.append(name, detail); card.append(body);
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
  const edit = button("Edit", "secondary");
  edit.addEventListener("click", () => { ensureContextInitial(record); openPokemonEditor(box.id, record.id, true); });
  actions.append(edit); card.append(actions);
  return card;
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
    ui["context-pokemon-grid"].replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "Choose a Box. If you do not have one yet, open the Boxes tab and import a save or Showdown set." }));
    ui["save-party-selection"].disabled = true;
    return;
  }
  if (!manual) {
    const party = box.parties[ui["context-party-select"].value];
    contextSelection.partyId = party?.id || null;
    contextSelection.pokemonIds = party ? [...party.pokemonIds] : [];
  }
  const records = manual ? box.pokemonOrder.map(id => box.pokemon[id]) : contextSelection.pokemonIds.map(id => box.pokemon[id]).filter(Boolean);
  if (!records.length) ui["context-pokemon-grid"].replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: manual ? "This Box has no Pokémon." : "Select a saved Party with at least one Pokémon." }));
  else ui["context-pokemon-grid"].replaceChildren(...records.map(record => contextPokemonCard(box, record, contextSelection.pokemonIds.includes(record.id), manual)));
  ui["save-party-selection"].disabled = contextSelection.pokemonIds.length < 1 || contextSelection.pokemonIds.length > 6;
  updateBeginAvailability();
}

function renderPartySummary() {
  const records = selectedContextRecords();
  ui["party-selection-summary"].replaceChildren(...records.map(record => {
    ensureContextInitial(record);
    const card = contextPokemonCard(selectedBox(contextSelection.boxId), record, true, false);
    const details = card.querySelector("small");
    const initial = contextSelection.initialConditions[record.id];
    details.textContent += ` · ${initial.currentHp} HP${initial.majorStatus ? ` · ${STATUS_LABELS[initial.majorStatus]}` : ""}`;
    return card;
  }));
  ui["party-selector-controls"].hidden = true;
  ui["party-selection-summary"].hidden = false;
  ui["edit-party-selection"].hidden = false;
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
  const trainer = dataset?.trainer(ui["trainer-select"].value);
  let required = 1;
  if (trainer) {
    try { required = dataset.trainerBattleFormat(trainer.id) === "doubles" ? 2 : 1; } catch { required = 1; }
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
  ui["party-source-mode"].value = "party";
  updateVariantSelect();
  renderContextPokemonGrid();
  if (!ui["plan-context-dialog"].open) ui["plan-context-dialog"].showModal();
}

function boxRecordToSnapshot(record) {
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
    source: { kind: "boxes-library" }
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
  if ((liveWriter?.active || planHasWork(plan)) && !(await confirmDestructive("Beginning a clean plan"))) return;
  try {
    const trainer = dataset.trainer(ui["trainer-select"].value);
    const variantId = trainer.mechanicsVariants?.length ? ui["variant-select"].value : null;
    const records = selectedContextRecords();
    const players = normalizePlayerCollection({ party: records.map(boxRecordToSnapshot) }, dataset);
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
    setStatus(`Clean ${plan.game.battleFormat === "doubles" ? "Doubles" : "Singles"} plan ready for ${trainer.displayName}. Nothing has been sent to Overlay.`);
  } catch (error) { setStatus(error.message, true); }
}

function selectedState() {
  return plan?.stateNodes?.[cursorStateNodeId] || null;
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

function legalTargets(state, side, actorKey, targetMode) {
  const own = activeKeys(state, side).filter(key => Number(state.combatantStates[key]?.hp?.max) > 0);
  const otherSide = side === "player" ? "enemy" : "player";
  const opposing = activeKeys(state, otherSide).filter(key => Number(state.combatantStates[key]?.hp?.max) > 0);
  if (targetMode === "adjacentally") return own.filter(key => key !== actorKey);
  if (targetMode === "adjacentallyorself") return own;
  if (targetMode === "any") return [...opposing, ...own.filter(key => key !== actorKey)];
  return opposing;
}

function battleSlotNumber(side, slot) {
  return side === "player" ? slot + 1 : slot + 3;
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

function possibleSwitches(state, side) {
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
  return plan.stateNodes[plan.initialStateNodeId].combatantStates[key];
}

function initialStageBaseline(key, stat) {
  const root = plan.stateNodes[plan.initialStateNodeId];
  const path = `combatantStates.${key}.statStages.${stat}`;
  const initialChange = stateEvents(root).flatMap(event => event.changes || []).find(change => change.path === path);
  return initialChange ? Number(initialChange.from || 0) : Number(root.combatantStates[key]?.statStages?.[stat] || 0);
}

function staticDetail(label, value, className = "") {
  const cell = document.createElement("div"); cell.className = "static-detail";
  const small = document.createElement("small"); small.textContent = label;
  const strong = document.createElement("strong"); strong.textContent = value; if (className) strong.className = className;
  cell.append(small, strong); return cell;
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
  const candidates = legalTargets(state, side, actorKey, targetMode);
  const targetKey = support.target === "self" ? actorKey : support.target === "target" ? candidates[0] || null : null;
  setDraft(side, slot, { type: "move", moveId: move.id, targetKey, mechanicValue: null });
}

function chooseBranchEvent(dimensionId, optionId) {
  if (!currentPreview || !branchEventModel) return;
  reviewOutcomeStateNodeId = null;
  selectedPreviewOutcomeId = selectBranchEventOutcome(
    branchEventModel,
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
  for (const dimension of dimensions) wrapper.append(renderBranchControl(dimension));
  container.append(wrapper);
}

function renderActionAux(container, side, slot, actorKey, move, support, draft) {
  const state = selectedState();
  const targetMode = support.targetMode || canonicalTarget(move);
  const candidates = legalTargets(state, side, actorKey, targetMode);
  const opposingTargets = opposingMovePreviewTargets(state, side, actorKey, move, support);
  const usesSlotSelection = support.target === "target"
    && candidates.length > 1
    && opposingTargets.length === candidates.length;
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
      for (const mon of possibleSwitches(state, side)) select.append(option(mon.combatantKey, recordName(mon)));
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

function requestDamageLabel(span, actorKey, targetKey, moveId, { boundedSlotRange = false, enemyThreat = false } = {}) {
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
  worker.damagePreview({ plan, stateNodeId: cursorStateNodeId, actorKey, targetKey: previewTargetKey, moveId }).then(result => {
    if (generation === damageGeneration && span.isConnected) applyDamageLabel(span, result, boundedSlotRange);
  }).catch(error => {
    if (generation !== damageGeneration || !span.isConnected) return;
    applyDamageLabel(span, { status: "unavailable", label: error.message.includes("unsupported") ? "Unsupported" : "—" }, boundedSlotRange);
  });
}

function opposingMovePreviewTargets(state, side, actorKey, move, support) {
  if (plan.game?.battleFormat !== "doubles") return [];
  if (["self", "field"].includes(support.target)) return [];
  const opposingSide = side === "player" ? "enemy" : "player";
  const opposing = new Set(activeKeys(state, opposingSide));
  const targetMode = support.targetMode || canonicalTarget(move);
  return legalTargets(state, side, actorKey, targetMode).filter(key => opposing.has(key));
}

function renderDamagePreview(moveButton, side, actorKey, targetKey, moveId) {
  const damage = document.createElement("span");
  damage.className = "damage-label";
  damage.textContent = "…";
  moveButton.append(damage);
  requestDamageLabel(damage, actorKey, targetKey, moveId, { enemyThreat: side === "enemy" });
}

function renderSlotDamagePreviews(container, side, slot, actorKey, move, opposingTargets, draft, selectable) {
  for (const opposingKey of opposingTargets) {
    const section = selectable ? button("", "damage-slot") : document.createElement("span");
    section.className = "damage-slot";
    const slotName = targetSlotLabel(selectedState(), opposingKey);
    section.dataset.slotLabel = slotName;
    const label = document.createElement("small"); label.className = "damage-slot-label"; label.textContent = slotName;
    const value = document.createElement("span"); value.className = "damage-slot-value"; value.textContent = "…";
    section.append(label, value);
    if (selectable) {
      section.setAttribute("aria-label", `${move.name} targeting ${slotName}`);
      section.setAttribute("aria-pressed", String(draft.type === "move" && draft.moveId === move.id && draft.targetKey === opposingKey));
      section.addEventListener("click", () => {
        for (const sibling of section.parentElement.querySelectorAll("button.damage-slot")) sibling.setAttribute("aria-pressed", String(sibling === section));
        setDraft(side, slot, { type: "move", moveId: move.id, targetKey: opposingKey, mechanicValue: null });
      });
    }
    container.append(section);
    requestDamageLabel(value, actorKey, opposingKey, move.id, { boundedSlotRange: true, enemyThreat: side === "enemy" });
  }
}

function renderSwitchStrip(container, side, slot, actorKey, draft) {
  const state = selectedState();
  const strip = document.createElement("div"); strip.className = "switch-strip";
  const current = plan.combatants[actorKey];
  const currentCanStay = current && Number(state.combatantStates[actorKey]?.hp?.max) > 0;
  const candidates = [...(currentCanStay ? [current] : []), ...possibleSwitches(state, side)];
  const previewKey = draft.switchToKey || draft.previewSwitchToKey || (currentCanStay ? actorKey : null);
  for (const mon of candidates) {
    const target = button("", "switch-target");
    target.append(sprite(mon));
    const isCurrent = mon.combatantKey === actorKey;
    const name = document.createElement("span"); name.textContent = `${recordName(mon)}${isCurrent ? " · Current" : ""}`; target.append(name);
    target.classList.toggle("is-current", isCurrent);
    target.setAttribute("aria-label", `${recordName(mon)}${isCurrent ? " (current Pokémon; preview staying in)" : ""}`);
    target.setAttribute("aria-pressed", String(previewKey === mon.combatantKey));
    target.addEventListener("click", () => setDraft(side, slot, isCurrent
      ? { type: "switch", actorKey, previewSwitchToKey: actorKey }
      : { type: "switch", actorKey, switchToKey: mon.combatantKey, previewSwitchToKey: mon.combatantKey }));
    strip.append(target);
  }
  if (!candidates.length) strip.append(Object.assign(document.createElement("p"), { className: "empty", textContent: "No healthy bench Pokémon are available." }));
  container.append(strip);
}

function replacementSelectionReady(state) {
  const pending = pendingReplacementSlots(state);
  return pending.length > 0 && pending.every(entry => actionForSlot(entry.side, entry.slot).switchToKey);
}

function renderCombatantCard(side, slot) {
  const { state, committedState, events: previewEvents, previewing } = renderedStateContext();
  const actorKey = activeKey(committedState, side, slot);
  const original = plan.combatants[actorKey];
  const pending = pendingReplacementSlots(committedState).some(entry => entry.side === side && entry.slot === slot);
  const draft = actionForSlot(side, slot);
  if (pending && draft.type !== "switch") Object.assign(draft, { type: "switch", actorKey });
  const displayKey = draft.type === "switch" && (draft.switchToKey || draft.previewSwitchToKey) ? draft.switchToKey || draft.previewSwitchToKey : actorKey;
  const mon = plan.combatants[displayKey] || original;
  const committedMonState = committedState.combatantStates[displayKey];
  const monState = state.combatantStates[displayKey] || committedMonState;
  const rootState = rootCombatantState(displayKey);
  const card = document.createElement("article"); card.className = "combatant-card";
  if (plan.game?.battleFormat === "doubles") {
    const slotHeading = document.createElement("div");
    slotHeading.className = "combatant-slot-heading";
    slotHeading.textContent = `Slot ${battleSlotNumber(side, slot)}`;
    card.append(slotHeading);
  }
  const header = document.createElement("div"); header.className = "combatant-header";
  const spriteBox = document.createElement("div"); spriteBox.className = "combatant-sprite"; spriteBox.append(sprite(mon));
  const identity = document.createElement("div");
  const name = document.createElement("h3"); name.className = "combatant-name"; name.textContent = recordName(mon);
  const species = document.createElement("p"); species.className = "combatant-species"; species.textContent = mon.nickname ? mon.displayName : `${side === "player" ? "Player" : "Enemy"} slot ${slot + 1}`;
  const meta = document.createElement("div"); meta.className = "meta-row";
  const typeChanged = JSON.stringify(monState.currentTypeIds) !== JSON.stringify(rootState.currentTypeIds);
  const typePreviewChanged = previewing && JSON.stringify(monState.currentTypeIds) !== JSON.stringify(committedMonState.currentTypeIds);
  for (const type of monState.currentTypeIds) {
    const chip = document.createElement("span"); chip.className = `meta-chip ${valueTone(state, displayKey, `combatantStates.${displayKey}.currentTypeIds`, typeChanged, { previewChanged: typePreviewChanged, events: previewEvents })}`.trim(); chip.textContent = dataset.get("types", type)?.name || type; meta.append(chip);
  }
  const genderChip = document.createElement("span"); genderChip.className = "meta-chip"; genderChip.textContent = mon.gender || "—"; meta.append(genderChip);
  const currentLevel = Number(monState.currentLevel ?? mon.level);
  const rootLevel = Number(rootState.currentLevel ?? mon.level);
  const committedLevel = Number(committedMonState.currentLevel ?? mon.level);
  const levelChip = document.createElement("span");
  levelChip.className = `meta-chip ${valueTone(state, displayKey, `combatantStates.${displayKey}.currentLevel`, currentLevel !== rootLevel, { previewChanged: previewing && currentLevel !== committedLevel, events: previewEvents })}`.trim();
  levelChip.textContent = `Lv. ${currentLevel}`;
  meta.append(levelChip);
  identity.append(name, species, meta); header.append(spriteBox, identity); card.append(header);
  const details = document.createElement("div"); details.className = "static-details";
  const nature = dataset.get("natures", mon.natureId)?.name || "—";
  const ability = dataset.get("abilities", monState.currentAbilityId)?.name || "—";
  const item = monState.currentItemId ? dataset.get("items", monState.currentItemId)?.name || monState.currentItemId : "None";
  const hpChanged = monState.hp.min !== rootState.hp.min || monState.hp.max !== rootState.hp.max;
  const statusChanged = monState.majorStatus !== rootState.majorStatus;
  const abilityChanged = monState.currentAbilityId !== rootState.currentAbilityId;
  const itemChanged = monState.currentItemId !== rootState.currentItemId;
  details.append(
    staticDetail("Nature", nature),
    staticDetail("Ability", ability, valueTone(state, displayKey, `combatantStates.${displayKey}.currentAbilityId`, abilityChanged, { previewChanged: previewing && monState.currentAbilityId !== committedMonState.currentAbilityId, events: previewEvents })),
    staticDetail("Item", item, valueTone(state, displayKey, `combatantStates.${displayKey}.currentItemId`, itemChanged, { previewChanged: previewing && monState.currentItemId !== committedMonState.currentItemId, events: previewEvents })),
    staticDetail("Status", monState.majorStatus ? STATUS_LABELS[monState.majorStatus] || monState.majorStatus : "None", valueTone(state, displayKey, `combatantStates.${displayKey}.majorStatus`, statusChanged, { previewChanged: previewing && monState.majorStatus !== committedMonState.majorStatus, events: previewEvents })),
    staticDetail("HP", formatHpRemaining(monState.hp), valueTone(state, displayKey, `combatantStates.${displayKey}.hp`, hpChanged, { previewChanged: previewing && (monState.hp.min !== committedMonState.hp.min || monState.hp.max !== committedMonState.hp.max || monState.hp.maxHp !== committedMonState.hp.maxHp), events: previewEvents }))
  );
  if (side === "player" && Number.isInteger(monState.experience)) {
    const expChanged = monState.experience !== rootState.experience;
    const nextLevelThreshold = currentLevel < 100 ? experienceForLevel(currentLevel + 1, mon.growthRate) : null;
    details.append(staticDetail(
      "EXP",
      `${monState.experience.toLocaleString()}/${nextLevelThreshold === null ? "Max" : nextLevelThreshold.toLocaleString()}`,
      valueTone(state, displayKey, `combatantStates.${displayKey}.experience`, expChanged, { previewChanged: previewing && monState.experience !== committedMonState.experience, events: previewEvents })
    ));
  }
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
      const switchSelected = draft.type === "switch";
      moveButton.disabled = switchSelected || !support.supported || Number(committedMonState.movePp?.[entry.moveId] ?? entry.maxPp) <= 0;
      moveButton.title = switchSelected ? "Switch is selected for this slot" : support.supported ? "" : support.reason;
      moveButton.setAttribute("aria-pressed", String(draft.type === "move" && draft.moveId === entry.moveId));
      const copy = document.createElement("span"); copy.className = "move-copy";
      const moveName = document.createElement("strong"); moveName.textContent = move?.name || entry.moveId;
      const currentPp = monState.movePp?.[entry.moveId] ?? entry.maxPp;
      const rootPp = rootState.movePp?.[entry.moveId] ?? entry.maxPp;
      const moveMeta = document.createElement("small"); moveMeta.textContent = `${move?.type || "—"} · ${currentPp} PP${support.supported ? "" : " · unsupported"}`;
      moveMeta.className = valueTone(state, displayKey, `combatantStates.${displayKey}.movePp.${entry.moveId}`, currentPp !== rootPp, { previewChanged: previewing && currentPp !== Number(committedMonState.movePp?.[entry.moveId] ?? entry.maxPp), events: previewEvents });
      copy.append(moveName, moveMeta);
      moveButton.append(copy);
      moveButton.addEventListener("click", () => configureMoveDraft(side, slot, actorKey, move, support));
      if (support.supported) {
        const targetMode = support.targetMode || canonicalTarget(move);
        const candidates = legalTargets(committedState, side, actorKey, targetMode);
        const targetKey = support.target === "self" ? actorKey : support.target === "field" ? null : draft.moveId === move.id && draft.targetKey ? draft.targetKey : candidates[0];
        const opposingTargets = opposingMovePreviewTargets(committedState, side, actorKey, move, support);
        const selectableSlots = !switchSelected
          && support.target === "target"
          && opposingTargets.length > 0
          && opposingTargets.length === candidates.length;
        if (opposingTargets.length) {
          const group = document.createElement("div"); group.className = "move-button-group";
          group.append(moveButton);
          renderSlotDamagePreviews(group, side, slot, actorKey, move, opposingTargets, draft, selectableSlots);
          moveActions.append(group);
        } else {
          renderDamagePreview(moveButton, side, actorKey, targetKey, move.id);
          moveActions.append(moveButton);
        }
      } else {
        const damage = document.createElement("span"); damage.className = "damage-label"; damage.textContent = "Unsupported"; moveButton.append(damage);
        moveActions.append(moveButton);
      }
    if (draft.type === "move" && draft.moveId === entry.moveId) renderActionAux(moveActions, side, slot, actorKey, move, support, draft);
  }
  const replacementReady = pending && replacementSelectionReady(committedState) && currentPreview?.previewKind === "replacement";
  const replacementCount = pendingReplacementSlots(committedState).length;
  const switchButton = button(
    pending
      ? replacementReady ? `Confirm Replacement${replacementCount > 1 ? "s" : ""}` : `Choose Replacement${replacementCount > 1 ? "s" : ""}`
      : "Switch",
    "switch-button"
  );
  switchButton.setAttribute("aria-pressed", String(draft.type === "switch"));
  switchButton.addEventListener("click", () => {
    if (pending) {
      if (replacementReady) commitCurrentPreview();
      return;
    }
    if (draft.type === "switch") setDraft(side, slot, {});
    else setDraft(side, slot, { type: "switch", actorKey });
  });
  moveActions.append(switchButton);
  if (draft.type === "switch") renderSwitchStrip(moveActions, side, slot, actorKey, draft);
  card.append(moveActions);
  if (side === "enemy") updateEnemyThreatHighlights(card);
  return card;
}

function slotIsEmpty(state, side, slot) {
  const key = activeKey(state, side, slot);
  if (!key) return true;
  const pending = pendingReplacementSlots(state).some(entry => entry.side === side && entry.slot === slot);
  return !pending && Number(state.combatantStates[key]?.hp?.max) <= 0;
}

function renderEmptyCombatantSlot(side, slot) {
  const card = document.createElement("article");
  card.className = "combatant-card empty-combatant-slot";
  const slotHeading = document.createElement("div");
  slotHeading.className = "combatant-slot-heading";
  slotHeading.textContent = `Slot ${battleSlotNumber(side, slot)}`;
  const empty = document.createElement("p");
  empty.className = "empty-slot-label";
  empty.textContent = "Empty slot";
  card.append(slotHeading, empty);
  return card;
}

function renderActionPanel(side) {
  const panel = ui[`${side}-action-panel`];
  const doubles = plan.game.battleFormat === "doubles";
  panel.classList.toggle("is-doubles", doubles);
  const heading = document.createElement("div"); heading.className = "action-panel-title";
  const title = document.createElement("h2"); title.textContent = `${side === "player" ? "Player" : "Enemy"} Action`;
  const format = document.createElement("span"); format.className = "pill"; format.textContent = doubles ? "Doubles" : "Singles";
  heading.append(title, format);
  const state = selectedState();
  const slots = doubles ? [0, 1] : [0];
  const cards = slots.map(slot => slotIsEmpty(state, side, slot) ? renderEmptyCombatantSlot(side, slot) : renderCombatantCard(side, slot));
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
  if (draft.type === "switch") return draft.switchToKey ? { actionType: "switch", actorKey, switchToKey: draft.switchToKey, switchKind: "voluntary", declaredAtStateHash: state.stateHash } : null;
  if (draft.type !== "move" || !draft.moveId) return null;
  const move = dataset.get("moves", draft.moveId);
  const support = moveSupport(move, dataset);
  if (!support.supported) return null;
  const mode = support.targetMode || canonicalTarget(move);
  const opponent = side === "player" ? "enemy" : "player";
  const targetKeys = support.target === "self" ? [actorKey]
    : support.target === "field" ? []
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
    for (const entry of pending) replacements[entry.side].push(actionFromDraft(entry.side, entry.slot));
    return [...replacements.player, ...replacements.enemy].every(Boolean) ? replacements : null;
  }
  const actions = { player: [], enemy: [] };
  for (const side of ["player", "enemy"]) {
    actions[side] = activeSlotEntries(state, side)
      .filter(entry => Number(state.combatantStates[entry.combatantKey]?.hp?.max) > 0)
      .map(entry => actionFromDraft(side, entry.slot));
  }
  return [...actions.player, ...actions.enemy].every(Boolean) ? actions : null;
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
  if (currentPreview.previewKind === "replacement") return "Next Turn";
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
    if (min * hits >= hp) return `guaranteed ${label}`;
    if (hits <= 4) {
      const chance = koChance(values, hp, hits) * 100;
      return `${chance.toFixed(chance < 1 ? 2 : 1).replace(/\.0$/, "")}% chance to ${label}`;
    }
    return `possible ${label}`;
  }
  return "more than 9 hits to KO";
}

function eventDescription(event) {
  const move = dataset.get("moves", event.moveId || event.metadata?.moveId);
  const targetPrefix = event.targetKey && event.targetKey !== event.actorKey ? outcomeTargetSlotLabel(event.targetKey) : null;
  if (event.eventType === "damage") {
    const damage = event.damageHp || {};
    const percent = event.damagePercent || {};
    const rolls = (event.metadata?.damageRolls || []).map(Number).filter(Number.isFinite);
    const hpBefore = Number(event.metadata?.targetHpBefore?.max ?? event.metadata?.targetHpBefore?.min);
    const ko = koDescription(rolls.length ? rolls : [damage.min, damage.max], hpBefore);
    const critical = event.metadata?.criticalHit === true ? " · Critical hit" : "";
    return {
      line: [targetPrefix, move?.name || event.moveId, `${damage.min}-${damage.max} (${Number(percent.min).toFixed(1)} - ${Number(percent.max).toFixed(1)}%)${critical}${ko ? ` -- ${ko}` : ""}`].filter(Boolean).join(" · "),
      detail: rolls.length ? `Possible damage amounts: (${formatDamageRollCounts(rolls)})` : null
    };
  }
  if (event.eventType === "switch") return { line: [targetPrefix, "Switch", event.metadata?.resultLabel || "Replacement sent out"].filter(Boolean).join(" · ") };
  const parts = [targetPrefix, move?.name, event.metadata?.resultLabel || event.reason || event.eventType].filter(Boolean);
  return { line: parts.join(" · ") };
}

function outcomeActionGroups(events) {
  const groups = [];
  for (const event of events) {
    const displayKey = event.actorKey || event.targetKey || null;
    const previous = groups.at(-1);
    if (previous && previous.displayKey === displayKey) previous.events.push(event);
    else groups.push({ displayKey, events: [event] });
  }
  return groups;
}

function renderOutcomeAction(group, fallbackLabel = null) {
  const item = document.createElement("li"); item.className = "outcome-action";
  const spriteBox = document.createElement("div"); spriteBox.className = "outcome-action-sprite";
  const mon = group.displayKey ? plan.combatants[group.displayKey] : null;
  if (mon) spriteBox.append(sprite(mon, `${recordName(mon)} sprite`));
  else spriteBox.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div"); copy.className = "outcome-action-copy";
  for (const event of group.events) {
    const description = eventDescription(event);
    const detail = document.createElement("div"); detail.className = "outcome-event-detail";
    const line = document.createElement("p"); line.className = "event-line"; line.textContent = description.line;
    if (event.eventType === "battle-ended") line.classList.add("battle-ended-text");
    detail.append(line);
    if (description.detail) {
      const amounts = document.createElement("p"); amounts.className = "damage-amounts"; amounts.textContent = description.detail;
      detail.append(amounts);
    }
    copy.append(detail);
  }
  if (!group.events.length && fallbackLabel) {
    const line = document.createElement("p"); line.className = "event-line"; line.textContent = fallbackLabel;
    copy.append(line);
  }
  item.append(spriteBox, copy);
  return item;
}

function outcomeSplitReason(entry, allEntries) {
  const outcome = entry.outcome || entry;
  const events = outcomePanelEvents(entry.events || []);
  const criticalOhko = isCriticalOhkoOutcome(entry);
  const highRollKo = isHighRollKoOutcome(entry, allEntries);
  if (criticalOhko) return "Critical-hit OHKO";
  if (highRollKo) return "Damage high roll causes a KO";
  const miss = events.find(event => event.eventType === "miss");
  if (miss) return `${dataset.get("moves", miss.moveId)?.name || miss.moveId} misses`;
  const skipped = events.find(event => event.eventType === "action-skipped");
  if (skipped) return skipped.metadata?.resultLabel || skipped.reason || "Action skipped";
  const noSecondary = events.find(event => event.eventType === "secondary-effect-missed");
  if (noSecondary) return `${dataset.get("moves", noSecondary.moveId)?.name || noSecondary.moveId}: no secondary effect`;
  const critical = events.find(event => event.eventType === "damage" && event.metadata?.criticalHit === true);
  if (critical) return `${dataset.get("moves", critical.moveId)?.name || critical.moveId} lands a critical hit`;
  const branchingEffect = events.find(event => [
    "major-status", "volatile-status", "status-failed", "volatile-status-failed", "move-blocked", "move-immune",
    "protect", "stat-stage-change", "heal", "field-change", "confusion-self-hit"
  ].includes(event.eventType) && event.metadata?.resultLabel);
  if (branchingEffect) return branchingEffect.metadata.resultLabel;
  const ko = events.find(event => event.eventType === "damage" && event.metadata?.thresholdOutcome === "ko");
  if (ko) return `${recordName(plan.combatants[ko.targetKey])} faints`;
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
  const selectedChoices = selectedBranchChoices(branchEventModel, selectedPreviewOutcomeId);
  const selectedDimensions = (branchEventModel?.dimensions || []).filter(dimension => selectedChoices[dimension.id]);
  if (selectedDimensions.length) {
    const summary = document.createElement("div"); summary.className = "branch-selection-summary";
    for (const dimension of selectedDimensions) {
      const chip = document.createElement("span");
      chip.textContent = `${dimension.label}: ${selectedChoices[dimension.id].label}`;
      summary.append(chip);
    }
    nodes.push(summary);
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
    selectedPreviewOutcomeId = branchEventModel.selectedOutcomeId;
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
    ui["commit-turn"].disabled = replacement;
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
  const format = document.createElement("span"); format.textContent = plan.game.battleFormat === "doubles" ? "Doubles" : "Singles";
  identity.append(trainer, format); wrapper.append(identity);
  const effects = [];
  const global = state.fieldState.global;
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
    .map(enemyKey => ({ enemyKey, projection: projectVw2rExperience(plan, state, enemyKey) }))
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
      const result = action.actionType === "move" ? dataset.get("moves", action.moveId)?.name || action.moveId : `Switch to ${recordName(plan.combatants[action.switchToKey])}`;
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

function renderTree() {
  const currentState = selectedState();
  const selectedCommittedStateNodeId = reviewOutcomeStateNodeId || (battleActuallyEnded(currentState) ? cursorStateNodeId : null);
  const selectedLineage = new Set(stateLineage(plan, selectedCommittedStateNodeId || cursorStateNodeId));
  const additionalDraftStateNodeIds = !reviewOutcomeStateNodeId && !battleActuallyEnded(currentState) ? [cursorStateNodeId] : [];
  const ordered = planTurnTreeOrder(plan, { additionalDraftStateNodeIds });
  const groups = new Map();
  for (const entry of ordered) {
    const key = Number(entry.turnNumber);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const columns = [...groups.entries()].sort(([a], [b]) => a - b).map(([turn, entries], columnIndex) => {
    const column = document.createElement("div"); column.className = "node-column"; column.dataset.column = columnIndex;
    const title = document.createElement("p"); title.className = "node-column-title"; title.textContent = `Turn ${turn}`; column.append(title);
    entries.forEach((entry, rowIndex) => {
      const state = entry.kind === "committed" ? plan.stateNodes[entry.outcomeStateNodeId] : plan.stateNodes[entry.decisionStateNodeId];
      const draftPreview = entry.kind === "draft"
        && !reviewOutcomeStateNodeId
        && entry.decisionStateNodeId === cursorStateNodeId
        && currentPreview?.previewKind !== "replacement"
        && currentPreview?.baseStateNodeId === cursorStateNodeId
        ? defaultPreviewEntry()
        : null;
      const outcome = entry.kind === "committed" ? state.outcome : draftPreview?.outcome || null;
      const node = button("", "node-button");
      node.dataset.column = columnIndex; node.dataset.row = rowIndex; node.dataset.lane = entry.lane; node.style.gridColumn = "1"; node.style.gridRow = String(Number(entry.lane) + 2); node.setAttribute("role", "treeitem");
      node.dataset.kind = entry.kind;
      node.dataset.stateNodeId = entry.outcomeStateNodeId || entry.decisionStateNodeId;
      const selected = entry.kind === "committed"
        ? entry.outcomeStateNodeId === selectedCommittedStateNodeId
        : !reviewOutcomeStateNodeId && entry.decisionStateNodeId === cursorStateNodeId && !battleActuallyEnded(state);
      node.setAttribute("aria-selected", String(selected));
      node.classList.toggle("is-draft", entry.kind === "draft");
      node.classList.toggle("is-ancestor", entry.kind === "committed" && selectedLineage.has(entry.outcomeStateNodeId) && !selected);
      const probability = outcome ? probabilityLabel(outcome) : "—";
      const visibleProbability = document.createElement("span"); visibleProbability.className = "node-probability"; visibleProbability.textContent = probability;
      const visualOutcomeState = entry.kind === "committed" ? state : draftPreview?.state || draftPreview || null;
      const visualActions = entry.kind === "committed" ? plan.actionGroups[state.parentActionGroupId]?.actions : draftPreview ? currentPreview?.actions : null;
      const visuals = turnNodeVisuals(plan, entry.decisionStateNodeId, visualOutcomeState, visualActions);
      node.classList.toggle("has-faint", visuals.hasFaint);
      const sprites = document.createElement("span"); sprites.className = "node-sprites";
      for (const combatantKey of visuals.combatantKeys) {
        const mon = plan.combatants[combatantKey];
        const holder = document.createElement("span"); holder.className = "node-sprite";
        const fainted = visuals.faintedCombatantKeys.has(combatantKey);
        holder.classList.toggle("has-faint", fainted);
        holder.title = `${recordName(mon)}${fainted ? " fainted" : ""}`;
        holder.append(sprite(mon)); sprites.append(holder);
      }
      const summary = entry.kind === "committed"
        ? `${state.outcome.label} · ${nodeActionSummary(state)}`
        : draftPreview ? `${(draftPreview.outcome || draftPreview).label || "Crafted outcome"}` : "Awaiting turn actions";
      const faintSummary = visuals.hasFaint ? ` · Fainted: ${[...visuals.faintedCombatantKeys].map(key => recordName(plan.combatants[key])).join(", ")}` : "";
      node.setAttribute("aria-label", `Turn ${turn} · ${probability} · ${summary}${faintSummary}`);
      node.append(visibleProbability);
      if (sprites.childElementCount) node.append(sprites);
      node.addEventListener("click", () => entry.kind === "committed" ? selectTurnOutcome(entry.outcomeStateNodeId) : selectStateNode(entry.decisionStateNodeId));
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
        : { type: "move", moveId: action.moveId, targetKey: action.targetKeys?.[0] || null, mechanicValue: action.mechanicActivations?.[0]?.switchToKey || action.mechanicActivations?.[0]?.typeId || action.mechanicActivations?.[0]?.moveId || null };
    });
  }
}

function renderExportSelection() {
  if (!plan) { ui["export-selection"].replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "No active plan. Import a plan file or begin a clean plan." })); ui["output-plan"].disabled = true; return; }
  const visibleEntries = planTreeOrder(plan, { includeReplacementStates: false }).filter(entry => entry.state.turnNumber > 0);
  const visibleIds = new Set(visibleEntries.map(entry => entry.state.stateNodeId));
  for (const stateId of exportSelection) if (!visibleIds.has(stateId)) exportSelection.delete(stateId);
  const nodes = visibleEntries.map(({ state }) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = exportSelection.has(state.stateNodeId);
    checkbox.addEventListener("change", () => { checkbox.checked ? exportSelection.add(state.stateNodeId) : exportSelection.delete(state.stateNodeId); ui["output-plan"].disabled = needsRecalculation || !exportSelection.size; });
    const text = document.createElement("span"); text.textContent = `Turn ${state.turnNumber} · ${state.outcome.label} · ${nodeActionSummary(state)}`;
    label.append(checkbox, text); return label;
  });
  ui["export-selection"].replaceChildren(...nodes);
  ui["output-plan"].disabled = needsRecalculation || !exportSelection.size;
}

function renderWorkspace() {
  const hasPlan = Boolean(plan);
  ui.workspace.hidden = !hasPlan;
  ui["empty-plan"].hidden = hasPlan;
  ui["battle-workspace"].classList.toggle("is-doubles", hasPlan && plan.game.battleFormat === "doubles");
  ui["plan-toolbar-label"].textContent = hasPlan ? `${plan.name} · ${currentTrainerName()} · ${plan.game.battleFormat === "doubles" ? "Doubles" : "Singles"}` : "No battle plan open";
  ui["commit-turn"].disabled = true;
  if (liveButton) { liveButton.disabled = !hasPlan || needsRecalculation; liveButton.textContent = liveWriter?.active ? "Stop Live Edit" : "Begin Live Edit"; }
  ui["recalculate-plan"].hidden = !hasPlan || !needsRecalculation;
  if (!hasPlan) return;
  ui["revision-label"].textContent = `Draft r${plan.documentRevision}`;
  const selected = selectedState();
  const reviewed = reviewOutcomeStateNodeId ? plan.stateNodes[reviewOutcomeStateNodeId] : null;
  const turnNumber = reviewed ? Number(reviewed.turnNumber) : battleActuallyEnded(selected) ? Number(selected.turnNumber) : Number(selected.turnNumber) + 1;
  ui["turn-label"].textContent = `Turn ${turnNumber}`;
  ui["commit-turn"].textContent = battleCompletionState(plan, selected).commitLabel;
  renderTree(); renderField(); renderActionPanels(); renderExportSelection();
  if (battleActuallyEnded(selectedState())) { ui.readiness.textContent = "The battle has ended."; clearPreview("The battle has ended."); }
  else if (needsRecalculation) { ui.readiness.textContent = "Recalculation is required."; clearPreview("This imported plan needs recalculation under the current mechanics fingerprint."); }
  else refreshPreview();
}

async function persistDraft() {
  if (!plan) return;
  draftRecord = draftRecord ? updateDraftRecord(draftRecord, plan, cursorStateNodeId) : createDraftRecord(plan, cursorStateNodeId);
  await draftStore.save(draftRecord);
}

async function flushLiveEdit() {
  if (!liveWriter?.active || !plan) return;
  await liveWriter.flush(plan);
  draftRecord = markLiveFlushed(draftRecord, { ...liveWriter.session, documentRevision: plan.documentRevision });
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
    await flushLiveEdit();
    renderWorkspace();
    setStatus(lockingBattleEnd ? "Battle-ending branch locked in the local draft." : replacementCommit ? "Replacement prepared for the next turn." : result.outcomeAdded ? "Crafted outcome branch added to the local draft." : result.created ? "Turn committed to the local draft." : "Opened the existing branch.");
  } catch (error) { setStatus(error.message, true); }
}

async function outputPlan() {
  try {
    if (!plan) throw new Error("No active plan is available to output");
    if (needsRecalculation) throw new Error("Recalculate this plan before outputting it");
    const selected = [...exportSelection];
    const { plan: output } = exportSelectedPlan(plan, selected);
    downloadPlan(output);
    const all = planTreeOrder(plan, { includeReplacementStates: false }).filter(({ state }) => state.turnNumber > 0).map(({ state }) => state.stateNodeId);
    const complete = all.every(id => exportSelection.has(id));
    draftRecord = markExported(draftRecord, { complete, selectedStateNodeIds: selected });
    await draftStore.save(draftRecord);
    ui["file-status"].textContent = complete ? "The full current draft was downloaded." : "The selected branch subset was downloaded; omitted branches remain in the local draft.";
  } catch (error) { ui["file-status"].textContent = error.message; }
}

async function importPlanFile(file) {
  if (!file || !dataset) return;
  if ((liveWriter?.active || planHasWork(plan)) && !(await confirmDestructive("Importing another plan"))) return;
  try {
    let imported = parsePlan(await file.text());
    assertValidPlanDocument(imported);
    if (imported.game.gameId !== selectedGameId) throw new Error(`This plan belongs to ${imported.game.gameId}; select that game first`);
    validatePlanReferences(imported, dataset);
    const initialUpgrade = upgradeInitialEntryEffects(imported, dataset);
    imported = initialUpgrade.plan;
    const hasResolvedBranches = Object.keys(imported.actionGroups || {}).length > 0 || Object.keys(imported.replacementTransitions || {}).length > 0;
    needsRecalculation = mechanicsCompatibility(imported, dataset).needsRecalculation || (initialUpgrade.changed && hasResolvedBranches);
    const probabilityRepair = needsRecalculation ? { plan: imported, refreshedStateNodeIds: [] } : await repairUnknownGraphProbabilities(imported);
    plan = probabilityRepair.plan;
    cursorStateNodeId = plan.initialStateNodeId;
    reviewOutcomeStateNodeId = null;
    actionDraft = emptyActionDraft();
    exportSelection.clear();
    draftRecord = createDraftRecord(plan, cursorStateNodeId);
    draftRecord.needsRecalculation = needsRecalculation;
    await draftStore.save(draftRecord);
    renderWorkspace();
    ui["output-dialog"].close();
    setStatus(needsRecalculation
      ? "Plan imported read-only; mechanics fingerprints differ and recalculation is required."
      : `Plan imported into the local draft.${probabilityRepair.refreshedStateNodeIds.length ? ` Repaired ${probabilityRepair.refreshedStateNodeIds.length} stale graph ${probabilityRepair.refreshedStateNodeIds.length === 1 ? "probability" : "probabilities"}.` : ""} Nothing has been sent to Overlay.`, needsRecalculation);
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
    setStatus("Recalculation completed. Review the rebuilt branches before output or Live Edit.");
  } catch (error) { plan = original; setStatus(`Recalculation stopped without replacing the imported plan: ${error.message}`, true); }
  finally { ui["recalculate-plan"].disabled = false; }
}

async function beginLiveEdit() {
  if (!plan || !liveWriter) return;
  try {
    const session = await liveWriter.begin(plan, draftRecord?.localLiveEdit || {});
    draftRecord = markLiveFlushed(draftRecord, { ...session, documentRevision: plan.documentRevision });
    await draftStore.save(draftRecord);
    renderWorkspace();
    setStatus(`Live Edit started at revision ${session.liveRevision}. Overlay still requires its own attach and explicit Send Turns.`);
  } catch (error) { setStatus(error.message, true); }
}

async function stopLiveEdit() {
  if (!liveWriter?.active || !plan) return;
  try {
    await liveWriter.stop(plan);
    draftRecord = setLocalLiveEdit(draftRecord, null);
    await draftStore.save(draftRecord);
    renderWorkspace();
    ui["live-stop-dialog"].showModal();
  } catch (error) { setStatus(error.message, true); }
}

async function installLocalLiveEdit() {
  if (PUBLIC_BUILD || !LOOPBACK_HOSTS.has(location.hostname) || !ui["live-edit-anchor"]) return;
  const { detectLocalLiveEditCapability, LocalLiveEditWriter } = await import("./integrations/local_live_edit.js");
  const capability = await detectLocalLiveEditCapability();
  if (!capability || liveButton) return;
  liveWriter = new LocalLiveEditWriter({ onError: error => setStatus(`Live Edit heartbeat failed: ${error.message}`, true) });
  liveButton = button("Begin Live Edit");
  liveButton.addEventListener("click", () => liveWriter.active ? stopLiveEdit() : beginLiveEdit());
  ui["live-edit-anchor"].append(liveButton);
  if (plan && draftRecord?.localLiveEdit) {
    try {
      const session = await liveWriter.begin(plan, draftRecord.localLiveEdit);
      draftRecord = markLiveFlushed(draftRecord, { ...session, documentRevision: plan.documentRevision });
      await draftStore.save(draftRecord);
      setStatus("Recovered the active local Live Edit writer. Overlay publication remains explicit.");
    } catch {
      draftRecord = setLocalLiveEdit(draftRecord, null);
      await draftStore.save(draftRecord);
    }
  }
  renderWorkspace();
}

async function confirmDestructive(actionLabel) {
  if (liveWriter?.active) {
    await stopLiveEdit();
    setStatus(`${actionLabel} paused because Live Edit had to stop first. Choose the stop flow, then request the change again.`);
    return false;
  }
  const notice = destructiveTransitionNotice(draftRecord, actionLabel);
  if (!notice) return true;
  ui["destructive-message"].textContent = notice.message;
  ui["destructive-output"].hidden = notice.currentExportExists;
  ui["destructive-discard"].textContent = notice.currentExportExists ? "Clear and Continue" : "Discard and Continue";
  return new Promise(resolve => {
    destructiveResolver = resolve;
    ui["destructive-dialog"].showModal();
  });
}

async function resolveDestructive(choice) {
  if (!destructiveResolver) return;
  const resolve = destructiveResolver; destructiveResolver = null;
  if (choice === "output") {
    try {
      const all = Object.values(plan.stateNodes).filter(state => state.turnNumber > 0).map(state => state.stateNodeId);
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
    needsRecalculation = Boolean(cached.needsRecalculation) || (initialUpgrade.changed && hasResolvedBranches);
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
  if (!gameId) return;
  if (selectedGameId && selectedGameId !== gameId && (liveWriter?.active || planHasWork(plan)) && !(await confirmDestructive("Changing games"))) {
    ui["game-select"].value = selectedGameId;
    return;
  }
  const config = GAME_REGISTRY[gameId];
  if (!config) { setStatus(`No PLC adapter is registered for ${gameId}.`, true); return; }
  try {
    setStatus(`Loading ${config.name} data and battle mechanics…`);
    if (selectedGameId && selectedGameId !== gameId) await clearActiveContext();
    worker?.terminate();
    dataset = await loadStandardizedDataset({ baseUrl: config.datasetBaseUrl });
    worker = new ResolverWorkerClient();
    await worker.initialize(config.datasetBaseUrl);
    selectedGameId = gameId;
    localStorage.setItem(SELECTED_GAME_KEY, gameId);
    ui["game-gate"].hidden = true;
    ui["app-tabs"].hidden = false;
    fillTrainerSelect();
    initializePokemonEditor();
    renderBoxes();
    refreshContextBoxSelect();
    setTab(activeTab);
    const restored = await restoreDraft();
    await installLocalLiveEdit();
    setStatus(restored ? `Recovered the active ${config.name} draft. Nothing has been sent to Overlay.` : `${config.name} is ready. Add or select a Box party to begin.`);
    if (!restored) queueMicrotask(() => openPlanContext());
  } catch (error) {
    setStatus(error.message, true);
    ui["game-select"].value = selectedGameId || "";
  }
}

function wireEvents() {
  ui["game-select"].addEventListener("change", () => selectGame(ui["game-select"].value));
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
  ui["variant-select"].addEventListener("change", updateBeginAvailability);
  ui["context-box-select"].addEventListener("change", () => { contextSelection = { ...emptyContextSelection(), boxId: ui["context-box-select"].value || null }; refreshContextPartySelect(); renderContextPokemonGrid(); });
  ui["party-source-mode"].addEventListener("change", () => { contextSelection.pokemonIds = []; contextSelection.partyId = null; contextSelection.saved = false; refreshContextPartySelect(); renderContextPokemonGrid(); });
  ui["context-party-select"].addEventListener("change", () => { contextSelection.partyId = ui["context-party-select"].value || null; contextSelection.saved = false; renderContextPokemonGrid(); });
  ui["save-party-selection"].addEventListener("click", savePartySelection);
  ui["edit-party-selection"].addEventListener("click", () => { contextSelection.saved = false; ui["party-selector-controls"].hidden = false; ui["party-selection-summary"].hidden = true; ui["edit-party-selection"].hidden = true; renderContextPokemonGrid(); });
  ui["begin-plan"].addEventListener("click", beginPlanFromContext);
  ui["save-pokemon"].addEventListener("click", savePokemonEditor);
  ui["new-plan"].addEventListener("click", () => openPlanContext());
  ui["commit-turn"].addEventListener("click", commitCurrentPreview);
  ui["save-plan"].addEventListener("click", () => { renderExportSelection(); ui["output-dialog"].showModal(); });
  ui["output-plan"].addEventListener("click", outputPlan);
  ui["import-plan"].addEventListener("change", () => importPlanFile(ui["import-plan"].files?.[0]));
  ui["recalculate-plan"].addEventListener("click", recalculateImportedPlan);
  ui["live-save-quit"]?.addEventListener("click", () => setTimeout(() => { renderExportSelection(); ui["output-dialog"].showModal(); }, 0));
  ui["live-keep-editing"]?.addEventListener("click", () => setStatus("Live writing remains stopped. The same local draft is still open."));
  ui["destructive-dialog"].addEventListener("close", () => resolveDestructive(ui["destructive-dialog"].returnValue));
  window.addEventListener("beforeunload", () => { worker?.terminate(); liveWriter?.stopHeartbeat?.(); });
}

async function start() {
  wireEvents();
  await installTestingStateOutput();
  try {
    boxLibrary = await boxStore.load() || createEmptyBoxLibrary();
    setStatus("Select a game to load its Boxes, trainers, and mechanics.");
  } catch (error) { setStatus(`Boxes storage could not be opened: ${error.message}`, true); }
}

start();
