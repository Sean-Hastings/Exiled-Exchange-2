import { describe, expect, it } from "vitest";
import { parseTablet } from "@/web/price-check/tablets/tablet-parser";

const rareDeliriumTablet = `Item Class: Tablet
Rarity: Rare
Planar Challenge
Delirium Precursor Tablet
--------
Item Level: 84
--------
{ Implicit Modifier }
Adds a Mirror of Delirium to a Map
17 uses remaining
--------
{ Prefix Modifier "Breeding" }
10% increased Pack Size in Map
{ Prefix Modifier "Teeming" }
Map has 40% increased Magic Monsters
{ Suffix Modifier "of the Simulacrum" (Tier: 1) }
20% increased Stack size of Simulacrum Splinters found in Map
{ Suffix Modifier "of Phobia" (Tier: 1) }
Delirium Encounters in Map are 20% more likely to spawn Unique Bosses
--------
Can be used in a personal Map Device to add modifiers to a Map.
--------
Corrupted
--------
Note: ~b/o 1 exalted
`;

const magicBreachTablet = `Item Class: Tablet
Rarity: Magic
Breach Tablet of Splinters
--------
Item Level: 70
--------
Adds an Otherworldy Breach to a Map
8 uses remaining
--------
25% increased Quantity of Breach Splinters dropped by Breach Monsters in Map
`;

const normalExpedition = `Item Class: Tablet
Rarity: Normal
Expedition Tablet
--------
Item Level: 65
--------
Adds a Kalguuran Expedition to a Map
10 uses remaining
`;

describe("parseTablet", () => {
  it("parses rare corrupted delirium tablet mods", () => {
    const parsed = parseTablet(rareDeliriumTablet.split(/\r?\n/));
    expect(parsed).not.toBeNull();
    expect(parsed!.isTablet).toBe(true);
    expect(parsed!.tabletBaseKey).toBe("delirium_tablet");
    expect(parsed!.category).toBe("Delirium");
    expect(parsed!.isCorrupted).toBe(true);
    expect(parsed!.usesRemaining).toBe(17);
    expect(parsed!.parsedMods.some((m) => m.id.includes("pack_size"))).toBe(
      true,
    );
    expect(
      parsed!.parsedMods.some((m) => m.id.includes("delirium_splinter")),
    ).toBe(true);
    expect(
      parsed!.parsedMods.some((m) => m.id.includes("delirium_boss")),
    ).toBe(true);
  });

  it("parses magic breach tablet", () => {
    const parsed = parseTablet(magicBreachTablet.split(/\r?\n/));
    expect(parsed).not.toBeNull();
    expect(parsed!.tabletBaseKey).toBe("breach_tablet");
    expect(parsed!.parsedMods.some((m) => m.id.includes("splinter"))).toBe(
      true,
    );
  });

  it("parses normal tablet with no explicits", () => {
    const parsed = parseTablet(normalExpedition.split(/\r?\n/));
    expect(parsed).not.toBeNull();
    expect(parsed!.tabletBaseKey).toBe("expedition_tablet");
    expect(parsed!.parsedMods).toHaveLength(0);
    expect(parsed!.usesRemaining).toBe(10);
  });

  it("returns null for non-tablet text", () => {
    const parsed = parseTablet([
      "Item Class: Waystones",
      "Rarity: Rare",
      "Waystone (Tier 14)",
    ]);
    expect(parsed).toBeNull();
  });
});
