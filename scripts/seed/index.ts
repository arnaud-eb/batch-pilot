/**
 * Seed script entrypoint.
 *
 *   npm run seed                 # create the default catalog if the store is empty
 *   npm run seed -- --count 800  # create N products
 *   npm run seed -- --reset      # delete previously seeded products, then re-seed
 *   npm run seed -- --reset-only # delete previously seeded products and stop
 *   npm run seed -- --seed 123   # fix the PRNG seed for a reproducible catalog
 *
 * Standalone: talks to the Admin API directly using a token from .env, never
 * through the app runtime (spec §2). Rate limiting is delegated to
 * ShopifyClient, which paces against the live cost budget.
 */

import "../lib/env";
import { ShopifyClient } from "../../app/lib/shopify/client";
import { isShopifyError } from "../../app/lib/shopify/errors";
import { loadOfflineSession, assertScopes, NoSessionError } from "../lib/session";
import { COLLECTIONS, generateCatalog } from "./generate";
import {
  createSeedProduct,
  deleteProduct,
  ensureCollection,
  findSeedProductIds,
  getPrimaryLocation,
} from "./mutations";

interface Args {
  count: number;
  reset: boolean;
  resetOnly: boolean;
  seed: number;
  shop?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { count: 600, reset: false, resetOnly: false, seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") args.reset = true;
    else if (a === "--reset-only") args.resetOnly = true;
    else if (a === "--count") args.count = Number(argv[++i]);
    else if (a === "--seed") args.seed = Number(argv[++i]);
    else if (a === "--shop") args.shop = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.count) || args.count < 1) {
    throw new Error(`--count must be a positive integer, got ${args.count}`);
  }
  return args;
}

async function reset(client: ShopifyClient): Promise<number> {
  const ids = await findSeedProductIds(client);
  if (ids.length === 0) {
    console.log("  Nothing to reset — no products carry the seed marker.");
    return 0;
  }
  console.log(`  Deleting ${ids.length} previously seeded product(s)…`);
  let deleted = 0;
  for (const id of ids) {
    await deleteProduct(client, id);
    if (++deleted % 50 === 0) console.log(`    …${deleted}/${ids.length}`);
  }
  console.log(`  Deleted ${deleted}.`);
  return deleted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const session = await loadOfflineSession(args.shop);
  assertScopes(session, ["write_products", "write_inventory", "read_locations"]);

  let throttleWaits = 0;
  const client = new ShopifyClient({
    shop: session.shop,
    accessToken: session.accessToken,
    onThrottleWait: ({ waitMs }) => {
      throttleWaits++;
      if (throttleWaits <= 3 || throttleWaits % 25 === 0) {
        console.log(`  ⏳ throttle: waiting ${waitMs}ms for the cost bucket to refill`);
      }
    },
  });

  console.log(`Store: ${session.shop}`);

  if (args.reset || args.resetOnly) {
    console.log("Reset:");
    await reset(client);
    if (args.resetOnly) {
      console.log("Done (reset-only).");
      return;
    }
  }

  // Guard against accidental double-seeding: refuse to add on top of an
  // existing seed set unless the caller asked for --reset first.
  if (!args.reset) {
    const existing = await findSeedProductIds(client);
    if (existing.length > 0) {
      console.log(
        `Store already has ${existing.length} seeded product(s). ` +
          `Re-run with --reset to replace them, or --reset-only to clear them.`,
      );
      return;
    }
  }

  const location = await getPrimaryLocation(client);
  console.log(`Location: ${location.name} (${location.id})`);

  console.log(`Ensuring ${COLLECTIONS.length} collections…`);
  const collectionIds = new Map<string, string>();
  for (const title of COLLECTIONS) {
    collectionIds.set(title, await ensureCollection(client, title));
  }

  console.log(`Generating ${args.count} products (seed=${args.seed})…`);
  const catalog = generateCatalog(args.count, args.seed);

  const started = Date.now();
  let created = 0;
  let variants = 0;
  const failures: Array<{ title: string; error: string }> = [];

  for (const product of catalog) {
    try {
      const result = await createSeedProduct(client, product, {
        locationId: location.id,
        collectionIds,
      });
      created++;
      variants += result.variantCount;
    } catch (err) {
      const message = isShopifyError(err) ? `${err.kind}: ${err.message}` : String(err);
      failures.push({ title: product.title.trim(), error: message });
      // Validation failures are per-product and expected on messy data; keep going.
      // Anything non-Shopify (a bug) should stop the run rather than spam.
      if (!isShopifyError(err)) throw err;
    }

    if (created % 50 === 0 && created > 0) {
      const avail = client.throttleStatus?.currentlyAvailable ?? "?";
      console.log(`  created ${created}/${args.count} (bucket: ${avail})`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("\n─── Summary ───");
  console.log(`  Products created: ${created}/${args.count}`);
  console.log(`  Variants created: ${variants}`);
  console.log(`  Throttle waits:   ${throttleWaits}`);
  console.log(`  Elapsed:          ${elapsed}s`);
  if (failures.length > 0) {
    console.log(`  Failures:         ${failures.length}`);
    for (const f of failures.slice(0, 10)) console.log(`    - ${f.title}: ${f.error}`);
    if (failures.length > 10) console.log(`    …and ${failures.length - 10} more`);
  }
}

main().catch((err) => {
  if (err instanceof NoSessionError) {
    console.error(`\n✖ ${err.message}`);
  } else if (isShopifyError(err)) {
    console.error(`\n✖ ${err.kind}: ${err.message}`);
  } else {
    console.error("\n✖ Unexpected error:", err);
  }
  process.exit(1);
});
