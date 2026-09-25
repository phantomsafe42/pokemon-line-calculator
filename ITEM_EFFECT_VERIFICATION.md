# Held item verification

Dataset owns item classifications, declarative activation rules, and pinned reference evidence. Battle Mechanics owns damage formulas and vendor builds. PLC owns state transitions, activation timing, consumption, and probability branches. Showdown is an offline reference, not a browser dependency.

## Classification and scope

The lifecycle distinguishes consumable, breakable, and persistent held effects. Persistent activation retains the item (`consumeOnActivation: false`, method `none`). Declarative conditions select generation, trigger, timing, holder state, and effect; the resolver validates these fields before applying them. Existing engine damage modifiers remain in Battle Mechanics. Items with no battle effect are outside this sweep.

This change covers Generation 3-5 berry/herb activation, damage recovery and recoil, residual effects, contact reactions, gems, flinch items, trapping items, reactive switches, selected transfer restrictions, and passive speed, accuracy, and critical modifiers. Suppression uses generation-specific Klutz, Embargo, Magic Room, Heal Block, Unnerve, and Sheer Force behavior where applicable.

## Evidence

The reference is `pokemon-showdown@0.11.11`, pinned by npm integrity, item source hashes, and a compiled simulator tree digest. The owner scripts resolve inherited Gen 3-5 callbacks, including callbacks nested in item conditions.

| Check | Result |
| --- | --- |
| Shell Bell controlled-damage cases | 62 matched |
| Held-item transition cases | 434 matched |
| Damage cases | 2,719 Showdown matches; 6 cartridge-resolved differences; 1 unrelated baseline difference |
| Speed, accuracy, critical cases | 123 Showdown matches; 9 cartridge-resolved differences |
| Flinch eligibility and transfer policy checks | 2,007 passed |

Transition cases compare HP, item identity, status, boosts, active slot, and selected volatile conditions. A seeded Showdown result must appear among PLC's branches; this alone does not certify every probability. Focus Band, Starf, flinch, repeat-use, trapping, and transfer tests add explicit branch assertions. Damage checks compare all sixteen rolls and include no-item baselines.

Cartridge witnesses independently evaluate integer arithmetic at its source phase: Gen 3 type boosters affect Attack/Special Attack before damage; Gen 4 Expert Belt truncates its modifier; Gen 4 raw speed-halving items bypass item suppression. Exact source URLs and hashes live in Dataset's `cartridge_item_rounding_answers.json`.

Battle Mechanics revision `0.11.0+gen4-metronome.1` adds the missing Gen 4 Metronome multiplier. The untouched source rebuild reproduces both upstream browser hashes before applying the narrow source patch. Owner tests cover sixteen damage rolls, multiple repeat counts, the cap, and critical ordering. The shared request accepts an integer repeat count from 0 through 10.

## Coverage limits

The generated coverage report has 399 resolved generation/item callback records: 356 exercised, 42 outside the public generation-specific inventory, and one requiring additional evidence: Platinum Kaizo Berserk Gene. These are callback records, not 399 distinct items, and exercised does not mean exhaustive certification. Engine-only effects outside that callback inventory and custom hack deviations require their own evidence.

Platinum Kaizo replaces the Shoal Salt slot with a custom Berserk Gene. Its documented immediate Attack effect and extracted item parameters do not prove the held-item activation routine. The retail Gen 2 Showdown rule must not be substituted for that build-specific behavior. It remains unverified.

Additional interaction coverage remains necessary for called/two-turn moves with Metronome, multiple-choice Eject Button presentation, all Mail variants, and drain against Substitute. The ordinary successful repeat/miss sequence is tested; that does not certify every move-calling state transition. One damage discrepancy also exists without an item and is recorded separately in the damage results rather than counted as an item match.

## Reproduce

In Dataset, set `SHOWDOWN_REFERENCE_ROOT` to the pinned installed package and run `npm run check:items`, `npm run check:items:reference`, and `npm run check:items:sweep`. Run the standardized Dataset validator as well. Only owner exporters may regenerate consumer item data.

In PLC, set `PLC_ITEM_REFERENCE_ROOT` to the Dataset checkout's `tools/imports/item-battle-mechanics` directory. Run `npm run check:items:reference`, `npm run check:items:sweep`, `npm run check`, `npm run check:generated`, and `npm test`. The sweep writes `.codex-tmp/item-effect-coverage.json` plus detailed mismatch reports. The Shell Bell check does not overwrite the complete coverage inventory.

Run Battle Mechanics `npm run check` and `npm test`. Its vendor README records the source-built engine procedure and hashes. The local PLC projection was exported from an isolated owner snapshot to exclude unrelated pending owner changes; it is not a projection of every current owner file.

These are local concern-branch candidates. Immutable dependency locks, test-build activation, publication, and runtime readback remain separate steps. The public browser smoke proves the built application loads; its hosted Dataset route does not establish runtime activation of these local Dataset changes.

