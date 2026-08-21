import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionModTiers,
  getSessionModTier,
  hydrateSessionModTiers,
  modQualityTierForBase,
  setSessionModTier,
  snapshotSessionModTiers,
} from "@/web/price-check/tablets/mod-tiers";
import {
  getComboTierOverride,
  resetComboTierOverridesForTests,
  setSessionComboTier,
  snapshotComboTierOverrides,
} from "@/web/price-check/tablets/combo-tier-overrides";
import {
  applyTierOverridesFromRepo,
  commitTierOverrides,
  emptyTierOverridesDocument,
  loadTierOverrides,
  resetTierOverridesForTests,
  sanitizeTierOverridesDocument,
  TIER_OVERRIDES_REVISION,
} from "@/web/price-check/tablets/tier-overrides-store";

const breach = "breach_tablet";
const ritual = "ritual_tablet";

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

describe("tier-overrides-store", () => {
  beforeEach(() => {
    mockLocalStorage();
    resetTierOverridesForTests();
    resetComboTierOverridesForTests();
    clearSessionModTiers();
  });

  afterEach(() => {
    resetTierOverridesForTests();
    resetComboTierOverridesForTests();
    clearSessionModTiers();
    vi.unstubAllGlobals();
  });

  it("per-base session mod tiers do not leak across bases", () => {
    setSessionModTier(breach, "junk_monster_eff_t1", "S");
    setSessionModTier(ritual, "junk_monster_eff_t1", "Junk");
    expect(modQualityTierForBase(breach, "junk_monster_eff_t1")).toBe("S");
    expect(modQualityTierForBase(ritual, "junk_monster_eff_t1")).toBe("Junk");
    expect(getSessionModTier(breach, "junk_monster_eff_t1")).toBe("S");
  });

  it("snapshot + hydrate session mod tiers round-trip", () => {
    setSessionModTier(ritual, "ritual_tribute_t1", "B");
    setSessionModTier(breach, "breach_hiveblood_t1", "A");
    const snap = snapshotSessionModTiers();
    clearSessionModTiers();
    expect(getSessionModTier(ritual, "ritual_tribute_t1")).toBeUndefined();
    hydrateSessionModTiers(snap);
    expect(getSessionModTier(ritual, "ritual_tribute_t1")).toBe("B");
    expect(getSessionModTier(breach, "breach_hiveblood_t1")).toBe("A");
  });

  it("commitTierOverrides persists local cache and restores via apply", () => {
    setSessionModTier(ritual, "ritual_tribute_t1", "B");
    setSessionComboTier(
      breach,
      ["junk_gold_t1", "breach_unstable_rare_t1"],
      "S",
    );
    const comboSnap = snapshotComboTierOverrides();
    const doc = {
      ...emptyTierOverridesDocument(),
      updatedAt: 42,
      modTiersByBase: snapshotSessionModTiers(),
      comboByBase: comboSnap.byBase,
    };
    const committed = commitTierOverrides(doc);
    expect(committed.revision).toBe(TIER_OVERRIDES_REVISION);
    expect(committed.modTiersByBase[ritual]?.ritual_tribute_t1).toBe("B");
    expect(loadTierOverrides().modTiersByBase[ritual]?.ritual_tribute_t1).toBe(
      "B",
    );

    clearSessionModTiers();
    resetComboTierOverridesForTests();
    const restored = applyTierOverridesFromRepo(loadTierOverrides());
    expect(restored.modTiersByBase[ritual]?.ritual_tribute_t1).toBe("B");
    expect(getSessionModTier(ritual, "ritual_tribute_t1")).toBe("B");
    const key = "junk_gold_t1+breach_unstable_rare_t1";
    expect(getComboTierOverride(breach, key)?.tier).toBe("S");
  });

  it("sanitize drops bad tiers and keeps valid shape", () => {
    const cleaned = sanitizeTierOverridesDocument({
      revision: TIER_OVERRIDES_REVISION,
      updatedAt: 1,
      modTiersByBase: {
        ritual_tablet: {
          ritual_tribute_t1: "B",
          bad: "Z",
        },
      },
      comboByBase: {
        breach_tablet: {
          "a+b": {
            comboKey: "a+b",
            baseId: "breach_tablet",
            modIds: ["junk_gold_t1", "breach_unstable_rare_t1"],
            tier: "S",
            updatedAt: 1,
          },
          broken: { tier: "nope" },
        },
      },
    });
    expect(cleaned.modTiersByBase.ritual_tablet).toEqual({
      ritual_tribute_t1: "B",
    });
    expect(
      cleaned.comboByBase.breach_tablet?.["a+b"]?.modIds,
    ).toEqual(["junk_gold_t1", "breach_unstable_rare_t1"]);
    expect(cleaned.comboByBase.breach_tablet?.broken).toBeUndefined();
  });
});
