import { describe, expect, it } from "vitest";
import {
  SIDE_SCORE,
  classifyModCombo,
  classifySide,
  comboScoreToRareTier,
  itemComboScore,
} from "@/web/price-check/tablets/mod-tiers";

describe("multi-affix combo tiering", () => {
  it("side ladder: SS > SA > S > AA > A > B", () => {
    expect(SIDE_SCORE.SS).toBeGreaterThan(SIDE_SCORE.SA);
    expect(SIDE_SCORE.SA).toBeGreaterThan(SIDE_SCORE.S);
    expect(SIDE_SCORE.S).toBeGreaterThan(SIDE_SCORE.AA);
    expect(SIDE_SCORE.AA).toBeGreaterThan(SIDE_SCORE.A);
    expect(SIDE_SCORE.A).toBeGreaterThan(SIDE_SCORE.B);
  });

  it("classifies suffix doubles and mixes", () => {
    expect(
      classifySide(["breach_splinter_qty_t1", "delirium_splinter_stack_t1"]),
    ).toBe("SS");
    expect(
      classifySide(["breach_splinter_qty_t1", "breach_splinter_qty_t2"]),
    ).toBe("SA");
    expect(classifySide(["breach_splinter_qty_t1", "junk_extra_shrine_t1"])).toBe(
      "S",
    );
    expect(
      classifySide(["breach_splinter_qty_t2", "delirium_splinter_stack_t2"]),
    ).toBe("AA");
    expect(classifySide(["breach_pack_size_t1", "junk_extra_shrine_t1"])).toBe(
      "A",
    );
    expect(classifySide(["breach_hiveblood_t1", "junk_extra_shrine_t1"])).toBe(
      "B",
    );
  });

  it("solo S scores above double A (same MDP bucket A)", () => {
    const soloS = itemComboScore([
      "junk_gold_t1",
      "junk_xp_t1",
      "breach_splinter_qty_t1",
      "junk_extra_shrine_t1",
    ]);
    const doubleA = itemComboScore([
      "junk_gold_t1",
      "junk_xp_t1",
      "breach_splinter_qty_t2",
      "delirium_splinter_stack_t2",
    ]);
    expect(soloS).toBeGreaterThan(doubleA);
    expect(comboScoreToRareTier(soloS)).toBe("A");
    expect(comboScoreToRareTier(doubleA)).toBe("A");
  });

  it("SS or SA (same side or cross) → MDP S (divine)", () => {
    // 2× S suffixes
    expect(
      classifyModCombo([
        "junk_gold_t1",
        "junk_xp_t1",
        "breach_splinter_qty_t1",
        "map_waystone_qty_t1",
      ]).rareTier,
    ).toBe("S");
    // S+A suffixes
    expect(
      classifyModCombo([
        "junk_gold_t1",
        "junk_xp_t1",
        "breach_splinter_qty_t1",
        "breach_splinter_qty_t2",
      ]).rareTier,
    ).toBe("S");
    // Cross: A prefix + S suffix
    expect(
      classifyModCombo([
        "breach_pack_size_t1",
        "junk_xp_t1",
        "breach_splinter_qty_t1",
        "junk_extra_shrine_t1",
      ]).rareTier,
    ).toBe("S");
  });

  it("solo A → B; junk → Trash", () => {
    expect(
      classifyModCombo([
        "breach_pack_size_t1",
        "junk_xp_t1",
        "junk_extra_shrine_t1",
        "junk_extra_strongbox_t1",
      ]).rareTier,
    ).toBe("B");
    expect(
      classifyModCombo([
        "junk_gold_t1",
        "junk_xp_t1",
        "junk_extra_shrine_t1",
        "junk_extra_strongbox_t1",
      ]).rareTier,
    ).toBe("Trash");
  });

  it("1p+1s pairs use the same scorer", () => {
    // A prefix + S suffix → cross SA → S
    expect(
      classifyModCombo(["breach_pack_size_t1", "breach_splinter_qty_t1"])
        .rareTier,
    ).toBe("S");
    // A prefix + B hiveblood → B (hiveblood dump on SC)
    expect(
      classifyModCombo(["breach_pack_size_t1", "breach_hiveblood_t1"]).rareTier,
    ).toBe("B");
    // A|A cross (potency + unstable) → MDP S (SC liquid ~329ex)
    expect(
      classifyModCombo([
        "breach_rare_potency_t1",
        "junk_xp_t1",
        "breach_unstable_rare_t1",
        "junk_extra_shrine_t1",
      ]).rareTier,
    ).toBe("S");
  });
});

