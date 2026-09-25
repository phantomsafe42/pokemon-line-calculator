# @smogon/calc browser vendor

These files use `@smogon/calc` 0.11.0 with local revision
`0.11.0+gen4-metronome.1`. The data bundle is unchanged. The engine is rebuilt
from upstream source with only the Generation 4 repeated-use Metronome modifier:

- `data.production.min.js` — SHA-256 `364be40ea1aec31f413d0036445f717d826ece9c33ec25a02399c3a287c99529`
- `engine.production.min.js` — SHA-256 `be3c7995256f7c3413319ededb1b4fdd36266e5be3b4dccb4a186fb0e1dd07af`

Reproduction: extract upstream commit `264a4ea846a0a0c7724e26c4671ff42e854b5ea1`
from its GitHub source archive, excluding the `calc/LICENSE` and `calc/README.md`
symlinks if Windows cannot create them. Run `npm ci --ignore-scripts` at the
source root and in `calc`, then run the owner tool
`node tools/build_metronome_engine.js <source-root>`. It verifies pinned inputs,
reproduces the original bundle hash before patching, builds the source patch,
asserts the final hash, and restores the input source. `metronome-build.json`
records the archive, build inputs, and both engine hashes. The source package
version remains 0.10.0 at the npm 0.11.0 gitHead; both unmodified output bundles
nevertheless reproduce the npm 0.11.0 distribution byte for byte.

The modifier uses integer `(damage * (10 + repeats)) / 10`, capped at ten repeats,
after critical damage and before random damage. Authority:
[HeartGold DamageCalcDefault](https://github.com/pret/pokeheartgold/blob/0985e8718df4f25e64d6507d89c0c97c0d288981/src/battle/battle_command.c#L766)
and the counter cap in
[battle turn processing](https://github.com/pret/pokeheartgold/blob/0985e8718df4f25e64d6507d89c0c97c0d288981/src/battle/overlay_12_0224E4FC.c#L5164).
Owner tests check all sixteen damage rolls at several counts, the cap, and
critical ordering. Dataset engine identity remains the upstream ABI version;
the local revision is identified by this provenance and consumer content hashes.

Source: <https://www.npmjs.com/package/@smogon/calc/v/0.11.0> and <https://github.com/smogon/damage-calc>.

The upstream engine bundle retains one CommonJS `require("./desc")` reference used only to format long prose descriptions. The Focus renderer supplies a browser-only no-op formatter while loading the bundle, then restores the prior global. Damage calculation and structured results do not use that formatter.

Do not replace these files without updating the pinned engine version in the shared adapter, contract guidance, integrity assertions, license, and calculation tests.
