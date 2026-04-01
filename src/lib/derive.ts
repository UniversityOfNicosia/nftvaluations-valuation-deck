import { calculateMedian } from "../data/loadCollections.ts";
import type {
  Activity,
  Bid,
  CollectionData,
  CombinedTraitMetrics,
  NeighborRecord,
  NeighborhoodMode,
  TokenTrait,
  TokenWithNumber,
} from "../data/types.ts";

export type RarityBucketTone = "elite" | "rare" | "mid" | "common";

export type RarityBucket = {
  label: "Top 1%" | "Top 5%" | "Top 10%" | "Top 25%" | "Mid" | "Common";
  tone: RarityBucketTone;
};

export type NeighborhoodPlotPoint = {
  tokenId: number;
  tokenNumber: number;
  label: string;
  x: number;
  y: number;
  radius: number;
  isSelected: boolean;
  rarityBucket: RarityBucket | null;
  sharedTraitCount: number;
  rarityGap: number;
};

const rarityBuckets: Array<{
  maxPercentile: number;
  label: RarityBucket["label"];
  tone: RarityBucketTone;
}> = [
  { maxPercentile: 0.01, label: "Top 1%", tone: "elite" },
  { maxPercentile: 0.05, label: "Top 5%", tone: "elite" },
  { maxPercentile: 0.1, label: "Top 10%", tone: "rare" },
  { maxPercentile: 0.25, label: "Top 25%", tone: "rare" },
  { maxPercentile: 0.75, label: "Mid", tone: "mid" },
  { maxPercentile: Number.POSITIVE_INFINITY, label: "Common", tone: "common" },
];

export function getVisibleTraits(collection: CollectionData, tokenId: number) {
  return (collection.tokenTraitsByTokenId.get(tokenId) ?? [])
    .filter((trait) => !trait.category_ignore_for_valuation && !trait.category_is_trait_count)
    .sort((left, right) => left.property_token_count - right.property_token_count);
}

export function getDefaultTraitSelection(traits: TokenTrait[]) {
  return traits.slice(0, Math.min(3, traits.length)).map((trait) => trait.property_id);
}

export function getTokenActivityHistory(collection: CollectionData, tokenId: number) {
  return (collection.activitiesByTokenId.get(tokenId) ?? []).filter(
    (activity) => activity.kind !== "mint",
  );
}

export function getRecentActivity(collection: CollectionData, tokenId: number) {
  return getTokenActivityHistory(collection, tokenId).slice(0, 18);
}

export function getTopTokenBids(collection: CollectionData, tokenId: number) {
  return (collection.tokenBidsByTokenId.get(tokenId) ?? []).slice(0, 5);
}

export function getTopCollectionBids(collection: CollectionData) {
  return collection.collectionBids.slice(0, 5);
}

export function deriveRarityBucket(percentile: number | undefined) {
  if (percentile === undefined || !Number.isFinite(percentile)) {
    return null;
  }

  const bucket = rarityBuckets.find((entry) => percentile <= entry.maxPercentile);
  return bucket ? { label: bucket.label, tone: bucket.tone } : null;
}

export function deriveCombinedTraitMetrics(
  collection: CollectionData,
  propertyIds: number[],
): CombinedTraitMetrics | null {
  if (propertyIds.length < 2) {
    return null;
  }

  const matchedTokens = collection.tokens.filter((token) => {
    const traitIds = new Set(
      (collection.tokenTraitsByTokenId.get(token.token_id) ?? []).map(
        (trait) => trait.property_id,
      ),
    );
    return propertyIds.every((propertyId) => traitIds.has(propertyId));
  });

  if (matchedTokens.length === 0) {
    return {
      matchedTokenCount: 0,
      matchedTokenShare: 0,
      matchedTokenNumbers: [],
    };
  }

  const latestSaleToken = [...matchedTokens]
    .filter((token) => token.last_single_sale_ts !== undefined)
    .sort((left, right) => (right.last_single_sale_ts ?? 0) - (left.last_single_sale_ts ?? 0))[0];
  const askFloorEth = Math.min(
    ...matchedTokens
      .map((token) => token.current_ask_eth)
      .filter((value): value is number => value !== undefined),
  );
  const floorReferenceEth = Math.min(
    ...matchedTokens
      .map((token) => token.adjusted_floor_eth)
      .filter((value): value is number => value !== undefined),
  );

  return {
    matchedTokenCount: matchedTokens.length,
    matchedTokenShare: matchedTokens.length / collection.tokens.length,
    askFloorEth: Number.isFinite(askFloorEth) ? askFloorEth : undefined,
    combinedMedianEth: calculateMedian(matchedTokens.map((token) => token.adjusted_floor_eth)),
    floorReferenceEth: Number.isFinite(floorReferenceEth) ? floorReferenceEth : undefined,
    latestSaleEth: latestSaleToken?.last_single_sale_eth,
    latestSaleUsd: latestSaleToken?.last_single_sale_usd,
    latestSaleTs: latestSaleToken?.last_single_sale_ts,
    matchedTokenNumbers: matchedTokens
      .map((token) => token.tokenNumber)
      .sort((left, right) => left - right),
  };
}

function buildTraitSets(collection: CollectionData) {
  const traitSets = new Map<number, Set<number>>();
  collection.tokens.forEach((token) => {
    traitSets.set(
      token.token_id,
      new Set(
        getVisibleTraits(collection, token.token_id).map((trait) => trait.property_id),
      ),
    );
  });
  return traitSets;
}

function clampCoordinate(value: number) {
  return Math.max(-1, Math.min(1, value));
}

function getNeighborhoodValueAnchor(token: TokenWithNumber, mode: NeighborhoodMode) {
  if (mode === "trait") {
    return token.prediction_eth ?? token.adjusted_floor_eth ?? token.current_ask_eth ?? 0;
  }
  return token.adjusted_floor_eth ?? token.prediction_eth ?? token.current_ask_eth ?? 0;
}

export function deriveNeighbors(
  collection: CollectionData,
  token: TokenWithNumber,
  mode: NeighborhoodMode,
): NeighborRecord[] {
  const traitSets = buildTraitSets(collection);
  const targetTraits = traitSets.get(token.token_id) ?? new Set<number>();

  if (mode === "visual" || mode === "curated") {
    return [];
  }

  return collection.tokens
    .filter((candidate) => candidate.token_id !== token.token_id)
    .map((candidate) => {
      const candidateTraits = traitSets.get(candidate.token_id) ?? new Set<number>();
      const sharedTraitIds = [...targetTraits].filter((propertyId) =>
        candidateTraits.has(propertyId),
      );
      const sharedTraitNames = getVisibleTraits(collection, candidate.token_id)
        .filter((trait) => sharedTraitIds.includes(trait.property_id))
        .map((trait) => `${trait.category_name}: ${trait.property_name}`);
      const rarityGap = Math.abs((candidate.rarity_rank ?? 0) - (token.rarity_rank ?? 0));
      const traitScore =
        sharedTraitIds.length * 10 -
        rarityGap / 50 -
        Math.abs((candidate.prediction_eth ?? 0) - (token.prediction_eth ?? 0)) / 10;
      const rarityScore =
        1000 -
        rarityGap -
        Math.abs((candidate.adjusted_floor_eth ?? 0) - (token.adjusted_floor_eth ?? 0));

      return {
        token: candidate,
        score: mode === "trait" ? traitScore : rarityScore,
        sharedTraitCount: sharedTraitIds.length,
        sharedTraitNames,
        rarityGap,
      };
    })
    .filter((neighbor) => (mode === "trait" ? neighbor.sharedTraitCount > 0 : true))
    .sort((left, right) => right.score - left.score);
}

export function buildNeighborhoodPlot(
  selectedToken: TokenWithNumber,
  neighbors: NeighborRecord[],
  mode: NeighborhoodMode,
): NeighborhoodPlotPoint[] {
  const baseValue = getNeighborhoodValueAnchor(selectedToken, mode);
  const valueSpreads = neighbors.map((neighbor) =>
    Math.abs(getNeighborhoodValueAnchor(neighbor.token, mode) - baseValue),
  );
  const raritySpreads = neighbors.map((neighbor) =>
    Math.abs((selectedToken.rarityPercentile ?? 1) - (neighbor.token.rarityPercentile ?? 1)),
  );
  const closenessSignals = neighbors.map((neighbor) =>
    mode === "trait" ? neighbor.sharedTraitCount : 1 / Math.max(neighbor.rarityGap, 1),
  );
  const maxValueSpread = Math.max(...valueSpreads, 1);
  const maxRaritySpread = Math.max(...raritySpreads, 0.01);
  const maxCloseness = Math.max(...closenessSignals, 1);

  return [
    {
      tokenId: selectedToken.token_id,
      tokenNumber: selectedToken.tokenNumber,
      label: selectedToken.display_name,
      x: 0,
      y: 0,
      radius: 14,
      isSelected: true,
      rarityBucket: deriveRarityBucket(selectedToken.rarityPercentile),
      sharedTraitCount: 0,
      rarityGap: 0,
    },
    ...neighbors.map((neighbor, index) => {
      const closeness = closenessSignals[index] ?? 1;
      return {
        tokenId: neighbor.token.token_id,
        tokenNumber: neighbor.token.tokenNumber,
        label: neighbor.token.display_name,
        x: clampCoordinate(
          (getNeighborhoodValueAnchor(neighbor.token, mode) - baseValue) / maxValueSpread,
        ),
        y: clampCoordinate(
          ((selectedToken.rarityPercentile ?? 1) - (neighbor.token.rarityPercentile ?? 1)) /
            maxRaritySpread,
        ),
        radius: 7 + (closeness / maxCloseness) * 6,
        isSelected: false,
        rarityBucket: deriveRarityBucket(neighbor.token.rarityPercentile),
        sharedTraitCount: neighbor.sharedTraitCount,
        rarityGap: neighbor.rarityGap,
      };
    }),
  ];
}

export function getDefaultInspectorActivity(activities: Activity[]) {
  return activities.find((activity) => activity.price_eth !== undefined) ?? activities[0];
}

export function getActivityMarketType(activity: Pick<Activity, "kind">) {
  if (activity.kind.includes("sale")) {
    return "sale" as const;
  }
  if (activity.kind.includes("listing")) {
    return "ask" as const;
  }
  return null;
}

export function summarizeMarketBand(token: TokenWithNumber, bids: Bid[]) {
  const topBidEth = bids[0]?.price_eth;
  return {
    topBidEth,
    fairEth: token.prediction_eth ?? token.nfti_v2_trim_eth ?? token.adjusted_floor_eth,
    listEth: token.current_ask_eth,
  };
}
