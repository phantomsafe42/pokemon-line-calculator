# Pokemon Line Calculator maintenance

Pokemon Line Calculator is a static, local-first browser tool for building,
calculating, branching, saving, and reopening turn-by-turn Pokemon battle
plans. The public application stores its draft and Boxes library in browser
IndexedDB. Imported save bytes are parsed in the browser and are not uploaded
by PLC.

## Source and generated boundaries

PLC owns its portable plan contracts, browser interface, resolver, cache,
tests, and narrow consumer adapters. It does not own Pokemon game facts,
Trainer AI authority, or the shared damage engine.

- `src/generated/datasets` and `src/generated/trainer-ai` are disposable,
  manifest-verified projections owned by the private Pokemon Datasets release.
- `src/generated/battle-mechanics` is a disposable, manifest-verified
  projection owned by Battle Mechanics.
- `src/generated/save-mechanics` is a disposable, manifest-verified parser
  projection owned by Save Mechanics.
- `public-assets` is a deterministic, hash-pinned public asset projection.

Never hand-edit a generated projection. Make authoritative corrections in its
owning component, then run the owning export through PLC's dependency sync.

## Dataset release lock

`dataset-lock.json` pins an immutable Dataset tag, full commit, public artifact
hash, and export profile. A public PLC branch must use the Dataset-owned
`plc-public` profile. The complete `plc` profile is reserved for private
integration branches and must not be copied selectively into a public build.

From a complete Streaming Tools workspace:

```powershell
npm run sync:workspace-dependencies
npm run check:workspace-dependencies
```

The sync verifies the Dataset tag, commit ancestry, artifact digest, clean
allowlisted inputs, and every generated manifest. It also runs the
Battle-Mechanics-owned projection matching the locked Dataset profile.

## Validation

Use Node.js 20 or newer. From this repository:

```powershell
npm run check
npm test
npm run check:generated
npm run check:workspace-dependencies
npm run check:publication
npm run build:public
npm run test:browser:public
```

`npm test` is the portable logic suite. `check:generated` validates the hashes
and inventories of checked-in compatibility projections. The public builder is
allowlist-based and rejects local paths, private integrations, instructions,
saves, ROMs, and unexpected files. The browser smoke uses an isolated headless
profile and does not write saves or workspace operational state.

## Publication boundary

The repository has no project-wide open-source license. Third-party notices
and licenses must remain intact. Keep unpublished datasets, engines, local
control routes, machine paths, credentials, saves, ROMs, instruction files,
and workspace history out of tracked public source and deployment artifacts.

The intentionally minimal `README.md` is release content and remains `TBD`
until a separate public documentation decision replaces it.
