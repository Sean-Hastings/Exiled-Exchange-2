import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "@/web/price-check/tablets/mod-weights";
import { modRollCurveKey } from "@/web/price-check/tablets/mod-roll-price-curve";
import {
  applySabSyncHit,
  buildSabDeepSyncWorklist,
  finalizeDeepSoloSCurves,
  type SabSyncWorkItem,
} from "@/web/price-check/tablets/sab-combo-plan";

describe("tablet-market deep sync", () => {
  it("applySabSyncHit with soloSAnchors defers solo-S opposite-pool expand", () => {
    const market = createEmptyMarketCache();
    const base = TABLET_BASES.temple_tablet!;
    const anchors = new Map<string, { roll: number; sellEx: number }[]>();
    const item: SabSyncWorkItem = {
      kind: "solo",
      modIds: ["temple_crystal_t1"],
      comboKey: "__solo__:temple_crystal_t1",
      prongRoll: 5,
      stats: [{ id: "explicit.stat_1940774881", min: 5, max: 5 }],
    };

    applySabSyncHit(market, "temple_tablet", item, 775, { soloSAnchors: anchors });

    expect(anchors.get("temple_crystal_t1")).toEqual([{ roll: 5, sellEx: 775 }]);
    for (const pId of base.allowedPrefixPool) {
      expect(market.modValueMap[`${pId}+temple_crystal_t1`]).toBeUndefined();
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

  it("deep worklist solo-S prongs integrate with deferred anchor path", () => {
    const plan = buildSabDeepSyncWorklist("temple_tablet");
    const market = createEmptyMarketCache();
    const anchors = new Map<string, { roll: number; sellEx: number }[]>();

    for (const item of plan.filter((w) => w.kind === "solo")) {
      applySabSyncHit(market, "temple_tablet", item, 500 + (item.prongRoll ?? 0), {
        soloSAnchors: anchors,
      });
    }

    expect(anchors.get("temple_crystal_t1")).toHaveLength(3);
    finalizeDeepSoloSCurves(market, "temple_tablet", anchors);
    expect(
      market.modRollCurves?.[modRollCurveKey("temple_tablet", "temple_crystal_t1")],
    ).toBeTruthy();
  });
});
