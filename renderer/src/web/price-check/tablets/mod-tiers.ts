import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import type { TabletCategory } from "./tablet-types";
import type { ModQualityTier } from "./strat-types";

/**
 * S/A/B tier tags + multi-affix combo scoring — **per tablet baseId**.
 *
 * Each base owns an independent sealed map (named tiers + pool fillers → Junk).
 * Do not share one object across bases.
 *
 * Sources (0.5.4 did not retune tablet pools; Domain Breach splinters dead):
 * - **0.5.4(f) / 0.5 live pools** — PoE2DB exclusives + shared fillers
 * - **akrpg Jul 2026** trade priors (post–Temple map-device economy)
 * - **Temple survey 2026-08-12** — crystal-only premium
 *   (`manual_review_1.json` / temple-manual-market)
 *
 * SIDE_SCORE / MDP cutoffs remain a working prior aligned with strat_reco.md.
 * Fallback when a mod is missing from the base map: valueScore → Junk-by-score
 * (or Junk when score is low). Prefer {@link modQualityTierForBase} everywhere
 * MDP/EV/fit knows the base.
 */

/**
 * Fill every mod in the base pool: named tiers win; unlisted pool mods → Junk.
 * Seals score-fallback so fillers cannot promote to A/S.
 */
function sealPoolAsJunk(
  baseId: string,
  named: Record<string, ModQualityTier>,
): Record<string, ModQualityTier> {
  const base = TABLET_BASES[baseId];
  const out: Record<string, ModQualityTier> = { ...named };
  if (!base) return out;
  for (const id of [
    ...base.allowedPrefixPool,
    ...base.allowedSuffixPool,
  ]) {
    if (!Object.prototype.hasOwnProperty.call(out, id)) out[id] = "Junk";
  }
  return out;
}

/**
 * Per-base quality maps. Independent sealed objects — Temple survey must not
 * affect Breach calibration and vice versa.
 */
const EXPLICIT_TIER_BY_BASE: Record<
  string,
  Record<string, ModQualityTier>
> = {
  /**
   * Temple survey 2026-08-12: only crystal is premium (~775ex solo).
   * Mid-band (~75–80 vs dump ~60) → B so they stay distinct from Trash fillers.
   * A empty — no mid-band A that could A|A → MDP S without crystal.
   * Remaining exclusives + shared fillers → Junk (sealed).
   */
  temple_tablet: sealPoolAsJunk("temple_tablet", {
    temple_crystal_t1: "S",
    map_pack_size_t1: "B",
    map_pack_size_t2: "B",
    map_waystone_qty_t1: "B",
    junk_monster_eff_t1: "B",
    junk_item_rarity_t1: "B",
    // Explicit Junk for exclusives (also sealed for other pool fillers)
    temple_beacon_pack_t1: "Junk",
    temple_chest_rare_t1: "Junk",
    temple_unique_monster_t1: "Junk",
    temple_extra_pack_t1: "Junk",
    temple_extra_pack_chance_t1: "Junk",
    temple_summon_mons_t1: "Junk",
  }),

  /**
   * Breach — akrpg Jul 2026 + 0.5.4 live exclusives.
   * Domain splinters are LEGACY dead (parse-only) — must NOT be S/A.
   * Unstable is S so potency(A)+unstable(S) → SA / MDP S (replaces old A|A).
   */
  breach_tablet: sealPoolAsJunk("breach_tablet", {
    breach_unstable_rare_t1: "S",
    breach_hiveblood_t1: "S",
    breach_rare_potency_t1: "A",
    breach_wombgift_qty_t1: "A",
    breach_wombgift_level_t1: "A",
    breach_pack_size_t1: "A",
    breach_pack_size_t2: "B",
    breach_vruun_chance_t1: "B",
    junk_monster_eff_t1: "B",
    junk_item_rarity_t1: "B",
    // Legacy Domain — dead economy, sealed Junk
    breach_splinter_qty_t1: "Junk",
    breach_splinter_qty_t2: "Junk",
  }),

  /**
   * Ritual — akrpg Jul 2026; reroll jackpot + omen/cost cluster A.
   */
  ritual_tablet: sealPoolAsJunk("ritual_tablet", {
    ritual_reroll_t1: "S",
    ritual_omen_t1: "A",
    ritual_reroll_cost_t1: "A",
    ritual_free_reroll_t1: "A",
    ritual_defer_cost_t1: "A",
    ritual_tribute_t1: "A",
    ritual_revived_rare_t1: "B",
    ritual_defer_t1: "B",
    junk_monster_eff_t1: "B",
    junk_item_rarity_t1: "B",
    ritual_revived_magic_t1: "Junk",
  }),

  /**
   * Abyss — four-pit + rare spawn jackpots; shared rarity/eff support A.
   * Desecrated / depths are dump fillers (sealed Junk).
   */
  abyss_tablet: sealPoolAsJunk("abyss_tablet", {
    abyss_four_chance_t1: "S",
    abyss_rare_spawn_t1: "S",
    abyss_abyssal_mods_t1: "A",
    abyss_monster_spawn_t1: "A",
    junk_rare_mons_t1: "A",
    junk_monster_rarity_t1: "A",
    junk_monster_eff_t1: "A",
    junk_item_rarity_t1: "A",
    junk_extra_exile_t1: "A",
    abyss_monster_spawn_t2: "B",
    abyss_pit_reward_t1: "B",
    abyss_eff_per_pit_t1: "B",
    abyss_pit_difficulty_t1: "B",
    abyss_desecrated_t1: "Junk",
    abyss_depths_t1: "Junk",
  }),

  /**
   * Delirium — splinter stack T1 jackpot; fog/timer fillers Junk.
   */
  delirium_tablet: sealPoolAsJunk("delirium_tablet", {
    delirium_splinter_stack_t1: "S",
    delirium_splinter_stack_t2: "A",
    delirium_fracturing_t1: "A",
    delirium_mirror_shards_t1: "A",
    delirium_boss_chance_t1: "A",
    delirium_pack_size_t1: "A",
    delirium_pack_size_t2: "B",
    delirium_timer_pause_t1: "B",
    delirium_fog_duration_t1: "Junk",
    delirium_fog_slower_t1: "Junk",
    delirium_deliriousness_t1: "Junk",
  }),

  /**
   * Expedition — remnants + logbook T1 jackpots (akrpg Jul 2026).
   */
  expedition_tablet: sealPoolAsJunk("expedition_tablet", {
    expedition_remnants_t1: "S",
    expedition_logbook_t1: "S",
    expedition_logbook_t2: "A",
    expedition_relic_effect_t1: "A",
    expedition_rare_monsters_t1: "A",
    expedition_markers_t1: "A",
    expedition_artifacts_t1: "B",
    expedition_explosive_radius_t1: "B",
    expedition_explosive_range_t1: "B",
  }),

  /**
   * Irradiated — shared-pool only; waystone + map-mods jackpots.
   */
  irradiated_tablet: sealPoolAsJunk("irradiated_tablet", {
    map_waystone_qty_t1: "S",
    junk_map_mods_t1: "S",
    junk_monster_eff_t1: "A",
    junk_item_rarity_t1: "A",
    junk_rare_mons_t1: "A",
    junk_monster_rarity_t1: "A",
    map_pack_size_t1: "B",
    map_pack_size_t2: "B",
  }),

  /**
   * Overseer — Azmeri (Wisps-style shared) jackpots; boss qty/rarity A.
   * No Overseer-exclusive "contains Azmeri" beyond shared azmeri IDs in pool.
   */
  overseer_tablet: sealPoolAsJunk("overseer_tablet", {
    junk_extra_azmeri_t1: "S",
    junk_azmeri_chance_t1: "S",
    junk_extra_exile_t1: "A",
    boss_item_rarity_t1: "A",
    boss_item_qty_t1: "A",
    boss_waystone_qty_t1: "A",
    boss_waystone_qty_t2: "A",
    boss_xp_t1: "B",
  }),
};

/** Session overlay from TierUncertaintyPanel (not yet committed to base maps). */
const SESSION_TIER_BY_MOD_ID: Record<string, ModQualityTier> = {};

/** True iff modId has an entry in that base's explicit map (§3.8). */
export function hasExplicitTier(modId: string, baseId?: string): boolean {
  if (baseId) {
    return Object.prototype.hasOwnProperty.call(
      EXPLICIT_TIER_BY_BASE[baseId] ?? {},
      modId,
    );
  }
  for (const map of Object.values(EXPLICIT_TIER_BY_BASE)) {
    if (Object.prototype.hasOwnProperty.call(map, modId)) return true;
  }
  return false;
}

export function hasSessionModTier(modId: string): boolean {
  return Object.prototype.hasOwnProperty.call(SESSION_TIER_BY_MOD_ID, modId);
}

export function getSessionModTier(modId: string): ModQualityTier | undefined {
  return SESSION_TIER_BY_MOD_ID[modId];
}

/** Runtime tier overlay for uncertainty panel; does not mutate base maps. */
export function setSessionModTier(
  modId: string,
  tier: ModQualityTier | null,
): void {
  if (tier == null) delete SESSION_TIER_BY_MOD_ID[modId];
  else SESSION_TIER_BY_MOD_ID[modId] = tier;
}

export function clearSessionModTiers(): void {
  for (const k of Object.keys(SESSION_TIER_BY_MOD_ID)) {
    delete SESSION_TIER_BY_MOD_ID[k];
  }
}

function tierFromValueScore(modId: string): ModQualityTier {
  const score = TABLET_MOD_WEIGHTS[modId]?.valueScore ?? 0;
  if (score >= 90) return "S";
  if (score >= 70) return "A";
  if (score >= 45) return "B";
  return "Junk";
}

/**
 * Base-aware quality tier — sole source of truth for EV / MDP / combo scoring.
 */
export function modQualityTierForBase(
  baseId: string | undefined,
  modId: string,
): ModQualityTier {
  if (SESSION_TIER_BY_MOD_ID[modId]) return SESSION_TIER_BY_MOD_ID[modId]!;
  if (baseId) {
    const map = EXPLICIT_TIER_BY_BASE[baseId];
    if (map && Object.prototype.hasOwnProperty.call(map, modId)) {
      return map[modId]!;
    }
  }
  // Residual: Junk-by-score (no global cross-base EXPLICIT map).
  return tierFromValueScore(modId);
}

/**
 * @deprecated Prefer {@link modQualityTierForBase} with a baseId.
 * Without a base, only valueScore fallback applies (no shared global map).
 */
export function modQualityTier(modId: string): ModQualityTier {
  return modQualityTierForBase(undefined, modId);
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
export function bestTier(
  modIds: string[],
  baseId?: string,
): ModQualityTier {
  let best: ModQualityTier = "Junk";
  for (const id of modIds) {
    const t = modQualityTierForBase(baseId, id);
    if (tierRank(t) > tierRank(best)) best = t;
  }
  return best;
}

export function countTier(
  modIds: string[],
  tier: ModQualityTier,
  baseId?: string,
): number {
  return modIds.filter((id) => modQualityTierForBase(baseId, id) === tier)
    .length;
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

export function classifySide(
  modIds: string[],
  baseId?: string,
): SidePattern {
  const nS = countTier(modIds, "S", baseId);
  const nA = countTier(modIds, "A", baseId);
  const nB = countTier(modIds, "B", baseId);
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
 *   A|A → +20 (liquid double-A without an S)
 *
 * Breach 0.5.4: potency(A)+unstable(S) same-side → SA (SIDE_SCORE 60 → MDP S).
 */
export function itemComboScore(modIds: string[], baseId?: string): number {
  const { prefixes, suffixes } = splitAffixSides(modIds);
  const p = classifySide(prefixes, baseId);
  const s = classifySide(suffixes, baseId);
  let score = SIDE_SCORE[p] + SIDE_SCORE[s];

  const pS = countTier(prefixes, "S", baseId);
  const pA = countTier(prefixes, "A", baseId);
  const sS = countTier(suffixes, "S", baseId);
  const sA = countTier(suffixes, "A", baseId);

  if (pS >= 1 && sS >= 1) score += 25;
  else if ((pS >= 1 && sA >= 1) || (sS >= 1 && pA >= 1)) score += 20;
  // Cross A|A (e.g. shared A-prefix × exclusive A-suffix on Abyss/Irradiated)
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
  baseId?: string,
): {
  prefixes: string[];
  suffixes: string[];
  prefixSide: SidePattern;
  suffixSide: SidePattern;
  score: number;
  rareTier: "S" | "A" | "B" | "Trash";
} {
  const { prefixes, suffixes } = splitAffixSides(modIds);
  const score = itemComboScore(modIds, baseId);
  let rareTier = comboScoreToRareTier(score);
  // Temple survey 2026-08-12: only crystal is premium — any rare with
  // temple_crystal_t1 is MDP S so alch P(S) ≈ P(crystal on rare).
  if (
    baseId === "temple_tablet" &&
    modIds.includes("temple_crystal_t1")
  ) {
    rareTier = "S";
  }
  return {
    prefixes,
    suffixes,
    prefixSide: classifySide(prefixes, baseId),
    suffixSide: classifySide(suffixes, baseId),
    score,
    rareTier,
  };
}

/** Core stash regexes from strat_reco.md */
export const STRAT_CORE_REGEX: Partial<Record<TabletCategory, string>> = {
  Irradiated: '"wayst|effe|pack"',
  Delirium: '"spli|effe|deli"',
};

export const UNIVERSAL_CATCHALL_REGEX = '"effe|wayst|pack|spli|rare"';
