import { describe, expect, it } from "vitest";
import { TabletRegexBuilder } from "@/web/price-check/tablets";
import { getHighValueModsForBase } from "@/web/price-check/tablets/mod-weights";

describe("TabletRegexBuilder", () => {
  it("never exceeds 50 characters", () => {
    const mods = getHighValueModsForBase("delirium_tablet", 40);
    const regex = TabletRegexBuilder.buildOptimizedRegex(
      mods.map((m) => ({
        id: m.id,
        name: m.name,
        regexHint: m.regexHint,
        minDesiredValue: m.minValue,
        priority: m.valueScore,
        highlightCategory: "high_value" as const,
      })),
    );
    expect(regex.length).toBeLessThanOrEqual(50);
    expect(TabletRegexBuilder.withinLimit(regex)).toBe(true);
  });

  it("trims lowest-priority patterns when over budget", () => {
    const regex = TabletRegexBuilder.buildOptimizedRegex([
      {
        id: "a",
        name: "aaaaaaaaaaaaaaaaaaaa",
        regexHint: "aaaaaaaaaaaaaaaaaaaa",
        priority: 10,
        highlightCategory: "high_value",
      },
      {
        id: "b",
        name: "bbbbbbbbbbbbbbbbbbbb",
        regexHint: "bbbbbbbbbbbbbbbbbbbb",
        priority: 5,
        highlightCategory: "high_value",
      },
      {
        id: "c",
        name: "cccccccccccccccccccc",
        regexHint: "cccccccccccccccccccc",
        priority: 1,
        highlightCategory: "high_value",
      },
    ]);
    expect(regex.length).toBeLessThanOrEqual(50);
    expect(regex.startsWith('"')).toBe(true);
    expect(regex.endsWith('"')).toBe(true);
  });

  it("builds pack-size style patterns", () => {
    const regex = TabletRegexBuilder.buildOptimizedRegex([
      {
        id: "map_pack_size_t1",
        name: "#% increased Pack Size in Map",
        minDesiredValue: 8,
        priority: 90,
        highlightCategory: "high_value",
      },
    ]);
    expect(regex).toContain("pa");
    expect(regex.length).toBeLessThanOrEqual(50);
  });

  it("returns empty quoted string for no targets", () => {
    expect(TabletRegexBuilder.buildOptimizedRegex([])).toBe('""');
  });
});
