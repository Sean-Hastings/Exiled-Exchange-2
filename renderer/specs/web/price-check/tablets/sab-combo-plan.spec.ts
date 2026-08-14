import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "@/web/price-check/tablets/mod-weights";
import { modQualityTierForBase } from "@/web/price-check/tablets/mod-tiers";
import { buildTierSaleTable } from "@/web/price-check/tablets/tablet-mdp";
import { modRollCurveKey } from "@/web/price-check/tablets/mod-roll-price-curve";
import type { TabletModDefinition } from "@/web/price-check/tablets/tablet-types";
import {
  applySabSyncHit,
  buildSabSyncWorklist,
  enumerateSabCombos,
  finalizeSoloSCurve,
  sabModsForBase,
  soloProngComboKey,
  type SabSyncWorkItem,
} from "@/web/price-check/tablets/sab-combo-plan";

function fakeMod(
  partial: Pick<
    TabletModDefinition,
    "id" | "tradeStatId" | "isPrefix" | "minValue" | "tier"
  > &
    Partial<TabletModDefinition>,
): TabletModDefinition {
  return {
    name: partial.id,
    statPattern: /x/,
    weight: 100,
    maxValue: (partial.minValue ?? 1) + 5,
    category: "Temple",
    valueScore: 50,
    regexHint: "x",
    ...partial,
  };
}

describe("sab-combo-plan", () => {
  it("enumerates solos/duos/triples/quad for 1S+1A+2B mix without junk", () => {
    // 2p + 2s → legal 2+2 quad; no Junk ids
    const M = [
      fakeMod({
        id: "fake_a_prefix",
        tradeStatId: "explicit.stat_111",
        isPrefix: true,
        minValue: 10,
        tier: 1,
      }),
      fakeMod({
        id: "fake_b_prefix",
        tradeStatId: "explicit.stat_222",
        isPrefix: true,
        minValue: 5,
        tier: 1,
      }),
      fakeMod({
        id: "fake_s_suffix",
        tradeStatId: "explicit.stat_333",
        isPrefix: false,
        minValue: 5,
        tier: 1,
      }),
      fakeMod({
        id: "fake_b_suffix",
        tradeStatId: "explicit.stat_444",
        isPrefix: false,
        minValue: 8,
        tier: 1,
      }),
    ];

    const plan = enumerateSabCombos(M, 40);
    const solos = plan.filter((w) => w.kind === "solo");
    const duos = plan.filter((w) => w.kind === "duo");
    const triples = plan.filter((w) => w.kind === "triple");
    const quads = plan.filter((w) => w.kind === "quad");

    expect(solos).toHaveLength(4);
    // cross 2×2=4 + pp 1 + ss 1 = 6
    expect(duos).toHaveLength(6);
    // 2p1s ×2 + 1p2s ×2 = 4
    expect(triples).toHaveLength(4);
    expect(quads).toHaveLength(1);
    expect(plan).toHaveLength(15);

    for (const item of plan) {
      for (const id of item.modIds) {
        expect(id).not.toMatch(/junk/i);
        expect(id.startsWith("fake_")).toBe(true);
      }
    }
  });

  it("temple worklist has no Junk-quality mods and collapses pack tiers", () => {
    const M = sabModsForBase("temple_tablet");
    expect(M.some((m) => m.id === "temple_crystal_t1")).toBe(true);
    // pack_t1 preferred over pack_t2 (higher min)
    expect(M.some((m) => m.id === "map_pack_size_t1")).toBe(true);
    expect(M.some((m) => m.id === "map_pack_size_t2")).toBe(false);
    for (const m of M) {
      expect(modQualityTierForBase("temple_tablet", m.id)).not.toBe("Junk");
    }

    const plan = buildSabSyncWorklist("temple_tablet", 40);
    expect(plan.length).toBeGreaterThan(10);
    expect(plan.length).toBeLessThanOrEqual(40);
    for (const item of plan) {
      for (const id of item.modIds) {
        expect(modQualityTierForBase("temple_tablet", id)).not.toBe("Junk");
      }
    }
  });

  it("solo S crystal worklist emits 3 exact-roll prongs", () => {
    const plan = buildSabSyncWorklist("temple_tablet", 40);
    const crystalProngs = plan
      .filter(
        (w) =>
          w.kind === "solo" &&
          w.modIds[0] === "temple_crystal_t1" &&
          w.prongRoll != null,
      )
      .sort((a, b) => (a.prongRoll ?? 0) - (b.prongRoll ?? 0));
    expect(crystalProngs.map((w) => w.prongRoll)).toEqual([5, 7, 10]);
    expect(crystalProngs.map((w) => w.comboKey)).toEqual([
      soloProngComboKey("temple_crystal_t1", 5),
      soloProngComboKey("temple_crystal_t1", 7),
      soloProngComboKey("temple_crystal_t1", 10),
    ]);
    for (const w of crystalProngs) {
      expect(w.stats).toEqual([
        {
          id: "explicit.stat_1940774881",
          min: w.prongRoll,
          max: w.prongRoll,
        },
      ]);
    }
    // Flat solo key no longer emitted for rollable S
    expect(plan.some((w) => w.comboKey === "__solo__:temple_crystal_t1")).toBe(
      false,
    );
  });

  it("solo S expands onto all prefix+S keys", () => {
    const market = createEmptyMarketCache();
    const base = TABLET_BASES.temple_tablet!;
    const item: SabSyncWorkItem = {
      kind: "solo",
      modIds: ["temple_crystal_t1"],
      comboKey: "__solo__:temple_crystal_t1",
      stats: [{ id: "explicit.stat_1940774881", min: 5 }],
    };
    applySabSyncHit(market, "temple_tablet", item, 900);

    for (const pId of base.allowedPrefixPool) {
      expect(market.modValueMap[`${pId}+temple_crystal_t1`]).toBe(900);
      expect(market.priceSource?.modValueMap?.[`${pId}+temple_crystal_t1`]).toBe(
        "measured",
      );
    }
    // Does not leave a measuredAffixSamples entry for solo S
    expect(
      market.measuredAffixSamples?.some((s) =>
        s.modIds.includes("temple_crystal_t1"),
      ),
    ).toBeFalsy();
  });

  it("finalizeSoloSCurve stores curve and expands with E[p], not min prong", () => {
    const market = createEmptyMarketCache();
    const base = TABLET_BASES.temple_tablet!;
    const mod = TABLET_MOD_WEIGHTS.temple_crystal_t1!;
    const ok = finalizeSoloSCurve(market, "temple_tablet", mod, [
      { roll: 5, sellEx: 775 },
      { roll: 7, sellEx: 950 },
      { roll: 10, sellEx: 2100 },
    ]);
    expect(ok).toBe(true);
    const key = modRollCurveKey("temple_tablet", "temple_crystal_t1");
    const curve = market.modRollCurves?.[key];
    expect(curve).toBeTruthy();
    expect(curve!.expectedSellEx).toBeGreaterThan(900);
    expect(curve!.expectedSellEx).not.toBe(775);
    for (const pId of base.allowedPrefixPool) {
      expect(market.modValueMap[`${pId}+temple_crystal_t1`]).toBe(
        curve!.expectedSellEx,
      );
      expect(market.priceSource?.modValueMap?.[`${pId}+temple_crystal_t1`]).toBe(
        "measured",
      );
    }
  });

  it("buildTierSaleTable picks up measuredAffixSamples for same-side duo", () => {
    const market = createEmptyMarketCache();
    market.basePrices.temple_tablet = 100;
    market.junkSellByBase = { temple_tablet: 60 };
    market.currencyCosts.alchemy = 0.05;
    market.currencyCosts.chaos = 45;
    market.currencyCosts.vaal = 0.4;
    market.currencyCosts.transmute = 0.01;
    market.currencyCosts.augmentation = 0.02;
    market.currencyCosts.regal = 0.15;
    // Same-side B+B prefixes — not on 1p1s grid
    market.measuredAffixSamples = [
      {
        baseId: "temple_tablet",
        modIds: ["junk_monster_eff_t1", "map_pack_size_t1"].sort(),
        sellEx: 250,
      },
    ];

    const sales = buildTierSaleTable(market, "temple_tablet")!;
    // B|B → rare B; low-end should see the sample (250) rather than only dump cascade
    expect(sales.uncorrupted.B).toBeLessThanOrEqual(250);
    expect(sales.uncorrupted.B).toBeGreaterThan(0);
    // Sample is the only measured B sale → low-end = 250 (unless monotone pull-down)
    expect(
      sales.uncorrupted.B === 250 || sales.uncorrupted.B === sales.uncorrupted.A,
    ).toBe(true);
  });
});
