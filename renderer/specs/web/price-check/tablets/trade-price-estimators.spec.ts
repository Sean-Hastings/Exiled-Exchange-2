import { describe, expect, it } from "vitest";
import {
  BUY_DEPTH_N,
  buyDepthForRegime,
  buyMeanEstimateNote,
  classifyMarketFlow,
  effectiveBuyCountForRegime,
  estimateBuyPriceEx,
  estimateBuyPriceMeanOfCheapestEx,
  estimateSellPriceEx,
  filterBuyListings,
  filterDustBuyListings,
  listingAmountToExalt,
  sellEstimateNote,
  SELL_THIN_PACK_BEFORE,
  SELL_UNDERCUT_PCT,
  SELL_UNDERCUT_THIN_PCT,
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
    const listings = [
      ...Array.from({ length: 60 }, (_, i) => ({ priceEx: 80 + i })),
      { priceEx: 120_000_000 },
    ];
    const kept = filterBuyListings(listings);
    expect(estimateBuyPriceEx(kept, 25)).toBe(104);
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

  it("legacy buy uses nth cheapest when book is deep (after conversion)", () => {
    const listings = [
      { priceEx: listingAmountToExalt(1, "chaos", fx)! },
      { priceEx: listingAmountToExalt(50, "exalted", fx)! },
      ...Array.from({ length: 60 }, (_, i) => ({
        priceEx: 60 + i,
      })),
    ];
    expect(estimateBuyPriceEx(listings, 25)).toBe(82);
    expect(estimateBuyPriceEx(listings, 10)).toBe(67);
  });

  it("legacy buy keeps ~35% depth on thin converted books", () => {
    const listings = [
      { priceEx: 20 },
      { priceEx: 20 },
      ...Array.from({ length: 15 }, (_, i) => ({ priceEx: 90 + i * 10 })),
      ...Array.from({ length: 6 }, () => ({ priceEx: 785 })),
      { priceEx: 1570 },
    ];
    const price = estimateBuyPriceEx(listings, 25);
    expect(price).toBeLessThan(400);
    expect(price).toBeGreaterThan(50);
  });

  it("buy uses median on very thin books (not the ask wall)", () => {
    const listings = [{ priceEx: 50 }, { priceEx: 80 }, { priceEx: 900 }];
    expect(estimateBuyPriceEx(listings, 25)).toBe(80);
    expect(estimateBuyPriceMeanOfCheapestEx(listings, 25)).toBe(80);
  });

  it("mean-of-B averages cheapest B asks on deep books", () => {
    const listings = Array.from({ length: 60 }, (_, i) => ({
      priceEx: 100 + i,
    }));
    // cheapest 10: 100..109 → mean 104.5
    expect(estimateBuyPriceMeanOfCheapestEx(listings, 10)).toBeCloseTo(104.5);
    // cheapest 25: 100..124 → mean 112
    expect(estimateBuyPriceMeanOfCheapestEx(listings, 25)).toBeCloseTo(112);
  });

  it("mean-of-B mid-book 6–49 uses mean of all when n < B (no 35%)", () => {
    // 20 listings, B=25 → mean of all 20
    const listings = Array.from({ length: 20 }, (_, i) => ({
      priceEx: 10 + i,
    }));
    const mean = listings.reduce((s, l) => s + l.priceEx, 0) / 20;
    expect(estimateBuyPriceMeanOfCheapestEx(listings, 25)).toBeCloseTo(mean);
    // Must not match legacy 35% depth pick
    const legacy = estimateBuyPriceEx(listings, 25);
    expect(estimateBuyPriceMeanOfCheapestEx(listings, 25)).not.toBe(legacy);
  });

  it("mean-of-B covers 6–49 listing books without 35% heuristic", () => {
    for (const n of [6, 10, 15, 29, 35, 49]) {
      const listings = Array.from({ length: n }, (_, i) => ({
        priceEx: 50 + i * 2,
      }));
      const B = 25;
      const k = Math.min(B, n);
      const expected =
        listings.slice(0, k).reduce((s, l) => s + l.priceEx, 0) / k;
      expect(estimateBuyPriceMeanOfCheapestEx(listings, B)).toBeCloseTo(
        expected,
      );
      // note must not mention p~35%
      expect(buyMeanEstimateNote(n, B, "cold")).not.toMatch(/35%/);
    }
  });

  it("regime → effective B: hot min(B,10), cold B, warm/unknown min(B,25)", () => {
    expect(effectiveBuyCountForRegime("hot", 40)).toBe(10);
    expect(effectiveBuyCountForRegime("hot", 8)).toBe(8);
    expect(effectiveBuyCountForRegime("cold", 40)).toBe(40);
    expect(effectiveBuyCountForRegime("unknown", 40)).toBe(25);
    expect(effectiveBuyCountForRegime("unknown", 20)).toBe(20);
    expect(buyMeanEstimateNote(80, 40, "hot")).toMatch(/mean@hot10|mean@min\(B,10\)/);
    expect(buyMeanEstimateNote(80, 40, "cold")).toBe("mean@B");
    expect(buyMeanEstimateNote(80, 40, "unknown")).toMatch(
      /mean@warm25|mean@min\(B,25\)/,
    );
    expect(buyMeanEstimateNote(80, 40, undefined)).toMatch(
      /mean@warm25|mean@min\(B,25\)/,
    );
  });

  it("sell 24h with ≥9 below uses 3% closest-under only", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const below = Array.from({ length: 9 }, (_, i) => ({
      priceEx: 100 + i,
      indexedAt: new Date(now - hour(1)).toISOString(),
    }));
    const listings = [
      ...below,
      { priceEx: 1000, indexedAt: new Date(now - dayMs() - hour(1)).toISOString() },
    ];
    const price = estimateSellPriceEx(listings, { nowMs: now });
    expect(price).toBeCloseTo(108 * 0.97);
    expect(sellEstimateNote(listings, { nowMs: now })).toMatch(/3% closest-under/);
    expect(SELL_THIN_PACK_BEFORE).toBe(9);
    expect(SELL_UNDERCUT_PCT).toBe(0.03);
  });

  it("sell 24h with 1 below (thin) is max(3% pack, 10% stale)", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const listings = [
      { priceEx: 100, indexedAt: new Date(now - hour(1)).toISOString() },
      {
        priceEx: 200,
        indexedAt: new Date(now - dayMs() - hour(1)).toISOString(),
      },
    ];
    const price = estimateSellPriceEx(listings, { nowMs: now });
    expect(price).toBeCloseTo(Math.max(100 * 0.97, 200 * 0.9));
    expect(sellEstimateNote(listings, { nowMs: now })).toMatch(/max\(3% pack, 10% stale\)/);
  });

  it("sell 24h with 0 below is 10% stale-anchor", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const listings = [
      {
        priceEx: 200,
        indexedAt: new Date(now - dayMs() * 2).toISOString(),
      },
      {
        priceEx: 300,
        indexedAt: new Date(now - dayMs() * 2).toISOString(),
      },
    ];
    expect(estimateSellPriceEx(listings, { nowMs: now })).toBeCloseTo(180);
    expect(sellEstimateNote(listings, { nowMs: now })).toMatch(/10% stale-anchor/);
    expect(SELL_UNDERCUT_THIN_PCT).toBe(0.1);
  });

  it("sell with no 24h listing uses 3% of window-max (not cheapest)", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const listings = [
      { priceEx: 100, indexedAt: new Date(now - hour(1)).toISOString() },
      { priceEx: 150, indexedAt: new Date(now - hour(2)).toISOString() },
    ];
    expect(estimateSellPriceEx(listings, { nowMs: now })).toBeCloseTo(150 * 0.97);
    expect(sellEstimateNote(listings, { nowMs: now })).toMatch(/3% window-max/);
    expect(sellEstimateNote(listings, { nowMs: now })).not.toMatch(/stale/);
  });

  it("sell treats 60-day cheap Instant Buyout as a valid stale (not ignored)", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const listings = [
      {
        priceEx: 785,
        indexedAt: new Date(now - dayMs() * 60).toISOString(),
      },
      { priceEx: 120, indexedAt: new Date(now - hour(2)).toISOString() },
    ];
    // If 14-day ghost cap still applied this would undercut the fresh 120 only.
    expect(estimateSellPriceEx(listings, { nowMs: now })).toBeCloseTo(
      Math.max(120 * 0.97, 785 * 0.9),
    );
  });

  it("crystal-dump-like: 1×337 fresh + 19×1000 fresh → 1000×0.97", () => {
    const listings = [
      { priceEx: 337 },
      ...Array.from({ length: 19 }, () => ({ priceEx: 1000 })),
    ];
    expect(estimateSellPriceEx(listings)).toBeCloseTo(970);
    expect(sellEstimateNote(listings)).toMatch(/3% window-max/);
  });

  it("thin 1-div + 24h 1000 → max(337×0.97, 1000×0.90) = 900", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const listings = [
      { priceEx: 337, indexedAt: new Date(now - hour(1)).toISOString() },
      {
        priceEx: 1000,
        indexedAt: new Date(now - dayMs() - hour(1)).toISOString(),
      },
    ];
    expect(estimateSellPriceEx(listings, { nowMs: now })).toBeCloseTo(900);
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
    expect(estimateBuyPriceMeanOfCheapestEx([], 25)).toBeNull();
    expect(estimateSellPriceEx([])).toBeNull();
  });

  it("BUY_DEPTH_N remains 25", () => {
    expect(BUY_DEPTH_N).toBe(25);
  });
});

function hour(n: number) {
  return n * 60 * 60 * 1000;
}

function dayMs() {
  return 24 * 60 * 60 * 1000;
}
