/**
 * Load .env for standalone scripts. Imported for its side effect at the top of
 * every script entrypoint, before any code reads process.env.
 *
 * The app runtime does NOT use this — the Shopify CLI injects env vars there.
 * This exists only so scripts run outside the CLI (seeding, tests) can find the
 * Admin API token.
 */
import { config } from "dotenv";

config();
