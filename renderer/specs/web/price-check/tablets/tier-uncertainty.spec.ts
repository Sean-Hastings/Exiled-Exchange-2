import { describe, expect, it, beforeEach } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import {
  clearSessionModTiers,
  hasExplicitTier,
  setSessionModTier,
} from "@/web/price-check/tablets/mod-tiers";
import {
  rankTierUncertainty,
  saleTouching,
  tierUncertaintyScore,
} from "@/web/price-check/tablets/tier-uncertainty";
import type { TierSurveyDocument } from "@/web/price-check/tablets/tier-survey-types";
import { TIER_SURVEY_REVISION } from "@/web/price-check/tablets/tier-survey-types";

describe("tier-uncertainty", () => {
  beforeEach(() => {
    clearSessionModTiers();
  });

  it("hasExplicitTier is true for EXPLICIT map entries", () => {
    expect(hasExplicitTier("temple_crystal_t1")).toBe(true);
    expect(hasExplicitTier("this_mod_does_not_exist_xyz")).toBe(false);
  });

  it("saleTouching matches '+' tokens only (no fuzzy)", () => {
    const market = createEmptyMarketCache();
    market.modValueMap["breach_rare_potency_t1+breach_unstable_rare_t1"] = 300;
    expect(saleTouching("breach_rare_potency_t1", market)).toBe(true);
    expect(saleTouching("breach_unstable_rare_t1", market)).toBe(true);
    expect(saleTouching("breach_rare", market)).toBe(false);
    expect(saleTouching("potency_t1", market)).toBe(false);
  });

  it("saleTouching scoped by base pools ignores foreign combos", () => {
    const market = createEmptyMarketCache();
    // Shared-looking key that is not entirely in breach pools (temple crystal)
    market.modValueMap["map_pack_size_t1+temple_crystal_t1"] = 500;
    expect(saleTouching("map_pack_size_t1", market)).toBe(true);
    expect(saleTouching("map_pack_size_t1", market, "breach_tablet")).toBe(
      false,
    );
    market.modValueMap["breach_rare_potency_t1+breach_unstable_rare_t1"] = 300;
    expect(
      saleTouching("breach_rare_potency_t1", market, "breach_tablet"),
    ).toBe(true);
  });

  it("ranking formula weights match §3.8 indicators", () => {
    const market = createEmptyMarketCache();
    // No sales, no survey → max score for unmapped mod
    const unmapped = "totally_fake_mod_id_for_test";
    const { score, reasons } = tierUncertaintyScore(unmapped, market, null);
    expect(reasons.noExplicitTier).toBe(true);
    expect(reasons.notSaleTouching).toBe(true);
    expect(reasons.valueScoreFallback).toBe(true);
    expect(reasons.noAutoSurvey).toBe(true);
    expect(score).toBe(2 + 2 + 1 + 1);

    // Explicit temple crystal with a sale touch
    market.modValueMap["map_pack_size_t2+temple_crystal_t1"] = 700;
    const survey: TierSurveyDocument = {
      revision: TIER_SURVEY_REVISION,
      baseId: "temple_tablet",
      baseName: "Temple Tablet",
      leagueId: "test",
      status: "complete",
      queue: [],
      observations: {
        "single:temple_crystal_t1": {
          key: "single:temple_crystal_t1",
          kind: "single",
          label: "crystal",
          modIds: ["temple_crystal_t1"],
          sellEx: 700,
          octave: null,
          octaveRound: null,
          updatedAt: 1,
        },
      },
      startedAt: 1,
      updatedAt: 1,
      fx: { exaltPerChaos: 45, exaltPerDivine: 350 },
      anchors: { dumpEx: 50, blankBuyEx: 100 },
      followUpsGenerated: false,
    };
    const crystal = tierUncertaintyScore(
      "temple_crystal_t1",
      market,
      survey,
    );
    expect(crystal.reasons.noExplicitTier).toBe(false);
    expect(crystal.reasons.notSaleTouching).toBe(false);
    expect(crystal.reasons.noAutoSurvey).toBe(false);
    expect(crystal.score).toBeLessThan(score);
  });

  it("session set tier reduces ranking uncertainty", () => {
    const market = createEmptyMarketCache();
    const before = rankTierUncertainty("temple_tablet", market, null);
    const target = before.find((r) => !hasExplicitTier(r.modId));
    expect(target).toBeTruthy();
    const scoreBefore = target!.score;
    setSessionModTier(target!.modId, "B");
    const after = rankTierUncertainty("temple_tablet", market, null);
    const row = after.find((r) => r.modId === target!.modId)!;
    expect(row.score).toBeLessThan(scoreBefore);
    expect(row.tier).toBe("B");
  });
});
