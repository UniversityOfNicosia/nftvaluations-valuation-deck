# Follow-up Notes

- The collection loader discovers top-level `*/metadata.json` files and also tolerates a future `*/data/*.json` layout, but it still assumes the collection folder itself remains the slug root.
- Token imagery is intentionally local-only in v1. Since the repo has no token image assets, the workbench uses a deterministic fallback visual instead of fetching remote media.
- The workbench now also accepts optional `panel` and `mode` hash-query params for shareable state in addition to the required `token` param. That extra URL state was added to make the neighborhood view deterministic for review and screenshots.
- Bundle size is large because the site intentionally hydrates repo-local JSON with no runtime API calls. If more collections are added, the next practical optimization is a build-time summarization/codegen step rather than more client-side fetch logic.
- Trait bids remain hidden by default even though they exist in raw data. If v2 surfaces them, it should do so behind a stricter usefulness filter than simple presence.
