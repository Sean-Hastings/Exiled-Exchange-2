import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import {
  RARE_TIERS,
  classifyModCombo,
  modComboToRareTier,
  modQualityTierForBase,
  type RareTier,
  type SidePattern,
} from "./mod-tiers";
import type { MarketPriceCache } from "./tablet-ev-calculator";
import {
  comboTierOverridesForBase,
  canonicalComboKey,
  getComboTierOverride,
  rareTierForCombo,
} from "./combo-tier-overrides";

export interface ComboTierRow {
  comboKey: string;
  modIds: string[];
  modLabels: string[];
  autoTier: RareTier;
  tier: RareTier;
  source: "override" | "auto";
  isCustom: boolean;
  measuredEx?: number;
  prefixSide?: SidePattern;
  suffixSide?: SidePattern;
}

const PREMIUM_AUTO = new Set<RareTier>(["SS", "S", "A"]);

function tierRank(tier: RareTier): number {
  return RARE_TIERS.indexOf(tier);
}

function hasJunkMod(modIds: string[], baseId: string): boolean {
  return modIds.some((id) => modQualityTierForBase(baseId, id) === "Junk");
}

/**
 * Cross-side 1p×1s plus same-side 2p / 2s pairs for the selected base,
 * plus custom / override-only combos.
 * Auto rows are non-Junk SS/S/A only; overrides (incl. Junk / B / Trash) still show.
 */
export function enumerateComboTierRows(
  baseId: string,
  market?: MarketPriceCache,
): ComboTierRow[] {
  const base = TABLET_BASES[baseId];
  if (!base) return [];

  const rows = new Map<string, ComboTierRow>();
  const prefixes = base.allowedPrefixPool;
  const suffixes = base.allowedSuffixPool;

  const addRow = (modIds: string[]) => {
    const comboKey = canonicalComboKey(baseId, modIds);
    if (!comboKey) return;

    const classified = classifyModCombo(modIds, baseId);
    const autoTier = modComboToRareTier(modIds, baseId);
    const { tier, source } = rareTierForCombo(modIds, baseId);
    const override = getComboTierOverride(baseId, comboKey);
    const hasOverride = source === "override";

    if (hasJunkMod(modIds, baseId) && !hasOverride) return;
    if (!PREMIUM_AUTO.has(autoTier) && !hasOverride) return;

    const rawPrice = market?.modValueMap?.[comboKey];
    let measuredEx =
      rawPrice != null && Number.isFinite(rawPrice) ? rawPrice : undefined;
    if (measuredEx == null && market?.measuredAffixSamples?.length) {
      const sorted = [...modIds].sort();
      const sample = market.measuredAffixSamples.find(
        (s) =>
          s.baseId === baseId &&
          s.modIds.length === sorted.length &&
          s.modIds.every((id, i) => id === sorted[i]),
      );
      if (sample != null && Number.isFinite(sample.sellEx) && sample.sellEx > 0) {
        measuredEx = sample.sellEx;
      }
    }

    rows.set(comboKey, {
      comboKey,
      modIds: [...modIds],
      modLabels: modIds.map((id) => TABLET_MOD_WEIGHTS[id]?.name ?? id),
      autoTier,
      tier,
      source,
      isCustom: !!override?.isCustom,
      measuredEx,
      prefixSide: classified.prefixSide,
      suffixSide: classified.suffixSide,
    });
  };

  for (const pId of prefixes) {
    for (const sId of suffixes) {
      addRow([pId, sId]);
    }
  }

  for (let i = 0; i < suffixes.length; i++) {
    for (let j = i + 1; j < suffixes.length; j++) {
      addRow([suffixes[i]!, suffixes[j]!]);
    }
  }

  for (let i = 0; i < prefixes.length; i++) {
    for (let j = i + 1; j < prefixes.length; j++) {
      addRow([prefixes[i]!, prefixes[j]!]);
    }
  }

  for (const entry of comboTierOverridesForBase(baseId)) {
    if (!rows.has(entry.comboKey)) addRow(entry.modIds);
  }

  const result = [...rows.values()];
  result.sort((a, b) => {
    const aMarked = a.source === "override" || a.isCustom;
    const bMarked = b.source === "override" || b.isCustom;
    if (aMarked !== bMarked) return aMarked ? -1 : 1;
    const tr = tierRank(b.tier) - tierRank(a.tier);
    if (tr !== 0) return tr;
    return a.comboKey.localeCompare(b.comboKey);
  });
  return result;
}
