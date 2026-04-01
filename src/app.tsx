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
  Bid,
  CollectionData,
  CollectionSummary,
  NeighborRecord,
  NeighborhoodMode,
  TokenWithNumber,
  ValueMode,
} from "./data/types.ts";
import {
  buildNeighborhoodPlot,
  deriveRarityBucket,
  deriveCombinedTraitMetrics,
  deriveNeighbors,
  getDefaultTraitSelection,
  getActivityMarketType,
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
type TimelineBidEntry = {
  entryType: "bid";
  bidId: string;
  bidScope: "token" | "collection";
  tokenId?: number;
  timestamp: number;
  endTimestamp?: number;
  priceEth?: number;
  priceUsd?: number;
  bidderAddress?: string;
  source?: string;
};
type TimelineEntry = Activity | TimelineAggregateBucket | TimelineBidEntry;
type TimelineLegend = {
  total: number;
  saleCount: number;
  askCount: number;
  bidCount: number;
  privateCount: number;
  tokenCount: number;
};
type ArtworkConfig = {
  chainId: number;
  contractAddress: string;
  featuredTokenIndex: string;
  featuredTokenNumber: number;
};
type SignalTone = "warm" | "cool" | "positive" | "muted" | "rare";

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
const artworkConfigBySlug: Record<string, ArtworkConfig> = {
  "fidenza-by-tyler-hobbs": {
    chainId: 1,
    contractAddress: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
    featuredTokenIndex: "78000239",
    featuredTokenNumber: 239,
  },
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

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

function buildTimelineBidEntries(
  bids: Bid[],
  cutoffTimestamp: number,
  bidScope: "token" | "collection",
) {
  return bids
    .filter((bid) => bid.status === "ACTIVE" && bid.is_active !== false)
    .filter((bid) => bid.start_ts >= cutoffTimestamp)
    .map<TimelineBidEntry>((bid) => ({
      entryType: "bid",
      bidId: bid.bid_id,
      bidScope,
      tokenId: bid.token_id,
      timestamp: bid.start_ts,
      endTimestamp: bid.end_ts,
      priceEth: bid.price_eth,
      priceUsd: bid.price_usd,
      bidderAddress: bid.bidder_address,
      source: bid.source,
    }))
    .sort((left, right) => right.timestamp - left.timestamp);
}

function isAggregateTimelineEntry(
  entry: TimelineEntry | undefined,
): entry is TimelineAggregateBucket {
  return entry !== undefined && "bucketId" in entry;
}

function isTimelineBidEntry(entry: TimelineEntry | undefined): entry is TimelineBidEntry {
  return entry !== undefined && "entryType" in entry && entry.entryType === "bid";
}

function getTimelineEntryKey(entry: TimelineEntry) {
  if (isAggregateTimelineEntry(entry)) {
    return entry.bucketId;
  }
  if (isTimelineBidEntry(entry)) {
    return `bid-${entry.bidId}`;
  }
  return `activity-${entry.activity_id}`;
}

function getTimelineEntryValue(entry: TimelineEntry) {
  if (isAggregateTimelineEntry(entry)) {
    return entry.medianPriceEth ?? 0;
  }
  if (isTimelineBidEntry(entry)) {
    return entry.priceEth ?? 0;
  }
  return entry.price_eth ?? 0;
}

function getTimelineLegend(
  activities: Activity[],
  bidEntries: TimelineBidEntry[],
): TimelineLegend {
  const activityTokenIds = activities.map((activity) => activity.token_id);
  const bidTokenIds = bidEntries
    .map((entry) => entry.tokenId)
    .filter((tokenId): tokenId is number => tokenId !== undefined);

  return {
    total: activities.length + bidEntries.length,
    saleCount: activities.filter((activity) => getActivityMarketType(activity) === "sale").length,
    askCount: activities.filter((activity) => getActivityMarketType(activity) === "ask").length,
    bidCount: bidEntries.length,
    privateCount: activities.filter(
      (activity) => activity.is_private || activity.kind.includes("private"),
    ).length,
    tokenCount: new Set([...activityTokenIds, ...bidTokenIds]).size,
  };
}

function describePath(points: Array<{ x: number; y: number }>) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function getTimelineEntrySemantic(entry: TimelineEntry) {
  if (isAggregateTimelineEntry(entry)) {
    return "aggregate" as const;
  }
  if (isTimelineBidEntry(entry)) {
    return "bid" as const;
  }
  return getActivityMarketType(entry) ?? "sale";
}

function getRarityToneClass(tone?: string) {
  return tone ? `rarity-tone-${tone}` : "";
}

function getArtworkConfig(slug: string) {
  return artworkConfigBySlug[slug];
}

function getDefaultTokenNumber(slug: string) {
  return getArtworkConfig(slug)?.featuredTokenNumber ?? 1;
}

function getCollectionArtworkUrl(slug: string) {
  const artwork = getArtworkConfig(slug);
  if (!artwork) {
    return undefined;
  }
  return `https://media-proxy.artblocks.io/${artwork.chainId}/${artwork.contractAddress}/${artwork.featuredTokenIndex}.png`;
}

function getTokenImageUrl(slug: string, tokenIndex: string | number) {
  const artwork = getArtworkConfig(slug);
  if (!artwork) {
    return undefined;
  }
  return `https://media-proxy.artblocks.io/${artwork.chainId}/${artwork.contractAddress}/${tokenIndex}.png`;
}

function getTokenExternalUrl(slug: string, tokenIndex: string | number) {
  const artwork = getArtworkConfig(slug);
  if (!artwork) {
    return undefined;
  }
  return `https://www.artblocks.io/token/${artwork.chainId}/${artwork.contractAddress}/${tokenIndex}`;
}

function buildTokenSignals(
  token: TokenWithNumber,
  tokenBids: Bid[],
  referenceTimestamp: number,
  rarityBucket: ReturnType<typeof deriveRarityBucket>,
) {
  const signals: Array<{ label: string; tone: SignalTone }> = [];
  const recentSaleAge = token.last_single_sale_ts
    ? referenceTimestamp - token.last_single_sale_ts
    : undefined;

  if (recentSaleAge !== undefined && recentSaleAge <= 180 * 24 * 60 * 60) {
    signals.push({
      label: `Recent sale ${formatRelativeAge(token.last_single_sale_ts, referenceTimestamp)}`,
      tone: "positive",
    });
  }
  if (token.current_ask_eth !== undefined) {
    signals.push({ label: "Active ask", tone: "warm" });
  }
  if (tokenBids[0]?.price_eth !== undefined) {
    signals.push({ label: "Token bid live", tone: "cool" });
  }
  if (rarityBucket) {
    signals.push({
      label: rarityBucket.label,
      tone: rarityBucket.tone === "elite" ? "rare" : "cool",
    });
  }
  if (
    token.current_ask_eth !== undefined &&
    token.prediction_eth !== undefined &&
    token.current_ask_eth > token.prediction_eth * 1.2
  ) {
    signals.push({ label: "Ask above model", tone: "muted" });
  }

  return signals.slice(0, 5);
}

function LandingPage({
  collections,
}: {
  collections: CollectionSummary[];
}) {
  return (
    <main className="landing-shell">
      <div className="hero-panel">
        <div className="hero-grid">
          <div>
            <p className="eyebrow">Static valuation workbench</p>
            <h1>Evidence-first collection decks, rebuilt around the art.</h1>
            <p className="hero-copy">
              Repo-local JSON still drives the whole experience, but the interface now
              leads with artwork, valuation bands, comps, and market context instead of
              feeling like a spreadsheet shell.
            </p>
          </div>
          <div className="hero-copy-block">
            <span className="pill muted">Static deploy</span>
            <span className="pill muted">Repo JSON only</span>
            <span className="pill muted">Image-led review</span>
          </div>
        </div>
      </div>
      <div className="collection-grid">
        {collections.map((collection) => (
          <button
            key={collection.slug}
            className="collection-card"
            onClick={() =>
              updateRoute(
                collection.slug,
                new URLSearchParams({
                  token: String(getDefaultTokenNumber(collection.slug)),
                }),
              )
            }
            type="button"
          >
            <div className="collection-card-art">
              <CollectionArtwork collection={collection} />
            </div>
            <div className="collection-card-body">
              <div className="collection-card-head">
                <div>
                  <p className="eyebrow">{collection.artist}</p>
                  <h2>{collection.title}</h2>
                </div>
                <span className="pill">Open workbench</span>
              </div>
              <p className="hero-copy">
                Open the deck to inspect token-level asks, local trait support, market
                history, and neighborhood comps in one place.
              </p>
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
                <Metric label="Snapshot" value={formatDate(collection.snapshotTs)} />
              </div>
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
        <div className="header-copy-block">
          <button className="back-link" onClick={() => (window.location.hash = "/")} type="button">
            Collection index
          </button>
          <p className="eyebrow">{collection.summary.artist}</p>
          <h1>{collection.summary.title} valuation workbench</h1>
          <p className="hero-copy">
            Token art, valuation bands, repo-local market evidence, and trait-driven comp
            context in a single review surface.
          </p>
        </div>
        <div className="header-actions">
          <div className="header-glance">
            <Metric
              label="Collection floor"
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
              label="30d median"
              value={formatValue(
                collection.context.median_sale_eth_30d,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
          </div>
          <ValueModeToggle valueMode={valueMode} onChange={setValueMode} />
        </div>
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
  const selectedRarityBucket = deriveRarityBucket(selectedToken.rarityPercentile);
  const timelineData = useMemo(() => {
    const cutoffTimestamp = getTimelineCutoff(referenceTimestamp, timelineRange);
    const tokenActivities = filterTimelineActivities(allTokenActivity, cutoffTimestamp);
    const tokenBidEntries = buildTimelineBidEntries(
      collection.tokenBidsByTokenId.get(selectedToken.token_id) ?? [],
      cutoffTimestamp,
      "token",
    );
    const neighborhoodTokenIds = new Set([
      selectedToken.token_id,
      ...visibleNeighbors.map((neighbor) => neighbor.token.token_id),
    ]);
    const neighborhoodActivities = filterTimelineActivities(
      collection.activities.filter((activity) => neighborhoodTokenIds.has(activity.token_id)),
      cutoffTimestamp,
    );
    const neighborhoodBidEntries = [...neighborhoodTokenIds]
      .flatMap((tokenId) =>
        buildTimelineBidEntries(
          collection.tokenBidsByTokenId.get(tokenId) ?? [],
          cutoffTimestamp,
          "token",
        ),
      )
      .sort((left, right) => right.timestamp - left.timestamp);
    const aggregateEntries = buildAggregateTimeline(
      collection.activities,
      cutoffTimestamp,
      timelineRange,
    );
    const collectionActivities = filterTimelineActivities(collection.activities, cutoffTimestamp);
    const collectionBidEntries = buildTimelineBidEntries(
      collection.collectionBids,
      cutoffTimestamp,
      "collection",
    );

    const entries: TimelineEntry[] =
      timelineScope === "token"
        ? [...tokenActivities, ...tokenBidEntries].sort(
            (left, right) => right.timestamp - left.timestamp,
          )
        : timelineScope === "neighborhood"
          ? [...neighborhoodActivities, ...neighborhoodBidEntries].sort(
              (left, right) => right.timestamp - left.timestamp,
            )
          : [...aggregateEntries, ...collectionBidEntries].sort(
              (left, right) => right.timestamp - left.timestamp,
            );
    const legend =
      timelineScope === "token"
        ? getTimelineLegend(tokenActivities, tokenBidEntries)
        : timelineScope === "neighborhood"
          ? getTimelineLegend(neighborhoodActivities, neighborhoodBidEntries)
          : getTimelineLegend(collectionActivities, collectionBidEntries);

    return {
      entries,
      legend,
    };
  }, [
    allTokenActivity,
    collection.activities,
    collection.collectionBids,
    collection.tokenBidsByTokenId,
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
  const tokenSignals = useMemo(
    () =>
      buildTokenSignals(
        selectedToken,
        tokenBids,
        referenceTimestamp,
        selectedRarityBucket,
      ),
    [referenceTimestamp, selectedRarityBucket, selectedToken, tokenBids],
  );
  const selectedTokenUrl = getTokenExternalUrl(
    collection.summary.slug,
    selectedToken.token_index,
  );

  return (
    <>
      <aside className="left-column">
        <section className="panel token-selector-panel">
          <div className="token-selector-head">
            <div>
              <p className="eyebrow">Token selector</p>
              <h2>{selectedToken.display_name}</h2>
            </div>
            <span className="pill muted">Shareable URL state</span>
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
                <strong>{token.display_name}</strong>
                <div className="chip-copy">
                  <span>
                    {formatValue(
                      token.current_ask_eth,
                      undefined,
                      collection.metadata.eth_usd,
                      "eth",
                    )}
                  </span>
                  <small>Rank {token.rarity_rank ?? "N/A"}</small>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel token-spotlight">
          <div className="token-stage">
            <div className="token-stage-top">
              <span className="eyebrow">Token spotlight</span>
              {selectedTokenUrl ? (
                <a className="art-link" href={selectedTokenUrl} rel="noreferrer" target="_blank">
                  Open on Art Blocks
                </a>
              ) : null}
            </div>
            <TokenArtwork
              alt={selectedToken.display_name}
              rarityBucket={selectedRarityBucket}
              slug={collection.summary.slug}
              token={selectedToken}
            />
          </div>
          <div className="token-stage-body">
            <div className="token-title-row">
              <div>
                <h2>{selectedToken.display_name}</h2>
                <p className="subdued-copy">
                  {collection.summary.title} / {collection.summary.artist}
                </p>
              </div>
              <span
                className={cx(
                  "pill rarity-pill",
                  selectedRarityBucket ? getRarityToneClass(selectedRarityBucket.tone) : "",
                )}
              >
                {selectedRarityBucket?.label ?? "Rarity pending"}
              </span>
            </div>
            <div className="token-pill-list">
              {tokenSignals.map((signal) => (
                <SignalPill key={signal.label} label={signal.label} tone={signal.tone} />
              ))}
            </div>
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
                label="Last sale age"
                value={formatRelativeAge(selectedToken.last_single_sale_ts, referenceTimestamp)}
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
              <Metric
                label="Current ask"
                value={formatValue(
                  selectedToken.current_ask_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}
              />
            </div>
          </div>
        </section>

        <section className="panel context-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Collection context</p>
              <h2>Deck anchors</h2>
            </div>
            <span className="pill muted">Context, not verdict</span>
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
          </div>
          <CollectionRegimeCard
            collection={collection}
            referenceTimestamp={referenceTimestamp}
            valueMode={valueMode}
          />
        </section>
      </aside>

      <section className="center-column">
        <section className="panel evidence-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Market evidence</p>
              <h2>{activeView === "timeline" ? "Timeline view" : "Neighborhood view"}</h2>
            </div>
            <div className="segmented-control">
              <button
                className={activeView === "timeline" ? "selected" : ""}
                onClick={() => onActiveViewChange("timeline")}
                type="button"
              >
                Timeline
              </button>
              <button
                className={activeView === "neighborhood" ? "selected" : ""}
                onClick={() => onActiveViewChange("neighborhood")}
                type="button"
              >
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
            collectionSlug={collection.summary.slug}
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
        </section>

        <section className="panel trait-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Trait support</p>
              <h2>Trait rows and intersections</h2>
            </div>
            <span className="pill muted">Local support only</span>
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
                  "Local intersections"}
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
                  No current overlap beyond the selected token. The box stays conservative
                  and reports the exact local intersection result instead of inventing
                  synthetic support.
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

      <aside className="right-column">
        <section className="panel inspector-card">
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
              collectionSlug={collection.summary.slug}
              ethUsd={collection.metadata.eth_usd}
              neighbor={inspectedNeighbor}
              valueMode={valueMode}
            />
          ) : null}
        </section>

        <section className="panel inspector-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Decision synthesis</p>
              <h2>Bid, fair, and list frame</h2>
            </div>
          </div>
          <div className="decision-grid">
            <DecisionCard
              notes={[
                `Token support ${formatValue(
                  marketBand.topBidEth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}`,
                `Collection support ${formatValue(
                  collection.context.top_bid_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}`,
                `Last sale ${formatRelativeAge(selectedToken.last_single_sale_ts, referenceTimestamp)}`,
              ]}
              title="Bid-side"
              tone="bid"
              value={formatValue(
                marketBand.topBidEth ?? collection.context.top_bid_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <DecisionCard
              notes={[
                `Model ${formatValue(
                  selectedToken.prediction_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}`,
                `Adjusted floor ${formatValue(
                  selectedToken.adjusted_floor_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}`,
                `Rarity ${selectedRarityBucket?.label ?? "N/A"}`,
              ]}
              title="Fair value"
              tone="fair"
              value={formatValue(
                marketBand.fairEth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <DecisionCard
              notes={[
                `Current ask ${formatValue(
                  selectedToken.current_ask_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}`,
                `Neighborhood set ${visibleNeighbors.length} comps`,
                `${activeTraits.length} active trait rows`,
              ]}
              title="List-side"
              tone="list"
              value={formatValue(
                marketBand.listEth ?? selectedToken.current_ask_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
          </div>
        </section>

        <section className="panel inspector-card bids-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Active bids</p>
              <h2>Collection and token support</h2>
            </div>
          </div>
          <BidList
            bids={tokenBids}
            ethUsd={collection.metadata.eth_usd}
            title="Token bids"
            valueMode={valueMode}
          />
          <BidList
            bids={collectionBids}
            ethUsd={collection.metadata.eth_usd}
            title="Collection bids"
            valueMode={valueMode}
          />
        </section>
      </aside>
    </>
  );
}

function CollectionArtwork({
  collection,
}: {
  collection: CollectionSummary;
}) {
  const [failed, setFailed] = useState(false);
  const src = getCollectionArtworkUrl(collection.slug);

  if (!src || failed) {
    return <div className="collection-artwork-fallback">{collection.title}</div>;
  }

  return (
    <img
      alt={`${collection.title} artwork preview`}
      className="collection-artwork"
      loading="lazy"
      onError={() => setFailed(true)}
      src={src}
    />
  );
}

function SignalPill({
  label,
  tone,
}: {
  label: string;
  tone: SignalTone;
}) {
  return <span className={cx("signal-pill", tone)}>{label}</span>;
}

function TokenArtwork({
  alt,
  rarityBucket,
  slug,
  token,
}: {
  alt: string;
  rarityBucket: ReturnType<typeof deriveRarityBucket>;
  slug: string;
  token: TokenWithNumber;
}) {
  const [failed, setFailed] = useState(false);
  const src = getTokenImageUrl(slug, token.token_index);

  if (!src || failed) {
    return <TokenFallback rarityBucket={rarityBucket} token={token} />;
  }

  return (
    <div className="token-artwork-frame">
      <img
        alt={alt}
        className="token-artwork"
        loading="lazy"
        onError={() => setFailed(true)}
        src={src}
      />
    </div>
  );
}

function TokenThumbnail({
  slug,
  token,
}: {
  slug: string;
  token: TokenWithNumber;
}) {
  const [failed, setFailed] = useState(false);
  const src = getTokenImageUrl(slug, token.token_index);

  if (!src || failed) {
    return <TokenFallback compact rarityBucket={null} token={token} />;
  }

  return (
    <div className="token-thumb-frame">
      <img
        alt={token.display_name}
        className="token-thumb-image"
        loading="lazy"
        onError={() => setFailed(true)}
        src={src}
      />
    </div>
  );
}

function DecisionCard({
  notes,
  title,
  tone,
  value,
}: {
  notes: string[];
  title: string;
  tone: "bid" | "fair" | "list";
  value: string;
}) {
  return (
    <div className={cx("decision-card", tone)}>
      <p className="eyebrow">{title}</p>
      <div className="decision-card-value">{value}</div>
      <div className="decision-card-notes">
        {notes.map((note) => (
          <span className="decision-note" key={note}>
            {note}
          </span>
        ))}
      </div>
    </div>
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

function TokenFallback({
  compact = false,
  rarityBucket,
  token,
}: {
  compact?: boolean;
  rarityBucket: ReturnType<typeof deriveRarityBucket>;
  token: TokenWithNumber;
}) {
  const hue = (token.tokenNumber * 29) % 360;
  return (
    <div
      className={cx("token-fallback", compact ? "compact" : "")}
      style={{ "--token-hue": `${hue}` } as CSSProperties}
    >
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
      {!compact ? (
        <div className="token-fallback-copy">
          <p>{token.display_name}</p>
          <div className="token-fallback-meta">
            <span>Fallback visual / rarity rank {token.rarity_rank ?? "N/A"}</span>
            {rarityBucket ? (
              <span className={`pill rarity-pill ${getRarityToneClass(rarityBucket.tone)}`}>
                {rarityBucket.label}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="token-fallback-tag">{formatTokenNumber(token.tokenNumber)}</div>
      )}
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
  legend: TimelineLegend;
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
    const x =
      44 + ((entry.timestamp - minTimestamp) / Math.max(maxTimestamp - minTimestamp, 1)) * 676;
    const y = 210 - (getTimelineEntryValue(entry) / maxPrice) * 176;
    return { x, y };
  });
  const linePath =
    scope === "aggregate" && linePoints.length > 1 ? describePath(linePoints) : "";

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
        <span className="legend-pill sale">Sales {legend.saleCount}</span>
        <span className="legend-pill ask">Asks {legend.askCount}</span>
        <span className="legend-pill bid">Bids {legend.bidCount}</span>
        <span className="legend-pill private">Private {legend.privateCount}</span>
        <span className="legend-pill">Tokens {legend.tokenCount}</span>
        {scope === "neighborhood" ? (
          <span className="legend-pill">Neighborhood size {neighborhoodShownCount}</span>
        ) : null}
      </div>
      <p className="footnote">
        {scope === "token"
          ? "Token-only scope mixes local sale rows, ask/listing rows, and active token bids that opened in the chosen recency window."
          : scope === "neighborhood"
            ? "Token + neighborhood combines the selected token with the current local neighborhood result set, including active token bids for the shown tokens."
            : "Aggregate lane groups collection-wide sale/ask activity into median-price windows and overlays active collection bids by bid-open timestamp."}
      </p>
      <p className="footnote">
        Bid markers use active bid start times plus expiry from the local snapshot only; the workbench does not infer missing bid history.
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
                !isTimelineBidEntry(entry) &&
                (entry.is_private || entry.kind.includes("private"));
              const selected = inspectedEntry
                ? getTimelineEntryKey(inspectedEntry) === getTimelineEntryKey(entry)
                : false;
              const semantic = getTimelineEntrySemantic(entry);
              const className = [
                "timeline-dot",
                semantic,
                privateMark ? "private" : "",
                selected ? "selected" : "",
              ]
                .filter(Boolean)
                .join(" ");

              if (semantic === "ask") {
                return (
                  <g key={getTimelineEntryKey(entry)}>
                    <rect
                      className={className}
                      height={selected ? 14 : 12}
                      onClick={() => onInspect(entry)}
                      rx={2}
                      transform={`rotate(45 ${point.x} ${point.y})`}
                      width={selected ? 14 : 12}
                      x={point.x - (selected ? 7 : 6)}
                      y={point.y - (selected ? 7 : 6)}
                    />
                  </g>
                );
              }

              if (semantic === "bid") {
                const offset = selected ? 8 : 7;
                return (
                  <g key={getTimelineEntryKey(entry)}>
                    <polygon
                      className={className}
                      onClick={() => onInspect(entry)}
                      points={`${point.x},${point.y - offset} ${point.x - offset},${point.y + offset - 2} ${point.x + offset},${point.y + offset - 2}`}
                    />
                  </g>
                );
              }

              return (
                <g key={getTimelineEntryKey(entry)}>
                  <circle
                    className={className}
                    cx={point.x}
                    cy={point.y}
                    onClick={() => onInspect(entry)}
                    r={selected ? 7 : semantic === "aggregate" ? 6 : 5}
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
                          {formatCompactDate(entry.endTimestamp)} / {entry.eventCount} events
                        </small>
                      </div>
                      <div className="neighbor-metrics">
                        <strong>
                          {formatValue(entry.medianPriceEth, undefined, ethUsd, valueMode)}
                        </strong>
                        <small>{entry.tokenCount} tokens</small>
                      </div>
                    </>
                  ) : isTimelineBidEntry(entry) ? (
                    <>
                      <div>
                        <span>{entry.bidScope === "collection" ? "Collection bid" : "Token bid"}</span>
                        <small>
                          {entry.bidScope === "collection"
                            ? "Collection-wide active support"
                            : collection.tokensById.get(entry.tokenId ?? -1)?.display_name ??
                              "Unknown token"}
                        </small>
                      </div>
                      <div className="neighbor-metrics">
                        <strong>
                          {formatValue(entry.priceEth, entry.priceUsd, ethUsd, valueMode)}
                        </strong>
                        <small>opens {formatCompactDate(entry.timestamp)}</small>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <span>
                          {getActivityMarketType(entry) === "ask"
                            ? entry.is_private
                              ? "Private ask"
                              : "Ask"
                            : entry.is_private
                              ? "Private sale"
                              : "Sale"}
                        </span>
                        <small>
                          {collection.tokensById.get(entry.token_id)?.display_name ??
                            entry.token_index}
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
  collectionSlug,
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
  collectionSlug: string;
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
  const plotPoints = useMemo(
    () => buildNeighborhoodPlot(selectedToken, neighbors, mode),
    [mode, neighbors, selectedToken],
  );
  const selectedPlotPoint = plotPoints[0];
  const selectedRarityBucket = deriveRarityBucket(selectedToken.rarityPercentile);

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
        {selectedRarityBucket ? (
          <span className={`legend-pill ${getRarityToneClass(selectedRarityBucket.tone)}`}>
            {selectedRarityBucket.label}
          </span>
        ) : null}
      </div>
      {neighbors.length === 0 ? (
        <div className="empty-state">
          <strong>No local neighbors in this mode yet.</strong>
          <small>Trait and rarity views are data-driven; visual and curated remain placeholders.</small>
        </div>
      ) : (
        <div className="neighborhood-map-card">
          <div className="map-caption">
            <strong>Similarity map</strong>
            <small>
              X tracks local value spread from the selected token, Y tracks rarity-percentile
              spread, and marker size reflects {mode === "trait" ? "shared visible traits." : "rarity proximity."}
            </small>
          </div>
          <svg
            aria-label={`Neighborhood similarity map for ${selectedToken.display_name}`}
            className="neighborhood-map"
            role="img"
            viewBox="0 0 760 320"
          >
            <line className="map-axis" x1="380" x2="380" y1="24" y2="292" />
            <line className="map-axis" x1="36" x2="724" y1="160" y2="160" />
            <text className="map-label" x="42" y="148">
              Lower value
            </text>
            <text className="map-label" textAnchor="end" x="718" y="148">
              Higher value
            </text>
            <text className="map-label" x="390" y="34">
              Rarer
            </text>
            <text className="map-label" x="390" y="286">
              More common
            </text>
            {plotPoints.map((point) => {
              const x = 380 + point.x * 260;
              const y = 160 - point.y * 110;
              const inspected = inspectedNeighbor?.token.token_id === point.tokenId;
              const pointClass = [
                "map-node",
                point.isSelected ? "selected" : "neighbor",
                inspected ? "inspected" : "",
                getRarityToneClass(point.rarityBucket?.tone),
              ]
                .filter(Boolean)
                .join(" ");

              if (point.isSelected) {
                return (
                  <g key={point.tokenId}>
                    <circle className={pointClass} cx={x} cy={y} r={point.radius} />
                    <text className="map-selected-label" textAnchor="middle" x={x} y={y - 20}>
                      {formatTokenNumber(point.tokenNumber)}
                    </text>
                  </g>
                );
              }

              const neighbor = neighbors.find((entry) => entry.token.token_id === point.tokenId);
              if (!neighbor) {
                return null;
              }

              return (
                <g
                  aria-label={`Inspect ${point.label}`}
                  className="map-button"
                  key={point.tokenId}
                  onClick={() => onInspect(neighbor)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onInspect(neighbor);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <circle className={pointClass} cx={x} cy={y} r={point.radius} />
                  {inspected ? (
                    <text className="map-inspected-label" textAnchor="middle" x={x} y={y - 18}>
                      {formatTokenNumber(point.tokenNumber)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          <div className="timeline-legend">
            <span className="legend-pill">Center {selectedPlotPoint?.label ?? selectedToken.display_name}</span>
            <span className="legend-pill">Click plotted neighbors to inspect</span>
          </div>
        </div>
      )}
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
              <TokenThumbnail slug={collectionSlug} token={neighbor.token} />
              <div className="neighbor-row-copy">
                <strong>{neighbor.token.display_name}</strong>
              <small>
                {neighbor.sharedTraitCount} shared traits / rarity gap{" "}
                {formatDistance(neighbor.rarityGap)} /{" "}
                {deriveRarityBucket(neighbor.token.rarityPercentile)?.label ?? "N/A"}
              </small>
              </div>
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

  if (isTimelineBidEntry(activity)) {
    return (
      <div className="inspector-body">
        <Metric
          label="Bid scope"
          value={activity.bidScope === "collection" ? "Collection" : "Token"}
        />
        {activity.bidScope === "token" ? (
          <Metric
            label="Token"
            value={
              collection.tokensById.get(activity.tokenId ?? -1)?.display_name ??
              "Unknown token"
            }
          />
        ) : null}
        <Metric
          label="Bid"
          value={formatValue(activity.priceEth, activity.priceUsd, ethUsd, valueMode)}
        />
        <Metric label="Opened" value={formatDate(activity.timestamp)} />
        <Metric
          label="Opened age"
          value={formatRelativeAge(activity.timestamp, referenceTimestamp)}
        />
        <Metric label="Expires" value={formatDate(activity.endTimestamp)} />
        <Metric label="Source" value={activity.source ?? "Unknown"} />
        <p className="footnote">
          Bid entries reflect the active local bid snapshot only. The chart plots bid-open time and
          expiry from `bids.json`, without inventing a full bid-by-bid history.
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
      <Metric
        label="Event"
        value={
          getActivityMarketType(activity) === "ask"
            ? activity.is_private
              ? "Private ask"
              : "Ask"
            : activity.is_private
              ? "Private sale"
              : "Sale"
        }
      />
      <Metric label="Timestamp" value={formatDate(activity.timestamp)} />
      <Metric
        label="Price"
        value={formatValue(activity.price_eth, activity.price_usd, ethUsd, valueMode)}
      />
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
  collectionSlug,
  ethUsd,
  neighbor,
  valueMode,
}: {
  collectionSlug: string;
  ethUsd: number;
  neighbor: NeighborRecord;
  valueMode: ValueMode;
}) {
  const rarityBucket = deriveRarityBucket(neighbor.token.rarityPercentile);

  return (
    <div className="inspector-body">
      <TokenArtwork
        alt={neighbor.token.display_name}
        rarityBucket={rarityBucket}
        slug={collectionSlug}
        token={neighbor.token}
      />
      <Metric label="Neighbor" value={neighbor.token.display_name} />
      <Metric
        label="Ask"
        value={formatValue(neighbor.token.current_ask_eth, undefined, ethUsd, valueMode)}
      />
      <Metric
        label="Prediction"
        value={formatValue(neighbor.token.prediction_eth, undefined, ethUsd, valueMode)}
      />
      <Metric label="Rarity bucket" value={rarityBucket?.label ?? "N/A"} />
      <Metric label="Rarity gap" value={formatDistance(neighbor.rarityGap)} />
      <p className="footnote">
        {neighbor.sharedTraitNames.length > 0
          ? `Shared traits: ${neighbor.sharedTraitNames.slice(0, 4).join(" / ")}`
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
              {bid.bidder_address ? `${bid.bidder_address.slice(0, 6)}...` : "Unknown bidder"} /
              expires {formatDate(bid.end_ts)}
            </small>
          </div>
        ))
      )}
    </div>
  );
}
