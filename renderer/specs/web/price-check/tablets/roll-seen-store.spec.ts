import { describe, expect, it } from "vitest";
import {
  aggregateRawSeen,
  attributeModSide,
  sanitizeRollSeenDocument,
  SideAttributionError,
} from "@/web/price-check/tablets/roll-seen-store";
import type { RollSeenDocument } from "@/web/price-check/tablets/roll-seen-types";
import { ROLL_SEEN_REVISION } from "@/web/price-check/tablets/roll-seen-types";

function doc(batches: RollSeenDocument["batches"]): RollSeenDocument {
  return { revision: ROLL_SEEN_REVISION, updatedAt: 1, batches };
}

describe("roll-seen-store", () => {
  it("attributes temple crystal to suffix pool", () => {
    expect(attributeModSide("temple_tablet", "temple_crystal_t1")).toBe(
      "suffix",
    );
  });

  it("rejects neither-pool membership", () => {
    expect(() =>
      attributeModSide("temple_tablet", "not_a_real_mod"),
    ).toThrow(SideAttributionError);
  });

  it("excludes empty/null hits and includes explicit 0", () => {
    const agg = aggregateRawSeen(
      doc([
        {
          id: "a",
          baseId: "temple_tablet",
          createdAt: 1,
          updatedAt: 1,
          affixesPerTablet: 4,
          tablets: 10,
          // T=40 → prefix 20, suffix 20
          hits: [
            { modId: "temple_crystal_t1", hits: 0 },
            { modId: "temple_chest_rare_t1", hits: null },
          ],
        },
      ]),
    );
    const crystal = agg.cells.find((c) => c.modId === "temple_crystal_t1");
    expect(crystal).toBeTruthy();
    expect(crystal!.hits).toBe(0);
    expect(crystal!.trials).toBe(20);
    expect(agg.cells.find((c) => c.modId === "temple_chest_rare_t1")).toBeUndefined();
  });

  it("sums multi-batch hits and accumulates sideTrials regardless of hits", () => {
    const agg = aggregateRawSeen(
      doc([
        {
          id: "a",
          baseId: "temple_tablet",
          createdAt: 1,
          updatedAt: 1,
          affixesPerTablet: 4,
          tablets: 5,
          hits: [{ modId: "temple_crystal_t1", hits: 2 }],
        },
        {
          id: "b",
          baseId: "temple_tablet",
          createdAt: 2,
          updatedAt: 2,
          affixesPerTablet: 4,
          tablets: 5,
          hits: [], // no measured mods, but sideTrials still accumulate
        },
      ]),
    );
    const crystal = agg.cells.find((c) => c.modId === "temple_crystal_t1")!;
    expect(crystal.hits).toBe(2);
    // only first batch measured crystal → trials = 10 (suffix of first)
    expect(crystal.trials).toBe(10);
    const suf = agg.sideTrials.find(
      (s) => s.baseId === "temple_tablet" && s.side === "suffix",
    )!;
    // both batches: 10+10
    expect(suf.sideTrials).toBe(20);
  });

  it("splits prefix vs suffix trials for measured mods", () => {
    const agg = aggregateRawSeen(
      doc([
        {
          id: "a",
          baseId: "breach_tablet",
          createdAt: 1,
          updatedAt: 1,
          affixesPerTablet: 4,
          tablets: 10,
          hits: [
            { modId: "junk_monster_eff_t1", hits: 3 }, // shared prefix
            { modId: "breach_rare_potency_t1", hits: 1 }, // suffix
          ],
        },
      ]),
    );
    const pref = agg.cells.find((c) => c.modId === "junk_monster_eff_t1")!;
    const suf = agg.cells.find((c) => c.modId === "breach_rare_potency_t1")!;
    expect(pref.side).toBe("prefix");
    expect(suf.side).toBe("suffix");
    expect(pref.trials).toBe(20);
    expect(suf.trials).toBe(20);
  });

  it("sanitizeRollSeenDocument drops corrupt batches", () => {
    const cleaned = sanitizeRollSeenDocument({
      revision: ROLL_SEEN_REVISION,
      updatedAt: 1,
      batches: [
        {
          id: "ok",
          baseId: "temple_tablet",
          createdAt: 1,
          updatedAt: 1,
          affixesPerTablet: 4,
          tablets: 2,
          hits: [{ modId: "temple_crystal_t1", hits: 1 }],
        },
        { id: "bad", baseId: "not_a_base", hits: "nope" },
        null,
        {
          id: "bad2",
          baseId: "temple_tablet",
          createdAt: 1,
          updatedAt: 1,
          affixesPerTablet: 4,
          tablets: 1,
          hits: [{ modId: 123, hits: "x" }],
        },
      ],
    });
    expect(cleaned.batches.map((b) => b.id)).toEqual(["ok", "bad2"]);
    expect(cleaned.batches[1]!.hits).toEqual([]);
    // unknown base / null / malformed batch objects dropped
    expect(cleaned.batches.find((b) => b.id === "bad")).toBeUndefined();
  });

  it("aggregateRawSeen skips bad mod attribution without throwing", () => {
    const agg = aggregateRawSeen(
      doc([
        {
          id: "a",
          baseId: "temple_tablet",
          createdAt: 1,
          updatedAt: 1,
          affixesPerTablet: 4,
          tablets: 5,
          hits: [
            { modId: "not_in_any_pool_xyz", hits: 2 },
            { modId: "temple_crystal_t1", hits: 1 },
          ],
        },
      ]),
    );
    expect(agg.cells.find((c) => c.modId === "not_in_any_pool_xyz")).toBeUndefined();
    expect(agg.cells.find((c) => c.modId === "temple_crystal_t1")?.hits).toBe(1);
  });

  it("sanitizeRollSeenDocument accepts file-shaped empty seed", () => {
    const cleaned = sanitizeRollSeenDocument({
      revision: ROLL_SEEN_REVISION,
      updatedAt: 0,
      batches: [],
    });
    expect(cleaned.revision).toBe(ROLL_SEEN_REVISION);
    expect(cleaned.updatedAt).toBe(0);
    expect(cleaned.batches).toEqual([]);
  });

  it("sanitizeRollSeenDocument keeps valid batches from repo-shaped docs", () => {
    const cleaned = sanitizeRollSeenDocument({
      revision: ROLL_SEEN_REVISION,
      updatedAt: 42,
      batches: [
        {
          id: "seed-1",
          baseId: "breach_tablet",
          createdAt: 10,
          updatedAt: 20,
          affixesPerTablet: 4,
          tablets: 3,
          hits: [{ modId: "breach_rare_potency_t1", hits: 2 }],
        },
      ],
    });
    expect(cleaned.batches).toHaveLength(1);
    expect(cleaned.batches[0]!.hits[0]!.hits).toBe(2);
    expect(cleaned.updatedAt).toBe(42);
  });
});
