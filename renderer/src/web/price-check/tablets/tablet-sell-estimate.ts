import {
  buildTierSaleTable,
  corruptSaleEx,
  listSaleEx,
  modsToRareTier,
  type RareTier,
} from "./tablet-mdp";
import { modRollCurveKey, priceAtRoll } from "./mod-roll-price-curve";
import type { ModRollPriceCurve } from "./mod-roll-price-curve";
import { templeCrystalRollCurve } from "./temple-manual-market";
import { modQualityTierForBase } from "./mod-tiers";
import type { PriceSource } from "./market-sanity";
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
  priceSource: PriceSource;
}

/** Prefer live measured S-roll curve; Temple crystal falls back to survey anchors. */
export function rollCurveForMod(
  market: MarketPriceCache,
  baseId: string,
  modId: string,
): { curve: ModRollPriceCurve; source: PriceSource } | null {
  const live = market.modRollCurves?.[modRollCurveKey(baseId, modId)];
  if (live) return { curve: live, source: "measured" };
  if (modId === "temple_crystal_t1") {
    const survey = templeCrystalRollCurve();
    if (survey) return { curve: survey, source: "manual-survey" };
  }
  return null;
}

function measuredComboAsk(
  market: MarketPriceCache,
  mods: ParsedTabletMod[],
): { value: number; source: PriceSource } {
  const prefixes = mods.filter((m) => m.isPrefix);
  const suffixes = mods.filter((m) => !m.isPrefix);
  if (!prefixes.length || !suffixes.length) {
    return { value: Number.NaN, source: "measured" };
  }
  let best = Number.NaN;
  let source: PriceSource = "measured";
  for (const p of prefixes) {
    for (const s of suffixes) {
      const key = `${p.id}+${s.id}`;
      const v = market.modValueMap[key];
      if (!(v != null && Number.isFinite(v) && v > 0)) continue;
      if (!Number.isFinite(best) || v > best) {
        best = v;
        source = market.priceSource?.modValueMap?.[key] ?? "measured";
      }
    }
  }
  return { value: best, source };
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
    let priceSource: PriceSource = "measured";
    for (const m of parsed.parsedMods) {
      if (modQualityTierForBase(parsed.tabletBaseKey, m.id) !== "S") continue;
      const hit = rollCurveForMod(market, parsed.tabletBaseKey, m.id);
      if (!hit || !Number.isFinite(m.rolledValue)) continue;
      const p = priceAtRoll(hit.curve, m.rolledValue);
      if (!Number.isFinite(p)) continue;
      if (!Number.isFinite(bestRoll) || p > bestRoll) {
        bestRoll = p;
        priceSource = hit.source;
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
        priceSource,
      };
    }
  }

  // Trash/B sale is the dump floor (`junkSellByBase`). Combo keys are global
  // and Temple survey junk+junk pairs used to leak across every base.
  if (rareTier !== "Trash" && rareTier !== "B") {
    const combo = measuredComboAsk(market, parsed.parsedMods);
    if (Number.isFinite(combo.value)) {
      return {
        sellEx: combo.value,
        rareTier,
        basis: "measured-combo",
        detail: `tier ${rareTier} measured combo`,
        priceSource: combo.source,
      };
    }
  }

  if (Number.isFinite(tierAsk)) {
    return {
      sellEx: tierAsk,
      rareTier,
      basis: "tier-ask",
      detail: `tier ${rareTier} ask`,
      priceSource: sales?.uncorruptedSource[rareTier] ?? "measured",
    };
  }

  return {
    sellEx: Number.NaN,
    rareTier,
    basis: "unknown",
    detail: "no measured ask",
    priceSource: "measured",
  };
}
