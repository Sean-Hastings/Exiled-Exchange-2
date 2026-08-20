import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMBO_TIER_OVERRIDE_REVISION,
  canonicalComboKey,
  getComboTierOverride,
  hydrateComboTierOverrides,
  loadComboTierOverrides,
  persistComboOverride,
  rareTierForCombo,
  resetComboTierOverridesForTests,
  saveComboTierOverrides,
  setSessionComboTier,
} from "@/web/price-check/tablets/combo-tier-overrides";

const breach = "breach_tablet";
const temple = "temple_tablet";

function mockLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
  return store;
}

describe("combo-tier-overrides", () => {
  beforeEach(() => {
    mockLocalStorage();
    resetComboTierOverridesForTests();
  });

  afterEach(() => {
    resetComboTierOverridesForTests();
    vi.unstubAllGlobals();
  });

  it("canonicalizes 1p1s, solo, and sorted multi keys", () => {
    expect(
      canonicalComboKey(breach, [
        "map_pack_size_t1",
        "breach_unstable_rare_t1",
      ]),
    ).toBe("map_pack_size_t1+breach_unstable_rare_t1");
    expect(canonicalComboKey(breach, ["breach_unstable_rare_t1"])).toBe(
      "__solo__:breach_unstable_rare_t1",
    );
    expect(
      canonicalComboKey(breach, [
        "breach_hiveblood_t1",
        "breach_unstable_rare_t1",
        "junk_gold_t1",
        "junk_xp_t1",
      ]),
    ).toBe(
      "breach_hiveblood_t1+breach_unstable_rare_t1+junk_gold_t1+junk_xp_t1",
    );
  });

  it("override wins over auto classification", () => {
    const modIds = ["map_pack_size_t1", "temple_crystal_t1"];
    const auto = rareTierForCombo(modIds, temple);
    expect(auto.source).toBe("auto");
    expect(auto.tier).toBe("SS");

    setSessionComboTier(temple, modIds, "Trash");
    const over = rareTierForCombo(modIds, temple);
    expect(over.source).toBe("override");
    expect(over.tier).toBe("Trash");
  });

  it("falls back to persisted tier when session cleared", async () => {
    vi.useFakeTimers();
    const modIds = ["map_pack_size_t1", "breach_unstable_rare_t1"];
    const key = canonicalComboKey(breach, modIds);

    setSessionComboTier(breach, modIds, "A");
    await vi.advanceTimersByTimeAsync(350);
    expect(getComboTierOverride(breach, key)?.tier).toBe("A");

    setSessionComboTier(breach, modIds, null);
    expect(getComboTierOverride(breach, key)?.tier).toBe("A");
    vi.useRealTimers();
  });

  it("round-trips localStorage with revision gate", async () => {
    vi.useFakeTimers();
    const modIds = ["junk_gold_t1", "breach_unstable_rare_t1"];
    const key = canonicalComboKey(breach, modIds);
    setSessionComboTier(breach, modIds, "S", { isCustom: true });
    await vi.advanceTimersByTimeAsync(350);

    const loaded = loadComboTierOverrides();
    expect(loaded?.revision).toBe(COMBO_TIER_OVERRIDE_REVISION);
    expect(loaded?.byBase[breach]?.[key]?.tier).toBe("S");
    expect(loaded?.byBase[breach]?.[key]?.isCustom).toBe(true);

    resetComboTierOverridesForTests();
    hydrateComboTierOverrides();
    expect(getComboTierOverride(breach, key)).toBeUndefined();

    saveComboTierOverrides(loaded!);
    hydrateComboTierOverrides();
    expect(getComboTierOverride(breach, key)?.tier).toBe("S");
    vi.useRealTimers();
  });
});
