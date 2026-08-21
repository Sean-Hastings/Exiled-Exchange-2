import { beforeEach, describe, expect, it } from "vitest";
import { enumerateComboTierRows } from "@/web/price-check/tablets/combo-tier-enumerate";
import {
  resetComboTierOverridesForTests,
  setSessionComboTier,
} from "@/web/price-check/tablets/combo-tier-overrides";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";

const breach = "breach_tablet";
const temple = "temple_tablet";

describe("combo-tier-enumerate", () => {
  beforeEach(() => {
    resetComboTierOverridesForTests();
  });

  it("lists Temple crystal cross combo as auto SS", () => {
    const rows = enumerateComboTierRows(temple);
    const ss = rows.find(
      (r) =>
        r.comboKey === "map_pack_size_t1+temple_crystal_t1" &&
        r.autoTier === "SS",
    );
    expect(ss).toBeTruthy();
    expect(ss!.tier).toBe("SS");
    expect(ss!.source).toBe("auto");
  });

  it("keeps override B visible when auto tier is SS", () => {
    const modIds = ["map_pack_size_t1", "temple_crystal_t1"];
    setSessionComboTier(temple, modIds, "B");

    const rows = enumerateComboTierRows(temple);
    const row = rows.find(
      (r) => r.comboKey === "map_pack_size_t1+temple_crystal_t1",
    );
    expect(row).toBeTruthy();
    expect(row!.autoTier).toBe("SS");
    expect(row!.tier).toBe("B");
    expect(row!.source).toBe("override");
    expect(rows[0]!.comboKey).toBe(row!.comboKey);
  });

  it("includes custom junk combo via override", () => {
    const modIds = ["junk_gold_t1", "breach_splinter_qty_t1"];
    setSessionComboTier(breach, modIds, "SS", { isCustom: true });

    const rows = enumerateComboTierRows(breach);
    const row = rows.find((r) => r.comboKey === canonicalKey(modIds));
    expect(row).toBeTruthy();
    expect(row!.autoTier).toBe("Trash");
    expect(row!.tier).toBe("SS");
    expect(row!.isCustom).toBe(true);
  });

  it("hides auto Trash combos without override", () => {
    const rows = enumerateComboTierRows(breach);
    const trashOnly = rows.filter(
      (r) => r.autoTier === "Trash" && r.source === "auto",
    );
    expect(trashOnly.length).toBe(0);
  });

  it("excludes auto junk_gold+unstable without override", () => {
    const rows = enumerateComboTierRows(breach);
    const junkCross = rows.find(
      (r) =>
        r.comboKey === "junk_gold_t1+breach_unstable_rare_t1" &&
        r.source === "auto",
    );
    expect(junkCross).toBeUndefined();
  });

  it("includes same-side SA (unstable+potency) as auto SS", () => {
    const rows = enumerateComboTierRows(breach);
    const sameSide = rows.find(
      (r) =>
        r.comboKey === "breach_rare_potency_t1+breach_unstable_rare_t1" &&
        r.source === "auto",
    );
    expect(sameSide).toBeTruthy();
    expect(sameSide!.autoTier).toBe("SS");
    expect(sameSide!.tier).toBe("SS");
    expect(sameSide!.suffixSide).toBe("SA");
  });

  it("surfaces measured price when market provided", () => {
    const market = createEmptyMarketCache();
    const key = "breach_rare_potency_t1+breach_unstable_rare_t1";
    market.modValueMap[key] = 4200;
    const rows = enumerateComboTierRows(breach, market);
    const row = rows.find((r) => r.comboKey === key);
    expect(row?.measuredEx).toBe(4200);
  });

  it("falls back to measuredAffixSamples for same-side price", () => {
    const market = createEmptyMarketCache();
    const key = "breach_rare_potency_t1+breach_unstable_rare_t1";
    market.measuredAffixSamples = [
      {
        baseId: breach,
        modIds: ["breach_rare_potency_t1", "breach_unstable_rare_t1"],
        sellEx: 2800,
      },
    ];
    const rows = enumerateComboTierRows(breach, market);
    const row = rows.find((r) => r.comboKey === key);
    expect(row?.measuredEx).toBe(2800);
  });
});

function canonicalKey(modIds: string[]): string {
  if (modIds.length === 1) return `__solo__:${modIds[0]}`;
  return `${modIds[0]}+${modIds[1]}`;
}
