import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests hit the real dev store, so they need node + real time
    // and generous timeouts (a throttled call can wait seconds for the bucket).
    environment: "node",
    include: ["app/lib/shopify/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Run test FILES serially. The deliberate throttle test drains the store's
    // shared cost bucket; if it ran alongside the wrapper tests it would make
    // them fail with unrelated throttle errors. One file at a time keeps the
    // rate-limit behaviour of one test from leaking into another.
    fileParallelism: false,
    // Also serialise within a file — these are stateful store mutations.
    sequence: { concurrent: false },
  },
});
