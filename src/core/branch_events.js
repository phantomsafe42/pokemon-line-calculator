function outcomeId(entry) {
  return entry?.previewOutcomeId || entry?.stateNodeId || entry?.state?.stateNodeId || null;
}

function outcomeEvents(entry) {
  return Array.isArray(entry?.events) ? entry.events : [];
}

function outcomeProbability(entry) {
  const value = Number(entry?.outcome?.probability ?? entry?.probability);
  return Number.isFinite(value) ? value : null;
}

function flattenedActions(actions = {}) {
  return ["player", "enemy"].flatMap(side => {
    const raw = actions?.[side];
    const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return entries.map((action, slot) => ({ side, slot, action }));
  });
}

function eventFor(events, predicate) {
  return events.find(predicate) || null;
}

function eventsForMove(events, action) {
  return events.filter(event => event.actorKey === action.actorKey && event.moveId === action.moveId);
}

function statusSignature(event) {
  if (event.eventType === "major-status") return `major:${event.metadata?.statusId || "status"}`;
  if (event.eventType === "volatile-status") return `volatile:${event.metadata?.volatileStatusId || "status"}`;
  return null;
}

function statusLabel(signature) {
  const id = String(signature || "").split(":")[1] || "status";
  const labels = {
    brn: "Burn",
    confusion: "Confusion",
    flinch: "Flinch",
    frz: "Freeze",
    par: "Paralysis",
    psn: "Poison",
    slp: "Sleep",
    tox: "Bad poison"
  };
  return labels[id] || id.replace(/(^|[-_])(\w)/g, (_, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

function actionCheckValue(events, actorKey) {
  const snapped = eventFor(events, event => event.actorKey === actorKey
    && event.eventType === "volatile-status-cleared"
    && event.metadata?.volatileStatusId === "confusion");
  if (snapped) return { id: "confusion-snapped", label: "Snaps out" };
  const selfHit = eventFor(events, event => event.actorKey === actorKey && event.eventType === "confusion-self-hit");
  if (selfHit) return { id: "confusion-self-hit", label: "Self-hit" };
  const confusionAct = eventFor(events, event => event.actorKey === actorKey && event.eventType === "confusion-check" && event.metadata?.outcome === "acted");
  if (confusionAct) return { id: "confusion-acted", label: "Acts through confusion" };
  const woke = eventFor(events, event => event.actorKey === actorKey
    && event.eventType === "status-cleared"
    && event.metadata?.cause === "wake");
  if (woke) return { id: "sleep-woke", label: "Wakes up" };
  const asleep = eventFor(events, event => event.actorKey === actorKey && event.eventType === "action-skipped" && event.reason === "sleep");
  if (asleep) return { id: "sleep-asleep", label: "Remains asleep" };
  return null;
}

function dimensionKey(parts) {
  return parts.filter(value => value !== null && value !== undefined && value !== "").join(":");
}

function addChoice(choices, definitions, definition, value) {
  if (!value) return;
  definitions.set(definition.id, { ...definitions.get(definition.id), ...definition });
  choices[definition.id] = value;
}

function moveTargetKeys(outcomes, action) {
  const keys = new Set(action.targetKeys || []);
  for (const entry of outcomes) {
    for (const event of eventsForMove(outcomeEvents(entry), action)) {
      if (event.targetKey) keys.add(event.targetKey);
    }
  }
  return [...keys];
}

function secondaryProfiles(outcomes, action, targetKey) {
  const profiles = new Set();
  for (const entry of outcomes) {
    for (const event of eventsForMove(outcomeEvents(entry), action)) {
      if (event.targetKey !== targetKey) continue;
      const signature = statusSignature(event);
      if (signature) profiles.add(signature);
    }
  }
  return [...profiles];
}

function choicesForOutcome(entry, outcomes, actions, definitions) {
  const events = outcomeEvents(entry);
  const choices = {};
  for (const { side, slot, action } of flattenedActions(actions)) {
    if (!action?.actorKey) continue;
    const check = actionCheckValue(events, action.actorKey);
    if (check) {
      const checkKind = check.id.startsWith("sleep-") ? "sleep" : "confusion";
      addChoice(choices, definitions, {
        id: dimensionKey(["action-check", action.actorKey, checkKind]),
        scope: "action",
        kind: `${checkKind}-check`,
        actorKey: action.actorKey,
        side,
        slot,
        label: checkKind === "sleep" ? "Sleep check" : "Confusion check"
      }, check);
    }
    if (action.actionType !== "move" || !action.moveId) continue;
    const moveEvents = eventsForMove(events, action);
    const skipped = eventFor(events, event => event.actorKey === action.actorKey
      && (event.eventType === "action-skipped" || event.eventType === "confusion-self-hit"));
    const miss = eventFor(moveEvents, event => event.eventType === "miss");
    const executed = moveEvents.some(event => !["confusion-check"].includes(event.eventType));
    addChoice(choices, definitions, {
      id: dimensionKey(["accuracy", action.actorKey, action.moveId]),
      scope: "move",
      kind: "accuracy",
      actorKey: action.actorKey,
      moveId: action.moveId,
      side,
      slot,
      label: "Accuracy"
    }, miss ? { id: "miss", label: "Misses" } : skipped || !executed ? { id: "not-reached", label: "Not reached" } : { id: "hit", label: "Hits" });

    const damageEvents = moveEvents.filter(event => event.eventType === "damage");
    addChoice(choices, definitions, {
      id: dimensionKey(["critical", action.actorKey, action.moveId]),
      scope: "move",
      kind: "critical",
      actorKey: action.actorKey,
      moveId: action.moveId,
      side,
      slot,
      label: "Critical hit"
    }, damageEvents.length
      ? damageEvents.some(event => event.metadata?.criticalHit === true) ? { id: "critical", label: "Crit" } : { id: "normal", label: "Normal" }
      : { id: "not-reached", label: "Not reached" });

    for (const targetKey of moveTargetKeys(outcomes, action)) {
      const damage = eventFor(damageEvents, event => event.targetKey === targetKey);
      addChoice(choices, definitions, {
        id: dimensionKey(["damage-result", action.actorKey, action.moveId, targetKey]),
        scope: "move",
        kind: "damage-result",
        actorKey: action.actorKey,
        targetKey,
        moveId: action.moveId,
        side,
        slot,
        label: "Damage result"
      }, damage ? {
        id: damage.metadata?.thresholdOutcome === "ko" ? "ko" : "survive",
        label: damage.metadata?.thresholdOutcome === "ko" ? "Faints" : "Survives"
      } : { id: "not-reached", label: "Not reached" });

      for (const profile of secondaryProfiles(outcomes, action, targetKey)) {
        const applied = eventFor(moveEvents, event => event.targetKey === targetKey && statusSignature(event) === profile);
        const missedSecondary = eventFor(moveEvents, event => event.targetKey === targetKey && event.eventType === "secondary-effect-missed");
        const label = statusLabel(profile);
        addChoice(choices, definitions, {
          id: dimensionKey(["secondary", action.actorKey, action.moveId, targetKey, profile]),
          scope: "move",
          kind: "secondary",
          actorKey: action.actorKey,
          targetKey,
          moveId: action.moveId,
          side,
          slot,
          effectLabel: label,
          label: `${label} effect`
        }, applied ? { id: "applied", label } : missedSecondary ? { id: "not-applied", label: `No ${label}` } : { id: "not-reached", label: "Not reached" });
      }
    }
  }
  return choices;
}

function dimensionIsSelectable(dimension) {
  const optionIds = new Set(dimension.options.map(option => option.id));
  if (dimension.kind === "accuracy") return optionIds.has("hit") && optionIds.has("miss");
  if (dimension.kind === "critical") return optionIds.has("normal") && optionIds.has("critical");
  if (dimension.kind === "damage-result") return optionIds.has("survive") && optionIds.has("ko");
  if (dimension.kind === "secondary") return optionIds.has("applied") && optionIds.has("not-applied");
  return dimension.options.length > 1;
}

export function createBranchEventModel({ outcomes = [], actions = {}, defaultOutcomeId = null } = {}) {
  const definitions = new Map();
  const choicesByOutcome = new Map();
  for (const entry of outcomes) {
    const id = outcomeId(entry);
    if (!id) continue;
    choicesByOutcome.set(id, choicesForOutcome(entry, outcomes, actions, definitions));
  }
  const dimensions = [];
  for (const definition of definitions.values()) {
    const optionMap = new Map();
    for (const entry of outcomes) {
      const id = outcomeId(entry);
      const outcomeChoices = choicesByOutcome.get(id);
      const choice = outcomeChoices?.[definition.id] || { id: "not-reached", label: "Not reached" };
      if (outcomeChoices && !outcomeChoices[definition.id]) outcomeChoices[definition.id] = choice;
      const option = optionMap.get(choice.id) || { ...choice, outcomeIds: [], probability: 0, probabilityStatus: "known" };
      option.outcomeIds.push(id);
      const probability = outcomeProbability(entry);
      if (probability === null) option.probabilityStatus = "unknown";
      else option.probability += probability;
      optionMap.set(choice.id, option);
    }
    const options = [...optionMap.values()].sort((left, right) => {
      if (left.id === "not-reached") return 1;
      if (right.id === "not-reached") return -1;
      if (left.probabilityStatus === "known" && right.probabilityStatus === "known" && right.probability !== left.probability) return right.probability - left.probability;
      return left.label.localeCompare(right.label);
    });
    const dimension = { ...definition, options };
    if (dimensionIsSelectable(dimension)) dimensions.push(dimension);
  }
  const availableIds = outcomes.map(outcomeId).filter(Boolean);
  return {
    dimensions,
    choicesByOutcome,
    outcomeIds: availableIds,
    selectedOutcomeId: availableIds.includes(defaultOutcomeId) ? defaultOutcomeId : availableIds[0] || null
  };
}

export function selectBranchEventOutcome(model, currentOutcomeId, dimensionId, optionId, outcomes = []) {
  const dimension = model?.dimensions?.find(entry => entry.id === dimensionId);
  const option = dimension?.options?.find(entry => entry.id === optionId);
  if (!option?.outcomeIds?.length) return currentOutcomeId;
  const currentChoices = model.choicesByOutcome.get(currentOutcomeId) || {};
  const byId = new Map(outcomes.map(entry => [outcomeId(entry), entry]));
  const candidates = option.outcomeIds.map(id => ({
    id,
    matches: Object.entries(currentChoices).filter(([key, value]) => key !== dimensionId && model.choicesByOutcome.get(id)?.[key]?.id === value.id).length,
    probability: outcomeProbability(byId.get(id)) ?? -1
  }));
  candidates.sort((left, right) => right.matches - left.matches || right.probability - left.probability || left.id.localeCompare(right.id));
  return candidates[0]?.id || currentOutcomeId;
}

export function selectedBranchChoices(model, selectedOutcomeId) {
  return model?.choicesByOutcome?.get(selectedOutcomeId) || {};
}
