export type ValueMode = "eth" | "usd" | "usd-eth" | "eth-usd";

export type CollectionSummary = {
  slug: string;
  title: string;
  artist: string;
  snapshotTs: number;
  ethUsd: number;
  floorEth?: number;
  topBidEth?: number;
};

export type CollectionMetadata = {
  collection_id: number;
  collection_name: string;
  artist_name: string;
  snapshot_ts: number;
  eth_usd: number;
  currency_default: string;
};

export type CollectionContext = {
  collection_id: number;
  snapshot_ts: number;
  floor_eth: number;
  top_bid_eth: number;
  median_sale_eth_30d?: number;
  sale_volume_eth_7d?: number;
  sale_volume_eth_30d?: number;
  sale_volume_eth_90d?: number;
  sale_volume_eth_180d?: number;
  sale_volume_eth_365d?: number;
  sale_volume_usd_7d?: number;
  sale_volume_usd_30d?: number;
  sale_volume_usd_90d?: number;
  sale_volume_usd_180d?: number;
  sale_volume_usd_365d?: number;
  listed_pct?: number;
  af_market_cap_eth?: number;
  nfti_market_cap_eth?: number;
  change_median_sale_30d_vs_prev30d_pct?: number;
  change_floor_pct_1d?: number;
  change_floor_pct_7d?: number;
  change_floor_pct_30d?: number;
  change_floor_pct_90d?: number;
  change_floor_pct_180d?: number;
  change_floor_pct_365d?: number;
  change_listed_pct_1d?: number;
  change_listed_pct_7d?: number;
  change_listed_pct_30d?: number;
  change_listed_pct_90d?: number;
  change_listed_pct_180d?: number;
  change_listed_pct_365d?: number;
  change_af_market_cap_pct_1d?: number;
  change_af_market_cap_pct_7d?: number;
  change_af_market_cap_pct_30d?: number;
  change_af_market_cap_pct_90d?: number;
  change_af_market_cap_pct_180d?: number;
  change_af_market_cap_pct_365d?: number;
  change_nfti_market_cap_pct_1d?: number;
  change_nfti_market_cap_pct_7d?: number;
  change_nfti_market_cap_pct_30d?: number;
  change_nfti_market_cap_pct_90d?: number;
  change_nfti_market_cap_pct_180d?: number;
  change_nfti_market_cap_pct_365d?: number;
  change_median_sale_30d_pct_1d?: number;
  change_median_sale_30d_pct_7d?: number;
  change_median_sale_30d_pct_30d?: number;
  change_median_sale_30d_pct_90d?: number;
  change_median_sale_30d_pct_180d?: number;
  change_median_sale_30d_pct_365d?: number;
  change_sale_volume_30d_pct_1d?: number;
  change_sale_volume_30d_pct_7d?: number;
  change_sale_volume_30d_pct_30d?: number;
  change_sale_volume_30d_pct_90d?: number;
  change_sale_volume_30d_pct_180d?: number;
  change_sale_volume_30d_pct_365d?: number;
};

export type CollectionSnapshot = {
  timestamp: number;
  eth_usd?: number;
  floor_eth?: number;
  listing_count?: number;
  owner_count?: number;
  sale_count_cum?: number;
  sale_volume_all_time_eth?: number;
  sale_volume_all_time_usd?: number;
  token_count?: number;
  token_quantity?: number;
  af_market_cap_eth?: number;
  nfti_market_cap_eth?: number;
  af_rank?: number;
  nfti_rank?: number;
  last_sale_eth?: number;
  last_sale_usd?: number;
};

export type TokenRecord = {
  token_id: number;
  token_index: string;
  token_index_number: number;
  name: string;
  display_name: string;
  current_ask_eth?: number;
  current_ask_start_ts?: number;
  current_ask_end_ts?: number;
  current_ask_marketplace_id?: number;
  highest_sale_eth?: number;
  last_single_sale_eth?: number;
  last_single_sale_usd?: number;
  last_single_sale_ts?: number;
  adjusted_floor_eth?: number;
  prediction_eth?: number;
  nfti_v2_base_eth?: number;
  nfti_v2_trim_eth?: number;
  rarity_rank?: number;
  rarity_score?: number;
  quantity?: number;
  classification?: number;
  mint_ts?: number;
  media_type?: number;
};

export type TokenWithNumber = TokenRecord & {
  tokenNumber: number;
  rarityPercentile: number;
};

export type TokenTrait = {
  token_id: number;
  token_index: string;
  property_id: number;
  property_name: string;
  property_open_sea_property?: string;
  property_open_sea_category?: string;
  property_token_count: number;
  property_token_quantity?: number;
  property_floor_eth?: number;
  property_last_sale_eth?: number;
  property_last_sale_usd?: number;
  category_id: number;
  category_name: string;
  category_type?: number;
  category_is_original?: boolean;
  category_is_trait_count?: boolean;
  category_ignore_for_valuation?: boolean;
  category_rarity_weight?: number;
};

export type Activity = {
  activity_id: number;
  token_id: number;
  token_index: string;
  kind: string;
  is_private: boolean;
  price_eth?: number;
  price_usd?: number;
  timestamp: number;
  listing_start_ts?: number;
  listing_end_ts?: number;
  listing_end_early_ts?: number;
  marketplace_id?: number;
  from_account_id?: number;
  to_account_id?: number;
};

export type Bid = {
  bid_id: string;
  scope: "collection" | "token" | "trait" | string;
  price_eth?: number;
  price_usd?: number;
  start_ts: number;
  end_ts: number;
  status: string;
  source?: string;
  bidder_address?: string;
  is_active?: boolean;
  token_index?: string;
  token_id?: number;
  trait_key?: string;
  trait_value?: string;
};

export type TraitSupport = {
  property_id: number;
  category_id: number;
  trait_key: string;
  trait_value: string;
  token_count: number;
  token_share_pct: number;
  top_bid_eth?: number;
  latest_clean_sale_eth?: number;
  latest_clean_sale_usd?: number;
  latest_clean_sale_ts?: number;
  median_sale_eth_30d?: number;
  median_sale_eth_90d?: number;
  median_sale_eth_365d?: number;
  ask_floor_eth?: number;
};

export type TraitAnnotationClass = "Grail" | "Positive" | "Neutral" | "Negative";
export type TraitDriverTier = "Major driver" | "Supporting driver" | "Not a driver";

export type TraitAnnotation = {
  property_id: number;
  class?: TraitAnnotationClass;
  driver_tier?: TraitDriverTier;
  rationale?: string;
};

export type TraitClassificationRecord = {
  class: TraitAnnotationClass;
  driver_tier: TraitDriverTier;
  rationale: string;
};

export type TraitClassificationFile = Record<string, TraitClassificationRecord>;

export type CollectionData = {
  summary: CollectionSummary;
  metadata: CollectionMetadata;
  context: CollectionContext;
  snapshots: CollectionSnapshot[];
  tokens: TokenWithNumber[];
  tokensById: Map<number, TokenWithNumber>;
  tokensByNumber: Map<number, TokenWithNumber>;
  tokenTraits: TokenTrait[];
  tokenTraitsByTokenId: Map<number, TokenTrait[]>;
  activities: Activity[];
  activitiesByTokenId: Map<number, Activity[]>;
  collectionBids: Bid[];
  tokenBidsByTokenId: Map<number, Bid[]>;
  traitSupport: TraitSupport[];
  traitSupportByPropertyId: Map<number, TraitSupport>;
  traitAnnotations: TraitAnnotation[];
  traitAnnotationsByPropertyId: Map<number, TraitAnnotation>;
};

export type CombinedTraitMetrics = {
  matchedTokenCount: number;
  matchedTokenShare: number;
  askFloorEth?: number;
  combinedMedianEth?: number;
  floorReferenceEth?: number;
  latestSaleEth?: number;
  latestSaleUsd?: number;
  latestSaleTs?: number;
  matchedTokenNumbers: number[];
};

export type NeighborhoodMode = "trait" | "rarity" | "visual" | "curated";

export type NeighborRecord = {
  token: TokenWithNumber;
  score: number;
  sharedTraitCount: number;
  sharedTraitNames: string[];
  rarityGap: number;
};
