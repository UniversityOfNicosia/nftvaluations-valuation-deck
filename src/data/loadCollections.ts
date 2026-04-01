import type {
  Activity,
  Bid,
  CollectionContext,
  CollectionData,
  CollectionMetadata,
  CollectionSnapshot,
  CollectionSummary,
  TokenRecord,
  TraitAnnotation,
  TraitAnnotationFile,
  TokenTrait,
  TokenWithNumber,
  TraitSupport,
} from "./types.ts";

type RawModule<T> = () => Promise<T>;
type ColumnarTable = {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
};

const dataFiles = [
  "collection_context.json",
  "collection_snapshots.json",
  "tokens.json",
  "token_traits.json",
  "activities.json",
  "bids.json",
  "trait_support.json",
] as const;

const eagerMetadataModules = {
  ...import.meta.glob("../../*/metadata.json", {
    eager: true,
    import: "default",
  }),
  ...import.meta.glob("../../*/data/metadata.json", {
    eager: true,
    import: "default",
  }),
};

const eagerContextModules = {
  ...import.meta.glob("../../*/collection_context.json", {
    eager: true,
    import: "default",
  }),
  ...import.meta.glob("../../*/data/collection_context.json", {
    eager: true,
    import: "default",
  }),
};

const fileImporters: Record<
  (typeof dataFiles)[number],
  Record<string, RawModule<unknown>>
> = {
  "collection_context.json": {
    ...import.meta.glob("../../*/collection_context.json", { import: "default" }),
    ...import.meta.glob("../../*/data/collection_context.json", {
      import: "default",
    }),
  },
  "collection_snapshots.json": {
    ...import.meta.glob("../../*/collection_snapshots.json", {
      import: "default",
    }),
    ...import.meta.glob("../../*/data/collection_snapshots.json", {
      import: "default",
    }),
  },
  "tokens.json": {
    ...import.meta.glob("../../*/tokens.json", { import: "default" }),
    ...import.meta.glob("../../*/data/tokens.json", { import: "default" }),
  },
  "token_traits.json": {
    ...import.meta.glob("../../*/token_traits.json", { import: "default" }),
    ...import.meta.glob("../../*/data/token_traits.json", { import: "default" }),
  },
  "activities.json": {
    ...import.meta.glob("../../*/activities.json", { import: "default" }),
    ...import.meta.glob("../../*/data/activities.json", { import: "default" }),
  },
  "bids.json": {
    ...import.meta.glob("../../*/bids.json", { import: "default" }),
    ...import.meta.glob("../../*/data/bids.json", { import: "default" }),
  },
  "trait_support.json": {
    ...import.meta.glob("../../*/trait_support.json", { import: "default" }),
    ...import.meta.glob("../../*/data/trait_support.json", { import: "default" }),
  },
};

const optionalFileImporters = {
  "trait_annotations.json": {
    ...import.meta.glob("../../*/trait_annotations.json", { import: "default" }),
    ...import.meta.glob("../../*/data/trait_annotations.json", {
      import: "default",
    }),
  },
};

function getSlugFromPath(path: string) {
  const match = path.match(/^\.\.\/\.\.\/([^/]+)\//);
  return match?.[1];
}

function findModule<T>(modules: Record<string, T>, slug: string) {
  const entry = Object.entries(modules).find(([path]) => getSlugFromPath(path) === slug);
  return entry?.[1];
}

function inflateTable<T>(table: ColumnarTable): T[] {
  return table.rows.map((row) => {
    const result: Record<string, unknown> = {};
    table.columns.forEach((column, index) => {
      result[column] = row[index] ?? undefined;
    });
    return result as T;
  });
}

function parseTokenNumber(token: TokenRecord) {
  const label = token.display_name || token.name || token.token_index;
  const match = label.match(/#(\d+)$/);
  return Number(match?.[1] ?? 0);
}

function compareTimestampDesc<T extends { timestamp?: number; start_ts?: number }>(
  left: T,
  right: T,
) {
  return (right.timestamp ?? right.start_ts ?? 0) - (left.timestamp ?? left.start_ts ?? 0);
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return undefined;
  }
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  }
  return sorted[midpoint];
}

export function listCollections() {
  const summaries: CollectionSummary[] = [];
  Object.entries(eagerMetadataModules).forEach(([path, rawMetadata]) => {
    const slug = getSlugFromPath(path);
    if (!slug) {
      return;
    }
    const metadata = rawMetadata as CollectionMetadata;
    const context = findModule(eagerContextModules, slug) as CollectionContext | undefined;
    summaries.push({
      slug,
      title: metadata.collection_name,
      artist: metadata.artist_name,
      snapshotTs: metadata.snapshot_ts,
      ethUsd: metadata.eth_usd,
      floorEth: context?.floor_eth,
      topBidEth: context?.top_bid_eth,
    });
  });

  return summaries.sort((left, right) => right.snapshotTs - left.snapshotTs);
}

function groupByTokenId<T extends { token_id: number }>(rows: T[]) {
  const grouped = new Map<number, T[]>();
  rows.forEach((row) => {
    const existing = grouped.get(row.token_id) ?? [];
    existing.push(row);
    grouped.set(row.token_id, existing);
  });
  return grouped;
}

export async function loadCollection(slug: string): Promise<CollectionData> {
  const metadata = findModule(eagerMetadataModules, slug) as CollectionMetadata | undefined;
  if (!metadata) {
    throw new Error(`Unknown collection slug: ${slug}`);
  }

  const resolvedImports = await Promise.all(
    dataFiles.map(async (fileName) => {
      const importer = findModule(fileImporters[fileName], slug);
      if (!importer) {
        throw new Error(`Missing ${fileName} for collection ${slug}`);
      }
      return [fileName, await importer()] as const;
    }),
  );

  const fileMap = Object.fromEntries(resolvedImports) as Record<
    (typeof dataFiles)[number],
    unknown
  >;

  const context = fileMap["collection_context.json"] as CollectionContext;
  const snapshots = inflateTable<CollectionSnapshot>(
    fileMap["collection_snapshots.json"] as ColumnarTable,
  ).sort((left, right) => left.timestamp - right.timestamp);
  const tokens = (fileMap["tokens.json"] as TokenRecord[])
    .map<TokenWithNumber>((token) => ({
      ...token,
      tokenNumber: parseTokenNumber(token),
      rarityPercentile:
        token.rarity_rank && metadata.collection_id
          ? token.rarity_rank / (fileMap["tokens.json"] as TokenRecord[]).length
          : 1,
    }))
    .sort((left, right) => left.tokenNumber - right.tokenNumber);
  const tokenTraits = inflateTable<TokenTrait>(
    fileMap["token_traits.json"] as ColumnarTable,
  );
  const activities = inflateTable<Activity>(
    fileMap["activities.json"] as ColumnarTable,
  ).sort(compareTimestampDesc);
  const bids = [...(fileMap["bids.json"] as Bid[])].sort(compareTimestampDesc);
  const traitSupport = [...(fileMap["trait_support.json"] as TraitSupport[])].sort(
    (left, right) => right.token_count - left.token_count,
  );
  const traitAnnotationImporter = findModule(optionalFileImporters["trait_annotations.json"], slug);
  const rawTraitAnnotations = traitAnnotationImporter ? await traitAnnotationImporter() : undefined;
  const traitAnnotationFile = rawTraitAnnotations as TraitAnnotationFile | TraitAnnotation[] | undefined;
  const traitAnnotations = Array.isArray(traitAnnotationFile)
    ? traitAnnotationFile
    : traitAnnotationFile?.traits ?? [];

  const tokensById = new Map(tokens.map((token) => [token.token_id, token]));
  const tokensByNumber = new Map(tokens.map((token) => [token.tokenNumber, token]));
  const tokenTraitsByTokenId = groupByTokenId(tokenTraits);
  const activitiesByTokenId = groupByTokenId(activities);
  const collectionBids = bids
    .filter((bid) => bid.scope === "collection")
    .sort((left, right) => (right.price_eth ?? 0) - (left.price_eth ?? 0));
  const tokenBidsByTokenId = new Map<number, Bid[]>();
  bids
    .filter((bid) => bid.scope === "token" && bid.token_id)
    .forEach((bid) => {
      const tokenId = bid.token_id!;
      const existing = tokenBidsByTokenId.get(tokenId) ?? [];
      existing.push(bid);
      tokenBidsByTokenId.set(
        tokenId,
        existing.sort((left, right) => (right.price_eth ?? 0) - (left.price_eth ?? 0)),
      );
    });
  const traitSupportByPropertyId = new Map(
    traitSupport.map((item) => [item.property_id, item]),
  );
  const traitAnnotationsByPropertyId = new Map(
    traitAnnotations.map((item) => [item.property_id, item]),
  );

  return {
    summary: {
      slug,
      title: metadata.collection_name,
      artist: metadata.artist_name,
      snapshotTs: metadata.snapshot_ts,
      ethUsd: metadata.eth_usd,
      floorEth: context.floor_eth,
      topBidEth: context.top_bid_eth,
    },
    metadata,
    context,
    snapshots,
    tokens,
    tokensById,
    tokensByNumber,
    tokenTraits,
    tokenTraitsByTokenId,
    activities,
    activitiesByTokenId,
    collectionBids,
    tokenBidsByTokenId,
    traitSupport,
    traitSupportByPropertyId,
    traitAnnotations,
    traitAnnotationsByPropertyId,
  };
}

export function calculateMedian(values: Array<number | undefined>) {
  return median(values.filter((value): value is number => value !== undefined));
}
