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
  TokenTrait,
  TokenWithNumber,
  TraitDriverTier,
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
type ContextDeltaWindow = "1d" | "1w" | "1m" | "3m" | "6m" | "1y";
type NeighborhoodSizeOption = 10 | 20 | 50 | 100 | "max";
type TimelineSeriesKey = "sale" | "ask" | "bid" | "private";
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
const contextDeltaOptions: Array<{ label: string; value: ContextDeltaWindow }> = [
  { label: "1d", value: "1d" },
  { label: "1w", value: "1w" },
  { label: "1m", value: "1m" },
  { label: "3m", value: "3m" },
  { label: "6m", value: "6m" },
  { label: "1y", value: "1y" },
];
const neighborhoodSizeOptions: NeighborhoodSizeOption[] = [10, 20, 50, 100, "max"];
const traitPreviewCount = 6;
const defaultMinBidEth = 0.001;
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

function getStoredNumber(key: string, fallback: number) {
  if (typeof window === "undefined") {
    return fallback;
  }

  const stored = window.localStorage.getItem(key);
  if (!stored) {
    return fallback;
  }

  const parsed = Number(stored);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  minBidEth = 0,
) {
  return bids
    .filter((bid) => bid.status === "ACTIVE" && bid.is_active !== false)
    .filter((bid) => bid.start_ts >= cutoffTimestamp)
    .filter((bid) => (bid.price_eth ?? 0) >= minBidEth)
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

function getTimelineSeriesKey(entry: TimelineEntry): TimelineSeriesKey {
  if (isTimelineBidEntry(entry)) {
    return "bid";
  }
  if (!isAggregateTimelineEntry(entry) && (entry.is_private || entry.kind.includes("private"))) {
    return "private";
  }
  return getActivityMarketType(entry) === "ask" ? "ask" : "sale";
}

function buildLinearTicks(min: number, max: number, count: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count <= 1) {
    return [max];
  }
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, index) => max - step * index);
}

function formatTimelineAxisValue(value: number) {
  if (value >= 100) {
    return value.toFixed(0);
  }
  if (value >= 20) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

function formatTimelineAgeTick(timestamp: number, latestTimestamp: number) {
  const ageInDays = Math.max(0, Math.round((latestTimestamp - timestamp) / 86_400));
  return ageInDays === 0 ? "now" : `${ageInDays}d`;
}

function getTimelineScopeSummary(scope: TimelineScope) {
  switch (scope) {
    case "token":
      return "Selected token rows only, with local sale, ask, and active bid evidence inside the chosen window.";
    case "neighborhood":
      return "Selected token plus the current neighborhood set, keeping the view compact and directly comparable.";
    default:
      return "Collection-wide activity compressed into median-price buckets, with active collection bids overlaid.";
  }
}

function describeTimelineAnchor(entry: TimelineEntry, collection: CollectionData) {
  if (isAggregateTimelineEntry(entry)) {
    return {
      detail: `${entry.eventCount} events / ${entry.tokenCount} tokens`,
      label: "Aggregate lane",
      semantic: "aggregate" as const,
    };
  }

  if (isTimelineBidEntry(entry)) {
    return {
      detail:
        entry.bidScope === "collection"
          ? "Collection-wide support"
          : collection.tokensById.get(entry.tokenId ?? -1)?.display_name ?? "Unknown token",
      label: entry.bidScope === "collection" ? "Collection bid" : "Token bid",
      semantic: "bid" as const,
    };
  }

  const semantic = getActivityMarketType(entry) === "ask" ? "ask" : "sale";
  return {
    detail:
      collection.tokensById.get(entry.token_id)?.display_name ??
      String(entry.token_index),
    label:
      semantic === "ask"
        ? entry.is_private
          ? "Private ask"
          : "Ask"
        : entry.is_private
          ? "Private sale"
          : "Sale",
    semantic,
  };
}

function formatSignedPercent(value: number | undefined, digits = 1) {
  if (value === undefined) {
    return "--";
  }

  const normalized = Math.abs(value) <= 1 ? value * 100 : value;
  const prefix = normalized > 0 ? "+" : "";
  return `${prefix}${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(normalized)}%`;
}

function getContextWindowSeconds(window: ContextDeltaWindow) {
  const day = 24 * 60 * 60;
  switch (window) {
    case "1d":
      return day;
    case "1w":
      return 7 * day;
    case "1m":
      return 30 * day;
    case "3m":
      return 90 * day;
    case "6m":
      return 180 * day;
    case "1y":
    default:
      return 365 * day;
  }
}

function getFloorDeltaForWindow(
  context: CollectionData["context"],
  window: ContextDeltaWindow,
) {
  switch (window) {
    case "1d":
      return context.change_floor_pct_1d;
    case "1w":
      return context.change_floor_pct_7d;
    case "1m":
      return context.change_floor_pct_30d;
    case "3m":
      return context.change_floor_pct_90d;
    case "6m":
      return context.change_floor_pct_180d;
    case "1y":
    default:
      return context.change_floor_pct_365d;
  }
}

function getSnapshotAtOrBefore(
  snapshots: CollectionData["snapshots"],
  timestamp: number,
) {
  let candidate = snapshots[0];
  snapshots.forEach((snapshot) => {
    if (snapshot.timestamp <= timestamp) {
      candidate = snapshot;
    }
  });
  return candidate;
}

function getListedPctFromSnapshot(snapshot: CollectionData["snapshots"][number] | undefined) {
  if (!snapshot || snapshot.listing_count === undefined || !snapshot.token_count) {
    return undefined;
  }
  return snapshot.listing_count / snapshot.token_count;
}

function deriveListedDelta(
  collection: CollectionData,
  window: ContextDeltaWindow,
  referenceTimestamp: number,
) {
  const currentListedPct =
    collection.context.listed_pct ??
    getListedPctFromSnapshot(collection.snapshots[collection.snapshots.length - 1]);
  if (currentListedPct === undefined) {
    return undefined;
  }

  const priorSnapshot = getSnapshotAtOrBefore(
    collection.snapshots,
    referenceTimestamp - getContextWindowSeconds(window),
  );
  const priorListedPct = getListedPctFromSnapshot(priorSnapshot);
  if (priorListedPct === undefined || priorListedPct === 0) {
    return undefined;
  }

  return (currentListedPct - priorListedPct) / priorListedPct;
}

function getChangeTone(value: number | undefined) {
  if (value === undefined || value === 0) {
    return "neutral";
  }
  return value > 0 ? "up" : "down";
}

function getTraitDriverTier(collection: CollectionData, propertyId: number): TraitDriverTier {
  return collection.traitAnnotationsByPropertyId.get(propertyId)?.driver_tier ?? "Not";
}

function getPrimaryTraitRows(collection: CollectionData, traits: TokenTrait[]) {
  if (collection.traitAnnotations.length === 0) {
    return traits.slice(0, traitPreviewCount);
  }

  const primaryRows = traits.filter(
    (trait) => getTraitDriverTier(collection, trait.property_id) !== "Supporting",
  );
  return primaryRows.length > 0 ? primaryRows : traits.slice(0, traitPreviewCount);
}

function getInitialTraitSelection(collection: CollectionData, traits: TokenTrait[]) {
  const majorTraitIds = traits
    .filter((trait) => getTraitDriverTier(collection, trait.property_id) === "Major")
    .map((trait) => trait.property_id);

  if (majorTraitIds.length > 0) {
    return majorTraitIds.slice(0, Math.min(3, majorTraitIds.length));
  }

  return getDefaultTraitSelection(getPrimaryTraitRows(collection, traits));
}

function getTraitRowClasses(collection: CollectionData, propertyId: number, selected: boolean) {
  const annotation = collection.traitAnnotationsByPropertyId.get(propertyId);
  return cx(
    "trait-table-row",
    annotation?.class ? `trait-class-${annotation.class.toLowerCase()}` : "",
    annotation?.driver_tier ? `trait-tier-${annotation.driver_tier.toLowerCase()}` : "",
    selected ? "selected" : "",
  );
}

function getCollectionContextRows(
  collection: CollectionData,
  valueMode: ValueMode,
  window: ContextDeltaWindow,
  referenceTimestamp: number,
) {
  return [
    {
      change: getFloorDeltaForWindow(collection.context, window),
      label: "Floor",
      value: formatValue(
        collection.context.floor_eth,
        undefined,
        collection.metadata.eth_usd,
        valueMode,
      ),
    },
    {
      change:
        window === "1m" ? collection.context.change_median_sale_30d_vs_prev30d_pct : undefined,
      label: "30d median",
      value: formatValue(
        collection.context.median_sale_eth_30d,
        undefined,
        collection.metadata.eth_usd,
        valueMode,
      ),
    },
    {
      change: undefined,
      label: "Top bid",
      value: formatValue(
        collection.context.top_bid_eth,
        undefined,
        collection.metadata.eth_usd,
        valueMode,
      ),
    },
    {
      change: deriveListedDelta(collection, window, referenceTimestamp),
      label: "Listed",
      value: formatPercent(collection.context.listed_pct),
    },
    {
      change: undefined,
      label: "Volume 30d",
      value: formatValue(
        collection.context.sale_volume_eth_30d,
        collection.context.sale_volume_usd_30d,
        collection.metadata.eth_usd,
        valueMode,
      ),
    },
  ];
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

function resolveTokenSelection(collection: CollectionData, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const numericMatch = normalized.match(/\d+/);
  if (numericMatch) {
    const tokenNumber = Number(numericMatch[0]);
    if (collection.tokensByNumber.has(tokenNumber)) {
      return tokenNumber;
    }
  }

  const exact = collection.tokens.find((token) => {
    const label = token.display_name.toLowerCase();
    return (
      label === normalized ||
      token.token_index === normalized ||
      String(token.token_id) === normalized
    );
  });
  if (exact) {
    return exact.tokenNumber;
  }

  return collection.tokens.find((token) => {
    const label = `${token.display_name} ${token.token_id}`.toLowerCase();
    return label.includes(normalized);
  })?.tokenNumber;
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
  const [minBidEth, setMinBidEth] = useState<number>(() =>
    getStoredNumber("valuation.minBidEth", defaultMinBidEth),
  );
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

  useEffect(() => {
    window.localStorage.setItem("valuation.minBidEth", String(minBidEth));
  }, [minBidEth]);

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
  const handleSelectToken = (tokenNumber: number) =>
    startTransition(() => {
      const params = new URLSearchParams(route.params);
      params.set("token", String(tokenNumber));
      onNavigate(params);
    });
  const handleTokenJump = (query: string) => {
    const resolvedTokenNumber = resolveTokenSelection(collection, query);
    if (!resolvedTokenNumber) {
      return;
    }
    setSearch("");
    handleSelectToken(resolvedTokenNumber);
  };

  return (
    <main className="workbench-shell">
      <header className="workbench-header">
        <div className="header-primary">
          <button className="back-link" onClick={() => (window.location.hash = "/")} type="button">
            Collection index
          </button>
          <div className="header-copy-block">
            <p className="eyebrow">{collection.summary.artist}</p>
            <h1>{collection.summary.title}</h1>
          </div>
          <TokenJumpControl
            filteredTokens={filteredTokens}
            onChange={setSearch}
            onSubmit={handleTokenJump}
            search={search}
            selectedToken={selectedToken}
          />
        </div>
        <div className="header-actions">
          <div className="header-kpis">
            <HeaderKpi
              label="Floor"
              value={formatValue(
                collection.context.floor_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <HeaderKpi
              label="Top bid"
              value={formatValue(
                collection.context.top_bid_eth,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
            <HeaderKpi
              label="30d median"
              value={formatValue(
                collection.context.median_sale_eth_30d,
                undefined,
                collection.metadata.eth_usd,
                valueMode,
              )}
            />
          </div>
          <div className="header-toolbar">
            <BidFloorControl minBidEth={minBidEth} onChange={setMinBidEth} />
            <ValueModeToggle valueMode={valueMode} onChange={setValueMode} />
          </div>
        </div>
      </header>
      <section className="workbench-grid">
        <TokenWorkbenchPanels
          key={selectedToken.token_id}
          activeView={activeView}
          collection={collection}
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
            params.set("mode", mode);
            onNavigate(params);
          }}
          minBidEth={minBidEth}
          onSelectToken={handleSelectToken}
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
  minBidEth,
  neighborhoodMode,
  onActiveViewChange,
  onNeighborhoodModeChange,
  onSelectToken,
  selectedToken,
  valueMode,
}: {
  activeView: "timeline" | "neighborhood";
  collection: CollectionData;
  minBidEth: number;
  neighborhoodMode: NeighborhoodMode;
  onActiveViewChange: (view: "timeline" | "neighborhood") => void;
  onNeighborhoodModeChange: (mode: NeighborhoodMode) => void;
  onSelectToken: (tokenNumber: number) => void;
  selectedToken: TokenWithNumber;
  valueMode: ValueMode;
}) {
  const visibleTraits = getVisibleTraits(collection, selectedToken.token_id);
  const referenceTimestamp = getReferenceTimestamp(collection);
  const [contextWindow, setContextWindow] = useState<ContextDeltaWindow>("1m");
  const primaryTraitRows = getPrimaryTraitRows(collection, visibleTraits);
  const collectionContextRows = getCollectionContextRows(
    collection,
    valueMode,
    contextWindow,
    referenceTimestamp,
  );
  const tokenBids = useMemo(
    () =>
      (collection.tokenBidsByTokenId.get(selectedToken.token_id) ?? [])
        .filter((bid) => bid.status === "ACTIVE" && bid.is_active !== false)
        .filter((bid) => (bid.price_eth ?? 0) >= minBidEth)
        .slice(0, 6),
    [collection.tokenBidsByTokenId, minBidEth, selectedToken.token_id],
  );
  const collectionBids = useMemo(
    () =>
      collection.collectionBids
        .filter((bid) => bid.status === "ACTIVE" && bid.is_active !== false)
        .filter((bid) => (bid.price_eth ?? 0) >= minBidEth)
        .slice(0, 6),
    [collection.collectionBids, minBidEth],
  );
  const marketBand = summarizeMarketBand(selectedToken, tokenBids);
  const allTokenActivity = getTokenActivityHistory(collection, selectedToken.token_id);
  const [timelineScope, setTimelineScope] = useState<TimelineScope>("token");
  const [timelineRange, setTimelineRange] = useState<TimelineRange>("1y");
  const [neighborhoodSize, setNeighborhoodSize] = useState<NeighborhoodSizeOption>(50);
  const [showAllTraits, setShowAllTraits] = useState(false);
  const [activeTraits, setActiveTraits] = useState<number[]>(() =>
    getInitialTraitSelection(collection, visibleTraits),
  );
  const [inspectedTimelineKey, setInspectedTimelineKey] = useState<string | undefined>();
  const allNeighbors = deriveNeighbors(collection, selectedToken, neighborhoodMode, activeTraits);
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
      minBidEth,
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
          minBidEth,
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
      minBidEth,
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
    minBidEth,
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
  const neighborRelevance = useMemo(
    () =>
      new Map(
        visibleNeighbors.map((neighbor, index) => [
          neighbor.token.token_id,
          Math.max(0.2, (visibleNeighbors.length - index) / visibleNeighbors.length),
        ]),
      ),
    [visibleNeighbors],
  );
  const matchedTokens = useMemo(
    () =>
      (combinedTraits?.matchedTokenNumbers ?? [])
        .map((tokenNumber) => collection.tokensByNumber.get(tokenNumber))
        .filter((token): token is TokenWithNumber => token !== undefined)
        .slice(0, 12),
    [collection.tokensByNumber, combinedTraits?.matchedTokenNumbers],
  );

  return (
    <>
      <aside className="left-column">
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
            <TokenEvidenceRail
              collectionBidEth={collection.context.top_bid_eth}
              ethUsd={collection.metadata.eth_usd}
              modelEth={selectedToken.prediction_eth}
              selectedToken={selectedToken}
              tokenBidEth={marketBand.topBidEth}
              valueMode={valueMode}
            />
            <div className="token-pill-list">
              {tokenSignals.map((signal) => (
                <SignalPill key={signal.label} label={signal.label} tone={signal.tone} />
              ))}
            </div>
            <div className="token-evidence-strip">
              <Metric
                label="Ask"
                note={selectedToken.current_ask_eth ? "Live" : "None"}
                value={formatValue(
                  selectedToken.current_ask_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}
              />
              <Metric
                label="Last sale"
                note={formatRelativeAge(selectedToken.last_single_sale_ts, referenceTimestamp)}
                value={formatValue(
                  selectedToken.last_single_sale_eth,
                  selectedToken.last_single_sale_usd,
                  collection.metadata.eth_usd,
                  valueMode,
                )}
              />
              <Metric
                label="Best bid"
                note={marketBand.topBidEth ? "Token" : "Collection"}
                value={formatValue(
                  marketBand.topBidEth ?? collection.context.top_bid_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}
              />
              <Metric
                label="Model"
                value={formatValue(
                  selectedToken.prediction_eth,
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
              <h2>Compact context rows</h2>
            </div>
            <ContextDeltaToggle onChange={setContextWindow} value={contextWindow} />
          </div>
          <div className="context-table">
            <div className="context-table-head">
              <span>Delta</span>
              <span>Metric</span>
              <span>Value</span>
            </div>
            {collectionContextRows.map((row) => (
              <div className="context-table-row" key={row.label}>
                <span className={`context-delta ${getChangeTone(row.change)}`}>
                  {formatSignedPercent(row.change)}
                </span>
                <strong>{row.label}</strong>
                <span>{row.value}</span>
              </div>
            ))}
          </div>
          <p className="footnote">
            Floor delta follows the selected window. Listed delta is derived from snapshot
            history when available. Top bid and rolling volume still need historical series
            in the current collection JSON.
          </p>
        </section>

        <section className="panel inspector-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Decision synthesis</p>
              <h2>Compact frame</h2>
            </div>
          </div>
          <div className="decision-grid">
            <DecisionCard
              notes={[
                `Token ${formatValue(
                  marketBand.topBidEth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}`,
                `Collection ${formatValue(
                  collection.context.top_bid_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}`,
              ]}
              title="Support"
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
                `Floor ${formatValue(
                  selectedToken.adjusted_floor_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}`,
              ]}
              title="Working value"
              tone="fair"
              value={formatValue(
                marketBand.fairEth,
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
              <h2>Filtered support</h2>
            </div>
            <span className="pill muted">Floor {formatValue(minBidEth, undefined, 1, "eth")}</span>
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
              neighborhoodMode={neighborhoodMode}
              neighborhoodSize={neighborhoodSize}
              neighborhoodShownCount={visibleNeighbors.length}
              neighborRelevance={neighborRelevance}
              onNeighborhoodModeChange={onNeighborhoodModeChange}
              onNeighborhoodSizeChange={setNeighborhoodSize}
              onInspect={(entry) => setInspectedTimelineKey(getTimelineEntryKey(entry))}
              onRangeChange={setTimelineRange}
              onScopeChange={setTimelineScope}
              selectedTokenId={selectedToken.token_id}
              range={timelineRange}
              scope={timelineScope}
              totalNeighborCount={allNeighbors.length}
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
              selectedTraitCount={activeTraits.length}
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
              <span>Share</span>
              <span>Ask floor</span>
              <span>Latest clean sale</span>
              <span>Median 30d</span>
            </div>
            {(showAllTraits ? visibleTraits : primaryTraitRows).map(
              (trait) => {
                const enabled = activeTraits.includes(trait.property_id);
                const support = collection.traitSupportByPropertyId.get(trait.property_id);
                const annotation = collection.traitAnnotationsByPropertyId.get(trait.property_id);
                return (
                  <button
                    key={trait.property_id}
                    aria-pressed={enabled}
                    className={getTraitRowClasses(collection, trait.property_id, enabled)}
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
                      <small>
                        {trait.property_token_count} matching tokens
                        {annotation?.driver_tier ? ` / ${annotation.driver_tier}` : ""}
                        {annotation?.class ? ` / ${annotation.class}` : ""}
                      </small>
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
                      {support?.latest_clean_sale_ts ? (
                        <small className="age-pill">
                          {formatRelativeAge(support.latest_clean_sale_ts, referenceTimestamp)
                            .replace(" ago", "")}
                        </small>
                      ) : null}
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
            {visibleTraits.length > primaryTraitRows.length ? (
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
            {!showAllTraits && visibleTraits.length > primaryTraitRows.length ? (
              <span className="pill muted">
                {visibleTraits.length - primaryTraitRows.length} supporting row
                {visibleTraits.length - primaryTraitRows.length === 1 ? "" : "s"} hidden
              </span>
            ) : null}
          </div>
          {combinedTraits && activeTraits.length >= 2 ? (
            <>
              <div className="trait-combined-row">
                <span className="trait-check combined">+</span>
                <span className="trait-copy">
                  <strong>Combined traits</strong>
                  <small>
                    {selectedTraitRows.map((trait) => trait.property_name).join(" + ")}
                  </small>
                </span>
                <span>{formatPercent(combinedTraits.matchedTokenShare)}</span>
                <span>
                  {formatValue(
                    combinedTraits.askFloorEth,
                    undefined,
                    collection.metadata.eth_usd,
                    valueMode,
                  )}
                </span>
                <span>
                  {formatValue(
                    combinedTraits.latestSaleEth,
                    combinedTraits.latestSaleUsd,
                    collection.metadata.eth_usd,
                    valueMode,
                  )}
                </span>
                <span>
                  {formatValue(
                    combinedTraits.combinedMedianEth,
                    undefined,
                    collection.metadata.eth_usd,
                    valueMode,
                  )}
                </span>
              </div>
              <div className="combined-token-strip">
                {matchedTokens.length > 0 ? (
                  matchedTokens.map((token) => (
                    <button
                      key={token.token_id}
                      className="combined-token-card"
                      onClick={() => onSelectToken(token.tokenNumber)}
                      type="button"
                    >
                      <TokenThumbnail slug={collection.summary.slug} token={token} />
                      <div className="combined-token-copy">
                        <strong>{token.display_name}</strong>
                        <small>
                          {formatValue(
                            token.current_ask_eth ?? token.last_single_sale_eth,
                            token.last_single_sale_usd,
                            collection.metadata.eth_usd,
                            valueMode,
                          )}
                        </small>
                      </div>
                    </button>
                  ))
                ) : (
                  <span className="pill muted">No current overlap in local token records</span>
                )}
              </div>
            </>
          ) : (
            <p className="footnote">
              Select at least two rows to see their intersection and matching tokens.
            </p>
          )}
        </section>
      </section>
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
  const externalUrl = getTokenExternalUrl(slug, token.token_index);

  if (!src || failed) {
    return <TokenFallback rarityBucket={rarityBucket} token={token} />;
  }

  return (
    <a
      className="token-artwork-frame"
      href={externalUrl ?? src}
      rel="noreferrer"
      target="_blank"
      title="Open full-resolution artwork"
    >
      <img
        alt={alt}
        className="token-artwork"
        loading="lazy"
        onError={() => setFailed(true)}
        src={src}
      />
      <span className="token-artwork-hint">Full image</span>
    </a>
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

function ContextDeltaToggle({
  onChange,
  value,
}: {
  onChange: (value: ContextDeltaWindow) => void;
  value: ContextDeltaWindow;
}) {
  return (
    <div className="segmented-control compact">
      {contextDeltaOptions.map((option) => (
        <button
          key={option.value}
          className={value === option.value ? "selected" : ""}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function BidFloorControl({
  minBidEth,
  onChange,
}: {
  minBidEth: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="bid-floor-control">
      <span>Min bid</span>
      <input
        min="0"
        onChange={(event) => {
          const nextValue = Number(event.target.value);
          onChange(Number.isFinite(nextValue) ? nextValue : 0);
        }}
        step="0.001"
        type="number"
        value={String(minBidEth)}
      />
      <small>Ξ</small>
    </label>
  );
}

function TokenEvidenceRail({
  collectionBidEth,
  ethUsd,
  modelEth,
  selectedToken,
  tokenBidEth,
  valueMode,
}: {
  collectionBidEth?: number;
  ethUsd: number;
  modelEth?: number;
  selectedToken: TokenWithNumber;
  tokenBidEth?: number;
  valueMode: ValueMode;
}) {
  const markers = [
    {
      id: "support",
      label: tokenBidEth !== undefined ? "Token bid" : "Collection bid",
      tone: "support",
      value: tokenBidEth ?? collectionBidEth,
    },
    {
      id: "floor",
      label: "Adj. floor",
      tone: "floor",
      value: selectedToken.adjusted_floor_eth,
    },
    {
      id: "model",
      label: "Model",
      tone: "model",
      value: modelEth,
    },
    {
      id: "sale",
      label: "Last sale",
      tone: "sale",
      value: selectedToken.last_single_sale_eth,
    },
    {
      id: "ask",
      label: "Ask",
      tone: "ask",
      value: selectedToken.current_ask_eth,
    },
  ].filter(
    (marker): marker is { id: string; label: string; tone: string; value: number } =>
      typeof marker.value === "number" && Number.isFinite(marker.value),
  );

  if (markers.length === 0) {
    return null;
  }

  const minValue = Math.min(...markers.map((marker) => marker.value));
  const maxValue = Math.max(...markers.map((marker) => marker.value));
  const spread = Math.max(maxValue - minValue, 0.001);

  return (
    <div className="token-evidence-rail">
      <div className="token-evidence-track" />
      {markers.map((marker, index) => {
        const left = ((marker.value - minValue) / spread) * 100;
        return (
          <div
            className={`token-evidence-marker ${marker.tone} ${index % 2 === 0 ? "high" : "low"}`}
            key={marker.id}
            style={{ left: `${left}%` }}
          >
            <span className="token-evidence-dot" />
            <div className="token-evidence-label">
              <strong>{marker.label}</strong>
              <small>{formatValue(marker.value, undefined, ethUsd, valueMode)}</small>
            </div>
          </div>
        );
      })}
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

function HeaderKpi({ label, value }: { label: string; value: string }) {
  return (
    <span className="header-kpi">
      <strong>{label}</strong>
      <span>{value}</span>
    </span>
  );
}

function TokenJumpControl({
  filteredTokens,
  onChange,
  onSubmit,
  search,
  selectedToken,
}: {
  filteredTokens: TokenWithNumber[];
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  search: string;
  selectedToken: TokenWithNumber;
}) {
  const listId = "token-jump-options";

  return (
    <form
      className="token-jump-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(search);
      }}
    >
      <label className="token-jump-label" htmlFor="token-jump-input">
        Token
      </label>
      <input
        className="token-jump-input"
        id="token-jump-input"
        list={listId}
        onChange={(event) => onChange(event.target.value)}
        placeholder={String(selectedToken.tokenNumber)}
        value={search}
      />
      <datalist id={listId}>
        {filteredTokens.map((token) => (
          <option key={token.token_id} value={String(token.tokenNumber)}>
            {token.display_name}
          </option>
        ))}
      </datalist>
      <button className="token-jump-button" type="submit">
        Go
      </button>
      <span className="token-jump-current">{selectedToken.display_name}</span>
    </form>
  );
}

function Metric({ label, note, value }: { label: string; note?: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
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
    { label: "Ξ", value: "eth" },
    { label: "USD", value: "usd" },
    { label: "USD + Ξ", value: "usd-eth" },
    { label: "Ξ + USD", value: "eth-usd" },
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
  neighborRelevance,
  neighborhoodMode,
  neighborhoodSize,
  neighborhoodShownCount,
  onNeighborhoodModeChange,
  onNeighborhoodSizeChange,
  onInspect,
  onRangeChange,
  onScopeChange,
  range,
  scope,
  selectedTokenId,
  totalNeighborCount,
  valueMode,
}: {
  collection: CollectionData;
  entries: TimelineEntry[];
  ethUsd: number;
  inspectedEntry?: TimelineEntry;
  legend: TimelineLegend;
  neighborRelevance: Map<number, number>;
  neighborhoodMode: NeighborhoodMode;
  neighborhoodSize: NeighborhoodSizeOption;
  neighborhoodShownCount: number;
  onNeighborhoodModeChange: (mode: NeighborhoodMode) => void;
  onNeighborhoodSizeChange: (size: NeighborhoodSizeOption) => void;
  onInspect: (entry: TimelineEntry) => void;
  onRangeChange: (range: TimelineRange) => void;
  onScopeChange: (scope: TimelineScope) => void;
  range: TimelineRange;
  scope: TimelineScope;
  selectedTokenId: number;
  totalNeighborCount: number;
  valueMode: ValueMode;
}) {
  const [hoveredEntryKey, setHoveredEntryKey] = useState<string | undefined>();
  const [visibleSeries, setVisibleSeries] = useState<Record<TimelineSeriesKey, boolean>>({
    sale: true,
    ask: true,
    bid: true,
    private: true,
  });
  const filteredEntries = useMemo(
    () =>
      entries.filter((entry) => {
        const series = getTimelineSeriesKey(entry);
        return visibleSeries[series];
      }),
    [entries, visibleSeries],
  );
  const chartEntries = [...filteredEntries].sort((left, right) => left.timestamp - right.timestamp);
  const referenceValues = [
    collection.context.floor_eth,
    collection.context.median_sale_eth_30d,
    collection.context.top_bid_eth,
  ].filter((value): value is number => typeof value === "number" && value > 0);
  const chartValues = chartEntries
    .map((entry) => getTimelineEntryValue(entry))
    .filter((value): value is number => Number.isFinite(value) && value > 0);
  const rawMin = Math.min(...(chartValues.length > 0 ? chartValues : [0]), ...referenceValues);
  const rawMax = Math.max(...(chartValues.length > 0 ? chartValues : [1]), ...referenceValues, 1);
  const pricePadding = Math.max((rawMax - rawMin) * 0.16, rawMax * 0.06, 0.75);
  const minPrice = Math.max(0, rawMin - pricePadding);
  const maxPrice = rawMax + pricePadding;
  const timestamps = chartEntries.map((entry) => entry.timestamp);
  const minTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : 1;
  const frame = {
    bottom: 246,
    height: 214,
    left: 56,
    right: 732,
    top: 32,
    width: 676,
  };
  const getX = (timestamp: number) =>
    frame.left +
    ((timestamp - minTimestamp) / Math.max(maxTimestamp - minTimestamp, 1)) * frame.width;
  const getY = (value: number) =>
    frame.bottom -
    ((value - minPrice) / Math.max(maxPrice - minPrice, 1)) * frame.height;
  const linePoints = chartEntries.map((entry) => {
    const x = getX(entry.timestamp);
    const y = getY(getTimelineEntryValue(entry));
    return { x, y };
  });
  const linePath =
    scope === "aggregate" && linePoints.length > 1 ? describePath(linePoints) : "";
  const yTicks = buildLinearTicks(minPrice, maxPrice, 5);
  const xTicks = buildLinearTicks(minTimestamp, maxTimestamp, 5);
  const floorReference = collection.context.floor_eth;
  const medianReference = collection.context.median_sale_eth_30d;
  const topBidReference = collection.context.top_bid_eth;
  const floorY =
    typeof floorReference === "number" ? getY(floorReference) : undefined;
  const medianY = typeof medianReference === "number" ? getY(medianReference) : undefined;
  const topBidY = typeof topBidReference === "number" ? getY(topBidReference) : undefined;
  const chartNote =
    scope === "neighborhood"
      ? `${neighborhoodShownCount} neighborhood tokens shown in this view.`
      : scope === "aggregate"
        ? "Aggregate buckets smooth token-level noise into collection-wide windows."
        : "Bid markers reflect active local bid snapshots only.";
  const neighborhoodModes: Array<{
    disabled?: boolean;
    label: string;
    value: NeighborhoodMode;
  }> = [
    { label: "Trait", value: "trait" },
    { label: "Rarity", value: "rarity" },
    { label: "Visual", value: "visual", disabled: true },
    { label: "Curated", value: "curated", disabled: true },
  ];
  const referenceTimestamp = getReferenceTimestamp(collection);
  const seriesCounts: Record<TimelineSeriesKey, number> = {
    sale: entries.filter((entry) => getTimelineSeriesKey(entry) === "sale").length,
    ask: entries.filter((entry) => getTimelineSeriesKey(entry) === "ask").length,
    bid: entries.filter((entry) => getTimelineSeriesKey(entry) === "bid").length,
    private: entries.filter((entry) => getTimelineSeriesKey(entry) === "private").length,
  };
  const activeEntry =
    filteredEntries.find((entry) => getTimelineEntryKey(entry) === hoveredEntryKey) ??
    (inspectedEntry &&
    filteredEntries.some(
      (entry) => getTimelineEntryKey(entry) === getTimelineEntryKey(inspectedEntry),
    )
      ? inspectedEntry
      : filteredEntries[0]);
  const prioritizedEntries = [...filteredEntries].sort((left, right) => {
    const leftTokenId = isTimelineBidEntry(left)
      ? left.tokenId
      : isAggregateTimelineEntry(left)
        ? undefined
        : left.token_id;
    const rightTokenId = isTimelineBidEntry(right)
      ? right.tokenId
      : isAggregateTimelineEntry(right)
        ? undefined
        : right.token_id;
    const leftPriority =
      (leftTokenId === selectedTokenId ? 100 : 0) +
      (getTimelineSeriesKey(left) === "sale" ? 40 : 0) +
      (getTimelineSeriesKey(left) === "ask" ? 30 : 0) +
      (neighborRelevance.get(leftTokenId ?? -1) ?? 0) * 20;
    const rightPriority =
      (rightTokenId === selectedTokenId ? 100 : 0) +
      (getTimelineSeriesKey(right) === "sale" ? 40 : 0) +
      (getTimelineSeriesKey(right) === "ask" ? 30 : 0) +
      (neighborRelevance.get(rightTokenId ?? -1) ?? 0) * 20;
    if (rightPriority !== leftPriority) {
      return rightPriority - leftPriority;
    }
    return right.timestamp - left.timestamp;
  });

  function getEntryRelevance(entry: TimelineEntry) {
    if (isAggregateTimelineEntry(entry)) {
      return 0.72;
    }
    if (isTimelineBidEntry(entry)) {
      if (entry.bidScope === "collection") {
        return 0.62;
      }
      if (entry.tokenId === selectedTokenId) {
        return 1;
      }
      return neighborRelevance.get(entry.tokenId ?? -1) ?? 0.35;
    }
    if (entry.token_id === selectedTokenId) {
      return 1;
    }
    return neighborRelevance.get(entry.token_id) ?? 0.42;
  }

  return (
    <section className="timeline-card">
      <div className="timeline-toolbar">
        <div className="segmented-control wrap compact">
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
        <div className="segmented-control wrap compact">
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
      <div className="timeline-subhead">
        <div className="timeline-legend toggles">
          <span className="legend-pill">Shown {filteredEntries.length}</span>
          {(["sale", "ask", "bid", "private"] as TimelineSeriesKey[]).map((series) => (
            <button
              key={series}
              className={cx(
                "legend-pill",
                series,
                visibleSeries[series] ? "selected" : "muted-off",
              )}
              onClick={() =>
                setVisibleSeries((current) => ({
                  ...current,
                  [series]: !current[series],
                }))
              }
              type="button"
            >
              {series} {seriesCounts[series]}
            </button>
          ))}
          <span className="legend-pill">Tokens {legend.tokenCount}</span>
          {typeof floorReference === "number" ? (
            <span className="legend-pill reference">
              floor {formatTimelineAxisValue(floorReference)}
            </span>
          ) : null}
          {typeof medianReference === "number" ? (
            <span className="legend-pill reference">
              30d median {formatTimelineAxisValue(medianReference)}
            </span>
          ) : null}
          {typeof topBidReference === "number" ? (
            <span className="legend-pill reference">
              top bid {formatTimelineAxisValue(topBidReference)}
            </span>
          ) : null}
        </div>
        <p className="timeline-caption">{getTimelineScopeSummary(scope)}</p>
      </div>
      {scope === "neighborhood" ? (
        <div className="definition-box">
          <div className="definition-copy">
            <strong>Neighborhood definition</strong>
            <small>These settings drive the evidence set without switching you away from timeline view.</small>
          </div>
          <div className="definition-actions">
            <div className="segmented-control wrap compact">
              {neighborhoodModes.map((entry) => (
                <button
                  key={entry.value}
                  className={neighborhoodMode === entry.value ? "selected" : ""}
                  disabled={entry.disabled}
                  onClick={() => !entry.disabled && onNeighborhoodModeChange(entry.value)}
                  type="button"
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <div className="segmented-control wrap compact">
              {neighborhoodSizeOptions.map((option) => (
                <button
                  key={`timeline-neighborhood-${String(option)}`}
                  className={neighborhoodSize === option ? "selected" : ""}
                  onClick={() => onNeighborhoodSizeChange(option)}
                  type="button"
                >
                  {option === "max" ? "Max" : option}
                </button>
              ))}
            </div>
            <span className="legend-pill">
              {neighborhoodShownCount} shown / {totalNeighborCount} total
            </span>
          </div>
        </div>
      ) : null}
      {entries.length === 0 ? (
        <div className="empty-state">
          <strong>No priced events in the selected window.</strong>
          <small>Switch recency or scope to review older local history.</small>
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="empty-state">
          <strong>All visible series are currently hidden.</strong>
          <small>Turn one or more legend toggles back on to repopulate the chart.</small>
        </div>
      ) : (
        <>
          <div className="timeline-chart-frame compact">
            {activeEntry ? (
              <ChartInspectorCard
                collection={collection}
                entry={activeEntry}
                ethUsd={ethUsd}
                referenceTimestamp={referenceTimestamp}
                valueMode={valueMode}
              />
            ) : null}
            <svg className="timeline-chart" viewBox="0 0 760 288" role="img">
              <rect
                className="timeline-plot-surface"
                height={frame.height}
                rx={18}
                width={frame.width}
                x={frame.left}
                y={frame.top}
              />
              {typeof floorY === "number" && typeof medianY === "number" ? (
                <rect
                  className="timeline-reference-band"
                  height={Math.abs(floorY - medianY)}
                  width={frame.width}
                  x={frame.left}
                  y={Math.min(floorY, medianY)}
                />
              ) : null}
              {yTicks.map((tick) => (
                <g key={`y-${tick.toFixed(2)}`}>
                  <line
                    className="timeline-grid-line"
                    x1={frame.left}
                    x2={frame.right}
                    y1={getY(tick)}
                    y2={getY(tick)}
                  />
                  <text
                    className="timeline-axis-label"
                    textAnchor="end"
                    x={frame.left - 10}
                    y={getY(tick) + 4}
                  >
                    {formatTimelineAxisValue(tick)}
                  </text>
                </g>
              ))}
              {xTicks.map((tick, index) => (
                <g key={`x-${index}-${tick.toFixed(0)}`}>
                  <line
                    className="timeline-grid-line vertical"
                    x1={getX(tick)}
                    x2={getX(tick)}
                    y1={frame.top}
                    y2={frame.bottom}
                  />
                  <text
                    className="timeline-axis-label"
                    textAnchor="middle"
                    x={getX(tick)}
                    y={frame.bottom + 24}
                  >
                    {formatTimelineAgeTick(tick, maxTimestamp)}
                  </text>
                </g>
              ))}
              <line
                className="axis-line"
                x1={frame.left}
                x2={frame.left}
                y1={frame.top}
                y2={frame.bottom}
              />
              <line
                className="axis-line"
                x1={frame.left}
                x2={frame.right}
                y1={frame.bottom}
                y2={frame.bottom}
              />
              {typeof medianReference === "number" && typeof medianY === "number" ? (
                <line
                  className="timeline-reference-line median"
                  x1={frame.left}
                  x2={frame.right}
                  y1={medianY}
                  y2={medianY}
                />
              ) : null}
              {typeof topBidReference === "number" && typeof topBidY === "number" ? (
                <line
                  className="timeline-reference-line bid"
                  x1={frame.left}
                  x2={frame.right}
                  y1={topBidY}
                  y2={topBidY}
                />
              ) : null}
              {linePath ? <path className="timeline-path" d={linePath} /> : null}
              {chartEntries.map((entry, index) => {
                const point = linePoints[index] ?? { x: frame.left, y: frame.bottom };
                const privateMark =
                  !isAggregateTimelineEntry(entry) &&
                  !isTimelineBidEntry(entry) &&
                  (entry.is_private || entry.kind.includes("private"));
                const selected = inspectedEntry
                  ? getTimelineEntryKey(inspectedEntry) === getTimelineEntryKey(entry)
                  : false;
                const semantic = getTimelineEntrySemantic(entry);
                const relevance = getEntryRelevance(entry);
                const markerOpacity = Math.min(1, 0.4 + relevance * 0.6);
                const className = [
                  "timeline-dot",
                  semantic,
                  privateMark ? "private" : "",
                  selected ? "selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                if (semantic === "ask") {
                  const size = selected ? 16 : 11 + relevance * 6;
                  return (
                    <g key={getTimelineEntryKey(entry)}>
                      <rect
                        className={className}
                        height={size}
                        opacity={markerOpacity}
                        onClick={() => onInspect(entry)}
                        onMouseEnter={() => setHoveredEntryKey(getTimelineEntryKey(entry))}
                        onMouseLeave={() => setHoveredEntryKey(undefined)}
                        rx={2}
                        transform={`rotate(45 ${point.x} ${point.y})`}
                        width={size}
                        x={point.x - size / 2}
                        y={point.y - size / 2}
                      />
                    </g>
                  );
                }

                if (semantic === "bid") {
                  const offset = selected ? 9 : 6 + relevance * 4;
                  return (
                    <g key={getTimelineEntryKey(entry)}>
                      <polygon
                        className={className}
                        opacity={markerOpacity}
                        onClick={() => onInspect(entry)}
                        onMouseEnter={() => setHoveredEntryKey(getTimelineEntryKey(entry))}
                        onMouseLeave={() => setHoveredEntryKey(undefined)}
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
                      opacity={markerOpacity}
                      onClick={() => onInspect(entry)}
                      onMouseEnter={() => setHoveredEntryKey(getTimelineEntryKey(entry))}
                      onMouseLeave={() => setHoveredEntryKey(undefined)}
                      r={selected ? 9 : semantic === "aggregate" ? 5.5 + relevance * 3 : 4 + relevance * 4}
                    />
                  </g>
                );
              })}
            </svg>
            <div className="timeline-axis-notes">
              <span>Price axis in Ξ. Marker size and opacity track local relevance.</span>
              <span>{chartNote}</span>
            </div>
          </div>
          <div className="timeline-anchor-list">
            {prioritizedEntries.slice(0, 6).map((entry) => {
              const selected = inspectedEntry
                ? getTimelineEntryKey(inspectedEntry) === getTimelineEntryKey(entry)
                : false;
              const anchor = describeTimelineAnchor(entry, collection);
              const value = isAggregateTimelineEntry(entry)
                ? formatValue(entry.medianPriceEth, undefined, ethUsd, valueMode)
                : isTimelineBidEntry(entry)
                  ? formatValue(entry.priceEth, entry.priceUsd, ethUsd, valueMode)
                  : formatValue(entry.price_eth, entry.price_usd, ethUsd, valueMode);
              return (
                <button
                  key={getTimelineEntryKey(entry)}
                  className={selected ? "timeline-anchor active" : "timeline-anchor"}
                  onClick={() => onInspect(entry)}
                  onMouseEnter={() => setHoveredEntryKey(getTimelineEntryKey(entry))}
                  onMouseLeave={() => setHoveredEntryKey(undefined)}
                  type="button"
                >
                  <span className={`timeline-anchor-type ${anchor.semantic}`}>{anchor.label}</span>
                  <div className="timeline-anchor-copy">
                    <strong>{anchor.detail}</strong>
                    <small>{formatCompactDate(entry.timestamp)}</small>
                  </div>
                  <span className="timeline-anchor-value">{value}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function ChartInspectorCard({
  collection,
  entry,
  ethUsd,
  referenceTimestamp,
  valueMode,
}: {
  collection: CollectionData;
  entry: TimelineEntry;
  ethUsd: number;
  referenceTimestamp: number;
  valueMode: ValueMode;
}) {
  const anchor = describeTimelineAnchor(entry, collection);
  const token = isAggregateTimelineEntry(entry)
    ? undefined
    : isTimelineBidEntry(entry)
      ? collection.tokensById.get(entry.tokenId ?? -1)
      : collection.tokensById.get(entry.token_id);
  const value = isAggregateTimelineEntry(entry)
    ? formatValue(entry.medianPriceEth, undefined, ethUsd, valueMode)
    : isTimelineBidEntry(entry)
      ? formatValue(entry.priceEth, entry.priceUsd, ethUsd, valueMode)
      : formatValue(entry.price_eth, entry.price_usd, ethUsd, valueMode);

  return (
    <div className="chart-inspector-card">
      {token ? <TokenThumbnail slug={collection.summary.slug} token={token} /> : null}
      <div className="chart-inspector-copy">
        <div className="chart-inspector-topline">
          <span className={`timeline-anchor-type ${anchor.semantic}`}>{anchor.label}</span>
          <strong>{value}</strong>
        </div>
        <div className="chart-inspector-title">{anchor.detail}</div>
        <div className="chart-inspector-meta">
          <span>{formatCompactDate(entry.timestamp)}</span>
          <span>{formatRelativeAge(entry.timestamp, referenceTimestamp)}</span>
        </div>
      </div>
    </div>
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
  selectedTraitCount,
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
  selectedTraitCount: number;
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
        <div className="segmented-control wrap compact">
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
        <div className="segmented-control wrap compact">
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
          ? ` Trait mode is currently using ${selectedTraitCount} selected trait row${selectedTraitCount === 1 ? "" : "s"}.`
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
      {inspectedNeighbor ? (
        <div className="chart-inspector-card neighbor">
          <TokenThumbnail slug={collectionSlug} token={inspectedNeighbor.token} />
          <div className="chart-inspector-copy">
            <div className="chart-inspector-topline">
              <span className="timeline-anchor-type ask">Neighbor</span>
              <strong>
                {formatValue(
                  inspectedNeighbor.token.current_ask_eth,
                  undefined,
                  ethUsd,
                  valueMode,
                )}
              </strong>
            </div>
            <div className="chart-inspector-title">{inspectedNeighbor.token.display_name}</div>
            <div className="chart-inspector-meta">
              <span>{inspectedNeighbor.sharedTraitCount} shared traits</span>
              <span>rarity gap {formatDistance(inspectedNeighbor.rarityGap)}</span>
            </div>
          </div>
        </div>
      ) : null}
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
  const maxBidEth = Math.max(...bids.map((bid) => bid.price_eth ?? 0), 0.0001);

  return (
    <div className="bid-list">
      <p className="eyebrow">{title}</p>
      {bids.length === 0 ? (
        <p className="footnote">No active bids in the local snapshot.</p>
      ) : (
        bids.map((bid) => (
          <div
            key={bid.bid_id}
            className="bid-row"
            style={
              {
                "--bid-strength": `${Math.max(0.12, (bid.price_eth ?? 0) / maxBidEth)}`,
              } as CSSProperties
            }
          >
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
