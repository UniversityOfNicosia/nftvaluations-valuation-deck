Fidenza collection 90 extract
Notes:
- Object files omit null-valued keys.
- Heavy files use compact columnar payloads with `columns` and `rows`.
- `activities.json` excludes bundle rows (`is_bundle = 1`).
- Token valuation history is split into one compact JSON file per token under `token_snapshots/`.
- OpenSea raw responses are cached under `_cache/opensea/`.
