/**
 * Buy/sell trade estimators + market flow classification (exalt-native).
 */

export const BUY_DEPTH_N = 25;
/** Hot / refilling book — ~10th cheapest as working ceiling. */
export const BUY_DEPTH_HOT = 10;
/** Default cold-market patience depth (overridable from UI). */
export const BUY_DEPTH_COLD_DEFAULT = 25;

export const SELL_STALE_MS = 24 * 60 * 60 * 1000;
/**
 * @deprecated unused — Instant Buyout listings stay buyable offline.
 * No 14-day ghost cap. Estimator default is Infinity.
 */
export const SELL_MAX_STALE_AGE_MS = Number.POSITIVE_INFINITY;
/** Pack / no-24h window-max undercut (3%). */
export const SELL_UNDERCUT_PCT = 0.03;
/** Thin stale undercut when fewer than {@link SELL_THIN_PACK_BEFORE} sit under the 24h wall. */
export const SELL_UNDERCUT_THIN_PCT = 0.1;
/**
 * Pack-below count at which we use 3% closest-under only.
 * `below.length < 9` mixes in 10% off the stale anchor.
 */
export const SELL_THIN_PACK_BEFORE = 9;
/**
 * @deprecated obsolete for Instant Buyout sell — do not pick 3% vs 10% from total n.
 * Kept for older call sites.
 */
export const SELL_THIN_BOOK = 6;
/** @deprecated prefer SELL_UNDERCUT_PCT — kept for older call sites */
export const HOT_MARKET_UNDERCUT = 1 - SELL_UNDERCUT_PCT;

/**
 * Wall-clock gap between Instant Buyout probe#1 and probe#2 for flow detection.
 * Sync bookends other trade work (junk/combo sells) between snaps; if that
 * middle work finishes early, idle-wait the remainder so the gap ≈ this value.
 * Gap duration is detection-only — never scales classify / mean-of-B math.
 */
export const FLOW_PROBE_MS = 45_000;
/** New listings below ceiling on re-query → treat as hot. */
export const FLOW_PROBE_MIN_NEW = 2;
/** Sync skips remainder sleeps at or below this (not worth a wait tick). */
export const FLOW_PROBE_WAIT_SKIP_MS = 500;

/**
 * Remaining idle ms before probe#2 so wall-clock (now − snap1) ≈ flowProbeMs.
 * Returns 0 when middle work already burned the detection window.
 * Callers skip sleep when the result is ≤ {@link FLOW_PROBE_WAIT_SKIP_MS}.
 */
export function remainingFlowProbeWaitMs(
  snap1FetchedAt: number,
  now: number,
  flowProbeMs: number,
): number {
  return Math.max(0, flowProbeMs - (now - snap1FetchedAt));
}

export const BUY_DUST_FLOOR_EX = 5;
export const BUY_MAX_EX = 25_000;
export const SELL_MAX_EX = 100_000;

export type MarketFlowRegime = "hot" | "cold" | "unknown";

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
  greaterExalted?: number;
  perfectExalted?: number;
}

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
    c === "augmentation" ||
    c === "orb-of-augmentation" ||
    c === "aug"
  ) {
    return orbCost(fx.augmentation);
  }
  if (c === "scour" || c === "scouring" || c === "orb-of-scouring") {
    return orbCost(fx.scouring ?? 0) ?? 0;
  }
  if (c === "greater-exalted-orb" || c === "greater-exalted") {
    return orbCost(fx.greaterExalted);
  }
  if (c === "perfect-exalted-orb" || c === "perfect-exalted") {
    return orbCost(fx.perfectExalted);
  }
  if (c === "greater-chaos-orb" || c === "greater-chaos") {
    return amount * fx.exaltPerChaos;
  }
  if (c === "perfect-chaos-orb" || c === "perfect-chaos") {
    return amount * fx.exaltPerChaos;
  }
  return null;
}

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
 * Buy price: nth cheapest after exalt sort.
 * Kept for flow-probe / debug “buy@N” labels only — EV/`basePrices` use
 * {@link estimateBuyPriceMeanOfCheapestEx}.
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

  if (sorted.length < 6) {
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }

  if (sorted.length >= n * 2) {
    return sorted[Math.min(n, sorted.length) - 1];
  }

  const depth = Math.min(n, Math.max(3, Math.floor(sorted.length * 0.35)));
  return sorted[depth - 1];
}

export function buyEstimateNote(sampleSize: number, n = BUY_DEPTH_N): string {
  if (!sampleSize) return "empty";
  if (sampleSize < 6) return `median (n=${sampleSize})`;
  if (sampleSize >= n * 2) return `buy@${n}`;
  const depth = Math.min(n, Math.max(3, Math.floor(sampleSize * 0.35)));
  return `p~35% (n=${sampleSize}→@${depth})`;
}

/**
 * Effective mean-of-cheapest count for EV blank cost (not legacy max(HOT,min(B,25))).
 * hot → min(B,10); cold → B; warm/unknown → min(B,25).
 */
export function effectiveBuyCountForRegime(
  regime: MarketFlowRegime,
  buyCountB: number,
): number {
  const B = Math.max(5, Math.min(50, Math.round(buyCountB)));
  if (regime === "hot") return Math.min(B, BUY_DEPTH_HOT);
  if (regime === "cold") return B;
  return Math.min(B, BUY_DEPTH_N);
}

/**
 * EV / market `basePrices` blank unit cost: mean of the cheapest B asks.
 * Thin books (n < 6): median. No ~35% mid-book heuristic.
 * When 6 ≤ n < B: mean of all asks (k = n).
 */
export function estimateBuyPriceMeanOfCheapestEx(
  listings: PricedListing[],
  B: number,
): number | null {
  const sorted = listings
    .map((l) => l.priceEx)
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;

  if (sorted.length < 6) {
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }

  const depth = Math.max(1, Math.round(B));
  const k = Math.min(depth, sorted.length);
  let sum = 0;
  for (let i = 0; i < k; i++) sum += sorted[i]!;
  return sum / k;
}

/** Status / debug notes for the mean-of-B blank-cost path. */
export function buyMeanEstimateNote(
  sampleSize: number,
  buyCountB: number,
  regime?: MarketFlowRegime,
): string {
  if (!sampleSize) return "empty";
  if (sampleSize < 6) return `median (n=${sampleSize})`;

  const B = Math.max(5, Math.min(50, Math.round(buyCountB)));
  // Undefined regime → unknown (= warm path: min(B,25)), not cold/full-B.
  const effectiveRegime: MarketFlowRegime = regime ?? "unknown";
  const kEff = effectiveBuyCountForRegime(effectiveRegime, B);
  const k = Math.min(kEff, sampleSize);

  if (effectiveRegime === "hot") {
    return B <= BUY_DEPTH_HOT && k === kEff
      ? `mean@hot10`
      : `mean@min(B,10)`;
  }
  if (effectiveRegime === "cold") {
    return k < B ? `mean@min(B,${sampleSize})` : `mean@B`;
  }
  // warm / unknown
  return kEff < B || k < kEff ? `mean@min(B,25)` : `mean@warm25`;
}

/**
 * Probe / debug depth labels. EV blank cost uses {@link effectiveBuyCountForRegime}.
 */
export function buyDepthForRegime(
  regime: MarketFlowRegime,
  coldDepth = BUY_DEPTH_COLD_DEFAULT,
): number {
  if (regime === "hot") return BUY_DEPTH_HOT;
  if (regime === "cold") return Math.max(5, coldDepth);
  return Math.max(BUY_DEPTH_HOT, Math.min(coldDepth, BUY_DEPTH_N));
}

function listingFingerprint(l: PricedListing): string {
  return `${l.priceEx}|${l.currency ?? ""}|${l.indexedAt ?? ""}`;
}

/**
 * Compare two samples of the same query. Hot = book below ceiling gained
 * enough new fingerprints (refilling). Cold = no meaningful refill.
 */
export function classifyMarketFlow(
  first: PricedListing[],
  second: PricedListing[],
  opts?: {
    ceilingEx?: number;
    minNew?: number;
  },
): MarketFlowRegime {
  if (!first.length && !second.length) return "unknown";
  const minNew = opts?.minNew ?? FLOW_PROBE_MIN_NEW;

  const ceiling =
    opts?.ceilingEx ??
    (() => {
      const sorted = first
        .map((l) => l.priceEx)
        .filter((p) => Number.isFinite(p) && p > 0)
        .sort((a, b) => a - b);
      if (!sorted.length) return Number.POSITIVE_INFINITY;
      // ~15th cheapest or last — band we care about grabbing
      const idx = Math.min(sorted.length - 1, Math.max(9, BUY_DEPTH_HOT - 1));
      return sorted[idx] * 1.15;
    })();

  const below = (xs: PricedListing[]) =>
    xs.filter((l) => Number.isFinite(l.priceEx) && l.priceEx <= ceiling);

  const a = below(first);
  const b = below(second);
  if (!a.length && !b.length) return "unknown";

  const firstKeys = new Set(a.map(listingFingerprint));
  let newCount = 0;
  for (const l of b) {
    if (!firstKeys.has(listingFingerprint(l))) newCount += 1;
  }

  if (newCount >= minNew) return "hot";
  // Also hot if count below ceiling grew meaningfully (bulk refill same prices)
  if (b.length >= a.length + minNew) return "hot";
  return "cold";
}

export interface SellEstimate {
  price: number | null;
  note: string;
}

export type SellEstimateOpts = {
  nowMs?: number;
  staleMs?: number;
  /** @deprecated unused — Instant Buyout has no 14-day ghost cap */
  maxStaleAgeMs?: number;
  undercutPct?: number;
  thinUndercutPct?: number;
  /** Pack-below count for 3%-only vs mix-in-10%-stale. Default {@link SELL_THIN_PACK_BEFORE}. */
  thinPackBefore?: number;
  /** @deprecated unused — estimator no longer uses total book size */
  thinBook?: number;
  /** @deprecated ignored — use undercutPct */
  hotUndercut?: number;
  ceilingEx?: number;
};

/** Age in ms; missing / unparsable `indexedAt` → fresh (not ≥24h). */
export function listingAgeMs(
  listing: PricedListing,
  nowMs: number,
): number | null {
  if (!listing.indexedAt) return null;
  const t = Date.parse(listing.indexedAt);
  if (!Number.isFinite(t)) return null;
  return nowMs - t;
}

/** Kept Instant Buyout row sitting ≥24h. Missing indexedAt is fresh. */
export function isSellListingStale(
  listing: PricedListing,
  nowMs = Date.now(),
  staleMs = SELL_STALE_MS,
): boolean {
  const age = listingAgeMs(listing, nowMs);
  return age != null && age >= staleMs;
}

/**
 * Instant Buyout sell: SEARCH is price-asc; FETCH stops at the first kept ≥24h
 * ask. No 14-day ghost cap (offline IB is still buyable). No total-n 3%/10% split.
 *
 * - Any ≥24h: cheapest such row is the stale wall.
 *   Pack-below = strictly cheaper. Closest-under = highest of those.
 *   `below.length >= 9` → 3% off closest-under only.
 *   `below.length < 9` → max(3% closest-under if any, 10% stale). 0 below → 10% stale.
 * - No ≥24h in the fetched window → 3% under the most expensive kept listing
 *   (top of the cheapest-N window), not the cheapest.
 */
export function estimateSellPriceDetail(
  listings: PricedListing[],
  opts?: SellEstimateOpts,
): SellEstimate {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleMs = opts?.staleMs ?? SELL_STALE_MS;
  const ceilingEx = opts?.ceilingEx ?? SELL_MAX_EX;
  const undercutPct = opts?.undercutPct ?? SELL_UNDERCUT_PCT;
  const thinUndercutPct = opts?.thinUndercutPct ?? SELL_UNDERCUT_THIN_PCT;
  const thinPackBefore = opts?.thinPackBefore ?? SELL_THIN_PACK_BEFORE;

  const priced = listings
    .filter(
      (l) =>
        Number.isFinite(l.priceEx) && l.priceEx > 0 && l.priceEx <= ceilingEx,
    )
    .slice()
    .sort((a, b) => a.priceEx - b.priceEx);
  if (!priced.length) return { price: null, note: "empty" };

  const stale = priced.filter((l) => isSellListingStale(l, nowMs, staleMs));

  if (stale.length) {
    const anchor = stale[0]!;
    const below = priced.filter((l) => l.priceEx < anchor.priceEx - 1e-9);
    const closestUnder = below.length ? below[below.length - 1]! : null;
    const packValue =
      closestUnder != null ? closestUnder.priceEx * (1 - undercutPct) : null;
    const staleValue = anchor.priceEx * (1 - thinUndercutPct);

    if (below.length >= thinPackBefore) {
      return {
        price: packValue,
        note: `3% closest-under (below=${below.length})`,
      };
    }
    if (packValue == null) {
      return {
        price: staleValue,
        note: "10% stale-anchor (0 below)",
      };
    }
    return {
      price: Math.max(packValue, staleValue),
      note: `max(3% pack, 10% stale) below=${below.length}`,
    };
  }

  const windowMax = priced[priced.length - 1]!.priceEx;
  return {
    price: windowMax * (1 - undercutPct),
    note: `3% window-max (n=${priced.length}, no 24h)`,
  };
}

export function estimateSellPriceEx(
  listings: PricedListing[],
  opts?: SellEstimateOpts,
): number | null {
  return estimateSellPriceDetail(listings, opts).price;
}

export function sellEstimateNote(
  listings: PricedListing[],
  opts?: SellEstimateOpts,
): string {
  return estimateSellPriceDetail(listings, opts).note;
}
