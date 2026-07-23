/**
 * Integration tests for the dry-run diff engine, against the real dev store.
 *
 * Uses the deterministic seed catalog (seed=42): "Urban  Mug 40" is a real
 * multi-variant product with variants at €38.99 and €44.99 — a genuine
 * price-boundary straddler, indexed (so no eventual-consistency lag) and stable
 * across reseeds. That is the Section 1 acceptance fixture.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShopifyClient } from "../shopify/client";
import { ValidationError } from "../shopify/errors";
import {
  createManyVariantProduct,
  deleteScratchProduct,
  makeClient,
} from "../shopify/test-helpers";
import { computeDiff, readProductsByIds } from "./compute";
import type { ChangeRequest } from "./types";

// The straddler, from the seed catalog. If the seed changes, refind it.
const MUG = {
  title: "Urban  Mug 40",
  underForty: "38.99",
  overForty: "44.99",
};

let client: ShopifyClient;

beforeAll(async () => {
  client = await makeClient();
});

describe("computeDiff — per-variant price semantics (Section 1)", () => {
  it("changes only the matching variant of a straddling product", async () => {
    const request: ChangeRequest = {
      filter: { tag: "bp-seed", priceMax: 40 },
      change: { setPrice: 19.99 },
    };

    const diff = await computeDiff(client, request);

    // Locate the straddler by title among all matched products.
    const mugMatch = diff.matches.find((m) => m.productTitle === MUG.title);
    expect(mugMatch, "the straddling mug should be matched").toBeDefined();
    expect(mugMatch!.matchedVariants).toBe(1);
    expect(mugMatch!.totalVariants).toBe(2);
    expect(mugMatch!.partial).toBe(true);

    // Exactly one price change for that product: the €38.99 variant → €19.99.
    const mugEntries = diff.entries.filter((e) => e.productId === mugMatch!.productId);
    expect(mugEntries).toHaveLength(1);
    expect(mugEntries[0].field).toBe("price");
    expect(mugEntries[0].oldValue).toBe(MUG.underForty);
    expect(mugEntries[0].newValue).toBe("19.99");

    // The €44.99 variant must NOT appear anywhere in the diff.
    const touchesOverForty = diff.entries.some((e) => e.oldValue === MUG.overForty);
    expect(touchesOverForty).toBe(false);
  });

  it("excludes a variant priced exactly at priceMax (exclusive upper bound)", async () => {
    // The seed catalog has 4 variants priced exactly 40.00 (Bold Notebook 354,
    // Bold Tote Bag 405 ×2, minimal sticker pack 444). Under "price < 40" they
    // must NOT be touched. This test fails on the old inclusive (≤) behaviour
    // and passes on the exclusive (<) behaviour — it actually distinguishes them.
    const diff = await computeDiff(client, {
      filter: { tag: "bp-seed", priceMax: 40 },
      change: { setPrice: 9.99 },
    });
    const touchesForty = diff.entries.filter(
      (e) => e.field === "price" && e.oldValue === "40.00",
    );
    expect(touchesForty).toHaveLength(0);
  });

  it("includes a variant priced exactly at priceMin (inclusive lower bound)", async () => {
    // Half-open [40, 41): 40.00 is included, and the exclusive upper keeps out
    // anything ≥ 41. So a 40.00 variant must appear.
    const diff = await computeDiff(client, {
      filter: { tag: "bp-seed", priceMin: 40, priceMax: 41 },
      change: { setPrice: 9.99 },
    });
    const includesForty = diff.entries.some(
      (e) => e.field === "price" && e.oldValue === "40.00",
    );
    expect(includesForty).toBe(true);
    // And nothing at/above the exclusive upper bound sneaks in.
    const atOrAboveUpper = diff.entries.some(
      (e) => e.field === "price" && Number(e.oldValue) >= 41,
    );
    expect(atOrAboveUpper).toBe(false);
  });

  it("emits no entry when the matched variant already has the target price", async () => {
    // setPrice equals the under-40 variant's current price → no-op, no entry.
    const diff = await computeDiff(client, {
      filter: { tag: "bp-seed", priceMax: 40 },
      change: { setPrice: Number(MUG.underForty) },
    });
    const mugMatch = diff.matches.find((m) => m.productTitle === MUG.title)!;
    const mugEntries = diff.entries.filter((e) => e.productId === mugMatch.productId);
    // The 38.99 variant is already 38.99, so it produces no change entry —
    // but the product still appears in matches (a variant did match the filter).
    expect(mugEntries).toHaveLength(0);
    expect(mugMatch.matchedVariants).toBe(1);
  });
});

describe("computeDiff — product-level changes over matched products", () => {
  it("adds only genuinely-new tags, once per product", async () => {
    const diff = await computeDiff(client, {
      filter: { tag: "bp-seed", priceMax: 40 },
      change: { addTags: ["bp-seed", "diff-demo"] }, // bp-seed already present
    });
    // Every tag entry must introduce "diff-demo" and never re-add "bp-seed".
    const tagEntries = diff.entries.filter((e) => e.field === "tags");
    expect(tagEntries.length).toBeGreaterThan(0);
    for (const e of tagEntries) {
      const oldTags = e.oldValue as string[];
      const newTags = e.newValue as string[];
      expect(newTags).toContain("diff-demo");
      // bp-seed was already there, so count is unchanged for it (no duplicate).
      expect(newTags.filter((t) => t === "bp-seed")).toHaveLength(1);
      expect(newTags.length).toBe(oldTags.length + 1);
    }
  });
});

describe("computeDiff — collection resolution", () => {
  it("resolves a collection title case-insensitively", async () => {
    // Real collection is "Summer Essentials"; a lower-case request must resolve
    // it rather than throwing (finding #3). Kept cheap with a no-op-ish change.
    const diff = await computeDiff(client, {
      filter: { collection: "summer essentials", priceMax: 40 },
      change: { addTags: ["diff-demo"] },
    });
    expect(diff.matches.length).toBeGreaterThan(0);
  });

  it("throws on a collection title that does not exist in any case", async () => {
    await expect(
      computeDiff(client, {
        filter: { collection: "no such collection at all" },
        change: { addTags: ["x"] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("computeDiff — purity (Section 2 acceptance)", () => {
  it("returns identical results when run twice with no execution between", async () => {
    const request: ChangeRequest = {
      filter: { tag: "bp-seed", priceMax: 40 },
      change: { setPrice: 19.99, addTags: ["diff-demo"] },
    };
    const first = await computeDiff(client, request);
    const second = await computeDiff(client, request);

    // Order is derived from the same query pagination, so deep-equal holds.
    expect(second.summary).toEqual(first.summary);
    expect(second.entries).toEqual(first.entries);
    expect(second.matches).toEqual(first.matches);
  });
});

describe("readProductsByIds — >100-variant refusal (finding #2)", () => {
  // The guard lives in the re-read step. We create a real synthetic product
  // with >100 variants and pass its id straight to readProductsByIds — that is
  // exactly where the guard sits, and passing the id directly sidesteps the
  // unrelated search-index lag (a fresh product isn't tag-searchable yet).
  let fixtureId: string | null = null;
  let fixtureVariantCount = 0;

  beforeAll(async () => {
    const fixture = await createManyVariantProduct(client, 101);
    fixtureId = fixture.id;
    fixtureVariantCount = fixture.variantCount;
  }, 60_000);

  afterAll(async () => {
    if (fixtureId) await deleteScratchProduct(client, fixtureId);
  });

  it("created a fixture that actually exceeds the 100-variant read cap", () => {
    // Guards the guard's precondition: if this ever drops to ≤100, the refusal
    // test below would pass vacuously (nothing to truncate).
    expect(fixtureVariantCount).toBeGreaterThan(100);
  });

  it("refuses (throws) rather than silently truncating a >100-variant product", async () => {
    await expect(readProductsByIds(client, [fixtureId!])).rejects.toBeInstanceOf(ValidationError);
    await expect(readProductsByIds(client, [fixtureId!])).rejects.toThrow(/more than 100.*variants/i);
  });
});

describe("computeDiff — truncation refusal (Section 2 acceptance)", () => {
  it("throws rather than diffing a truncated candidate set", async () => {
    // bp-seed matches 600 products; a tiny ceiling forces the refusal.
    await expect(
      computeDiff(
        client,
        { filter: { tag: "bp-seed" }, change: { addTags: ["x"] } },
        { maxCandidates: 5 },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("succeeds when the candidate set fits under the ceiling", async () => {
    // Same filter, ample ceiling → completes without throwing.
    const diff = await computeDiff(
      client,
      { filter: { tag: "bp-seed", priceMax: 40 }, change: { setPrice: 19.99 } },
      { maxCandidates: 5000 },
    );
    expect(diff.summary.lineItemChanges).toBeGreaterThan(0);
  });
});
