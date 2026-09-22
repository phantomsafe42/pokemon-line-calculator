# Pokemon Line Calculator versions

The current public PLC build is **0.6.0**. Product versions use `x.y.z`:

- `x` marks a new build generation. The fully distributed build will start at `1.0.0` when its owner approves that milestone.
- `y` marks a major content addition and resets `z` to zero.
- `z` marks a patch to the current content build.

The following commits are the milestones used to establish the current version. They are historical markers, not retroactively created release tags.

| Version milestone | Content | Commit |
| --- | --- | --- |
| 0.1.0 | Initial public release | `db3af9d` |
| 0.2.0 | New battle formats | `30c0692` |
| 0.3.0 | Game additions and AI Forecast | `b504c22` |
| 0.4.0 | Vanilla game additions | `9574c5d` |
| 0.5.0 | Sandbox mode | `73d915e` |
| 0.6.0 | Visual overhaul | `456b3a4` |

The owner designated the current public baseline as `0.6.0`, including the subsequent visual patch already on `main`. Future public pushes should update the package version and lock together, and the generated public-build manifest records that product version. PLC product versions are independent of Dataset and Pokemon Assets release versions and of plan-file schema versions. A version number alone does not authorize a push or tag; publication follows the repository's release workflow.
