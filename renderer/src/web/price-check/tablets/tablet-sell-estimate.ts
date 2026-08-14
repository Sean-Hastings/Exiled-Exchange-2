import {
  buildTierSaleTable,
  corruptSaleEx,
  listSaleEx,
  modsToRareTier,
  type RareTier,
} from "./tablet-mdp";
import { priceAtRoll } from "./mod-roll-price-curve";
import { templeCrystalRollCurve } from "./temple-manual-market";
import { modQualityTierForBase } from "./mod-tiers";
import type { MarketPriceCache } from "./tablet-ev-calculator";
import type { ParsedTabletItem, ParsedTabletMod } from "./tablet-types";

export type TabletSellBasis =
  | "roll-curve"
  | "measured-combo"
  | "tier-ask"
  | "unknown";

export interface TabletSellEstimate {
  sellEx: number;
  rareTier: RareTier;
  basis: TabletSellBasis;
  /** Short human detail, e.g. "crystal 9 → 1561ex" */
  detail: string;
}

/** Mods with measured roll→price curves (high-tier sell estimates). */
function rollCurveForMod(modId: string) {
  if (modId === "temple_crystal_t1") return templeCrystalRollCurve();
  return null;
}

function measuredComboAsk(
  market: MarketPriceCache,
  mods: ParsedTabletMod[],
): number {
  const prefixes = mods.filter((m) => m.isPrefix);
  const suffixes = mods.filter((m) => !m.isPrefix);
  if (!prefixes.length || !suffixes.length) return Number.NaN;
  let best = Number.NaN;
  for (const p of prefixes) {
    for (const s of suffixes) {
      const v = market.modValueMap[`${p.id}+${s.id}`];
      if (!(v != null && Number.isFinite(v) && v > 0)) continue;
      best = Number.isFinite(best) ? Math.max(best, v) : v;
    }
  }
  return best;
}

/**
 * Sell estimate for a parsed tablet: rare tier + (on S/A) roll curves when
 * available. Never invents prices — missing data stays NaN.
 */
export function estimateTabletSellPrice(
  parsed: ParsedTabletItem,
  market: MarketPriceCache,
): TabletSellEstimate {
  const modIds = parsed.parsedMods.map((m) => m.id);
  const rareTier = modIds.length
    ? modsToRareTier(modIds, parsed.tabletBaseKey)
    : "Trash";
  const sales = buildTierSaleTable(market, parsed.tabletBaseKey);
  const tierAsk = sales
    ? parsed.isCorrupted
      ? corruptSaleEx(sales, rareTier)
      : listSaleEx(sales, rareTier)
    : Number.NaN;

  // High tiers: roll-specific curve on S-quality mods (e.g. crystal %)
  if (rareTier === "S" || rareTier === "A") {
    let bestRoll = Number.NaN;
    let detail = "";
    for (const m of parsed.parsedMods) {
      if (modQualityTierForBase(parsed.tabletBaseKey, m.id) !== "S") continue;
      const curve = rollCurveForMod(m.id);
      if (!curve || !Number.isFinite(m.rolledValue)) continue;
      const p = priceAtRoll(curve, m.rolledValue);
      if (!Number.isFinite(p)) continue;
      if (!Number.isFinite(bestRoll) || p > bestRoll) {
        bestRoll = p;
        const short = m.id.replace(/_t\d+$/, "").replace(/^temple_/, "");
        detail = `${short} ${m.rolledValue} → ${Math.round(p)}ex`;
      }
    }
    if (Number.isFinite(bestRoll)) {
      return {
        sellEx: bestRoll,
        rareTier,
        basis: "roll-curve",
        detail,
      };
    }
  }

  const combo = measuredComboAsk(market, parsed.parsedMods);
  if (Number.isFinite(combo)) {
    return {
      sellEx: combo,
      rareTier,
      basis: "measured-combo",
      detail: `tier ${rareTier} measured combo`,
    };
  }

  if (Number.isFinite(tierAsk)) {
    return {
      sellEx: tierAsk,
      rareTier,
      basis: "tier-ask",
      detail: `tier ${rareTier} ask`,
    };
  }

  return {
    sellEx: Number.NaN,
    rareTier,
    basis: "unknown",
    detail: "no measured ask",
  };
}
