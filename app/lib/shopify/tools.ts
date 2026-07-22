/**
 * The tool wrapper layer: small, typed, reliable operations over the Admin
 * GraphQL API. Deliberately dumb — no business logic, no AI. These become the
 * "tools" an agent calls in Phase 3, so their contract matters more than their
 * cleverness: typed inputs and outputs, and failure modes that are
 * distinguishable (not found vs. validation vs. rate limited) rather than one
 * generic throw.
 *
 * All rate-limit handling lives in ShopifyClient; these functions assume calls
 * either succeed or raise a typed ShopifyError.
 */

import { ShopifyClient, assertNoUserErrors } from "./client";
import { NotFoundError, ValidationError } from "./errors";

// ─── Shared shapes ───────────────────────────────────────────────────────────

export interface ProductSummary {
  id: string;
  title: string;
  /**
   * The product's lowest variant price, as a decimal string ("44.95"). A
   * product can have many variants at many prices; queryProducts reports the
   * minimum so callers have a single stable number. Callers needing per-variant
   * prices should read `variants`.
   *
   * DELIBERATE SIMPLIFICATION (Phase 0-1): price bounds in ProductFilters are
   * evaluated against this minimum, so a product matches priceMax:40 if its
   * cheapest variant is ≤ 40 even when it also has a €55 variant. Phase 2's diff
   * layer is expected to become variant-aware — evaluating each variant against
   * the bound and previewing "3 of 5 variants match" — using the full `variants`
   * array this tool already returns. Until then, treat a price match as
   * "the product has at least one variant near this bound", not "every variant
   * qualifies". See docs/phase-0-1-spec.md.
   */
  price: string;
  /** Total on-hand inventory across all variants and locations. */
  stock: number;
  tags: string[];
  /** Titles of every collection the product belongs to (can be several). */
  collections: string[];
  variants: Array<{ id: string; title: string; price: string; stock: number }>;
}

export interface ProductFilters {
  /** Inclusive lower bound on the product's minimum variant price. See ProductSummary.price. */
  priceMin?: number;
  /** Inclusive upper bound on the product's minimum variant price. See ProductSummary.price. */
  priceMax?: number;
  /** Inclusive lower bound on total inventory. */
  stockMin?: number;
  /** Inclusive upper bound on total inventory. */
  stockMax?: number;
  /** Products carrying this tag. */
  tag?: string;
  /** Products in this collection, by collection gid. */
  collectionId?: string;
  /** Hard cap on results returned. Defaults to 250. See QueryResult.hasMore. */
  limit?: number;
}

/**
 * Result of queryProducts. `hasMore` is the anti-silent-truncation signal: it is
 * true when the store held more matching products than `limit` returned, so
 * callers (notably Phase 2's diff preview) never mistake a capped page for the
 * complete set. When true, raise the limit or paginate — do not present the
 * partial set as "everything that matches".
 */
export interface QueryResult {
  products: ProductSummary[];
  hasMore: boolean;
}

// ─── Fragments ───────────────────────────────────────────────────────────────

const PRODUCT_FIELDS = `
  id
  title
  tags
  totalInventory
  collections(first: 20) { nodes { title } }
  variants(first: 100) { nodes { id title price inventoryQuantity } }
`;

interface RawProduct {
  id: string;
  title: string;
  tags: string[];
  totalInventory: number;
  collections: { nodes: Array<{ title: string }> };
  variants: { nodes: Array<{ id: string; title: string; price: string; inventoryQuantity: number | null }> };
}

function toSummary(p: RawProduct): ProductSummary {
  const variants = p.variants.nodes.map((v) => ({
    id: v.id,
    title: v.title,
    price: v.price,
    stock: v.inventoryQuantity ?? 0,
  }));
  const minPrice = variants.reduce(
    (min, v) => (Number(v.price) < Number(min) ? v.price : min),
    variants[0]?.price ?? "0.00",
  );
  return {
    id: p.id,
    title: p.title,
    price: minPrice,
    stock: p.totalInventory ?? 0,
    tags: p.tags,
    collections: p.collections.nodes.map((c) => c.title),
    variants,
  };
}

/**
 * Build the Shopify search-query DSL string from the filters Shopify can
 * evaluate server-side. Price is deliberately absent: it lives on variants and
 * isn't reliably filterable in the products query, so queryProducts applies
 * price bounds client-side after fetching.
 */
function buildQueryString(filters: ProductFilters): string {
  const clauses: string[] = [];
  if (filters.tag) clauses.push(`tag:'${escapeSearchValue(filters.tag)}'`);
  if (filters.collectionId) {
    // A collection gid ends in a numeric id (gid://shopify/Collection/123).
    // Take that trailing id and require it to be digits, so a malformed gid
    // can't inject a raw fragment into the search string.
    const numericId = filters.collectionId.split("/").pop();
    if (numericId && /^\d+$/.test(numericId)) {
      clauses.push(`collection_id:${numericId}`);
    } else {
      throw new ValidationError(
        `collectionId must be a Collection gid ending in a numeric id, got: ${filters.collectionId}`,
        [],
        { collectionId: filters.collectionId },
      );
    }
  }
  if (filters.stockMin !== undefined) clauses.push(`inventory_total:>=${filters.stockMin}`);
  if (filters.stockMax !== undefined) clauses.push(`inventory_total:<=${filters.stockMax}`);
  return clauses.join(" AND ");
}

/**
 * Escape a value for use inside a single-quoted Shopify search phrase. Escape
 * backslashes first, then quotes — reversing the order would double-escape the
 * backslashes the quote-escaping introduces. Exported as the one canonical
 * escaper so callers building search strings don't each roll their own.
 */
export function escapeSearchValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ─── queryProducts ───────────────────────────────────────────────────────────

/**
 * Search products by price range, stock threshold, tag, and/or collection.
 * Server-evaluable filters (tag, collection, stock) go into the query string;
 * price bounds are applied client-side against each product's minimum variant
 * price. Paginates until the limit is reached or the store is exhausted.
 *
 * Returns { products, hasMore }. `hasMore` is true when more products matched
 * than `limit` returned — callers must not treat a capped result as the full
 * set (Phase 2's diff preview depends on knowing the difference). If price
 * filters exclude most of the catalog, note that pagination still reads every
 * page to find matches, since price isn't evaluated server-side.
 */
export async function queryProducts(
  client: ShopifyClient,
  filters: ProductFilters = {},
): Promise<QueryResult> {
  const limit = filters.limit ?? 250;
  const queryString = buildQueryString(filters);
  // Collect one match beyond the limit: its existence is exactly what hasMore
  // reports. This also fixes the boundary case where the limit-th match is the
  // last product on its page — we still look further to know if more matched.
  const target = limit + 1;
  const matches: ProductSummary[] = [];
  let cursor: string | null = null;

  outer: while (matches.length < target) {
    const { data }: { data: { products: {
      nodes: RawProduct[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } } } = await client.request(
      `query QueryProducts($cursor: String, $q: String) {
         products(first: 100, after: $cursor, query: $q) {
           nodes { ${PRODUCT_FIELDS} }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { cursor, q: queryString || null },
      { estimatedCost: 60 },
    );

    for (const raw of data.products.nodes) {
      const summary = toSummary(raw);
      const price = Number(summary.price);
      if (filters.priceMin !== undefined && price < filters.priceMin) continue;
      if (filters.priceMax !== undefined && price > filters.priceMax) continue;
      matches.push(summary);
      if (matches.length >= target) break outer;
    }

    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }

  const hasMore = matches.length > limit;
  return { products: matches.slice(0, limit), hasMore };
}

// ─── updateProduct ───────────────────────────────────────────────────────────

export interface ProductChanges {
  title?: string;
  /**
   * Replaces the product's entire tag set. To add tags without clobbering the
   * existing ones, use addTags instead — this is the overwrite operation.
   */
  tags?: string[];
}

export interface UpdatedProduct {
  id: string;
  title: string;
  tags: string[];
}

/** Update product-level fields (title, tags). Returns the updated fields. */
export async function updateProduct(
  client: ShopifyClient,
  id: string,
  changes: ProductChanges,
): Promise<UpdatedProduct> {
  if (changes.title === undefined && changes.tags === undefined) {
    throw new ValidationError("updateProduct called with no changes", [], { id });
  }

  const { data } = await client.request<{
    productUpdate: {
      product: { id: string; title: string; tags: string[] } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    `mutation UpdateProduct($product: ProductUpdateInput!) {
       productUpdate(product: $product) {
         product { id title tags }
         userErrors { field message }
       }
     }`,
    {
      product: {
        id,
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...(changes.tags !== undefined ? { tags: changes.tags } : {}),
      },
    },
    { estimatedCost: 10 },
  );

  throwIfMissing(data.productUpdate.userErrors, "Product", id);
  assertNoUserErrors(data.productUpdate, `updateProduct(${id})`);
  const product = data.productUpdate.product;
  if (!product) throw new NotFoundError("Product", id);
  return product;
}

// ─── updateVariant ───────────────────────────────────────────────────────────

export interface VariantChanges {
  /** New price as a number; serialized to a 2-decimal Money string. */
  price?: number;
  compareAtPrice?: number;
}

export interface UpdatedVariant {
  id: string;
  price: string;
  compareAtPrice: string | null;
}

/**
 * Update variant-level fields (price, compareAtPrice). The bulk mutation needs
 * the owning product id, which isn't in the caller's hands, so this resolves it
 * from the variant id first — one extra read, but it keeps the tool's signature
 * honest (you pass a variant id, nothing else).
 */
export async function updateVariant(
  client: ShopifyClient,
  id: string,
  changes: VariantChanges,
): Promise<UpdatedVariant> {
  if (changes.price === undefined && changes.compareAtPrice === undefined) {
    throw new ValidationError("updateVariant called with no changes", [], { id });
  }

  const { data: lookup } = await client.request<{
    productVariant: { id: string; product: { id: string } } | null;
  }>(
    `query VariantProduct($id: ID!) {
       productVariant(id: $id) { id product { id } }
     }`,
    { id },
    { estimatedCost: 5 },
  );

  if (!lookup.productVariant) throw new NotFoundError("ProductVariant", id);
  const productId = lookup.productVariant.product.id;

  const { data } = await client.request<{
    productVariantsBulkUpdate: {
      productVariants: Array<{ id: string; price: string; compareAtPrice: string | null }> | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    `mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         productVariants { id price compareAtPrice }
         userErrors { field message }
       }
     }`,
    {
      productId,
      variants: [
        {
          id,
          ...(changes.price !== undefined ? { price: changes.price.toFixed(2) } : {}),
          ...(changes.compareAtPrice !== undefined
            ? { compareAtPrice: changes.compareAtPrice.toFixed(2) }
            : {}),
        },
      ],
    },
    { estimatedCost: 10 },
  );

  assertNoUserErrors(data.productVariantsBulkUpdate, `updateVariant(${id})`);
  const updated = data.productVariantsBulkUpdate.productVariants?.[0];
  if (!updated) throw new NotFoundError("ProductVariant", id);
  return updated;
}

// ─── addTags ─────────────────────────────────────────────────────────────────

export interface TaggedProduct {
  id: string;
  tags: string[];
}

/**
 * Add tags to a product without clobbering existing ones. Uses Shopify's native
 * tagsAdd, which merges and de-duplicates server-side — the platform guarantees
 * the "merge, not overwrite" contract, so this wrapper doesn't read-modify-write
 * (which would race).
 */
export async function addTags(
  client: ShopifyClient,
  id: string,
  tags: string[],
): Promise<TaggedProduct> {
  if (tags.length === 0) {
    throw new ValidationError("addTags called with no tags", [], { id });
  }

  const { data } = await client.request<{
    tagsAdd: {
      node: { id: string; tags?: string[] } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    `mutation AddTags($id: ID!, $tags: [String!]!) {
       tagsAdd(id: $id, tags: $tags) {
         node { id ... on Product { tags } }
         userErrors { field message }
       }
     }`,
    { id, tags },
    { estimatedCost: 10 },
  );

  throwIfMissing(data.tagsAdd.userErrors, "Product", id);
  assertNoUserErrors(data.tagsAdd, `addTags(${id})`);
  const node = data.tagsAdd.node;
  if (!node) throw new NotFoundError("Product", id);
  return { id: node.id, tags: node.tags ?? [] };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Shopify reports a missing resource as a userError, not a distinct status.
 * Promote those to NotFoundError so callers can tell "the id was wrong" from
 * "the change was invalid" — a distinction Phase 2's diff engine depends on.
 */
function throwIfMissing(
  userErrors: Array<{ field: string[] | null; message: string }>,
  resource: string,
  id: string,
): void {
  const notFound = userErrors.some((e) =>
    /does not exist|couldn't find|not found|invalid id/i.test(e.message),
  );
  if (notFound) throw new NotFoundError(resource, id);
}
