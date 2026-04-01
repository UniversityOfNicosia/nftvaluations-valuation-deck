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

export function getVisibleTraits(collection: CollectionData, tokenId: number) {
  return (collection.tokenTraitsByTokenId.get(tokenId) ?? [])
    .filter((trait) => !trait.category_ignore_for_valuation && !trait.category_is_trait_count)
    .sort((left, right) => left.property_token_count - right.property_token_count);
}

export function getDefaultTraitSelection(traits: TokenTrait[]) {
  return traits.slice(0, Math.min(3, traits.length)).map((trait) => trait.property_id);
}

export function getRecentActivity(collection: CollectionData, tokenId: number) {
  return (collection.activitiesByTokenId.get(tokenId) ?? [])
    .filter((activity) => activity.kind !== "mint")
    .slice(0, 18);
}

export function getTopTokenBids(collection: CollectionData, tokenId: number) {
  return (collection.tokenBidsByTokenId.get(tokenId) ?? []).slice(0, 5);
}

export function getTopCollectionBids(collection: CollectionData) {
  return collection.collectionBids.slice(0, 5);
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
    };
  }

  return {
    matchedTokenCount: matchedTokens.length,
    matchedTokenShare: matchedTokens.length / collection.tokens.length,
    floorAskEth: Math.min(
      ...matchedTokens
        .map((token) => token.current_ask_eth)
        .filter((value): value is number => value !== undefined),
    ),
    medianPredictionEth: calculateMedian(matchedTokens.map((token) => token.prediction_eth)),
    medianAdjustedFloorEth: calculateMedian(
      matchedTokens.map((token) => token.adjusted_floor_eth),
    ),
    medianRarityRank: calculateMedian(matchedTokens.map((token) => token.rarity_rank)),
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
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
}

export function getDefaultInspectorActivity(activities: Activity[]) {
  return activities.find((activity) => activity.price_eth !== undefined) ?? activities[0];
}

export function summarizeMarketBand(token: TokenWithNumber, bids: Bid[]) {
  const topBidEth = bids[0]?.price_eth;
  return {
    topBidEth,
    fairEth: token.prediction_eth ?? token.nfti_v2_trim_eth ?? token.adjusted_floor_eth,
    listEth: token.current_ask_eth,
  };
}
