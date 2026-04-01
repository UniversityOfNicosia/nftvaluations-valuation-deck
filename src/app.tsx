import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  calculateMedian,
  listCollections,
  loadCollection,
  loadTokenSnapshots,
} from "./data/loadCollections.ts";
import type { TokenSnapshotPoint } from "./data/loadCollections.ts";
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
import type { ValuationModel } from "./lib/derive.ts";
import {
  formatCompactDate,
  formatDate,
  formatDateTime,
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

function getDeltaForWindow(
  context: CollectionData["context"],
  prefix: string,
  window: ContextDeltaWindow,
) {
  const suffixMap: Record<ContextDeltaWindow, string> = {
    "1d": "_1d",
    "1w": "_7d",
    "1m": "_30d",
    "3m": "_90d",
    "6m": "_180d",
    "1y": "_365d",
  };
  const key = `${prefix}${suffixMap[window]}` as keyof typeof context;
  const value = context[key];
  return typeof value === "number" ? value : undefined;
}

function getFloorDeltaForWindow(
  context: CollectionData["context"],
  window: ContextDeltaWindow,
) {
  return getDeltaForWindow(context, "change_floor_pct", window);
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
  return collection.traitAnnotationsByPropertyId.get(propertyId)?.driver_tier ?? "Not a driver";
}

function getPrimaryTraitRows(collection: CollectionData, traits: TokenTrait[]) {
  if (collection.traitAnnotations.length === 0) {
    return traits.slice(0, traitPreviewCount);
  }

  const primaryRows = traits.filter((trait) => {
    const annotation = collection.traitAnnotationsByPropertyId.get(trait.property_id);
    if (!annotation) return false;
    const isMajor = annotation.driver_tier === "Major driver";
    const isHighClass = annotation.class === "Grail" || annotation.class === "Positive";
    return isMajor || isHighClass;
  });
  return primaryRows.length > 0 ? primaryRows : traits.slice(0, traitPreviewCount);
}

function getInitialTraitSelection(collection: CollectionData, traits: TokenTrait[]) {
  const selected = traits.filter((trait) => {
    const annotation = collection.traitAnnotationsByPropertyId.get(trait.property_id);
    if (!annotation) return false;
    const isMajor = annotation.driver_tier === "Major driver";
    const isHighClass = annotation.class === "Grail" || annotation.class === "Positive";
    return isMajor || isHighClass;
  }).map((trait) => trait.property_id);

  if (selected.length > 0) {
    return selected;
  }

  return getDefaultTraitSelection(getPrimaryTraitRows(collection, traits));
}

type SynthesisEvidence = {
  text: string;
  age?: string;
  strength: "strong" | "medium" | "weak";
};

type SynthesisSide = {
  value: number | undefined;
  evidence: SynthesisEvidence[];
};

function buildDecisionSynthesis(
  token: TokenWithNumber,
  marketBand: { topBidEth?: number; fairEth?: number; listEth?: number },
  neighbors: Array<{ token: TokenWithNumber; sharedTraitCount: number }>,
  collection: CollectionData,
  referenceTimestamp: number,
): { bid: SynthesisSide; fair: SynthesisSide; list: SynthesisSide } {
  const valid = (v: number | undefined) => v != null && Number.isFinite(v) && v > 0 ? v : undefined;
  const ageLabel = (ts: number | undefined) => {
    if (!ts) return undefined;
    const days = (referenceTimestamp - ts) / (24 * 60 * 60);
    if (days <= 0) return "now";
    if (days < 1) return "< 1d";
    if (days < 30) return `${Math.round(days)}d`;
    if (days < 365) return `${Math.round(days / 30)}m`;
    return `${Math.round(days / 365)}y`;
  };
  const recencyStrength = (ts: number | undefined): "strong" | "medium" | "weak" => {
    if (!ts) return "weak";
    const days = (referenceTimestamp - ts) / (24 * 60 * 60);
    if (days <= 90) return "strong";
    if (days <= 365) return "medium";
    return "weak";
  };

  const tokenBid = valid(marketBand.topBidEth);
  const collBid = valid(collection.context.top_bid_eth);
  const adjFloor = valid(token.adjusted_floor_eth);
  const nfti = valid(token.prediction_eth);
  const lastSale = valid(token.last_single_sale_eth);
  const lastSaleTs = token.last_single_sale_ts;
  const currentAsk = valid(token.current_ask_eth);

  // Build credible neighbor lanes from top 10 closest neighbors
  const topNeighbors = neighbors.slice(0, 10);
  const neighborSales = topNeighbors
    .filter((n) => valid(n.token.last_single_sale_eth) && n.token.last_single_sale_ts)
    .sort((a, b) => (b.token.last_single_sale_ts ?? 0) - (a.token.last_single_sale_ts ?? 0));
  const neighborAsks = topNeighbors
    .filter((n) => valid(n.token.current_ask_eth))
    .sort((a, b) => (a.token.current_ask_eth ?? 0) - (b.token.current_ask_eth ?? 0));

  const neighborSaleValues = neighborSales.map((n) => n.token.last_single_sale_eth ?? 0);
  const laneLow = neighborSaleValues.length > 0 ? Math.min(...neighborSaleValues) : undefined;
  const laneHigh = neighborSaleValues.length > 0 ? Math.max(...neighborSaleValues) : undefined;
  const laneCenter = laneLow != null && laneHigh != null ? (laneLow + laneHigh) / 2 : undefined;

  const upperNeighborAsks = neighborAsks.map((n) => n.token.current_ask_eth ?? 0);
  const upperLane = upperNeighborAsks.length > 0 ? Math.max(...upperNeighborAsks) : undefined;

  // === BID SIDE ===
  const bidEvidence: SynthesisEvidence[] = [];
  let bidValue: number | undefined;

  // 1. Meaningful token bid
  if (tokenBid && adjFloor && tokenBid >= adjFloor * 0.5) {
    bidValue = tokenBid;
    bidEvidence.push({ text: `Token bid ${tokenBid.toFixed(2)} Ξ`, strength: "strong" });
  } else if (tokenBid) {
    bidEvidence.push({ text: `Token bid ${tokenBid.toFixed(2)} Ξ — weak`, strength: "weak" });
  }

  // 2. Lower neighbor lane
  if (laneLow != null && !bidValue) {
    bidValue = laneLow;
    bidEvidence.push({ text: `Lower neighbor lane ${laneLow.toFixed(2)} Ξ`, strength: "medium" });
  } else if (laneLow != null && bidEvidence.length < 3) {
    bidEvidence.push({ text: `Lower neighbor lane ${laneLow.toFixed(2)} Ξ`, strength: "medium" });
  }

  // 3. Adjusted floor fallback
  if (!bidValue && adjFloor) {
    bidValue = adjFloor;
    bidEvidence.push({ text: `Adj. floor ${adjFloor.toFixed(2)} Ξ (fallback)`, strength: "medium" });
  } else if (adjFloor && bidEvidence.length < 3) {
    bidEvidence.push({ text: `Adj. floor ${adjFloor.toFixed(2)} Ξ`, strength: "medium" });
  }

  // Collection bid as context only
  if (collBid && bidEvidence.length < 3) {
    bidEvidence.push({ text: `Collection bid ${collBid.toFixed(2)} Ξ (context)`, strength: "weak" });
  }

  // === FAIR VALUE ===
  const fairEvidence: SynthesisEvidence[] = [];
  let fairValue: number | undefined;
  let fairIsModelLed = false;

  // 1. Own last sale if relevant
  if (lastSale && lastSaleTs && recencyStrength(lastSaleTs) !== "weak") {
    fairValue = lastSale;
    fairEvidence.push({
      text: `Own sale ${lastSale.toFixed(2)} Ξ`,
      age: ageLabel(lastSaleTs),
      strength: recencyStrength(lastSaleTs),
    });
  } else if (lastSale && lastSaleTs) {
    // Stale — show as reference, don't drive value
    fairEvidence.push({
      text: `Own sale ${lastSale.toFixed(2)} Ξ (stale)`,
      age: ageLabel(lastSaleTs),
      strength: "weak",
    });
  }

  // 2. Center of neighbor lane
  if (laneCenter != null && neighborSales.length >= 2) {
    if (!fairValue) {
      fairValue = laneCenter;
    }
    fairEvidence.push({
      text: `Neighbor lane ${laneLow!.toFixed(1)}–${laneHigh!.toFixed(1)} Ξ`,
      strength: "medium",
    });
  } else if (neighborSales.length === 1) {
    const ns = neighborSales[0];
    if (!fairValue) {
      fairValue = ns.token.last_single_sale_eth;
    }
    fairEvidence.push({
      text: `${ns.token.display_name} sold ${(ns.token.last_single_sale_eth ?? 0).toFixed(2)} Ξ`,
      age: ageLabel(ns.token.last_single_sale_ts),
      strength: recencyStrength(ns.token.last_single_sale_ts),
    });
  }

  // 3. Model outputs as reference
  if (!fairValue) {
    fairValue = nfti ?? adjFloor;
    fairIsModelLed = true;
  }
  if (nfti && fairEvidence.length < 3) {
    fairEvidence.push({
      text: `NFTi ${nfti.toFixed(2)} Ξ${fairIsModelLed ? " (model-led)" : ""}`,
      strength: fairIsModelLed ? "medium" : "weak",
    });
  }
  if (adjFloor && adjFloor !== nfti && fairEvidence.length < 3) {
    fairEvidence.push({ text: `Adj. floor ${adjFloor.toFixed(2)} Ξ`, strength: "weak" });
  }

  // === LIST SIDE ===
  const listEvidence: SynthesisEvidence[] = [];
  let listValue: number | undefined;

  // Build upper neighbor lane for validation
  const upperAskLane = upperNeighborAsks.length > 0
    ? { low: Math.min(...upperNeighborAsks), high: Math.max(...upperNeighborAsks) }
    : undefined;

  // 1. Current ask — validate against neighbor lane
  if (currentAsk && upperAskLane) {
    if (currentAsk <= upperAskLane.high * 1.15) {
      // Inside credible lane
      listValue = currentAsk;
      listEvidence.push({
        text: `Current ask ${currentAsk.toFixed(2)} Ξ`,
        age: ageLabel(token.current_ask_start_ts),
        strength: "strong",
      });
    } else {
      // Above lane — reject
      const pctAbove = fairValue ? ((currentAsk - fairValue) / fairValue * 100).toFixed(0) : "?";
      listEvidence.push({
        text: `Current ask ${currentAsk.toFixed(2)} Ξ (+${pctAbove}% vs fair) — rejected`,
        strength: "weak",
      });
    }
  } else if (currentAsk && !upperAskLane) {
    // No neighbor asks to validate against — accept cautiously
    listValue = currentAsk;
    listEvidence.push({
      text: `Current ask ${currentAsk.toFixed(2)} Ξ (no comps to validate)`,
      age: ageLabel(token.current_ask_start_ts),
      strength: "medium",
    });
  }

  // 2. Upper neighbor lane
  if (upperLane != null && !listValue) {
    listValue = upperLane;
  }
  if (neighborAsks.length > 0 && listEvidence.length < 3) {
    const closest = neighborAsks[0];
    listEvidence.push({
      text: `${closest.token.display_name} ask ${(closest.token.current_ask_eth ?? 0).toFixed(2)} Ξ`,
      strength: "medium",
    });
  }
  if (neighborAsks.length >= 3 && listEvidence.length < 3) {
    listEvidence.push({
      text: `Upper comp lane to ${upperLane!.toFixed(2)} Ξ`,
      strength: "weak",
    });
  }

  // 3. Fallback only if nothing else
  if (!listValue && fairValue) {
    listValue = fairValue * 1.15;
    listEvidence.push({ text: `Fallback: fair +15% (no market evidence)`, strength: "weak" });
  }

  return {
    bid: { value: bidValue, evidence: bidEvidence.slice(0, 3) },
    fair: { value: fairValue, evidence: fairEvidence.slice(0, 3) },
    list: { value: listValue, evidence: listEvidence.slice(0, 3) },
  };
}

function getSaleRecencyTone(saleTs: number | undefined, referenceTs: number): string {
  if (!saleTs) return "";
  const days = (referenceTs - saleTs) / (24 * 60 * 60);
  if (days <= 7) return "recency-fresh";
  if (days <= 21) return "recency-recent";
  if (days <= 45) return "recency-aging";
  if (days <= 90) return "recency-stale";
  return "recency-old";
}

function driverTierSlug(tier: TraitDriverTier): string {
  if (tier === "Major driver") return "major";
  if (tier === "Supporting driver") return "supporting";
  return "not";
}

function getTraitRowClasses(collection: CollectionData, propertyId: number, selected: boolean) {
  const annotation = collection.traitAnnotationsByPropertyId.get(propertyId);
  return cx(
    "trait-table-row",
    annotation?.class ? `trait-class-${annotation.class.toLowerCase()}` : "",
    annotation?.driver_tier ? `trait-tier-${driverTierSlug(annotation.driver_tier)}` : "",
    selected ? "selected" : "",
  );
}

function getCollectionContextRows(
  collection: CollectionData,
  valueMode: ValueMode,
  window: ContextDeltaWindow,
) {
  const ctx = collection.context;
  return [
    {
      change: getDeltaForWindow(ctx, "change_floor_pct", window),
      label: "Floor",
      value: formatValue(ctx.floor_eth, undefined, collection.metadata.eth_usd, valueMode),
    },
    {
      change: getDeltaForWindow(ctx, "change_median_sale_30d_pct", window),
      label: "30d median",
      value: formatValue(ctx.median_sale_eth_30d, undefined, collection.metadata.eth_usd, valueMode),
    },
    {
      change: undefined,
      label: "Top bid",
      value: formatValue(ctx.top_bid_eth, undefined, collection.metadata.eth_usd, valueMode),
    },
    {
      change: getDeltaForWindow(ctx, "change_listed_pct", window),
      label: "Listed",
      value: formatPercent(ctx.listed_pct),
    },
    {
      change: getDeltaForWindow(ctx, "change_sale_volume_30d_pct", window),
      label: "Volume 30d",
      value: formatValue(ctx.sale_volume_eth_30d, ctx.sale_volume_usd_30d, collection.metadata.eth_usd, valueMode),
    },
    {
      change: getDeltaForWindow(ctx, "change_af_market_cap_pct", window),
      label: "AF market cap",
      value: formatValue(ctx.af_market_cap_eth, undefined, collection.metadata.eth_usd, valueMode),
    },
    {
      change: getDeltaForWindow(ctx, "change_nfti_market_cap_pct", window),
      label: "NFTi market cap",
      value: formatValue(ctx.nfti_market_cap_eth, undefined, collection.metadata.eth_usd, valueMode),
    },
  ].filter((row) => row.value !== "—");
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
      <div className="landing-header">
        <p className="eyebrow">NFT Valuations</p>
        <h1>Valuation Deck</h1>
        <p className="landing-subtitle">
          Evidence-first valuation workbench for NFT collections.
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
              <p className="eyebrow">{collection.artist}</p>
              <h2>{collection.title}</h2>
              <div className="collection-card-stats">
                <div className="landing-stat">
                  <small>Floor</small>
                  <strong>{formatValue(collection.floorEth, undefined, collection.ethUsd, "eth-usd")}</strong>
                </div>
                <div className="landing-stat">
                  <small>Top bid</small>
                  <strong>{formatValue(collection.topBidEth, undefined, collection.ethUsd, "eth-usd")}</strong>
                </div>
                <div className="landing-stat">
                  <small>Snapshot</small>
                  <strong>{formatDate(collection.snapshotTs)}</strong>
                </div>
              </div>
              <span className="landing-cta">Open workbench &rarr;</span>
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
  const [tokenSnapshots, setTokenSnapshots] = useState<TokenSnapshotPoint[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadTokenSnapshots(collection.summary.slug, selectedToken.token_id).then((data) => {
      if (!cancelled) setTokenSnapshots(data);
    });
    return () => { cancelled = true; };
  }, [collection.summary.slug, selectedToken.token_id]);
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
                <h2>
                  {selectedToken.display_name}
                  <span className="token-info-trigger">
                    <svg
                      className="token-info-icon"
                      fill="none"
                      height="14"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      width="14"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" x2="12" y1="16" y2="12" />
                      <line x1="12" x2="12.01" y1="8" y2="8" />
                    </svg>
                    <div className="token-info-popover">
                      <div className="token-info-row">
                        <span>Token ID</span>
                        <span>{selectedToken.token_index}</span>
                      </div>
                      {selectedToken.mint_ts ? (
                        <div className="token-info-row">
                          <span>Minted</span>
                          <span>{formatDate(selectedToken.mint_ts)}</span>
                        </div>
                      ) : null}
                      {selectedToken.rarity_rank != null ? (
                        <div className="token-info-row">
                          <span>Rarity rank</span>
                          <span>#{selectedToken.rarity_rank}</span>
                        </div>
                      ) : null}
                      {selectedToken.rarity_score != null ? (
                        <div className="token-info-row">
                          <span>Rarity score</span>
                          <span>{selectedToken.rarity_score.toFixed(2)}</span>
                        </div>
                      ) : null}
                      {selectedToken.highest_sale_eth != null ? (
                        <div className="token-info-row">
                          <span>Highest sale</span>
                          <span>
                            {formatValue(
                              selectedToken.highest_sale_eth,
                              undefined,
                              collection.metadata.eth_usd,
                              valueMode,
                            )}
                          </span>
                        </div>
                      ) : null}
                      {selectedToken.quantity != null && selectedToken.quantity > 1 ? (
                        <div className="token-info-row">
                          <span>Quantity</span>
                          <span>{selectedToken.quantity}</span>
                        </div>
                      ) : null}
                    </div>
                  </span>
                </h2>
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
                {selectedToken.rarity_rank != null ? ` #${selectedToken.rarity_rank}` : ""}
              </span>
            </div>
            <div className="valuation-hero-card nfti">
              <span className="valuation-hero-label">NFTi valuation</span>
              <span className="valuation-hero-value">
                {formatValue(
                  selectedToken.prediction_eth,
                  undefined,
                  collection.metadata.eth_usd,
                  valueMode,
                )}
              </span>
              {selectedToken.prediction_eth != null ? (
                <ValuationRangeBar
                  activeAskEth={selectedToken.current_ask_eth}
                  activeBidEth={marketBand.topBidEth}
                  ethUsd={collection.metadata.eth_usd}
                  fairEth={selectedToken.prediction_eth}
                  valueMode={valueMode}
                />
              ) : null}
            </div>
            <DataTable
              columns={[
                { header: "Metric", key: "metric" },
                { header: "Value", key: "value" },
                { header: "Note", key: "note" },
              ]}
              rows={[
                {
                  cells: {
                    metric: "Ask",
                    note: selectedToken.current_ask_eth
                      ? formatRelativeAge(selectedToken.current_ask_start_ts, referenceTimestamp)
                      : "None",
                    value: formatValue(
                      selectedToken.current_ask_eth,
                      undefined,
                      collection.metadata.eth_usd,
                      valueMode,
                    ),
                  },
                  titles: selectedToken.current_ask_start_ts
                    ? { note: formatDateTime(selectedToken.current_ask_start_ts) }
                    : undefined,
                },
                {
                  cells: {
                    metric: "Last Sale",
                    note: formatRelativeAge(
                      selectedToken.last_single_sale_ts,
                      referenceTimestamp,
                    ),
                    value: formatValue(
                      selectedToken.last_single_sale_eth,
                      selectedToken.last_single_sale_usd,
                      collection.metadata.eth_usd,
                      valueMode,
                    ),
                  },
                  titles: selectedToken.last_single_sale_ts
                    ? { note: formatDateTime(selectedToken.last_single_sale_ts) }
                    : undefined,
                },
                {
                  cells: {
                    metric: "Best Bid",
                    note: marketBand.topBidEth ? "Token" : "Collection",
                    value: formatValue(
                      marketBand.topBidEth ?? collection.context.top_bid_eth,
                      undefined,
                      collection.metadata.eth_usd,
                      valueMode,
                    ),
                  },
                },
                {
                  cells: {
                    metric: "Adj. Floor",
                    note: "Valuation",
                    value: formatValue(
                      selectedToken.adjusted_floor_eth,
                      undefined,
                      collection.metadata.eth_usd,
                      valueMode,
                    ),
                  },
                  className: "valuation-row",
                },
              ]}
            />
          </div>
        </section>

        <section className="panel context-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Collection context</p>
            </div>
            <ContextDeltaToggle onChange={setContextWindow} value={contextWindow} />
          </div>
          <DataTable
            columns={[
              { header: "Delta", key: "delta" },
              { header: "Metric", key: "metric" },
              { header: "Value", key: "value" },
            ]}
            rows={collectionContextRows.map((row) => ({
              cells: {
                delta: (
                  <span className={`context-delta ${getChangeTone(row.change)}`}>
                    {formatSignedPercent(row.change)}
                  </span>
                ),
                metric: row.label,
                value: row.value,
              },
            }))}
          />
        </section>

        {(() => {
          const synthesis = buildDecisionSynthesis(
            selectedToken,
            marketBand,
            visibleNeighbors,
            collection,
            referenceTimestamp,
          );
          return (
            <section className="panel synthesis-card">
              <div className="section-head">
                <p className="eyebrow">Decision synthesis</p>
                <span className="pill experimental-tag">Placeholder</span>
              </div>
              <div className="synthesis-grid">
                <div className="synthesis-block bid">
                  <div className="synthesis-block-head">
                    <span className="synthesis-block-title">Bid-side</span>
                    <strong className="synthesis-block-value">
                      {formatValue(synthesis.bid.value, undefined, collection.metadata.eth_usd, valueMode)}
                    </strong>
                  </div>
                  <div className="synthesis-evidence">
                    {synthesis.bid.evidence.map((ev, i) => (
                      <span key={i} className={`synthesis-ev ${ev.strength}`}>
                        {ev.text}
                        {ev.age ? <small className="ev-age">{ev.age}</small> : null}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="synthesis-block fair">
                  <div className="synthesis-block-head">
                    <span className="synthesis-block-title">Fair value</span>
                    <strong className="synthesis-block-value">
                      {formatValue(synthesis.fair.value, undefined, collection.metadata.eth_usd, valueMode)}
                    </strong>
                  </div>
                  <div className="synthesis-evidence">
                    {synthesis.fair.evidence.map((ev, i) => (
                      <span key={i} className={`synthesis-ev ${ev.strength}`}>
                        {ev.text}
                        {ev.age ? <small className="ev-age">{ev.age}</small> : null}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="synthesis-block list">
                  <div className="synthesis-block-head">
                    <span className="synthesis-block-title">List-side</span>
                    <strong className="synthesis-block-value">
                      {formatValue(synthesis.list.value, undefined, collection.metadata.eth_usd, valueMode)}
                    </strong>
                  </div>
                  <div className="synthesis-evidence">
                    {synthesis.list.evidence.map((ev, i) => (
                      <span key={i} className={`synthesis-ev ${ev.strength}`}>
                        {ev.text}
                        {ev.age ? <small className="ev-age">{ev.age}</small> : null}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          );
        })()}

      </aside>

      <section className="center-column">
        <section className="panel evidence-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Market evidence</p>
              <h2>{activeView === "timeline" ? "Timeline view" : "Similarity map"}</h2>
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
                Similarity
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
              tokenSnapshots={tokenSnapshots}
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
          </div>
          <div className="trait-table has-class-col">
            <div className="trait-table-head">
              <span></span>
              <span>Trait</span>
              <span>Class</span>
              <span>Ask floor</span>
              <span>Best bid</span>
              <span>Last sale</span>
              <span>30d sale median</span>
            </div>
            {(showAllTraits ? visibleTraits : primaryTraitRows).map(
              (trait) => {
                const enabled = activeTraits.includes(trait.property_id);
                const support = collection.traitSupportByPropertyId.get(trait.property_id);
                const annotation = collection.traitAnnotationsByPropertyId.get(trait.property_id);
                const traitBid = support?.top_bid_eth;
                const collectionBid = collection.context.top_bid_eth;
                const bestBid = traitBid != null && traitBid > (collectionBid ?? 0)
                  ? { value: traitBid, source: "Trait" }
                  : collectionBid != null
                    ? { value: collectionBid, source: "Collection" }
                    : undefined;
                const saleTone = getSaleRecencyTone(
                  support?.latest_clean_sale_ts,
                  referenceTimestamp,
                );
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
                    <span className={cx("trait-check", enabled && "checked")}>{enabled ? "\u25A0" : ""}</span>
                    <span className="trait-copy">
                      <strong>{trait.property_name}</strong>
                      <small>
                        {trait.category_name} &middot; {trait.property_token_count} tokens
                      </small>
                    </span>
                    <span className="trait-class-cell">
                      {annotation?.class ? (
                        <span className={`trait-class-badge class-${annotation.class.toLowerCase()}`}>
                          {annotation.class}
                        </span>
                      ) : (
                        <span className="trait-class-badge class-none">&mdash;</span>
                      )}
                    </span>
                    <span className="trait-value trait-value-primary">
                      {formatValue(
                        support?.ask_floor_eth ?? trait.property_floor_eth,
                        undefined,
                        collection.metadata.eth_usd,
                        valueMode,
                      )}
                    </span>
                    <span className="trait-value">
                      {bestBid ? (
                        <span className="trait-bid-stack">
                          <span>{formatValue(bestBid.value, undefined, collection.metadata.eth_usd, valueMode)}</span>
                          <small className="bid-source-pill">{bestBid.source}</small>
                        </span>
                      ) : "—"}
                    </span>
                    <span className="trait-value">
                      {formatValue(
                        support?.latest_clean_sale_eth ?? trait.property_last_sale_eth,
                        support?.latest_clean_sale_usd ?? trait.property_last_sale_usd,
                        collection.metadata.eth_usd,
                        valueMode,
                      )}
                      {support?.latest_clean_sale_ts ? (
                        <small className={cx("age-pill", saleTone)}>
                          {formatRelativeAge(support.latest_clean_sale_ts, referenceTimestamp)
                            .replace(" ago", "")}
                        </small>
                      ) : null}
                    </span>
                    <span className="trait-value">
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
            {combinedTraits && activeTraits.length >= 2 ? (
              <div className="trait-table-footer">
                <div className="trait-table-footer-label">
                  <strong>Intersection</strong>
                  <small>
                    {selectedTraitRows.map((trait) => trait.property_name).join(" + ")}
                    {" "}&middot; {combinedTraits.matchedTokenCount} token{combinedTraits.matchedTokenCount === 1 ? "" : "s"}
                    {" "}({formatPercent(combinedTraits.matchedTokenShare)})
                  </small>
                </div>
                <span className="trait-value trait-value-primary">
                  {formatValue(combinedTraits.askFloorEth, undefined, collection.metadata.eth_usd, valueMode)}
                </span>
                <span className="trait-value">&mdash;</span>
                <span className="trait-value">
                  {formatValue(
                    combinedTraits.latestSaleEth,
                    combinedTraits.latestSaleUsd,
                    collection.metadata.eth_usd,
                    valueMode,
                  )}
                </span>
                <span className="trait-value">
                  {formatValue(combinedTraits.combinedMedianEth, undefined, collection.metadata.eth_usd, valueMode)}
                </span>
              </div>
            ) : null}
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
            <div className="trait-intersection">
              <div className="trait-intersection-header">
                <p className="eyebrow">Trait intersection</p>
              </div>
              <p className="footnote trait-intersection-desc">
                <strong>{combinedTraits.matchedTokenCount} token{combinedTraits.matchedTokenCount === 1 ? "" : "s"}</strong> sharing{" "}
                <strong>{selectedTraitRows.map((trait) => trait.property_name).join(" + ")}</strong>.
                Click any token to navigate to it.
              </p>
              {matchedTokens.length > 0 ? (
                <table className="data-table neighbor-data-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Name</th>
                      <th>Rarity</th>
                      <th>Ask</th>
                      <th>NFTi</th>
                      <th>Adj. Floor</th>
                      <th>Last Sale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchedTokens.map((token) => {
                      const imgSrc = getTokenImageUrl(collection.summary.slug, token.token_index);
                      return (
                        <tr
                          key={token.token_id}
                          onClick={() => onSelectToken(token.tokenNumber)}
                          style={{ cursor: "pointer" }}
                        >
                          <td className="neighbor-thumb-cell">
                            {imgSrc ? (
                              <ImageHoverPopover alt={token.display_name} src={imgSrc} />
                            ) : null}
                          </td>
                          <td>
                            <strong>{token.display_name}</strong>
                          </td>
                          <td className="table-note">
                            {deriveRarityBucket(token.rarityPercentile)?.label ?? "—"}
                          </td>
                          <td>
                            <strong>
                              {formatValue(token.current_ask_eth, undefined, collection.metadata.eth_usd, valueMode)}
                            </strong>
                          </td>
                          <td>
                            {formatValue(token.prediction_eth, undefined, collection.metadata.eth_usd, valueMode)}
                          </td>
                          <td>
                            {formatValue(token.adjusted_floor_eth, undefined, collection.metadata.eth_usd, valueMode)}
                          </td>
                          <td>
                            {formatValue(token.last_single_sale_eth, token.last_single_sale_usd, collection.metadata.eth_usd, valueMode)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="footnote">No matching tokens found</p>
              )}
            </div>
          ) : (
            <p className="footnote">
              Select at least two trait rows above to see their intersection and matching tokens.
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
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const src = getTokenImageUrl(slug, token.token_index);

  if (!src || failed) {
    return <TokenFallback rarityBucket={rarityBucket} token={token} />;
  }

  return (
    <>
      <button
        className="token-artwork-frame"
        onClick={() => setLightboxOpen(true)}
        title="View full image"
        type="button"
      >
        <img
          alt={alt}
          className="token-artwork"
          loading="lazy"
          onError={() => setFailed(true)}
          src={src}
        />
        <span className="token-artwork-hint">Full image</span>
      </button>
      {lightboxOpen
        ? createPortal(
            <div className="lightbox-overlay" onClick={() => setLightboxOpen(false)}>
              <button
                className="lightbox-close"
                onClick={() => setLightboxOpen(false)}
                type="button"
              >
                &times;
              </button>
              <img
                alt={alt}
                className="lightbox-image"
                onClick={(e) => e.stopPropagation()}
                src={src}
              />
            </div>,
            document.body,
          )
        : null}
    </>
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

type DataTableColumn = {
  header: string;
  key: string;
};

type DataTableRow = {
  cells: Record<string, React.ReactNode>;
  className?: string;
  titles?: Record<string, string>;
};

function DataTable({ columns, rows }: { columns: DataTableColumn[]; rows: DataTableRow[] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key}>{col.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr className={row.className} key={i}>
            {columns.map((col) => (
              <td
                className={col.key === columns[columns.length - 1].key ? "table-note" : undefined}
                key={col.key}
                title={row.titles?.[col.key]}
              >
                {row.cells[col.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
            <span>Fallback visual / rarity rank {token.rarity_rank ?? "—"}</span>
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
  tokenSnapshots,
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
  tokenSnapshots: TokenSnapshotPoint[];
  totalNeighborCount: number;
  valueMode: ValueMode;
}) {
  const [hoveredEntryKey, setHoveredEntryKey] = useState<string | undefined>();
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | undefined>();
  const [valuationOverlay, setValuationOverlay] = useState<"nfti" | "af" | "off">("nfti");
  const [keyEventsOpen, setKeyEventsOpen] = useState(true);
  const chartFrameRef = useRef<HTMLDivElement>(null);
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
  const timestamps = chartEntries.map((entry) => entry.timestamp);
  const minTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : 1;
  const visibleSnapshots = scope === "token" && valuationOverlay !== "off"
    ? tokenSnapshots.filter((s) => s.timestamp >= minTimestamp && s.timestamp <= maxTimestamp)
    : [];
  const snapshotValues = visibleSnapshots.map((s) =>
    valuationOverlay === "af" ? s.adjusted_floor_eth : s.nfti_eth,
  ).filter((v) => Number.isFinite(v) && v > 0);
  const rawMin = Math.min(...(chartValues.length > 0 ? chartValues : [0]), ...referenceValues, ...(snapshotValues.length > 0 ? snapshotValues : []));
  const rawMax = Math.max(...(chartValues.length > 0 ? chartValues : [1]), ...referenceValues, ...(snapshotValues.length > 0 ? snapshotValues : []), 1);
  const pricePadding = Math.max((rawMax - rawMin) * 0.16, rawMax * 0.06, 0.75);
  const minPrice = Math.max(0, rawMin - pricePadding);
  const maxPrice = rawMax + pricePadding;
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
  const valuationPath = (() => {
    if (scope !== "token" || valuationOverlay === "off" || visibleSnapshots.length < 2) return "";
    const points = visibleSnapshots
      .filter((s) => s.timestamp >= minTimestamp && s.timestamp <= maxTimestamp)
      .map((s) => ({
        x: getX(s.timestamp),
        y: getY(valuationOverlay === "af" ? s.adjusted_floor_eth : s.nfti_eth),
      }));
    return points.length >= 2 ? describePath(points) : "";
  })();
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
  const handleDotEnter = useCallback(
    (entry: TimelineEntry, event: React.MouseEvent<SVGElement>) => {
      setHoveredEntryKey(getTimelineEntryKey(entry));
      const frame = chartFrameRef.current;
      if (frame) {
        const rect = frame.getBoundingClientRect();
        setTooltipPos({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      }
    },
    [],
  );
  const handleDotMove = useCallback(
    (event: React.MouseEvent<SVGElement>) => {
      const frame = chartFrameRef.current;
      if (frame) {
        const rect = frame.getBoundingClientRect();
        setTooltipPos({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      }
    },
    [],
  );
  const handleDotLeave = useCallback(() => {
    setHoveredEntryKey(undefined);
    setTooltipPos(undefined);
  }, []);
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
      <div className="chart-controls-bar">
        <div className="chart-control-group">
          <span className="chart-control-label">Filter by type</span>
          <div className="timeline-legend toggles">
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
                {series === "sale" ? "● " : series === "ask" ? "◆ " : series === "bid" ? "▲ " : "● "}{series} {seriesCounts[series]}
              </button>
            ))}
          </div>
        </div>
        {scope === "token" ? (
          <div className="chart-control-group">
            <span className="chart-control-label">Valuation overlay</span>
            <div className="segmented-control wrap compact">
              <button
                className={valuationOverlay === "nfti" ? "selected" : ""}
                onClick={() => setValuationOverlay((c) => c === "nfti" ? "off" : "nfti")}
                type="button"
              >
                NFTi
              </button>
              <button
                className={valuationOverlay === "af" ? "selected" : ""}
                onClick={() => setValuationOverlay((c) => c === "af" ? "off" : "af")}
                type="button"
              >
                Adj. Floor
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {scope === "neighborhood" ? (
        <div className="definition-box">
          <div className="chart-controls-bar">
            <div className="chart-control-group">
              <span className="chart-control-label">
                Similarity mode
                <InfoTip>
                  <p className="explainer-text">How neighbors are ranked:</p>
                  <ul className="explainer-list">
                    <li><strong>Trait</strong> — shared visible traits, weighted by rarity and value proximity</li>
                    <li><strong>Rarity</strong> — closeness in rarity rank and adjusted floor value</li>
                    <li><strong>Visual / Curated</strong> — placeholders for future modes</li>
                  </ul>
                </InfoTip>
              </span>
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
            </div>
            <div className="chart-control-group">
              <span className="chart-control-label">
                Pool size
                <InfoTip>
                  <p className="explainer-text">
                    How many neighbor tokens to include. Smaller pools focus on the closest matches; larger pools show more of the collection.
                  </p>
                </InfoTip>
              </span>
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
            </div>
            <span className="chart-info-pill">{neighborhoodShownCount} shown &middot; {totalNeighborCount} total</span>
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
          <div className="timeline-chart-frame compact" ref={chartFrameRef}>
            {hoveredEntryKey && activeEntry && tooltipPos ? (
              <ChartTooltip
                collection={collection}
                entry={activeEntry}
                ethUsd={ethUsd}
                containerRef={chartFrameRef}
                pos={tooltipPos}
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
              {linePath ? <path className="timeline-path" d={linePath} /> : null}
              {valuationPath ? <path className="valuation-line" d={valuationPath} /> : null}
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
                        onMouseEnter={(e) => handleDotEnter(entry, e)}
                        onMouseMove={handleDotMove}
                        onMouseLeave={handleDotLeave}
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
                        onMouseEnter={(e) => handleDotEnter(entry, e)}
                        onMouseMove={handleDotMove}
                        onMouseLeave={handleDotLeave}
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
                      onMouseEnter={(e) => handleDotEnter(entry, e)}
                      onMouseMove={handleDotMove}
                      onMouseLeave={handleDotLeave}
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
          <div className="timeline-key-events">
            <button
              className="timeline-key-events-header"
              onClick={() => setKeyEventsOpen((c) => !c)}
              type="button"
            >
              <h3>Key events <span className="collapse-indicator">{keyEventsOpen ? "▾" : "▸"}</span></h3>
              <span className="token-info-trigger">
                <svg
                  className="token-info-icon"
                  fill="none"
                  height="13"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  width="13"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" x2="12" y1="16" y2="12" />
                  <line x1="12" x2="12.01" y1="8" y2="8" />
                </svg>
                <div className="token-info-popover explainer-popover">
                  <p className="explainer-text">
                    Top market events for this token, sorted by relevance:
                  </p>
                  <ul className="explainer-list">
                    <li>Events from the selected token rank highest</li>
                    <li>Sales rank above asks, asks above bids</li>
                    <li>More recent events break ties</li>
                  </ul>
                  <p className="explainer-hint">
                    Hover a row to highlight it on the chart.
                  </p>
                </div>
              </span>
            </button>
            {keyEventsOpen ? (
            <div className="timeline-anchor-list">
              {prioritizedEntries.slice(0, 6).map((entry) => {
                const selected = inspectedEntry
                  ? getTimelineEntryKey(inspectedEntry) === getTimelineEntryKey(entry)
                  : false;
                const anchor = describeTimelineAnchor(entry, collection);
                const entryToken = isAggregateTimelineEntry(entry)
                  ? undefined
                  : isTimelineBidEntry(entry)
                    ? collection.tokensById.get(entry.tokenId ?? -1)
                    : collection.tokensById.get(entry.token_id);
                const entryImgSrc = entryToken
                  ? getTokenImageUrl(collection.summary.slug, entryToken.token_index)
                  : undefined;
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
                    {entryImgSrc ? (
                      <ImageHoverPopover alt={anchor.detail} src={entryImgSrc} />
                    ) : null}
                    <span className={`timeline-anchor-type ${anchor.semantic}`}>{anchor.label}</span>
                    <span className="timeline-anchor-detail">{anchor.detail}</span>
                    <span className="timeline-anchor-date">{formatCompactDate(entry.timestamp)}</span>
                    <span className="timeline-anchor-value">{value}</span>
                  </button>
                );
              })}
            </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function ValuationRangeBar({
  activeAskEth,
  activeBidEth,
  ethUsd,
  fairEth,
  valueMode,
}: {
  activeAskEth?: number;
  activeBidEth?: number;
  ethUsd: number;
  fairEth: number;
  valueMode: ValueMode;
}) {
  // Dummy bid/ask spread: ±10% of fair value
  const modelBidEth = fairEth * 0.9;
  const modelAskEth = fairEth * 1.1;
  const rangeWidth = ((modelAskEth - modelBidEth) / fairEth) * 100;
  const confidence = 68;

  // The bar spans from 0% to 100% with model bid at 20%, fair at 50%, model ask at 80%
  // Map real values onto this scale: modelBidEth=20%, fairEth=50%, modelAskEth=80%
  // Linear: pct = 20 + (value - modelBidEth) / (modelAskEth - modelBidEth) * 60
  const spread = modelAskEth - modelBidEth;
  const toPct = (v: number) => Math.max(2, Math.min(98, 20 + ((v - modelBidEth) / spread) * 60));

  const activeBidPct = activeBidEth != null ? toPct(activeBidEth) : undefined;
  const activeAskPct = activeAskEth != null ? toPct(activeAskEth) : undefined;

  return (
    <div className="valuation-range">
      <div className="valuation-range-bar">
        <div className="valuation-range-fill" />
        <div className="valuation-range-marker bid" style={{ left: "20%" }} />
        <div className="valuation-range-marker fair" style={{ left: "50%" }} />
        <div className="valuation-range-marker ask" style={{ left: "80%" }} />
        {activeBidPct != null ? (
          <span className="valuation-live-dot live-bid" style={{ left: `${activeBidPct}%` }}>
            <span className="valuation-live-popover">
              Active bid: {formatValue(activeBidEth, undefined, ethUsd, valueMode)}
            </span>
          </span>
        ) : null}
        {activeAskPct != null ? (
          <span className="valuation-live-dot live-ask" style={{ left: `${activeAskPct}%` }}>
            <span className="valuation-live-popover">
              Active ask: {formatValue(activeAskEth, undefined, ethUsd, valueMode)}
            </span>
          </span>
        ) : null}
      </div>
      <div className="valuation-range-labels">
        <span className="valuation-range-label" style={{ left: "20%" }}>
          <small>Fair Bid</small>
          {formatValue(modelBidEth, undefined, ethUsd, valueMode)}
        </span>
        <span className="valuation-range-label" style={{ left: "50%" }}>
          <small>Fair Value</small>
        </span>
        <span className="valuation-range-label" style={{ left: "80%" }}>
          <small>Fair Ask</small>
          {formatValue(modelAskEth, undefined, ethUsd, valueMode)}
        </span>
      </div>
      <div className="valuation-range-meta">
        <span className="valuation-confidence">
          <small>Confidence</small>
          <strong>{confidence}<span className="confidence-max">/100</span></strong>
        </span>
      </div>
    </div>
  );
}

function InfoTip({ children }: { children: React.ReactNode }) {
  return (
    <span className="token-info-trigger">
      <svg className="token-info-icon" fill="none" height="12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="12">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" x2="12" y1="16" y2="12" />
        <line x1="12" x2="12.01" y1="8" y2="8" />
      </svg>
      <div className="token-info-popover explainer-popover">
        {children}
      </div>
    </span>
  );
}

function ImageHoverPopover({ alt, src }: { alt: string; src: string }) {
  const thumbRef = useRef<HTMLImageElement>(null);
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  const handleEnter = () => {
    const el = thumbRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setPos({
        left: rect.left + rect.width / 2,
        top: rect.top,
      });
    }
    setShow(true);
  };

  return (
    <span className="image-hover-popover" onMouseEnter={handleEnter} onMouseLeave={() => setShow(false)}>
      <img alt={alt} className="image-hover-thumb" loading="lazy" ref={thumbRef} src={src} />
      {show
        ? createPortal(
            <span
              className="image-hover-enlarged"
              style={{ left: pos.left, top: pos.top }}
            >
              <img alt={alt} src={src} />
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

function ChartTooltip({
  collection,
  containerRef,
  entry,
  ethUsd,
  pos,
  referenceTimestamp,
  valueMode,
}: {
  collection: CollectionData;
  containerRef: { current: HTMLDivElement | null };
  entry: TimelineEntry;
  ethUsd: number;
  pos: { x: number; y: number };
  referenceTimestamp: number;
  valueMode: ValueMode;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
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

  const containerWidth = containerRef.current?.offsetWidth ?? 800;
  const containerHeight = containerRef.current?.offsetHeight ?? 400;
  const tooltipWidth = tooltipRef.current?.offsetWidth ?? 240;
  const tooltipHeight = tooltipRef.current?.offsetHeight ?? 100;

  const gap = 12;
  let left = pos.x + gap;
  let top = pos.y - tooltipHeight - gap;

  if (left + tooltipWidth > containerWidth) {
    left = pos.x - tooltipWidth - gap;
  }
  if (left < 0) {
    left = gap;
  }
  if (top < 0) {
    top = pos.y + gap;
  }
  if (top + tooltipHeight > containerHeight) {
    top = containerHeight - tooltipHeight - gap;
  }

  const imgSrc = token ? getTokenImageUrl(collection.summary.slug, token.token_index) : undefined;

  return (
    <div
      className="chart-tooltip has-thumb"
      ref={tooltipRef}
      style={{ left, top }}
    >
      {imgSrc ? (
        <img alt={anchor.detail} className="chart-tooltip-thumb" src={imgSrc} />
      ) : null}
      <div className="chart-tooltip-body">
        <div className="chart-tooltip-topline">
          <span className={`timeline-anchor-type ${anchor.semantic}`}>{anchor.label}</span>
          <strong>{value}</strong>
        </div>
        <div className="chart-tooltip-detail">{anchor.detail}</div>
        <div className="chart-tooltip-meta">
          <span>{formatCompactDate(entry.timestamp)}</span>
          <span>{formatRelativeAge(entry.timestamp, referenceTimestamp)}</span>
        </div>
      </div>
    </div>
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

function NeighborTooltip({
  collectionSlug,
  containerRef,
  ethUsd,
  neighbor,
  pos,
  valueMode,
}: {
  collectionSlug: string;
  containerRef: { current: HTMLDivElement | null };
  ethUsd: number;
  neighbor: NeighborRecord;
  pos: { x: number; y: number };
  valueMode: ValueMode;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const imgSrc = getTokenImageUrl(collectionSlug, neighbor.token.token_index);
  const containerWidth = containerRef.current?.offsetWidth ?? 800;
  const containerHeight = containerRef.current?.offsetHeight ?? 400;
  const tooltipWidth = tooltipRef.current?.offsetWidth ?? 200;
  const tooltipHeight = tooltipRef.current?.offsetHeight ?? 80;

  const gap = 12;
  let left = pos.x + gap;
  let top = pos.y - tooltipHeight - gap;

  if (left + tooltipWidth > containerWidth) {
    left = pos.x - tooltipWidth - gap;
  }
  if (left < 0) {
    left = gap;
  }
  if (top < 0) {
    top = pos.y + gap;
  }
  if (top + tooltipHeight > containerHeight) {
    top = containerHeight - tooltipHeight - gap;
  }

  return (
    <div className="chart-tooltip has-thumb" ref={tooltipRef} style={{ left, top }}>
      {imgSrc ? (
        <img alt={neighbor.token.display_name} className="chart-tooltip-thumb" src={imgSrc} />
      ) : null}
      <div className="chart-tooltip-body">
        <div className="chart-tooltip-topline">
          <span className="timeline-anchor-type ask">Neighbor</span>
          <strong>
            {formatValue(neighbor.token.current_ask_eth, undefined, ethUsd, valueMode)}
          </strong>
        </div>
        <div className="chart-tooltip-detail">{neighbor.token.display_name}</div>
        <div className="chart-tooltip-meta">
          <span>{neighbor.sharedTraitCount} shared traits</span>
          <span>rarity gap {formatDistance(neighbor.rarityGap)}</span>
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
  const [hoveredNeighborId, setHoveredNeighborId] = useState<number | undefined>();
  const [neighborTooltipPos, setNeighborTooltipPos] = useState<{ x: number; y: number } | undefined>();
  const [neighborSearch, setNeighborSearch] = useState("");
  const [showAllNeighbors, setShowAllNeighbors] = useState(false);
  const [neighborSort, setNeighborSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "similarity", dir: "asc" });
  const [valuationModel, setValuationModel] = useState<ValuationModel>("nfti");
  const mapFrameRef = useRef<HTMLDivElement>(null);
  const displayedNeighbors = neighbors;
  const plotPoints = useMemo(
    () => buildNeighborhoodPlot(selectedToken, displayedNeighbors, mode, valuationModel),
    [mode, displayedNeighbors, selectedToken, valuationModel],
  );
  const selectedPlotPoint = plotPoints[0];
  const selectedRarityBucket = deriveRarityBucket(selectedToken.rarityPercentile);
  const hoveredNeighbor = hoveredNeighborId
    ? displayedNeighbors.find((n) => n.token.token_id === hoveredNeighborId)
    : undefined;

  return (
    <section className="timeline-card">
      <p className="chart-description">
        X tracks value spread from the selected token, Y tracks rarity-percentile spread,
        and marker size reflects {mode === "trait" ? "shared visible traits." : "rarity proximity."}
      </p>
      <div className="chart-controls-bar">
        <div className="chart-control-group">
          <span className="chart-control-label">
            Similarity mode
            <InfoTip>
              <p className="explainer-text">How neighbors are ranked:</p>
              <ul className="explainer-list">
                <li><strong>Trait</strong> — shared visible traits, weighted by rarity and value proximity</li>
                <li><strong>Rarity</strong> — closeness in rarity rank and adjusted floor value</li>
                <li><strong>Visual / Curated</strong> — placeholders for future modes</li>
              </ul>
            </InfoTip>
          </span>
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
        </div>
        <div className="chart-control-group">
          <span className="chart-control-label">
            Pool size
            <InfoTip>
              <p className="explainer-text">
                How many neighbor tokens to include. Smaller pools focus on the closest matches; larger pools show more of the collection.
              </p>
            </InfoTip>
          </span>
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
        <div className="chart-control-group">
          <span className="chart-control-label">X-axis value</span>
          <div className="segmented-control wrap compact">
            <button
              className={valuationModel === "nfti" ? "selected" : ""}
              onClick={() => setValuationModel("nfti")}
              type="button"
            >
              NFTi
            </button>
            <button
              className={valuationModel === "adjusted-floor" ? "selected" : ""}
              onClick={() => setValuationModel("adjusted-floor")}
              type="button"
            >
              Adj. Floor
            </button>
          </div>
        </div>
      </div>
      {displayedNeighbors.length === 0 ? (
        <div className="empty-state">
          <strong>No local neighbors in this mode yet.</strong>
          <small>Trait and rarity views are data-driven; visual and curated remain placeholders.</small>
        </div>
      ) : (
        <div className="neighborhood-map-card" ref={mapFrameRef}>
          {hoveredNeighbor && neighborTooltipPos ? (
            <NeighborTooltip
              collectionSlug={collectionSlug}
              containerRef={mapFrameRef}
              ethUsd={ethUsd}
              neighbor={hoveredNeighbor}
              pos={neighborTooltipPos}
              valueMode={valueMode}
            />
          ) : null}
          <svg
            aria-label={`Neighborhood similarity map for ${selectedToken.display_name}`}
            className="neighborhood-map"
            role="img"
            viewBox="0 0 760 320"
          >
            <line className="map-axis" x1="380" x2="380" y1="24" y2="292" />
            <line className="map-axis" x1="36" x2="724" y1="160" y2="160" />
            <text className="map-label" x="42" y="148">
              Lower {valuationModel === "nfti" ? "NFTi" : "Adj. Floor"}
            </text>
            <text className="map-label" textAnchor="end" x="718" y="148">
              Higher {valuationModel === "nfti" ? "NFTi" : "Adj. Floor"}
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
                  onMouseEnter={(e) => {
                    setHoveredNeighborId(point.tokenId);
                    const frame = mapFrameRef.current;
                    if (frame) {
                      const rect = frame.getBoundingClientRect();
                      setNeighborTooltipPos({
                        x: e.clientX - rect.left,
                        y: e.clientY - rect.top,
                      });
                    }
                  }}
                  onMouseMove={(e) => {
                    const frame = mapFrameRef.current;
                    if (frame) {
                      const rect = frame.getBoundingClientRect();
                      setNeighborTooltipPos({
                        x: e.clientX - rect.left,
                        y: e.clientY - rect.top,
                      });
                    }
                  }}
                  onMouseLeave={() => {
                    setHoveredNeighborId(undefined);
                    setNeighborTooltipPos(undefined);
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
      <div className="neighbor-table-section">
        <div className="neighbor-table-header">
          <div>
            <p className="eyebrow">Nearest neighbors</p>
            <h3>
              {displayedNeighbors.length} token{displayedNeighbors.length === 1 ? "" : "s"} ranked by similarity
            </h3>
          </div>
          <input
            className="neighbor-search-input"
            onChange={(e) => setNeighborSearch(e.target.value)}
            placeholder="Search by name or number\u2026"
            type="text"
            value={neighborSearch}
          />
        </div>
        {(() => {
          const searchLower = neighborSearch.toLowerCase().trim();
          const filtered = searchLower
            ? displayedNeighbors.filter(
                (n) =>
                  n.token.display_name.toLowerCase().includes(searchLower) ||
                  String(n.token.tokenNumber).includes(searchLower) ||
                  n.token.token_index.toLowerCase().includes(searchLower),
              )
            : displayedNeighbors;

          const sortedFiltered = [...filtered].sort((a, b) => {
            const dir = neighborSort.dir === "asc" ? 1 : -1;
            switch (neighborSort.key) {
              case "similarity":
                return (b.score - a.score) * dir;
              case "name":
                return a.token.display_name.localeCompare(b.token.display_name) * dir;
              case "shared":
                return (a.sharedTraitCount - b.sharedTraitCount) * dir;
              case "rank":
                return ((a.token.rarity_rank ?? 9999) - (b.token.rarity_rank ?? 9999)) * dir;
              case "ask":
                return ((a.token.current_ask_eth ?? 0) - (b.token.current_ask_eth ?? 0)) * dir;
              case "nfti":
                return ((a.token.prediction_eth ?? 0) - (b.token.prediction_eth ?? 0)) * dir;
              case "adjfloor":
                return ((a.token.adjusted_floor_eth ?? 0) - (b.token.adjusted_floor_eth ?? 0)) * dir;
              case "lastsale":
                return ((a.token.last_single_sale_eth ?? 0) - (b.token.last_single_sale_eth ?? 0)) * dir;
              default:
                return 0;
            }
          });

          const previewCount = 12;
          const visible = showAllNeighbors || searchLower ? sortedFiltered : sortedFiltered.slice(0, previewCount);

          const sortHeader = (label: string, key: string) => (
            <th
              className="sortable-th"
              onClick={() =>
                setNeighborSort((prev) =>
                  prev.key === key
                    ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
                    : { key, dir: key === "similarity" ? "asc" : "desc" },
                )
              }
            >
              {label}
              {neighborSort.key === key ? (
                <span className="sort-indicator">{neighborSort.dir === "asc" ? " \u25B2" : " \u25BC"}</span>
              ) : null}
            </th>
          );

          return (
            <>
              <table className="data-table neighbor-data-table">
                <thead>
                  <tr>
                    {sortHeader("#", "similarity")}
                    <th></th>
                    {sortHeader("Name", "name")}
                    {sortHeader("Shared", "shared")}
                    {sortHeader("Rank", "rank")}
                    <th>Rarity</th>
                    {sortHeader("Ask", "ask")}
                    {sortHeader("NFTi", "nfti")}
                    {sortHeader("Adj. Floor", "adjfloor")}
                    {sortHeader("Last Sale", "lastsale")}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((neighbor) => {
                    const rank = displayedNeighbors.indexOf(neighbor) + 1; // always similarity rank
                    const imgSrc = getTokenImageUrl(collectionSlug, neighbor.token.token_index);
                    const inspected = inspectedNeighbor?.token.token_id === neighbor.token.token_id;
                    return (
                      <tr
                        key={neighbor.token.token_id}
                        className={inspected ? "neighbor-row-active" : ""}
                        onClick={() => onInspect(neighbor)}
                        style={{ cursor: "pointer" }}
                      >
                        <td className="table-note">{rank}</td>
                        <td className="neighbor-thumb-cell">
                          {imgSrc ? (
                            <ImageHoverPopover alt={neighbor.token.display_name} src={imgSrc} />
                          ) : null}
                        </td>
                        <td>
                          <strong>{neighbor.token.display_name}</strong>
                        </td>
                        <td>{neighbor.sharedTraitCount}</td>
                        <td className="table-note">
                          {neighbor.token.rarity_rank != null ? `#${neighbor.token.rarity_rank}` : "—"}
                        </td>
                        <td className="table-note">
                          {deriveRarityBucket(neighbor.token.rarityPercentile)?.label ?? "—"}
                        </td>
                        <td>
                          <strong>
                            {formatValue(neighbor.token.current_ask_eth, undefined, ethUsd, valueMode)}
                          </strong>
                        </td>
                        <td>
                          {formatValue(neighbor.token.prediction_eth, undefined, ethUsd, valueMode)}
                        </td>
                        <td>
                          {formatValue(neighbor.token.adjusted_floor_eth, undefined, ethUsd, valueMode)}
                        </td>
                        <td>
                          {formatValue(neighbor.token.last_single_sale_eth, neighbor.token.last_single_sale_usd, ethUsd, valueMode)}
                          {neighbor.token.last_single_sale_ts ? (
                            <small
                              className={cx("age-pill", getSaleRecencyTone(neighbor.token.last_single_sale_ts, Date.now() / 1000))}
                              title={formatDateTime(neighbor.token.last_single_sale_ts)}
                            >
                              {formatRelativeAge(neighbor.token.last_single_sale_ts, Date.now() / 1000).replace(" ago", "")}
                            </small>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!searchLower && filtered.length > previewCount ? (
                <button
                  className="secondary-button"
                  onClick={() => setShowAllNeighbors((c) => !c)}
                  type="button"
                >
                  {showAllNeighbors
                    ? "Show fewer"
                    : `Show all ${filtered.length} neighbors`}
                </button>
              ) : null}
              {searchLower && filtered.length === 0 ? (
                <p className="footnote">No neighbors matching "{neighborSearch}"</p>
              ) : null}
            </>
          );
        })()}
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
