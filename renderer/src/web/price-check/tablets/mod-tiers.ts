import { TABLET_MOD_WEIGHTS } from "./mod-weights";
import type { TabletCategory } from "./tablet-types";
import type { ModQualityTier } from "./strat-types";

/**
 * S/A/B tier tags + multi-affix combo scoring.
 *
 * SIDE_SCORE / MDP cutoffs are a working prior aligned with strat_reco.md.
 * **Breach** is the calibration base via the live trade tier survey
 * (`tier-survey.md`). Other tablet types reuse the same ladder; their
 * mod→quality maps are hand-seeded and less precise until surveyed.
 */
const EXPLICIT_TIER_BY_MOD_ID: Record<string, ModQualityTier> = {
  // Irradiated / shared map
  map_waystone_qty_t1: "S",
  map_pack_size_t1: "A",
  map_pack_size_t2: "B",
  map_quantity_t1: "B",
  map_quantity_t2: "Junk",
  map_rarity_t1: "B",

  // Delirium
  delirium_splinter_stack_t1: "S",
  delirium_splinter_stack_t2: "A",
  delirium_pack_size_t1: "A",
  delirium_pack_size_t2: "B",
  delirium_boss_chance_t1: "B",

  // Breach — calibrated from Runes of Aldur survey r5 (dump≈8ex).
  // Splinters: Domain is 15–30%; trade still returns 0 under uses+available
  // (dump4 Standard saw hits). Keep S/A prior; survey r6 retries without uses.
  breach_splinter_qty_t1: "S",
  breach_splinter_qty_t2: "A",
  breach_pack_size_t1: "A",
  breach_pack_size_t2: "B",
  /** Best liquid driver; solo ≈ dump. */
  breach_rare_potency_t1: "A",
  /** Solo ~dump; with potency ≈ blank mid. */
  breach_hiveblood_t1: "B",
  /** With potency: ~329ex liquid (n≈1600) — A combo piece. r4’s ~38ex was a fluke. */
  breach_unstable_rare_t1: "A",
  breach_wombgift_qty_t1: "B",
  breach_vruun_chance_t1: "B",

  // Expedition
  expedition_logbook_t1: "S",
  expedition_logbook_t2: "A",
  expedition_relic_effect_t1: "A",
  expedition_rare_monsters_t1: "B",
  expedition_artifacts_t1: "B",

  // Boss
  boss_waystone_qty_t1: "S",
  boss_waystone_qty_t2: "A",
  boss_item_rarity_t1: "A",

  // Abyss
  abyss_desecrated_t1: "S",
  abyss_monster_spawn_t1: "A",
  abyss_monster_spawn_t2: "B",
  abyss_depths_t1: "A",

  // Temple / Vaal — manual trade survey 2026-08-12 (dump≈50, blank≈100).
  // Crystal ~775ex solo; beacon/chest/eff/pack support showed no combo lift.
  temple_crystal_t1: "S",
  temple_beacon_pack_t1: "Junk",
  temple_chest_rare_t1: "Junk",
};

export function modQualityTier(modId: string): ModQualityTier {
  if (EXPLICIT_TIER_BY_MOD_ID[modId]) return EXPLICIT_TIER_BY_MOD_ID[modId];
  const score = TABLET_MOD_WEIGHTS[modId]?.valueScore ?? 0;
  if (score >= 90) return "S";
  if (score >= 70) return "A";
  if (score >= 45) return "B";
  return "Junk";
}

export function tierRank(tier: ModQualityTier): number {
  switch (tier) {
    case "S":
      return 3;
    case "A":
      return 2;
    case "B":
      return 1;
    default:
      return 0;
  }
}

/** Best single-mod tier among a set of mod ids (legacy helper). */
export function bestTier(modIds: string[]): ModQualityTier {
  let best: ModQualityTier = "Junk";
  for (const id of modIds) {
    const t = modQualityTier(id);
    if (tierRank(t) > tierRank(best)) best = t;
  }
  return best;
}

export function countTier(modIds: string[], tier: ModQualityTier): number {
  return modIds.filter((id) => modQualityTier(id) === tier).length;
}

/**
 * Pattern on one affix side (≤2 prefixes or ≤2 suffixes).
 *
 * Ladder (high → low), matching strat_reco divine vs merchant bands:
 *   SS > SA > S(solo) > AA > A(solo/AB) > B > empty
 * Solo S sits above AA (divine needs S+support; solo S is still the better
 * merchant ask). Cross-side S+A / S+S is handled in {@link itemComboScore}.
 */
export type SidePattern = "SS" | "SA" | "S" | "AA" | "A" | "B" | "Empty";

/** Relative side strength (not exalts — ordinal for combo math). */
export const SIDE_SCORE: Record<SidePattern, number> = {
  SS: 70,
  SA: 60,
  S: 45,
  AA: 40,
  A: 25,
  B: 10,
  Empty: 0,
};

export function classifySide(modIds: string[]): SidePattern {
  const nS = countTier(modIds, "S");
  const nA = countTier(modIds, "A");
  const nB = countTier(modIds, "B");
  if (nS >= 2) return "SS";
  if (nS >= 1 && nA >= 1) return "SA";
  if (nS >= 1) return "S";
  if (nA >= 2) return "AA";
  if (nA >= 1) return "A"; // A alone or A+B
  if (nB >= 1) return "B";
  return "Empty";
}

export function splitAffixSides(modIds: string[]): {
  prefixes: string[];
  suffixes: string[];
} {
  const prefixes: string[] = [];
  const suffixes: string[] = [];
  for (const id of modIds) {
    if (TABLET_MOD_WEIGHTS[id]?.isPrefix) prefixes.push(id);
    else suffixes.push(id);
  }
  return { prefixes, suffixes };
}

/**
 * Full-item combo score from prefix side + suffix side + cross synergy.
 *
 * Cross bonuses (prefix × suffix), on top of side scores:
 *   S|S → +25 (double S across sides)
 *   S|A → +20 (divine synergy; strat TRADE_DIVINE)
 *   A|A → +8  (solid double-A without an S)
 */
export function itemComboScore(modIds: string[]): number {
  const { prefixes, suffixes } = splitAffixSides(modIds);
  const p = classifySide(prefixes);
  const s = classifySide(suffixes);
  let score = SIDE_SCORE[p] + SIDE_SCORE[s];

  const pS = countTier(prefixes, "S");
  const pA = countTier(prefixes, "A");
  const sS = countTier(suffixes, "S");
  const sA = countTier(suffixes, "A");

  if (pS >= 1 && sS >= 1) score += 25;
  else if ((pS >= 1 && sA >= 1) || (sS >= 1 && pA >= 1)) score += 20;
  // SC liquid: potency(A)+unstable(A) ≈ 329ex (n≥1000) — AA is jackpot-tier
  else if (pA >= 1 && sA >= 1) score += 20;

  return score;
}

/**
 * Map combo score → MDP rare bucket.
 *
 *   S     ≥ 60  — SS / SA / cross S+A|S+S  (list / divine)
 *   A     ≥ 40  — solo S / AA / strong cross-A
 *   B     ≥ 20  — solo A (merchant low)
 *   Trash < 20  — B/junk only
 */
export function comboScoreToRareTier(
  score: number,
): "S" | "A" | "B" | "Trash" {
  if (score >= 60) return "S";
  if (score >= 40) return "A";
  if (score >= 20) return "B";
  return "Trash";
}

/** Multi-affix rare classification (2p+2s aware). */
export function classifyModCombo(
  modIds: string[],
): {
  prefixes: string[];
  suffixes: string[];
  prefixSide: SidePattern;
  suffixSide: SidePattern;
  score: number;
  rareTier: "S" | "A" | "B" | "Trash";
} {
  const { prefixes, suffixes } = splitAffixSides(modIds);
  const score = itemComboScore(modIds);
  return {
    prefixes,
    suffixes,
    prefixSide: classifySide(prefixes),
    suffixSide: classifySide(suffixes),
    score,
    rareTier: comboScoreToRareTier(score),
  };
}

/** Core stash regexes from strat_reco.md */
export const STRAT_CORE_REGEX: Partial<Record<TabletCategory, string>> = {
  Irradiated: '"wayst|effe|pack"',
  Delirium: '"spli|effe|deli"',
};

export const UNIVERSAL_CATCHALL_REGEX = '"effe|wayst|pack|spli|rare"';
