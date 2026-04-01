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

## GitHub Pages

This repo includes:

- `.github/workflows/deploy-pages.yml` to build and deploy the Pages artifact from `docs/`
- `.github/workflows/verify-docs-snapshot.yml` to fail CI when committed `docs/` is stale
- a small guard in `index.html` that redirects GitHub Pages traffic from the raw repo root to `docs/` if Pages is ever misconfigured to serve the source tree again

The preferred Pages source is still `GitHub Actions`, but the repo-level fallback keeps the site from going blank if that setting drifts.
