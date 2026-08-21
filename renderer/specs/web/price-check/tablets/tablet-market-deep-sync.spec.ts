import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "@/web/price-check/tablets/mod-weights";
import { modRollCurveKey } from "@/web/price-check/tablets/mod-roll-price-curve";
import {
  applySabSyncHit,
  buildSabDeepSyncWorklist,
  expandSoloSAOppositePool,
  finalizeDeepSoloSCurves,
  type SabSyncWorkItem,
} from "@/web/price-check/tablets/sab-combo-plan";

describe("tablet-market deep sync", () => {
  it("applySabSyncHit expands solo S/A immediately (no deferred anchors)", () => {
    const market = createEmptyMarketCache();
    const base = TABLET_BASES.temple_tablet!;
    const item: SabSyncWorkItem = {
      kind: "solo",
      modIds: ["temple_crystal_t1"],
      comboKey: "__solo__:temple_crystal_t1",
      prongRoll: 8,
      stats: [{ id: "explicit.stat_1940774881", min: 8, max: 8 }],
    };

    applySabSyncHit(market, "temple_tablet", item, 900);

    for (const pId of base.allowedPrefixPool) {
      expect(market.modValueMap[`${pId}+temple_crystal_t1`]).toBe(900);
    }
  });

  it("expandSoloSAOppositePool does not clobber existing pair stamps", () => {
    const market = createEmptyMarketCache();
    const base = TABLET_BASES.temple_tablet!;
    const packKey = "map_pack_size_t1+temple_crystal_t1";
    market.modValueMap[packKey] = 2500;

    const crystal = TABLET_MOD_WEIGHTS.temple_crystal_t1!;
    expandSoloSAOppositePool(market, "temple_tablet", crystal, 900);

    expect(market.modValueMap[packKey]).toBe(2500);
    for (const pId of base.allowedPrefixPool) {
      const key = `${pId}+temple_crystal_t1`;
      if (key === packKey) continue;
      expect(market.modValueMap[key]).toBe(900);
    }
  });

  it("finalizeDeepSoloSCurves fits roll curve and expands with E[p]", () => {
    const market = createEmptyMarketCache();
    const base = TABLET_BASES.temple_tablet!;
    const anchors = new Map([
      [
        "temple_crystal_t1",
        [
          { roll: 5, sellEx: 775 },
          { roll: 7, sellEx: 950 },
          { roll: 10, sellEx: 2100 },
        ],
      ],
    ]);

    finalizeDeepSoloSCurves(market, "temple_tablet", anchors);

    const key = modRollCurveKey("temple_tablet", "temple_crystal_t1");
    const curve = market.modRollCurves?.[key];
    expect(curve).toBeTruthy();
    expect(curve!.expectedSellEx).toBeGreaterThan(900);
    for (const pId of base.allowedPrefixPool) {
      expect(market.modValueMap[`${pId}+temple_crystal_t1`]).toBe(
        curve!.expectedSellEx,
      );
    }
  });

  it("finalizeDeepSoloSCurves flat-expands best prong when curve fit fails", () => {
    const market = createEmptyMarketCache();
    const base = TABLET_BASES.temple_tablet!;
    const anchors = new Map([
      ["temple_crystal_t1", [{ roll: 5, sellEx: 800 }]],
    ]);

    finalizeDeepSoloSCurves(market, "temple_tablet", anchors);

    expect(market.modRollCurves?.[modRollCurveKey("temple_tablet", "temple_crystal_t1")]).toBeUndefined();
    for (const pId of base.allowedPrefixPool) {
      expect(market.modValueMap[`${pId}+temple_crystal_t1`]).toBe(800);
    }
  });

  it("deep worklist solos apply immediately without multi-prong deferral", () => {
    const plan = buildSabDeepSyncWorklist("temple_tablet");
    const market = createEmptyMarketCache();
    const crystalSolos = plan.filter(
      (w) => w.kind === "solo" && w.modIds[0] === "temple_crystal_t1",
    );
    expect(crystalSolos).toHaveLength(1);
    expect(crystalSolos[0]!.prongRoll).toBe(8);

    applySabSyncHit(market, "temple_tablet", crystalSolos[0]!, 900);
    expect(
      market.modValueMap["map_pack_size_t1+temple_crystal_t1"],
    ).toBe(900);
  });
});
