# Repo Notes

- This repository is a Vite app, but GitHub Pages has already served the raw repo root in the past. Keep the fallback path intact.
- `index.html` is the Vite source entrypoint. Do not remove the inline GitHub Pages redirect guard or the `data-source-entry` attribute on the module script.
- `docs/` is the committed static fallback snapshot. Any change that affects the shipped UI, styles, routing, or data loading must be followed by `npm run build:docs`, and the updated `docs/` output must be committed.
- Optional per-collection `trait_annotations.json` files can drive trait row coloring and driver tiers. Keep them alongside the collection JSON (`<slug>/trait_annotations.json` or `<slug>/data/trait_annotations.json`) and use `property_id` values that already exist in the collection trait data.
- GitHub Pages should deploy from `main` `/docs`. `verify-docs-snapshot.yml` fails if `docs/` is stale. Treat a stale `docs/` diff as a release blocker.
- Preferred local verification: `npm test` and `npm run build:docs`.
