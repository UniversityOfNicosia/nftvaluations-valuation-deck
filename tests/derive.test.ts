import { describe, expect, it } from "vitest";
import { calculateMedian } from "../src/data/loadCollections.ts";
import type { CollectionData, TokenWithNumber } from "../src/data/types.ts";
import {
  deriveCombinedTraitMetrics,
  deriveNeighbors,
} from "../src/lib/derive.ts";

describe("calculateMedian", () => {
  it("returns the midpoint for odd-length arrays", () => {
    expect(calculateMedian([1, 9, 3])).toBe(3);
  });

  it("returns the average midpoint for even-length arrays", () => {
    expect(calculateMedian([2, 6, 10, 14])).toBe(8);
  });

  it("ignores undefined values", () => {
    expect(calculateMedian([undefined, 4, 10])).toBe(7);
  });
});

function createToken(
  token_id: number,
  tokenNumber: number,
  overrides: Partial<TokenWithNumber> = {},
): TokenWithNumber {
  return {
    token_id,
    token_index: String(tokenNumber),
    token_index_number: tokenNumber,
    name: `Token ${tokenNumber}`,
    display_name: `Fidenza #${tokenNumber}`,
    tokenNumber,
    rarityPercentile: 0.5,
    prediction_eth: tokenNumber,
    adjusted_floor_eth: tokenNumber,
    rarity_rank: tokenNumber,
    ...overrides,
  };
}

function createCollection(tokens: TokenWithNumber[], traitMap: Map<number, number[]>) {
  return {
    summary: {
      slug: "fidenza-by-tyler-hobbs",
      title: "Fidenza",
      artist: "Tyler Hobbs",
      snapshotTs: 0,
      ethUsd: 2000,
    },
    metadata: {
      collection_id: 1,
      collection_name: "Fidenza",
      artist_name: "Tyler Hobbs",
      snapshot_ts: 0,
      eth_usd: 2000,
      currency_default: "eth",
    },
    context: {
      collection_id: 1,
      snapshot_ts: 0,
      floor_eth: 1,
      top_bid_eth: 1,
    },
    snapshots: [],
    tokens,
    tokensById: new Map(tokens.map((token) => [token.token_id, token])),
    tokensByNumber: new Map(tokens.map((token) => [token.tokenNumber, token])),
    tokenTraits: [],
    tokenTraitsByTokenId: new Map(
      tokens.map((token) => [
        token.token_id,
        (traitMap.get(token.token_id) ?? []).map((property_id) => ({
          token_id: token.token_id,
          token_index: token.token_index,
          property_id,
          property_name: `Trait ${property_id}`,
          property_token_count: tokens.length,
          category_id: property_id,
          category_name: "Category",
        })),
      ]),
    ),
    activities: [],
    activitiesByTokenId: new Map(),
    collectionBids: [],
    tokenBidsByTokenId: new Map(),
    traitSupport: [],
    traitSupportByPropertyId: new Map(),
  } as unknown as CollectionData;
}

describe("deriveNeighbors", () => {
  it("returns the full sorted local neighborhood instead of capping at twelve", () => {
    const selected = createToken(1, 1, { prediction_eth: 10, adjusted_floor_eth: 10 });
    const neighbors = Array.from({ length: 15 }, (_, index) =>
      createToken(index + 2, index + 2, {
        prediction_eth: 9 - index * 0.1,
        adjusted_floor_eth: 9 - index * 0.1,
        rarity_rank: index + 2,
      }),
    );
    const collection = createCollection([selected, ...neighbors], new Map([
      [selected.token_id, [1, 2]],
      ...neighbors.map((token) => [token.token_id, [1]] as const),
    ]));

    const result = deriveNeighbors(collection, selected, "trait");

    expect(result).toHaveLength(15);
    expect(result[0]?.token.token_id).toBe(2);
    expect(result.at(-1)?.token.token_id).toBe(16);
  });
});

describe("deriveCombinedTraitMetrics", () => {
  it("returns conservative overlap metrics and matching token numbers", () => {
    const selected = createToken(1, 10, { adjusted_floor_eth: 8, current_ask_eth: 9 });
    const matchA = createToken(2, 11, {
      adjusted_floor_eth: 10,
      current_ask_eth: 12,
      last_single_sale_eth: 15,
      last_single_sale_usd: 30000,
      last_single_sale_ts: 100,
    });
    const matchB = createToken(3, 12, {
      adjusted_floor_eth: 14,
      current_ask_eth: 9,
      last_single_sale_eth: 20,
      last_single_sale_usd: 40000,
      last_single_sale_ts: 200,
    });
    const other = createToken(4, 13, { adjusted_floor_eth: 20, current_ask_eth: 25 });
    const collection = createCollection([selected, matchA, matchB, other], new Map([
      [selected.token_id, [1, 2]],
      [matchA.token_id, [1, 2]],
      [matchB.token_id, [1, 2]],
      [other.token_id, [1]],
    ]));

    const result = deriveCombinedTraitMetrics(collection, [1, 2]);

    expect(result).toEqual({
      matchedTokenCount: 3,
      matchedTokenShare: 0.75,
      askFloorEth: 9,
      combinedMedianEth: 10,
      floorReferenceEth: 8,
      latestSaleEth: 20,
      latestSaleUsd: 40000,
      latestSaleTs: 200,
      matchedTokenNumbers: [10, 11, 12],
    });
  });
});
