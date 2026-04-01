import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { listCollections, loadCollection } from "./data/loadCollections.ts";
import type {
  Activity,
  CollectionData,
  CollectionSummary,
  NeighborRecord,
  NeighborhoodMode,
  TokenTrait,
  TokenWithNumber,
  ValueMode,
} from "./data/types.ts";
import {
  deriveCombinedTraitMetrics,
  deriveNeighbors,
  getDefaultInspectorActivity,
  getDefaultTraitSelection,
  getRecentActivity,
  getTopCollectionBids,
  getTopTokenBids,
  getVisibleTraits,
  summarizeMarketBand,
} from "./lib/derive.ts";
import {
  formatCompactDate,
  formatDate,
  formatDistance,
  formatPercent,
  formatTokenNumber,
  formatValue,
} from "./lib/formatting.ts";

type RouteState =
  | {
      kind: "home";
    }
  | {
      kind: "collection";
      slug: string;
      params: URLSearchParams;
    };

function parseRoute(): RouteState {
  const hash = window.location.hash.replace(/^#/, "");
  const [pathPart = "/", queryString = ""] = hash.split("?");
  const params = new URLSearchParams(queryString);
  const normalizedPath = pathPart === "" ? "/" : pathPart;
  const collectionMatch = normalizedPath.match(/^\/collections\/([^/]+)$/);
  if (collectionMatch) {
    return { kind: "collection", slug: collectionMatch[1], params };
  }
  return { kind: "home" };
}

function updateRoute(slug: string, params: URLSearchParams) {
  const query = params.toString();
  window.location.hash = `/collections/${slug}${query ? `?${query}` : ""}`;
}

function LandingPage({
  collections,
}: {
  collections: CollectionSummary[];
}) {
  return (
    <main className="landing-shell">
      <div className="hero-panel">
        <p className="eyebrow">Static valuation workbench</p>
        <h1>Repo-local collection decks, with no backend in the loop.</h1>
        <p className="hero-copy">
          Collection discovery is build-time only. Each deck hydrates compact repo JSON,
          keeps price context local, and opens directly into a focused valuation
          workbench.
        </p>
      </div>
      <div className="collection-grid">
        {collections.map((collection) => (
          <button
            key={collection.slug}
            className="collection-card"
            onClick={() =>
              updateRoute(
                collection.slug,
                new URLSearchParams({ token: "239" }),
              )
            }
            type="button"
          >
            <div className="collection-card-head">
              <div>
                <p className="eyebrow">{collection.artist}</p>
                <h2>{collection.title}</h2>
              </div>
              <span className="pill">Open workbench</span>
            </div>
            <div className="collection-card-stats">
              <Metric
                label="Collection floor"
                value={formatValue(
                  collection.floorEth,
                  undefined,
                  collection.ethUsd,
                  "eth-usd",
                )}
              />
              <Metric
                label="Top collection bid"
                value={formatValue(
                  collection.topBidEth,
                  undefined,
                  collection.ethUsd,
                  "eth-usd",
                )}
              />
              <Metric
                label="Snapshot"
                value={formatDate(collection.snapshotTs)}
              />
            </div>
          </button>
        ))}
      </div>
    </main>
  );
}

export function App() {
  const [route, setRoute] = useState<RouteState>(() => parseRoute());
  const [collections] = useState(() => listCollections());

  useEffect(() => {
    const handleHashChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  if (route.kind === "home") {
    return <LandingPage collections={collections} />;
  }

  return (
    <CollectionRoute
      key={route.slug}
      route={route}
      onNavigate={(params) => updateRoute(route.slug, params)}
    />
  );
}

function CollectionRoute({
  route,
  onNavigate,
}: {
  route: Extract<RouteState, { kind: "collection" }>;
  onNavigate: (params: URLSearchParams) => void;
}) {
  const [collection, setCollection] = useState<CollectionData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadCollection(route.slug)
      .then((result) => {
        if (active) {
          setCollection(result);
        }
      })
      .catch((loadError) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Unknown load error");
        }
      });

    return () => {
      active = false;
    };
  }, [route.slug]);

  if (error) {
    return (
      <main className="state-panel">
        <p className="eyebrow">Load error</p>
        <h1>{route.slug}</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (!collection) {
    return (
      <main className="state-panel">
        <p className="eyebrow">Hydrating static deck</p>
        <h1>{route.slug}</h1>
        <p>Loading local JSON, normalizing compact tables, and preparing workbench state.</p>
      </main>
    );
  }

  return <Workbench collection={collection} route={route} onNavigate={onNavigate} />;
}

function Workbench({
  collection,
  route,
  onNavigate,
}: {
  collection: CollectionData;
  route: Extract<RouteState, { kind: "collection" }>;
  onNavigate: (params: URLSearchParams) => void;
}) {
  const initialTokenNumber = Number(route.params.get("token") ?? 239);
  const [valueMode, setValueMode] = useState<ValueMode>("eth-usd");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  const selectedTokenNumber = collection.tokensByNumber.has(initialTokenNumber)
    ? initialTokenNumber
    : collection.tokens[0]?.tokenNumber ?? 0;
  const activeView =
    route.params.get("panel") === "neighborhood" ? "neighborhood" : "timeline";
  const requestedMode = route.params.get("mode");
  const neighborhoodMode: NeighborhoodMode =
    requestedMode === "rarity" ? "rarity" : "trait";
  const selectedToken =
    collection.tokensByNumber.get(selectedTokenNumber) ?? collection.tokens[0];

  useEffect(() => {
    const params = new URLSearchParams(route.params);
    params.set("token", String(selectedToken.tokenNumber));
    if (params.toString() !== route.params.toString()) {
      onNavigate(params);
    }
  }, [onNavigate, route.params, selectedToken.tokenNumber]);

  const filteredTokens = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) {
      return collection.tokens.slice(0, 18);
    }
    return collection.tokens
      .filter((token) => {
        const label = `${token.display_name} ${token.token_id}`.toLowerCase();
        return label.includes(query);
      })
      .slice(0, 18);
  }, [collection.tokens, deferredSearch]);

  return (
    <main className="workbench-shell">
      <header className="workbench-header">
        <div>
          <button className="back-link" onClick={() => (window.location.hash = "/")} type="button">
            Collection index
          </button>
          <p className="eyebrow">{collection.summary.artist}</p>
          <h1>{collection.summary.title} valuation workbench</h1>
        </div>
        <ValueModeToggle valueMode={valueMode} onChange={setValueMode} />
      </header>
      <section className="workbench-grid">
        <TokenWorkbenchPanels
          key={selectedToken.token_id}
          activeView={activeView}
          collection={collection}
          filteredTokens={filteredTokens}
          neighborhoodMode={neighborhoodMode}
          onActiveViewChange={(view) => {
            const params = new URLSearchParams(route.params);
            params.set("panel", view);
            if (view !== "neighborhood") {
              params.delete("mode");
            } else if (!params.get("mode")) {
              params.set("mode", "trait");
            }
            onNavigate(params);
          }}
          onNeighborhoodModeChange={(mode) => {
            const params = new URLSearchParams(route.params);
            params.set("panel", "neighborhood");
            params.set("mode", mode);
            onNavigate(params);
          }}
          onSearchChange={setSearch}
          onSelectToken={(tokenNumber) =>
            startTransition(() => {
              const params = new URLSearchParams(route.params);
              params.set("token", String(tokenNumber));
              onNavigate(params);
            })
          }
          search={search}
          selectedToken={selectedToken}
          valueMode={valueMode}
        />
      </section>
    </main>
  );
}

function TokenWorkbenchPanels({
  activeView,
  collection,
  filteredTokens,
  neighborhoodMode,
  onActiveViewChange,
  onNeighborhoodModeChange,
  onSearchChange,
  onSelectToken,
  search,
  selectedToken,
  valueMode,
}: {
  activeView: "timeline" | "neighborhood";
  collection: CollectionData;
  filteredTokens: TokenWithNumber[];
  neighborhoodMode: NeighborhoodMode;
  onActiveViewChange: (view: "timeline" | "neighborhood") => void;
  onNeighborhoodModeChange: (mode: NeighborhoodMode) => void;
  onSearchChange: (value: string) => void;
  onSelectToken: (tokenNumber: number) => void;
  search: string;
  selectedToken: TokenWithNumber;
  valueMode: ValueMode;
}) {
  const visibleTraits = getVisibleTraits(collection, selectedToken.token_id);
  const recentActivity = getRecentActivity(collection, selectedToken.token_id);
  const tokenBids = getTopTokenBids(collection, selectedToken.token_id);
  const collectionBids = getTopCollectionBids(collection);
  const marketBand = summarizeMarketBand(selectedToken, tokenBids);
  const neighbors = deriveNeighbors(collection, selectedToken, neighborhoodMode);
  const [activeTraits, setActiveTraits] = useState<number[]>(() =>
    getDefaultTraitSelection(visibleTraits),
  );
  const [inspectedActivityId, setInspectedActivityId] = useState<number | undefined>(
    () => getDefaultInspectorActivity(recentActivity)?.activity_id,
  );
  const [inspectedNeighborId, setInspectedNeighborId] = useState<number | undefined>(
    () => neighbors[0]?.token.token_id,
  );
  const combinedTraits = deriveCombinedTraitMetrics(collection, activeTraits);
  const inspectedActivity =
    recentActivity.find((activity) => activity.activity_id === inspectedActivityId) ??
    getDefaultInspectorActivity(recentActivity);
  const inspectedNeighbor =
    neighbors.find((neighbor) => neighbor.token.token_id === inspectedNeighborId) ??
    neighbors[0];

  return (
    <>
      <aside className="panel left-column">
        <section className="token-selector">
          <div className="token-selector-head">
            <div>
              <p className="eyebrow">Token selector</p>
              <h2>{selectedToken.display_name}</h2>
            </div>
            <span className="pill">URL state on</span>
          </div>
          <label className="search-box">
            <span>Jump to token</span>
            <input
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Type #239 or token id"
              value={search}
            />
          </label>
          <div className="token-results">
            {filteredTokens.map((token) => (
              <button
                key={token.token_id}
                className={token.token_id === selectedToken.token_id ? "token-chip active" : "token-chip"}
                onClick={() => onSelectToken(token.tokenNumber)}
                type="button"
              >
                <span>{token.display_name}</span>
                <small>{formatValue(token.current_ask_eth, undefined, collection.metadata.eth_usd, "eth")}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="token-card">
          <TokenFallback token={selectedToken} />
          <div className="market-band">
            <Metric label="Bid" value={formatValue(marketBand.topBidEth, undefined, collection.metadata.eth_usd, valueMode)} />
            <Metric label="Fair" value={formatValue(marketBand.fairEth, undefined, collection.metadata.eth_usd, valueMode)} />
            <Metric label="List" value={formatValue(marketBand.listEth, undefined, collection.metadata.eth_usd, valueMode)} />
          </div>
          <div className="token-summary-grid">
            <Metric label="Adjusted floor" value={formatValue(selectedToken.adjusted_floor_eth, undefined, collection.metadata.eth_usd, valueMode)} />
            <Metric label="Base model" value={formatValue(selectedToken.nfti_v2_base_eth, undefined, collection.metadata.eth_usd, valueMode)} />
            <Metric label="Trim model" value={formatValue(selectedToken.nfti_v2_trim_eth, undefined, collection.metadata.eth_usd, valueMode)} />
            <Metric label="Last sale" value={formatValue(selectedToken.last_single_sale_eth, selectedToken.last_single_sale_usd, collection.metadata.eth_usd, valueMode)} />
            <Metric label="Rarity rank" value={selectedToken.rarity_rank ? `${selectedToken.rarity_rank} / ${collection.tokens.length}` : "N/A"} />
            <Metric label="Minted" value={formatDate(selectedToken.mint_ts)} />
          </div>
        </section>

        <section className="context-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Collection context</p>
              <h2>Live deck anchors</h2>
            </div>
          </div>
          <div className="context-grid">
            <Metric label="Floor" value={formatValue(collection.context.floor_eth, undefined, collection.metadata.eth_usd, valueMode)} />
            <Metric label="Top bid" value={formatValue(collection.context.top_bid_eth, undefined, collection.metadata.eth_usd, valueMode)} />
            <Metric label="Median sale 30d" value={formatValue(collection.context.median_sale_eth_30d, undefined, collection.metadata.eth_usd, valueMode)} />
            <Metric label="Listed %" value={formatPercent(collection.context.listed_pct)} />
            <Metric label="Volume 30d" value={formatValue(collection.context.sale_volume_eth_30d, collection.context.sale_volume_usd_30d, collection.metadata.eth_usd, valueMode)} />
            <Metric label="Floor change 30d" value={formatPercent(collection.context.change_floor_pct_30d)} />
            <Metric label="AF market cap" value={formatValue(collection.context.af_market_cap_eth, undefined, collection.metadata.eth_usd, valueMode)} />
            <Metric label="NFTi market cap" value={formatValue(collection.context.nfti_market_cap_eth, undefined, collection.metadata.eth_usd, valueMode)} />
          </div>
          <p className="footnote">
            AF and NFTi metrics remain contextual only. The workbench does not imply
            hidden weighting as authoritative.
          </p>
        </section>
      </aside>

      <section className="panel center-column">
        <div className="section-head">
          <div>
            <p className="eyebrow">Market evidence</p>
            <h2>Timeline and neighborhood</h2>
          </div>
          <div className="segmented-control">
            <button className={activeView === "timeline" ? "selected" : ""} onClick={() => onActiveViewChange("timeline")} type="button">
              Timeline
            </button>
            <button className={activeView === "neighborhood" ? "selected" : ""} onClick={() => onActiveViewChange("neighborhood")} type="button">
              Neighborhood
            </button>
          </div>
        </div>

        {activeView === "timeline" ? (
          <TimelinePanel
            activities={recentActivity}
            ethUsd={collection.metadata.eth_usd}
            inspectedActivity={inspectedActivity}
            onInspect={(activity) => setInspectedActivityId(activity.activity_id)}
            valueMode={valueMode}
          />
        ) : (
          <NeighborhoodPanel
            ethUsd={collection.metadata.eth_usd}
            inspectedNeighbor={inspectedNeighbor}
            mode={neighborhoodMode}
            neighbors={neighbors}
            onInspect={(neighbor) => setInspectedNeighborId(neighbor.token.token_id)}
            onModeChange={onNeighborhoodModeChange}
            selectedToken={selectedToken}
            valueMode={valueMode}
          />
        )}

        <section className="trait-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Trait support</p>
              <h2>Visible token traits</h2>
            </div>
            <span className="pill muted">Trait bids hidden in v1</span>
          </div>
          <div className="trait-chip-list">
            {visibleTraits.map((trait) => {
              const enabled = activeTraits.includes(trait.property_id);
              return (
                <button
                  key={trait.property_id}
                  className={enabled ? "trait-chip selected" : "trait-chip"}
                  onClick={() =>
                    setActiveTraits((current) =>
                      enabled
                        ? current.filter((propertyId) => propertyId !== trait.property_id)
                        : [...current, trait.property_id],
                    )
                  }
                  type="button"
                >
                  <span>{trait.category_name}: {trait.property_name}</span>
                  <small>{trait.property_token_count} tokens</small>
                </button>
              );
            })}
          </div>
          <div className="trait-grid">
            {visibleTraits.map((trait) => (
              <TraitSupportCard
                key={trait.property_id}
                collection={collection}
                trait={trait}
                valueMode={valueMode}
              />
            ))}
          </div>
          {combinedTraits && activeTraits.length >= 2 ? (
            <div className="combined-trait-card">
              <div>
                <p className="eyebrow">Combined traits</p>
                <h3>{activeTraits.length} selected traits</h3>
              </div>
              {combinedTraits.matchedTokenCount > 0 ? (
                <div className="context-grid">
                  <Metric label="Matching tokens" value={`${combinedTraits.matchedTokenCount} / ${collection.tokens.length}`} />
                  <Metric label="Share" value={formatPercent(combinedTraits.matchedTokenShare)} />
                  <Metric label="Lowest ask" value={formatValue(combinedTraits.floorAskEth, undefined, collection.metadata.eth_usd, valueMode)} />
                  <Metric label="Median prediction" value={formatValue(combinedTraits.medianPredictionEth, undefined, collection.metadata.eth_usd, valueMode)} />
                  <Metric label="Median adj. floor" value={formatValue(combinedTraits.medianAdjustedFloorEth, undefined, collection.metadata.eth_usd, valueMode)} />
                  <Metric label="Median rarity rank" value={combinedTraits.medianRarityRank ? `${Math.round(combinedTraits.medianRarityRank)}` : "N/A"} />
                </div>
              ) : (
                <p className="footnote">
                  No current overlap beyond the selected token. The box still reflects the
                  local intersection result instead of inventing synthetic support.
                </p>
              )}
            </div>
          ) : null}
        </section>
      </section>

      <aside className="panel right-column">
        <section className="inspector-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Inspector</p>
              <h2>{activeView === "timeline" ? "Selected market event" : "Selected neighbor"}</h2>
            </div>
          </div>
          {activeView === "timeline" && inspectedActivity ? (
            <EventInspector
              activity={inspectedActivity}
              ethUsd={collection.metadata.eth_usd}
              valueMode={valueMode}
            />
          ) : null}
          {activeView === "neighborhood" && inspectedNeighbor ? (
            <NeighborInspector
              ethUsd={collection.metadata.eth_usd}
              neighbor={inspectedNeighbor}
              valueMode={valueMode}
            />
          ) : null}
        </section>

        <section className="inspector-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Synthesis</p>
              <h2>Compact decision frame</h2>
            </div>
          </div>
          <ul className="synthesis-list">
            <li>
              Current ask sits at{" "}
              <strong>
                {formatValue(selectedToken.current_ask_eth, undefined, collection.metadata.eth_usd, valueMode)}
              </strong>{" "}
              against a contextual fair band of{" "}
              <strong>
                {formatValue(selectedToken.prediction_eth, undefined, collection.metadata.eth_usd, valueMode)}
              </strong>.
            </li>
            <li>
              Token-specific bid depth is capped at{" "}
              <strong>
                {formatValue(tokenBids[0]?.price_eth, tokenBids[0]?.price_usd, collection.metadata.eth_usd, valueMode)}
              </strong>
              ; collection support sits at{" "}
              <strong>
                {formatValue(collection.context.top_bid_eth, undefined, collection.metadata.eth_usd, valueMode)}
              </strong>.
            </li>
            <li>
              Neighborhood mode is local-only, derived from token traits and rarity. Visual
              and curated comparables stay disabled placeholders until repo-local sources exist.
            </li>
            <li>
              Trait medians and clean sales are informational only. Raw trait bids are present
              in source data but intentionally muted here.
            </li>
          </ul>
        </section>

        <section className="inspector-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Active bids</p>
              <h2>Collection and token support</h2>
            </div>
          </div>
          <BidList bids={tokenBids} ethUsd={collection.metadata.eth_usd} title="Token bids" valueMode={valueMode} />
          <BidList bids={collectionBids} ethUsd={collection.metadata.eth_usd} title="Collection bids" valueMode={valueMode} />
        </section>
      </aside>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ValueModeToggle({
  valueMode,
  onChange,
}: {
  valueMode: ValueMode;
  onChange: (mode: ValueMode) => void;
}) {
  const modes: Array<{ label: string; value: ValueMode }> = [
    { label: "ETH", value: "eth" },
    { label: "USD", value: "usd" },
    { label: "USD + ETH", value: "usd-eth" },
    { label: "ETH + USD", value: "eth-usd" },
  ];

  return (
    <div className="segmented-control wide">
      {modes.map((mode) => (
        <button
          key={mode.value}
          className={mode.value === valueMode ? "selected" : ""}
          onClick={() => onChange(mode.value)}
          type="button"
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}

function TokenFallback({ token }: { token: TokenWithNumber }) {
  const hue = (token.tokenNumber * 29) % 360;
  return (
    <div className="token-fallback" style={{ "--token-hue": `${hue}` } as React.CSSProperties}>
      <svg viewBox="0 0 320 220" aria-hidden="true">
        <defs>
          <linearGradient id={`gradient-${token.token_id}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={`hsl(${hue} 66% 56%)`} />
            <stop offset="100%" stopColor={`hsl(${(hue + 80) % 360} 52% 32%)`} />
          </linearGradient>
        </defs>
        <rect fill={`url(#gradient-${token.token_id})`} height="220" rx="24" width="320" />
        <path
          d={`M20 ${110 + (token.tokenNumber % 27)} C 80 40, 140 180, 300 ${60 + (token.tokenNumber % 80)}`}
          fill="none"
          opacity="0.85"
          stroke="rgba(255,255,255,0.82)"
          strokeWidth="10"
        />
        <path
          d={`M22 ${46 + (token.tokenNumber % 45)} C 120 160, 180 20, 292 ${130 + (token.tokenNumber % 50)}`}
          fill="none"
          opacity="0.48"
          stroke="rgba(16,18,24,0.34)"
          strokeWidth="28"
        />
      </svg>
      <div className="token-fallback-copy">
        <p>{token.display_name}</p>
        <span>Local-only fallback visual • rarity {token.rarity_rank ?? "N/A"}</span>
      </div>
    </div>
  );
}

function TimelinePanel({
  activities,
  ethUsd,
  inspectedActivity,
  onInspect,
  valueMode,
}: {
  activities: Activity[];
  ethUsd: number;
  inspectedActivity?: Activity;
  onInspect: (activity: Activity) => void;
  valueMode: ValueMode;
}) {
  const plotted = activities.filter((activity) => activity.price_eth !== undefined);
  const maxPrice = Math.max(...plotted.map((activity) => activity.price_eth ?? 0), 1);
  const timestamps = plotted.map((activity) => activity.timestamp);
  const minTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : 1;

  return (
    <section className="timeline-card">
      <svg className="timeline-chart" viewBox="0 0 760 250" role="img">
        <line x1="44" x2="44" y1="18" y2="210" className="axis-line" />
        <line x1="44" x2="720" y1="210" y2="210" className="axis-line" />
        {plotted.map((activity) => {
          const x =
            44 +
            ((activity.timestamp - minTimestamp) / Math.max(maxTimestamp - minTimestamp, 1)) *
              676;
          const y = 210 - ((activity.price_eth ?? 0) / maxPrice) * 176;
          const privateMark = activity.is_private || activity.kind.includes("private");
          const selected = inspectedActivity?.activity_id === activity.activity_id;
          return (
            <g key={activity.activity_id}>
              <circle
                className={selected ? "timeline-dot selected" : privateMark ? "timeline-dot private" : "timeline-dot"}
                cx={x}
                cy={y}
                onClick={() => onInspect(activity)}
                r={selected ? 7 : 5}
              />
            </g>
          );
        })}
      </svg>
      <div className="timeline-list">
        {plotted.slice(0, 8).map((activity) => (
          <button
            key={activity.activity_id}
            className={
              inspectedActivity?.activity_id === activity.activity_id
                ? "timeline-row active"
                : "timeline-row"
            }
            onClick={() => onInspect(activity)}
            type="button"
          >
            <span>{activity.kind.replace("_", " ")}</span>
            <strong>{formatValue(activity.price_eth, activity.price_usd, ethUsd, valueMode)}</strong>
            <small>{formatCompactDate(activity.timestamp)}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function NeighborhoodPanel({
  ethUsd,
  inspectedNeighbor,
  mode,
  neighbors,
  onInspect,
  onModeChange,
  selectedToken,
  valueMode,
}: {
  ethUsd: number;
  inspectedNeighbor?: NeighborRecord;
  mode: NeighborhoodMode;
  neighbors: NeighborRecord[];
  onInspect: (neighbor: NeighborRecord) => void;
  onModeChange: (mode: NeighborhoodMode) => void;
  selectedToken: TokenWithNumber;
  valueMode: ValueMode;
}) {
  const modes: Array<{ label: string; value: NeighborhoodMode; disabled?: boolean }> = [
    { label: "Trait", value: "trait" },
    { label: "Rarity", value: "rarity" },
    { label: "Visual", value: "visual", disabled: true },
    { label: "Curated", value: "curated", disabled: true },
  ];

  return (
    <section className="timeline-card">
      <div className="segmented-control wrap">
        {modes.map((entry) => (
          <button
            key={entry.value}
            className={entry.value === mode ? "selected" : ""}
            disabled={entry.disabled}
            onClick={() => !entry.disabled && onModeChange(entry.value)}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>
      <p className="footnote">
        Neighborhoods are computed locally from token records plus token traits only.
        {mode === "trait"
          ? " Trait mode emphasizes shared visible traits."
          : mode === "rarity"
            ? " Rarity mode emphasizes nearby ranks."
            : " Additional modes remain placeholders until stronger local evidence exists."}
      </p>
      <div className="neighbor-list">
        {neighbors.map((neighbor) => (
          <button
            key={neighbor.token.token_id}
            className={
              inspectedNeighbor?.token.token_id === neighbor.token.token_id
                ? "neighbor-row active"
                : "neighbor-row"
            }
            onClick={() => onInspect(neighbor)}
            type="button"
          >
            <div>
              <strong>{neighbor.token.display_name}</strong>
              <small>
                {neighbor.sharedTraitCount} shared traits • rarity gap{" "}
                {formatDistance(neighbor.rarityGap)}
              </small>
            </div>
            <div className="neighbor-metrics">
              <span>{formatValue(neighbor.token.current_ask_eth, undefined, ethUsd, valueMode)}</span>
              <small>
                vs {formatTokenNumber(selectedToken.tokenNumber)}
              </small>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function TraitSupportCard({
  collection,
  trait,
  valueMode,
}: {
  collection: CollectionData;
  trait: TokenTrait;
  valueMode: ValueMode;
}) {
  const support = collection.traitSupportByPropertyId.get(trait.property_id);

  return (
    <article className="trait-support-card">
      <p className="eyebrow">{trait.category_name}</p>
      <h3>{trait.property_name}</h3>
      <div className="context-grid">
        <Metric label="Token count" value={`${trait.property_token_count}`} />
        <Metric label="Share" value={support ? formatPercent(support.token_share_pct) : "N/A"} />
        <Metric label="Ask floor" value={formatValue(support?.ask_floor_eth ?? trait.property_floor_eth, undefined, collection.metadata.eth_usd, valueMode)} />
        <Metric label="Clean sale" value={formatValue(support?.latest_clean_sale_eth ?? trait.property_last_sale_eth, support?.latest_clean_sale_usd ?? trait.property_last_sale_usd, collection.metadata.eth_usd, valueMode)} />
        <Metric label="Median 30d" value={formatValue(support?.median_sale_eth_30d, undefined, collection.metadata.eth_usd, valueMode)} />
        <Metric label="Median 90d" value={formatValue(support?.median_sale_eth_90d, undefined, collection.metadata.eth_usd, valueMode)} />
      </div>
    </article>
  );
}

function EventInspector({
  activity,
  ethUsd,
  valueMode,
}: {
  activity: Activity;
  ethUsd: number;
  valueMode: ValueMode;
}) {
  return (
    <div className="inspector-body">
      <Metric label="Event" value={activity.kind.replace("_", " ")} />
      <Metric label="Timestamp" value={formatDate(activity.timestamp)} />
      <Metric label="Price" value={formatValue(activity.price_eth, activity.price_usd, ethUsd, valueMode)} />
      <Metric label="Private" value={activity.is_private ? "Yes" : "No"} />
      <p className="footnote">
        Listings and listing_private rows are treated as ask-side events. Private rows remain
        visible but distinct.
      </p>
    </div>
  );
}

function NeighborInspector({
  ethUsd,
  neighbor,
  valueMode,
}: {
  ethUsd: number;
  neighbor: NeighborRecord;
  valueMode: ValueMode;
}) {
  return (
    <div className="inspector-body">
      <Metric label="Neighbor" value={neighbor.token.display_name} />
      <Metric label="Ask" value={formatValue(neighbor.token.current_ask_eth, undefined, ethUsd, valueMode)} />
      <Metric label="Prediction" value={formatValue(neighbor.token.prediction_eth, undefined, ethUsd, valueMode)} />
      <Metric label="Rarity gap" value={formatDistance(neighbor.rarityGap)} />
      <p className="footnote">
        {neighbor.sharedTraitNames.length > 0
          ? `Shared traits: ${neighbor.sharedTraitNames.slice(0, 4).join(" • ")}`
          : "Rarity neighborhood is based on locally derived rank proximity."}
      </p>
    </div>
  );
}

function BidList({
  bids,
  ethUsd,
  title,
  valueMode,
}: {
  bids: Array<{ bid_id: string; bidder_address?: string; end_ts?: number; price_eth?: number; price_usd?: number }>;
  ethUsd: number;
  title: string;
  valueMode: ValueMode;
}) {
  return (
    <div className="bid-list">
      <p className="eyebrow">{title}</p>
      {bids.length === 0 ? (
        <p className="footnote">No active bids surfaced from local JSON.</p>
      ) : (
        bids.map((bid) => (
          <div className="bid-row" key={bid.bid_id}>
            <strong>{formatValue(bid.price_eth, bid.price_usd, ethUsd, valueMode)}</strong>
            <small>
              {bid.bidder_address?.slice(0, 6)}…{bid.bidder_address?.slice(-4)} • ends{" "}
              {formatCompactDate(bid.end_ts)}
            </small>
          </div>
        ))
      )}
    </div>
  );
}
