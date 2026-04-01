import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { CSSProperties } from "react";
import {
  calculateMedian,
  listCollections,
  loadCollection,
} from "./data/loadCollections.ts";
import type {
  Activity,
  CollectionData,
  CollectionSummary,
  NeighborRecord,
  NeighborhoodMode,
  TokenWithNumber,
  ValueMode,
} from "./data/types.ts";
import {
  deriveCombinedTraitMetrics,
  deriveNeighbors,
  getDefaultTraitSelection,
  getTokenActivityHistory,
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
  formatRelativeAge,
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

type TimelineScope = "token" | "neighborhood" | "aggregate";
type TimelineRange = "1m" | "3m" | "1y" | "all";
type NeighborhoodSizeOption = 10 | 20 | 50 | 100 | "max";
type TimelineAggregateBucket = {
  bucketId: string;
  kind: "aggregate";
  timestamp: number;
  startTimestamp: number;
  endTimestamp: number;
  medianPriceEth?: number;
  eventCount: number;
  saleCount: number;
  listingCount: number;
  privateCount: number;
  tokenCount: number;
};
type TimelineEntry = Activity | TimelineAggregateBucket;

const timelineScopeOptions: Array<{ label: string; value: TimelineScope }> = [
  { label: "Token only", value: "token" },
  { label: "Token + neighborhood", value: "neighborhood" },
  { label: "Aggregate lane", value: "aggregate" },
];
const timelineRangeOptions: Array<{ label: string; value: TimelineRange }> = [
  { label: "1m", value: "1m" },
  { label: "3m", value: "3m" },
  { label: "1y", value: "1y" },
  { label: "All", value: "all" },
];
const neighborhoodSizeOptions: NeighborhoodSizeOption[] = [10, 20, 50, 100, "max"];
const traitPreviewCount = 6;

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

function getReferenceTimestamp(collection: CollectionData) {
  return Math.max(
    collection.activities[0]?.timestamp ?? 0,
    collection.snapshots[collection.snapshots.length - 1]?.timestamp ?? 0,
  );
}

function getTimelineCutoff(referenceTimestamp: number, range: TimelineRange) {
  const day = 24 * 60 * 60;
  switch (range) {
    case "1m":
      return referenceTimestamp - 30 * day;
    case "3m":
      return referenceTimestamp - 90 * day;
    case "1y":
      return referenceTimestamp - 365 * day;
    case "all":
    default:
      return 0;
  }
}

function filterTimelineActivities(activities: Activity[], cutoffTimestamp: number) {
  return activities.filter(
    (activity) =>
      activity.kind !== "mint" &&
      activity.price_eth !== undefined &&
      activity.timestamp >= cutoffTimestamp,
  );
}

function buildAggregateTimeline(
  activities: Activity[],
  cutoffTimestamp: number,
  range: TimelineRange,
) {
  const filtered = filterTimelineActivities(activities, cutoffTimestamp);
  if (filtered.length === 0) {
    return [];
  }

  const newestTimestamp = filtered[0]?.timestamp ?? cutoffTimestamp;
  const minimumBucketSize =
    range === "1m"
      ? 5 * 24 * 60 * 60
      : range === "3m"
        ? 12 * 24 * 60 * 60
        : range === "1y"
          ? 30 * 24 * 60 * 60
          : 60 * 24 * 60 * 60;
  const targetBucketCount =
    range === "1m" ? 6 : range === "3m" ? 8 : range === "1y" ? 12 : 16;
  const span = Math.max(newestTimestamp - cutoffTimestamp, minimumBucketSize);
  const bucketSize = Math.max(Math.ceil(span / targetBucketCount), minimumBucketSize);
  const buckets = new Map<number, Activity[]>();

  filtered.forEach((activity) => {
    const bucketIndex = Math.max(
      0,
      Math.floor((newestTimestamp - activity.timestamp) / bucketSize),
    );
    const existing = buckets.get(bucketIndex) ?? [];
    existing.push(activity);
    buckets.set(bucketIndex, existing);
  });

  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([bucketIndex, bucketActivities]) => {
      const timestamps = bucketActivities.map((activity) => activity.timestamp);
      return {
        bucketId: `aggregate-${bucketIndex}`,
        kind: "aggregate" as const,
        timestamp: Math.max(...timestamps),
        startTimestamp: Math.min(...timestamps),
        endTimestamp: Math.max(...timestamps),
        medianPriceEth: calculateMedian(
          bucketActivities.map((activity) => activity.price_eth),
        ),
        eventCount: bucketActivities.length,
        saleCount: bucketActivities.filter((activity) => activity.kind.includes("sale")).length,
        listingCount: bucketActivities.filter((activity) =>
          activity.kind.includes("listing"),
        ).length,
        privateCount: bucketActivities.filter(
          (activity) => activity.is_private || activity.kind.includes("private"),
        ).length,
        tokenCount: new Set(bucketActivities.map((activity) => activity.token_id)).size,
      };
    })
    .sort((left, right) => right.timestamp - left.timestamp);
}

function isAggregateTimelineEntry(
  entry: TimelineEntry | undefined,
): entry is TimelineAggregateBucket {
  return entry !== undefined && "bucketId" in entry;
}

function getTimelineEntryKey(entry: TimelineEntry) {
  return isAggregateTimelineEntry(entry) ? entry.bucketId : `activity-${entry.activity_id}`;
}

function getTimelineEntryValue(entry: TimelineEntry) {
  return isAggregateTimelineEntry(entry) ? entry.medianPriceEth ?? 0 : entry.price_eth ?? 0;
}

function describePath(points: Array<{ x: number; y: number }>) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
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
  const tokenBids = getTopTokenBids(collection, selectedToken.token_id);
  const collectionBids = getTopCollectionBids(collection);
  const marketBand = summarizeMarketBand(selectedToken, tokenBids);
  const referenceTimestamp = getReferenceTimestamp(collection);
  const allTokenActivity = getTokenActivityHistory(collection, selectedToken.token_id);
  const [timelineScope, setTimelineScope] = useState<TimelineScope>("token");
  const [timelineRange, setTimelineRange] = useState<TimelineRange>("1y");
  const [neighborhoodSize, setNeighborhoodSize] = useState<NeighborhoodSizeOption>(50);
  const [showAllTraits, setShowAllTraits] = useState(false);
  const [activeTraits, setActiveTraits] = useState<number[]>(() =>
    getDefaultTraitSelection(visibleTraits),
  );
  const [inspectedTimelineKey, setInspectedTimelineKey] = useState<string | undefined>();
  const allNeighbors = deriveNeighbors(collection, selectedToken, neighborhoodMode);
  const visibleNeighbors = useMemo(() => {
    if (neighborhoodSize === "max") {
      return allNeighbors;
    }
    return allNeighbors.slice(0, neighborhoodSize);
  }, [allNeighbors, neighborhoodSize]);
  const [inspectedNeighborId, setInspectedNeighborId] = useState<number | undefined>(
    () => visibleNeighbors[0]?.token.token_id,
  );
  const combinedTraits = deriveCombinedTraitMetrics(collection, activeTraits);
  const selectedTraitRows = visibleTraits.filter((trait) =>
    activeTraits.includes(trait.property_id),
  );
  const timelineData = useMemo(() => {
    const cutoffTimestamp = getTimelineCutoff(referenceTimestamp, timelineRange);
    const tokenActivities = filterTimelineActivities(allTokenActivity, cutoffTimestamp);
    const neighborhoodTokenIds = new Set([
      selectedToken.token_id,
      ...visibleNeighbors.map((neighbor) => neighbor.token.token_id),
    ]);
    const neighborhoodActivities = filterTimelineActivities(
      collection.activities.filter((activity) => neighborhoodTokenIds.has(activity.token_id)),
      cutoffTimestamp,
    );
    const aggregateEntries = buildAggregateTimeline(
      collection.activities,
      cutoffTimestamp,
      timelineRange,
    );
    const collectionActivities = filterTimelineActivities(collection.activities, cutoffTimestamp);
    const entries: TimelineEntry[] =
      timelineScope === "token"
        ? tokenActivities
        : timelineScope === "neighborhood"
          ? neighborhoodActivities
          : aggregateEntries;
    const legendSource =
      timelineScope === "token"
        ? tokenActivities
        : timelineScope === "neighborhood"
          ? neighborhoodActivities
          : collectionActivities;

    return {
      entries,
      legend: {
        total: legendSource.length,
        saleCount: legendSource.filter((activity) => activity.kind.includes("sale")).length,
        listingCount: legendSource.filter((activity) =>
          activity.kind.includes("listing"),
        ).length,
        privateCount: legendSource.filter(
          (activity) => activity.is_private || activity.kind.includes("private"),
        ).length,
        tokenCount: new Set(legendSource.map((activity) => activity.token_id)).size,
      },
    };
  }, [
    allTokenActivity,
    collection.activities,
    referenceTimestamp,
    selectedToken.token_id,
    timelineRange,
    timelineScope,
    visibleNeighbors,
  ]);
  const inspectedTimelineEntry =
    timelineData.entries.find((entry) => getTimelineEntryKey(entry) === inspectedTimelineKey) ??
    timelineData.entries[0];
  const inspectedNeighbor =
    visibleNeighbors.find((neighbor) => neighbor.token.token_id === inspectedNeighborId) ??
    visibleNeighbors[0];
  const matchingNeighborhoodTokens = useMemo(() => {
    const visibleNeighborNumbers = new Set(
      visibleNeighbors.map((neighbor) => neighbor.token.tokenNumber),
    );
    return (combinedTraits?.matchedTokenNumbers ?? []).filter((tokenNumber) =>
      visibleNeighborNumbers.has(tokenNumber),
    );
  }, [combinedTraits, visibleNeighbors]);

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
                <small>
                  {formatValue(
                    token.current_ask_eth,
                    undefined,
                    collection.metadata.eth_usd,
                    "eth",
                  )}
                </small>
              </button>
            ))}
          </div>
        </section>

        <section className="token-card">
          <TokenFallback token={selectedToken} />
          <div className="market-band">
            <Metric
              label="Bid"
              value={formatValue(
                marketBand.topBidEth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric
              label="Fair"
              value={formatValue(
                marketBand.fairEth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric
              label="List"
              value={formatValue(
                marketBand.listEth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
          </div>
          <div className="token-summary-grid">
            <Metric
              label="Adjusted floor"
              value={formatValue(
                selectedToken.adjusted_floor_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric
              label="Base model"
              value={formatValue(
                selectedToken.nfti_v2_base_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric
              label="Trim model"
              value={formatValue(
                selectedToken.nfti_v2_trim_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric
              label="Last sale"
              value={formatValue(
                selectedToken.last_single_sale_eth,
                selectedToken.last_single_sale_usd,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric
              label="Rarity rank"
              value={
                selectedToken.rarity_rank
                  ? `${selectedToken.rarity_rank} / ${collection.tokens.length}`
                  : "N/A"
              }
            />
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
            <Metric
              label="Floor"
              value={formatValue(
                collection.context.floor_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric
              label="Top bid"
              value={formatValue(
                collection.context.top_bid_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric
              label="Median sale 30d"
              value={formatValue(
                collection.context.median_sale_eth_30d,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric label="Listed %" value={formatPercent(collection.context.listed_pct)} />
            <Metric
              label="Volume 30d"
              value={formatValue(
                collection.context.sale_volume_eth_30d,
                collection.context.sale_volume_usd_30d,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric
              label="Floor change 30d"
              value={formatPercent(collection.context.change_floor_pct_30d)}
            />
            <Metric
              label="AF market cap"
              value={formatValue(
                collection.context.af_market_cap_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <Metric
              label="NFTi market cap"
              value={formatValue(
                collection.context.nfti_market_cap_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
          </div>
          <CollectionRegimeCard
            collection={collection}
            referenceTimestamp={referenceTimestamp}
            valueMode={valueMode}
          />
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
            collection={collection}
            entries={timelineData.entries}
            ethUsd={collection.metadata.eth_usd}
            inspectedEntry={inspectedTimelineEntry}
            legend={timelineData.legend}
            neighborhoodShownCount={visibleNeighbors.length}
            onInspect={(entry) => setInspectedTimelineKey(getTimelineEntryKey(entry))}
            onRangeChange={setTimelineRange}
            onScopeChange={setTimelineScope}
            range={timelineRange}
            scope={timelineScope}
            valueMode={valueMode}
          />
        ) : (
          <NeighborhoodPanel
            ethUsd={collection.metadata.eth_usd}
            inspectedNeighbor={inspectedNeighbor}
            mode={neighborhoodMode}
            neighbors={visibleNeighbors}
            onInspect={(neighbor) => setInspectedNeighborId(neighbor.token.token_id)}
            onModeChange={onNeighborhoodModeChange}
            onSizeChange={setNeighborhoodSize}
            selectedToken={selectedToken}
            shownCount={visibleNeighbors.length}
            size={neighborhoodSize}
            totalCount={allNeighbors.length}
            valueMode={valueMode}
          />
        )}

        <section className="trait-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Trait support</p>
              <h2>Trait row support</h2>
            </div>
            <span className="pill muted">Trait bids hidden in v1</span>
          </div>
          <div className="trait-table">
            <div className="trait-table-head">
              <span>Select</span>
              <span>Trait</span>
              <span>Support</span>
              <span>Ask floor</span>
              <span>Latest clean sale</span>
              <span>Median 30d</span>
            </div>
            {(showAllTraits ? visibleTraits : visibleTraits.slice(0, traitPreviewCount)).map(
              (trait) => {
                const enabled = activeTraits.includes(trait.property_id);
                const support = collection.traitSupportByPropertyId.get(trait.property_id);
                return (
                  <button
                    key={trait.property_id}
                    aria-pressed={enabled}
                    className={enabled ? "trait-table-row selected" : "trait-table-row"}
                    onClick={() =>
                      setActiveTraits((current) =>
                        enabled
                          ? current.filter((propertyId) => propertyId !== trait.property_id)
                          : [...current, trait.property_id],
                      )
                    }
                    type="button"
                  >
                    <span className="trait-check">{enabled ? "x" : ""}</span>
                    <span className="trait-copy">
                      <strong>{trait.category_name}: {trait.property_name}</strong>
                      <small>{trait.property_token_count} matching tokens</small>
                    </span>
                    <span>{formatPercent(support?.token_share_pct)}</span>
                    <span>
                      {formatValue(
                        support?.ask_floor_eth ?? trait.property_floor_eth,
                        undefined,
                        collection.metadata.eth_usd,
                        valueMode,
                      )}
                    </span>
                    <span>
                      {formatValue(
                        support?.latest_clean_sale_eth ?? trait.property_last_sale_eth,
                        support?.latest_clean_sale_usd ?? trait.property_last_sale_usd,
                        collection.metadata.eth_usd,
                        valueMode,
                      )}
                    </span>
                    <span>
                      {formatValue(
                        support?.median_sale_eth_30d,
                        undefined,
                        collection.metadata.eth_usd,
                        valueMode,
                      )}
                    </span>
                  </button>
                );
              },
            )}
          </div>
          <div className="trait-actions">
            {visibleTraits.length > traitPreviewCount ? (
              <button
                className="secondary-button"
                onClick={() => setShowAllTraits((current) => !current)}
                type="button"
              >
                {showAllTraits
                  ? "Show fewer traits"
                  : `Show all ${visibleTraits.length} traits`}
              </button>
            ) : null}
            <span className="pill muted">
              {activeTraits.length} selected row{activeTraits.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="combined-trait-card">
            <div className="section-head">
              <div>
                <p className="eyebrow">Combined traits</p>
                <h3>
                  {activeTraits.length >= 2
                    ? `${activeTraits.length} selected traits`
                    : "Select 2+ rows to compare overlap"}
                </h3>
              </div>
              <span className="pill muted">
                {selectedTraitRows.slice(0, 2).map((trait) => trait.property_name).join(" + ") ||
                  "Local-only intersections"}
              </span>
            </div>
            {combinedTraits && activeTraits.length >= 2 ? (
              combinedTraits.matchedTokenCount > 0 ? (
                <>
                  <div className="context-grid">
                    <Metric
                      label="Combined support"
                      value={`${combinedTraits.matchedTokenCount} / ${collection.tokens.length}`}
                    />
                    <Metric
                      label="Share"
                      value={formatPercent(combinedTraits.matchedTokenShare)}
                    />
                    <Metric
                      label="Combined median"
                      value={formatValue(
                        combinedTraits.combinedMedianEth,
                        undefined,
                        collection.metadata.eth_usd,
                        valueMode,
                      )}
                    />
                    <Metric
                      label="Latest sale"
                      value={formatValue(
                        combinedTraits.latestSaleEth,
                        combinedTraits.latestSaleUsd,
                        collection.metadata.eth_usd,
                        valueMode,
                      )}
                    />
                    <Metric
                      label="Latest sale age"
                      value={formatRelativeAge(
                        combinedTraits.latestSaleTs,
                        referenceTimestamp,
                      )}
                    />
                    <Metric
                      label="Ask / floor"
                      value={`${formatValue(
                        combinedTraits.askFloorEth,
                        undefined,
                        collection.metadata.eth_usd,
                        valueMode,
                      )} / ${formatValue(
                        combinedTraits.floorReferenceEth,
                        undefined,
                        collection.metadata.eth_usd,
                        valueMode,
                      )}`}
                    />
                  </div>
                  <div className="combined-token-strip">
                    <div>
                      <p className="eyebrow">Matching neighborhood tokens</p>
                      <p className="footnote">
                        Intersections use current local neighborhood results only, without trait-bid
                        weighting.
                      </p>
                    </div>
                    <div className="token-pill-list">
                      {matchingNeighborhoodTokens.length > 0 ? (
                        matchingNeighborhoodTokens.slice(0, 12).map((tokenNumber) => (
                          <button
                            key={tokenNumber}
                            className="token-pill"
                            onClick={() => onSelectToken(tokenNumber)}
                            type="button"
                          >
                            {formatTokenNumber(tokenNumber)}
                          </button>
                        ))
                      ) : (
                        <span className="pill muted">No current neighborhood overlap</span>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <p className="footnote">
                  No current overlap beyond the selected token. The box stays conservative and
                  reports the local intersection result rather than inferring synthetic support.
                </p>
              )
            ) : (
              <p className="footnote">
                Use the checkbox rows above to pick at least two visible traits. The combined box
                summarizes overlap from matched local token records only.
              </p>
            )}
          </div>
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
          {activeView === "timeline" && inspectedTimelineEntry ? (
            <TimelineInspector
              activity={inspectedTimelineEntry}
              collection={collection}
              ethUsd={collection.metadata.eth_usd}
              referenceTimestamp={referenceTimestamp}
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
                {formatValue(
                  selectedToken.current_ask_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}
              </strong>{" "}
              against a contextual fair band of{" "}
              <strong>
                {formatValue(
                  selectedToken.prediction_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}
              </strong>.
            </li>
            <li>
              Token-specific bid depth is capped at{" "}
              <strong>
                {formatValue(
                  tokenBids[0]?.price_eth,
                  tokenBids[0]?.price_usd,
                  collection.metadata.eth_usd,
                  valueMode,
                )}
              </strong>
              ; collection support sits at{" "}
              <strong>
                {formatValue(
                  collection.context.top_bid_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}
              </strong>.
            </li>
            <li>
              Neighborhood mode is local-only and defaults to a 50-token comp set. Visual
              and curated comparables stay disabled placeholders until repo-local sources exist.
            </li>
            <li>
              Trait support rows and combined intersections use conservative token-level overlap.
              Raw trait bids are present in source data but intentionally muted here.
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
    <div className="token-fallback" style={{ "--token-hue": `${hue}` } as CSSProperties}>
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
  collection,
  entries,
  ethUsd,
  inspectedEntry,
  legend,
  neighborhoodShownCount,
  onInspect,
  onRangeChange,
  onScopeChange,
  range,
  scope,
  valueMode,
}: {
  collection: CollectionData;
  entries: TimelineEntry[];
  ethUsd: number;
  inspectedEntry?: TimelineEntry;
  legend: {
    total: number;
    saleCount: number;
    listingCount: number;
    privateCount: number;
    tokenCount: number;
  };
  neighborhoodShownCount: number;
  onInspect: (entry: TimelineEntry) => void;
  onRangeChange: (range: TimelineRange) => void;
  onScopeChange: (scope: TimelineScope) => void;
  range: TimelineRange;
  scope: TimelineScope;
  valueMode: ValueMode;
}) {
  const chartEntries = [...entries].sort((left, right) => left.timestamp - right.timestamp);
  const maxPrice = Math.max(...chartEntries.map((entry) => getTimelineEntryValue(entry)), 1);
  const timestamps = chartEntries.map((entry) => entry.timestamp);
  const minTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : 1;
  const linePoints = chartEntries.map((entry) => {
    const x = 44 + ((entry.timestamp - minTimestamp) / Math.max(maxTimestamp - minTimestamp, 1)) * 676;
    const y = 210 - (getTimelineEntryValue(entry) / maxPrice) * 176;
    return { x, y };
  });
  const linePath = linePoints.length > 1 ? describePath(linePoints) : "";

  return (
    <section className="timeline-card">
      <div className="timeline-toolbar">
        <div className="segmented-control wrap">
          {timelineScopeOptions.map((option) => (
            <button
              key={option.value}
              className={scope === option.value ? "selected" : ""}
              onClick={() => onScopeChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="segmented-control wrap">
          {timelineRangeOptions.map((option) => (
            <button
              key={option.value}
              className={range === option.value ? "selected" : ""}
              onClick={() => onRangeChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="timeline-legend">
        <span className="legend-pill">Shown {legend.total}</span>
        <span className="legend-pill">Sales {legend.saleCount}</span>
        <span className="legend-pill">Listings {legend.listingCount}</span>
        <span className="legend-pill">Private {legend.privateCount}</span>
        <span className="legend-pill">Tokens {legend.tokenCount}</span>
        {scope === "neighborhood" ? (
          <span className="legend-pill">Neighborhood size {neighborhoodShownCount}</span>
        ) : null}
      </div>
      <p className="footnote">
        {scope === "token"
          ? "Token-only scope shows the selected token history after the chosen recency filter."
          : scope === "neighborhood"
            ? "Token + neighborhood combines the selected token with the current local neighborhood result set."
            : "Aggregate lane groups collection-wide events into local median-price windows for the chosen recency filter."}
      </p>
      {entries.length === 0 ? (
        <div className="empty-state">
          <strong>No priced events in the selected window.</strong>
          <small>Switch recency or scope to review older local history.</small>
        </div>
      ) : (
        <>
          <svg className="timeline-chart" viewBox="0 0 760 250" role="img">
            <line x1="44" x2="44" y1="18" y2="210" className="axis-line" />
            <line x1="44" x2="720" y1="210" y2="210" className="axis-line" />
            {linePath ? <path className="timeline-path" d={linePath} /> : null}
            {chartEntries.map((entry, index) => {
              const point = linePoints[index] ?? { x: 44, y: 210 };
              const privateMark =
                !isAggregateTimelineEntry(entry) &&
                (entry.is_private || entry.kind.includes("private"));
              const selected = inspectedEntry
                ? getTimelineEntryKey(inspectedEntry) === getTimelineEntryKey(entry)
                : false;
              return (
                <g key={getTimelineEntryKey(entry)}>
                  <circle
                    className={
                      selected
                        ? "timeline-dot selected"
                        : privateMark
                          ? "timeline-dot private"
                          : isAggregateTimelineEntry(entry)
                            ? "timeline-dot aggregate"
                            : "timeline-dot"
                    }
                    cx={point.x}
                    cy={point.y}
                    onClick={() => onInspect(entry)}
                    r={selected ? 7 : isAggregateTimelineEntry(entry) ? 6 : 5}
                  />
                </g>
              );
            })}
          </svg>
          <div className="timeline-list">
            {entries.slice(0, 8).map((entry) => {
              const selected = inspectedEntry
                ? getTimelineEntryKey(inspectedEntry) === getTimelineEntryKey(entry)
                : false;
              return (
                <button
                  key={getTimelineEntryKey(entry)}
                  className={selected ? "timeline-row active" : "timeline-row"}
                  onClick={() => onInspect(entry)}
                  type="button"
                >
                  {isAggregateTimelineEntry(entry) ? (
                    <>
                      <div>
                        <span>Aggregate lane</span>
                        <small>
                          {formatCompactDate(entry.startTimestamp)} to{" "}
                          {formatCompactDate(entry.endTimestamp)} • {entry.eventCount} events
                        </small>
                      </div>
                      <div className="neighbor-metrics">
                        <strong>
                          {formatValue(entry.medianPriceEth, undefined, ethUsd, valueMode)}
                        </strong>
                        <small>{entry.tokenCount} tokens</small>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <span>{entry.kind.replace("_", " ")}</span>
                        <small>
                          {collection.tokensById.get(entry.token_id)?.display_name ?? entry.token_index}
                        </small>
                      </div>
                      <div className="neighbor-metrics">
                        <strong>
                          {formatValue(entry.price_eth, entry.price_usd, ethUsd, valueMode)}
                        </strong>
                        <small>{formatCompactDate(entry.timestamp)}</small>
                      </div>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
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
  onSizeChange,
  selectedToken,
  shownCount,
  size,
  totalCount,
  valueMode,
}: {
  ethUsd: number;
  inspectedNeighbor?: NeighborRecord;
  mode: NeighborhoodMode;
  neighbors: NeighborRecord[];
  onInspect: (neighbor: NeighborRecord) => void;
  onModeChange: (mode: NeighborhoodMode) => void;
  onSizeChange: (size: NeighborhoodSizeOption) => void;
  selectedToken: TokenWithNumber;
  shownCount: number;
  size: NeighborhoodSizeOption;
  totalCount: number;
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
      <div className="timeline-toolbar">
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
        <div className="segmented-control wrap">
          {neighborhoodSizeOptions.map((option) => (
            <button
              key={String(option)}
              className={size === option ? "selected" : ""}
              onClick={() => onSizeChange(option)}
              type="button"
            >
              {option === "max" ? "Max" : option}
            </button>
          ))}
        </div>
      </div>
      <p className="footnote">
        Neighborhoods are computed locally from token records plus token traits only.
        {mode === "trait"
          ? " Trait mode emphasizes shared visible traits."
          : mode === "rarity"
            ? " Rarity mode emphasizes nearby ranks."
            : " Additional modes remain placeholders until stronger local evidence exists."}
      </p>
      <div className="timeline-legend">
        <span className="legend-pill">Shown {shownCount}</span>
        <span className="legend-pill">Total local comps {totalCount}</span>
        <span className="legend-pill">
          Against {formatTokenNumber(selectedToken.tokenNumber)}
        </span>
      </div>
      {neighbors.length === 0 ? (
        <div className="empty-state">
          <strong>No local neighbors in this mode yet.</strong>
          <small>Trait and rarity views are data-driven; visual and curated remain placeholders.</small>
        </div>
      ) : null}
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

function CollectionRegimeCard({
  collection,
  referenceTimestamp,
  valueMode,
}: {
  collection: CollectionData;
  referenceTimestamp: number;
  valueMode: ValueMode;
}) {
  const recentSnapshots = collection.snapshots
    .filter((snapshot) => snapshot.floor_eth !== undefined && snapshot.floor_eth > 0)
    .filter((snapshot) => snapshot.timestamp >= referenceTimestamp - 180 * 24 * 60 * 60)
    .filter((_, index, snapshots) => {
      const step = Math.max(Math.floor(snapshots.length / 40), 1);
      return index % step === 0 || index === snapshots.length - 1;
    });
  const floorValues = recentSnapshots.map((snapshot) => snapshot.floor_eth ?? 0);
  const minFloor = Math.min(...floorValues, 0);
  const maxFloor = Math.max(...floorValues, 1);
  const sparklinePoints = recentSnapshots.map((snapshot, index) => {
    const x = 12 + (index / Math.max(recentSnapshots.length - 1, 1)) * 336;
    const y =
      92 - (((snapshot.floor_eth ?? 0) - minFloor) / Math.max(maxFloor - minFloor, 1)) * 72;
    return { x, y };
  });
  const linePath = sparklinePoints.length > 1 ? describePath(sparklinePoints) : "";
  const areaPath =
    sparklinePoints.length > 1
      ? `${linePath} L ${sparklinePoints[sparklinePoints.length - 1]?.x.toFixed(1) ?? "348"} 96 L ${sparklinePoints[0]?.x.toFixed(1) ?? "12"} 96 Z`
      : "";
  const latestSnapshot = collection.snapshots[collection.snapshots.length - 1];

  return (
    <div className="regime-card">
      <div className="section-head">
        <div>
          <p className="eyebrow">Collection regime</p>
          <h3>180d floor sparkline</h3>
        </div>
        <span className="pill muted">Placeholder lane</span>
      </div>
      <svg className="regime-chart" viewBox="0 0 360 108" role="img">
        <line className="axis-line" x1="12" x2="348" y1="96" y2="96" />
        {areaPath ? <path className="regime-area" d={areaPath} /> : null}
        {linePath ? <path className="regime-line" d={linePath} /> : null}
      </svg>
      <div className="context-grid">
        <Metric
          label="Current floor"
          value={formatValue(
            latestSnapshot?.floor_eth,
            undefined,
            collection.metadata.eth_usd,
            valueMode,
          )}
        />
        <Metric
          label="Floor change 90d"
          value={formatPercent(collection.context.change_floor_pct_90d)}
        />
        <Metric label="Listings" value={`${latestSnapshot?.listing_count ?? "N/A"}`} />
        <Metric label="Owners" value={`${latestSnapshot?.owner_count ?? "N/A"}`} />
      </div>
      <p className="footnote">
        This regime area is intentionally local-only. The sparkline reflects snapshot floors, while
        any future named regime labels should wait for a deterministic offline ruleset.
      </p>
    </div>
  );
}

function TimelineInspector({
  activity,
  collection,
  ethUsd,
  referenceTimestamp,
  valueMode,
}: {
  activity: TimelineEntry;
  collection: CollectionData;
  ethUsd: number;
  referenceTimestamp: number;
  valueMode: ValueMode;
}) {
  if (isAggregateTimelineEntry(activity)) {
    return (
      <div className="inspector-body">
        <Metric
          label="Window"
          value={`${formatCompactDate(activity.startTimestamp)} to ${formatCompactDate(activity.endTimestamp)}`}
        />
        <Metric
          label="Median price"
          value={formatValue(activity.medianPriceEth, undefined, ethUsd, valueMode)}
        />
        <Metric label="Events" value={`${activity.eventCount}`} />
        <Metric label="Tokens represented" value={`${activity.tokenCount}`} />
        <Metric label="Private events" value={`${activity.privateCount}`} />
        <p className="footnote">
          Aggregate lane groups collection-wide activity into local time buckets so the inspector can
          summarize event density without implying token-level comparability.
        </p>
      </div>
    );
  }

  return (
    <div className="inspector-body">
      <Metric
        label="Token"
        value={collection.tokensById.get(activity.token_id)?.display_name ?? activity.token_index}
      />
      <Metric label="Event" value={activity.kind.replace("_", " ")} />
      <Metric label="Timestamp" value={formatDate(activity.timestamp)} />
      <Metric label="Price" value={formatValue(activity.price_eth, activity.price_usd, ethUsd, valueMode)} />
      <Metric label="Age" value={formatRelativeAge(activity.timestamp, referenceTimestamp)} />
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
        <p className="footnote">No active bids in the local snapshot.</p>
      ) : (
        bids.map((bid) => (
          <div key={bid.bid_id} className="bid-row">
            <strong>{formatValue(bid.price_eth, bid.price_usd, ethUsd, valueMode)}</strong>
            <small>
              {bid.bidder_address ? `${bid.bidder_address.slice(0, 6)}...` : "Unknown bidder"} •
              expires {formatDate(bid.end_ts)}
            </small>
          </div>
        ))
      )}
    </div>
  );
}
