import { describe, expect, it } from "vitest";
import {
  SIDE_SCORE,
  classifyModCombo,
  classifySide,
  comboScoreToRareTier,
  itemComboScore,
  modComboToRareTier,
  modQualityTierForBase,
  rareTierFromSidePatterns,
} from "@/web/price-check/tablets/mod-tiers";
import { WEIGHT_BENCH } from "@/web/price-check/tablets/mod-weights";

const breach = "breach_tablet";
const temple = "temple_tablet";
const irradiated = "irradiated_tablet";

describe("multi-affix combo tiering", () => {
  it("side ladder: SS > SA > S > AA > A > B", () => {
    expect(SIDE_SCORE.SS).toBeGreaterThan(SIDE_SCORE.SA);
    expect(SIDE_SCORE.SA).toBeGreaterThan(SIDE_SCORE.S);
    expect(SIDE_SCORE.S).toBeGreaterThan(SIDE_SCORE.AA);
    expect(SIDE_SCORE.AA).toBeGreaterThan(SIDE_SCORE.A);
    expect(SIDE_SCORE.A).toBeGreaterThan(SIDE_SCORE.B);
  });

  it("classifies suffix doubles and mixes (0.5.4 Breach live)", () => {
    // SS: unstable + hiveblood
    expect(
      classifySide(
        ["breach_unstable_rare_t1", "breach_hiveblood_t1"],
        breach,
      ),
    ).toBe("SS");
    // SA: unstable + potency
    expect(
      classifySide(
        ["breach_unstable_rare_t1", "breach_rare_potency_t1"],
        breach,
      ),
    ).toBe("SA");
    expect(
      classifySide(
        ["breach_unstable_rare_t1", "junk_extra_shrine_t1"],
        breach,
      ),
    ).toBe("S");
    // AA: potency + pack_size_t1
    expect(
      classifySide(
        ["breach_rare_potency_t1", "breach_pack_size_t1"],
        breach,
      ),
    ).toBe("AA");
    expect(
      classifySide(["breach_pack_size_t1", "junk_extra_shrine_t1"], breach),
    ).toBe("A");
    // Domain splinters are Junk; pack_size_t2 is B
    expect(
      classifySide(
        ["breach_pack_size_t2", "junk_extra_shrine_t1"],
        breach,
      ),
    ).toBe("B");
    expect(
      modQualityTierForBase(breach, "breach_splinter_qty_t1"),
    ).toBe("Junk");
    expect(
      modQualityTierForBase(breach, "breach_splinter_qty_t2"),
    ).toBe("Junk");
    expect(modQualityTierForBase(breach, "junk_item_rarity_t1")).toBe(
      "Junk",
    );
  });

  it("solo S scores above double A (score helper approximates A tier)", () => {
    const soloS = itemComboScore(
      [
        "junk_gold_t1",
        "junk_xp_t1",
        "breach_unstable_rare_t1",
        "junk_extra_shrine_t1",
      ],
      breach,
    );
    const doubleA = itemComboScore(
      [
        "junk_gold_t1",
        "junk_xp_t1",
        "breach_rare_potency_t1",
        "breach_pack_size_t1",
      ],
      breach,
    );
    expect(soloS).toBeGreaterThan(doubleA);
    expect(comboScoreToRareTier(soloS)).toBe("A");
    expect(comboScoreToRareTier(doubleA)).toBe("A");
  });

  it("pattern classifier: solo S → S; AA → A", () => {
    expect(
      modComboToRareTier(
        [
          "junk_gold_t1",
          "junk_xp_t1",
          "breach_unstable_rare_t1",
          "junk_extra_shrine_t1",
        ],
        breach,
      ),
    ).toBe("S");
    expect(
      modComboToRareTier(
        [
          "junk_gold_t1",
          "junk_xp_t1",
          "breach_rare_potency_t1",
          "breach_pack_size_t1",
        ],
        breach,
      ),
    ).toBe("A");
  });

  it("SS or SA (same side or cross) → MDP SS (divine)", () => {
    // 2× S suffixes
    expect(
      classifyModCombo(
        [
          "junk_gold_t1",
          "junk_xp_t1",
          "breach_unstable_rare_t1",
          "breach_hiveblood_t1",
        ],
        breach,
      ).rareTier,
    ).toBe("SS");
    // S+A suffixes (unstable + potency)
    expect(
      classifyModCombo(
        [
          "junk_gold_t1",
          "junk_xp_t1",
          "breach_unstable_rare_t1",
          "breach_rare_potency_t1",
        ],
        breach,
      ).rareTier,
    ).toBe("SS");
    // Solo S + B support stays S:
    expect(
      classifyModCombo(
        [
          "junk_monster_eff_t1",
          "junk_xp_t1",
          "breach_unstable_rare_t1",
          "junk_extra_shrine_t1",
        ],
        breach,
      ).rareTier,
    ).toBe("S");
  });

  it("cross A|A → A (not SS/S)", () => {
    expect(
      modComboToRareTier(
        ["junk_monster_eff_t1", "junk_rare_mons_t1"],
        "abyss_tablet",
      ),
    ).toBe("A");
  });

  it("solo A → B; junk → Trash", () => {
    expect(
      classifyModCombo(
        [
          "breach_pack_size_t1",
          "junk_xp_t1",
          "junk_extra_shrine_t1",
          "junk_extra_strongbox_t1",
        ],
        breach,
      ).rareTier,
    ).toBe("B");
    expect(
      classifyModCombo(
        [
          "junk_gold_t1",
          "junk_xp_t1",
          "junk_extra_shrine_t1",
          "junk_extra_strongbox_t1",
        ],
        breach,
      ).rareTier,
    ).toBe("Trash");
  });

  it("1p+1s pairs use the same scorer", () => {
    // Same-side SA (potency A + unstable S) → MDP SS
    expect(
      classifyModCombo(
        ["breach_rare_potency_t1", "breach_unstable_rare_t1"],
        breach,
      ).rareTier,
    ).toBe("SS");
    // Same-side SA (pack A + hiveblood S) → MDP SS
    expect(
      classifyModCombo(
        ["breach_pack_size_t1", "breach_hiveblood_t1"],
        breach,
      ).rareTier,
    ).toBe("SS");
    // Domain dead: pack + splinter is solo A → B
    expect(
      classifyModCombo(
        ["breach_pack_size_t1", "breach_splinter_qty_t1"],
        breach,
      ).rareTier,
    ).toBe("B");
    // Shared eff is B support — B prefix + A suffix → B
    expect(
      classifyModCombo(
        ["junk_monster_eff_t1", "breach_rare_potency_t1"],
        breach,
      ).rareTier,
    ).toBe("B");
  });

  it("rareTierFromSidePatterns cross S|S → SS", () => {
    expect(
      rareTierFromSidePatterns("S", "S", { pS: 1, pA: 0, sS: 1, sA: 0 }),
    ).toBe("SS");
    expect(
      rareTierFromSidePatterns("S", "A", { pS: 1, pA: 0, sS: 0, sA: 1 }),
    ).toBe("SS");
  });
});

describe("Temple per-base quality (survey 2026-08-12)", () => {
  it("crystal S; mid-band B; Temple exclusives Junk; no Irradiated S/A bleed", () => {
    expect(modQualityTierForBase(temple, "temple_crystal_t1")).toBe("S");
    expect(modQualityTierForBase(temple, "map_waystone_qty_t1")).toBe("B");
    expect(modQualityTierForBase(temple, "junk_monster_eff_t1")).toBe("B");
    expect(modQualityTierForBase(temple, "junk_item_rarity_t1")).toBe("B");
    expect(modQualityTierForBase(temple, "map_pack_size_t1")).toBe("B");
    expect(modQualityTierForBase(temple, "map_pack_size_t2")).toBe("B");
    expect(modQualityTierForBase(temple, "temple_beacon_pack_t1")).toBe(
      "Junk",
    );
    expect(modQualityTierForBase(temple, "junk_map_mods_t1")).toBe("Junk");
    expect(modQualityTierForBase(temple, "junk_extra_azmeri_t1")).toBe(
      "Junk",
    );
    // Irradiated / Breach keep their own sealed maps
    expect(modQualityTierForBase(irradiated, "map_waystone_qty_t1")).toBe(
      "S",
    );
    expect(modQualityTierForBase(breach, "junk_monster_eff_t1")).toBe("B");
    expect(modQualityTierForBase(breach, "map_waystone_qty_t1")).toBe(
      "Junk",
    );
  });

  it("crystal alone → MDP SS; waystone/eff alone not SS; non-crystal A|A not SS", () => {
    expect(
      classifyModCombo(["junk_gold_t1", "temple_crystal_t1"], temple)
        .rareTier,
    ).toBe("SS");
    expect(
      classifyModCombo(["map_waystone_qty_t1"], temple).rareTier,
    ).not.toBe("SS");
    expect(
      classifyModCombo(["junk_monster_eff_t1"], temple).rareTier,
    ).not.toBe("SS");
    // Former Irradiated A|A pair must not promote on Temple (both B / Junk)
    expect(
      classifyModCombo(
        ["junk_monster_eff_t1", "junk_map_mods_t1"],
        temple,
      ).rareTier,
    ).not.toBe("SS");
  });

  it("Breach potency+unstable still promote under breach_tablet map", () => {
    expect(
      classifyModCombo(
        ["breach_rare_potency_t1", "breach_unstable_rare_t1"],
        breach,
      ).rareTier,
    ).toBe("SS");
    expect(modQualityTierForBase(breach, "breach_unstable_rare_t1")).toBe(
      "S",
    );
    expect(modQualityTierForBase(breach, "breach_hiveblood_t1")).toBe("S");
    expect(modQualityTierForBase(breach, "breach_rare_potency_t1")).toBe(
      "A",
    );
  });
});

describe("post-0.5.4 sealed quality tags (per-base)", () => {
  it("marks Ritual / Abyss / Expedition / Overseer jackpots as S", () => {
    expect(modQualityTierForBase("ritual_tablet", "ritual_reroll_t1")).toBe(
      "S",
    );
    expect(modQualityTierForBase("abyss_tablet", "abyss_rare_spawn_t1")).toBe(
      "S",
    );
    expect(modQualityTierForBase("abyss_tablet", "abyss_four_chance_t1")).toBe(
      "S",
    );
    expect(
      modQualityTierForBase("expedition_tablet", "expedition_remnants_t1"),
    ).toBe("S");
    expect(
      modQualityTierForBase("expedition_tablet", "expedition_logbook_t1"),
    ).toBe("S");
    expect(
      modQualityTierForBase("overseer_tablet", "junk_extra_azmeri_t1"),
    ).toBe("S");
    expect(
      modQualityTierForBase("overseer_tablet", "junk_azmeri_chance_t1"),
    ).toBe("S");
    expect(modQualityTierForBase(temple, "temple_crystal_t1")).toBe("S");
  });

  it("demotes Abyss desecrated/depths and Domain splinters to Junk", () => {
    expect(
      modQualityTierForBase("abyss_tablet", "abyss_desecrated_t1"),
    ).toBe("Junk");
    expect(modQualityTierForBase("abyss_tablet", "abyss_depths_t1")).toBe(
      "Junk",
    );
    expect(modQualityTierForBase(breach, "breach_splinter_qty_t1")).toBe(
      "Junk",
    );
    expect(modQualityTierForBase("ritual_tablet", "ritual_omen_t1")).toBe(
      "A",
    );
    expect(
      modQualityTierForBase("delirium_tablet", "delirium_fracturing_t1"),
    ).toBe("A");
    expect(modQualityTierForBase(irradiated, "junk_monster_eff_t1")).toBe(
      "A",
    );
    expect(modQualityTierForBase(irradiated, "junk_map_mods_t1")).toBe("S");
  });

  it("keeps WEIGHT_BENCH out of EV until fitted", () => {
    expect(WEIGHT_BENCH.some((r) => r.id === "ritual_reroll_t1")).toBe(true);
    expect(WEIGHT_BENCH.every((r) => r.holdReason.length > 0)).toBe(true);
  });
});
