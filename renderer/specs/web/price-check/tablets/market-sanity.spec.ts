import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import {
  dumpFloorEx,
  dumpFloorInfo,
  fallbackPriceTag,
  isFallbackPriceSource,
} from "@/web/price-check/tablets/market-sanity";
import { applyTempleManualSurveyMarket } from "@/web/price-check/tablets/temple-manual-market";

describe("dumpFloorInfo", () => {
  it("uses live junk as measured when no source stamp", () => {
    const market = createEmptyMarketCache();
    market.junkSellByBase = { breach_tablet: 25 };
    const info = dumpFloorInfo(market, "breach_tablet");
    expect(info.value).toBe(25);
    expect(info.source).toBe("measured");
    expect(isFallbackPriceSource(info.source)).toBe(false);
    expect(dumpFloorEx(market, "breach_tablet")).toBe(25);
  });

  it("falls back to 20% of blank when no junk sample", () => {
    const market = createEmptyMarketCache();
    market.basePrices.breach_tablet = 60;
    const info = dumpFloorInfo(market, "breach_tablet");
    expect(info.value).toBeCloseTo(12, 8);
    expect(info.source).toBe("fraction-of-base");
    expect(fallbackPriceTag(info.source)).toBe("20% blank");
    expect(dumpFloorEx(market, "breach_tablet")).toBeCloseTo(12, 8);
  });

  it("stamps temple survey dump after overlay", () => {
    const market = applyTempleManualSurveyMarket(createEmptyMarketCache());
    const info = dumpFloorInfo(market, "temple_tablet");
    expect(info.value).toBe(60);
    expect(info.source).toBe("manual-survey");
    expect(fallbackPriceTag(info.source)).toBe("survey");
  });

  it("returns NaN measured when nothing is known", () => {
    const market = createEmptyMarketCache();
    const info = dumpFloorInfo(market, "breach_tablet");
    expect(Number.isNaN(info.value)).toBe(true);
    expect(info.source).toBe("measured");
    expect(isFallbackPriceSource(info.source)).toBe(false);
  });
});
