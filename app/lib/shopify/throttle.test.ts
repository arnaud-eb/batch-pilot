/**
 * Deliberate rate-limit test (DoD: "intentionally trigger it once to confirm
 * backoff works").
 *
 * Section 2 established that serial calls never trip the throttle — the 100/sec
 * restore outpaces a single caller. So this fires a concurrent burst large
 * enough to overdraw the ~2000-point bucket in one go, then asserts two things:
 *   1. Shopify actually throttled us (onThrottle fired), and
 *   2. every request still resolved — the client backed off and retried rather
 *      than failing hard.
 *
 * It lives in its own file because it drains the store-wide cost bucket; the
 * serial file execution configured in vitest.config.ts keeps that from leaking
 * into the wrapper tests. An afterAll pause lets the bucket refill afterwards.
 */

import { afterAll, describe, expect, it } from "vitest";
import { ShopifyClient } from "./client";
import { makeClient } from "./test-helpers";

const BURST = 50;

// A moderately expensive read: enough cost per call that ~34 of them exhaust
// the 2000 bucket, but well under the 1000-point single-query ceiling so each
// query is individually valid.
const EXPENSIVE_QUERY = `
  query {
    products(first: 150) {
      nodes { id title tags variants(first: 5) { nodes { id price } } }
    }
  }
`;

describe("rate limiting", () => {
  let client: ShopifyClient;
  let throttleEvents = 0;

  afterAll(async () => {
    // Give the bucket a moment to refill so nothing after this pays for it.
    await new Promise((r) => setTimeout(r, 3000));
  });

  it(
    "trips Shopify's throttle under a concurrent burst and recovers",
    async () => {
      client = await makeClient({
        maxRetries: 8,
        onThrottle: () => {
          throttleEvents++;
        },
      });

      const results = await Promise.allSettled(
        Array.from({ length: BURST }, () => client.request(EXPENSIVE_QUERY, {}, { estimatedCost: 0 })),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      const rejected = results.filter((r) => r.status === "rejected");

      // The whole point: we hit the real limit at least once.
      expect(throttleEvents).toBeGreaterThan(0);

      // And backoff got everything through despite that.
      if (rejected.length > 0) {
        const reasons = rejected.map((r) => (r as PromiseRejectedResult).reason?.message).join("; ");
        throw new Error(`${rejected.length}/${BURST} requests failed after backoff: ${reasons}`);
      }
      expect(fulfilled).toBe(BURST);
    },
    120_000,
  );
});
