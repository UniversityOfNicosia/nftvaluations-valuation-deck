# NFT Valuations Valuation Deck

This project is a Vite + React app. The root `index.html` is a source entrypoint for Vite, so it is not meant to be opened directly from the repository with a double-click.

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

The production-ready site is written to `dist/`. That built `dist/index.html` is the version to publish or open directly from disk.

## GitHub Pages

This repo includes a GitHub Actions workflow at `.github/workflows/deploy-pages.yml` that builds the app and deploys `dist/` to GitHub Pages on pushes to `main`.
