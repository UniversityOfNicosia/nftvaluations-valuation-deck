# NFT Valuations Valuation Deck

This project is a Vite + React app. The root `index.html` is still the Vite source entrypoint for local development, but the repo also keeps a committed `docs/` snapshot so GitHub Pages can recover even if it is pointed at the repo contents instead of the Actions artifact.

## Run locally

```bash
npm install
npm run dev
```

Vite will serve the app locally and transform `src/main.tsx` for the browser.

## Build a static site

```bash
npm run build
```

The production-ready site is written to `dist/`. That built `dist/index.html` is the version to preview locally.

## Refresh the committed Pages fallback

```bash
npm run build:docs
```

This rebuilds the app and copies the production output into `docs/`, which is the committed fallback snapshot for GitHub Pages. If you change shipped UI code, styles, routing, or data loading, refresh `docs/` and commit it too.

## Optional trait row annotations

If you want the trait table to use explicit row coloring and driver tiers, add an optional `trait_annotations.json` file inside a collection folder:

- `<collection-slug>/trait_annotations.json`
- or `<collection-slug>/data/trait_annotations.json`

The app reads it if present and falls back gracefully if it is missing.

Schema:

```json
{
  "version": 1,
  "traits": [
    {
      "property_id": 1234,
      "class": "Positive",
      "driver_tier": "Major",
      "note": "Optional free-text note"
    }
  ]
}
```

Supported values:

- `class`: `Positive`, `Neutral`, `Grail`, `Negative`
- `driver_tier`: `Major`, `Supporting`, `Not`

Current UI behavior:

- `class` controls the row tint
- `Supporting` rows are hidden by default until the user expands the table
- `Major` rows are preferred for the initial checked rows
- `Not` rows remain visible but are not prioritized

`property_id` must match the IDs already present in `token_traits.json` and `trait_support.json`.

## GitHub Pages

This repo includes:

- `.github/workflows/verify-docs-snapshot.yml` to fail PR CI when committed `docs/` is stale
- a small guard in `index.html` that redirects GitHub Pages traffic from the raw repo root to `docs/` if Pages is ever misconfigured to serve the source tree again

GitHub Pages should be configured to deploy from the `main` branch using the `/docs` folder. With that setup, the committed `docs/` snapshot is the deployed site and GitHub's built-in Pages workflow is the only deployment run you should see after pushes to `main`.
