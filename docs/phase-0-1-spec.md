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

- [ ] App installs and runs against a Partner dev store
- [ ] Seed script populates 500+ messy products
- [ ] All four tool wrapper functions implemented, typed, and tested against real API calls
- [ ] Rate-limit handling verified (intentionally trigger it once to confirm backoff works) — confirmed in scope as part of the Section 3 test suite; run against the dev store with seed data
- [ ] Everything committed to a GitHub repo with a README describing setup steps

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
- Admin API version: GraphiQL defaults to `2026-07`; the app's webhooks pin `2026-10`.
  Pin the wrapper layer explicitly so dev and runtime agree.
- Scopes granted: `write_products`, `write_inventory`, `read_locations`, `write_metaobjects`,
  `write_metaobject_definitions`. Dev stores auto-grant, so no consent screen.
- `shopify app dev` fires `APP_UNINSTALLED` on startup and reinstalls, clearing the Prisma session table.
- The CLI does not rewrite `application_url` in the local toml; tunnel URLs are updated app-side only.
  No `.env` is written to disk — credentials are injected by the CLI at runtime.
