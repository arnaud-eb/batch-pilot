/**
 * Shared setup for the integration tests. These run against the real dev store
 * (spec §3: "No mocked API responses at this stage"), so the helpers here make
 * a real client and create disposable scratch products that clean themselves
 * up, keeping tests isolated from the seed catalog and from each other.
 */

import "../../../scripts/lib/env";
import { ShopifyClient } from "./client";
import { loadOfflineSession } from "../../../scripts/lib/session";

/** Marker distinct from the seed marker, so test cleanup never touches seed data. */
export const TEST_MARKER_TAG = "bp-test";

export async function makeClient(
  overrides: Partial<ConstructorParameters<typeof ShopifyClient>[0]> = {},
): Promise<ShopifyClient> {
  const session = await loadOfflineSession(process.env.SHOPIFY_SHOP_DOMAIN);
  return new ShopifyClient({
    shop: session.shop,
    accessToken: session.accessToken,
    ...overrides,
  });
}

let cachedLocationId: string | null = null;

async function primaryLocationId(client: ShopifyClient): Promise<string> {
  if (cachedLocationId) return cachedLocationId;
  const { data } = await client.request<{
    locations: { nodes: Array<{ id: string; isActive: boolean }> };
  }>(`query { locations(first: 5) { nodes { id isActive } } }`, {}, { estimatedCost: 5 });
  const loc = data.locations.nodes.find((n) => n.isActive) ?? data.locations.nodes[0];
  cachedLocationId = loc.id;
  return loc.id;
}

export interface ScratchProduct {
  id: string;
  variantId: string;
  title: string;
}

/**
 * Create a throwaway product to mutate in a test. Single default variant with a
 * known price and stock; tagged with TEST_MARKER_TAG plus any extras. Delete it
 * with deleteScratchProduct in a finally/afterEach.
 */
export async function createScratchProduct(
  client: ShopifyClient,
  opts: { title: string; price?: number; stock?: number; tags?: string[] },
): Promise<ScratchProduct> {
  const locationId = await primaryLocationId(client);
  const { data } = await client.request<{
    productSet: {
      product: { id: string; variants: { nodes: Array<{ id: string }> } } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    `mutation ($input: ProductSetInput!) {
       productSet(input: $input, synchronous: true) {
         product { id variants(first: 1) { nodes { id } } }
         userErrors { field message }
       }
     }`,
    {
      input: {
        title: opts.title,
        status: "ACTIVE",
        tags: [TEST_MARKER_TAG, ...(opts.tags ?? [])],
        productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants: [
          {
            price: (opts.price ?? 10).toFixed(2),
            optionValues: [{ optionName: "Title", name: "Default Title" }],
            inventoryQuantities: [
              { locationId, name: "available", quantity: opts.stock ?? 5 },
            ],
          },
        ],
      },
    },
    { estimatedCost: 20 },
  );

  const errs = data.productSet.userErrors;
  if (errs.length) throw new Error(`scratch product setup failed: ${errs.map((e) => e.message).join("; ")}`);
  const product = data.productSet.product!;
  return { id: product.id, variantId: product.variants.nodes[0].id, title: opts.title };
}

/**
 * Create a synthetic product with at least `minVariants` variants, to exercise
 * code paths that only trigger past the 100-variant read cap. The data is not
 * realistic — two options whose cartesian product crosses the threshold — it
 * exists only to cross it. Returns the product id; delete with
 * deleteScratchProduct. Tagged TEST_MARKER_TAG so cleanup never hits seed data.
 */
export async function createManyVariantProduct(
  client: ShopifyClient,
  minVariants: number,
): Promise<{ id: string; variantCount: number }> {
  // Choose factor counts whose product is ≥ minVariants (e.g. 15×7 = 105).
  const betaCount = 7;
  const alphaCount = Math.ceil(minVariants / betaCount);
  const alpha = Array.from({ length: alphaCount }, (_, i) => `a${i + 1}`);
  const beta = Array.from({ length: betaCount }, (_, i) => `b${i + 1}`);
  const variants = alpha.flatMap((a) =>
    beta.map((b) => ({
      price: "1.00",
      optionValues: [
        { optionName: "Alpha", name: a },
        { optionName: "Beta", name: b },
      ],
    })),
  );

  const { data } = await client.request<{
    productSet: {
      product: { id: string; variantsCount: { count: number } | null } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(
    `mutation ($input: ProductSetInput!) {
       productSet(input: $input, synchronous: true) {
         product { id variantsCount { count } }
         userErrors { field message }
       }
     }`,
    {
      input: {
        title: `BP VERIFY ${variants.length}-variant fixture`,
        status: "DRAFT",
        tags: [TEST_MARKER_TAG],
        productOptions: [
          { name: "Alpha", values: alpha.map((name) => ({ name })) },
          { name: "Beta", values: beta.map((name) => ({ name })) },
        ],
        variants,
      },
    },
    { estimatedCost: 200 },
  );

  const errs = data.productSet.userErrors;
  if (errs.length) {
    throw new Error(`many-variant fixture setup failed: ${errs.map((e) => e.message).join("; ")}`);
  }
  const product = data.productSet.product!;
  return { id: product.id, variantCount: product.variantsCount?.count ?? variants.length };
}

export async function deleteScratchProduct(client: ShopifyClient, id: string): Promise<void> {
  await client.request(
    `mutation ($input: ProductDeleteInput!) {
       productDelete(input: $input) { deletedProductId userErrors { message } }
     }`,
    { input: { id } },
    { estimatedCost: 10 },
  );
}
