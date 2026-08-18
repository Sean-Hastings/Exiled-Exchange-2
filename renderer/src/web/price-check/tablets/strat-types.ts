/**
 * Dual-path tablet flipping strategies.
 *
 * Entry = how to acquire a tablet (buy white / buy magic / buy rare / skip).
 * Magics are never listed. A blue is **promising** (has A or S → regal+ex) or
 * **trash** (no A/S → alch). Blank+T+A is a lottery over those states; bought
 * cheapest magics are always trash.
 */

/** How to acquire / open a craft (not “what to do with a hovered rare”). */
export type BlankCraftStrategy =
  /**
   * Buy/keep whites → Alchemy (classic mass rare flip).
   * Dominated by Magic-Pipeline when magics exist; kept for explicit solves.
   */
  | "Scour-Alch"
  /**
   * Buy white → Transmute+Aug → promising (A/S) regal+ex / trash alch
   */
  | "Magic-Pipeline"
  /**
   * Skip whites; buy cheapest 10-use magics. Those books are trash-only,
   * so always alch (no promising regal lottery).
   */
  | "Buy-Magic"
  /** Skip craft; buy cheapest 10-use rares and apply rare policy */
  | "Buy-Rare"
  /** Don't buy anything; only process inventory you already have */
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
  "Magic-Pipeline": "Blank→Magic",
  "Buy-Magic": "Buy Magics",
  "Buy-Rare": "Buy Rares",
  "Skip-Blanks": "Skip Buys",
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
