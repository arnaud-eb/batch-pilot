/**
 * The GraphQL side of seeding: turn a generated SeedProduct into Admin API
 * calls, and provide the reset/query operations the idempotency logic needs.
 *
 * Every seeded product carries the marker tag `SEED_MARKER_TAG`. This is what
 * makes reset safe: it deletes only products it can prove it created, never a
 * product added by hand or by Shopify's sample data. That "don't delete what
 * you didn't create" property is a Phase 2 guardrail rehearsed early.
 */

import { ShopifyClient, assertNoUserErrors } from "../../app/lib/shopify/client";
import { NotFoundError } from "../../app/lib/shopify/errors";
import { escapeSearchValue } from "../../app/lib/shopify/tools";
import type { SeedProduct } from "./generate";

/** Namespaced so it can't collide with the realistic tag pool. */
export const SEED_MARKER_TAG = "bp-seed";

/** Shopify's inventory state name for on-hand available stock. */
const AVAILABLE_STATE = "available";

interface Location {
  id: string;
  name: string;
}

/** The single active location stock is attached to. */
export async function getPrimaryLocation(client: ShopifyClient): Promise<Location> {
  const { data } = await client.request<{
    locations: { nodes: Array<{ id: string; name: string; isActive: boolean }> };
  }>(
    `query { locations(first: 5) { nodes { id name isActive } } }`,
    {},
    { estimatedCost: 5 },
  );

  const active = data.locations.nodes.find((n) => n.isActive) ?? data.locations.nodes[0];
  if (!active) throw new NotFoundError("Location", "any active location");
  return { id: active.id, name: active.name };
}

/**
 * Ensure a collection exists, returning its id. Idempotent: an existing
 * collection with the same title is reused rather than duplicated, so re-runs
 * don't pile up "New Arrivals (2)".
 */
export async function ensureCollection(client: ShopifyClient, title: string): Promise<string> {
  const { data: found } = await client.request<{
    collections: { nodes: Array<{ id: string; title: string }> };
  }>(
    `query FindCollection($q: String!) {
       collections(first: 1, query: $q) { nodes { id title } }
     }`,
    { q: `title:'${escapeSearchValue(title)}'` },
    { estimatedCost: 5 },
  );

  const existing = found.collections.nodes.find((c) => c.title === title);
  if (existing) return existing.id;

  const { data } = await client.request<{
    collectionCreate: {
      collection: { id: string } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    `mutation CreateCollection($input: CollectionInput!) {
       collectionCreate(input: $input) {
         collection { id }
         userErrors { field message }
       }
     }`,
    { input: { title } },
    { estimatedCost: 10 },
  );

  assertNoUserErrors(data.collectionCreate, `collectionCreate(${title})`);
  const id = data.collectionCreate.collection?.id;
  if (!id) throw new NotFoundError("Collection", title);
  return id;
}

/**
 * Create one product with all its variants and inventory in a single
 * productSet call. `collectionIds` maps collection title -> gid, resolved once
 * up front so this doesn't re-query per product.
 */
export async function createSeedProduct(
  client: ShopifyClient,
  product: SeedProduct,
  ctx: { locationId: string; collectionIds: Map<string, string> },
): Promise<{ id: string; variantCount: number }> {
  const isMultiVariant = product.variants.length > 1 && product.variants[0].optionValue !== null;

  // productSet requires every variant to carry optionValues, even a single
  // default one. A multi-variant product gets a real Size/Color option; a
  // single-variant product gets Shopify's internal default, "Title" /
  // "Default Title", which is what the platform uses under the hood anyway.
  const optionName = isMultiVariant
    ? /^(XS|S|M|L|XL|XXL)$/.test(product.variants[0].optionValue ?? "")
      ? "Size"
      : "Color"
    : "Title";

  const productOptions = isMultiVariant
    ? [{ name: optionName, values: product.variants.map((v) => ({ name: v.optionValue! })) }]
    : [{ name: "Title", values: [{ name: "Default Title" }] }];

  const variants = product.variants.map((v) => ({
    price: v.price.toFixed(2),
    sku: v.sku,
    optionValues: [{ optionName, name: isMultiVariant ? v.optionValue! : "Default Title" }],
    inventoryQuantities: [
      { locationId: ctx.locationId, name: AVAILABLE_STATE, quantity: v.stock },
    ],
  }));

  const collections = product.collections
    .map((title) => ctx.collectionIds.get(title))
    .filter((id): id is string => Boolean(id));

  const input = {
    title: product.title,
    productType: product.productType,
    vendor: product.vendor,
    status: "ACTIVE",
    tags: [...product.tags, SEED_MARKER_TAG],
    collections,
    productOptions,
    variants,
  };

  const { data } = await client.request<{
    productSet: {
      product: { id: string; variants: { nodes: Array<{ id: string }> } } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    `mutation SeedProduct($input: ProductSetInput!) {
       productSet(input: $input, synchronous: true) {
         product { id variants(first: 10) { nodes { id } } }
         userErrors { field message }
       }
     }`,
    { input },
    { estimatedCost: 20 },
  );

  assertNoUserErrors(data.productSet, `productSet(${product.title.trim()})`);
  const created = data.productSet.product;
  if (!created) throw new NotFoundError("Product", product.title);
  return { id: created.id, variantCount: created.variants.nodes.length };
}

/** Every seeded product id, page by page. Used by reset and by count checks. */
export async function findSeedProductIds(client: ShopifyClient): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;

  for (;;) {
    const { data }: {
      data: {
        products: {
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    } = await client.request(
      `query SeedProducts($cursor: String) {
         products(first: 100, after: $cursor, query: "tag:${SEED_MARKER_TAG}") {
           nodes { id }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { cursor },
      { estimatedCost: 20 },
    );

    ids.push(...data.products.nodes.map((n) => n.id));
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }

  return ids;
}

/** Delete one product. Treats an already-gone product as success, not error. */
export async function deleteProduct(client: ShopifyClient, id: string): Promise<void> {
  const { data } = await client.request<{
    productDelete: {
      deletedProductId: string | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    `mutation DeleteProduct($input: ProductDeleteInput!) {
       productDelete(input: $input) {
         deletedProductId
         userErrors { field message }
       }
     }`,
    { input: { id } },
    { estimatedCost: 10 },
  );

  assertNoUserErrors(data.productDelete, `productDelete(${id})`);
}
