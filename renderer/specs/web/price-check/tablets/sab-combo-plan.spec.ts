import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "@/web/price-check/tablets/mod-weights";
import {
  classifyModCombo,
  modQualityTierForBase,
} from "@/web/price-check/tablets/mod-tiers";
import { buildTierSaleTable } from "@/web/price-check/tablets/tablet-mdp";
import { modRollCurveKey } from "@/web/price-check/tablets/mod-roll-price-curve";
import {
  applySabSyncHit,
  buildSabDeepSyncWorklist,
  buildSabSyncWorklist,
  collapseModsByTradeStat,
  enumerateSabCombos,
  finalizeDeepSoloSCurves,
  finalizeSoloSCurve,
  sabModsForBase,
  type SabSyncWorkItem,
} from "@/web/price-check/tablets/sab-combo-plan";
import type { TabletModDefinition } from "@/web/price-check/tablets/tablet-types";
import type { ModQualityTier } from "@/web/price-check/tablets/strat-types";

function allBQuality(modIds: string[], baseId: string): boolean {
  return (
    modIds.length > 0 &&
    modIds.every((id) => modQualityTierForBase(baseId, id) === "B")
  );
}

function qualitiesOf(modIds: string[], baseId: string): ModQualityTier[] {
  return modIds.map((id) => modQualityTierForBase(baseId, id));
}

function duoPairKind(
  qs: ModQualityTier[],
): "SS" | "SA" | "AA" | "SB" | "AB" | "BB" | "other" {
  if (qs.length !== 2) return "other";
  const nS = qs.filter((q) => q === "S").length;
  const nA = qs.filter((q) => q === "A").length;
  const nB = qs.filter((q) => q === "B").length;
  if (nS === 2) return "SS";
  if (nS === 1 && nA === 1) return "SA";
  if (nA === 2) return "AA";
  if (nS === 1 && nB === 1) return "SB";
  if (nA === 1 && nB === 1) return "AB";
  if (nB === 2) return "BB";
  return "other";
}

function fitsAffixCaps(mods: TabletModDefinition[]): boolean {
  let p = 0;
  let s = 0;
  for (const m of mods) {
    if (m.isPrefix) p++;
    else s++;
  }
  return p <= 2 && s <= 2;
}

function tradeLegalCombo(mods: TabletModDefinition[]): boolean {
  if (!mods.length || !fitsAffixCaps(mods)) return false;
  return collapseModsByTradeStat(mods).length === mods.length;
}

function combinations<T>(arr: T[], k: number): T[][] {
  if (k <= 0 || k > arr.length) return [];
  if (k === 1) return arr.map((x) => [x]);
  const out: T[][] = [];
  for (let i = 0; i <= arr.length - k; i++) {
    for (const rest of combinations(arr.slice(i + 1), k - 1)) {
      out.push([arr[i]!, ...rest]);
    }
  }
  return out;
}

/**
 * Reconstruct sell-combo counts from S/A/B (Junk excluded).
 * Live worklist is afterSbDrop; previous/A keep AB/SB for pinned history.
 */
function sellComboCensus(baseId: string, safetyMax = 40) {
  const base = TABLET_BASES[baseId];
  const ids = base
    ? [...base.allowedPrefixPool, ...base.allowedSuffixPool]
    : [];
  const raw: TabletModDefinition[] = [];
  for (const id of ids) {
    const m = TABLET_MOD_WEIGHTS[id];
    if (!m) continue;
    const q = modQualityTierForBase(baseId, m.id);
    if (q === "Junk") continue;
    raw.push(m);
  }
  const M = collapseModsByTradeStat(raw);
  const sMods = M.filter((m) => modQualityTierForBase(baseId, m.id) === "S");
  const aMods = M.filter((m) => modQualityTierForBase(baseId, m.id) === "A");
  const bMods = M.filter((m) => modQualityTierForBase(baseId, m.id) === "B");

  const solos = [...sMods, ...aMods].filter((m) => tradeLegalCombo([m])).length;

  let ssSaAa = 0;
  let sb = 0;
  let ab = 0;
  for (const pair of combinations(M, 2)) {
    if (!tradeLegalCombo(pair)) continue;
    const kind = duoPairKind(
      pair.map((m) => modQualityTierForBase(baseId, m.id)),
    );
    if (kind === "SS" || kind === "SA" || kind === "AA") ssSaAa++;
    else if (kind === "SB") sb++;
    else if (kind === "AB") ab++;
  }

  let allS3 = 0;
  for (const trip of combinations(sMods, 3)) {
    if (tradeLegalCombo(trip)) allS3++;
  }
  let allS4 = 0;
  if (sMods.length <= 8) {
    for (const quad of combinations(sMods, 4)) {
      if (tradeLegalCombo(quad)) allS4++;
    }
  }

  const previous = solos + ssSaAa + sb + ab + allS3 + allS4;
  const afterAbDrop = solos + ssSaAa + sb + allS3 + allS4;
  const afterSbDrop = solos + ssSaAa + allS3 + allS4;
  return {
    baseId,
    s: sMods.length,
    a: aMods.length,
    b: bMods.length,
    solos,
    ssSaAa,
    sb,
    ab,
    allS3,
    allS4,
    previous: Math.min(safetyMax, previous),
    afterAbDrop: Math.min(safetyMax, afterAbDrop),
    afterSbDrop: Math.min(safetyMax, afterSbDrop),
    truncatedAt40: afterAbDrop > safetyMax,
    fullRefreshPrevious: 2 + 4 + Math.min(safetyMax, previous),
    fullRefreshA: 2 + 4 + Math.min(safetyMax, afterAbDrop),
    // 2 blank + 2 magic + 2 junk flow snaps + SAB sells
    fullRefreshB: 2 + 4 + Math.min(safetyMax, afterSbDrop),
  };
}

describe("sab-combo-plan", () => {
  it("keeps S/A solos, SS/SA/AA duos, and all-S triples/quads only", () => {
    for (const baseId of ["temple_tablet", "breach_tablet"] as const) {
      const M = sabModsForBase(baseId);
      expect(
        M.every((m) => {
          const q = modQualityTierForBase(baseId, m.id);
          return q === "S" || q === "A";
        }),
      ).toBe(true);
      const plan = enumerateSabCombos(M, 40, baseId);
      expect(plan.length).toBeGreaterThan(0);
      for (const item of plan) {
        const qs = qualitiesOf(item.modIds, baseId);
        expect(qs.every((q) => q !== "Junk" && q !== "B")).toBe(true);
        if (item.kind === "solo") {
          expect(["S", "A"]).toContain(qs[0]);
        } else if (item.kind === "duo") {
          const kind = duoPairKind(qs);
          expect(["SS", "SA", "AA"]).toContain(kind);
          expect(kind).not.toBe("SB");
          expect(kind).not.toBe("AB");
          expect(kind).not.toBe("BB");
        } else {
          expect(qs.every((q) => q === "S")).toBe(true);
        }
      }
    }
  });

  it("temple worklist has 1 crystal solo @8, no crystal+B duos, no prongs/B solos/triples", () => {
    const M = sabModsForBase("temple_tablet");
    expect(M.some((m) => m.id === "temple_crystal_t1")).toBe(true);
    expect(M.some((m) => m.id === "map_pack_size_t1")).toBe(false);
    expect(M.some((m) => m.id === "map_pack_size_t2")).toBe(false);
    for (const m of M) {
      const q = modQualityTierForBase("temple_tablet", m.id);
      expect(q).not.toBe("Junk");
      expect(q).not.toBe("B");
    }

    const plan = buildSabSyncWorklist("temple_tablet", 40);
    expect(plan).toHaveLength(1);

    const bSolos = [
      "map_pack_size_t1",
      "junk_monster_eff_t1",
      "junk_item_rarity_t1",
      "map_waystone_qty_t1",
    ];
    for (const item of plan) {
      for (const id of item.modIds) {
        expect(modQualityTierForBase("temple_tablet", id)).not.toBe("Junk");
        expect(modQualityTierForBase("temple_tablet", id)).not.toBe("B");
      }
      expect(allBQuality(item.modIds, "temple_tablet")).toBe(false);
      if (item.kind === "solo") {
        expect(bSolos).not.toContain(item.modIds[0]);
      }
      expect(item.kind === "triple" || item.kind === "quad").toBe(false);
    }

    const crystalSolos = plan.filter(
      (w) => w.kind === "solo" && w.modIds[0] === "temple_crystal_t1",
    );
    expect(crystalSolos).toHaveLength(1);
    expect(crystalSolos[0]!.prongRoll).toBe(8);
    expect(crystalSolos[0]!.stats).toEqual([
      { id: "explicit.stat_1940774881", min: 8, max: 8 },
    ]);

    const crystalPlusB = plan.filter(
      (w) =>
        w.kind === "duo" &&
        w.modIds.includes("temple_crystal_t1") &&
        w.modIds.some((id) => modQualityTierForBase("temple_tablet", id) === "B"),
    );
    expect(crystalPlusB).toHaveLength(0);
    expect(
      plan.some(
        (w) =>
          w.kind === "duo" &&
          duoPairKind(qualitiesOf(w.modIds, "temple_tablet")) === "SB",
      ),
    ).toBe(false);
    expect(
      plan.some(
        (w) =>
          w.kind === "duo" &&
          duoPairKind(qualitiesOf(w.modIds, "temple_tablet")) === "AB",
      ),
    ).toBe(false);

    // B+B (e.g. pack|waystone) is not searched
    expect(
      plan.some(
        (w) =>
          w.modIds.includes("map_pack_size_t1") &&
          w.modIds.includes("map_waystone_qty_t1") &&
          !w.modIds.includes("temple_crystal_t1"),
      ),
    ).toBe(false);
  });

  it("breach worklist keeps S/A solos, SS/SA/AA only; no SB, no AB/BB, no mixed triples", () => {
    const plan = buildSabSyncWorklist("breach_tablet", 40);
    const census = sellComboCensus("breach_tablet");
    expect(plan).toHaveLength(census.afterSbDrop);
    expect(census.ab).toBeGreaterThan(0);
    expect(census.sb).toBeGreaterThan(0);

    for (const item of plan) {
      expect(allBQuality(item.modIds, "breach_tablet")).toBe(false);
      const qs = qualitiesOf(item.modIds, "breach_tablet");
      if (item.kind === "solo") {
        expect(["S", "A"]).toContain(qs[0]);
        expect(qs[0]).not.toBe("B");
      } else if (item.kind === "duo") {
        expect(["SS", "SA", "AA"]).toContain(duoPairKind(qs));
      }
      expect(item.kind === "triple" || item.kind === "quad").toBe(false);
    }

    const sSolos = plan.filter(
      (w) =>
        w.kind === "solo" &&
        modQualityTierForBase("breach_tablet", w.modIds[0]!) === "S",
    );
    const aSolos = plan.filter(
      (w) =>
        w.kind === "solo" &&
        modQualityTierForBase("breach_tablet", w.modIds[0]!) === "A",
    );
    expect(sSolos).toHaveLength(2);
    expect(aSolos.length).toBeGreaterThan(0);
    expect(sSolos.map((w) => w.modIds[0]).sort()).toEqual(
      ["breach_hiveblood_t1", "breach_unstable_rare_t1"].sort(),
    );
    expect(sSolos.every((w) => w.prongRoll != null)).toBe(true);

    const ss = plan.filter(
      (w) =>
        w.kind === "duo" &&
        w.modIds.includes("breach_unstable_rare_t1") &&
        w.modIds.includes("breach_hiveblood_t1"),
    );
    expect(ss.length).toBe(1);

    const sa = plan.filter(
      (w) =>
        w.kind === "duo" &&
        w.modIds.includes("breach_unstable_rare_t1") &&
        w.modIds.includes("breach_rare_potency_t1"),
    );
    expect(sa.length).toBe(1);

    const sPlusB = plan.filter(
      (w) =>
        w.kind === "duo" &&
        w.modIds.includes("breach_unstable_rare_t1") &&
        w.modIds.includes("junk_monster_eff_t1"),
    );
    expect(sPlusB).toHaveLength(0);

    // A+B (potency + monster eff) is not searched
    expect(
      plan.some(
        (w) =>
          w.kind === "duo" &&
          w.modIds.includes("breach_rare_potency_t1") &&
          w.modIds.includes("junk_monster_eff_t1"),
      ),
    ).toBe(false);

    // B+B (eff + vruun) is Trash-tier MDP (not searched)
    expect(
      classifyModCombo(
        ["junk_monster_eff_t1", "breach_vruun_chance_t1"],
        "breach_tablet",
      ).rareTier,
    ).toBe("Trash");
    expect(
      plan.some(
        (w) =>
          w.modIds.includes("junk_monster_eff_t1") &&
          w.modIds.includes("breach_vruun_chance_t1") &&
          w.modIds.length === 2,
      ),
    ).toBe(false);
  });

  it("buildSabDeepSyncWorklist uses single p65 crystal solo and RareTier pairs", () => {
    const plan = buildSabDeepSyncWorklist("temple_tablet");
    const crystalSolos = plan.filter(
      (w) => w.kind === "solo" && w.modIds[0] === "temple_crystal_t1",
    );
    expect(crystalSolos).toHaveLength(1);
    expect(crystalSolos[0]!.prongRoll).toBe(8);
    expect(crystalSolos[0]!.stats).toEqual([
      { id: "explicit.stat_1940774881", min: 8, max: 8 },
    ]);

    // Crystal+pack (S+B → SS via temple jackpot) is a premium pair search
    expect(
      plan.some(
        (w) =>
          w.kind === "duo" &&
          w.modIds.includes("temple_crystal_t1") &&
          (w.modIds.includes("map_pack_size_t1") ||
            w.modIds.includes("map_pack_size_t2")),
      ),
    ).toBe(true);

    // Pairs before solos
    const firstSoloIdx = plan.findIndex((w) => w.kind === "solo");
    const lastDuoIdx = plan.reduce(
      (acc, w, i) => (w.kind === "duo" ? i : acc),
      -1,
    );
    expect(firstSoloIdx).toBeGreaterThan(-1);
    expect(lastDuoIdx).toBeGreaterThan(-1);
    expect(lastDuoIdx).toBeLessThan(firstSoloIdx);
  });

  it("buildSabDeepSyncWorklist includes Ritual omen+reroll and Breach unstable+potency", () => {
    const ritual = buildSabDeepSyncWorklist("ritual_tablet");
    expect(
      ritual.some(
        (w) =>
          w.kind === "duo" &&
          w.modIds.includes("ritual_omen_t1") &&
          w.modIds.includes("ritual_reroll_t1"),
      ),
    ).toBe(true);

    const breach = buildSabDeepSyncWorklist("breach_tablet");
    expect(
      breach.some(
        (w) =>
          w.kind === "duo" &&
          w.modIds.includes("breach_unstable_rare_t1") &&
          w.modIds.includes("breach_rare_potency_t1"),
      ),
    ).toBe(true);
  });

  it("buildSabDeepSyncWorklist is uncapped vs standard 40-cap on large bases", () => {
    const deep = buildSabDeepSyncWorklist("overseer_tablet");
    const standard = buildSabSyncWorklist("overseer_tablet", 40);
    expect(deep.length).toBeGreaterThan(standard.length);
  });

  it("solo S crystal worklist emits one 65th-pct roll @8", () => {
    const plan = buildSabSyncWorklist("temple_tablet", 40);
    const crystal = plan.find(
      (w) => w.kind === "solo" && w.modIds[0] === "temple_crystal_t1",
    );
    expect(crystal).toBeTruthy();
    expect(crystal!.prongRoll).toBe(8);
    expect(crystal!.comboKey).toBe("__solo__:temple_crystal_t1");
    expect(crystal!.stats).toEqual([
      { id: "explicit.stat_1940774881", min: 8, max: 8 },
    ]);
  });

  it("enumerates affix-legal all-S triples/quads and skips mixed triples", () => {
    const crystal = TABLET_MOD_WEIGHTS.temple_crystal_t1!;
    const splinter = TABLET_MOD_WEIGHTS.delirium_splinter_stack_t1!;
    const logPrefix = {
      ...TABLET_MOD_WEIGHTS.expedition_logbook_t1!,
      isPrefix: true,
    };
    const rerollPrefix = {
      ...TABLET_MOD_WEIGHTS.ritual_reroll_t1!,
      isPrefix: true,
    };
    const packB = TABLET_MOD_WEIGHTS.map_pack_size_t1!;
    const plan = enumerateSabCombos(
      [crystal, splinter, logPrefix, rerollPrefix, packB],
      40,
    );

    const triples = plan.filter((w) => w.kind === "triple");
    const quads = plan.filter((w) => w.kind === "quad");
    expect(triples).toHaveLength(4);
    expect(quads).toHaveLength(1);
    const allSIds = [
      "temple_crystal_t1",
      "delirium_splinter_stack_t1",
      "expedition_logbook_t1",
      "ritual_reroll_t1",
    ];
    for (const item of [...triples, ...quads]) {
      expect(item.modIds).not.toContain("map_pack_size_t1");
      expect(item.modIds.every((id) => allSIds.includes(id))).toBe(true);
    }
    expect(quads[0]!.modIds.sort()).toEqual([...allSIds].sort());
    expect(
      plan.some(
        (w) =>
          w.kind === "triple" &&
          w.modIds.includes("map_pack_size_t1") &&
          w.modIds.includes("temple_crystal_t1"),
      ),
    ).toBe(false);
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

  it("same-side duo stamps modValueMap and measuredAffixSamples", () => {
    const market = createEmptyMarketCache();
    const item: SabSyncWorkItem = {
      kind: "duo",
      modIds: ["breach_rare_potency_t1", "breach_unstable_rare_t1"],
      comboKey: "breach_rare_potency_t1+breach_unstable_rare_t1",
      stats: [
        { id: "explicit.stat_dummy_a", min: 1, max: 1 },
        { id: "explicit.stat_dummy_b", min: 1, max: 1 },
      ],
    };
    applySabSyncHit(market, "breach_tablet", item, 3500);

    const key = "breach_rare_potency_t1+breach_unstable_rare_t1";
    expect(market.modValueMap[key]).toBe(3500);
    expect(market.priceSource?.modValueMap?.[key]).toBe("measured");
    expect(
      market.measuredAffixSamples?.some(
        (s) =>
          s.baseId === "breach_tablet" &&
          s.sellEx === 3500 &&
          s.modIds.join("+") === key,
      ),
    ).toBe(true);
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

  it("B-tier samples do not price a mid-band; B sale equals Trash dump", () => {
    const market = createEmptyMarketCache();
    market.basePrices.temple_tablet = 100;
    market.junkSellByBase = { temple_tablet: 60 };
    market.currencyCosts.alchemy = 0.05;
    market.currencyCosts.chaos = 45;
    market.currencyCosts.vaal = 0.4;
    market.currencyCosts.transmute = 0.01;
    market.currencyCosts.augmentation = 0.02;
    market.currencyCosts.regal = 0.15;
    // Cross-side B+B (pack|waystone) → MDP Trash (B/junk filler)
    expect(
      classifyModCombo(
        ["map_pack_size_t1", "map_waystone_qty_t1"],
        "temple_tablet",
      ).rareTier,
    ).toBe("Trash");
    market.measuredAffixSamples = [
      {
        baseId: "temple_tablet",
        modIds: ["map_pack_size_t1", "map_waystone_qty_t1"].sort(),
        sellEx: 250,
      },
    ];

    const sales = buildTierSaleTable(market, "temple_tablet")!;
    expect(sales.uncorrupted.B).toBe(sales.uncorrupted.Trash);
    expect(sales.uncorrupted.B).toBe(60);
    expect(sales.uncorrupted.B).not.toBe(250);
  });

  it("SEARCH sell-combo census per tablet base (afterSbDrop is live worklist)", () => {
    const summary = Object.keys(TABLET_BASES).map((baseId) => {
      const row = sellComboCensus(baseId);
      const plan = buildSabSyncWorklist(baseId, 40);
      expect(plan, baseId).toHaveLength(row.afterSbDrop);
      expect(
        plan.filter(
          (w) =>
            w.kind === "duo" &&
            duoPairKind(qualitiesOf(w.modIds, baseId)) === "AB",
        ),
      ).toHaveLength(0);
      expect(
        plan.filter(
          (w) =>
            w.kind === "duo" &&
            duoPairKind(qualitiesOf(w.modIds, baseId)) === "SB",
        ),
      ).toHaveLength(0);
      return {
        base: baseId.replace(/_tablet$/, ""),
        prev: row.previous,
        A: row.afterAbDrop,
        B_noSB: row.afterSbDrop,
        AB_dropped: row.ab,
        SB: row.sb,
        allS3: row.allS3,
        sMods: row.s,
        refreshA: row.fullRefreshA,
        refreshB: row.fullRefreshB,
      };
    });
    expect(summary).toEqual([
      {
        base: "breach",
        prev: 18,
        A: 14,
        B_noSB: 10,
        AB_dropped: 4,
        SB: 4,
        allS3: 0,
        sMods: 2,
        refreshA: 20,
        refreshB: 16,
      },
      {
        base: "delirium",
        prev: 14,
        A: 11,
        B_noSB: 10,
        AB_dropped: 3,
        SB: 1,
        allS3: 0,
        sMods: 1,
        refreshA: 17,
        refreshB: 16,
      },
      {
        base: "expedition",
        prev: 25,
        A: 19,
        B_noSB: 15,
        AB_dropped: 6,
        SB: 4,
        allS3: 0,
        sMods: 2,
        refreshA: 25,
        refreshB: 21,
      },
      {
        base: "ritual",
        prev: 11,
        A: 7,
        B_noSB: 3,
        AB_dropped: 4,
        SB: 4,
        allS3: 0,
        sMods: 1,
        refreshA: 13,
        refreshB: 9,
      },
      {
        base: "overseer",
        prev: 27,
        A: 23,
        B_noSB: 21,
        AB_dropped: 4,
        SB: 2,
        allS3: 0,
        sMods: 2,
        refreshA: 29,
        refreshB: 27,
      },
      {
        base: "abyss",
        prev: 27,
        A: 22,
        B_noSB: 21,
        AB_dropped: 5,
        SB: 1,
        allS3: 0,
        sMods: 1,
        refreshA: 28,
        refreshB: 27,
      },
      {
        base: "irradiated",
        prev: 20,
        A: 17,
        B_noSB: 15,
        AB_dropped: 3,
        SB: 2,
        allS3: 0,
        sMods: 2,
        refreshA: 23,
        refreshB: 21,
      },
      {
        base: "temple",
        prev: 5,
        A: 5,
        B_noSB: 1,
        AB_dropped: 0,
        SB: 4,
        allS3: 0,
        sMods: 1,
        refreshA: 11,
        refreshB: 7,
      },
    ]);
  });
});
