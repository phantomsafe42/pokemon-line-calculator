# Pokemon Line Calculator

Pokemon Line Calculator (PLC) is a local-first Web Tool for building, calculating, branching, saving, reopening, and selectively presenting turn-by-turn Pokémon battle plans.

## Current status

The current local build implements Stages 1 through 7 of the battle-planner specification plus the tested schema-v2 Singles/Doubles, schema-v3 Generation 5 Triple, and schema-v4 Generation 5 Rotation extensions, game-first Boxes library, EXP planning, complete VW2R move adapter, and calculator-interface redesign. The build includes:

- A versioned portable plan schema plus graph, ID, range, probability, size, and hostile-field validation.
- Selected-node output with automatic ancestry closure and plan-file re-ingest.
- Standardized dataset, exact trainer-variant, selected-game read-only save with a mandatory-party/optional-PC-Box review step, Showdown set, portable Boxes JSON, and shared damage-calculator adapters. The enabled VW2R adapter accepts a raw `.sav` or validated DeSmuME `.dsv`; other registered game parsers remain gated until their standardized Dataset and battle-mechanics contracts pass. Move, ability, item, and nature identities resolve through standardized `save_id_maps.json`; the Gen 5 held-item value `0` remains `None`, while an unresolved nonzero identity fails closed. Species resolution starts from the unique base standardized record sharing the save's numeric species ID, because alternate forms reuse that ID and are encoded separately in the packed form field.
- Read-only VW2R save EXP import plus player-only Gen 5 trainer-battle EXP projection. The Player Action panel displays current total EXP over the next-level total threshold. The portable plan tracks per-enemy participation through switches, Exp. Share and Lucky Egg splits, one-time faint payouts, level-ups, recalculated stats/HP, and current-turn/persisted UI tones. Locking a battle-ending branch offers to write that branch's absolute EXP and levels back to its canonical Box records; the active plan remains frozen, and a later locked branch overwrites those Box totals instead of compounding them. Projection consumes standardized species `baseExp` and normalizes it to the portable plan's `baseExperienceYield` field; PLC does not repair or rewrite Dataset files.
- A DOM-independent Singles/Doubles resolver plus schema-v3 Generation 5 Triple and schema-v4 Generation 5 Rotation extensions for per-slot Move, voluntary Switch, Triple Shift, Rotation's priority-6 rotate-and-move selection, and same-turn forced replacement actions; multi-actor priority/speed order and order control; position-aware target reach; ally/foe spread targeting; redirection and side guards; slot-aware switch interception and switch-in damage previews; staged move accuracy; exact normal/critical damage candidates (including independent multi-hit criticals); KO/survival thresholds; faint-before-action cancellation; crafted branch-event selection; progressive HP/status/stage/item/ability/PP/volatile state; delayed attacks and heals; switching and Baton Pass; major status; weather/terrain/rooms; and deterministic supported residuals.
- A VW2R-only, generated move-semantics adapter covering all 559 standardized VW2R move IDs. It is built from pinned `pokemon-showdown@0.11.11` definitions with Showdown's Gen 8, Gen 7, Gen 6, and Gen 5 historical layers applied in order, then explicit calculation-only VW2R overrides. It does not alter standardized display data or apply VW2R quirks to other games.
- One active IndexedDB draft with crash/refresh recovery, export freshness, destructive-transition confirmation, selected-node output, current-fingerprint reference validation, and explicit recalculation.
- A classic Web Worker boundary with monotonically increasing preview requests.
- A game-first, responsive browser editor with separate PLC and Boxes tabs. Boxes are game-scoped IndexedDB libraries containing canonical editable Pokémon records and named Parties that reference those records. Form-, gender-, and shiny-aware sprite calls resolve through the versioned Pokémon Asset Dataset; PLC requests animated Gen 5 art with explicit static Gen 5 and pixel fallbacks, and a missing asset preserves the card's sprite column instead of collapsing its contents. The trainer selector is grouped by standardized progression split and ordered by canonical `trainer_order.json` position within each split. PLC derives Singles, Doubles, Triples, or Rotation from the selected trainer, snapshots a saved/manual Box party at Begin, exposes static HZLA-inspired combatant panels with selectable moves, switches, Triple Shift, and Rotation front/reserve controls, uses a horizontal node tree, and presents HZLA-style damage ranges and raw rolls. A switch preview calculates the displayed incoming Pokémon with its own stats, types, item, and Ability while retaining the occupied slot only for range and spread-target geometry.
- A dedicated bounded schema-v2 Overlay projection endpoint, schema-v1 plan migration, read-only plan import in the OBS dock, explicit Select Displayed/Send Turns/Clear Display behavior, and a stable combined-source renderer for Singles or Doubles across one or more branch columns.

The accepted Generation 5 Triple Battle extension uses three positions per side, execution-time adjacency and target revalidation, Shift, dynamic spread counts, position-aware Intimidate/redirection, Triple Ally Switch and Flame Burst behavior, forced replacement/empty-position handling, automatic one-on-one centering, and exact lazy six-actor Speed-tie resolution. The local UI uses opposing L-shaped player/enemy formations with one shared top-down player viewpoint, fixed Slots 1–6, range-aware per-slot damage previews, Shift formation previews, and fixed six-sprite node rows. Triple Overlay projection and Live Edit remain disabled until the Overlay owner implements and validates the corresponding presentation contract.

The Generation 5 Rotation extension keeps three deployed Pokémon per side while designating one front Pokémon on each side as the sole ordinary battle participant. Selecting a reserve Pokémon's move declares Rotation's priority-6 rotate-and-move action; it is not a switch, preserves the combatant's attached state, and does not trigger entry, exit, hazard, or switch-reset behavior. Only the front Pokémon participates in ordinary targeting, spread, residual, and proximity-scoped Ability checks, while weather remains global. The local interface reuses the fixed six-card Triple geometry, marks Front and Waiting positions, and stores six sprites in slot order. Rotation Overlay projection and Live Edit fail closed pending an Overlay-owned contract.

The Notes column includes a generated, read-only Trainer AI forecast above the user's per-node editable notes. It executes the Dataset-owned evaluator profiles in the resolver Worker and presents broad player-facing likelihoods from **Very Unlikely** through **Guaranteed**, with equally likely options called out explicitly. **Turn actions** combine moves, trainer items, and voluntary switches through their real phase precedence; **Replacement after a faint** separately forecasts which reserve the Trainer AI will send out. Move explanations expose the incentive ledger: every legal move-target candidate starts at 100, documented AI rules add or remove points, and the highest final score enters the source-defined tie selector. Items and switches retain their actual eligibility, gate, priority, or ranking rules rather than being given invented move scores.

The supported VW2R and Renegade Platinum builds bind canonical PLC moves to exact numeric identities and answer state-backed move, battler, type, status, stage, weather, action, and maximum-damage ranking queries through the shared calculator. In Gen 5 multi-active battles, PLC evaluates the AI's active Pokémon in the Dataset-declared right-to-left pass, carrying consumed trainer-item slots and already-selected switch reservations into each later actor. Exact evaluator fractions remain available internally for validation. When the only missing input is the hidden Gen 4 LCRNG seed, the educational forecast runs a deterministic spread of exact stateful evaluations and converts the resulting weight into a qualitative band; it does not claim to recover the live seed or present a fake precise percentage. Missing commands, action semantics, or required battle state appear as a **Forecast error**, not as ordinary uncertainty.

The private local build can attach read-only to the VW2R Battle Log through a bounded same-origin Launcher proxy. It presents completed observed turns in a fixed Actual lane beside planned nodes, preserves decoded event prose for inspection, and enables **Create Branch from Actual** only when decoded move identities uniquely match one planned state for the same turn. In-progress, insufficient, ambiguous, and unmatched tracker turns remain visible but cannot silently mutate the plan. Starting the tracker while no battle is active baselines old history and waits for the next battle; PLC never writes to the Battle Log, emulator, save, or ROM.
- Optional local Live Edit with one PLC writer, independent Overlay reader attachment, revision concurrency, heartbeats, recovery grace, complete-plan atomic writes, and cleanup after both clients release.

The accepted build also resolves Gen 5 multi-active Trace target branching and maintains explicit current-form identity for Forecast, Flower Gift, and Zen Mode. Weather-driven Castform and Cherrim forms update immediately, Zen Mode evaluates exact HP distributions at its late residual point, and form species, types, stats, and sprites persist through previews, committed nodes, switches, and damage requests. PLC exposes an active Flower Gift side flag to the shared damage request; the Battle Mechanics owner must add that existing engine field to its generated wrapper allowlist before allied Pokémon receive Flower Gift's damage modifier in the shared calculator.

Open the local build through the existing Stream Tools server:

```text
http://127.0.0.1:8000/Web%20Tools/Pokemon%20Line%20Calculator/
```

PLC never publishes merely because a plan is imported, opened, edited, previewed, committed, or updated through Live Edit. Only the Overlay dock's explicit Send Turns action replaces the battle-plan stream projection; Clear Display and Overlay Stop Live Edit clear it.

Every standardized VW2R move is selectable and can enter the Singles, Doubles, Triple, and Rotation resolver. Showdown-backed structured effects include primary and secondary effects, conditional/random power, multi-hit distributions, sleep/freeze/confusion/action branching, delayed attacks and healing, self-KO and crash behavior, called moves, switching, Baton Pass, redirection, guards, order control, and Pledge combinations. The Worker still resolves every materially different candidate, but the UI displays one crafted outcome: hit/miss, Crit, chance-status, KO/survival, and action-time status-check buttons select a compatible candidate, and Next Turn saves only that selection. Hidden sleep/confusion duration is carried as a state distribution and only branches at the affected Pokémon's action check. Calculator previews use Showdown/HZLA's default hit-count convention (three hits for a normal 2–5-hit move, maximum with Skill Link or Grip Claw); committed turns branch over the real Gen 5 hit-count distribution and calculate each selected total independently. Random called-move outcomes that cannot be inferred from battle state remain explicit planner declarations. The engine still fails closed for unsupported cross-interactions in the deliberately bounded ability/item residual and switch-in registries; allied Flower Gift damage pending the Battle Mechanics contract addition, player battle-item actions, traded-Pokémon EXP bonuses without original-trainer data, non-base save-form resolution until Dataset publishes an explicit packed-form identity map, Triple/Rotation Overlay projection, Trainer AI action paths with genuinely missing semantics, and exact observed-state reconstruction beyond uniquely decoded move matching remain expansion work. The core plan, resolver, projection, Boxes library, and file contracts remain game-neutral; each enabled game still requires its own standardized Dataset and planner-readiness contract.

The current technical specification is [BATTLE_PLANNER_SPEC.md](BATTLE_PLANNER_SPEC.md). It remains the authority for the portable plan graph, resolver behavior, Overlay display-selection boundary, and private Live Edit integration.

## Temporary Trainer AI HP assumption

For forecast calculations only, HP ranges use their midpoint rounded down (78–80 becomes 79). The original planner ranges and damage distributions remain unchanged. Both turn and replacement forecasts disclose this assumption; Guaranteed is conditional on assumed HP. This is not a weighted average or a most-likely damage roll. Threshold-aware branching remains deferred for review on September 7, 2026.

## Public build

PLC can be published as a static GitHub Pages project site. The public profile keeps the portable planner, Boxes library, read-only save import, plan import/export, Dataset adapter, Worker, and Singles/Doubles/Triple/Rotation engine and planner UI. It omits the private **Output State**, **Live Edit**, and **Battle Tracker** controls, their loopback integration modules, and all workspace instruction/history files.

The public app stores Boxes and the active draft in the browser's IndexedDB. Imported save bytes are parsed in the browser and are not uploaded by PLC. The local build reads the workspace Pokémon Asset release through `/Datasets/Pokemon%20Assets/release`; the public builder replaces that base with `POKEMON_ASSET_RELEASE_BASE`, which must be an HTTPS URL pinned to an immutable tag or commit. If it is not configured, the public artifact retains a fail-closed placeholder rather than silently calling an upstream sprite host. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Build and verify the deployable `dist` directory with:

```powershell
npm run build:public
npm run test:browser:public
```

The public build now defaults to the deterministic checked-in `public-assets` projection, pinned by its source-index and per-file hashes. Regenerate it only with `node tools/project_public_assets.mjs` from the complete workspace. Local development still uses the authoritative Dataset release. The builder always enables the public presentation even after local controls are restored. An external immutable hosted release can optionally override the bundled base:

```powershell
$env:POKEMON_ASSET_RELEASE_BASE = "https://<host>/<owner>/<asset-repo>/<immutable-release>/release"
npm run build:public
```

The build is allowlist-based, emits a SHA-256 manifest, rejects local control routes and machine paths, and fails if instruction files, saves, ROMs, or local-only integration folders enter the artifact. The Pages workflow separately audits tracked source before deployment. The repository intentionally has no project-wide open-source license yet; third-party licenses are preserved, but reuse of PLC's own source requires an explicit license decision.

## Component boundary

All PLC-specific files stay in this folder. PLC will consume established interfaces instead of becoming a second authority:

`../../Battle Mechanics/` owns the game-neutral shared damage adapter and pinned formula engine. PLC owns a narrow resolver adapter plus critical-hit probability, turn-state branching, and outcome presentation. For standalone use it checks in a manifest-verified generated consumer copy of the required engine files; that copy is not a second authority and is never hand-edited.

- Standardized datasets own game facts and mechanics readiness.
- Save Tracker owns save parsing and provides an optional local pre-battle player-snapshot adapter.
- The standardized Overlay calculator owns the current damage adapter and pinned engine.
- The Stream Tools Launcher owns static serving and bounded loopback operational endpoints.
- Overlay owns plan-file ingest, the read-only display-selection tree, projection production, branch-window renderer, layout, animation, visibility, stable OBS routing, and final stream presentation.

Only narrow integration adapters should live in those owning components. The planner UI, schemas, resolver, cache, portable plan-file code, tests, editable node tree, and optional local live-writer client stay here. PLC never sends data directly to OBS.

Ordinary plan downloads are portable and can be reopened by PLC or imported by Overlay. The local Stream Tools build may additionally expose Begin Live Edit, which maintains an ephemeral plan file through the loopback server for an attached Overlay dock. The published PLC build omits this local-only feature.

## Development workflow

Trainer AI choice locks restrict move candidates without preempting item or switch decisions. Gen 5 recharge is represented as its own forced action. Multi-active selection uses position-aware order, and actually fainted Gen 5 slots share reserve reservations; forecasts for living actors explicitly assume only that actor faints. Gen 5 trapping uses the engine's escape exceptions; Platinum retains its documented naive AI trapping bug, including refusing Flying/Shed Shell escapes. Score reasons describe verified reached branches where available, never a whole program's historical trainer label.

Replay an explicitly supplied private Output State snapshot, read-only, against the current generated evaluator and real damage adapter:

```powershell
node tools/replay_trainer_ai_snapshot.mjs <output-state.json>
```

The replay verifies the input hash after evaluation and reports forecast errors without writing the snapshot or changing the browser draft.

From this folder:

```powershell
npm run check
npm test
npm run check:generated
npm run build:public
npm run test:browser:public
```

Workspace maintainers can additionally validate private loopback integrations and the full local browser workflow:

```powershell
npm run test:workspace
npm run test:browser
npm run check:workspace-dependencies
```

`npm test`, `npm run check:generated`, the public build, and the public browser smoke are standalone. They use checked-in, digest-verified generated copies of the registered game Datasets, Generation 3/4/5 Trainer AI documentation, Battle Mechanics, and Save Mechanics files. `npm run sync:workspace-dependencies` is a workspace-maintainer command that refreshes those allowlisted copies from their owning components; it must not be used to invent or hand-maintain game facts inside PLC.

To reproduce the pinned VW2R move-reference artifact in a development checkout that has the ignored Showdown package fixture available:

```powershell
npm run build:move-reference
npm run check:move-reference
```

The ordinary syntax, portable test, and public-build checks do not depend on that ignored development fixture.

The browser smoke test launches an isolated hidden headless Chromium profile, loads the real local route, verifies game selection, dataset and Worker readiness, creates a Box and Party through Showdown import, and—when an approved save fixture is supplied—verifies the no-sprite seven-PC-Box review step before importing the mandatory party plus one selected PC Box. The save-backed path also verifies that an empty held-item ID remains `None` and that Player Action renders total EXP as `current/next-level threshold`. It then resolves and commits a School Kid Neil Singles turn, checks the horizontal node details and HZLA-style rolls, renders a trainer-derived Doubles workspace, captures desktop/mobile screenshots, and removes its own profile. Save tests verify the fixture hash separately. None of these paths writes the save, generated player JSON, current-game state, Overlay state, or OBS.

The private local build also exposes a testing-only **Output State** button when the custom Stream Tools server advertises its PLC testing-state capability. One click atomically replaces the fixed ignored file `Local Tools/Stream Tools Launcher/.state/plc-testing-state/latest.json`; it never opens a browser save-location prompt. The versioned snapshot contains the active plan, Box library, selected node, incomplete per-slot action drafts and targets, preview state, visible controls, dialogs, viewport, and scroll state needed to reproduce the current PLC screen. It excludes raw save bytes, browser credentials/cookies, Live Edit session and lease identifiers, and Overlay/OBS operational state. This diagnostic snapshot is not a portable plan file and is never sent through Live Edit.

Do not treat a draft specification, direct local page, headless screenshot, or isolated API test as proof of production OBS readiness.

### Trainer AI rule labels

The forecast adapter exposes `actors[].moves[].incentiveLedger.adjustments[].title` as the Dataset-owned 1–3 word rule label, alongside the unchanged `summary` description and stable `reasonCode`. Matching source-branch variants supply their own title/summary pair through the shared evaluator. Presentation may use `title` for a compact label and `summary` for hover/focus details; titles are not unique IDs or executable mechanics. This data contract does not itself replace the current visible descriptions with tooltips.
