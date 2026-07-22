/**
 * Prints a real dry-run diff against the seed catalog so it can be eyeballed
 * before any execution engine exists. No mutations — computeDiff is pure read.
 *
 *   npm run diff:demo
 *
 * Demonstrates the Section 1 per-variant decision: a product straddling the
 * price filter shows only its matching variants changing, flagged PARTIAL.
 */

import "./lib/env";
import { ShopifyClient } from "../app/lib/shopify/client";
import { loadOfflineSession } from "./lib/session";
import { computeDiff } from "../app/lib/diff/compute";
import type { ChangeRequest, DiffEntry, DiffResult } from "../app/lib/diff/types";

function fmt(v: string | string[]): string {
  return Array.isArray(v) ? `[${v.join(", ")}]` : v;
}

function renderProduct(diff: DiffResult, productId: string): string[] {
  const match = diff.matches.find((m) => m.productId === productId)!;
  const entries = diff.entries.filter((e) => e.productId === productId);
  const flag = match.partial ? " — PARTIAL" : "";
  const lines = [
    `  ▸ ${match.productTitle.trim()}  [${match.matchedVariants} of ${match.totalVariants} variants match${flag}]`,
  ];
  for (const e of entries) {
    if (e.field === "price") {
      lines.push(`      price  variant "${e.variantTitle}"   ${fmt(e.oldValue)} → ${fmt(e.newValue)}`);
    } else {
      lines.push(`      ${e.field.padEnd(5)}  ${fmt(e.oldValue)} → ${fmt(e.newValue)}`);
    }
  }
  return lines;
}

async function main() {
  const session = await loadOfflineSession(process.env.SHOPIFY_SHOP_DOMAIN);
  const client = new ShopifyClient({ shop: session.shop, accessToken: session.accessToken });

  const request: ChangeRequest = {
    filter: { tag: "bp-seed", priceMax: 40 },
    change: { setPrice: 19.99, addTags: ["summer-sale"] },
  };

  console.log("CHANGE REQUEST");
  console.log("  filter:  price ≤ 40  (evaluated PER VARIANT), tag:bp-seed");
  console.log("  change:  set matching-variant price → 19.99;  add tag [summer-sale] to matched products");
  console.log("  (dry run — nothing is written)\n");

  const started = Date.now();
  const diff = await computeDiff(client, request, { maxCandidates: 5000 });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log("SUMMARY");
  console.log(`  products affected:  ${diff.summary.productsAffected}`);
  console.log(`  variants affected:  ${diff.summary.variantsAffected}`);
  console.log(`  line-item changes:  ${diff.summary.lineItemChanges}`);
  console.log(`  computed in ${elapsed}s\n`);

  // The canonical straddler from the seed, called out explicitly.
  const straddler = diff.matches.find((m) => m.productTitle.trim() === "Urban  Mug 40".trim());
  if (straddler) {
    console.log("STRADDLER (price boundary runs through this product's variants)");
    for (const line of renderProduct(diff, straddler.productId)) console.log(line);
    console.log("  expected by hand: the €38.99 variant → 19.99; the €44.99 variant untouched; +summer-sale tag.\n");
  }

  const partials = diff.matches.filter((m) => m.partial && m.productId !== straddler?.productId);
  console.log(`OTHER PARTIAL PRODUCTS (only some variants matched): ${partials.length} total. First 4:`);
  for (const m of partials.slice(0, 4)) {
    for (const line of renderProduct(diff, m.productId)) console.log(line);
  }

  const fullMatches = diff.matches.filter((m) => !m.partial);
  console.log(`\nFULLY-MATCHED PRODUCTS (all variants under 40): ${fullMatches.length} total. First 2:`);
  for (const m of fullMatches.slice(0, 2)) {
    for (const line of renderProduct(diff, m.productId)) console.log(line);
  }

  // A quick integrity line: every price entry's variant really was ≤ 40.
  const priceEntries = diff.entries.filter((e: DiffEntry) => e.field === "price");
  const allUnder40 = priceEntries.every((e) => Number(e.oldValue) <= 40);
  console.log(`\nINTEGRITY CHECK: all ${priceEntries.length} price changes were on variants ≤ €40 → ${allUnder40 ? "PASS" : "FAIL"}`);
}

main().catch((err) => {
  console.error("\n✖", err instanceof Error ? err.message : err);
  process.exit(1);
});
