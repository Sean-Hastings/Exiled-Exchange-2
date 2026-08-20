import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import {
  RARE_TIERS,
  classifyModCombo,
  modComboToRareTier,
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

/**
 * 1p×1s grid for the selected base, plus custom / override-only combos.
 * Includes auto SS/S/A rows and any override (including B/Trash).
 */
export function enumerateComboTierRows(
  baseId: string,
  market?: MarketPriceCache,
): ComboTierRow[] {
  const base = TABLET_BASES[baseId];
  if (!base) return [];

  const rows = new Map<string, ComboTierRow>();

  const addRow = (modIds: string[]) => {
    const comboKey = canonicalComboKey(baseId, modIds);
    if (!comboKey) return;

    const classified = classifyModCombo(modIds, baseId);
    const autoTier = modComboToRareTier(modIds, baseId);
    const { tier, source } = rareTierForCombo(modIds, baseId);
    const override = getComboTierOverride(baseId, comboKey);
    const hasOverride = source === "override";

    if (!PREMIUM_AUTO.has(autoTier) && !hasOverride) return;

    const rawPrice = market?.modValueMap?.[comboKey];
    const measuredEx =
      rawPrice != null && Number.isFinite(rawPrice) ? rawPrice : undefined;

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

  for (const pId of base.allowedPrefixPool) {
    for (const sId of base.allowedSuffixPool) {
      addRow([pId, sId]);
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
