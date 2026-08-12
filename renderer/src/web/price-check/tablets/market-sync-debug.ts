import type { ExaltFx } from "./trade-price-estimators";

export type ListingKeepReason =
  | "ok"
  | "no-price"
  | "no-convert"
  | "dust"
  | "ceiling";

/** One raw trade listing after convert + keep decision. */
export interface ListingDebugRow {
  amount: number;
  currency: string;
  /** Converted exalt; null if conversion failed */
  priceEx: number | null;
  keep: ListingKeepReason;
  indexedAt?: string;
  /** Trade site: seller online / afk / offline */
  accountStatus?: "offline" | "online" | "afk";
  /** true when listing.fee is set (in-game marketplace / instant buyout) */
  isInstantBuyout?: boolean;
}

export interface SearchDebugTrace {
  kind:
    | "buy-securable"
    | "buy-available"
    | "buy-online"
    | "buy-any"
    | "sell-combo"
    | "sell-junk";
  label: string;
  typeName: string;
  /** status.option sent to trade2 */
  statusOption?: string;
  /** Exact search body (for verifying filters) */
  queryBody?: unknown;
  queryId?: string;
  totalHits?: number;
  fetched: number;
  converted: number;
  kept: number;
  mix: string;
  estimate: number | null;
  estimateNote: string;
  floorEx: number;
  ceilingEx: number;
  listings: ListingDebugRow[];
  error?: string;
}

export interface BaseBuyDebugTrace {
  baseId: string;
  baseName: string;
  typeNamesTried: string[];
  finalBuy: number | null;
  /** Which live status band produced the final buy */
  finalStatus?: "securable" | "available" | "online" | "any";
  searches: SearchDebugTrace[];
}

export interface ComboSellDebugTrace {
  baseId: string;
  baseName: string;
  comboKey: string;
  finalSell: number | null;
  search: SearchDebugTrace;
}

export interface MarketSyncDebug {
  revision: number;
  updatedAt: number;
  leagueId: string;
  fx: ExaltFx;
  buyFloorEx: number;
  buyCeilingEx: number;
  sellCeilingEx: number;
  bases: BaseBuyDebugTrace[];
  combos: ComboSellDebugTrace[];
}
