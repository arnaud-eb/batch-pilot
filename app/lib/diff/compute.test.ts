/**
 * Integration tests for the dry-run diff engine, against the real dev store.
 *
 * Uses the deterministic seed catalog (seed=42): "Urban  Mug 40" is a real
 * multi-variant product with variants at €38.99 and €44.99 — a genuine
 * price-boundary straddler, indexed (so no eventual-consistency lag) and stable
 * across reseeds. That is the Section 1 acceptance fixture.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ShopifyClient } from "../shopify/client";
import { ValidationError } from "../shopify/errors";
import { makeClient } from "../shopify/test-helpers";
import { computeDiff } from "./compute";
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
