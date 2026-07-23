/**
 * Full approve → execute → verify cycle, end to end, on disposable products.
 *
 *   npm run execute:demo
 *
 * Unlike the unit tests (which hand-build diffs), this runs the real pipeline:
 * computeDiff produces the diff, it is explicitly approved, the execution engine
 * applies it, and then an INDEPENDENT query — not the engine's own report —
 * confirms the store actually changed. Everything is on throwaway products
 * tagged bp-exec-demo, deleted at the end. Seed data is never touched.
 */

import "./lib/env";
import { computeDiff } from "../app/lib/diff/compute";
import { executeDiff } from "../app/lib/execute/execute";
import { queryProducts } from "../app/lib/shopify/tools";
import {
  createScratchProduct,
  deleteScratchProduct,
  makeClient,
} from "../app/lib/shopify/test-helpers";
import type { ShopifyClient } from "../app/lib/shopify/client";

const DEMO_TAG = "bp-exec-demo";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForIndex(client: ShopifyClient, count: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const { products } = await queryProducts(client, { tag: DEMO_TAG, limit: 50 });
    if (products.length >= count) return;
    await sleep(2000);
  }
  throw new Error("fixtures never became searchable (index lag exceeded 60s)");
}

async function currentPrice(client: ShopifyClient, variantId: string): Promise<string> {
  const { data } = await client.request<{ productVariant: { price: string } | null }>(
    `query ($id: ID!) { productVariant(id: $id) { price } }`,
    { id: variantId },
    { estimatedCost: 5 },
  );
  return data.productVariant?.price ?? "?";
}

async function main() {
  const client = await makeClient();
  const prices = [25, 30, 35];

  console.log("SETUP — creating 3 disposable fixtures");
  const fixtures = await Promise.all(
    prices.map((p, i) =>
      createScratchProduct(client, {
        title: `Exec Demo ${String.fromCharCode(65 + i)}`,
        price: p,
        tags: [DEMO_TAG, "keep-me"],
      }),
    ),
  );
  for (const [i, f] of fixtures.entries()) console.log(`  ${f.title}: €${prices[i].toFixed(2)}  (${f.id})`);

  try {
    process.stdout.write("  waiting for search index… ");
    await waitForIndex(client, fixtures.length);
    console.log("indexed.\n");

    // 1. DIFF — what would change (no writes yet).
    console.log("DIFF — computeDiff (dry run, nothing written)");
    console.log("  filter:  tag:bp-exec-demo, price < 100 (per variant)");
    console.log("  change:  set price → 9.99;  add tag [flash-sale]\n");
    const diff = await computeDiff(client, {
      filter: { tag: DEMO_TAG, priceMax: 100 },
      change: { setPrice: 9.99, addTags: ["flash-sale"] },
    });
    for (const e of diff.entries) {
      const what = e.field === "price" ? `price  ${e.oldValue} → ${e.newValue}` : `${e.field}   → +flash-sale`;
      console.log(`  ▸ ${e.productTitle}  ${what}`);
    }
    console.log(
      `  summary: ${diff.summary.productsAffected} products, ${diff.summary.variantsAffected} variants, ${diff.summary.lineItemChanges} line-items\n`,
    );

    // Snapshot the real before-state via an independent read.
    const before = await Promise.all(fixtures.map((f) => currentPrice(client, f.variantId)));

    // 2. APPROVE + 3. EXECUTE.
    console.log('APPROVAL — approvedBy="execute-demo" → APPROVED');
    const result = await executeDiff(client, diff, { approved: true, approvedBy: "execute-demo" });
    console.log(
      `EXECUTE — serial, re-verify each: ${result.summary.succeeded}/${result.summary.total} succeeded, ` +
        `${result.summary.failed} failed, in ${(result.durationMs / 1000).toFixed(1)}s\n`,
    );

    // 4. INDEPENDENT VERIFICATION — fresh query, not the engine's report.
    console.log("INDEPENDENT VERIFICATION — fresh query of the store, not the engine's word");
    let allGood = true;
    for (const [i, f] of fixtures.entries()) {
      const after = await currentPrice(client, f.variantId);
      const { products } = await queryProducts(client, { tag: DEMO_TAG, limit: 50 });
      const tags = products.find((p) => p.id === f.id)?.tags ?? [];
      const priceOk = after === "9.99";
      const tagOk = tags.includes("flash-sale") && tags.includes("keep-me");
      allGood &&= priceOk && tagOk;
      console.log(
        `  ${f.title}: price €${before[i]} → €${after} ${priceOk ? "✓" : "✗"}   ` +
          `tags include flash-sale & keep-me ${tagOk ? "✓" : "✗"}`,
      );
    }
    console.log(`\nRESULT: ${allGood ? "PASS — store independently confirms every change" : "FAIL"}`);
  } finally {
    console.log("\nCLEANUP — deleting fixtures");
    await Promise.all(fixtures.map((f) => deleteScratchProduct(client, f.id).catch(() => {})));
  }
}

main().catch((err) => {
  console.error("\n✖", err instanceof Error ? err.message : err);
  process.exit(1);
});
