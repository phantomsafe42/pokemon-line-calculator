# Third-party notices

Pokémon Line Calculator includes or derives data from the following third-party projects.

## Pokémon Showdown

The generated VW2R move-semantics reference was derived from `pokemon-showdown@0.11.11`. Pokémon Showdown is licensed under the MIT License. Its license is reproduced in `third_party/pokemon-showdown-0.11.11/LICENSE`.

PLC resolves Pokémon images through the workspace's versioned Pokémon Asset Dataset. Source-specific sprite provenance, redistribution review, and release metadata live with that Dataset rather than in PLC.

The public build contains a deterministic projection of Dataset release 0.4.0-dev.1,
not a separately maintained asset library. `public-assets/projection.json` records
the source root-index and provenance-manifest hashes and every projected file digest.
Only Gen 5 animated/static, pixel fallback, and UI icon collections are included;
3D and ROM-derived Seaglass profiles are excluded. No ROM or save bytes are included.

Artwork sources include the Smogon Sprite Project (https://github.com/smogon/sprites),
PokeAPI sprites (https://github.com/PokeAPI/sprites), the DS64 normalized snapshot
(https://github.com/DrPrettyman/PokemonSprites-64x64DSStyle), and the
pokeemerald-expansion contributors (https://github.com/rh-hideout/pokeemerald-expansion).
Type and status icons originate from Bulbapedia and Bulbagarden Archives.
Their copyright policies are https://bulbapedia.bulbagarden.net/wiki/Bulbapedia:Copyrights
and https://archives.bulbagarden.net/wiki/Archives:Copyrights.

Publication review, September 5, 2026: repository availability and code licenses
do not establish blanket artwork redistribution rights. Underlying Pokemon art
and contributor artwork remain owned by their respective rights holders; this
fan-tool release does not relicense them or claim rights-holder endorsement.
The project owner authorized proceeding with the public PLC release after the
asset-publication limitation was disclosed. The shared asset repository remains
private; this authorization is not represented as a license from the rights holders.

Source: <https://github.com/smogon/pokemon-showdown>

## @smogon/calc

The browser damage engine is copied from `@smogon/calc@0.11.0` through the workspace's shared Battle Mechanics component. The copied bundle, provenance note, and MIT license are located under `src/generated/battle-mechanics/vendor/smogon-calc-0.11.0/`.

Source: <https://github.com/smogon/damage-calc>

## Pokémon and game data

Pokémon and related names are trademarks of Nintendo, Creatures Inc., and GAME FREAK Inc. This fan-made planning tool is not affiliated with or endorsed by those companies.
