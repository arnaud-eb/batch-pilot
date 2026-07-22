# BatchPilot — Phase 0-1 Spec

_Feed this to Claude Code as the starting contract. Update it as reality corrects the plan — don't let it go stale._

## Context

BatchPilot is a Shopify app that lets a merchant describe a bulk catalog change in plain English ("tag every product under €40 with 'summer-26'"), preview the exact diff before anything changes, and execute it safely across the catalog. This spec covers only the foundation: environment, seed data, and the thin API wrapper layer. No AI/agent logic yet — that's Phase 3.

## Out of scope for this spec

- Natural language parsing / AI tool-calling (Phase 3)
- Dry-run diff engine (Phase 2)
- Guardrails, rollback, audit log (Phase 2 & 4)
- Billing, UI polish, App Store listing

---

## 1. Environment

**Goal:** a working Shopify app scaffold connected to a development store, with GraphQL access confirmed end-to-end.

- Scaffold via `shopify app init`, React Router template (`--template reactRouter --flavor typescript`).
  The Remix template no longer exists under that name — Remix v3 shipped as React Router v7, and CLI 4.5.2
  accepts only `reactRouter|none`. Stack is `react-router@7` + `@shopify/shopify-app-react-router@1`.
- Confirm OAuth flow completes and the app installs cleanly on a Partner development store.
- Confirm a trivial GraphQL query (e.g. `shop { name }`) returns data from the dev store through the app.

**Acceptance check:** running `shopify app dev`, installing on the dev store, and hitting the embedded admin UI shows real shop data — not mocked.

---

## 2. Seed data script

**Goal:** populate the dev store with realistic, messy product data so later phases have something non-trivial to operate on.

**Requirements:**

- Standalone script (not part of the app runtime) using the Admin GraphQL API.
- Generate 500–1000 products with:
  - Randomized price (spread across €5–€150, weighted toward common price points)
  - Randomized stock (some at 0, some in the thousands — need edge cases)
  - Randomized tags (pull from a realistic pool of 15-20 tag names, most products get 1-3)
  - Assignment to 4-6 fake collections
  - A mix of clean and messy titles (some with trailing whitespace, inconsistent casing, etc. — real catalogs are messy, don't seed a clean dataset)
- Idempotent-ish: safe to re-run without duplicating everything (either check-and-skip or a clear "reset" mode that deletes prior seed data first).
- Respect Shopify's API rate limits — batch/throttle the creation calls rather than firing them all at once.

**Acceptance check:** after running the script, the dev store admin shows several hundred products with visibly varied prices, stock levels, tags, and collections.

---

## 3. Thin tool wrapper layer

**Goal:** small, well-tested functions wrapping the Admin GraphQL API. These are dumb on purpose — no business logic, no AI, just reliable typed operations. They become the "tools" an agent calls in Phase 3.

**Functions to implement:**

| Function                     | Purpose                                                          | Notes                                                              |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `queryProducts(filters)`     | Search products by price range, stock threshold, tag, collection | Return a typed list with id, title, price, stock, tags, `collections: string[]` |
| `updateProduct(id, changes)` | Update product-level fields (title, tags)                        | Return the updated fields for confirmation                         |
| `updateVariant(id, changes)` | Update variant-level fields (price, etc.)                        | Same pattern                                                       |
| `addTags(id, tags)`          | Add tags without clobbering existing ones                        | Must merge, not overwrite                                          |

**Requirements for each function:**

- TypeScript, fully typed inputs/outputs.
- Explicit error handling — distinguish "not found," "rate limited," and "validation error" as different outcomes, not one generic throw.
- A rate-limit-aware wrapper around raw GraphQL calls (respect Shopify's cost-based throttling; back off and retry rather than failing hard on a 429-equivalent).
- A unit/integration test per function that runs against the dev store and asserts the change actually took effect (query after mutate).

**Acceptance check:** each function has a passing test that performs a real mutation against the dev store and verifies it via a follow-up query. No mocked API responses at this stage — we want confidence the wrappers work against the real thing.

---

## Definition of done for Phase 0-1

- [x] App installs and runs against a Partner dev store
- [x] Seed script populates 500+ messy products (600 verified live)
- [x] All four tool wrapper functions implemented, typed, and tested against real API calls
- [x] Rate-limit handling verified (intentionally trigger it once to confirm backoff works) — concurrent-burst test trips the throttle and asserts recovery
- [x] Everything committed to a GitHub repo with a README describing setup steps

## Notes for Claude Code

- Work through the three sections in order (Environment → Seed data → Tool wrappers), checking in after each rather than completing all three before review.
- Prioritize correctness and test coverage over speed here — Phase 2's dry-run engine will only be trustworthy if these wrappers are solid.
- Flag any Shopify API rate-limit or GraphQL quirks encountered — they matter for Phase 2/3 design decisions.

## Observed environment facts (Section 1, verified against the dev store)

- Store: `batchpilot.myshopify.com`, Partner org EaseBest, app record `batch-pilot-app`.
- **Throttle budget measured live**: `maximumAvailable: 2000`, `restoreRate: 100`/sec, and a
  `shop { name }` query costs 1. Section 3's backoff should read `extensions.cost.throttleStatus`
  from each response rather than assuming a fixed request/sec limit.
- **Store currency is USD**, not EUR — see currency decision before seeding.
- Admin API version: the app pins `ApiVersion.July26` (`2026-07`) in `app/shopify.server.ts`, which
  matches GraphiQL's default. The `2026-10` in `shopify.app.toml` is the _webhook_ API version, a
  separate setting — not a mismatch. Wrapper layer pins `2026-07` to match the app.
- `expiringOfflineAccessTokens: true` is enabled, so offline tokens (`shpua_…`) expire and carry a
  refresh token. Scripts reading the stored session must fail loudly on expiry, not emit bare 401s.
  Observed live: the app's offline token expires ~60 minutes after issue and only refreshes when the
  app is loaded in the admin — too fragile for a long script run. The seed/test scripts therefore
  prefer a stable custom-app token (`shpat_…`) from `.env`, falling back to the offline session.
- **Legacy custom apps**: as of 2026-01-01 merchants can't create new legacy custom apps, but
  Partners still can on a non-transferred dev store — which is how the `shpat_` seed token was made.
- **`productSet` collapses seeding to one call per product** — product + options + variants +
  per-variant inventory in a single mutation (~20 cost). It requires `optionValues` on _every_
  variant, including single-variant products, which take the default `Title` / `Default Title` value.
- **Serial calls never trip the throttle.** The 600-product seed ran at ~0.7s/call and the bucket
  never dropped below ~1980/2000, because 100/sec restore outpaces a single serial caller. The
  deliberate rate-limit test in Section 3 must fire _concurrent_ requests to actually trigger backoff.
- Dev stores auto-add products to a default `Home page` collection the seed script never assigns.
  Section 3's collection filter must expect membership it didn't create.
- **Search index is eventually consistent.** `products(query: "tag:…")` is backed by an async search
  index: a just-created product is not findable by tag/inventory search for a short lag, though it is
  immediately readable by `product(id:)` (strongly consistent). Mutation wrappers verify via id reads;
  the read wrapper (`queryProducts`) is tested against the already-indexed seed catalog. Phase 2's
  dry-run must not create-then-query-by-tag and expect fresh results — read back by id, or tolerate lag.
- Scopes granted: `write_products`, `write_inventory`, `read_locations`, `write_metaobjects`,
  `write_metaobject_definitions`. Dev stores auto-grant, so no consent screen.
- `shopify app dev` fires `APP_UNINSTALLED` on startup and reinstalls, clearing the Prisma session table.
- The CLI does not rewrite `application_url` in the local toml; tunnel URLs are updated app-side only.
  No `.env` is written to disk — credentials are injected by the CLI at runtime.

## Post-review decisions (five-axis review of Sections 1-3)

Applied in Phase 0-1:

- **`queryProducts` returns `{ products, hasMore }`.** A capped result set is no longer silently
  indistinguishable from a complete one — `hasMore` is true when more products matched than `limit`
  returned. Phase 2's diff preview must check it: presenting a truncated set as "everything that
  matches" would make an approved bulk edit wrong.
- Backslashes are now escaped in search-string values (one canonical `escapeSearchValue` helper,
  reused by `queryProducts` and the seed's `ensureCollection`); a malformed `collectionId` is rejected
  with `ValidationError` rather than injected raw. Verified against the live API: single-quote escaping
  already prevented search-operator breakout, so this is robustness, not a closed vulnerability.

Deliberate evolutions deferred to later phases (decisions, not defects):

- **Price is evaluated per-product (min variant) in Phase 0-1; per-variant belongs in the Phase 2 diff
  layer.** "Products under €40" currently matches a product whose _cheapest_ variant is ≤ 40, which can
  sweep along that product's €55 variant. The honest semantic — "which variants match" — is a diff-layer
  concern: it consumes the full `variants` array `queryProducts` already returns and previews
  "3 of 5 variants match". `queryProducts`' `priceMin/priceMax` therefore remain min-variant filters and
  should be read as "the product has a variant near this bound", not "every variant qualifies".
- **Restrictive price filters still page the whole catalog** (price isn't evaluated server-side), so a
  filter matching little reads every page. Acceptable at dev-store scale; revisit if `queryProducts`
  gets called with tight price filters over large catalogs in Phase 3.
- **The deliberate-throttle test asserts `throttleEvents > 0` off a fixed 50-request burst** — passing
  but load-dependent. If it ever flakes, switch it to loop-until-throttled instead of a fixed burst.
