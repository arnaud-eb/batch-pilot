/**
 * Rate-limit-aware Admin GraphQL client.
 *
 * Shopify throttles on a cost-based leaky bucket, not requests/sec. Every
 * response carries `extensions.cost.throttleStatus`, so rather than guessing a
 * safe request rate we track the real bucket and wait exactly long enough for
 * it to refill. Measured on the dev store: 2000 point capacity, 100 points/sec
 * restore. Those are read from responses, not hardcoded, because the ceiling
 * differs by plan (Plus stores get considerably more).
 */

import {
  AuthError,
  GraphQLRequestError,
  NetworkError,
  RateLimitedError,
  ValidationError,
} from "./errors";

/** Matches ApiVersion.July26 in app/shopify.server.ts. Keep them in step. */
export const API_VERSION = "2026-07";

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface QueryCost {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: ThrottleStatus;
}

export interface GraphQLResponse<T> {
  data: T;
  cost: QueryCost | null;
}

export interface ClientOptions {
  shop: string;
  accessToken: string;
  apiVersion?: string;
  /**
   * Keep this many points in the bucket rather than spending to zero. A margin
   * means an unexpectedly expensive query doesn't hard-fail, it just waits.
   */
  reserve?: number;
  maxRetries?: number;
  /** Injectable for tests so retry logic doesn't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Fires when the client proactively waits for the bucket to refill. */
  onThrottleWait?: (info: { waitMs: number; status: ThrottleStatus }) => void;
  /**
   * Fires when Shopify actually throttled a request and the client is retrying.
   * Distinct from onThrottleWait (which is self-pacing before spending): this
   * means we hit the real limit. The deliberate rate-limit test asserts on it.
   */
  onThrottle?: (info: { attempt: number; reason: "http_429" | "http_430" | "graphql_throttled" }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ShopifyClient {
  private readonly endpoint: string;
  private readonly accessToken: string;
  private readonly reserve: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onThrottleWait?: ClientOptions["onThrottleWait"];
  private readonly onThrottle?: ClientOptions["onThrottle"];

  /** Last known bucket state, updated from every response. */
  private throttle: ThrottleStatus | null = null;

  constructor(opts: ClientOptions) {
    const version = opts.apiVersion ?? API_VERSION;
    const shop = opts.shop.replace(/^https?:\/\//, "");
    this.endpoint = `https://${shop}/admin/api/${version}/graphql.json`;
    this.accessToken = opts.accessToken;
    this.reserve = opts.reserve ?? 100;
    this.maxRetries = opts.maxRetries ?? 5;
    this.sleep = opts.sleep ?? defaultSleep;
    this.onThrottleWait = opts.onThrottleWait;
    this.onThrottle = opts.onThrottle;
  }

  /** Current bucket state, or null before the first response. */
  get throttleStatus(): ThrottleStatus | null {
    return this.throttle;
  }

  /**
   * Wait until the bucket can afford `cost` points plus the reserve.
   * Called before spending, so we throttle ourselves rather than relying on
   * Shopify to reject us and then recovering.
   */
  private async waitForCapacity(cost: number): Promise<void> {
    const status = this.throttle;
    if (!status) return; // No data yet — first request establishes the baseline.

    const needed = cost + this.reserve - status.currentlyAvailable;
    if (needed <= 0) return;

    const waitMs = Math.ceil((needed / status.restoreRate) * 1000);
    this.onThrottleWait?.({ waitMs, status });
    await this.sleep(waitMs);

    // Assume the bucket refilled as advertised; the next response corrects it.
    this.throttle = {
      ...status,
      currentlyAvailable: Math.min(
        status.maximumAvailable,
        status.currentlyAvailable + Math.ceil((waitMs / 1000) * status.restoreRate),
      ),
    };
  }

  /**
   * Execute a GraphQL document. `estimatedCost` lets callers declare an
   * expensive query up front so we pace before spending rather than after.
   */
  async request<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
    opts: { estimatedCost?: number } = {},
  ): Promise<GraphQLResponse<T>> {
    const estimatedCost = opts.estimatedCost ?? 10;
    let attempt = 0;

    for (;;) {
      await this.waitForCapacity(estimatedCost);

      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": this.accessToken,
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (cause) {
        if (attempt++ >= this.maxRetries) {
          throw new NetworkError(`Request failed after ${attempt} attempts: ${String(cause)}`);
        }
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new AuthError(
          `Admin API rejected the credential (HTTP ${res.status}). The offline token may have ` +
            `expired — open the app in the Shopify admin to refresh it.`,
          { status: res.status },
        );
      }

      // 430 is Shopify's "shop is over its limit"; 429 is standard throttling.
      if (res.status === 429 || res.status === 430) {
        this.onThrottle?.({ attempt: attempt + 1, reason: res.status === 429 ? "http_429" : "http_430" });
        const retryAfterMs = retryAfterFromHeader(res) ?? backoffMs(attempt + 1);
        if (attempt++ >= this.maxRetries) {
          throw new RateLimitedError(
            `Still throttled after ${attempt} attempts`,
            retryAfterMs,
            { status: res.status },
          );
        }
        await this.sleep(retryAfterMs);
        continue;
      }

      if (res.status >= 500) {
        if (attempt++ >= this.maxRetries) {
          throw new NetworkError(`Shopify returned HTTP ${res.status} after ${attempt} attempts`);
        }
        await this.sleep(backoffMs(attempt));
        continue;
      }

      let body: {
        data?: T;
        errors?: Array<{ message: string; extensions?: { code?: string } }>;
        extensions?: { cost?: QueryCost };
      };
      try {
        body = await res.json();
      } catch (cause) {
        throw new GraphQLRequestError(`Malformed JSON from Admin API: ${String(cause)}`);
      }

      const cost = body.extensions?.cost ?? null;
      if (cost?.throttleStatus) this.throttle = cost.throttleStatus;

      if (body.errors?.length) {
        // THROTTLED arrives as a 200 with a GraphQL error, not an HTTP status.
        const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
        if (throttled) {
          this.onThrottle?.({ attempt: attempt + 1, reason: "graphql_throttled" });
          const waitMs = this.throttle
            ? Math.ceil(((estimatedCost + this.reserve) / this.throttle.restoreRate) * 1000)
            : backoffMs(attempt + 1);
          if (attempt++ >= this.maxRetries) {
            throw new RateLimitedError(`Throttled after ${attempt} attempts`, waitMs, {
              throttleStatus: this.throttle,
            });
          }
          await this.sleep(waitMs);
          continue;
        }

        throw new GraphQLRequestError(
          body.errors.map((e) => e.message).join("; "),
          body.errors,
        );
      }

      if (!body.data) {
        throw new GraphQLRequestError("Admin API returned no data and no errors");
      }

      return { data: body.data, cost };
    }
  }
}

/** Exponential backoff with jitter, capped so a stuck loop stays responsive. */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 16_000);
  return base + Math.floor(Math.random() * 250);
}

function retryAfterFromHeader(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

/**
 * Collect `userErrors` from a mutation payload into a ValidationError.
 * Shopify returns these with HTTP 200 and no GraphQL errors, so they are
 * invisible unless explicitly checked — the single most common way to write a
 * mutation wrapper that silently does nothing.
 */
export function assertNoUserErrors(
  payload: { userErrors?: Array<{ field: string[] | null; message: string }> } | null | undefined,
  operation: string,
): void {
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new ValidationError(
      `${operation} rejected: ${userErrors.map((e) => e.message).join("; ")}`,
      userErrors,
      { operation },
    );
  }
}
