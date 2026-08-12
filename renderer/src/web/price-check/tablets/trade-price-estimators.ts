/** Defaults for tablet buy/sell trade estimators (exalt-native prices). */
export const BUY_DEPTH_N = 25;
export const SELL_STALE_MS = 24 * 60 * 60 * 1000;
/** Ignore listings older than this for the "stale clearing price" preference. */
export const SELL_MAX_STALE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const HOT_MARKET_UNDERCUT = 0.95;
/**
 * Trade sorts by raw amount across mixed currencies, so the cheapest page is
 * flooded with 1-alch / 1-transmute noise. Drop sub-floor asks before buy@N.
 * Blanks are typically 50–200ex; <5ex after conversion is dust.
 */
export const BUY_DUST_FLOOR_EX = 5;
/** Absolute blank-buy ceiling (~70div @350ex) — rejects mirror/meme asks. */
export const BUY_MAX_EX = 25_000;
/** Crafted combo sell ceiling — still rejects mirrors / fat-finger divines. */
export const SELL_MAX_EX = 100_000;

export interface PricedListing {
  /** Listing price converted to exalted orbs. */
  priceEx: number;
  /** ISO listing.indexed; missing → treated as fresh (not stale). */
  indexedAt?: string;
  /** Original listing currency id (e.g. exalted, chaos). */
  currency?: string;
}

/** FX + orb costs in exalted — used to normalize any trade listing currency. */
export interface ExaltFx {
  exaltPerChaos: number;
  exaltPerDivine: number;
  alchemy?: number;
  regal?: number;
  vaal?: number;
  transmute?: number;
  augmentation?: number;
  scouring?: number;
  /** Optional: exalt value of one greater/perfect exalted orb */
  greaterExalted?: number;
  perfectExalted?: number;
}

/** EE2 remaps greater/perfect trade tags to display labels before we see them. */
const DISPLAY_CURRENCY_TO_TRADE_TAG: Record<string, string> = {
  "G. transmute": "greater-orb-of-transmutation",
  "P. transmute": "perfect-orb-of-transmutation",
  "G. aug": "greater-orb-of-augmentation",
  "P. aug": "perfect-orb-of-augmentation",
  "G. chaos": "greater-chaos-orb",
  "P. chaos": "perfect-chaos-orb",
  "G. regal": "greater-regal-orb",
  "P. regal": "perfect-regal-orb",
  "G. exalted": "greater-exalted-orb",
  "P. exalted": "perfect-exalted-orb",
};

/** Map priceCurrency (trade tag or EE2 display label) → trade tag. */
export function resolveTradeCurrencyTag(priceCurrency: string): string {
  const trimmed = priceCurrency.trim();
  if (DISPLAY_CURRENCY_TO_TRADE_TAG[trimmed]) {
    return DISPLAY_CURRENCY_TO_TRADE_TAG[trimmed];
  }
  return trimmed;
}

function normCurrency(currency: string): string {
  const tag = resolveTradeCurrencyTag(currency);
  return tag
    .toLowerCase()
    .trim()
    .replace(/\./g, " ")
    .replace(/\s+/g, "-")
    .replace(/^g-/, "greater-")
    .replace(/^p-/, "perfect-");
}

/**
 * Convert a trade listing amount+currency into exalted orbs.
 * Only whitelist currencies — mirrors / unknown orbs return null (never invent).
 * Uses explicit FX only (no ninja primaryValue multiply — that double-counted).
 */
export function listingAmountToExalt(
  amount: number,
  currency: string,
  fx: ExaltFx,
): number | null {
  if (!(amount > 0) || !Number.isFinite(amount)) return null;
  if (!(fx.exaltPerChaos > 0) || !(fx.exaltPerDivine > 0)) return null;
  const c = normCurrency(currency);

  if (
    c === "exalted" ||
    c === "exalted-orb" ||
    c === "exa" ||
    c === "exalt"
  ) {
    return amount;
  }
  if (c === "chaos" || c === "chaos-orb") {
    return amount * fx.exaltPerChaos;
  }
  if (c === "divine" || c === "divine-orb" || c === "div") {
    return amount * fx.exaltPerDivine;
  }

  const orbCost = (n: number | undefined) =>
    n != null && Number.isFinite(n) && n > 0 ? amount * n : null;

  if (c === "alch" || c === "alchemy" || c === "orb-of-alchemy") {
    return orbCost(fx.alchemy);
  }
  if (c === "regal" || c === "regal-orb") return orbCost(fx.regal);
  if (c === "vaal" || c === "vaal-orb") return orbCost(fx.vaal);
  if (
    c === "transmute" ||
    c === "orb-of-transmutation" ||
    c === "transmutation"
  ) {
    return orbCost(fx.transmute);
  }
  if (
    c === "aug" ||
    c === "augmentation" ||
    c === "orb-of-augmentation"
  ) {
    return orbCost(fx.augmentation);
  }
  if (c === "scour" || c === "scouring" || c === "orb-of-scouring") {
    return orbCost(fx.scouring ?? 0) ?? 0;
  }

  if (c === "greater-chaos-orb" || c === "greater-chaos") {
    // Approx: treat as chaos (better than dropping); G-chaos ≥ chaos
    return amount * fx.exaltPerChaos;
  }
  if (c === "perfect-chaos-orb" || c === "perfect-chaos") {
    return amount * fx.exaltPerChaos;
  }
  if (c === "greater-exalted-orb" || c === "greater-exalted") {
    return orbCost(fx.greaterExalted);
  }
  if (c === "perfect-exalted-orb" || c === "perfect-exalted") {
    return orbCost(fx.perfectExalted);
  }

  // Explicit reject: mirrors and anything else (never ninja-multiply into millions)
  return null;
}

/**
 * Keep only listings inside [floor, ceiling].
 * Never falls back to dust/outliers — empty is better than wrong.
 */
export function filterBuyListings(
  listings: PricedListing[],
  opts?: { floorEx?: number; ceilingEx?: number },
): PricedListing[] {
  const floorEx = opts?.floorEx ?? BUY_DUST_FLOOR_EX;
  const ceilingEx = opts?.ceilingEx ?? BUY_MAX_EX;
  return listings.filter(
    (l) =>
      Number.isFinite(l.priceEx) &&
      l.priceEx >= floorEx &&
      l.priceEx <= ceilingEx,
  );
}

/** @deprecated use filterBuyListings */
export function filterDustBuyListings(
  listings: PricedListing[],
  floorEx = BUY_DUST_FLOOR_EX,
): PricedListing[] {
  return filterBuyListings(listings, { floorEx, ceilingEx: BUY_MAX_EX });
}

/**
 * Buy price after conversion to exalt.
 *
 * Trade returns results sorted by *raw* currency amount (15 vaal before 1 divine),
 * so our fetched sample is often thin once re-sorted in exalt. Using a fixed
 * buy@25 on a 29-listing book picks near the ask wall (e.g. 1div). Cap depth to
 * ~35% of the converted book so thin samples stay near the liquid floor.
 */
export function estimateBuyPriceEx(
  listings: PricedListing[],
  n = BUY_DEPTH_N,
): number | null {
  const sorted = listings
    .map((l) => l.priceEx)
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;

  // Tiny books: median (avoid the lone ask-wall outlier)
  if (sorted.length < 6) {
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }

  // Deep books: classic buy@N
  if (sorted.length >= n * 2) {
    return sorted[n - 1];
  }

  // Medium/thin: ~35th percentile of the converted sample
  const depth = Math.min(n, Math.max(3, Math.floor(sorted.length * 0.35)));
  return sorted[depth - 1];
}

/** Human-readable note for debug traces. */
export function buyEstimateNote(sampleSize: number, n = BUY_DEPTH_N): string {
  if (!sampleSize) return "empty";
  if (sampleSize < 6) return `median (n=${sampleSize})`;
  if (sampleSize >= n * 2) return `buy@${n}`;
  const depth = Math.min(n, Math.max(3, Math.floor(sampleSize * 0.35)));
  return `p~35% (n=${sampleSize}→@${depth})`;
}

/**
 * Sell price after exalt conversion.
 *
 * Prefer a recently-stale clearing ask when the book has depth; on thin books
 * (typical crafted combos) undercut the live floor — "cheapest stale" alone
 * often picks a lone underpriced ghost.
 */
export function estimateSellPriceEx(
  listings: PricedListing[],
  opts?: {
    nowMs?: number;
    staleMs?: number;
    maxStaleAgeMs?: number;
    hotUndercut?: number;
    ceilingEx?: number;
  },
): number | null {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleMs = opts?.staleMs ?? SELL_STALE_MS;
  const maxStaleAgeMs = opts?.maxStaleAgeMs ?? SELL_MAX_STALE_AGE_MS;
  const hotUndercut = opts?.hotUndercut ?? HOT_MARKET_UNDERCUT;
  const ceilingEx = opts?.ceilingEx ?? SELL_MAX_EX;

  const priced = listings
    .filter(
      (l) =>
        Number.isFinite(l.priceEx) && l.priceEx > 0 && l.priceEx <= ceilingEx,
    )
    .slice()
    .sort((a, b) => a.priceEx - b.priceEx);
  if (!priced.length) return null;

  const ageMs = (l: PricedListing): number | null => {
    if (!l.indexedAt) return null;
    const t = Date.parse(l.indexedAt);
    if (!Number.isFinite(t)) return null;
    return nowMs - t;
  };

  const fresh = priced.filter((l) => {
    const age = ageMs(l);
    return age == null || age < staleMs;
  });
  const stale = priced.filter((l) => {
    const age = ageMs(l);
    return age != null && age >= staleMs && age <= maxStaleAgeMs;
  });

  // Thin books: live floor × undercut (don't ride a single stale ghost)
  if (priced.length < 6 || fresh.length > 0) {
    const floor = (fresh.length ? fresh : priced)[0].priceEx;
    // If a stale ask is near the live floor, prefer it as clearing price
    if (stale.length && stale[0].priceEx <= floor * 1.15) {
      return stale[0].priceEx;
    }
    return floor * hotUndercut;
  }

  // Deep, all-stale book: cheapest recently-stale clearing ask
  if (stale.length) return stale[0].priceEx;
  return priced[0].priceEx * hotUndercut;
}
