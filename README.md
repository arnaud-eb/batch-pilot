# BatchPilot

A Shopify app for safe, bulk catalog edits described in plain English. A
merchant says _"tag every product under €40 with 'summer-26'"_, previews the
exact diff before anything changes, and executes it across the catalog.

This repository currently covers **Phase 0-1**: the app scaffold, a seed-data
script, and a thin, well-tested wrapper layer over the Admin GraphQL API. There
is no natural-language or diff logic yet — see `docs/phase-0-1-spec.md` for the
scope and for the running log of Shopify API quirks discovered along the way.

## Stack

- **App**: [React Router v7](https://reactrouter.com/) via the Shopify CLI
  template (the former Remix template — Remix v3 shipped as React Router v7),
  TypeScript, Polaris, Prisma session storage.
- **Admin API**: GraphQL, version `2026-07`, pinned in `app/shopify.server.ts`
  and mirrored in `app/lib/shopify/client.ts`.

## Prerequisites

- Node `>=20.19 <22 || >=22.12`
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) (`npm i -g @shopify/cli`)
- A Shopify Partner account and a development store

## Setup

```bash
npm install
```

### Run the app against your dev store

```bash
shopify app dev
```

This starts a tunnel, installs the app on your development store, and prints an
embedded-app URL. Open it in the Shopify admin to confirm real shop data loads.
Press `g` in the CLI to open GraphiQL against the Admin API.

The app requests these scopes (`shopify.app.toml`): `write_products`,
`write_inventory`, `read_locations`, `write_metaobjects`,
`write_metaobject_definitions`. Inventory and locations are required beyond the
template default because stock lives on `InventoryLevel` at a `Location`.

### Credentials for the standalone scripts

The seed script and the integration tests talk to the Admin API **directly**,
not through the app runtime, so they need their own token. Create a `.env` in
the repo root:

```
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Get the token from the store admin: **Settings → Apps and sales channels →
Develop apps → Allow custom app development → Create an app**, grant
`read/write_products`, `read/write_inventory`, `read_locations`, install it, and
reveal the Admin API access token (shown once).

> A custom-app token is used rather than the app's own offline session because
> the app's offline token expires ~60 minutes after issue and would die
> mid-run. `.env` is gitignored — never commit it.

## Seeding data

Populate the dev store with realistic, deliberately messy product data:

```bash
npm run seed                  # ~600 products (skips if seed data already exists)
npm run seed -- --count 800   # choose the count (500-1000 range)
npm run seed -- --reset       # delete previously seeded products, then re-seed
npm run seed -- --reset-only  # delete previously seeded products and stop
npm run seed -- --seed 123    # fix the PRNG seed for a reproducible catalog
```

Every seeded product carries the marker tag `bp-seed`. `--reset` deletes **only**
marked products, so it never touches products you added by hand. The generated
catalog spans €5–€150 (weighted low), includes zero and four-figure stock,
multi-variant products, multi-collection membership, and messy titles.

## Testing

```bash
npm test          # run once
npm run test:watch
```

Tests are **integration tests against the real dev store** — no mocked API
responses (Phase 0-1 wants confidence the wrappers work against the real thing).
Each mutation test changes a disposable scratch product and re-queries to prove
the change landed; scratch products are tagged `bp-test` and cleaned up
afterwards. One test deliberately trips Shopify's rate limit with a concurrent
burst and asserts the client backs off and recovers.

Requires a populated `.env` and seed data present (`npm run seed`).

## Layout

```
app/lib/shopify/      Reusable Admin API wrapper layer (also used by the app + Phase 3)
  errors.ts           Typed failure outcomes: not-found / rate-limited / validation / ...
  client.ts           Cost-aware GraphQL client with backoff against the live throttle bucket
  tools.ts            The four tool wrappers: queryProducts, updateProduct, updateVariant, addTags
  *.test.ts           Integration tests + the deliberate rate-limit test
scripts/
  seed/               Standalone seed script (generate.ts is pure/deterministic)
  lib/                Session loading (.env or Prisma) and env bootstrap
docs/phase-0-1-spec.md  The spec, kept updated with observed API behaviour
```

## The tool wrapper layer

`app/lib/shopify/tools.ts` exposes four intentionally dumb, fully-typed
operations. They contain no business logic — they are the reliable primitives an
agent will call in Phase 3.

| Function                       | Purpose                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `queryProducts(client, f)`     | Search by price range, stock, tag, collection → typed list  |
| `updateProduct(client, id, c)` | Update product fields (title, tags — tags **replace**)      |
| `updateVariant(client, id, c)` | Update variant fields (price, compareAtPrice)               |
| `addTags(client, id, tags)`    | Add tags, **merging** with existing ones (never clobbers)   |

Errors are typed and distinguishable: `NotFoundError`, `RateLimitedError`,
`ValidationError`, `AuthError`, etc. — a bad id, an invalid change, and a
throttle are different outcomes, not one generic throw.
