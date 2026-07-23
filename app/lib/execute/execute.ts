/**
 * Execution engine (Phase 2, Section 3).
 *
 * Takes an approved diff and applies it. Design (see docs/phase-2-spec.md §3):
 *  - Refuses without explicit approval.
 *  - Serial by default (quirk #2: serial calls don't trip the throttle).
 *  - After each mutation, re-reads by id to confirm the change took effect —
 *    the mutation response alone is not trusted.
 *  - Continues past a failed item rather than aborting: a partial success with a
 *    clear per-item report beats an all-or-nothing failure on a large run.
 *
 * It performs writes, unlike the diff engine. The inverse operation (rollback)
 * is Section 4, which reuses this engine by feeding it a diff of old←new.
 */

import { ShopifyClient } from "../shopify/client";
import { isShopifyError } from "../shopify/errors";
import { updateProduct, updateVariant } from "../shopify/tools";
import type { DiffEntry, DiffResult } from "../diff/types";
import type { ExecutionApproval, ExecutionResult, LineItemResult } from "./types";

export class ExecutionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionRefusedError";
  }
}

export async function executeDiff(
  client: ShopifyClient,
  diff: DiffResult,
  approval: ExecutionApproval,
): Promise<ExecutionResult> {
  if (!approval.approved) {
    throw new ExecutionRefusedError(
      "Execution refused: the diff was not approved. Pass { approved: true } to run it.",
    );
  }

  const started = Date.now();
  const results: LineItemResult[] = [];

  // Serial by default (quirk #2: serial calls don't trip the throttle).
  // Concurrent execution is a deliberate future opt-in — add it, and its option,
  // when it's actually implemented rather than scaffolding a dead parameter now.
  for (const entry of diff.entries) {
    results.push(await applyAndVerify(client, entry));
  }

  const summary = {
    total: results.length,
    succeeded: results.filter((r) => r.status === "succeeded").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };

  return { results, summary, durationMs: Date.now() - started };
}

/** Apply one entry, then confirm it via an independent re-read by id. */
async function applyAndVerify(
  client: ShopifyClient,
  entry: DiffEntry,
): Promise<LineItemResult> {
  try {
    await applyEntry(client, entry);
  } catch (err) {
    const message = isShopifyError(err) ? `${err.kind}: ${err.message}` : String(err);
    return { entry, status: "failed", verified: false, error: message };
  }

  // Don't trust the mutation response — read the current value back by id.
  try {
    const verified = await verifyEntry(client, entry);
    return verified
      ? { entry, status: "succeeded", verified: true }
      : {
          entry,
          status: "failed",
          verified: false,
          error: "Mutation reported success but the re-read did not show the new value",
        };
  } catch (err) {
    const message = isShopifyError(err) ? `${err.kind}: ${err.message}` : String(err);
    return { entry, status: "failed", verified: false, error: `Verification read failed: ${message}` };
  }
}

function applyEntry(client: ShopifyClient, entry: DiffEntry): Promise<unknown> {
  switch (entry.field) {
    case "price":
      if (!entry.variantId) {
        return Promise.reject(new Error("price entry has no variantId"));
      }
      return updateVariant(client, entry.variantId, { price: Number(entry.newValue) });
    case "title":
      return updateProduct(client, entry.productId, { title: entry.newValue as string });
    case "tags":
      return updateProduct(client, entry.productId, { tags: entry.newValue as string[] });
    default:
      return Promise.reject(new Error(`Unknown diff field: ${(entry as DiffEntry).field}`));
  }
}

/** Independent re-read: is the entry's newValue actually in place now? */
async function verifyEntry(client: ShopifyClient, entry: DiffEntry): Promise<boolean> {
  if (entry.field === "price") {
    const { data } = await client.request<{
      productVariant: { price: string } | null;
    }>(
      `query ($id: ID!) { productVariant(id: $id) { price } }`,
      { id: entry.variantId },
      { estimatedCost: 5 },
    );
    return data.productVariant?.price === entry.newValue;
  }

  const { data } = await client.request<{
    product: { title: string; tags: string[] } | null;
  }>(
    `query ($id: ID!) { product(id: $id) { title tags } }`,
    { id: entry.productId },
    { estimatedCost: 5 },
  );
  if (!data.product) return false;

  if (entry.field === "title") {
    return data.product.title === entry.newValue;
  }
  // tags: Shopify normalises order, so compare as sets.
  const want = new Set(entry.newValue as string[]);
  const got = new Set(data.product.tags);
  if (want.size !== got.size) return false;
  for (const t of want) if (!got.has(t)) return false;
  return true;
}
