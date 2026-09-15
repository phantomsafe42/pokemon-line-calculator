# Third-party notices

Pokémon Line Calculator includes or derives data from the following third-party projects.

## Pokémon Showdown

The generated VW2R move-semantics reference was derived from `pokemon-showdown@0.11.11`. Pokémon Showdown is licensed under the MIT License. Its license is reproduced in `third_party/pokemon-showdown-0.11.11/LICENSE`.

PLC resolves Pokémon images through the workspace's versioned Pokémon Asset Dataset. Source-specific sprite provenance, redistribution review, and release metadata live with that Dataset rather than in PLC.

The public build uses the selector-only Pokémon Asset Gateway at
<https://assets.phantomsafe.tv> and pins immutable Dataset release
`0.7.0-dev.2` (tag `v0.7.0-dev.2`, release commit
`44c778913a42c3752061cb073f000682edff4f9b`). It requests individual display
assets by typed identity and does not include the private release inventory,
raw object paths, ROM bytes, or save bytes. The release's machine-readable
credits contract is available at
<https://assets.phantomsafe.tv/v1/releases/0.7.0-dev.2/credits>.

Artwork sources include the Smogon Sprite Project (https://github.com/smogon/sprites),
PokeAPI sprites (https://github.com/PokeAPI/sprites), the DS64 normalized snapshot
(https://github.com/DrPrettyman/PokemonSprites-64x64DSStyle), and the
pokeemerald-expansion contributors (https://github.com/rh-hideout/pokeemerald-expansion).
Type and status icons originate from Bulbapedia and Bulbagarden Archives.
Their copyright policies are https://bulbapedia.bulbagarden.net/wiki/Bulbapedia:Copyrights
and https://archives.bulbagarden.net/wiki/Archives:Copyrights.

Publication review, September 14, 2026: the project owner approved publication
and redistribution of this immutable release for PhantomSafe-owned tools that
are free to access. The decision is noncommercial, requires attribution and
provenance, and is not represented as a license from Nintendo, Creatures,
GAME FREAK, The Pokémon Company, community artists, archive hosts, ROM-hack
authors, or another third party. Underlying art remains owned by its respective
rightsholders, and the shared source repository and object store remain private.

Source: <https://github.com/smogon/pokemon-showdown>

## @smogon/calc

The browser damage engine is copied from `@smogon/calc@0.11.0` through the workspace's shared Battle Mechanics component. The copied bundle, provenance note, and MIT license are located under `src/generated/battle-mechanics/vendor/smogon-calc-0.11.0/`.

Source: <https://github.com/smogon/damage-calc>

## Pokémon and game data

Pokémon and related names are trademarks of Nintendo, Creatures Inc., and GAME FREAK Inc. This fan-made planning tool is not affiliated with or endorsed by those companies.
