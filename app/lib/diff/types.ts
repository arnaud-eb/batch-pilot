/**
 * Types for the dry-run diff engine (Phase 2, Section 2).
 *
 * The diff engine sits between a structured change request and any actual
 * mutation: it computes exactly what *would* change, per-variant, and returns it
 * for approval. It performs no writes. Phase 3 will generate ChangeRequest from
 * natural language; here it is hand-written.
 */

/**
 * A structured change request: what to match, and what to do to the matches.
 * Filters select *candidate products*; price/stock are then evaluated
 * per-variant inside the engine (the Section 1 per-variant decision).
 */
export interface ChangeRequest {
  filter: {
    /** Match variants whose price is ≤ this. Evaluated per-variant. */
    priceMax?: number;
    /** Match variants whose price is ≥ this. Evaluated per-variant. */
    priceMin?: number;
    /** Match variants whose on-hand stock is ≥ this. Evaluated per-variant. */
    stockMin?: number;
    /** Match products carrying this tag (product-level, server-side). */
    tag?: string;
    /** Match products in this collection, by title (product-level, server-side). */
    collection?: string;
  };
  change: {
    /** Add these tags to every matched product (merge, product-level). */
    addTags?: string[];
    /** Rename matched products via a pure function of the current title. */
    setTitle?: (current: string) => string;
    /** Set price on every matched *variant* (variant-level). */
    setPrice?: number;
  };
}

/** The field a diff entry touches. */
export type DiffField = "price" | "title" | "tags";

/**
 * One concrete change. There is exactly one entry per *actual* change — a
 * matched variant whose price already equals setPrice produces no entry, so the
 * diff never lists no-op "changes". Product-level entries (title, tags) omit
 * variantId; variant-level entries (price) include it.
 */
export interface DiffEntry {
  productId: string;
  productTitle: string;
  variantId?: string;
  variantTitle?: string;
  field: DiffField;
  oldValue: string | string[];
  newValue: string | string[];
}

/**
 * Per-product match context, so the diff can show *why* a product was included
 * even for product-level changes: "3 of 5 variants match". A product appears
 * here if at least one of its variants matched the filter, whether or not that
 * produced a change entry.
 */
export interface ProductMatch {
  productId: string;
  productTitle: string;
  matchedVariants: number;
  totalVariants: number;
  /** True when only some of the product's variants matched the filter. */
  partial: boolean;
}

export interface DiffSummary {
  productsAffected: number;
  variantsAffected: number;
  lineItemChanges: number;
}

export interface DiffResult {
  entries: DiffEntry[];
  matches: ProductMatch[];
  summary: DiffSummary;
}
