# BatchPilot — Phase 2 Spec: Dry-Run Diff Engine

_Builds directly on Phase 0-1's wrapper layer and its documented API quirks. No AI/agent logic yet — that's Phase 3. This is the trust layer everything else sits on._

## Context

Phase 0-1 delivered typed, tested wrappers (`queryProducts`, `updateProduct`, `updateVariant`, `addTags`) plus five real API quirks worth designing around (see `docs/phase-0-1-notes.md` or the PR description — eventual consistency, serial-vs-concurrent throttling, `productSet` variant requirements, the Home collection, token expiry).

Phase 2 builds the layer that sits between "a structured change request" and "an actual mutation": compute an accurate diff, show it, require explicit approval, execute safely, and log everything for rollback. No natural language yet — Phase 2 takes a structured filter/change object as input; Phase 3 will be what generates that object from plain English.

## Out of scope for this spec

- Natural language parsing (Phase 3)
- Guardrails like hard caps and a read-only kill switch (Phase 4 — though the audit log built here is what Phase 4's rollback depends on)
- UI polish

---

## 1. Price semantics — resolve this first, it shapes everything below

**Decision: evaluate filters and diffs per-variant, not per-product.**

- A filter like `price < 40` matches individual **variants**, not products. A multi-variant product can be partially in-scope.
- The diff output groups by product for readability, but each line item is a variant-level change, with a note when a product is only partially affected (e.g. "3 of 5 variants match").
- `updateProduct`-level changes (title, tags) apply to the whole product regardless of which variants matched the filter — but the diff should still show _why_ the product was included (which variants triggered the match).

**Acceptance check:** a test fixture product with variants at €35 and €55, filtered on `price < 40`, produces a diff showing exactly one variant changing, not the whole product.

---

## 2. The diff computation

**Goal:** given a change request (filter + intended change), compute exactly what would happen — no mutations yet.

**Input shape (structured, hand-written for this phase — Phase 3 will generate this from NL):**

```ts
type ChangeRequest = {
  filter: {
    priceMax?: number;
    priceMin?: number;
    stockMin?: number;
    tag?: string;
    collection?: string;
  };
  change: {
    addTags?: string[];
    setTitle?: (current: string) => string; // for pattern-based renames
    setPrice?: number;
  };
};
```

**Requirements:**

- Query matching products/variants using `queryProducts` — **always re-read by id before computing the diff**, per quirk #1 (search index lag). Use the search query to get candidate ids, then confirm current state with a direct id lookup before diffing.
- Compute an array of `{ productId, variantId?, field, oldValue, newValue }` entries — one entry per actual change, not per product.
- No mutation calls anywhere in this function. This function is pure read + compute.
- Return a summary alongside the detail: total products affected, total variants affected, total line-item changes.
- **Refuse to proceed on a truncated result set.** `queryProducts` (as of the Phase 0-1 fix) returns `hasMore` alongside results — if `hasMore` is true, the diff computation must not silently diff a partial catalog. Either paginate through all pages before computing the diff, or throw a clear "result set too large to preview safely" error rather than returning an incomplete diff. A diff that's silently wrong is worse than a diff that refuses to run.

**Acceptance check:** running the diff function twice in a row with no execution in between returns identical results (proves it's not accidentally mutating state). A second test: a filter matching more than one page of results either returns a complete diff across all pages or throws — never a silently partial one.

---

## 3. The execution engine

**Goal:** take an approved diff and actually apply it, safely.

**Requirements:**

- Takes a diff (from Section 2) plus an explicit approval flag — refuses to run without it.
- Executes changes **serially by default** (per quirk #2 — serial calls don't trip the throttle, so this is the safe default; concurrency is an explicit opt-in optimization, not the baseline).
- After each mutation, re-reads by id to confirm the change actually took effect before moving to the next — don't trust the mutation response alone.
- Collects results per line item: succeeded / failed / skipped, with the actual error if failed.
- If a mutation fails partway through a batch, **continue with the remaining items** rather than aborting — a partial success with a clear report is more useful than an all-or-nothing failure on a 600-product run. Log clearly what succeeded and what didn't.

**Acceptance check:** run against a batch of 20 real diff items, confirm all 20 actually changed via a follow-up query, confirm the run completes in a reasonable time using serial execution.

---

## 4. The audit / rollback log

**Goal:** every executed run is fully reversible from its own log — no separate backup mechanism needed.

**Requirements:**

- Persist to SQLite (simplest option for a local project — Postgres is overkill here).
- Schema: one row per run (id, timestamp, change request, diff summary, approved-by-note), one row per line-item change within that run (old value, new value, success/fail).
- A `rollback(runId)` function that reads the log and issues the inverse mutations (old value becomes the new target) — reuses the Section 3 execution engine so rollback gets the same serial-safe, re-verify behavior for free.
- Rollback of a partially-failed run only reverts the line items that actually succeeded (nothing to undo for the ones that failed).

**Acceptance check:** execute a real batch change, confirm it applied, run rollback, confirm the store is back to its pre-change state via direct query — not just "rollback ran without error."

---

## Post-verification decisions (adversarial review of computeDiff)

An adversarial verifier probed the diff engine against the live store. Outcomes:

- **Price bounds are a half-open interval `[priceMin, priceMax)`.** `priceMax` is
  EXCLUSIVE (price < priceMax), matching this spec's "price < 40" wording — 4 real
  seed variants priced exactly €40.00 were being repriced under the old inclusive
  behaviour. `priceMin` is INCLUSIVE (price ≥ priceMin). A boundary test with a real
  €40.00 variant now guards this (it fails on the old inclusive code).
- **Variant-count guard added (finding #2).** A product with >100 variants now makes
  the diff *refuse* rather than silently drop variants 101+ — the same discipline as
  the product-level `hasMore` refusal. Not exercised by seed data (max 5 variants);
  defensive for real catalogs / combined listings.
- **Collection titles resolve case-insensitively (finding #3).** The old strict `===`
  rejected a real collection on any case difference; matters for Phase 3's NL titles.
- **Candidate order is now deterministic** (sorted by numeric id before re-read), so the
  purity guarantee no longer relies on Shopify's undocumented default sort being stable.
- **Untracked inventory (finding #4) — documented, not fixed.** A variant with
  `inventoryQuantity: null` is treated as stock 0, so `stockMin ≥ 1` excludes it.
  Untracked arguably means "unlimited". No seed variant is untracked, so there is
  nothing to test against yet — revisit when a real catalog needs it.

## Definition of done for Phase 2

- [x] Price/filter semantics are per-variant, tested against a straddling fixture (`Urban  Mug 40`, seed catalog)
- [x] Diff computation is provably pure (no side effects), re-reads by id to avoid stale search results
- [x] Diff computation never silently proceeds on a truncated (`hasMore: true`) result set — paginates fully or throws
- [ ] Execution engine runs serially by default, re-verifies each mutation, continues past partial failures
- [ ] Every run and every line-item change is logged to SQLite
- [ ] Rollback works end-to-end on a real executed run, verified by direct query afterward
- [ ] Sections 1-2 committed with tests, zero mocks (Sections 3-4 pending checkpoint approval)

## Notes for Claude Code

- Work through sections in order; each depends on the last (diff → execute → log/rollback).
- Section 1's per-variant decision is a real design change from how `queryProducts` currently reports price (min-variant) — call out explicitly whether that requires touching the Phase 0-1 wrapper or just how Phase 2 consumes it.
- Checkpoint with me after Section 2 (diff engine) before touching Section 3 — I want to see real diff output on the 600-product seed data before anything is allowed to execute.
- Reuse the seed store's existing 600 products rather than creating new fixtures where possible — that data already has the messy spread (price, stock, tags) this phase needs to exercise.
