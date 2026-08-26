# @smogon/calc browser vendor

These files are the browser bundles from the official `@smogon/calc` 0.11.0 npm package:

- `data.production.min.js` — SHA-256 `364be40ea1aec31f413d0036445f717d826ece9c33ec25a02399c3a287c99529`
- `engine.production.min.js` — SHA-256 `e77a129dccf6812dcd299fc79d1f5de8afa77e8eb6de89bca283f468c968e124`

Source: <https://www.npmjs.com/package/@smogon/calc/v/0.11.0> and <https://github.com/smogon/damage-calc>.

The upstream engine bundle retains one CommonJS `require("./desc")` reference used only to format long prose descriptions. The Focus renderer supplies a browser-only no-op formatter while loading the bundle, then restores the prior global. Damage calculation and structured results do not use that formatter.

Do not replace these files without updating the pinned engine version in the shared adapter, contract guidance, integrity assertions, license, and calculation tests.
