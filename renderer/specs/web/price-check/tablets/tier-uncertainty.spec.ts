import { describe, expect, it, beforeEach } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import {
  clearSessionModTiers,
  hasExplicitTier,
  setSessionModTier,
} from "@/web/price-check/tablets/mod-tiers";
import {
  compareTierUncertaintyRows,
  rankTierUncertainty,
  saleTouching,
  tierUncertaintyScore,
  type TierUncertaintyRow,
} from "@/web/price-check/tablets/tier-uncertainty";
import type { TierSurveyDocument } from "@/web/price-check/tablets/tier-survey-types";
import { TIER_SURVEY_REVISION } from "@/web/price-check/tablets/tier-survey-types";

describe("tier-uncertainty", () => {
  beforeEach(() => {
    clearSessionModTiers();
  });

  it("hasExplicitTier is true for per-base map entries", () => {
    expect(hasExplicitTier("temple_crystal_t1", "temple_tablet")).toBe(
      true,
    );
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
      "temple_tablet",
    );
    expect(crystal.reasons.noExplicitTier).toBe(false);
    expect(crystal.reasons.notSaleTouching).toBe(false);
    expect(crystal.reasons.noAutoSurvey).toBe(false);
    expect(crystal.score).toBeLessThan(score);
  });

  it("session set tier reduces ranking uncertainty", () => {
    const market = createEmptyMarketCache();
    // Sealed Breach pool has explicit tags on every pool mod — exercise session
    // overlay on an unmapped id (same score path the panel uses).
    const fake = "totally_fake_mod_id_for_session";
    const before = tierUncertaintyScore(fake, market, null, "breach_tablet");
    expect(before.reasons.noExplicitTier).toBe(true);
    setSessionModTier("breach_tablet", fake, "B");
    const after = tierUncertaintyScore(fake, market, null, "breach_tablet");
    expect(after.score).toBeLessThan(before.score);
    expect(after.reasons.noExplicitTier).toBe(false);

    // Live pool rows are sealed; session still overrides displayed tier
    const ranked = rankTierUncertainty("breach_tablet", market, null);
    expect(ranked.every((r) => !r.reasons.noExplicitTier)).toBe(true);
    const hive = ranked.find((r) => r.modId === "breach_hiveblood_t1")!;
    expect(hive.tier).toBe("S");
    setSessionModTier("breach_tablet", "breach_hiveblood_t1", "B");
    const ranked2 = rankTierUncertainty("breach_tablet", market, null);
    expect(
      ranked2.find((r) => r.modId === "breach_hiveblood_t1")!.tier,
    ).toBe("B");
  });

  describe("compareTierUncertaintyRows / panel sort", () => {
    const baseRow = (
      overrides: Partial<TierUncertaintyRow> & Pick<TierUncertaintyRow, "modId">,
    ): TierUncertaintyRow => ({
      name: overrides.modId,
      side: "suffix",
      tier: "B",
      score: 3,
      reasons: {
        noExplicitTier: false,
        notSaleTouching: true,
        valueScoreFallback: false,
        noAutoSurvey: true,
      },
      isMarked: false,
      ...overrides,
    });

    it("marked rows sort before unmarked despite lower score", () => {
      const marked = baseRow({
        modId: "marked_low",
        score: 0,
        isMarked: true,
        tier: "B",
      });
      const unmarked = baseRow({
        modId: "unmarked_high",
        score: 6,
        isMarked: false,
      });
      expect(compareTierUncertaintyRows(marked, unmarked)).toBeLessThan(0);

      const market = createEmptyMarketCache();
      setSessionModTier("breach_tablet", "breach_hiveblood_t1", "B");
      const ranked = rankTierUncertainty("breach_tablet", market, null);
      const hiveIdx = ranked.findIndex((r) => r.modId === "breach_hiveblood_t1");
      expect(hiveIdx).toBe(0);
      expect(ranked[hiveIdx]!.isMarked).toBe(true);
    });

    it("within marked rows sorts tier high to low (S > A > B > Junk)", () => {
      const s = baseRow({ modId: "mod_s", isMarked: true, tier: "S", score: 0 });
      const a = baseRow({ modId: "mod_a", isMarked: true, tier: "A", score: 0 });
      const b = baseRow({ modId: "mod_b", isMarked: true, tier: "B", score: 0 });
      const junk = baseRow({
        modId: "mod_junk",
        isMarked: true,
        tier: "Junk",
        score: 0,
      });
      const sorted = [junk, b, a, s].sort(compareTierUncertaintyRows);
      expect(sorted.map((r) => r.tier)).toEqual(["S", "A", "B", "Junk"]);

      const market = createEmptyMarketCache();
      setSessionModTier("breach_tablet", "breach_hiveblood_t1", "B");
      setSessionModTier("breach_tablet", "breach_unstable_rare_t1", "S");
      const ranked = rankTierUncertainty("breach_tablet", market, null);
      const marked = ranked.filter((r) => r.isMarked);
      expect(marked.map((r) => r.modId)).toEqual([
        "breach_unstable_rare_t1",
        "breach_hiveblood_t1",
      ]);
    });

    it("score-0 rows stay in the ranked list (panel shows full pool)", () => {
      const market = createEmptyMarketCache();
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
      // Unmarked but fully certain (explicit + sale + survey)
      const crystalScore = tierUncertaintyScore(
        "temple_crystal_t1",
        market,
        survey,
        "temple_tablet",
      );
      expect(crystalScore.score).toBe(0);

      const ranked = rankTierUncertainty("temple_tablet", market, survey);
      const crystal = ranked.find((r) => r.modId === "temple_crystal_t1")!;
      expect(crystal.isMarked).toBe(false);
      expect(crystal.score).toBe(0);
      // Panel uses full ranked list — no score>0 filter
      expect(ranked.some((r) => r.modId === "temple_crystal_t1")).toBe(true);
      const last = ranked[ranked.length - 1]!;
      expect(last.score).toBeLessThanOrEqual(ranked[0]!.score);
    });

    it("unmarked rows still sort by score descending", () => {
      const high = baseRow({ modId: "high", score: 6, isMarked: false });
      const mid = baseRow({ modId: "mid", score: 3, isMarked: false });
      const low = baseRow({ modId: "low", score: 1, isMarked: false });
      const sorted = [low, mid, high].sort(compareTierUncertaintyRows);
      expect(sorted.map((r) => r.score)).toEqual([6, 3, 1]);

      const market = createEmptyMarketCache();
      const ranked = rankTierUncertainty("breach_tablet", market, null);
      const unmarked = ranked.filter((r) => !r.isMarked);
      for (let i = 1; i < unmarked.length; i++) {
        expect(unmarked[i - 1]!.score).toBeGreaterThanOrEqual(unmarked[i]!.score);
      }
    });
  });
});
