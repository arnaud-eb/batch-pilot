/**
 * Integration tests for the execution engine, against the real dev store.
 *
 * These perform real mutations, so they operate ONLY on disposable scratch
 * products (tagged bp-test), never the seed catalog — executing against seed
 * data would corrupt the fixtures the diff tests depend on. Each test builds a
 * diff by hand over products it created (the engine's contract is "take a diff,
 * apply it"; where the diff came from is Section 2's concern), executes it, then
 * confirms the change with an INDEPENDENT follow-up query — not the engine's own
 * verified flag.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShopifyClient } from "../shopify/client";
import {
  ScratchProduct,
  createScratchProduct,
  deleteScratchProduct,
  makeClient,
} from "../shopify/test-helpers";
import { executeDiff, ExecutionRefusedError } from "./execute";
import type { DiffEntry, DiffResult } from "../diff/types";

let client: ShopifyClient;

beforeAll(async () => {
  client = await makeClient();
});

/** Wrap entries in a minimal DiffResult (execute only reads .entries). */
function asDiff(entries: DiffEntry[]): DiffResult {
  const variantsAffected = new Set(entries.filter((e) => e.variantId).map((e) => e.variantId)).size;
  const productsAffected = new Set(entries.map((e) => e.productId)).size;
  return {
    entries,
    matches: [],
    summary: { productsAffected, variantsAffected, lineItemChanges: entries.length },
  };
}

/** Independent re-read of a variant's price, bypassing the engine entirely. */
async function readVariantPrice(id: string): Promise<string | null> {
  const { data } = await client.request<{ productVariant: { price: string } | null }>(
    `query ($id: ID!) { productVariant(id: $id) { price } }`,
    { id },
    { estimatedCost: 5 },
  );
  return data.productVariant?.price ?? null;
}

describe("executeDiff — approval gate", () => {
  it("refuses to run without explicit approval", async () => {
    await expect(
      executeDiff(client, asDiff([]), { approved: false }),
    ).rejects.toBeInstanceOf(ExecutionRefusedError);
  });

  it("runs (trivially) on an empty approved diff", async () => {
    const result = await executeDiff(client, asDiff([]), { approved: true });
    expect(result.summary).toEqual({ total: 0, succeeded: 0, failed: 0, skipped: 0 });
  });
});

describe("executeDiff — batch of 20 real items (Section 3 acceptance)", () => {
  const BATCH = 20;
  const scratch: ScratchProduct[] = [];

  beforeAll(async () => {
    // Create the 20 fixtures in parallel (cheap, well under the cost bucket).
    const created = await Promise.all(
      Array.from({ length: BATCH }, (_, i) =>
        createScratchProduct(client, { title: `Exec Fixture ${i}`, price: 10 }),
      ),
    );
    scratch.push(...created);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(scratch.map((p) => deleteScratchProduct(client, p.id).catch(() => {})));
  });

  it("executes 20 price changes and every one is confirmed by an independent query", async () => {
    // Each fixture starts at 10.00; give each a distinct new price 20.00..39.00.
    const entries: DiffEntry[] = scratch.map((p, i) => ({
      productId: p.id,
      productTitle: p.title,
      variantId: p.variantId,
      variantTitle: "Default Title",
      field: "price",
      oldValue: "10.00",
      newValue: (20 + i).toFixed(2),
    }));

    const result = await executeDiff(client, asDiff(entries), {
      approved: true,
      approvedBy: "execute.test",
    });

    expect(result.summary.total).toBe(BATCH);
    expect(result.summary.succeeded).toBe(BATCH);
    expect(result.summary.failed).toBe(0);
    expect(result.results.every((r) => r.verified)).toBe(true);

    // Independent confirmation: query each variant directly and check the price.
    for (const [i, p] of scratch.entries()) {
      const price = await readVariantPrice(p.variantId);
      expect(price, `fixture ${i} price`).toBe((20 + i).toFixed(2));
    }

    // Serial execution should complete a 20-item batch in reasonable time.
    expect(result.durationMs).toBeLessThan(60_000);
    // Results preserve input order (a serial-execution signal).
    expect(result.results.map((r) => r.entry.productId)).toEqual(scratch.map((p) => p.id));
  });
});

describe("executeDiff — continues past a failure", () => {
  const scratch: ScratchProduct[] = [];

  beforeAll(async () => {
    const created = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        createScratchProduct(client, { title: `Partial Fixture ${i}`, price: 10 }),
      ),
    );
    scratch.push(...created);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(scratch.map((p) => deleteScratchProduct(client, p.id).catch(() => {})));
  });

  it("marks the bad item failed, applies the rest, and does not abort", async () => {
    const good = (p: ScratchProduct, i: number): DiffEntry => ({
      productId: p.id,
      productTitle: p.title,
      variantId: p.variantId,
      variantTitle: "Default Title",
      field: "price",
      oldValue: "10.00",
      newValue: (50 + i).toFixed(2),
    });
    // A bogus variant id sandwiched between valid ones.
    const bad: DiffEntry = {
      productId: "gid://shopify/Product/1",
      productTitle: "does not exist",
      variantId: "gid://shopify/ProductVariant/1",
      variantTitle: "-",
      field: "price",
      oldValue: "0.00",
      newValue: "99.99",
    };

    const entries = [good(scratch[0], 0), bad, good(scratch[1], 1), good(scratch[2], 2)];
    const result = await executeDiff(client, asDiff(entries), { approved: true });

    expect(result.summary.total).toBe(4);
    expect(result.summary.succeeded).toBe(3);
    expect(result.summary.failed).toBe(1);

    const failed = result.results.find((r) => r.status === "failed");
    expect(failed?.entry.productId).toBe("gid://shopify/Product/1");
    expect(failed?.error).toBeTruthy();

    // The valid items after the failure really were applied.
    expect(await readVariantPrice(scratch[1].variantId)).toBe("51.00");
    expect(await readVariantPrice(scratch[2].variantId)).toBe("52.00");
  });
});
