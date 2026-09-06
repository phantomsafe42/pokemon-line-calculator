import { toId } from "../core/primitives.js?v=20260905-drafts-freecalc-partners-v1";
import { SHOWDOWN_MOVE_REFERENCE_BY_GAME, SHOWDOWN_MOVE_REFERENCE_BY_GENERATION, SHOWDOWN_REFERENCE_SOURCE } from "./generated/showdown_move_reference.js?v=20260905-drafts-freecalc-partners-v1";

const STATUS_RULES = Object.freeze({
  brn: { immuneTypes: ["fire"], immuneAbilities: ["waterveil", "waterbubble"] },
  par: { immuneAbilities: ["limber"] },
  psn: { immuneTypes: ["poison", "steel"], immuneAbilities: ["immunity", "pastelveil"] },
  tox: { immuneTypes: ["poison", "steel"], immuneAbilities: ["immunity", "pastelveil"] },
  slp: { immuneAbilities: ["insomnia", "vitalspirit", "sweetveil"] },
  frz: { immuneTypes: ["ice"], immuneAbilities: ["magmaarmor"] }
});

const SPECIAL_HANDLERS = Object.freeze({
  protect: "protect",
  detect: "protect",
  endure: "endure",
  counter: "counter-damage",
  mirrorcoat: "mirror-coat-damage",
  metalburst: "metal-burst-damage",
  finalgambit: "final-gambit-damage",
  endeavor: "endeavor-damage",
  superfang: "half-current-hp-damage",
  clearsmog: "clear-target-stat-stages",
  thief: "steal-item",
  covet: "steal-item",
  knockoff: "remove-item",
  rapidspin: "clear-own-hazards",
  brickbreak: "break-target-screens",
  psychicfangs: "break-target-screens",
  wakeupslap: "wake-target",
  fakeout: "first-turn-only",
  dreameater: "requires-sleeping-target",
  suckerpunch: "requires-damaging-target-action",
  bide: "bide",
  destinybond: "destiny-bond",
  doomdesire: "delayed-attack",
  futuresight: "delayed-attack",
  falseswipe: "nonlethal-damage",
  focuspunch: "requires-undamaged-before-action",
  highjumpkick: "crash-on-failure",
  jumpkick: "crash-on-failure",
  explosion: "self-destruct",
  selfdestruct: "self-destruct",
  healingwish: "healing-wish",
  lunardance: "lunar-dance",
  memento: "self-destruct",
  wish: "wish",
  curse: "curse",
  attract: "attract",
  present: "present",
  magnitude: "magnitude",
  incinerate: "incinerate-berry",
  lastresort: "last-resort",
  skydrop: "sky-drop",
  firepledge: "pledge",
  grasspledge: "pledge",
  waterpledge: "pledge",
  spitup: "spit-up",
  dig: "two-turn-charge",
  fly: "two-turn-charge",
  dive: "two-turn-charge",
  bounce: "two-turn-charge",
  iceburn: "two-turn-charge",
  freezeshock: "two-turn-charge",
  skullbash: "two-turn-charge",
  skyattack: "two-turn-charge",
  shadowforce: "two-turn-charge",
  solarbeam: "two-turn-charge",
  mudsport: "sport-field",
  watersport: "sport-field",
  teleport: "no-op",
  haze: "clear-all-stat-stages",
  rest: "rest",
  soak: "set-water-type",
  block: "trap-target",
  meanlook: "trap-target",
  spiderweb: "trap-target",
  defog: "defog",
  splash: "no-op",
  lockon: "sure-hit",
  mindreader: "sure-hit",
  recycle: "recycle-item",
  refresh: "clear-self-status",
  psychup: "copy-stat-stages",
  healbell: "clear-party-status",
  aromatherapy: "clear-party-status",
  moonlight: "weather-heal",
  synthesis: "weather-heal",
  morningsun: "weather-heal",
  bellydrum: "belly-drum",
  guardswap: "swap-defensive-stages",
  powerswap: "swap-offensive-stages",
  heartswap: "swap-all-stages",
  healpulse: "target-heal",
  painsplit: "pain-split",
  skillswap: "swap-abilities",
  switcheroo: "swap-items",
  trick: "swap-items",
  worryseed: "set-insomnia",
  simplebeam: "set-simple",
  roleplay: "copy-ability",
  entrainment: "share-ability",
  acupressure: "random-stat-boost",
  allyswitch: "ally-switch",
  flameburst: "flame-burst",
  guardsplit: "split-defenses",
  powersplit: "split-offenses",
  perishsong: "perish-song",
  psychoshift: "psycho-shift",
  reflecttype: "copy-types",
  conversion: "conversion",
  conversion2: "conversion-2",
  camouflage: "camouflage",
  mimic: "copy-last-move",
  sketch: "copy-last-move",
  quash: "move-last",
  afteryou: "move-next",
  spite: "reduce-last-move-pp",
  assist: "call-party-move",
  copycat: "call-last-field-move",
  mefirst: "call-target-move",
  metronome: "call-random-move",
  mirrormove: "call-target-last-move",
  naturepower: "nature-power",
  sleeptalk: "sleep-talk",
  bestow: "give-item",
  swallow: "swallow",
  transform: "transform",
  flowershield: "flower-shield",
  rototiller: "rototiller",
  topsyturvy: "invert-stat-stages",
  floralhealing: "terrain-target-heal",
  gearup: "plus-minus-offense",
  purify: "purify",
  shoreup: "terrain-self-heal",
  speedswap: "swap-speed-stats",
  strengthsap: "strength-sap",
  magneticflux: "plus-minus-defense",
  trickortreat: "add-ghost-type",
  venomdrench: "venom-drench",
  forestscurse: "add-grass-type",
  instruct: "instruct",
  happyhour: "no-op",
  celebrate: "no-op",
  holdhands: "no-op",
  stuffcheeks: "stuff-cheeks",
  magicpowder: "set-psychic-type",
  teatime: "teatime",
  courtchange: "court-change",
  corrosivegas: "remove-item",
  junglehealing: "party-quarter-heal-status",
  lunarblessing: "party-quarter-heal-status",
  takeheart: "take-heart"
});

const AUTOMATIC_TARGET_MODES = new Set(["all", "alladjacent", "alladjacentfoes", "scripted"]);
const FIELD_TARGET_MODES = new Set(["allyside", "allyteam", "allies", "foeside"]);
const FIELD_SPECIAL_HANDLERS = new Set([
  "clear-all-stat-stages", "clear-party-status", "perish-song", "flower-shield", "rototiller",
  "plus-minus-offense", "plus-minus-defense", "teatime", "court-change", "party-quarter-heal-status"
]);

function targetMode(reference, move = null) {
  if (move && String(move.category).toLowerCase() !== "status") return toId(move.target || reference.target || "normal");
  return toId(reference.target || move?.target || "normal");
}

function targetFor(reference, fallback = "target") {
  return targetMode(reference) === "self" ? "self" : fallback;
}

function statusOperation(statusId, target = "target") {
  return {
    kind: "major-status",
    target,
    statusId,
    ...(STATUS_RULES[statusId] || {})
  };
}

function effectOperations(effect, reference, defaultTarget = "target") {
  if (!effect || typeof effect !== "object") return [];
  const operations = [];
  const target = targetFor(reference, defaultTarget);
  if (effect.status) operations.push(statusOperation(toId(effect.status), target));
  if (effect.boosts) operations.push({ kind: "stat-stages", target, statStages: { ...effect.boosts } });
  if (effect.volatileStatus) operations.push({ kind: "volatile-status", target, volatileStatusId: toId(effect.volatileStatus) });
  if (effect.self) operations.push(...effectOperations(effect.self, { target: "self" }, "self"));
  return operations;
}

function secondaryOperations(reference) {
  const entries = reference.secondaries || (reference.secondary ? [reference.secondary] : []);
  return entries.flatMap(entry => {
    const operations = effectOperations(entry, reference);
    if (!operations.length) return [];
    return [{ kind: "chance", chance: Number(entry.chance ?? 100), operations }];
  });
}

function primaryOperations(move, reference) {
  const operations = [];
  if (String(move.category).toLowerCase() !== "status") {
    operations.push({
      kind: "damage",
      ...(reference.drain ? { drain: [...reference.drain] } : {}),
      ...(move.recoil || reference.recoil ? { recoil: [...(move.recoil || reference.recoil)] } : {}),
      ...(move.multihit || reference.multihit ? { multihit: structuredClone(move.multihit || reference.multihit) } : {})
    });
  }
  if (reference.status) operations.push(statusOperation(toId(reference.status), targetFor(reference)));
  if (reference.boosts) operations.push({ kind: "stat-stages", target: targetFor(reference), statStages: { ...reference.boosts } });
  if (reference.heal) operations.push({ kind: "heal", target: targetFor(reference, "self"), fraction: [...reference.heal] });
  if (reference.weather) operations.push({ kind: "field-condition", fieldKind: "weather", fieldId: toId(reference.weather), durationTurns: 5 });
  if (reference.terrain) operations.push({ kind: "field-condition", fieldKind: "terrain", fieldId: toId(reference.terrain), durationTurns: 5 });
  if (reference.pseudoWeather) operations.push({ kind: "pseudo-weather", pseudoWeatherId: toId(reference.pseudoWeather) });
  if (reference.sideCondition) operations.push({
    kind: "side-condition",
    sideConditionId: toId(reference.sideCondition),
    targetSide: targetMode(reference) === "allyside" ? "own" : "opposing"
  });
  if (reference.slotCondition) operations.push({ kind: "slot-condition", slotConditionId: toId(reference.slotCondition) });
  if (reference.volatileStatus && !["mudsport", "watersport"].includes(toId(move.id || move.name))) operations.push({ kind: "volatile-status", target: targetFor(reference), volatileStatusId: toId(reference.volatileStatus) });
  if (reference.self) operations.push(...effectOperations(reference.self, { target: "self" }, "self"));
  operations.push(...secondaryOperations(reference));
  if (reference.selfSwitch) operations.push({ kind: "self-switch", switchMode: reference.selfSwitch === true ? "switch" : toId(reference.selfSwitch) });
  if (reference.forceSwitch) operations.push({ kind: "force-switch" });
  return operations;
}

export function vw2rMoveSupport(move, dataset = null) {
  if (!move) return { supported: false, reason: "Move data is unavailable" };
  const moveId = toId(move.id || move.name);
  const generation = Number(dataset?.mechanics?.damageGeneration || 5);
  const reference = SHOWDOWN_MOVE_REFERENCE_BY_GAME[dataset?.gameId]?.[moveId]
    || SHOWDOWN_MOVE_REFERENCE_BY_GENERATION[generation]?.[moveId];
  if (!reference) return { supported: false, reason: `${move.name || move.id} has no pinned Showdown move definition` };
  let operations = primaryOperations(move, reference);
  // VW2R repurposes Water Sport as a damaging move. Keep the displayed source
  // data intact and suppress only Showdown's legacy status-move callback here.
  const specialHandlerId = dataset?.gameId === "volt-white-2r" && moveId === "watersport" && String(move.category).toLowerCase() !== "status"
    ? null
    : SPECIAL_HANDLERS[moveId] || null;
  if (["curse", "attract", "sky-drop"].includes(specialHandlerId)) {
    operations = operations.filter(operation => operation.kind !== "volatile-status");
  }
  if (!operations.length && !specialHandlerId) {
    return {
      supported: false,
      reason: `${move.name || move.id} requires a dedicated structured resolver handler`,
      callbackPaths: reference.callbacks || []
    };
  }
  const mode = targetMode(reference, move);
  const fieldOnly = operations.length > 0 && operations.every(operation => ["field-condition", "pseudo-weather", "side-condition", "slot-condition"].includes(operation.kind));
  return {
    supported: true,
    effectId: "structured-move",
    moveId,
    target: mode === "self"
      ? "self"
      : fieldOnly || FIELD_TARGET_MODES.has(mode) || FIELD_SPECIAL_HANDLERS.has(specialHandlerId)
        ? "field"
        : AUTOMATIC_TARGET_MODES.has(mode)
          ? "automatic"
          : "target",
    targetMode: mode,
    operations,
    specialHandlerId,
    critRatio: Number(reference.critRatio || 1),
    ...(reference.willCrit !== undefined || move.willCrit !== undefined
      ? { willCrit: reference.willCrit === true || move.willCrit === true }
      : {}),
    flags: { ...(reference.flags || {}) },
    breaksProtect: reference.breaksProtect === true,
    callbackPaths: reference.callbacks || []
  };
}

export function vw2rReferenceMoveIds(dataset = null) {
  const generation = Number(dataset?.mechanics?.damageGeneration || 5);
  return Object.keys(SHOWDOWN_MOVE_REFERENCE_BY_GAME[dataset?.gameId] || SHOWDOWN_MOVE_REFERENCE_BY_GENERATION[generation] || {});
}

export function hasShowdownMoveReference(dataset = null) {
  const generation = Number(dataset?.mechanics?.damageGeneration);
  return Number.isInteger(generation)
    && Array.isArray(SHOWDOWN_REFERENCE_SOURCE.games)
    && SHOWDOWN_REFERENCE_SOURCE.games.includes(dataset?.gameId)
    && Boolean(SHOWDOWN_MOVE_REFERENCE_BY_GAME[dataset?.gameId]);
}
