/**
 * Typed failure outcomes for the Admin API wrapper layer.
 *
 * The spec requires "not found", "rate limited" and "validation error" to be
 * distinguishable outcomes rather than one generic throw, because Phase 2's
 * dry-run engine has to react differently to each: a validation error means the
 * planned change is wrong, a not-found means the catalog moved under us, and a
 * rate limit means retry later and nothing is wrong at all.
 */

export type ShopifyErrorKind =
  | "not_found"
  | "rate_limited"
  | "validation"
  | "auth"
  | "graphql"
  | "network";

export abstract class ShopifyError extends Error {
  abstract readonly kind: ShopifyErrorKind;
  /** True when retrying the identical request could plausibly succeed. */
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A referenced resource does not exist, or is not visible to this app. */
export class NotFoundError extends ShopifyError {
  readonly kind = "not_found" as const;
  readonly retryable = false;

  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, { resource, id });
  }
}

/**
 * Shopify rejected the request for cost reasons. `retryAfterMs` is derived from
 * the throttle status when available rather than guessed, so callers can wait
 * exactly as long as the leaky bucket actually needs.
 */
export class RateLimitedError extends ShopifyError {
  readonly kind = "rate_limited" as const;
  readonly retryable = true;

  constructor(
    message: string,
    readonly retryAfterMs: number,
    context: Record<string, unknown> = {},
  ) {
    super(message, { ...context, retryAfterMs });
  }
}

/**
 * The request was well-formed but Shopify refused the change — a userError in
 * mutation response, a bad price format, a tag that violates limits.
 * Never retryable: the same input will always be rejected.
 */
export class ValidationError extends ShopifyError {
  readonly kind = "validation" as const;
  readonly retryable = false;

  constructor(
    message: string,
    readonly userErrors: ReadonlyArray<{ field: string[] | null; message: string }> = [],
    context: Record<string, unknown> = {},
  ) {
    super(message, { ...context, userErrors });
  }
}

/** Token missing, expired or lacking a required scope. */
export class AuthError extends ShopifyError {
  readonly kind = "auth" as const;
  readonly retryable = false;
}

/** A GraphQL-level error that isn't one of the more specific cases above. */
export class GraphQLRequestError extends ShopifyError {
  readonly kind = "graphql" as const;
  readonly retryable = false;

  constructor(
    message: string,
    readonly errors: ReadonlyArray<unknown> = [],
    context: Record<string, unknown> = {},
  ) {
    super(message, { ...context, errors });
  }
}

/** Transport failed — DNS, socket, timeout, 5xx. Worth retrying. */
export class NetworkError extends ShopifyError {
  readonly kind = "network" as const;
  readonly retryable = true;
}

export function isShopifyError(err: unknown): err is ShopifyError {
  return err instanceof ShopifyError;
}
