/**
 * Product data generation for the seed script.
 *
 * Pure and deterministic: given the same seed, the same catalog. That matters
 * because Phase 2's dry-run engine will be tested against this data, and a diff
 * engine is much easier to trust when the fixture doesn't move underneath it.
 *
 * The catalog is deliberately messy. Real merchant catalogs have inconsistent
 * casing, stray whitespace, and abandoned tags, and a bulk-edit tool that has
 * only ever seen clean data will confidently mangle a real one.
 */

/** mulberry32 — small, fast, adequate for fixture data. Not cryptographic. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const int = (rng: Rng, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

/** 15-20 tags, per spec. Mixed conventions on purpose — real pools are not tidy. */
export const TAG_POOL = [
  "sale",
  "new-arrival",
  "clearance",
  "summer",
  "winter",
  "bestseller",
  "limited",
  "eco-friendly",
  "handmade",
  "imported",
  "Staff Pick",
  "bundle",
  "gift-idea",
  "final-sale",
  "restock-soon",
  "premium",
  "outlet",
  "seasonal",
] as const;

export const COLLECTIONS = [
  "Summer Essentials",
  "Clearance Corner",
  "New Arrivals",
  "Premium Line",
  "Gift Shop",
] as const;

const PRODUCT_TYPES = [
  "T-Shirt", "Hoodie", "Mug", "Poster", "Tote Bag", "Cap", "Notebook",
  "Sticker Pack", "Water Bottle", "Socks", "Keychain", "Candle",
] as const;

const ADJECTIVES = [
  "Classic", "Vintage", "Modern", "Rustic", "Minimal", "Bold", "Cozy",
  "Sleek", "Retro", "Organic", "Urban", "Coastal",
] as const;

const COLORS = [
  "Black", "White", "Navy", "Olive", "Burgundy", "Sand", "Charcoal", "Teal",
] as const;

const SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;

/**
 * Price points weighted toward what real catalogs actually use: lots of
 * charm pricing (x.99 / x.95) clustered at the low end, a thin premium tail.
 * A uniform €5-€150 spread would make "products under €40" trivially
 * uninteresting to test against.
 */
function generatePrice(rng: Rng): number {
  const roll = rng();
  let base: number;
  if (roll < 0.45) base = int(rng, 5, 25); // budget bulk
  else if (roll < 0.8) base = int(rng, 26, 60); // mid, straddles the €40 boundary
  else if (roll < 0.95) base = int(rng, 61, 110);
  else base = int(rng, 111, 150);

  const ending = pick(rng, [0.99, 0.95, 0.5, 0.0, 0.99, 0.99]);
  return Number((base + ending).toFixed(2));
}

/**
 * Stock with real edge cases: genuine zeros (oversold/discontinued) and
 * four-figure counts. Phase 2 needs both — "everything out of stock" and
 * "everything with stock over 1000" are exactly the queries a merchant asks.
 */
function generateStock(rng: Rng): number {
  const roll = rng();
  if (roll < 0.15) return 0;
  if (roll < 0.2) return int(rng, 1, 3); // nearly gone
  if (roll < 0.85) return int(rng, 4, 250);
  if (roll < 0.97) return int(rng, 251, 1500);
  return int(rng, 1501, 9999);
}

/**
 * Messiness applied to titles. Each product gets at most one defect so the
 * catalog stays plausible rather than uniformly corrupted, and so a fix for
 * one defect class can be verified without the others interfering.
 */
type TitleDefect = "none" | "trailing_ws" | "leading_ws" | "upper" | "lower" | "double_space";

function messyTitle(rng: Rng, clean: string): { title: string; defect: TitleDefect } {
  const roll = rng();
  if (roll < 0.6) return { title: clean, defect: "none" };
  if (roll < 0.7) return { title: `${clean}  `, defect: "trailing_ws" };
  if (roll < 0.78) return { title: ` ${clean}`, defect: "leading_ws" };
  if (roll < 0.87) return { title: clean.toUpperCase(), defect: "upper" };
  if (roll < 0.94) return { title: clean.toLowerCase(), defect: "lower" };
  return { title: clean.replace(" ", "  "), defect: "double_space" };
}

export interface SeedVariant {
  /** Null for single-variant products, which Shopify represents as one default variant. */
  optionValue: string | null;
  price: number;
  stock: number;
  sku: string;
}

export interface SeedProduct {
  title: string;
  cleanTitle: string;
  defect: TitleDefect;
  productType: string;
  vendor: string;
  tags: string[];
  collections: string[];
  variants: SeedVariant[];
}

/**
 * Roughly a third of products get multiple variants at differing prices.
 * Single-variant catalogs hide the question "what is this product's price?",
 * which is precisely the question queryProducts has to answer correctly.
 */
function generateVariants(rng: Rng, sku: string): SeedVariant[] {
  const basePrice = generatePrice(rng);

  if (rng() < 0.65) {
    return [{ optionValue: null, price: basePrice, stock: generateStock(rng), sku }];
  }

  const useSizes = rng() < 0.6;
  const pool = useSizes ? SIZES : COLORS;
  const count = int(rng, 2, Math.min(5, pool.length));
  const chosen = [...pool].slice(0, count);

  return chosen.map((value, i) => {
    // Larger sizes / later colors drift upward in price, as real catalogs do.
    const drift = useSizes ? i * int(rng, 0, 3) : int(rng, -3, 5);
    const price = Math.max(1, Number((basePrice + drift).toFixed(2)));
    return { optionValue: value, price, stock: generateStock(rng), sku: `${sku}-${value}` };
  });
}

export function generateProduct(rng: Rng, index: number): SeedProduct {
  const adjective = pick(rng, ADJECTIVES);
  const productType = pick(rng, PRODUCT_TYPES);
  const cleanTitle = `${adjective} ${productType} ${index + 1}`;
  const { title, defect } = messyTitle(rng, cleanTitle);

  // Most products get 1-3 tags, per spec; a few get none, a few get many.
  const tagRoll = rng();
  const tagCount = tagRoll < 0.08 ? 0 : tagRoll < 0.85 ? int(rng, 1, 3) : int(rng, 4, 6);
  const tags = [...new Set(Array.from({ length: tagCount }, () => pick(rng, TAG_POOL)))];

  // Products can belong to several collections — the reason queryProducts
  // returns collections as an array rather than a single value.
  const collectionCount = rng() < 0.12 ? 0 : int(rng, 1, 3);
  const collections = [
    ...new Set(Array.from({ length: collectionCount }, () => pick(rng, COLLECTIONS))),
  ];

  return {
    title,
    cleanTitle,
    defect,
    productType,
    vendor: pick(rng, ["Acme Co", "Northwind", "Globex", "Initech", "Umbrella"]),
    tags,
    collections,
    variants: generateVariants(rng, `BP-${String(index + 1).padStart(5, "0")}`),
  };
}

export function generateCatalog(count: number, seed: number): SeedProduct[] {
  const rng = makeRng(seed);
  return Array.from({ length: count }, (_, i) => generateProduct(rng, i));
}
