# PlantUML browser engine assets

The JavaScript files and upstream license in this directory are generated from
the installed `@plantuml/core` package by
`scripts/prepare-plantuml-assets.mjs`. They are intentionally not committed.

- Upstream: https://github.com/plantuml/plantuml
- Package: https://www.npmjs.com/package/@plantuml/core
- License after generation: see `LICENSE` in this directory

The generated files are served as same-origin static assets so the large TeaVM
and Graphviz bundles are not reprocessed by the application server build.

The preparation script applies a small safety-limit patch that reads
`globalThis.__PLANTUML_VIEWER_LIMIT__`, defaulting to 8192 pixels. The viewer
only offers a larger, user-selected value after an oversized-diagram error and
keeps its own 32768-pixel browser safety cap.
