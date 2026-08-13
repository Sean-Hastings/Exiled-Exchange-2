import { ItemCategory, ItemRarity, type ParsedItem } from "@/parser";
import { ModifierType } from "@/parser/modifiers";
import {
  findTabletBaseByName,
  TABLET_BASES,
  TABLET_MOD_WEIGHTS,
} from "./mod-weights";
import type { ParsedTabletItem, ParsedTabletMod } from "./tablet-types";

const USES_REMAINING = /(\d+)\s+uses?\s+remaining/i;

/**
 * Detect tablet clipboard dumps before / without full parseClipboard.
 * Returns null when the text is not a Precursor / Tower tablet.
 */
export function parseTablet(rawLines: string[]): ParsedTabletItem | null {
  const joined = rawLines.join("\n");
  const isTablet =
    rawLines.some((l) => /Item Class:\s*Tablet/i.test(l)) ||
    rawLines.some((l) => /\bTablet\b/i.test(l));
  if (!isTablet) return null;

  let baseDef = null as ReturnType<typeof findTabletBaseByName>;
  for (const line of rawLines) {
    baseDef = findTabletBaseByName(line);
    if (baseDef) break;
  }
  if (!baseDef) {
    // Fallback: generic irradiated when class is Tablet but base unknown
    if (!/Item Class:\s*Tablet/i.test(joined)) return null;
    baseDef = TABLET_BASES.irradiated_tablet;
  }

  const parsedMods: ParsedTabletMod[] = [];
  const seen = new Set<string>();

  for (const line of rawLines) {
    for (const mod of Object.values(TABLET_MOD_WEIGHTS)) {
      const pool = [
        ...baseDef.allowedPrefixPool,
        ...baseDef.allowedSuffixPool,
      ];
      const allowedOnBase =
        pool.includes(mod.id) ||
        mod.category === baseDef.category ||
        // shared map mods
        mod.id.startsWith("map_");
      if (!allowedOnBase) continue;

      const match = line.match(mod.statPattern);
      if (!match) continue;

      // Flat mods (no numeric roll) omit a capture — use minValue as the roll.
      const rolledValue =
        match[1] != null && match[1] !== ""
          ? parseFloat(match[1])
          : mod.minValue;
      if (Number.isNaN(rolledValue)) continue;
      if (rolledValue < mod.minValue || rolledValue > mod.maxValue) continue;

      const sameStat = parsedMods.findIndex(
        (m) => TABLET_MOD_WEIGHTS[m.id]?.tradeStatId === mod.tradeStatId,
      );
      if (sameStat >= 0) {
        const existing = TABLET_MOD_WEIGHTS[parsedMods[sameStat].id];
        // Keep closer tier / higher valueScore
        if (existing && existing.tier <= mod.tier) continue;
        seen.delete(parsedMods[sameStat].id);
        parsedMods.splice(sameStat, 1);
      }

      if (seen.has(mod.id)) continue;
      seen.add(mod.id);
      parsedMods.push({
        id: mod.id,
        rawText: line.trim(),
        rolledValue,
        tier: mod.tier,
        isPrefix: mod.isPrefix,
        valueScore: mod.valueScore,
      });
    }
  }

  const usesMatch = joined.match(USES_REMAINING);
  const rarityLine = rawLines.find((l) => /^Rarity:/i.test(l));

  return {
    isTablet: true,
    tabletBaseKey: baseDef.id,
    category: baseDef.category,
    baseName: baseDef.name,
    rarity: rarityLine?.replace(/^Rarity:\s*/i, "").trim(),
    isCorrupted: rawLines.some((l) => /^Corrupted$/i.test(l.trim())),
    parsedMods,
    usesRemaining: usesMatch ? parseInt(usesMatch[1], 10) : undefined,
  };
}

/**
 * Enrich an already-parsed EE2 item with tablet-specific metadata.
 */
export function parseTabletFromItem(
  item: ParsedItem,
): ParsedTabletItem | null {
  if (item.category !== ItemCategory.Tablet) {
    // Still try raw text for robustness
    const fromRaw = parseTablet(item.rawText.split(/\r?\n/));
    if (!fromRaw) return null;
    return fromRaw;
  }

  const baseDef =
    findTabletBaseByName(item.info.refName) ||
    findTabletBaseByName(item.info.name) ||
    null;

  if (!baseDef) {
    return parseTablet(item.rawText.split(/\r?\n/));
  }

  const parsedMods: ParsedTabletMod[] = [];
  for (const calc of item.statsByType) {
    if (
      calc.type !== ModifierType.Explicit &&
      calc.type !== ModifierType.Fractured
    ) {
      continue;
    }
    const value = calc.sources[0]?.contributes?.value;
    const candidates = Object.values(TABLET_MOD_WEIGHTS).filter((m) => {
      const explicitIds = calc.stat.trade.ids.explicit ?? [];
      return (
        m.statRef === calc.stat.ref || explicitIds.includes(m.tradeStatId)
      );
    });
    if (!candidates.length || value == null) continue;

    const tierMatch =
      candidates.find(
        (m) => value >= m.minValue && value <= m.maxValue,
      ) ?? candidates.sort((a, b) => a.tier - b.tier)[0];

    parsedMods.push({
      id: tierMatch.id,
      rawText: calc.stat.ref,
      rolledValue: value,
      tier: tierMatch.tier,
      isPrefix: tierMatch.isPrefix,
      valueScore: tierMatch.valueScore,
    });
  }

  // Fall back to line parser if stats didn't map
  if (!parsedMods.length) {
    const fromRaw = parseTablet(item.rawText.split(/\r?\n/));
    if (fromRaw) return fromRaw;
  }

  const usesStat = item.statsByType.find((s) =>
    /uses? remaining/i.test(s.stat.ref),
  );

  return {
    isTablet: true,
    tabletBaseKey: baseDef.id,
    category: baseDef.category,
    baseName: baseDef.name,
    rarity: item.rarity,
    isCorrupted: item.isCorrupted,
    parsedMods,
    usesRemaining: usesStat?.sources[0]?.contributes?.value,
  };
}

export function isTabletItem(item: ParsedItem): boolean {
  return (
    item.category === ItemCategory.Tablet ||
    /\bTablet\b/i.test(item.info.refName) ||
    /\bTablet\b/i.test(item.rawText.split(/\r?\n/).slice(0, 6).join("\n"))
  );
}

export function tabletRarityLabel(item: ParsedItem): string {
  switch (item.rarity) {
    case ItemRarity.Normal:
      return "Normal";
    case ItemRarity.Magic:
      return "Magic";
    case ItemRarity.Rare:
      return "Rare";
    case ItemRarity.Unique:
      return "Unique";
    default:
      return "Unknown";
  }
}