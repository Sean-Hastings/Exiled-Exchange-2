/**
 * Dual-path tablet flipping strategies.
 *
 * Blank path = what to do with Normal (white) bases.
 * Rare path  = what to do with junk / under-rolled rares you already hold.
 * These are scored independently so the best blank craft is never forced
 * onto rare disposition (and vice versa).
 */

/** How to turn a blank (Normal) tablet into something sellable */
export type BlankCraftStrategy =
  /** Buy/keep whites → Alchemy (classic mass rare flip) */
  | "Scour-Alch"
  /**
   * Transmute → Augment → branch Regal/Alch → optional Exalt
   * (see strat_reco.md Magic-Pipeline state machine)
   */
  | "Magic-Pipeline"
  /** Don't craft blanks; only process rares you already have */
  | "Skip-Blanks";

/** How to dispose of a junk / mid / under-rolled rare */
export type RareDispositionStrategy =
  /** Chaos Orb re-roll until a sellable combo */
  | "Chaos-Spam"
  /** Exalt slam an open affix on a promising magic/rare */
  | "Exalt-Slam"
  /** Vaal corrupt for lottery upside */
  | "Vaal-Corrupt"
  /** List mid rolls on merchant / chaos price */
  | "Merchant-List"
  /** Send bricks to 3-to-1 reforge bench queue */
  | "Reforge-3to1"
  /** Dump / list as-is for salvage; stop crafting */
  | "Dump-Sell";

export type ModQualityTier = "S" | "A" | "B" | "Junk";

export const BLANK_STRATEGY_LABELS: Record<BlankCraftStrategy, string> = {
  "Scour-Alch": "Blank→Alch",
  "Magic-Pipeline": "Magic Pipeline",
  "Skip-Blanks": "Skip Blanks",
};

export const RARE_STRATEGY_LABELS: Record<RareDispositionStrategy, string> = {
  "Chaos-Spam": "Chaos Reroll",
  "Exalt-Slam": "Exalt Slam",
  "Vaal-Corrupt": "Vaal Corrupt",
  "Merchant-List": "Merchant List",
  "Reforge-3to1": "Reforge 3:1",
  "Dump-Sell": "Dump / Sell",
};

export function formatSplitStrategy(
  blank: BlankCraftStrategy,
  rare: RareDispositionStrategy,
): string {
  return `${BLANK_STRATEGY_LABELS[blank]} / ${RARE_STRATEGY_LABELS[rare]}`;
}
