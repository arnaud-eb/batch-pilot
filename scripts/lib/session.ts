/**
 * Loads the app's stored offline session so standalone scripts can talk to the
 * Admin API without a second set of credentials.
 *
 * This deliberately reuses the token `shopify app dev` already negotiated
 * rather than asking for a hand-made Admin API token: fewer secrets to manage,
 * and the script provably uses the same scopes the app itself was granted.
 *
 * Caveat worth knowing: `shopify app dev` fires APP_UNINSTALLED on startup and
 * reinstalls, which clears this table. If the script reports no session, open
 * the app in the Shopify admin once and re-run.
 */

import { PrismaClient } from "@prisma/client";

export interface StoreSession {
  shop: string;
  accessToken: string;
  scopes: string[];
}

export class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSessionError";
  }
}

/**
 * Preferred credential path: a custom-app Admin API token (`shpat_…`) from
 * .env. Unlike the app's offline session these do not expire, which matters
 * because the app's tokens live ~60 minutes and only refresh when someone
 * loads the app in the admin — a long seed run would die partway through,
 * having already created several hundred products.
 */
function sessionFromEnv(): StoreSession | null {
  const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!accessToken || !shop) return null;

  return {
    shop: shop.replace(/^https?:\/\//, ""),
    accessToken,
    // Custom-app tokens carry no scope list; assume configured correctly and
    // let the API reject us with a real message if not.
    scopes: (process.env.SHOPIFY_ADMIN_SCOPES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export async function loadOfflineSession(shopDomain?: string): Promise<StoreSession> {
  const fromEnv = sessionFromEnv();
  if (fromEnv) return fromEnv;

  const prisma = new PrismaClient();
  try {
    const sessions = await prisma.session.findMany({
      where: { isOnline: false, ...(shopDomain ? { shop: shopDomain } : {}) },
    });

    if (sessions.length === 0) {
      throw new NoSessionError(
        "No offline session found in prisma/dev.sqlite.\n" +
          "Run `shopify app dev`, then open the app once in the Shopify admin to store a session.",
      );
    }

    if (sessions.length > 1 && !shopDomain) {
      const shops = sessions.map((s) => s.shop).join(", ");
      throw new NoSessionError(
        `Multiple stores have sessions (${shops}). Pass --shop to choose one.`,
      );
    }

    const session = sessions[0];
    if (session.expires && session.expires.getTime() <= Date.now()) {
      throw new NoSessionError(
        `The offline token for ${session.shop} expired at ${session.expires.toISOString()}.\n` +
          "Open the app in the Shopify admin to refresh it, then re-run.",
      );
    }

    return {
      shop: session.shop,
      accessToken: session.accessToken,
      scopes: session.scope?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
    };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Fail fast with a readable message when a scope is missing, rather than
 * letting the API return an opaque permission error mid-run.
 */
export function assertScopes(session: StoreSession, required: string[]): void {
  // Custom-app tokens report no scope list; nothing to check against, so let
  // the API be the authority rather than inventing a false failure here.
  if (session.scopes.length === 0) return;

  const missing = required.filter((s) => !session.scopes.includes(s));
  if (missing.length > 0) {
    throw new NoSessionError(
      `Session for ${session.shop} is missing required scope(s): ${missing.join(", ")}.\n` +
        `Granted: ${session.scopes.join(", ") || "(none)"}\n` +
        "Update `access_scopes` in shopify.app.toml and restart `shopify app dev`.",
    );
  }
}
