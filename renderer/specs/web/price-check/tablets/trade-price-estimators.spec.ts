import { describe, expect, it } from "vitest";
import {
  BUY_DEPTH_N,
  buyDepthForRegime,
  classifyMarketFlow,
  estimateBuyPriceEx,
  estimateSellPriceEx,
  filterBuyListings,
  filterDustBuyListings,
  listingAmountToExalt,
  type ExaltFx,
} from "@/web/price-check/tablets/trade-price-estimators";

const fx: ExaltFx = {
  exaltPerChaos: 45,
  exaltPerDivine: 350,
  alchemy: 0.05,
  regal: 0.15,
  vaal: 0.4,
  transmute: 0.01,
  augmentation: 0.02,
  scouring: 0,
};

describe("trade-price-estimators", () => {
  it("converts common listing currencies into exalt", () => {
    expect(listingAmountToExalt(100, "exalted", fx)).toBe(100);
    expect(listingAmountToExalt(2, "chaos", fx)).toBe(90);
    expect(listingAmountToExalt(1, "divine", fx)).toBe(350);
    expect(listingAmountToExalt(10, "alch", fx)).toBeCloseTo(0.5);
    expect(listingAmountToExalt(1, "regal", fx)).toBeCloseTo(0.15);
  });

  it("converts EE2 display labels for greater/perfect chaos", () => {
    expect(listingAmountToExalt(2, "G. chaos", fx)).toBe(90);
    expect(listingAmountToExalt(1, "P. chaos", fx)).toBe(45);
  });

  it("does not treat greater exalted as 1:1 with exalted", () => {
    expect(listingAmountToExalt(1, "G. exalted", fx)).toBeNull();
  });

  it("rejects mirrors and unknown currencies", () => {
    expect(listingAmountToExalt(1, "mirror", fx)).toBeNull();
    expect(listingAmountToExalt(1, "ancient", fx)).toBeNull();
  });

  it("filters buy listings with floor and ceiling (no dust fallback)", () => {
    const listings = [
      { priceEx: 0.05, currency: "alch" },
      { priceEx: 2, currency: "chaos" },
      { priceEx: 90, currency: "chaos" },
      { priceEx: 100, currency: "exalted" },
      { priceEx: 50_000_000, currency: "mirror" },
    ];
    const kept = filterBuyListings(listings, { floorEx: 5, ceilingEx: 25_000 });
    expect(kept.map((l) => l.priceEx)).toEqual([90, 100]);
  });

  it("buy ignores multi-million outliers via prefilter", () => {
    // ≥50 kept → classic buy@25; outlier must not skew depth
    const listings = [
      ...Array.from({ length: 60 }, (_, i) => ({ priceEx: 80 + i })),
      { priceEx: 120_000_000 },
    ];
    const kept = filterBuyListings(listings);
    expect(estimateBuyPriceEx(kept, 25)).toBe(104); // 80..139 → index 24 = 104
  });

  it("filters dust asks before buy depth", () => {
    const listings = [
      { priceEx: 0.05, currency: "alch" },
      { priceEx: 0.1, currency: "alch" },
      { priceEx: 0.2, currency: "alch" },
      { priceEx: 0.3, currency: "alch" },
      { priceEx: 0.4, currency: "alch" },
      { priceEx: 2, currency: "chaos" },
      { priceEx: 90, currency: "chaos" },
      { priceEx: 100, currency: "exalted" },
      { priceEx: 110, currency: "exalted" },
      { priceEx: 120, currency: "exalted" },
      { priceEx: 130, currency: "exalted" },
    ];
    const kept = filterDustBuyListings(listings, 5);
    expect(kept.every((l) => l.priceEx >= 5)).toBe(true);
    expect(kept.map((l) => l.priceEx)).toEqual([90, 100, 110, 120, 130]);
  });

  it("buy uses nth cheapest when book is deep (after conversion)", () => {
    const listings = [
      { priceEx: listingAmountToExalt(1, "chaos", fx)! }, // 45
      { priceEx: listingAmountToExalt(50, "exalted", fx)! },
      ...Array.from({ length: 60 }, (_, i) => ({
        priceEx: 60 + i,
      })),
    ];
    // 62 listings ≥ 2*25 → classic buy@25
    // sorted: 45, 50, 60..119 → index 24 = 60+(24-2)=82
    expect(estimateBuyPriceEx(listings, 25)).toBe(82);
    expect(estimateBuyPriceEx(listings, 10)).toBe(67);
  });

  it("buy uses ~35% depth on thin converted books (not buy@25 into ask wall)", () => {
    // Mirrors dump2: ~29 usable asks, buy@25 would hit 1div
    const listings = [
      { priceEx: 20 },
      { priceEx: 20 },
      ...Array.from({ length: 15 }, (_, i) => ({ priceEx: 90 + i * 10 })),
      ...Array.from({ length: 6 }, () => ({ priceEx: 785 })),
      { priceEx: 1570 },
    ];
    // n=23, depth=max(3,floor(23*0.35))=8 → index 7
    const price = estimateBuyPriceEx(listings, 25);
    expect(price).toBeLessThan(400);
    expect(price).toBeGreaterThan(50);
  });

  it("buy uses median on very thin books (not the ask wall)", () => {
    const listings = [{ priceEx: 50 }, { priceEx: 80 }, { priceEx: 900 }];
    // depth = max(3, floor(3*0.35))=3 → index 2 = 900... hmm
    // With only 3 listings, depth=3 picks the max. Prefer lower.
    // Actually floor(3*0.35)=1, max(3,1)=3 → still 900.
    // Need depth to allow going below length when small.
    expect(estimateBuyPriceEx(listings, 25)).toBe(80);
  });

  it("sell undercuts pack below cheapest ≥24h stale anchor", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;
    // Fresh pack under stale ghost: undercut highest ask strictly below anchor
    const price = estimateSellPriceEx(
      [
        { priceEx: 100, indexedAt: new Date(now - hour(1)).toISOString() },
        {
          priceEx: 200,
          indexedAt: new Date(now - dayMs - hour(1)).toISOString(),
        },
        { priceEx: 300, indexedAt: new Date(now - dayMs * 2).toISOString() },
      ],
      { nowMs: now },
    );
    // thin book (<6) → 10% under pack leader 100
    expect(price).toBe(90);
  });

  it("sell undercuts pack under near-floor stale (not ride the stale ask)", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const price = estimateSellPriceEx(
      [
        { priceEx: 100, indexedAt: new Date(now - hour(1)).toISOString() },
        {
          priceEx: 110,
          indexedAt: new Date(now - dayMs - hour(1)).toISOString(),
        },
      ],
      { nowMs: now },
    );
    expect(price).toBe(90);
  });

  it("sell undercuts live floor when no stale listings", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const price = estimateSellPriceEx(
      [
        { priceEx: 100, indexedAt: new Date(now - hour(1)).toISOString() },
        { priceEx: 150, indexedAt: new Date(now - hour(2)).toISOString() },
      ],
      { nowMs: now },
    );
    expect(price).toBe(90);
  });

  it("sell ignores ancient ghosts beyond max stale age", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const price = estimateSellPriceEx(
      [
        {
          priceEx: 785,
          indexedAt: new Date(now - dayMs * 60).toISOString(),
        },
        { priceEx: 120, indexedAt: new Date(now - hour(2)).toISOString() },
      ],
      { nowMs: now },
    );
    expect(price).toBe(108); // live floor × 0.9 (thin)
  });

  it("deep all-stale book undercuts cheapest recently-stale ask", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const listings = Array.from({ length: 8 }, (_, i) => ({
      priceEx: 200 + i * 10,
      indexedAt: new Date(now - dayMs * 2 - hour(i)).toISOString(),
    }));
    // nothing below anchor → shave anchor at 4%
    expect(estimateSellPriceEx(listings, { nowMs: now })).toBe(192);
  });

  it("classifyMarketFlow detects refill as hot", () => {
    const first = Array.from({ length: 12 }, (_, i) => ({
      priceEx: 80 + i,
      currency: "exalted",
      indexedAt: "2026-08-11T10:00:00.000Z",
    }));
    const second = [
      ...first,
      { priceEx: 79, currency: "exalted", indexedAt: "2026-08-11T10:01:00.000Z" },
      { priceEx: 78, currency: "exalted", indexedAt: "2026-08-11T10:01:05.000Z" },
    ];
    expect(classifyMarketFlow(first, second)).toBe("hot");
    expect(classifyMarketFlow(first, first)).toBe("cold");
    expect(buyDepthForRegime("hot", 40)).toBe(10);
    expect(buyDepthForRegime("cold", 40)).toBe(40);
  });

  it("returns null on empty books", () => {
    expect(estimateBuyPriceEx([])).toBeNull();
    expect(estimateSellPriceEx([])).toBeNull();
  });
});

function hour(n: number) {
  return n * 60 * 60 * 1000;
}
