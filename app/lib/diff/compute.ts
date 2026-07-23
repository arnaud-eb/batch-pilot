/**
 * Dry-run diff computation (Phase 2, Section 2).
 *
 * computeDiff is pure read + compute: it queries, re-reads authoritative state
 * by id, and returns what *would* change. It performs no mutations. Running it
 * twice with no execution in between returns identical results — that property
 * is the whole point, and it is tested.
 *
 * Design decisions (see docs/phase-2-spec.md §1-2):
 *  - Per-variant semantics. Price and stock filters are evaluated against each
 *    variant, not the product. A product with variants at €35 and €55 filtered
 *    on price<40 yields ONE variant change, not a whole-product change.
 *  - Candidate selection uses only the reliable server-side filters (tag,
 *    collection). Price/stock are applied per-variant here, NOT via
 *    queryProducts' min-variant price filter (which is a documented Phase 0-1
 *    simplification and wrong for per-variant matching).
 *  - Re-read by id before diffing (quirk #1: the search index is eventually
 *    consistent, so search results can be stale; product(id:) is authoritative).
 *  - Refuse to diff a truncated candidate set (hasMore): a silently partial diff
 *    is worse than one that refuses to run.
 */

import { ShopifyClient } from "../shopify/client";
import { ValidationError } from "../shopify/errors";
import { queryProducts } from "../shopify/tools";
import type {
  ChangeRequest,
  DiffEntry,
  DiffResult,
  ProductMatch,
} from "./types";

/** Authoritative product state, read fresh by id. */
export interface FreshProduct {
  id: string;
  title: string;
  tags: string[];
  variants: Array<{ id: string; title: string; price: string; stock: number }>;
}

/**
 * Upper bound on candidate products a single diff may consider. Beyond this we
 * refuse rather than silently preview a partial catalog. Generous for a dev
 * store; a real deployment would page or tighten filters.
 */
const MAX_CANDIDATES = 5000;

/** Batch size for id re-reads — keeps each nodes() query's cost bounded. */
const READ_BATCH = 50;

export interface ComputeDiffOptions {
  /**
   * Override the candidate-set ceiling. Above this the diff refuses rather than
   * previewing a partial catalog. Exposed mainly so tests can trigger the
   * refusal without needing MAX_CANDIDATES real products.
   */
  maxCandidates?: number;
}

export async function computeDiff(
  client: ShopifyClient,
  request: ChangeRequest,
  options: ComputeDiffOptions = {},
): Promise<DiffResult> {
  const candidateIds = await selectCandidateIds(client, request, options.maxCandidates ?? MAX_CANDIDATES);
  // Sort candidates deterministically before re-reading so the diff's entry
  // order does not depend on Shopify's (undocumented) default product sort
  // being stable across calls — the purity guarantee should be contractual,
  // not incidental.
  const orderedIds = sortByNumericId(candidateIds);
  const fresh = await readProductsByIds(client, orderedIds);

  const entries: DiffEntry[] = [];
  const matches: ProductMatch[] = [];

  for (const product of fresh) {
    const matchedVariants = product.variants.filter((v) =>
      variantMatches(v, request.filter),
    );
    if (matchedVariants.length === 0) continue;

    matches.push({
      productId: product.id,
      productTitle: product.title,
      matchedVariants: matchedVariants.length,
      totalVariants: product.variants.length,
      partial: matchedVariants.length < product.variants.length,
    });

    // Variant-level change: setPrice applies to each matched variant only.
    if (request.change.setPrice !== undefined) {
      const target = request.change.setPrice.toFixed(2);
      for (const v of matchedVariants) {
        if (v.price !== target) {
          entries.push({
            productId: product.id,
            productTitle: product.title,
            variantId: v.id,
            variantTitle: v.title,
            field: "price",
            oldValue: v.price,
            newValue: target,
          });
        }
      }
    }

    // Product-level changes apply to the whole product once at least one
    // variant matched — but only emit an entry when the value actually changes.
    if (request.change.setTitle) {
      const newTitle = request.change.setTitle(product.title);
      if (newTitle !== product.title) {
        entries.push({
          productId: product.id,
          productTitle: product.title,
          field: "title",
          oldValue: product.title,
          newValue: newTitle,
        });
      }
    }

    if (request.change.addTags && request.change.addTags.length > 0) {
      const existing = new Set(product.tags);
      const merged = [...product.tags];
      for (const t of request.change.addTags) {
        if (!existing.has(t)) merged.push(t);
      }
      if (merged.length !== product.tags.length) {
        entries.push({
          productId: product.id,
          productTitle: product.title,
          field: "tags",
          oldValue: product.tags,
          newValue: merged,
        });
      }
    }
  }

  const variantsAffected = new Set(
    entries.filter((e) => e.variantId).map((e) => e.variantId),
  ).size;
  const productsAffected = new Set(entries.map((e) => e.productId)).size;

  return {
    entries,
    matches,
    summary: {
      productsAffected,
      variantsAffected,
      lineItemChanges: entries.length,
    },
  };
}

/**
 * A variant matches when it satisfies every price/stock bound present.
 *
 * Price bounds form a HALF-OPEN interval [priceMin, priceMax):
 *   - priceMax is EXCLUSIVE (price < priceMax) so "under €40" (priceMax: 40)
 *     does not touch a €40.00 variant — matching the spec §1 wording "price < 40".
 *   - priceMin is INCLUSIVE (price >= priceMin) so "at least €40" (priceMin: 40)
 *     does include a €40.00 variant.
 * stockMin is inclusive (stock >= stockMin).
 *
 * NOTE (finding #4, documented not fixed): a variant with untracked inventory
 * arrives here as stock 0 (see readProductsByIds), so stockMin >= 1 excludes it.
 * Untracked arguably means "unlimited", not zero — revisit when a real catalog
 * with untracked variants exists to test against.
 */
function variantMatches(
  variant: { price: string; stock: number },
  filter: ChangeRequest["filter"],
): boolean {
  const price = Number(variant.price);
  if (filter.priceMax !== undefined && price >= filter.priceMax) return false;
  if (filter.priceMin !== undefined && price < filter.priceMin) return false;
  if (filter.stockMin !== undefined && variant.stock < filter.stockMin) return false;
  return true;
}

/**
 * Get candidate product ids using only the server-side product-level filters
 * (tag, collection). Throws if the candidate set is truncated — a partial diff
 * is not allowed. Price/stock are intentionally NOT sent to queryProducts; they
 * are applied per-variant during computation.
 */
async function selectCandidateIds(
  client: ShopifyClient,
  request: ChangeRequest,
  maxCandidates: number,
): Promise<string[]> {
  const { tag, collection } = request.filter;
  const collectionId = collection
    ? await resolveCollectionId(client, collection)
    : undefined;

  const { products, hasMore } = await queryProducts(client, {
    tag,
    collectionId,
    limit: maxCandidates,
  });

  if (hasMore) {
    throw new ValidationError(
      `Result set too large to preview safely: more than ${maxCandidates} candidate ` +
        `products match this filter. Narrow the filter (add a tag or collection) ` +
        `before requesting a diff.`,
      [],
      { candidateCount: products.length, hasMore },
    );
  }

  return products.map((p) => p.id);
}

/** Order gids by their trailing numeric id so entry order is deterministic. */
function sortByNumericId(ids: string[]): string[] {
  const key = (gid: string) => Number(gid.split("/").pop() ?? 0);
  return [...ids].sort((a, b) => key(a) - key(b));
}

/**
 * Resolve a collection title to its gid; throws if no such collection exists.
 *
 * Matches case-insensitively (finding #3): Shopify's title search is already
 * case-insensitive, so a strict `===` filter would reject a real collection on
 * any case difference — neither reliable matching nor reliable rejection. An
 * exact-case hit is preferred when several titles differ only by case.
 */
async function resolveCollectionId(client: ShopifyClient, title: string): Promise<string> {
  const { data } = await client.request<{
    collections: { nodes: Array<{ id: string; title: string }> };
  }>(
    `query FindCollection($q: String!) {
       collections(first: 10, query: $q) { nodes { id title } }
     }`,
    { q: `title:'${title.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` },
    { estimatedCost: 5 },
  );
  const nodes = data.collections.nodes;
  const match =
    nodes.find((c) => c.title === title) ??
    nodes.find((c) => c.title.toLowerCase() === title.toLowerCase());
  if (!match) {
    throw new ValidationError(`No collection titled "${title}"`, [], { title });
  }
  return match.id;
}

/** Highest number of variants read per product; see the refusal below. */
const VARIANT_READ_CAP = 100;

/**
 * Re-read products by id for authoritative current state (quirk #1). Batches ids
 * through nodes() so a large candidate set doesn't blow the query cost budget.
 *
 * Refuses (finding #2) rather than silently truncating a product with more than
 * VARIANT_READ_CAP variants: dropping variants 101+ would under-report matches
 * and misstate "M of N", which is the exact silent-partial-preview the engine
 * refuses at the product level via hasMore. Same discipline, one level down.
 */
export async function readProductsByIds(
  client: ShopifyClient,
  ids: string[],
): Promise<FreshProduct[]> {
  const out: FreshProduct[] = [];

  for (let i = 0; i < ids.length; i += READ_BATCH) {
    const batch = ids.slice(i, i + READ_BATCH);
    const { data } = await client.request<{
      nodes: Array<
        | {
            id: string;
            title: string;
            tags: string[];
            variants: {
              nodes: Array<{ id: string; title: string; price: string; inventoryQuantity: number | null }>;
              pageInfo: { hasNextPage: boolean };
            };
          }
        | null
      >;
    }>(
      `query ReadProducts($ids: [ID!]!) {
         nodes(ids: $ids) {
           ... on Product {
             id
             title
             tags
             variants(first: ${VARIANT_READ_CAP}) {
               nodes { id title price inventoryQuantity }
               pageInfo { hasNextPage }
             }
           }
         }
       }`,
      { ids: batch },
      { estimatedCost: READ_BATCH },
    );

    for (const node of data.nodes) {
      // A candidate can vanish between search and re-read (deleted, or the
      // search index was stale). Skip it — it simply isn't in the diff.
      if (!node) continue;
      if (node.variants.pageInfo.hasNextPage) {
        throw new ValidationError(
          `Product ${node.id} ("${node.title}") has more than ${VARIANT_READ_CAP} ` +
            `variants; the diff cannot preview it safely without dropping variants. ` +
            `Variant pagination is not yet supported.`,
          [],
          { productId: node.id },
        );
      }
      out.push({
        id: node.id,
        title: node.title,
        tags: node.tags,
        variants: node.variants.nodes.map((v) => ({
          id: v.id,
          title: v.title,
          price: v.price,
          stock: v.inventoryQuantity ?? 0,
        })),
      });
    }
  }

  return out;
}
