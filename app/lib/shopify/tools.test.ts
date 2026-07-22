/**
 * Integration tests for the four tool wrappers, against the real dev store.
 *
 * Every test follows the spec's mutate-then-query pattern: perform the change,
 * then read the resource back with an independent query and assert the change
 * actually landed. No mocked responses — the point is confidence the wrappers
 * work against the real API, not against our assumptions about it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShopifyClient } from "./client";
import { NotFoundError, ValidationError } from "./errors";
import { addTags, queryProducts, updateProduct, updateVariant } from "./tools";
import {
  ScratchProduct,
  createScratchProduct,
  deleteScratchProduct,
  makeClient,
} from "./test-helpers";

let client: ShopifyClient;
const toClean: string[] = [];

beforeAll(async () => {
  client = await makeClient();
});

afterAll(async () => {
  for (const id of toClean) {
    try {
      await deleteScratchProduct(client, id);
    } catch {
      // Best-effort cleanup; a leaked scratch product is tagged bp-test and
      // removable later, not worth failing the suite over.
    }
  }
});

async function scratch(opts: Parameters<typeof createScratchProduct>[1]): Promise<ScratchProduct> {
  const p = await createScratchProduct(client, opts);
  toClean.push(p.id);
  return p;
}

/** Read a product straight from the API, bypassing our wrappers, to verify. */
async function readProduct(id: string) {
  const { data } = await client.request<{
    product: {
      id: string;
      title: string;
      tags: string[];
      variants: { nodes: Array<{ id: string; price: string }> };
    } | null;
  }>(
    `query ($id: ID!) {
       product(id: $id) { id title tags variants(first: 5) { nodes { id price } } }
     }`,
    { id },
    { estimatedCost: 5 },
  );
  return data.product;
}

describe("updateProduct", () => {
  it("changes the title and the change is visible on re-query", async () => {
    const p = await scratch({ title: "ScratchTitle A" });

    const result = await updateProduct(client, p.id, { title: "Renamed Title A" });
    expect(result.title).toBe("Renamed Title A");

    const fresh = await readProduct(p.id);
    expect(fresh?.title).toBe("Renamed Title A");
  });

  it("replaces the tag set wholesale (unlike addTags)", async () => {
    const p = await scratch({ title: "ScratchTitle B", tags: ["keep-me", "and-me"] });

    await updateProduct(client, p.id, { tags: ["only-this"] });

    const fresh = await readProduct(p.id);
    expect(fresh?.tags).toEqual(["only-this"]);
    expect(fresh?.tags).not.toContain("keep-me");
  });

  it("raises NotFoundError for a nonexistent product id", async () => {
    await expect(
      updateProduct(client, "gid://shopify/Product/1", { title: "x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("raises ValidationError when no changes are supplied", async () => {
    const p = await scratch({ title: "ScratchTitle C" });
    await expect(updateProduct(client, p.id, {})).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("updateVariant", () => {
  it("changes the price and the change is visible on re-query", async () => {
    const p = await scratch({ title: "ScratchVariant A", price: 20 });

    const result = await updateVariant(client, p.variantId, { price: 33.5 });
    expect(result.price).toBe("33.50");

    const fresh = await readProduct(p.id);
    expect(fresh?.variants.nodes[0].price).toBe("33.50");
  });

  it("raises NotFoundError for a nonexistent variant id", async () => {
    await expect(
      updateVariant(client, "gid://shopify/ProductVariant/1", { price: 9.99 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("addTags", () => {
  it("merges new tags without clobbering existing ones", async () => {
    const p = await scratch({ title: "ScratchTags A", tags: ["original-1", "original-2"] });

    const result = await addTags(client, p.id, ["added-1", "added-2"]);

    // The returned set contains both old and new.
    for (const t of ["original-1", "original-2", "added-1", "added-2"]) {
      expect(result.tags).toContain(t);
    }

    const fresh = await readProduct(p.id);
    expect(fresh?.tags).toEqual(expect.arrayContaining(["original-1", "added-1"]));
  });

  it("de-duplicates when adding a tag that already exists", async () => {
    const p = await scratch({ title: "ScratchTags B", tags: ["dup"] });

    await addTags(client, p.id, ["dup", "fresh"]);

    const fresh = await readProduct(p.id);
    const dupCount = fresh?.tags.filter((t) => t === "dup").length;
    expect(dupCount).toBe(1);
    expect(fresh?.tags).toContain("fresh");
  });
});

// queryProducts is tested against the already-indexed seed catalog, not
// freshly-created scratch products: Shopify's tag/inventory search index is
// eventually consistent, so a just-created product isn't searchable for a short
// lag. The seed products (tag:bp-seed) have long since been indexed.
describe("queryProducts", () => {
  it("finds seeded products by tag and returns the typed shape", async () => {
    const { products } = await queryProducts(client, { tag: "bp-seed", limit: 5 });

    expect(products.length).toBeGreaterThan(0);
    const hit = products[0];
    expect(typeof hit.id).toBe("string");
    expect(typeof hit.title).toBe("string");
    expect(hit.price).toMatch(/^\d+\.\d{2}$/);
    expect(typeof hit.stock).toBe("number");
    expect(hit.tags).toContain("bp-seed");
    expect(Array.isArray(hit.collections)).toBe(true);
    expect(hit.variants.length).toBeGreaterThan(0);
  });

  it("signals hasMore when truncation happens mid-page", async () => {
    // The common case: limit smaller than a page, so the cut falls inside the
    // first page of results. (Note: this case alone does NOT exercise the
    // page-boundary bug — see the next test.)
    const { products, hasMore } = await queryProducts(client, { tag: "bp-seed", limit: 3 });
    expect(products).toHaveLength(3);
    expect(hasMore).toBe(true);
  });

  it("signals hasMore at a page boundary (limit == the 100-per-page fetch size)", async () => {
    // Regression guard for the boundary bug fixed during review: when the
    // limit-th match is the LAST product on its page, naive
    // `while (results.length < limit)` pagination exits without looking at the
    // next page and reports hasMore=false even though more matched. Verified
    // against the store that the pre-fix algorithm returned false here while the
    // over-fetch-by-one fix returns true. Requires >100 bp-seed products (600).
    const { products, hasMore } = await queryProducts(client, { tag: "bp-seed", limit: 100 });
    expect(products).toHaveLength(100);
    expect(hasMore).toBe(true);
  });

  it("reports hasMore false when the whole matching set fits", async () => {
    const uniqueTag = "bp-seed";
    const { products, hasMore } = await queryProducts(client, { tag: uniqueTag, limit: 100000 });
    expect(products.length).toBeGreaterThan(0);
    expect(hasMore).toBe(false);
  });

  it("applies a price ceiling client-side", async () => {
    const { products } = await queryProducts(client, { tag: "bp-seed", priceMax: 40, limit: 50 });

    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect(Number(p.price)).toBeLessThanOrEqual(40);
    }
  });

  it("applies a price floor client-side", async () => {
    const { products } = await queryProducts(client, { tag: "bp-seed", priceMin: 100, limit: 50 });

    for (const p of products) {
      expect(Number(p.price)).toBeGreaterThanOrEqual(100);
    }
  });

  it("returns min variant price for multi-variant products", async () => {
    // Pull a decent sample and confirm the reported price is the variant min.
    const { products } = await queryProducts(client, { tag: "bp-seed", limit: 100 });
    const multi = products.find((p) => p.variants.length > 1);
    expect(multi, "seed catalog should contain multi-variant products").toBeDefined();
    const min = Math.min(...multi!.variants.map((v) => Number(v.price)));
    expect(Number(multi!.price)).toBe(min);
  });

  it("rejects a malformed collectionId", async () => {
    await expect(
      queryProducts(client, { collectionId: "not-a-gid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns an empty set for a tag that matches nothing", async () => {
    const { products, hasMore } = await queryProducts(client, { tag: `bp-test-none-${Date.now()}` });
    expect(products).toEqual([]);
    expect(hasMore).toBe(false);
  });
});
