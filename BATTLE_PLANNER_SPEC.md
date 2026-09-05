# Pokemon Line Calculator (PLC) Technical Specification

Status: Schema-v2 Singles/Doubles build accepted  
Date: August 24, 2026  
Component: Pokemon Line Calculator (`PLC`)  
Owner: `Web Tools/Pokemon Line Calculator/`  
Current proving game: Pokémon Volt White 2 Redux Egglocke (`volt-white-2r`)

## 1. Purpose

This document defines the game selection, Boxes storage, ingest, calculation, branching, caching, portable plan-file, local live-edit, node-tree, and Overlay projection contracts for the Pokemon Line Calculator (PLC), a shared Pokémon battle-planning Web Tool.

The planner is a planning and education tool. The accepted product models proposed Singles, Doubles, and Generation 5 Triple battles turn by turn. The current working extension adds Generation 5 Rotation planning, generated Trainer AI education, and a private read-only observed-turn comparison lane. PLC previews all materially different outcomes before a turn is committed, retains alternate strategic and probabilistic branches, and lets the user explicitly choose which saved turn instances the Overlay should display on stream. Triple and Rotation presentation in Overlay is not yet implemented or accepted.

VW2R is the first proving game. The core planner must remain game-neutral. Other games opt in through standardized dataset, mechanics, trainer, and save-ingest contracts rather than game-specific UI forks.

PLC owns its calculator-specific application, resolver, schemas, tests, active-draft cache, plan-file creation and re-ingest, editable node tree, and optional local live-writer client. Overlay owns saved-plan ingest, its read-only display-selection tree, the display-projection producer, the branch-window renderer, and final OBS presentation. Other components may own narrow integration adapters required by their established responsibilities, but must not duplicate PLC logic.

The schema-v2 Singles/Doubles planner, game-first Boxes workflow, calculator redesign, and private Live Edit integration are accepted history. Existing Dataset and Save Tracker authority boundaries are unchanged.

## 2. Accepted product decisions

The following decisions are settled for the first implementation:

- The planner UI and core resolver support Singles, Doubles, schema-v3 Generation 5 Triple, and schema-v4 Generation 5 Rotation battles. Overlay projection supports Singles and Doubles; Triple and Rotation Overlay projection still fail closed.
- Doubles requires one action per live active slot, explicit single-target selection, distinct switch/replacement destinations, spread targeting from canonical move data, and the shared calculator's Doubles format modifier.
- The planner is a browser-compatible static application. Local Stream Tools use is served by the existing custom server; the published build runs without that server.
- Core calculation and branching run in browser-compatible code. Expensive resolution work runs in a Web Worker.
- The first user decision is the game. Changing games resets the active PLC context after the ordinary destructive-transition guard, and only Boxes belonging to the selected game are shown.
- A game-scoped Boxes library stores canonical editable Pokémon records. Named Parties contain at most six record IDs; one record may appear in several Parties, and an edit is therefore visible through every Party reference in that Box.
- The local build accepts a user-selected save as a read-only pre-battle snapshot when that game has an explicit save adapter. Showdown and portable Boxes JSON provide portable/manual input. No mode continuously rereads or writes a save during a planned battle.
- Combatants begin at 100% HP, with no status, zero stat stages, full PP, their original ability active, and their original item held unless the user declares a pre-battle override.
- Manual initial overrides are allowed for pre-existing damage, major status, map weather/terrain, and other unusual starting conditions. Normal mid-battle changes must come from resolved actions and events.
- The VW2R effect library covers every standardized VW2R move ID in Singles and Doubles, and every move can enter the Triple or Rotation resolver from a legal participating position. Coverage includes priority and speed order, multi-active order control and redirection, direct and conditional damage, multi-hit and random-power distributions, stat changes, healing, recoil, major and volatile status, weather/terrain/room changes, delayed attacks/heals, switching and Baton Pass, Protect/Quick Guard/Wide Guard prevention, supported residual effects, item/ability changes required by moves, fainting, and action cancellation.
- VW2R save snapshots retain total EXP. Raw move, ability, item, and nature identifiers resolve through the standardized save-ID contract rather than battle-data `num` coercion; an unmapped held-item value `0` means no held item. A raw species ID first resolves to the unique base standardized record sharing that number, because alternate forms reuse the species number and are encoded in a separate packed form field. Non-base save-form resolution remains disabled until Dataset publishes an explicit packed-form identity map. The standardized species contract supplies `baseExp`, which PLC normalizes to the portable plan's `baseExperienceYield` field. The VW2R-only EXP adapter projects Gen 5 trainer-battle payouts for player Pokémon, including per-enemy participation through switches, Exp. Share and Lucky Egg, level-up state, and one-time faint rewards. Missing yield data disables only EXP projection and is never repaired inside PLC.
- Battle-item actions are represented by the shared schema but disabled for VW2R initially.
- The resolver generates every materially different candidate outcome internally. The UI condenses those candidates into branch-event controls and commits only the crafted outcome the user selected.
- HP remains a range until the range crosses a future-relevant threshold. Equivalent future states are merged.
- The calculator defaults its working cursor to the most likely branch. This default never publishes anything to the Overlay.
- A durable plan file exists only after an explicit Output Plan File or successful Save and Quit action.
- The calculator caches only one active working draft. The cache is recoverable working state, not a saved-file authority.
- Changing game, trainer, exact trainer variant, source roster, or imported plan is destructive to the active draft and requires confirmation when planning work exists.
- A plan file can be re-ingested by PLC and independently ingested by Overlay. Neither import publishes anything to the stream.
- PLC selects which plan nodes and required ancestry are exported. Overlay separately selects which imported turn instances are displayed.
- The Overlay displays no battle plan by default. Importing a file or detecting a live revision only updates its selectable node tree; Select Displayed followed by Send Turns remains required.
- The Overlay receives a compact rendering-ready projection, not the editable plan document or raw branch graph.
- PLC never communicates with OBS directly.
- Local PLC may offer Begin Live Edit when the trusted loopback capability is available. The published PLC build does not include or expose live editing.
- A local live-edit session uses the ordinary versioned plan format in an ephemeral server-managed file. PLC writes revisions; Overlay monitors them through the loopback broker.
- New or changed live-plan nodes never update the stream automatically.

## 3. Authority and component boundaries

### 3.1 Dataset authority

Static game facts come from a validation-passed standardized dataset:

- Species/form identities and base mechanics: `species.json`.
- Moves and structured move mechanics: `moves.json`.
- Abilities and items: `abilities.json` and `items.json`.
- Natures, types, and stat identities: `natures.json`, `types.json`, and `stats.json`.
- Trainer occurrences, variants, teams, and battle profiles: `trainers.json`.
- Calculator readiness, engine, generations, ruleset, and verified defaults: `battle_mechanics.json`.
- Game rules such as set mode or disabled EV gain: manifest-declared rules such as `game_rules.json`.

Planner code must not repair dataset facts, infer mechanics from display strings, parse move-description prose as executable rules, or borrow defaults from another game. VW2R move-resolution semantics are supplied by a separate versioned ruleset adapter generated from pinned Showdown definitions plus explicit VW2R calculation-only overrides. That adapter never rewrites the standardized source or changes the data shown to users. Missing or unresolved mechanics fail closed.

### 3.2 Save and Save Tracker authority

Save Tracker remains the owner of continuous operational save monitoring and generated current player team/collection output. PLC may additionally parse a file that the user explicitly selects through a game-specific, read-only import adapter. That import creates a new Box snapshot and never becomes a live watcher or a Save Tracker replacement.

The current VW2R collection provides these relevant fields:

- `pid`, `uniqueKey`, `species`, `speciesId`, `nickname`, and `displayName`.
- `level`, `ability`, `item`, `nature`, and `gender`.
- Six IV values and the current moveset.
- `storage`, `box`, and `slot` provenance.

Current VW2R collection records do not provide current battle HP, major status, stat stages, transient field state, or player EV fields. VW2R may use zero player EVs only because its validated mechanics contract declares player EV gain disabled. A future game must publish reliable EVs or require a visible runtime input.

The planner never writes a save, current team/collection JSON, `current_game.json`, snapshots, events, or run history. Save import must preserve the selected file byte-for-byte and must fail closed for an unsupported game, size, or structure.

### 3.3 Overlay and Launcher authority

Overlay owns the branch-plan stream window. It decides how projection columns and turn cells are rendered, positioned, animated, hidden, restored, and presented through its stable OBS routing. PLC does not create, control, or communicate with an OBS Browser Source.

In ordinary portable mode, the saved plan file is the only PLC-to-Overlay integration boundary. PLC downloads it; the user explicitly imports it through the Overlay dock. PLC has no live connection to Overlay.

In optional local live-edit mode, the existing custom Node server owns one ephemeral live-plan file plus writer/reader leases. PLC submits complete validated plan revisions to the server; Overlay monitors revisions through the server rather than attempting to watch an arbitrary filesystem path. This live session remains separate from `/__stream-tools/overlay-state/:gameId` and is absent from the published PLC build.

After either ordinary import or live attachment, the Overlay dock owns display selection. Send Turns writes a dedicated, bounded projection to ignored operational state for the Overlay branch-window renderer. This avoids enlarging the existing high-frequency battle-overlay state response and keeps plan content isolated from trainer, Focus, roster, layout, and DS-screen state.

### 3.4 Existing calculator authority

`Battle Mechanics/` owns the shared damage adapter and pinned `smogon-calc` engine as the damage-formula authority. The turn resolver wraps that adapter with progressive state, action order, structured move effects, probability branching, and event application. It requests exact normal and critical calculations separately; critical-hit probability and multi-hit critical-count branching remain PLC responsibilities. VW2R's move-effect contract is generated from pinned `pokemon-showdown@0.11.11`, applying Showdown's Gen 8 through Gen 5 historical override layers in order before explicit VW2R calculation-only exceptions. Showdown is a semantic reference, not a runtime dependency or a replacement damage engine. The resolver does not depend on the standalone PKCalc fork.

For a variable 2–5-hit move, a calculator preview follows the Showdown/HZLA convention of three hits unless Skill Link or Grip Claw guarantees the maximum. Turn resolution does not treat that preview default as a deterministic battle result: it branches over the Gen 5 hit-count distribution and requests the matching explicit hit total from the shared calculator. Fixed-hit moves always use their declared count.

### 3.5 Planned integration summary

| Component | Direction | Required PLC integration | Explicit boundary |
|---|---|---|---|
| Standardized Datasets | Dataset → PLC | Game manifest, species/forms, moves, abilities, items, natures, types, trainers, battle profile, rules, and validation-passed mechanics contract | PLC never edits dataset facts or generated consumers |
| User-selected save / Save Tracker | File or optional local snapshot → PLC adapter | Read-only game-specific Box import or normalized pre-battle snapshot | PLC never writes the save or generated state and never continuously ingests battle state |
| Battle Mechanics | Shared adapter → PLC resolver and Overlay Focus | Exact normal/critical damage ranges under the declared mechanics contract | Consumers wrap the shared calculator; they do not copy its formula, game facts, or use PKCalc |
| Stream Tools static server | Local PLC and Overlay ↔ loopback broker | Serve the local app; manage the optional ephemeral live-plan file and leases; store the Overlay's last explicitly sent display projection | Live sessions are local-only ignored state; ordinary files and PLC IndexedDB drafts remain outside the server |
| Overlay | Plan file or live revision → Overlay | Validate an imported plan, present a read-only node tree, produce the explicit display projection, and render it as an Overlay window | Overlay never edits or recalculates the plan; it owns display selection, window behavior, stable routing, and OBS presentation |

PLC has no planned integration with beldumsafe, Stream Deck, Run History Publisher or Sites, Discord Scheduler, save editors, Champions Move Finder, or PKCalc. A future live battle log may become an optional observed-state adapter, but is outside the first build.

## 4. Runtime architecture

```text
Standardized dataset ───────┐
Selected save / Showdown ───┼─ Game-scoped Boxes library ── Party snapshot ── PLC normalized plan document
Standardized trainers ──────┤                                                   │
Imported plan file ─────────┘                                                   ├─ IndexedDB active draft
                                                         │
                                                         ├─ Resolver Web Worker
                                                         │    ├─ action validation
                                                         │    ├─ damage adapter
                                                         │    ├─ effects/events
                                                         │    └─ branch generation
                                                         │
                                                         ├─ Ordinary selected-plan download
                                                         │           │
                                                         │           └──────────────┐
                                                         │                          │
                                                         └─ Local live writer        │
                                                              └─ managed live file   │
                                                                         │           │
                                                                         ▼           ▼
                                                                    Overlay plan ingest
                                                                         │
                                                                    Read-only node tree
                                                                         │
                                                                    Explicit Send Turns
                                                                         │
                                                                    Loopback projection
                                                                         │
                                                                    Overlay branch window
                                                                         │
                                                                    OBS Browser Source
```

The core resolver and ordinary file workflow must not depend on DOM elements, OBS, Windows paths, active-game filenames, Save Tracker, the Stream Tools server, or a specific game folder. The local build loads separate Save Tracker and capability-gated live-edit adapters. The published build omits those adapters and uses the same core and plan schema.

## 5. Terminology and graph model

The internal plan alternates between three concepts:

1. A state node describes battle state after zero or more resolved turns.
2. An action group describes the complete set of strategic actions proposed from a state node.
3. Outcome state nodes describe the materially distinct results of resolving that action group.

```text
State Node
├─ Action Group A: player move, enemy move
│  ├─ Outcome State: enemy faints
│  └─ Outcome State: enemy survives
└─ Action Group B: player switches, enemy move
   ├─ Outcome State: switch-in survives
   └─ Outcome State: switch-in faints
```

`turnNumber` remains the human-facing order and display label. It is not a unique storage key once branches exist. `stateNodeId` and `actionGroupId` provide stable identity.

The root state node represents the declared pre-battle state before Turn 1. A Turn N outcome node represents the state after Turn N has resolved, including its end-of-turn effects.

## 6. Shared primitives

### 6.1 Stable IDs

All entity references use stable standardized IDs. Display names are snapshots for presentation only.

Player combatant identity prefers:

1. A stable Save Tracker `uniqueKey`.
2. `pid` when present.
3. A documented adapter-generated key when the parser lacks a stable instance identity.

Enemy combatant identity uses game, trainer occurrence, exact trainer variant when required, and trainer team slot. Manual/custom combatants use a generated document-scoped ID.

Example keys:

```text
player:unique:abc123
player:pid:305419896
enemy:trainer:43:variant:final-rom-trainer-360:slot:1
custom:7f00d50a
```

### 6.2 Stat tables

All planner-facing stat tables use the canonical keys below, regardless of parser-specific abbreviations:

```json
{
  "hp": 31,
  "atk": 31,
  "def": 31,
  "spa": 31,
  "spd": 31,
  "spe": 31
}
```

Ingest adapters are responsible for mapping formats such as VW2R's `at`, `df`, `sa`, `sd`, and `sp` fields.

### 6.3 Ranges

Uncertain numeric state uses inclusive ranges:

```json
{
  "min": 31,
  "max": 44
}
```

An exact value has equal minimum and maximum. Percentages are derived from HP values and max HP rather than stored as the only state.

## 7. Battle plan document

The exported and re-ingestable file uses one versioned root document:

```json
{
  "kind": "pokemon-battle-plan",
  "schemaVersion": 2,
  "planId": "plan-vw2r-example",
  "name": "VW2R Example Plan",
  "createdAt": "2026-08-23T00:00:00.000Z",
  "updatedAt": "2026-08-23T00:00:00.000Z",
  "documentRevision": 12,

  "game": {
    "gameId": "volt-white-2r",
    "battleFormat": "doubles",
    "trainerId": "example",
    "trainerVariantId": null
  },

  "mechanicsFingerprint": {
    "engineId": "smogon-calc",
    "engineVersion": "0.11.0",
    "damageGeneration": 5,
    "canonicalDataGeneration": 9,
    "mechanicsProfile": "vw2r-complete-pchal-egglocke-challenge-v1",
    "datasetManifestHash": "sha256-placeholder",
    "battleMechanicsHash": "sha256-placeholder"
  },

  "sourceSnapshot": {
    "playerCollectionUpdatedAt": "2026-08-23T00:00:00.000Z",
    "playerRosterHash": "sha256-placeholder",
    "trainerSnapshotHash": "sha256-placeholder"
  },

  "combatants": {},
  "initialStateNodeId": "state-root",
  "stateNodes": {},
  "actionGroups": {},
  "workingDraft": null
}
```

The example trainer ID and hashes above are placeholders, not VW2R dataset facts.

Schema version 2 stores per-side active-key and action arrays for one or two slots. Schema-v1 Singles files remain accepted and are migrated in memory to schema version 2 when opened; output uses schema version 2.

The plan file does not contain a machine-specific save path, live overlay-state record, Overlay display selection, credentials, or an implicit instruction to publish.

## 8. Combatant registry

Each Pokémon that may enter the planned battle has one normalized registry record:

```json
{
  "combatantKey": "player:unique:abc123",
  "side": "player",

  "source": {
    "kind": "save-tracker",
    "pid": 305419896,
    "uniqueKey": "abc123",
    "trainerId": null,
    "trainerVariantId": null,
    "trainerSlot": null
  },

  "speciesId": "samurott",
  "formId": null,
  "displayName": "Samurott",
  "nickname": "Example",
  "level": 28,
  "gender": "M",
  "natureId": "adamant",

  "ivs": {
    "hp": 31,
    "atk": 20,
    "def": 18,
    "spa": 4,
    "spd": 21,
    "spe": 15
  },

  "evs": {
    "hp": 0,
    "atk": 0,
    "def": 0,
    "spa": 0,
    "spd": 0,
    "spe": 0
  },

  "originalAbilityId": "torrent",
  "originalItemId": "mysticwater",
  "originalTypeIds": ["water"],
  "growthRate": "Medium Slow",
  "experience": 10609,
  "baseExperienceYield": null,

  "moves": [
    {
      "moveId": "razorshell",
      "maxPp": 10
    }
  ]
}
```

Base stats, weight, NFE status, move power, type chart, ability behavior, and item behavior remain dataset references. A plan snapshot may retain the resolved display name and original type list for historical readability, but it cannot override the referenced mechanics.

Held item and ability require both original registry values and mutable battle-state values because they can be consumed, removed, changed, or suppressed during a battle.

## 9. Mutable battle state

### 9.1 Combatant state

```json
{
  "combatantKey": "player:unique:abc123",
  "currentLevel": 24,
  "experience": 10609,
  "hp": {
    "min": 91,
    "max": 91,
    "maxHp": 91
  },
  "majorStatus": null,

  "statStages": {
    "atk": 0,
    "def": 0,
    "spa": 0,
    "spd": 0,
    "spe": 0,
    "accuracy": 0,
    "evasion": 0
  },

  "currentAbilityId": "torrent",
  "abilitySuppressed": false,

  "currentItemId": "mysticwater",
  "itemState": "held",

  "currentTypeIds": ["water"],

  "movePp": {
    "razorshell": 10
  },

  "volatileConditions": {
    "confusionTurns": null,
    "confusionCounterDistribution": null,
    "sleepCounterDistribution": null,
    "sleepCounterStartDistribution": null,
    "leechSeeded": false,
    "substituteHp": 0,
    "tauntTurns": 0,
    "encoredMoveId": null,
    "disabledMoveId": null,
    "choiceLockedMoveId": null,
    "rechargeRequired": false,
    "protectStreak": 0
  },

  "turnFlags": {
    "hasMoved": false,
    "wasDamaged": false,
    "damageTaken": 0,
    "damagingHitsTaken": 0,
    "lastDamageSourceKey": null,
    "lastDamageCategory": null,
    "flinched": false
  }
}
```

`itemState` begins as `held` and may become `consumed`, `knocked-off`, `flung`, or another structured supported state. Major status, volatile conditions, and per-turn flags use normalized IDs defined by the resolver contract.

Player combatants imported from a supported save retain total EXP and the species growth rate in the immutable combatant snapshot. `currentLevel` and optional recalculated `currentStats` are mutable battle state so a payout can affect later actions without changing the pre-battle snapshot. Manual/Showdown records may omit total EXP; payout amounts can still be projected, but a level-up cannot be inferred without a known starting total.

### 9.2 EXP participation state

EXP participation is portable, game-neutral bookkeeping keyed by enemy combatant. Each active player begins as a participant against each initially active enemy. A player switch-in joins the participant set for every currently active enemy; an enemy switch-in begins or resumes its own participant set with the currently active players. Benching does not erase participation, and each enemy key may be rewarded only once.

VW2R is the first payout adapter. It uses the Gen 5 scaled trainer-battle formula, divides the ordinary and Exp. Share halves before recipient multipliers, applies Lucky Egg per recipient, excludes fainted recipients while preserving their stored state, and emits one `experience-gain` event per rewarded player Pokémon. A participating Exp. Share holder receives both shares. The adapter is player-only and explicitly does not infer the traded-Pokémon bonus because the current save snapshot does not retain original-trainer identity.

### 9.3 Field state

Field state is divided into global and per-side scopes:

```json
{
  "global": {
    "weather": {
      "id": null,
      "source": null,
      "durationMode": null,
      "remainingTurns": null
    },
    "terrain": {
      "id": null,
      "source": null,
      "durationMode": null,
      "remainingTurns": null
    },
    "trickRoomTurns": 0,
    "gravityTurns": 0,
    "magicRoomTurns": 0,
    "wonderRoomTurns": 0
  },

  "sides": {
    "player": {
      "reflectTurns": 0,
      "lightScreenTurns": 0,
      "auroraVeilTurns": 0,
      "tailwindTurns": 0,
      "safeguardTurns": 0,
      "mistTurns": 0,
      "hazards": {}
    },
    "enemy": {
      "reflectTurns": 0,
      "lightScreenTurns": 0,
      "auroraVeilTurns": 0,
      "tailwindTurns": 0,
      "safeguardTurns": 0,
      "mistTurns": 0,
      "hazards": {}
    }
  }
}
```

Map weather or terrain uses `source: "map"` and may use `durationMode: "permanent"`. Move-, item-, or ability-created conditions use their mechanics-defined duration.

The active dataset declares which global and side conditions are legal. Cross-generation fields may exist in the shared schema while remaining disabled for a particular game.

### 9.4 State node

```json
{
  "stateNodeId": "state-turn-2-survive",
  "parentActionGroupId": "actions-turn-2-main",
  "turnNumber": 2,
  "createdOrder": 7,

  "outcome": {
    "kind": "chance",
    "label": "Enemy survives",
    "probability": 0.8125,
    "probabilityStatus": "known",
    "conditions": [
      {
        "kind": "damage-threshold",
        "expression": "damage < target current HP"
      }
    ]
  },

  "active": {
    "playerCombatantKeys": ["player:unique:abc123", "player:unique:def456"],
    "enemyCombatantKeys": ["enemy:trainer:example:slot:1", "enemy:trainer:example:slot:2"],
    "playerCombatantKey": "player:unique:abc123",
    "enemyCombatantKey": "enemy:trainer:example:slot:1"
  },

  "combatantStates": {},
  "fieldState": {},
  "resolutionEventIds": [],
  "childActionGroupIds": [],
  "pendingReplacementSlots": [],
  "battleEnded": false,

  "stateHash": "sha256-placeholder",
  "status": "resolved"
}
```

State status is one of:

- `resolved`: valid under the current mechanics fingerprint.
- `preview`: derived but not committed.
- `stale`: an ancestor or mechanics dependency changed.
- `invalid`: the saved action sequence cannot be replayed.
- `incomplete`: required input is missing.

Implementations may store structural deltas plus a state hash instead of duplicating every full state, provided imported files can deterministically reconstruct and validate each node.

## 10. Per-turn actions

### 10.1 User-selectable action types

| Action | Selectable | Consumes a turn | Initial VW2R status |
|---|---:|---:|---|
| Move | Yes | Yes | Enabled |
| Switch | Yes | Yes | Enabled |
| Use Item | Ruleset-controlled | Yes | Represented but disabled |
| Unspecified | Draft-only | No resolution | Enabled as an incomplete placeholder |
| Forced Replacement | Between turns | No | Enabled when required |

Run, capture, and forfeit are outside the first trainer-battle scope.

Move modifiers such as Mega Evolution, Z-Moves, Dynamax, Terastallization, or a ROM-hack-specific once-per-battle mechanic are not separate action types. Future rulesets may expose them through a `mechanicActivations` array on a move or switch action.

### 10.2 Move action

```json
{
  "actionType": "move",
  "actorKey": "player:unique:abc123",
  "moveId": "revenge",
  "targetKeys": ["enemy:trainer:example:slot:1"],
  "mechanicActivations": [],
  "declaredAtStateHash": "sha256-placeholder"
}
```

Conditions such as Revenge's enhanced power, moving second, or being damaged earlier in the turn are derived from resolved events. They are not manual move-action toggles.

### 10.3 Voluntary switch action

```json
{
  "actionType": "switch",
  "actorKey": "player:unique:abc123",
  "switchToKey": "player:unique:def456",
  "switchKind": "voluntary",
  "declaredAtStateHash": "sha256-placeholder"
}
```

The resolver applies switch order, relevant opposing moves, outgoing volatile/stat-stage resets, entry hazards, switch-in abilities/items, and active-combatant replacement.

### 10.4 Forced replacement

```json
{
  "actionType": "replacement",
  "side": "player",
  "slot": 1,
  "switchToKey": "player:unique:def456",
  "reason": "previous-active-fainted",
  "consumesTurn": false
}
```

A forced replacement is a transition between state nodes and does not become a voluntary switch on the next numbered turn.

### 10.5 Resolver-generated actions and outcomes

The user does not manually select the following as action types:

- Miss, critical hit, flinch, full paralysis, sleep continuation/wake, or confusion self-hit.
- Recharge, Truant-style inability, move failure, or actor fainted before moving.
- Forced move from Choice lock, Encore, no PP, or Struggle.
- Chance-based secondary effects.

They are resolver-generated branch events. Accuracy, critical, damage-threshold, and chance-status controls appear with the selected move; sleep/confusion action checks appear when the affected Pokémon reaches its action.

## 11. Action readiness and turn preview

The resolver calculates required slots from the selected starting state. Singles requires one action per side; Doubles requires one action for each of two live slots per side:

```json
{
  "requiredSides": ["player", "enemy"],
  "requiredSlots": [
    { "side": "player", "slot": 0 },
    { "side": "player", "slot": 1 },
    { "side": "enemy", "slot": 0 },
    { "side": "enemy", "slot": 1 }
  ]
}
```

A side is removed from `requiredSides` when its action is already determined by the current state or a non-turn forced replacement is pending.

The Next Turn or New Branch control remains disabled until:

- Every required side has a legal Move or Switch action.
- Any required observed trainer nature/IV input is complete.
- Exact trainer variant selection is present when the trainer occurrence is combined.
- No forced replacement or other blocking transition remains unresolved.
- The selected action can be evaluated under the active mechanics contract.

`Unspecified` preserves an incomplete draft but does not satisfy readiness.

Once required actions are ready, the calculator resolves them into an uncommitted preview:

```json
{
  "baseStateNodeId": "state-turn-2-survive",
  "proposedTurnNumber": 3,
  "actions": {
    "player": [{ "actionType": "move", "moveId": "revenge" }],
    "enemy": [{ "actionType": "move", "moveId": "crunch" }]
  },
  "actionSignature": "sha256-placeholder",
  "previewRevision": 4,
  "previewStatus": "ready",
  "outcomes": [],
  "defaultPreviewOutcomeId": null
}
```

The Worker resolves every materially distinct candidate, but the page renders one crafted outcome instead of an unbounded outcome list. Branch-event buttons default to the most likely compatible candidate and let the user select hit/miss, normal/critical, status application, KO/survival, sleep/confusion checks, and other exposed splits. Changing either action invalidates and recomputes the preview. Stale Web Worker results must be discarded by preview revision.

Random sleep/confusion duration is hidden state, not an application-time branch. Application records only whether the status occurred and stores the duration as a probability distribution. Wake/snap-out, self-hit, and act-through checks branch only when the affected Pokémon reaches a later action; if the status is applied before that Pokémon acts, its first eligible check occurs in the same turn.

## 12. Progressive resolution sequence

For each action group, the resolver performs these stages:

1. Clone or reconstruct the parent state node.
2. Reset per-turn flags and validate active combatants.
3. Validate selected actions, targets, move PP, switch targets, ruleset restrictions, and mechanics support.
4. Derive effective action priority, priority modifiers, effective speed, Trick Room behavior, and any required speed-tie branch.
5. Resolve the first action.
6. Apply its PP use, damage, healing, recoil, stat changes, status, item/ability changes, switching, or field changes as ordered events.
7. Re-evaluate whether the next ordered actor can act and which conditional move mechanics now apply.
8. Resolve every remaining action against the progressively mutated state.
9. Resolve fainting and required replacement boundaries.
10. Apply deterministic end-of-turn effects in game-defined order.
11. Decrement turn-limited effects.
12. Generate materially distinct outcome states, probabilities, ranges, event summaries, and state hashes.

A Pokémon that faints before its action receives an event such as:

```json
{
  "eventType": "action-skipped",
  "actorKey": "enemy:trainer:example:slot:1",
  "reason": "actor-fainted-before-moving"
}
```

The engine must not record this as zero damage because no move occurred.

## 13. Resolution events

Events make progressive rules auditable and prepare the schema for a future live battle log.

```json
{
  "eventId": "event-turn-3-step-2",
  "source": "planned",
  "turnNumber": 3,
  "step": 2,
  "eventType": "damage",
  "actorKey": "enemy:trainer:example:slot:1",
  "targetKey": "player:unique:abc123",
  "moveId": "crunch",
  "damageHp": {
    "min": 18,
    "max": 22
  },
  "damagePercent": {
    "min": 19.8,
    "max": 24.2
  },
  "changes": [],
  "metadata": {}
}
```

Future observed events may use `source: "observed"` without changing planned-event consumers. A later live battle-log project may match observed events to a saved branch, but no live battle ingestion is required for the first planner.

## 14. Automatic branching

### 14.1 Branch categories

Branch edges use one of these categories:

- `chance`: accuracy, critical hits, damage rolls, multi-hit counts, secondary effects, or speed ties with known or derivable probability.
- `conditional`: a ranged result crosses a mechanically meaningful threshold.
- `decision`: a user-authored alternate Move or Switch action group. Decision branches have no probability unless a future AI model provides one.

### 14.2 Material branch rule

The resolver creates separate outcomes only when they change future-relevant state. Examples include:

- KO versus survival.
- HP crossing an ability, item, move-power, or residual-damage threshold.
- Hit versus miss.
- Relevant critical versus non-critical result.
- Secondary effect applied versus not applied.
- Different multi-hit totals producing a meaningful state distinction.
- Different speed-tie winners.

Individual damage rolls that produce equivalent future state remain one HP range. The resolver must not silently discard possible states to enforce an arbitrary branch cap. It may collapse or summarize equivalent branches.

### 14.3 Probability

Each chance outcome stores:

- `probability`: a number from 0 through 1 when known.
- `probabilityStatus`: `known`, `tied`, `partial`, or `unknown`.
- Structured factors used to calculate the probability.

Sibling chance outcomes marked as complete probability coverage must sum to 1 within a defined numeric tolerance. A crafted action group intentionally stores only user-selected candidates, so each saved node retains its absolute resolver probability without implying that the saved subset sums to 1.

The calculator's working default is the highest-probability outcome. For a complete future path, the most likely path maximizes cumulative probability through automatic chance edges. User decision edges do not receive invented probability.

If probability is tied or unknown, the UI must say so. A stable internal order may select the working cursor, but it may not label that selection more likely.

Manual branch selection remains selected until the user changes it or requests the most likely branch again.

### 14.4 Range splitting

HP remains a range until a threshold matters:

```text
HP 31–44
├─ HP 31–36: ability or berry activates
└─ HP 37–44: ability or berry does not activate
```

The same rule applies to any ranged value that changes legal actions or mechanics. After differences no longer matter, equivalent future states may be merged while retaining combined probability and provenance.

## 15. Next Turn and New Branch behavior

The node-tree cursor identifies a parent state node.

### 15.1 Next Turn

The control reads Next Turn when the selected state has no committed action group for the currently proposed actions.

Clicking Next Turn:

1. Commits the complete player/enemy action group.
2. Commits only the currently crafted resolver outcome as an outcome state node.
3. Marks that outcome as the action group's default.
4. Advances the working cursor to the committed outcome.

### 15.2 New Branch

The control reads New Branch when the selected state already has one or more committed action groups and the proposed action signature is new.

Selecting an earlier state node pre-fills an existing following action set when available. The user may change any slot action or target. Committing the new action group does not alter the old group, its outcomes, or any descendants.

If the proposed action signature exactly matches an existing child action group, the calculator re-resolves the candidate set. Selecting an already saved crafted outcome opens that node; selecting an unsaved crafted outcome adds only that sibling to the existing action group rather than creating a duplicate action group.

### 15.3 Descendant preservation

Adding a sibling decision branch never invalidates existing siblings. A direct mechanics migration or explicit destructive edit may cause descendants to become stale, but they remain preserved until the user explicitly removes them.

When replay is required, only descendants of the changed node are evaluated. Impossible actions are marked invalid with a reason such as fainted actor, unavailable switch target, consumed item, exhausted PP, or missing mechanics.

## 16. Active draft cache

The calculator stores exactly one active draft in IndexedDB:

```json
{
  "cacheSchemaVersion": 1,
  "draftRevision": 27,
  "lastExportedRevision": 22,
  "lastLiveFlushedRevision": null,
  "dirty": true,

  "sourceFingerprint": {
    "gameId": "volt-white-2r",
    "trainerId": "example",
    "trainerVariantId": null,
    "playerCollectionUpdatedAt": "2026-08-23T00:00:00.000Z",
    "playerRosterHash": "sha256-placeholder",
    "mechanicsHash": "sha256-placeholder"
  },

  "document": {},
  "workingCursorStateNodeId": "state-turn-2-survive",
  "exportSelectionDraft": null,
  "localLiveEdit": null
}
```

The active draft is updated after every meaningful planning action. It protects against refresh or crash but is not a saved plan.

`lastExportedRevision === draftRevision` means the user's latest explicitly downloaded file matches the active draft. The calculator does not assume continued write access to a previously downloaded file.

When local live editing is active, `lastLiveFlushedRevision` records the latest revision acknowledged by the loopback server. A live flush is not a durable user save and does not update `lastExportedRevision`.

The implementation may request persistent browser storage, but exported files remain the only durable user-controlled plan authority. The local server's ephemeral live file is recoverable session state, not a replacement for Save and Quit.

## 17. Destructive transition confirmation

The following actions replace or clear the active planning context:

- Changing game.
- Changing trainer occurrence.
- Changing exact trainer mechanics variant.
- Refreshing player combatants from a newer save snapshot.
- Importing another plan file.
- Explicitly clearing the plan.

When the active draft contains planning work, the calculator presents a confirmation before continuing.

If local live editing is active, a destructive transition must first resolve the same Stop Live Edit flow described in section 18.4. PLC may not silently abandon its writer lease or replace the live document with a different game, trainer, variant, roster, or imported plan.

If the current revision is not exported:

> Changing trainers will erase this battle plan, including initial conditions, Pokémon modifications, turns, and branches. No up-to-date output file exists.

Actions:

- Cancel.
- Output Plan, Then Switch.
- Discard and Switch.

If the current revision is exported:

> Changing trainers will clear the active plan. Your latest output file matches the current draft.

Actions:

- Cancel.
- Clear and Switch.

After confirmation, the calculator clears the action tree, initial overrides, player modifications, mid-battle state, switch history, and export-selection draft. It then ingests the current player snapshot and newly selected trainer from clean defaults. PLC never clears or changes the Overlay's current stream projection.

## 18. Plan file output and re-ingest

### 18.1 Ordinary output

Only Output Plan File creates a durable file. Recommended filename shape:

```text
<game-id>-<trainer-label>.plc-plan.json
```

Before output, the PLC node tree lets the user select the turn instances or branches to include. The export contains each selected instance plus the complete required ancestry back to the initial state. Selecting all exports the full committed graph. Unselected sibling branches and later descendants are omitted.

The output contains the combatant registry and every normalized state, action, event, range, probability, fingerprint, and display snapshot needed to:

- Reopen the included graph in PLC and create a new branch from any included state.
- Render the included graph in Overlay without running the calculator or loading dataset facts.
- Validate stable identities, lineage, revision, and mechanics provenance.

Incomplete previews are excluded. A committed node may include derived diagnostics, but PLC import must be able to recompute its results.

The output excludes Overlay display selection because opening a file never implies permission to display anything.

The format is defined for PLC and Overlay. It is structured, versioned, human-readable JSON, but it does not imitate Showdown notation or reference another calculator format.

### 18.2 Import

PLC and Overlay share a versioned plan-file validator. Import validates:

1. File kind, schema version, and size limits.
2. Game and trainer identities.
3. Exact trainer variant requirements.
4. Every referenced combatant, species, move, ability, item, nature, and ruleset ID.
5. Dataset and mechanics fingerprints.
6. Graph integrity, parent/child links, monotonic turn numbers, and cycle absence.
7. Probability and state-hash invariants.

If fingerprints match, PLC import restores an editable active draft. If they differ, PLC preserves the original document and results but marks the plan Needs Recalculation. The user must explicitly recalculate before producing a new current result.

Overlay import is read-only. It validates and displays the saved graph but does not recalculate, modify, or write the source file. Unsupported schema versions fail closed; mechanics-fingerprint differences produce a visible warning rather than silently substituting current results.

Import never publishes to the stream and starts with no Overlay display selection, even if the file came from a plan previously shown on stream.

### 18.3 Local-only live-edit capability

Begin Live Edit is an optional Stream Tools integration, not part of the portable PLC product. The button is present only when the local build loads its separate live-edit adapter and a trusted loopback capability check succeeds. Published builds omit the adapter and button entirely rather than showing a disabled control.

The loopback server permits exactly one active PLC live-plan session at a time. It creates a random session ID and an ephemeral managed file under ignored Launcher state. The managed file uses the same plan schema as an ordinary `.plc-plan.json` file; lease, heartbeat, and cleanup metadata live in a separate server-owned session record and are never exported.

Begin Live Edit initializes that file with the complete current committed plan, regardless of the user's ordinary export-selection draft. PLC is the only writer. It submits a complete plan snapshot after every committed graph change, debounced as needed. The server validates the document, requires the expected prior revision, writes the new revision atomically, and acknowledges it before PLC updates `lastLiveFlushedRevision`. Incomplete action previews are not published to the live file.

The Overlay dock's Begin Live Edit button discovers and attaches to the sole active session. If none exists, it reports that PLC has not begun a live edit. Overlay receives a read-only lease and monitors monotonically increasing plan revisions through the loopback API; it does not open a filesystem watcher or obtain an arbitrary local path.

New live-plan nodes are added to the Overlay tree as unselected turn instances. Existing display selection and the currently sent stream projection remain unchanged until the user explicitly changes selection and presses Send Turns.

### 18.4 Stop Live Edit behavior

While active, both buttons read Stop Live Edit.

Pressing Stop Live Edit in PLC first flushes the latest committed revision, stops further live writes, releases the PLC writer lease, clears `localLiveEdit`, and changes the button back to Begin Live Edit. This stop is complete before the follow-up modal is shown and is not cancelled by either modal choice.

The modal explains that live writing has ended and has exactly these primary actions:

- Save and Quit: open PLC's ordinary save screen so the user can select which committed nodes and branches to include, then generate a durable `.plc-plan.json` through the normal output flow. This does not resume live writing or clear the active PLC draft.
- Keep Editing: create no ordinary plan file and return directly to the same active, currently unsaved PLC draft. Editing continues only in PLC/IndexedDB; subsequent changes are not written to the stopped live file.

If the ordinary save screen opened by Save and Quit is cancelled, PLC returns to the same unsaved draft with live writing still stopped.

Pressing Stop Live Edit in the Overlay dock clears the imported live tree, its unsent and last-sent display selection, and the current battle-plan display projection, then releases the Overlay reader lease. Other Overlay state such as trainer, Focus, roster, layout, and DS focus is preserved.

If PLC stops while Overlay remains attached, the final live revision remains readable and selectable until Overlay stops. If Overlay stops while PLC remains active, PLC continues writing and Overlay may reattach later.

If PLC later presses Begin Live Edit while a compatible reader-held session for the same plan remains, it may reacquire that session's writer lease and publish the current complete plan as the next revision. If the old session was deleted or represents another plan, PLC creates a new session.

### 18.5 Lease expiry and deletion

PLC and Overlay send short heartbeats while attached. An explicit stop releases that client's lease. A closed, crashed, or disconnected client loses its lease after a bounded grace period.

The server deletes the ephemeral managed live file and its session metadata only after both the writer and every reader lease are absent or expired. A server restart applies a recovery grace period so reloading clients can reattach before an orphan is removed. Cleanup never deletes an ordinary downloaded plan file.

### 18.6 Proposed local interface

Exact route names may be finalized during implementation, but the local adapter requires bounded operations equivalent to:

- Discover local live-edit capability.
- Create or resume the sole active writer session.
- Submit a complete plan revision with expected-revision concurrency control.
- Discover and attach the sole active reader session.
- Fetch only when a newer revision exists.
- Heartbeat and release a writer or reader lease.
- Reap an unleased session after the recovery grace period.

Every route remains loopback-only, rejects arbitrary paths and session IDs, bounds request sizes and strings, and keeps live-plan state separate from `/__stream-tools/overlay-state/:gameId`.

## 19. Shared node-tree behavior

PLC and Overlay use the same plan schema, graph traversal, lineage, branch-count, and turn-instance selection rules. The implementations should share a headless selection module so behavior cannot drift. Their permissions and selection purposes differ.

### 19.1 PLC export selection

PLC's editable tree controls navigation and branch creation. Export mode lets the user choose the committed turn instances included in an ordinary output file. Selection automatically closes over required ancestors and shared plan metadata. It never changes Overlay state.

### 19.2 Overlay display selection

After ordinary import or live attachment, Overlay presents the imported graph through a read-only tree. Individual saved turn outcome instances are selectable, including multiple instances of the same turn number on different branches. No nodes are selected automatically.

Overlay derives display columns from selected-node lineage. For example:

```text
Turn 2
├─ Turn 3: Enemy faints
└─ Turn 3: Enemy survives
```

Selecting all three nodes produces two display branches and therefore two Overlay columns. The shared Turn 2 is repeated in both coherent branch paths.

Rules:

- A selected parent with one selected descendant produces one column.
- A selected parent with two selected descendants on different lineages produces two columns.
- Selected shared ancestors appear in every applicable column.
- Unselected ancestors participate in lineage calculation but are not rendered.
- Non-contiguous selected turn numbers are legal at the data layer. Their visual treatment is deferred.
- `branchCount` is the number of derived columns, not the number of checked nodes.

The Overlay selection summary reports at least:

```text
<N> turn instances selected · <B> branches · <B> Overlay columns
```

### 19.3 Editable Overlay selection draft

```json
{
  "sourcePlanId": "plan-vw2r-example",
  "sourcePlanRevision": 31,
  "selectedStateNodeIds": [
    "state-turn-2-main",
    "state-turn-3-ko",
    "state-turn-3-survive"
  ],
  "derived": {
    "selectedTurnCount": 3,
    "branchCount": 2,
    "columns": [
      {
        "columnId": "branch-ko",
        "stateNodeIds": ["state-turn-2-main", "state-turn-3-ko"]
      },
      {
        "columnId": "branch-survive",
        "stateNodeIds": ["state-turn-2-main", "state-turn-3-survive"]
      }
    ]
  }
}
```

Selecting or deselecting nodes changes only this draft. The Overlay stream window continues showing the last explicitly sent projection.

### 19.4 Editing a sent selection

After sending, Select Displayed reopens selection mode with the currently displayed nodes checked. The user may add or remove nodes. The calculator shows Display selection has unsent changes until the user sends again or cancels.

Cancel Selection restores the last-sent selection. Clear Display explicitly sends an empty projection.

Imported-file replacement or live-plan revisions never update the stream automatically. New nodes appear unselected. If a sent node later changes, becomes stale, or disappears from a newer live revision, the Overlay marks the sent projection outdated while continuing to render its last explicit snapshot until Send Turns, Clear Display, or Stop Live Edit.

## 20. Overlay display projection

### 20.1 No default publication

The Overlay stream window never receives a new projection merely because:

- PLC chose a most-likely working branch.
- The Overlay dock imported a plan file.
- The Overlay dock attached to a live session or detected a newer revision.
- PLC previewed or committed a turn.
- The Overlay display selection changed before Send Turns.

Only Send Turns in the Overlay dock replaces the live display projection during normal use. Clear Display and Overlay Stop Live Edit explicitly replace it with an empty projection.

### 20.2 Projection schema

```json
{
  "kind": "battle-plan-display",
  "schemaVersion": 2,
  "gameId": "volt-white-2r",
  "projectionRevision": 8,
  "sourcePlanId": "plan-vw2r-example",
  "sourcePlanRevision": 31,
  "sentAt": "2026-08-23T00:00:00.000Z",

  "selection": {
    "selectedStateNodeIds": [
      "state-turn-2-main",
      "state-turn-3-ko",
      "state-turn-3-survive"
    ],
    "selectedTurnCount": 3,
    "branchCount": 2
  },

  "columns": [
    {
      "columnId": "branch-ko",
      "turns": []
    },
    {
      "columnId": "branch-survive",
      "turns": []
    }
  ]
}
```

The Overlay dock derives each display turn from the rendering snapshot already stored in the imported plan. Each schema-v2 turn carries `players` and `enemies` arrays of one or two rendering participants. Multi-target actions preserve a bounded result label for every affected target. The projection contains only the stable IDs, display labels, selected actions/moves, damage/result labels, sprite-resolution identities, and outcome explanation required by the Overlay renderer. The projection is not the editable node graph. Overlay does not calculate battle state or resolve plan files.

### 20.3 Proposed loopback interface

The implementation should use a dedicated interface such as:

- `GET /__stream-tools/battle-plan-display/:gameId`.
- `POST /__stream-tools/battle-plan-display/:gameId` to replace the complete projection atomically.
- An explicit empty projection through POST for Clear Display.

The exact route name may be finalized during implementation, but it must remain separate from `/__stream-tools/overlay-state/:gameId`.

The server validates the game ID, schema version, source identifiers, revision fields, bounded string lengths, node IDs, turn numbers, column shape, payload size, and display-safe values. Invalid projections fail with HTTP 400 and do not partially replace the previous projection.

Projection state is ignored operational state written atomically under the Launcher's `.state` boundary. It contains no editable plan document, live-plan file, save path, credentials, or dataset authority.

The future Overlay branch-window renderer polls this dedicated endpoint at a modest revision-aware interval. The stable Overlay router presents that renderer to OBS. Same-context messaging may accelerate updates but is never the cross-context authority.

## 21. Processing and storage strategy

### 21.1 Web Worker

The Web Worker owns:

- Action validation that depends on mechanics.
- Effective priority and speed ordering.
- Damage-adapter calls.
- Event resolution.
- Range threshold analysis.
- Branch generation, probability composition, and equivalence merging.
- State-hash generation.

The main thread owns UI state, IndexedDB orchestration, file pickers/downloads, node-tree interaction, and explicit projection submission.

Every worker request includes a monotonically increasing request revision. Responses for an older revision are discarded.

### 21.2 Structural sharing

To control plan size, implementations should share:

- One combatant registry.
- One action group across all its outcome nodes.
- Parent state plus deterministic state deltas where practical.
- Interned event and condition identifiers when useful.

An exported plan may include reconstructed full states for portability only if size and deterministic validation remain acceptable. Storage optimization must not make the document non-reproducible.

### 21.3 Game-scoped Boxes library

The Boxes library is separate from the one-active-plan draft database. Its portable document has a versioned kind/schema pair, a revision, and a map keyed by game ID. Each game owns ordered Boxes; each Box owns ordered canonical Pokémon records and ordered named Parties. A Party stores record IDs rather than copies. Party membership is many-to-many within one Box and is capped at six distinct records.

Canonical Box records contain editable nickname, species/form, level, gender, base stats, IVs, EVs, nature, ability, item, and up to four moves with move ID, displayed name, base power, PP, and type. Save-derived records may additionally contain total EXP. Actual stats and EXP-to-next-level are formula-derived. Dataset values remain authoritative defaults and displayed source truth; record-level base-stat and move BP/type values are plan-input calculation overrides and never mutate standardized data. Boxes JSON import/export is portable and game-scoped. Showdown import may create a Box or add records to an existing Box; Showdown export serializes selected records.

A supported save import always creates a new Box and a default Party from the active party. It is a one-time read-only snapshot. After parsing and before any records or sprites are added to the Boxes interface, PLC presents a text/count-only PC Box selector. The active party is mandatory; the user may select any combination of the adapter's available PC Boxes, including none, and must explicitly save the import. Cancelling creates nothing. Supported DS adapters normalize either an exact 524,288-byte raw `.sav` or a 524,410-byte DeSmuME `.dsv` with its validated 122-byte footer before game-specific parsing; `.srm` is not an advertised import format. The enabled VW2R adapter exposes its seven validated 30-slot PC Box boundaries, resolves move/ability/item/nature identities through standardized `save_id_maps.json`, resolves the base species independently from the packed form field, and extracts total EXP along with the mandatory party and confirmed PC Boxes. The Gen 5 held-item sentinel `0` imports as no held item; an unresolved nonzero held-item identity fails closed with its storage location instead of silently becoming `None`. Other registered save parsers remain unavailable in the interface until the selected game's standardized Dataset and battle-mechanics contracts pass. Non-base forms require an explicit Dataset-owned packed-form map rather than guessing from display-oriented form arrays.

Beginning a plan copies the selected Box records into an immutable plan combatant snapshot. Later Box edits do not rewrite an active plan. Starting absolute HP and major status are plan-context declarations and are not written back to canonical Box records.

Locking a battle-ending branch may explicitly write its player party's absolute final EXP and levels to the originating canonical Box records. The write uses stable record and Box identities, updates every tracked party record to the selected branch's totals, and never applies an EXP delta to the current Box value. Therefore saving a different terminal branch from the same plan replaces the earlier saved result, including restoring a record to the plan baseline when the later branch gave it no EXP. The active plan, its root state, and its other branches remain immutable; the saved progression is consumed only when a new plan snapshots those Box records. Imported portable plans bind their automatically created `Import #` party to the local records before this write is offered.

## 22. Cross-game readiness contract

The planner core supports a game only when an adapter can provide:

1. A complete standardized manifest and source identities.
2. A validation-passed damage mechanics contract for the pinned supported engine.
3. Structured move-effect metadata for every selected move behavior the turn resolver must apply.
4. Generation/ruleset modules for turn order, switching, residual order, statuses, and field effects.
5. Exact trainer variants and runtime-required inputs.
6. A normalized player combatant snapshot or visible manual replacement fields.

The planner should eventually add an explicit versioned turn-resolver readiness section to the game's mechanics contract or a manifest-declared companion contract. It must name:

- Resolver ruleset/version.
- Supported action types.
- Supported move, item, ability, status, weather, terrain, switching, and residual effect IDs.
- Structured per-game overrides.
- Validation status, unresolved count, covered source files, and known-answer suite.

Games lacking this contract remain unavailable for progressive planning even if ordinary overlays or one-off damage calculations work. The UI reports the missing readiness requirement instead of selecting another game's rules.

## 23. Illustrative VW2R branch example

This example uses illustrative combatants and values. It demonstrates the planner model and is not a claim about a specific VW2R trainer record.

### Root state

- Player and enemy begin at 100% HP.
- Weather and terrain are clear.
- Both have zero stat stages.

### Turn 1 action group

- Player selects a guaranteed Defense-boosting move.
- Enemy selects a damaging move.
- Player has higher effective speed and acts first.

Resolution:

1. Player's Defense stage changes before enemy damage is calculated.
2. Enemy damage uses the increased Defense.
3. End-of-turn state records the new Defense stage and reduced HP range.

### Turn 2 main action group

- Enemy is faster and selects a damaging move.
- Player selects Revenge.

Resolution:

1. Enemy damages player first.
2. The event log sets `player.turnFlags.wasDamaged = true` and records the attacker.
3. Revenge resolves using its satisfied conditional-power behavior.
4. Damage rolls cross the enemy's current-HP threshold.

Automatic outcomes:

```text
Turn 2
├─ 18.75%: Enemy faints; no later enemy action is possible
└─ 81.25%: Enemy survives in the stored HP range
```

The survival outcome becomes the working default because it is more likely. Neither outcome is published to the Overlay.

### Alternate decision branch

The user selects the Turn 1 outcome node, changes the player Turn 2 action from Revenge to Switch, reviews every resulting switch/damage outcome, and presses New Branch. The original Revenge action group and all descendants remain intact.

### Explicit Overlay selection

The user enters Select Displayed mode and selects the Turn 1 outcome plus both Turn 2 outcomes. The derived selection reports two branches and produces two columns. Send Turns publishes those two columns atomically.

## 24. Invariants

Implementations must preserve these invariants:

1. No durable plan file is created without explicit Output Plan File or successful Save and Quit.
2. Ordinary plan output is portable and requires no live Overlay or Stream Tools connection.
3. No plan import, live attachment, live revision, PLC action selection, preview, turn commit, branch selection, or most-likely default changes the stream projection.
4. Overlay Send Turns, Clear Display, and Overlay Stop Live Edit are the only actions that replace the Overlay projection.
5. Turn numbers are labels/order, never unique branch identity.
6. A committed action group is shared by its outcome nodes.
7. Adding a sibling branch does not mutate or erase existing branches or descendants.
8. A changed action invalidates only its uncommitted preview until explicitly committed as a new branch.
9. All runtime state changes are ordered events; conditional moves inspect event/state facts rather than user-facing prose toggles.
10. Faint-before-action is an action-skipped result, not zero damage.
11. HP uncertainty remains a range until a material threshold requires a split.
12. Unknown probability is never labeled most likely.
13. Dataset facts and current save output are read-only inputs.
14. Exact trainer variant and runtime-observed requirements fail closed.
15. The editable PLC plan remains client-side except for explicit ordinary output and the optional local live file.
16. The live file uses the ordinary plan schema, has exactly one PLC writer, and is never the durable saved-file authority.
17. The server deletes only an unleased ephemeral live file after its recovery grace period; it never deletes an ordinary plan download.
18. Imported plans and new live nodes never carry automatic display permission.

## 25. Validation plan

### 25.1 Schema and graph validation

- Accept a minimal root-only plan.
- Reject duplicate IDs, missing parents, cycles, invalid turn-number progression, cross-game IDs, and malformed ranges.
- Round-trip a complete plan document without semantic loss.
- Reconstruct state deterministically from full states or deltas.
- Verify action signatures deduplicate identical child action groups.

### 25.2 Ingest validation

- Normalize a copied/approved Save Tracker payload without reading or mutating the save.
- Map all parser stat keys to canonical planner keys.
- Preserve explicit species/form IDs and stable player instance keys.
- Validate exact trainer occurrence, variant, slot, IV, EV, nature, ability, item, move, and battle format.
- Prove VW2R zero player EV use comes from the mechanics contract.
- Fail visibly on missing required data.

### 25.3 Resolver validation

- Priority and effective-speed order.
- Speed ties and tied probability.
- Defense boost before later damage.
- Guaranteed KO skips the later action.
- Possible KO creates KO/survival outcomes.
- Revenge-like conditional power derives from earlier damage events.
- Voluntary switch, entry effects, and outgoing-state reset.
- Forced replacement without consuming a numbered turn.
- Healing, recoil, major status, weather/terrain, Protect, and deterministic residual order.
- All 559 standardized VW2R moves compile to structured descriptors and enter both Singles and Doubles resolution without an unsupported-move failure.
- Representative Showdown callback behavior: delayed attacks/heals, Bide, Substitute, Baton Pass, conditional/random power, crash/self-KO effects, redirection, side guards, order control, and Pledge combinations.
- HP-range threshold split and equivalent-state merge.
- Probability composition and sibling total.
- Unsupported effects fail closed.

### 25.4 Cache and file validation

- Refresh restores the one active IndexedDB draft.
- Draft and exported revisions report freshness correctly.
- Destructive trainer/game/variant/roster/import changes require the correct confirmation.
- Output and successful Save and Quit are the only durable file-creation paths.
- Selected-node output includes required ancestry and can be reopened and branched without omitted siblings.
- The plan round trip preserves both canonical resolver state and rendering snapshots.
- PLC import restores editing; Overlay import remains read-only.
- Import never publishes and Overlay begins with no display selection.
- Matching fingerprints reopen editable; mismatched fingerprints require recalculation.
- Oversized or hostile JSON is rejected without changing the active draft.

### 25.5 Display-selection validation

- PLC export selection and Overlay display selection remain independent.
- One linear selected path derives one column.
- One selected shared parent plus two selected descendants derives two columns.
- Shared selected ancestors repeat in each coherent column.
- Unselected ancestors are omitted from the presentation while lineage remains correct.
- Editing a sent selection does not change the last-sent projection.
- Cancel restores the last-sent selection.
- Send Turns atomically replaces the complete projection.
- Clear Display sends an explicit empty projection.
- Ordinary file replacement and live revisions mark affected projections outdated without silently updating the stream.

### 25.6 Server validation

- Run on an isolated port and `STREAM_TOOLS_STATE_ROOT`.
- Hide the local live-edit capability when the adapter/server is unavailable and omit it from the published build.
- Permit only one active writer session; attach and release independent writer/reader leases.
- Accept a complete valid live-plan revision only with the expected prior revision and acknowledge it after atomic replacement.
- Make new live revisions discoverable without exposing an arbitrary filesystem path.
- Keep an ephemeral live file while either writer or reader remains attached.
- Expire crashed-client leases, honor the recovery grace period, and delete the session only after all leases are absent.
- Prove PLC Stop Live Edit flushes and releases its writer before showing the modal.
- Prove Keep Editing creates no ordinary file, preserves the same draft, and leaves live writing stopped.
- Prove Save and Quit opens ordinary node selection, and a completed output preserves the durable copy while later live-session cleanup removes only ignored state.
- Prove cancelling the ordinary save screen returns to the same unsaved draft without reacquiring the writer lease.
- Accept a valid compact projection and increment its revision.
- Reject malformed game IDs, turns, columns, strings, and oversized requests with HTTP 400.
- Preserve the prior projection after a rejected request.
- Persist an explicitly sent projection across a server restart.
- Keep existing overlay-state partial updates and public fields unchanged.
- Do not touch live player JSON, current game, trainer/focus/layout state, OBS, or ignored production state during automated tests.

### 25.7 Existing regression gates

- Shared damage-calculator unit tests.
- VW2R known-answer tests.
- Sprite-resolution and Focus species-resolution tests.
- VW2R standardized-source validation and overlay contract.
- Syntax checks for changed JavaScript and parsed inline scripts.
- Stable route and project-generated headless checks when UI work begins.
- Real OBS validation remains mandatory only after a visual renderer and production route are implemented and the user authorizes refresh.

## 26. Implementation stages

### Stage 1: Formal schemas and fixtures

- Convert the representative structures in this document into versioned JSON Schemas or equivalent validators.
- Add graph, ID, range, and probability invariant tests.
- Create an illustrative VW2R plan fixture with a meaningful KO/survival branch and alternate Switch decision branch.

### Stage 2: Normalized ingest adapters

- Player collection adapter for the current standardized Save Tracker output.
- Standardized trainer/variant adapter.
- Initial-condition override contract.
- Readiness and source fingerprint generation.

### Stage 3: Pure resolver and branch engine

- Worker-safe, DOM-free state and event engine.
- Shared damage-calculator integration.
- Initial structured effect registry.
- Range, threshold, probability, and equivalence behavior.
- Next Turn/New Branch preview and commit behavior.

### Stage 4: Draft cache and plan files

- Single active IndexedDB draft.
- Destructive-transition confirmation state machine.
- Selected-node ordinary output with automatic ancestry closure.
- Shared PLC/Overlay plan validation and PLC re-ingest.
- Needs Recalculation behavior.

### Stage 5: Overlay plan ingest and display selection

- Read-only ordinary plan import and identical node-tree traversal behavior.
- Node-lineage column derivation from an imported plan.
- Editable selection draft and last-sent state.
- Dedicated loopback projection endpoint on an isolated state root first.
- Explicit Send Turns and Clear Display.

### Stage 5A: Optional local live editing

- Capability-gated local adapter omitted from published builds.
- Single writer session, read-only Overlay attachment, revision concurrency, heartbeats, and recovery grace.
- Begin Live Edit and Stop Live Edit state machines in PLC and Overlay dock.
- Atomic complete-plan updates, unselected new-node reconciliation, immediate writer stop, post-stop save choice, and safe ephemeral cleanup.

### Stage 6: Calculator interaction design

- Game-first shell with separate PLC and Boxes tabs.
- Modal Plan Context with a trainer selector grouped by standardized progression split and canonical within-split order, trainer-derived format, a read-only selected-enemy-team preview above Box/Party selection, plan-only starting HP/status, and an explicit Begin action.
- Horizontal state-node columns with equal player/enemy action summaries on every committed node.
- HZLA-inspired two-sided static combatant/action interface, centered current-effects Field panel, and HZLA-style outcome range/raw-roll descriptions.
- Save-derived total EXP displayed as `current total/next-level total threshold`, plus Field-panel projected/actual per-Pokémon EXP lines. Level and stat changes follow the same red-current-turn, gold-persisted, default-restored tone rules as other iterative state.
- Most-likely crafted-outcome preview with per-move and per-action branch-event controls.
- Editable node tree and export-selection mode.
- Most-likely working cursor and manual branch navigation.
- Accessibility, keyboard, focus, narrow-dock, desktop, and error-state behavior.

### Stage 7: Overlay branch-window renderer

- Column and turn-cell geometry.
- Sprites, arrows, move labels, damage/result presentation, and branch labeling.
- Overlay-owned window behavior, stable router, and production Browser Source integration.
- Project-generated screenshots followed by explicitly authorized real OBS validation.

## 27. Deferred visual and expansion decisions

The following remain expansion decisions after the first game-first Boxes and calculator-interface build:

- Final calculator color, typography, spacing, and animation polish beyond the implemented HZLA-inspired structure.
- Richer branch-line geometry beyond the implemented horizontal turn columns and lineage highlighting.
- Overlay cell dimensions, maximum simultaneous columns, viewport behavior, and non-contiguous-turn gaps.
- Whether move names accompany damage percentages in every Overlay cell.
- Column ordering and manual column reordering.
- Additional ability/item residual and switch-in interactions beyond the bounded structured registries.
- Triple and Rotation Overlay projection.
- Enabled battle-item UI.
- Exact observed-state reconstruction from Battle Log data beyond the bounded decoded-move identity match.
- Distribution, remote local-service integration, and other-device OBS setup.

These deferred items must not require a rewrite of the plan document, action-group/outcome graph, display-selection, or projection contracts above.

## 28. Gen 5 Triple Battle logic extension

Triple Battles are enabled only by a game profile whose standardized trainer format is `triple` or `triples`. The VW2R profile uses Generation 5 mechanics. Other generations and games must opt into their own format profile; Triple behavior must not leak into Singles, Doubles, or Rotation Battles.

### 28.1 Positions and identity

- Each side has three stable displayed positions in one shared player-view coordinate system: left `0`, center `1`, and right `2`. Player action slots map directly to those positions. Enemy action slots preserve trainer lead order and map to displayed positions as action slots `[1, 2, 0]` for Left, Center, Right; every label, target list, adjacency check, Shift, Ally Switch, and automatic-centering rule resolves through that mapping.
- Portable schema-v3 Triple plans store three active/action entries per side. Existing schema-v1 Singles and schema-v2 Singles/Doubles plans remain readable without semantic migration.
- UI slot labels may number the player and enemy rows globally, but the resolver uses `{ side, position }`; display numbers never determine reach.
- Same-side adjacency is `abs(sourcePosition - targetPosition) === 1`.
- Both rows use the player's shared top-down left/center/right coordinates. Cross-side adjacency is `abs(sourcePosition - targetPosition) <= 1`; for example, player Slot 1 reaches enemy Slots 4 and 5, not Slots 5 and 6.
- Initial deployment uses the first three eligible party members as left, center, and right.

### 28.2 Targeting and spread damage

- Target legality is checked when actions are declared and checked again against the current positions when each action executes.
- `allAdjacentFoes` and `allAdjacent` dynamically filter targets by the actor's execution-time position.
- A move with canonical distance reach may target any legal field position. Distance reach comes from structured mechanics metadata such as the pinned original move definition; temporary type changes never create or remove that property.
- Source-response effects such as Counter, Mirror Coat, Metal Burst, Bide, Destiny Bond, and Grudge retain their source relationship across distance where Generation 5 permits it.
- A living target made unreachable by an earlier positional change causes the move to fail. A target that fainted may be redirected only to a surviving opponent the move can legally reach.
- Attention redirection applies only when the move can legally reach the redirecting Pokémon.
- Multi-target damage uses the Doubles/Triples 0.75 spread modifier when more than one target exists at execution. If exactly one target exists, normal single-target damage applies.

### 28.3 Shift action

- `shift` is a schema-v3 turn action available only to a Pokémon declared in an edge position.
- The acting edge Pokémon exchanges positions with the current center occupant. The center Pokémon cannot predeclare a contingent Shift.
- Shift has priority `0`, uses the initiating Pokémon's effective Speed, and resolves among moves. Move-only fractional-order effects such as Quick Claw and Custap Berry do not activate for Shift. Both edge Pokémon may declare Shift and resolve sequentially in one turn.
- Shift consumes the initiating Pokémon's action but consumes no PP or item.
- Shift is not switching: it does not trigger hazards, entry/exit Abilities, switch healing, Pursuit, EXP participation, or state resets.
- Stat stages, types, Ability state, item state, major and volatile status, counters, move locks, and current HP remain attached to each Pokémon.
- Sleep, freeze, paralysis, confusion, flinch, Truant, Encore, and similar move-prevention checks do not prevent Shift. Their action counters do not advance merely because the Pokémon shifted.
- Later queued actions follow their acting Pokémon to its new position. Their selected target location is revalidated from that position; an ally target that becomes the user itself fails.

### 28.4 Positional effects

- Intimidate affects only adjacent opposing Pokémon at the moment the user enters battle.
- Follow Me and Rage Powder redirect only reachable moves.
- Flame Burst applies its one-sixteenth maximum-HP collateral damage only to allies adjacent to the struck target, including when the direct hit is absorbed by Substitute; Magic Guard prevents that collateral damage.
- Acupressure may select only the user or an adjacent ally according to its canonical target rules.
- Generation 5 Ally Switch fails from center and otherwise exchanges the user with the ally on the opposite edge. It remains distinct from Shift.
- Effects defined for a side, team, field, or all active combatants remain non-positional unless their structured Generation 5 rule says otherwise.

### 28.5 Field, fainting, and replacement behavior

- Weather is one global field condition regardless of its move or Ability source. Position does not limit weather activation, damage, healing, accuracy, or stat effects, and Shift does not restart it.
- Screens, hazards, rooms, and other existing side/global state retain their established scope.
- Forced replacements enter the selected vacated position. When fewer reserves remain than fainted positions, the user chooses which positions receive the available replacements; every unchosen position becomes empty while the battle continues.
- If exactly one living Pokémon remains on each roster and their active positions are non-adjacent, both move automatically to center after end-of-turn effects.
- Battle completion continues to depend on living roster members, not occupied slot count.

### 28.6 Exact action-order resolution

- Six-actor ordering must not eagerly materialize every full Speed-tie permutation.
- Equal-order actors resolve lazily, with each remaining tied actor having equal conditional probability at each step.
- Equivalent resolver states merge while preserving exact total probability and significant branch-event conditions.
- No low-probability order or outcome may be silently discarded or approximated. A safety ceiling must fail closed with a diagnostic.

### 28.7 Logic and local-interface acceptance gates

Automated tests must cover the full adjacency matrix, distance exceptions, one and two Shift actions, Shift under status, Shift item-order exclusions, dynamic range failure, spread target counts, position-aware Intimidate and redirection, Flame Burst through Substitute, Ally Switch, global weather, forced replacements, empty positions, automatic centering, priority, Trick Room, six-way Speed ties, schema round trips, and complete Singles/Doubles regression.

The local Triple interface uses opposing L-shaped formations viewed from above. The player center occupies the inside upper-right cell, while the enemy center occupies the mirrored inside upper-left cell and the enemy's Right card folds below it on the left. Both sides use the player's shared Left/Center/Right viewpoint. Cards are labelled with global Slots 1–3 for the player and Slots 4–6 for the enemy, with numbers increasing Left to Right. Edge cards expose Shift with the current center slot, target damage sections are ordered by displayed opposing slot and mark only unreachable positions `Out of range`, and Shift previews swap the affected cards without detaching their chosen actions from combatant identity. At narrow widths, each side stacks Left, Center, then Right.

Triple node rows always reserve six sprite positions in global Slot 1, 2, 3, 4, 5, then 6 order. They use the turn's end positions, preserve empty placeholders, and retain the existing red faint and blue voluntary-switch borders. Triple plans remain local-only for display integration: Live Edit is disabled and Overlay projection must fail closed until its owning component gains and validates a schema-v3 presentation contract.

## 29. Gen 5 form-dependent Ability state

- Trace filters out non-copyable Abilities and branches equally over eligible adjacent opposing Pokémon before action ordering. The selected copied Ability becomes ordinary current Ability state and executes its entry effect when applicable.
- Forecast reacts to effective weather immediately. Castform's current species, type, calculated stats, and sprite switch among its standardized Normal, Sunny, Rainy, and Snowy forms and revert when weather is absent or suppressed.
- Flower Gift reacts to effective sun immediately. Cherrim uses an explicit Sunshine sprite state and each side exposes whether a living active Flower Gift Cherrim supplies the Gen 5 ally modifier. PLC passes this side flag to Battle Mechanics; that owner must allowlist `isFlowerGift` in its shared side-options contract before the pinned calculator applies the ally modifier.
- Zen Mode checks at residual order 29. Exact HP distributions that straddle half HP branch into Standard and Zen states; current species, Fire/Psychic typing, calculated stats, and sprites follow the selected state and revert when the threshold or Ability no longer applies.
- Current form identity is resolver state rather than a Dataset rewrite. It persists through node commits and plan files, drives damage requests and planner sprites, and resets through the ordinary switch/Transform rules.

## 30. Gen 5 Rotation Battle extension

Rotation Battles are enabled only by a game profile whose standardized trainer format is `rotation`. The VW2R profile uses Generation 5 mechanics. Rotation rules must not leak into Singles, Doubles, or Triple profiles.

### 30.1 State and participation

- Portable schema-v4 Rotation plans deploy three Pokémon per side and store `rotation.frontSlots.player` and `rotation.frontSlots.enemy` as zero-based displayed positions. Schema-v1 through schema-v3 plans retain their existing meaning.
- The front Pokémon on each side is the sole ordinary active participant. Waiting Pokémon remain deployed and visible but are not ordinary move targets and do not participate in proximity-scoped entry Abilities, spread effects, residual damage or healing, or other effects limited to active participants.
- Weather and other true field state remain global. Rotation never limits their existence to the front position.
- A combatant's HP, PP, status, volatile state, stat stages, types, Ability state, item state, and participation history remain attached to combatant identity while it waits or rotates.

### 30.2 Rotate-and-move declaration

- Each side declares exactly one ordinary turn action. Selecting a move on a waiting Pokémon declares that Pokémon as the actor and rotates it to the front before it uses the selected move.
- Rotation has priority `+6`, before ordinary move priority. After rotation, the selected move resolves at its own priority and effective Speed in the ordinary action-order system.
- Rotation is not switching. It does not trigger entry hazards, entry or exit Abilities, switch healing, Pursuit, EXP participation, or switch/reset semantics.
- The selected move targets the opposing front Pokémon after both sides' declared rotations have resolved. Preview damage and action controls follow the prospective front actors without changing the committed state.
- A voluntary switch replaces only the current front combatant. Waiting deployed Pokémon are not legal switch destinations or switch-out actors.

### 30.3 AI actor selection and presentation

- Generation 5 Rotation AI chooses one living deployed Pokémon uniformly before that actor's move scoring: one third with three candidates, one half with two, and certainty with one. This actor probability is separate from the conditional probability of a move given that actor.
- The local UI reuses the six-card Triple geometry and global Slot 1–6 node sprite order. Each side marks exactly one living **Front** card and the other deployed cards **Waiting**.
- Triple-style six-sprite node rows preserve slot order and existing faint/switch borders. Rotation is not presented as a voluntary switch border.
- Live Edit and Overlay projection fail closed for Rotation until the Overlay owner adds and validates a schema-v4 presentation contract.

### 30.4 Acceptance gates

Automated tests must cover format recognition, schema round trips, initial fronts, reserve move declaration, priority-6 rotation ordering, state preservation, front-only targeting/residual/Ability participation, global weather, switch limits, forced replacement, node sprite order, AI actor probability, and complete Singles/Doubles/Triple regression. Browser validation must prove six cards, fixed labels, Front/Waiting markers, one action per side, reserve selection, and responsive geometry.

## 31. Dataset-backed Trainer AI education

- Dataset owns each game binding, inherited generation AI profile, executable-semantics documentation, readiness blockers, command coverage, trainer AI masks, and trainer battle-profile association. PLC consumes digest-verified generated copies and never turns display prose or command names into guessed executable behavior.
- The Notes panel renders a read-only **Enemy AI forecast** separately from the editable per-node user note. Generated text must never replace, mutate, or serialize into the user's note.
- The player-facing vocabulary is **Very Unlikely**, **Unlikely**, **Possible**, **Likely**, **Very Likely**, and **Guaranteed**. Options with equal modeled weight are identified explicitly. Exact rational weights remain internal validation evidence and are not the primary educational presentation.
- **Turn actions** are one forecast domain. PLC evaluates the ordered full action pipeline and lets forced continuations, trainer-item use, voluntary switches, Rotation actor selection, and move/target scoring preempt or combine exactly as the Dataset profile declares.
- **Replacement after a faint** is a separate forecast domain. For each active enemy with a healthy reserve, PLC evaluates a hypothetical post-KO request from the current state and lists the possible switch-ins independently of current-turn moves, items, and voluntary switches.
- Move explanations expose the incentive-point ledger. Each legal move-target candidate begins at the profile's declared initial score—100 for supported Generation 4 and 5 profiles. Every reached executable score adjustment shows the documented points added or removed and the educational reason. Final score outcomes and source-defined tie selection remain distinct. Trainer items, voluntary switches, and replacements use their real eligibility, gate, priority, or ranking systems; PLC must not invent a 100-point ledger for phases that do not use one.
- The supported VW2R and Renegade Platinum builds run their Generation 5 and Generation 4 evaluators in the resolver Worker with exact numeric move/item bindings and state-backed command/action queries, including shared-calculator maximum-damage ranking. If the exact evaluator succeeds, the forecast derives directly from it. When a Renegade Platinum path is blocked only by the player's inability to observe the exact unsigned 32-bit `state.random.g4LcrngSeed`, the shared forecast layer runs a deterministic bounded ensemble of exact stateful seed executions and maps the result to a likelihood band. This is modeled player guidance, not an exact probability claim or recovered emulator state.
- Missing commands, action semantics, required battle state, stale generated inputs, and unsupported multi-active selection state remain fail-closed and are presented as **Forecast error**. Hidden RNG alone is ordinary uncertainty and must not appear as “Probability unavailable.” Planner actions and user notes remain usable after an AI forecast error.

## 32. Private observed-turn comparison

### 32.1 Ownership and transport

- The VW2R Battle Log owns emulator attachment, packet decoding, event persistence, and its loopback API. PLC is read-only and never writes to the log, emulator, ROM, or save.
- The Stream Tools Launcher owns a bounded same-origin proxy at `/__stream-tools/vw2r-battle-log`. It exposes only capability, normalized state, and sanitized semantic events. Raw packet events, packet bytes, arbitrary paths, and non-loopback upstream hosts are excluded.
- The private Tailscale test gateway may proxy these same read-only routes for an authenticated tailnet user. The feature remains private and is excluded from the public static build.

### 32.2 Session and actual-node lane

- Beginning Battle Tracker while a battle is active attaches to the most recent non-ended battle. Beginning while inactive baselines all existing history and waits for the next battle-start event, so a prior battle cannot be mistaken for current evidence.
- Polling is incremental by monotonically increasing event ID. A new battle-start event clears the prior observed session before collecting the new one.
- Semantic events are grouped by reported turn. A turn becomes complete when a later turn begins or the battle ends. An in-progress turn remains visible but cannot be used as a branch source.
- Observed turns occupy a fixed **Actual** lane beside the plan graph. The lane does not rewrite plan nodes, outcome probabilities, selected moves, user notes, or Overlay projection.

### 32.3 Comparison and branch creation

- Current v1 matching decodes move numeric IDs through the selected game Dataset and compares the complete turn's sorted player/enemy move identities to action groups for the same turn number.
- **Create Branch from Actual** is enabled only when those identities uniquely identify one planned state node. It selects that existing state as the branch point; subsequent planner actions create an ordinary user branch under existing graph rules.
- In-progress, insufficient, ambiguous, and unmatched turns display an explicit explanation and keep branch creation disabled. PLC never guesses between multiple planned states or invents HP/status state that the log did not publish.
- Exact actual-state reconstruction, damage-roll binding, switch/replacement identity, status attribution, and automatic plan mutation require a future versioned Battle Log event contract and are not implied by decoded move matching.

### 32.4 Acceptance gates

Unit tests must cover session baselining, current-battle attachment, battle reset, turn completion, semantic-event sanitization, unique matching, ambiguity, insufficient evidence, unmatched evidence, and branch eligibility. Launcher tests must prove upstream loopback restriction, route allowlisting, and raw-packet exclusion. A private browser smoke must verify capability detection, begin/wait/follow/stop controls, Actual-node presentation, and public-build exclusion. A live captured battle remains a separate manual integration gate.
