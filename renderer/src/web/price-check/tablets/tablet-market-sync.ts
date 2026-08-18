import { usePoeninja } from "@/web/background/Prices";
import {
  pickSoftcoreChallengeLeague,
  useLeagues,
} from "@/web/background/Leagues";
import {
  requestResults,
  requestTradeResultList,
  type PricingResult,
} from "@/web/price-check/trade/pathofexile-trade";
import { RATE_LIMIT_RULES } from "@/web/price-check/trade/common";
import { RateLimiter } from "@/web/price-check/trade/RateLimiter";
import { TABLET_BASES } from "./mod-weights";
import { createEmptyMarketCache } from "./default-market";
import { isFinitePositive } from "./market-sanity";
import {
  applySabSyncHit,
  buildSabSyncWorklist,
} from "./sab-combo-plan";
import {
  BUY_DEPTH_COLD_DEFAULT,
  BUY_DEPTH_HOT,
  BUY_DEPTH_N,
  BUY_DUST_FLOOR_EX,
  BUY_MAX_EX,
  FLOW_PROBE_MS,
  FLOW_PROBE_WAIT_SKIP_MS,
  SELL_MAX_EX,
  buyEstimateNote,
  buyMeanEstimateNote,
  classifyMarketFlow,
  effectiveBuyCountForRegime,
  estimateBuyPriceEx,
  estimateBuyPriceMeanOfCheapestEx,
  estimateSellPriceDetail,
  isSellListingStale,
  listingAmountToExalt,
  remainingFlowProbeWaitMs,
  type ExaltFx,
  type MarketFlowRegime,
  type PricedListing,
} from "./trade-price-estimators";
import type {
  BaseBuyDebugTrace,
  ComboSellDebugTrace,
  ListingDebugRow,
  ListingKeepReason,
  MarketSyncDebug,
  SearchDebugTrace,
} from "./market-sync-debug";
import type { MarketPriceCache, TabletEVResult } from "./tablet-ev-calculator";
import {
  appendDoubleFollowUps,
  createSurveyDocument,
  deferUnfinishedSplinters,
  reorderSurveyQueueSplintersLast,
  surveyProgress,
} from "./tier-survey-plan";
import { computeOctave } from "./tier-survey-analyze";
import type {
  SurveyWorkItem,
  TierSurveyDocument,
} from "./tier-survey-types";
import { TIER_SURVEY_REVISION } from "./tier-survey-types";
import {
  SurveyTradeGate,
  parseRateLimitWaitSec,
} from "./survey-trade-gate";

export type { MarketSyncDebug } from "./market-sync-debug";

/** Bump when conversion / estimator semantics change — invalidates persisted cache. */
export const MARKET_SYNC_REVISION = 31;

/** Buy: enough depth for buy@N. Any listed currency; convert to exalt client-side. */
const BUY_LISTING_SAMPLE = 30;
/** Sell: 3 FETCH batches of 10. Stop early on first kept ≥24h listing. */
const SELL_LISTING_SAMPLE = 30;
/** Trash magic/rare books: full 30 so sell wall + buy mean-of-B share one SEARCH. */
const TRASH_LISTING_SAMPLE = 30;
/** Survey fetch depth — fewer FETCH tokens per search. */
const SURVEY_LISTING_SAMPLE = 8;
const FETCH_BATCH = 10;
/** HTTP budget; rate-limit wait is excluded from this clock. */
const TRADE_HTTP_TIMEOUT_MS = 45_000;

/**
 * Tablet EV / survey always price against softcore challenge (not Standard/HC).
 * Falls back to selected league only if challenge cannot be resolved.
 */
function resolveTabletLeagueId(): string | undefined {
  const leagues = useLeagues();
  const list = leagues.list.value;
  const challenge = pickSoftcoreChallengeLeague(list);
  if (challenge) {
    if (leagues.selectedId.value !== challenge) {
      leagues.selectedId.value = challenge;
    }
    return challenge;
  }
  return leagues.selectedId.value;
}

/** Server-start sync can race OverlayWindow's league fetch — wait, then load. */
async function ensureTabletLeagueId(
  progress: ProgressFn,
  isCancelled: () => boolean,
): Promise<string | undefined> {
  const leagues = useLeagues();
  if (!leagues.list.value.length) {
    progress("Loading trade leagues…");
    for (
      let i = 0;
      i < 50 && leagues.isLoading.value && !leagues.list.value.length;
      i++
    ) {
      if (isCancelled()) return undefined;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!leagues.list.value.length) {
      await leagues.load();
    }
  }
  return resolveTabletLeagueId();
}

export type MarketSyncStatus =
  | { state: "idle" }
  | { state: "loading"; detail: string }
  | { state: "ready"; updatedAt: number; source: string }
  | { state: "error"; message: string; partial: boolean };

type ProgressFn = (detail: string) => void;
type NinjaApi = ReturnType<typeof usePoeninja>;

interface TabletTradeSearchBody {
  query: {
    /** PoE2 trade2: securable=marketplace, available=instant|online, online, any */
    status: { option: "securable" | "available" | "online" | "any" };
    type?: string;
    stats: Array<{
      type: "and";
      filters: Array<{
        id: string;
        value?: { min?: number; max?: number };
        disabled?: boolean;
      }>;
    }>;
    filters: {
      type_filters?: {
        filters: {
          category?: { option: string };
          rarity?: { option: string };
        };
      };
      trade_filters?: {
        filters: {
          collapse?: { option: string };
          price?: { option: string };
          indexed?: { option: string };
        };
      };
    };
  };
  sort: { price: "asc" };
}

/** Fresh blanks / premium rolls: full charge tablets only. */
const USES_REMAINING_STAT = "pseudo.pseudo_number_of_uses_remaining";
const FULL_USES = 10;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timeout: ${label} (${Math.round(ms / 1000)}s)`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function noticeRateLimit(kind: "search" | "fetch", progress: ProgressFn, ctx: string) {
  const rules =
    kind === "search" ? RATE_LIMIT_RULES.SEARCH : RATE_LIMIT_RULES.FETCH;
  const est = RateLimiter.estimateTime(1, rules);
  if (est > 1500) {
    progress(`${ctx} — rate limit ~${Math.ceil(est / 1000)}s`);
  }
}

async function fetchListingsBatched(
  queryId: string,
  resultIds: string[],
  progress: ProgressFn,
  ctx: string,
  isCancelled: () => boolean,
  shouldStop?: (accumulated: PricingResult[]) => boolean,
): Promise<PricingResult[]> {
  const out: PricingResult[] = [];
  const total = Math.ceil(resultIds.length / FETCH_BATCH);
  for (let i = 0; i < resultIds.length; i += FETCH_BATCH) {
    if (isCancelled()) throw new Error("Market sync cancelled");
    const batch = resultIds.slice(i, i + FETCH_BATCH);
    if (!batch.length) break;
    const step = Math.floor(i / FETCH_BATCH) + 1;
    noticeRateLimit("fetch", progress, `${ctx} fetch ${step}/${total}`);
    progress(`${ctx} fetch ${step}/${total}`);
    // Include estimated RL wait in the timeout budget (wait lives inside requestResults)
    const rlWait = RateLimiter.estimateTime(1, RATE_LIMIT_RULES.FETCH);
    try {
      const rows = await withTimeout(
        requestResults(queryId, batch, { accountName: "" }),
        TRADE_HTTP_TIMEOUT_MS + Math.max(0, rlWait) + 5_000,
        `${ctx} fetch ${step}/${total}`,
      );
      out.push(...rows);
    } catch (e) {
      // Keep partial book — sell only needs a floor, not every page
      if (out.length) {
        console.warn(
          `[tablet-market] partial fetch ${out.length}/${resultIds.length}:`,
          e,
        );
        progress(
          `${ctx} — partial ${out.length} listings (${e instanceof Error ? e.message : String(e)})`,
        );
        break;
      }
      throw e;
    }
    if (shouldStop?.(out)) break;
  }
  return out;
}

/**
 * Build exalt FX from poe.ninja only. No ratio fallbacks — missing legs → null.
 * Sanity-bands PoE2 chaos (typically ~30–60ex) so we never treat 1c as 1ex.
 */
function buildExaltFx(ninja: NinjaApi): ExaltFx | null {
  const xchg = ninja.xchgRate.value;
  // When core is exalted, xchgRate = exalted per divine
  if (xchg == null || !Number.isFinite(xchg) || xchg <= 0) return null;

  const core = ninja.xchgRateCurrency.value?.id ?? "exalted";
  const chaosHit = ninja.findPriceByQuery({ ns: "ITEM", name: "Chaos Orb" });

  let exaltPerDivine: number;
  let exaltPerChaos: number;

  if (core === "exalted") {
    exaltPerDivine = xchg;
    if (!(chaosHit?.primaryValue && chaosHit.primaryValue > 0)) return null;
    // primaryValue is in divines → exalt = div * (ex/div)
    exaltPerChaos = chaosHit.primaryValue * exaltPerDivine;
  } else if (core === "chaos") {
    const chaosPerDiv = xchg;
    const exaltHit = ninja.findPriceByQuery({
      ns: "ITEM",
      name: "Exalted Orb",
    });
    if (!exaltHit?.primaryValue) return null;
    exaltPerDivine = 1 / exaltHit.primaryValue;
    exaltPerChaos = exaltPerDivine / chaosPerDiv;
  } else {
    return null;
  }

  if (!isFinitePositive(exaltPerDivine)) return null;
  if (!isFinitePositive(exaltPerChaos)) return null;

  // PoE2: chaos is tens of exalt, not ~1 and not thousands
  if (exaltPerChaos < 10 || exaltPerChaos > 200) {
    console.warn(
      `[tablet-market] rejecting absurd FX exaltPerChaos=${exaltPerChaos}`,
    );
    return null;
  }
  if (exaltPerDivine < 50 || exaltPerDivine > 2000) {
    console.warn(
      `[tablet-market] rejecting absurd FX exaltPerDivine=${exaltPerDivine}`,
    );
    return null;
  }

  const rates: ExaltFx = { exaltPerChaos, exaltPerDivine };

  const gEx = ninja.findPriceByQuery({
    ns: "ITEM",
    name: "Greater Exalted Orb",
  });
  if (gEx?.primaryValue && gEx.primaryValue > 0) {
    const v = gEx.primaryValue * exaltPerDivine;
    if (isFinitePositive(v) && v < BUY_MAX_EX) rates.greaterExalted = v;
  }
  const pEx = ninja.findPriceByQuery({
    ns: "ITEM",
    name: "Perfect Exalted Orb",
  });
  if (pEx?.primaryValue && pEx.primaryValue > 0) {
    const v = pEx.primaryValue * exaltPerDivine;
    if (isFinitePositive(v) && v < BUY_MAX_EX) rates.perfectExalted = v;
  }

  return rates;
}

function divinePrimaryToExalt(
  primaryValueDiv: number,
  rates: { exaltPerChaos: number; exaltPerDivine: number },
): number {
  return primaryValueDiv * rates.exaltPerDivine;
}

function fxFromMarket(market: MarketPriceCache, rates: ExaltFx): ExaltFx {
  const c = market.currencyCosts;
  return {
    exaltPerChaos: rates.exaltPerChaos,
    exaltPerDivine: rates.exaltPerDivine,
    alchemy: Number.isFinite(c.alchemy) ? c.alchemy : undefined,
    regal: Number.isFinite(c.regal) ? c.regal : undefined,
    vaal: Number.isFinite(c.vaal) ? c.vaal : undefined,
    transmute: Number.isFinite(c.transmute) ? c.transmute : undefined,
    augmentation: Number.isFinite(c.augmentation) ? c.augmentation : undefined,
    scouring: Number.isFinite(c.scouring) ? c.scouring : 0,
    greaterExalted: rates.greaterExalted,
    perfectExalted: rates.perfectExalted,
  };
}

/**
 * Convert listing → exalt via explicit FX whitelist only.
 * Do NOT multiply poe.ninja primaryValue here — that path produced
 * multi-million "ex" when mirrors / mis-unit primaryValues appeared.
 */
function classifyListing(
  l: PricingResult,
  fx: ExaltFx,
  floorEx: number,
  ceilingEx: number,
): ListingDebugRow {
  const amount = l.priceAmount;
  const currency = l.priceCurrency;
  const meta = {
    indexedAt: l.indexedAt,
    accountStatus: l.accountStatus,
    isInstantBuyout: l.isInstantBuyout,
  };
  if (!(amount > 0) || currency === "no price") {
    return {
      amount,
      currency,
      priceEx: null,
      keep: "no-price",
      ...meta,
    };
  }
  const priceEx = listingAmountToExalt(amount, currency, fx);
  let keep: ListingKeepReason;
  if (priceEx == null || !isFinitePositive(priceEx)) keep = "no-convert";
  else if (priceEx < floorEx) keep = "dust";
  else if (priceEx > ceilingEx) keep = "ceiling";
  else keep = "ok";
  return { amount, currency, priceEx, keep, ...meta };
}

function keptToPriced(rows: ListingDebugRow[]): PricedListing[] {
  return rows
    .filter((r) => r.keep === "ok" && r.priceEx != null)
    .map((r) => ({
      priceEx: r.priceEx!,
      indexedAt: r.indexedAt,
      currency: r.currency,
    }));
}

function currencyMixSummary(listings: PricedListing[]): string {
  const counts = new Map<string, number>();
  for (const l of listings) {
    const c = l.currency ?? "?";
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([c, n]) => `${n}${c.slice(0, 3)}`)
    .join("+");
}

function mixFromDebug(rows: ListingDebugRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([c, n]) => `${n}×${c}`)
    .join(", ");
}

async function searchPricedListings(
  body: TabletTradeSearchBody,
  leagueId: string,
  fx: ExaltFx,
  progress: ProgressFn,
  ctx: string,
  isCancelled: () => boolean,
  floorEx: number,
  ceilingEx: number,
  sample = BUY_LISTING_SAMPLE,
  opts?: {
    /** Sell path only: after each FETCH batch of 10, stop if any kept listing is ≥24h. */
    stopOnStale?: boolean;
  },
): Promise<{
  priced: PricedListing[];
  rows: ListingDebugRow[];
  queryId?: string;
  totalHits?: number;
  body: TabletTradeSearchBody;
}> {
  if (isCancelled()) throw new Error("Market sync cancelled");
  noticeRateLimit("search", progress, ctx);
  progress(ctx);
  const searchRl = RateLimiter.estimateTime(1, RATE_LIMIT_RULES.SEARCH);
  const search = await withTimeout(
    requestTradeResultList(body as never, leagueId, {
      allowSlowQueue: true,
    }),
    TRADE_HTTP_TIMEOUT_MS + Math.max(0, searchRl) + 5_000,
    ctx,
  );
  const ids = search.result.slice(0, sample);
  if (!ids.length) {
    return {
      priced: [],
      rows: [],
      queryId: search.id,
      totalHits: search.total,
      body,
    };
  }
  const listings = await fetchListingsBatched(
    search.id,
    ids,
    progress,
    ctx,
    isCancelled,
    opts?.stopOnStale
      ? (accumulated) => {
          const classified = accumulated.map((l) =>
            classifyListing(l, fx, floorEx, ceilingEx),
          );
          return keptToPriced(classified).some((l) => isSellListingStale(l));
        }
      : undefined,
  );
  const rows = listings.map((l) => classifyListing(l, fx, floorEx, ceilingEx));
  return {
    priced: keptToPriced(rows),
    rows,
    queryId: search.id,
    totalHits: search.total,
    body,
  };
}

function buildSearchTrace(opts: {
  kind: SearchDebugTrace["kind"];
  label: string;
  typeName: string;
  statusOption?: string;
  queryBody?: unknown;
  queryId?: string;
  totalHits?: number;
  rows: ListingDebugRow[];
  priced: PricedListing[];
  estimate: number | null;
  estimateNote: string;
  floorEx: number;
  ceilingEx: number;
  error?: string;
}): SearchDebugTrace {
  return {
    kind: opts.kind,
    label: opts.label,
    typeName: opts.typeName,
    statusOption: opts.statusOption,
    queryBody: opts.queryBody,
    queryId: opts.queryId,
    totalHits: opts.totalHits,
    fetched: opts.rows.length,
    converted: opts.rows.filter((r) => r.priceEx != null).length,
    kept: opts.priced.length,
    mix: mixFromDebug(opts.rows),
    estimate: opts.estimate,
    estimateNote: opts.estimateNote,
    floorEx: opts.floorEx,
    ceilingEx: opts.ceilingEx,
    listings: opts.rows,
    error: opts.error,
  };
}

/**
 * Buy blanks from the *live* market only.
 *
 * PoE2 trade status labels (official filters):
 * - securable = Instant Buyout (merchant tab / in-game marketplace) — default
 * - available = Instant Buyout AND In Person (whisper) — opt-in fallback
 * - online    = In Person (Online) ONLY — excludes marketplace
 * - any       = includes offline ghosts
 *
 * One SEARCH per snap — any listed currency, converted to exalt.
 * Instant Buyout (`securable`) only unless `includeAvailable` is on, then
 * fall back to `available` when the marketplace book is empty. `forceStatus`
 * locks one band (flow probe #2 / mkt-only snaps).
 */
async function searchBuyPriceEx(
  typeName: string,
  leagueId: string,
  fx: ExaltFx,
  progress: ProgressFn,
  ctx: string,
  isCancelled: () => boolean,
  buyFloor: number,
  buyCeiling: number,
  buyDepth: number = BUY_DEPTH_N,
  opts?: {
    /** Lock to one status band (no fallback). Used by flow probe #2 / mkt-only snaps. */
    forceStatus?: "securable" | "available";
    /** When true and no forceStatus, try available if securable is empty. */
    includeAvailable?: boolean;
  },
): Promise<{
  price: number;
  sampleSize: number;
  status: "securable" | "available";
  mix: string;
  priced: PricedListing[];
  traces: SearchDebugTrace[];
} | null> {
  const traces: SearchDebugTrace[] = [];

  type BuyBand = {
    status: "available" | "securable";
    kind: "buy-available" | "buy-securable";
    note: string;
  };
  const allBands: BuyBand[] = [
    {
      status: "securable",
      kind: "buy-securable",
      note: "marketplace / instant buyout only",
    },
    {
      status: "available",
      kind: "buy-available",
      note: "instant buyout + in-person online (fallback)",
    },
  ];
  const bands = opts?.forceStatus
    ? allBands.filter((b) => b.status === opts.forceStatus)
    : opts?.includeAvailable
      ? allBands
      : allBands.filter((b) => b.status === "securable");

  for (const band of bands) {
    const body = blankTabletQuery(typeName, band.status);
    const hit = await searchPricedListings(
      body,
      leagueId,
      fx,
      progress,
      `${ctx} ${band.status} exalted`,
      isCancelled,
      buyFloor,
      buyCeiling,
      BUY_LISTING_SAMPLE,
    );
    const priced = hit.priced;
    const price = estimateBuyPriceEx(priced, buyDepth);
    traces.push(
      buildSearchTrace({
        kind: band.kind,
        label: `${ctx} ${band.status} · any-currency (sort by listed amount)`,
        typeName,
        statusOption: band.status,
        queryBody: body,
        queryId: hit.queryId,
        totalHits: hit.totalHits,
        rows: hit.rows,
        priced,
        estimate: price,
        estimateNote: `${buyEstimateNote(priced.length, buyDepth)} · any-currency (${band.note})`,
        floorEx: buyFloor,
        ceilingEx: buyCeiling,
      }),
    );

    if (price == null || !priced.length) continue;

    return {
      price,
      sampleSize: priced.length,
      status: band.status,
      mix: currencyMixSummary(priced),
      priced,
      traces,
    };
  }

  return null;
}

async function sleepCancellable(
  ms: number,
  isCancelled: () => boolean,
  progress: ProgressFn,
  label: string,
): Promise<void> {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    if (isCancelled()) throw new Error("Market sync cancelled");
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    progress(`${label} (${left}s)…`);
    await new Promise((r) =>
      setTimeout(r, Math.min(1000, Math.max(0, end - Date.now()))),
    );
  }
}

function commitBlankBuyPrice(
  market: MarketPriceCache,
  baseId: string,
  priced: PricedListing[],
  regime: MarketFlowRegime,
  buyCountB: number,
  stats: { basesPriced: number },
): number | null {
  const kEff = effectiveBuyCountForRegime(regime, buyCountB);
  const price = estimateBuyPriceMeanOfCheapestEx(priced, kEff);
  if (price == null || !isFinitePositive(price)) return null;
  const wasUnset = !isFinitePositive(market.basePrices[baseId]);
  market.basePrices[baseId] = price;
  if (wasUnset) stats.basesPriced++;
  return price;
}

/** Sell: Instant Buyout estimator (see estimateSellPriceDetail). FETCH stops at first kept ≥24h. */
async function searchSellPriceEx(
  body: TabletTradeSearchBody,
  leagueId: string,
  fx: ExaltFx,
  progress: ProgressFn,
  ctx: string,
  typeName: string,
  isCancelled: () => boolean,
  sellCeiling: number,
  sample = SELL_LISTING_SAMPLE,
): Promise<{ price: number | null; trace: SearchDebugTrace }> {
  try {
    const hit = await searchPricedListings(
      body,
      leagueId,
      fx,
      progress,
      ctx,
      isCancelled,
      0,
      sellCeiling,
      sample,
      { stopOnStale: true },
    );
    const detail = estimateSellPriceDetail(hit.priced, {
      ceilingEx: sellCeiling,
    });
    return {
      price: detail.price,
      trace: buildSearchTrace({
        kind: "sell-combo",
        label: ctx,
        typeName,
        statusOption: body.query.status.option,
        queryBody: body,
        queryId: hit.queryId,
        totalHits: hit.totalHits,
        rows: hit.rows,
        priced: hit.priced,
        estimate: detail.price,
        estimateNote: `${detail.note} · ${body.query.status.option}`,
        floorEx: 0,
        ceilingEx: sellCeiling,
      }),
    };
  } catch (e) {
    return {
      price: null,
      trace: buildSearchTrace({
        kind: "sell-combo",
        label: ctx,
        typeName,
        statusOption: body.query.status.option,
        rows: [],
        priced: [],
        estimate: null,
        estimateNote: "error",
        floorEx: 0,
        ceilingEx: sellCeiling,
        error: e instanceof Error ? e.message : String(e),
      }),
    };
  }
}

/**
 * Instant Buyout (`securable`) only unless `includeAvailable`, then fall back
 * to mixed `available` when the marketplace book yields no usable sell.
 */
async function searchSellPricePreferMarket(
  buildBody: (
    status: "securable" | "available",
  ) => TabletTradeSearchBody,
  leagueId: string,
  fx: ExaltFx,
  progress: ProgressFn,
  ctx: string,
  typeName: string,
  isCancelled: () => boolean,
  sellCeiling: number,
  sample = SELL_LISTING_SAMPLE,
  includeAvailable = false,
): Promise<{ price: number | null; trace: SearchDebugTrace }> {
  const statuses = includeAvailable
    ? (["securable", "available"] as const)
    : (["securable"] as const);
  let fallback: { price: number | null; trace: SearchDebugTrace } | null = null;
  for (const status of statuses) {
    const hit = await searchSellPriceEx(
      buildBody(status),
      leagueId,
      fx,
      progress,
      `${ctx} ${status}`,
      typeName,
      isCancelled,
      sellCeiling,
      sample,
    );
    if (hit.price != null && isFinitePositive(hit.price)) return hit;
    if (!fallback) fallback = hit;
  }
  return fallback!;
}

/**
 * One SEARCH for a 10-use rarity book (magic or rare). FETCH the full sample
 * (no sell early-stop) so sell-wall and buy mean-of-B share the same IDs.
 * Instant Buyout first; optional `available` fallback when that book is empty.
 */
async function searchTrashBookPreferMarket(
  buildBody: (status: "securable" | "available") => TabletTradeSearchBody,
  leagueId: string,
  fx: ExaltFx,
  progress: ProgressFn,
  ctx: string,
  typeName: string,
  isCancelled: () => boolean,
  buyFloor: number,
  buyCeiling: number,
  sellCeiling: number,
  buyCountB: number,
  includeAvailable: boolean,
  kinds: { sell: "sell-junk" | "sell-magic"; buy: "buy-junk" | "buy-magic" },
  opts?: {
    forceStatus?: "securable" | "available";
    regime?: MarketFlowRegime;
  },
): Promise<{
  sell: number | null;
  buy: number | null;
  buyPriced: PricedListing[];
  status: "securable" | "available";
  sellTrace: SearchDebugTrace;
  buyTrace: SearchDebugTrace;
}> {
  const statuses = opts?.forceStatus
    ? ([opts.forceStatus] as const)
    : includeAvailable
      ? (["securable", "available"] as const)
      : (["securable"] as const);
  let fallback: {
    sell: number | null;
    buy: number | null;
    buyPriced: PricedListing[];
    status: "securable" | "available";
    sellTrace: SearchDebugTrace;
    buyTrace: SearchDebugTrace;
  } | null = null;
  const kEff = effectiveBuyCountForRegime(opts?.regime ?? "unknown", buyCountB);
  const fetchCeiling = Math.max(buyCeiling, sellCeiling);

  for (const status of statuses) {
    const body = buildBody(status);
    const label = `${ctx} ${status}`;
    try {
      const hit = await searchPricedListings(
        body,
        leagueId,
        fx,
        progress,
        label,
        isCancelled,
        0,
        fetchCeiling,
        TRASH_LISTING_SAMPLE,
      );
      const sellPriced = hit.priced.filter((p) => p.priceEx <= sellCeiling);
      const buyPriced = hit.priced.filter(
        (p) => p.priceEx >= buyFloor && p.priceEx <= buyCeiling,
      );
      const sellDetail = estimateSellPriceDetail(sellPriced, {
        ceilingEx: sellCeiling,
      });
      const buy = estimateBuyPriceMeanOfCheapestEx(buyPriced, kEff);
      const sellTrace = buildSearchTrace({
        kind: kinds.sell,
        label,
        typeName,
        statusOption: status,
        queryBody: body,
        queryId: hit.queryId,
        totalHits: hit.totalHits,
        rows: hit.rows,
        priced: sellPriced,
        estimate: sellDetail.price,
        estimateNote: `${sellDetail.note} · ${status} · 10-use trash book`,
        floorEx: 0,
        ceilingEx: sellCeiling,
      });
      const buyTrace = buildSearchTrace({
        kind: kinds.buy,
        label: `${label} buy mean@${kEff}`,
        typeName,
        statusOption: status,
        queryBody: body,
        queryId: hit.queryId,
        totalHits: hit.totalHits,
        rows: hit.rows,
        priced: buyPriced,
        estimate: buy,
        estimateNote: `${buyMeanEstimateNote(buyPriced.length, kEff)} · reused SEARCH · 10-use`,
        floorEx: buyFloor,
        ceilingEx: buyCeiling,
      });
      const result = {
        sell: sellDetail.price,
        buy,
        buyPriced,
        status,
        sellTrace,
        buyTrace,
      };
      if (
        (result.sell != null && isFinitePositive(result.sell)) ||
        (result.buy != null && isFinitePositive(result.buy))
      ) {
        return result;
      }
      if (!fallback) fallback = result;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const empty = {
        sell: null as number | null,
        buy: null as number | null,
        buyPriced: [] as PricedListing[],
        status,
        sellTrace: buildSearchTrace({
          kind: kinds.sell,
          label,
          typeName,
          statusOption: status,
          rows: [],
          priced: [],
          estimate: null,
          estimateNote: "error",
          floorEx: 0,
          ceilingEx: sellCeiling,
          error: err,
        }),
        buyTrace: buildSearchTrace({
          kind: kinds.buy,
          label,
          typeName,
          statusOption: status,
          rows: [],
          priced: [],
          estimate: null,
          estimateNote: "error",
          floorEx: buyFloor,
          ceilingEx: buyCeiling,
          error: err,
        }),
      };
      if (!fallback) fallback = empty;
    }
  }
  return fallback!;
}

function fullUsesFilter(minUses = FULL_USES) {
  return {
    id: USES_REMAINING_STAT,
    // min only — tablets cap at 10; avoid excluding edge index quirks with max
    value: { min: minUses },
  };
}

function blankTabletQuery(
  baseName: string,
  status: "securable" | "available" | "online" | "any" = "securable",
  /** When set, restrict listings to this currency so API price-sort ≈ exalt. */
  priceCurrency?: string,
): TabletTradeSearchBody {
  const tradeFilters: NonNullable<
    TabletTradeSearchBody["query"]["filters"]["trade_filters"]
  >["filters"] = {
    // Don't collapse — we need depth across accounts for buy@N
    indexed: { option: "1month" },
  };
  if (priceCurrency) {
    tradeFilters.price = { option: priceCurrency };
  }
  return {
    query: {
      status: { option: status },
      type: baseName,
      stats: [
        {
          type: "and",
          filters: [fullUsesFilter(FULL_USES)],
        },
      ],
      filters: {
        type_filters: {
          filters: {
            category: { option: "map.tablet" },
            rarity: { option: "normal" },
          },
        },
        trade_filters: {
          filters: tradeFilters,
        },
      },
    },
    sort: { price: "asc" },
  };
}

function tradeTypeNamesForBase(base: {
  name: string;
  aliases: string[];
}): string[] {
  // Short name first; one *specific* Precursor alias as fallback only.
  // Skip bare "Precursor Tablet" — too broad / wrong base.
  const names = [base.name];
  const precursor = base.aliases.find(
    (a) => /precursor/i.test(a) && !/^precursor tablet$/i.test(a.trim()),
  );
  if (precursor) names.push(precursor);
  return [...new Set(names)];
}

function soloModTabletQuery(
  baseName: string,
  tradeStatId: string,
  min?: number,
  status: "securable" | "available" = "securable",
  max?: number,
): TabletTradeSearchBody {
  return multiModTabletQuery(
    baseName,
    [{ id: tradeStatId, min, max }],
    status,
  );
}

/** AND of N explicit stats — rare/nonunique tablet with uses left. */
function multiModTabletQuery(
  baseName: string,
  stats: Array<{ id: string; min?: number; max?: number }>,
  status: "securable" | "available" = "securable",
): TabletTradeSearchBody {
  return {
    query: {
      // Prefer Instant Buyout (in-game mkt); caller may fall back to available
      status: { option: status },
      type: baseName,
      stats: [
        {
          type: "and",
          filters: [
            // Any remaining uses — crafted stock is often partially used
            fullUsesFilter(1),
            ...stats.map((s) => {
              const hasMin = s.min != null;
              const hasMax = s.max != null;
              return {
                id: s.id,
                value:
                  hasMin || hasMax
                    ? {
                        ...(hasMin ? { min: s.min } : {}),
                        ...(hasMax ? { max: s.max } : {}),
                      }
                    : undefined,
              };
            }),
          ],
        },
      ],
      filters: {
        type_filters: {
          filters: {
            category: { option: "map.tablet" },
            rarity: { option: "nonunique" },
          },
        },
        trade_filters: {
          filters: {
            indexed: { option: "1month" },
          },
        },
      },
    },
    sort: { price: "asc" },
  };
}

/** Broad 10-use rarity book — cheapest Instant Buyout listings of this base. */
function rarityTabletQuery(
  baseName: string,
  rarity: "rare" | "magic",
  status: "securable" | "available" = "securable",
): TabletTradeSearchBody {
  return {
    query: {
      status: { option: status },
      type: baseName,
      stats: [
        {
          type: "and",
          filters: [fullUsesFilter(FULL_USES)],
        },
      ],
      filters: {
        type_filters: {
          filters: {
            category: { option: "map.tablet" },
            rarity: { option: rarity },
          },
        },
        trade_filters: {
          filters: {
            indexed: { option: "1month" },
          },
        },
      },
    },
    sort: { price: "asc" },
  };
}

/** Trash rare floor + rare buy — same SEARCH. Whites would collapse ≈ blank buy. */
function junkTabletQuery(
  baseName: string,
  status: "securable" | "available" = "securable",
): TabletTradeSearchBody {
  return rarityTabletQuery(baseName, "rare", status);
}

/** Trash magic floor + magic buy — same SEARCH. */
function magicTabletQuery(
  baseName: string,
  status: "securable" | "available" = "securable",
): TabletTradeSearchBody {
  return rarityTabletQuery(baseName, "magic", status);
}

export interface MarketSyncResult {
  market: MarketPriceCache;
  status: MarketSyncStatus;
  stats: {
    basesPriced: number;
    combosPriced: number;
    currenciesPriced: number;
  };
  debug?: MarketSyncDebug;
}

export function cloneMarketCache(src: MarketPriceCache): MarketPriceCache {
  return {
    basePrices: { ...src.basePrices },
    currencyCosts: { ...src.currencyCosts },
    modValueMap: { ...src.modValueMap },
    modPremiums: src.modPremiums ? { ...src.modPremiums } : {},
    junkSellByBase: src.junkSellByBase ? { ...src.junkSellByBase } : {},
    junkBuyByBase: src.junkBuyByBase ? { ...src.junkBuyByBase } : {},
    magicSellByBase: src.magicSellByBase ? { ...src.magicSellByBase } : {},
    magicBuyByBase: src.magicBuyByBase ? { ...src.magicBuyByBase } : {},
    measuredAffixSamples: src.measuredAffixSamples
      ? src.measuredAffixSamples.map((s) => ({
          ...s,
          modIds: [...s.modIds],
        }))
      : undefined,
    modRollCurves: src.modRollCurves
      ? Object.fromEntries(
          Object.entries(src.modRollCurves).map(([k, c]) => [
            k,
            {
              ...c,
              anchors: c.anchors.map((a) => ({ ...a })),
            },
          ]),
        )
      : undefined,
    listingAnchors: src.listingAnchors
      ? { ...src.listingAnchors }
      : undefined,
    fx: src.fx ? { ...src.fx } : undefined,
    priceSource: src.priceSource
      ? {
          junkSellByBase: src.priceSource.junkSellByBase
            ? { ...src.priceSource.junkSellByBase }
            : undefined,
          junkBuyByBase: src.priceSource.junkBuyByBase
            ? { ...src.priceSource.junkBuyByBase }
            : undefined,
          magicSellByBase: src.priceSource.magicSellByBase
            ? { ...src.priceSource.magicSellByBase }
            : undefined,
          magicBuyByBase: src.priceSource.magicBuyByBase
            ? { ...src.priceSource.magicBuyByBase }
            : undefined,
          modValueMap: src.priceSource.modValueMap
            ? { ...src.priceSource.modValueMap }
            : undefined,
        }
      : undefined,
  };
}

const SOLO_MOD_KEY_PREFIX = "__solo__:";

/** Combo keys owned by this base: `__solo__:id`, `p+s`, or 3+ `id+id+…`. */
function comboKeyBelongsToBase(key: string, ids: Set<string>): boolean {
  if (key.startsWith(SOLO_MOD_KEY_PREFIX)) {
    const id = key.slice(SOLO_MOD_KEY_PREFIX.length);
    return id.length > 0 && ids.has(id);
  }
  const parts = key.split("+");
  if (!parts.length || parts.some((p) => !p)) return false;
  return parts.every((p) => ids.has(p));
}

/** Wipe blank buy only — keep last-refresh sells until junk+SAB replaces them. */
export function clearBaseBuySlice(market: MarketPriceCache, baseId: string) {
  market.basePrices[baseId] = Number.NaN;
  if (market.junkBuyByBase) delete market.junkBuyByBase[baseId];
  if (market.magicBuyByBase) delete market.magicBuyByBase[baseId];
  if (market.priceSource?.junkBuyByBase) {
    delete market.priceSource.junkBuyByBase[baseId];
  }
  if (market.priceSource?.magicBuyByBase) {
    delete market.priceSource.magicBuyByBase[baseId];
  }
}

/**
 * Wipe measured sells for one base (junk, combos, samples, roll curves).
 * Leaves blank buy and other bases' unique keys intact.
 */
export function clearBaseSellSlice(market: MarketPriceCache, baseId: string) {
  if (market.junkSellByBase) delete market.junkSellByBase[baseId];
  if (market.magicSellByBase) delete market.magicSellByBase[baseId];
  if (market.priceSource?.junkSellByBase) {
    delete market.priceSource.junkSellByBase[baseId];
  }
  if (market.priceSource?.magicSellByBase) {
    delete market.priceSource.magicSellByBase[baseId];
  }
  if (market.measuredAffixSamples) {
    market.measuredAffixSamples = market.measuredAffixSamples.filter(
      (s) => s.baseId !== baseId,
    );
  }
  if (market.modRollCurves) {
    const prefix = `${baseId}/`;
    for (const key of Object.keys(market.modRollCurves)) {
      if (key.startsWith(prefix)) delete market.modRollCurves[key];
    }
  }
  const base = TABLET_BASES[baseId];
  if (!base) return;
  const ids = new Set([
    ...base.allowedPrefixPool,
    ...base.allowedSuffixPool,
  ]);
  // Include orphaned priceSource keys (e.g. source without a live sell)
  const keys = new Set([
    ...Object.keys(market.modValueMap),
    ...Object.keys(market.priceSource?.modValueMap ?? {}),
  ]);
  for (const key of keys) {
    if (!comboKeyBelongsToBase(key, ids)) continue;
    delete market.modValueMap[key];
    if (market.priceSource?.modValueMap) {
      delete market.priceSource.modValueMap[key];
    }
  }
}

/** Wipe buy + sells for one base. Prefer split helpers during a live sync. */
export function clearBaseMarketSlice(
  market: MarketPriceCache,
  baseId: string,
) {
  clearBaseBuySlice(market, baseId);
  clearBaseSellSlice(market, baseId);
}

function ensurePriceSource(market: MarketPriceCache) {
  if (!market.priceSource) market.priceSource = {};
  if (!market.priceSource.junkSellByBase) market.priceSource.junkSellByBase = {};
  if (!market.priceSource.junkBuyByBase) market.priceSource.junkBuyByBase = {};
  if (!market.priceSource.magicSellByBase) {
    market.priceSource.magicSellByBase = {};
  }
  if (!market.priceSource.magicBuyByBase) market.priceSource.magicBuyByBase = {};
  if (!market.priceSource.modValueMap) market.priceSource.modValueMap = {};
}

function stampMeasuredMap(
  market: MarketPriceCache,
  field: "junkSellByBase" | "junkBuyByBase" | "magicSellByBase" | "magicBuyByBase",
  baseId: string,
  price: number,
) {
  market[field] = market[field] ?? {};
  market[field]![baseId] = price;
  ensurePriceSource(market);
  market.priceSource![field]![baseId] = "measured";
}

function stampMeasuredJunk(market: MarketPriceCache, baseId: string, price: number) {
  stampMeasuredMap(market, "junkSellByBase", baseId, price);
}

/** Merge partial sync debug into the previous full trace (replace matching bases). */
export function mergeMarketSyncDebug(
  prev: MarketSyncDebug | null | undefined,
  next: MarketSyncDebug,
  baseIds: string[],
): MarketSyncDebug {
  if (!prev || !baseIds.length) return next;
  const idSet = new Set(baseIds);
  return {
    ...next,
    bases: [
      ...prev.bases.filter((b) => !idSet.has(b.baseId)),
      ...next.bases,
    ],
    combos: [
      ...prev.combos.filter((c) => !idSet.has(c.baseId)),
      ...next.combos,
    ],
  };
}

export async function syncTabletMarketFromTrade(opts?: {
  combosPerBase?: number;
  /** If set, only sync these tablet base ids (others kept from seedMarket). */
  baseIds?: string[];
  /** Existing cache to merge into for partial refreshes. */
  seedMarket?: MarketPriceCache;
  /**
   * Called with a clone after each base's junk+SAB book is usable, and after
   * each probe #2 / final blank commit. Caller must not mutate the clone.
   */
  onPartialMarket?: (
    market: MarketPriceCache,
    debug: MarketSyncDebug,
  ) => void;
  onProgress?: (detail: string) => void;
  isCancelled?: () => boolean;
  /** Buy count B — mean of cheapest B for EV blank cost. */
  buyCountB?: number;
  /**
   * @deprecated Use buyCountB. Read alias for one revision.
   */
  coldBuyDepth?: number;
  /** Delay between buy snapshots for flow detection (ms). */
  flowProbeMs?: number;
  /** Set false to skip re-query (single snapshot, unknown regime → warm depth). */
  flowProbe?: boolean;
  /**
   * When true, fall back to in-person / trade-site (`available`) if Instant
   * Buyout (`securable`) is empty. Default off.
   */
  includeAvailable?: boolean;
}): Promise<MarketSyncResult> {
  const combosPerBase = opts?.combosPerBase ?? 40;
  const progress = opts?.onProgress ?? (() => undefined);
  const isCancelled = opts?.isCancelled ?? (() => false);
  const buyCountB = Math.max(
    5,
    opts?.buyCountB ?? opts?.coldBuyDepth ?? BUY_DEPTH_COLD_DEFAULT,
  );
  const coldBuyDepth = buyCountB;
  const flowProbeMs = opts?.flowProbeMs ?? FLOW_PROBE_MS;
  const flowProbeEnabled = opts?.flowProbe !== false;
  const includeAvailable = opts?.includeAvailable === true;
  const filterIds = opts?.baseIds?.length
    ? new Set(opts.baseIds.filter((id) => !!TABLET_BASES[id]))
    : null;

  const leagueId = await ensureTabletLeagueId(progress, isCancelled);
  if (!leagueId) {
    const leagues = useLeagues();
    const why = leagues.error.value
      ? ` (${leagues.error.value})`
      : leagues.isLoading.value
        ? " (still loading)"
        : "";
    return {
      market: createEmptyMarketCache(),
      status: {
        state: "error",
        message: `No softcore challenge league — prices unavailable (NaN)${why}`,
        partial: false,
      },
      stats: { basesPriced: 0, combosPriced: 0, currenciesPriced: 0 },
    };
  }

  const ninja = usePoeninja();
  progress("Loading poe.ninja currency rates…");
  ninja.queuePricesFetch();

  let rates = buildExaltFx(ninja);
  for (let i = 0; i < 8 && !rates; i++) {
    if (isCancelled()) {
      return {
        market: createEmptyMarketCache(),
        status: {
          state: "error",
          message: "Market sync cancelled",
          partial: false,
        },
        stats: { basesPriced: 0, combosPriced: 0, currenciesPriced: 0 },
      };
    }
    await new Promise((r) => setTimeout(r, 400));
    rates = buildExaltFx(ninja);
  }

  const stats = { basesPriced: 0, combosPriced: 0, currenciesPriced: 0 };

  if (!rates) {
    return {
      market: opts?.seedMarket
        ? cloneMarketCache(opts.seedMarket)
        : createEmptyMarketCache(),
      status: {
        state: "error",
        message: "poe.ninja FX not ready / failed sanity — no FX seeded",
        partial: false,
      },
      stats,
    };
  }

  const { exaltPerChaos, exaltPerDivine } = rates;
  const buyFloor = BUY_DUST_FLOOR_EX;
  const buyCeiling = Math.min(BUY_MAX_EX, exaltPerDivine * 50);
  const sellCeiling = Math.min(SELL_MAX_EX, exaltPerDivine * 200);

  const market = opts?.seedMarket
    ? cloneMarketCache(opts.seedMarket)
    : createEmptyMarketCache();
  market.currencyCosts.exalted = 1;
  market.currencyCosts.chaos = exaltPerChaos;
  market.currencyCosts.scouring = 0;
  market.fx = { exaltPerChaos, exaltPerDivine };

  const currencyNames: Array<{
    key: keyof MarketPriceCache["currencyCosts"];
    name: string;
  }> = [
    { key: "alchemy", name: "Orb of Alchemy" },
    { key: "vaal", name: "Vaal Orb" },
    { key: "transmute", name: "Orb of Transmutation" },
    { key: "augmentation", name: "Orb of Augmentation" },
    { key: "regal", name: "Regal Orb" },
  ];

  for (const { key, name } of currencyNames) {
    const hit = ninja.findPriceByQuery({ ns: "ITEM", name });
    if (!hit?.primaryValue) continue;
    const value = divinePrimaryToExalt(hit.primaryValue, rates);
    if (isFinitePositive(value)) {
      market.currencyCosts[key] = value;
      stats.currenciesPriced++;
    }
  }

  const fx = fxFromMarket(market, rates);
  progress(
    `FX ready: ${exaltPerChaos.toFixed(1)}ex/c, ${exaltPerDivine.toFixed(0)}ex/div`,
  );

  const baseDebug: BaseBuyDebugTrace[] = [];
  const comboDebug: ComboSellDebugTrace[] = [];

  const makeDebug = (): MarketSyncDebug => ({
    revision: MARKET_SYNC_REVISION,
    updatedAt: Date.now(),
    leagueId,
    fx,
    buyFloorEx: buyFloor,
    buyCeilingEx: buyCeiling,
    sellCeilingEx: sellCeiling,
    bases: baseDebug,
    combos: comboDebug,
  });

  const bases = Object.values(TABLET_BASES).filter(
    (b) => !filterIds || filterIds.has(b.id),
  );
  if (!bases.length) {
    return {
      market,
      status: {
        state: "error",
        message: "No matching tablet bases to sync",
        partial: false,
      },
      stats,
      debug: makeDebug(),
    };
  }

  const emitPartial = () => {
    opts?.onPartialMarket?.(cloneMarketCache(market), makeDebug());
  };

  try {
    type TrashSnap = Awaited<ReturnType<typeof searchTrashBookPreferMarket>>;
    type PendingBuy = {
      base: (typeof bases)[number];
      ctx: string;
      typeName: string;
      snap1: NonNullable<Awaited<ReturnType<typeof searchBuyPriceEx>>> | null;
      magicSnap1: TrashSnap | null;
      rareSnap1: TrashSnap | null;
      fetchedAt: number;
      entry: BaseBuyDebugTrace;
    };
    const pendingBuys: PendingBuy[] = [];

    // ── Bookend flow probe ──────────────────────────────────────────────
    // Probe#1 (blank+magic+rare per base) → SAB middle work burns the gap →
    // per-base remainder wait → Probe#2 (last). Wall-clock between snap1→snap2
    // is the detection window only; classifyMarketFlow / mean-of-B do not use
    // gap ms. Variable gap: if middle work already took ≥ FLOW_PROBE_MS, skip
    // idle wait.
    //
    // Buy wipe is per-base at probe #1 (not an all-base clear). Sell wipe is
    // deferred until that base's junk+SAB block so unfinished types keep last
    // refresh sells. Do not publish the working market during probe #1.
    //
    // Provisional blank: junk/combo trade searches do not need blank prices,
    // but we still commit snap1 @ regime=unknown (warm depth) so basePrices
    // exist during middle work / partial cancel. Probe#2 overwrites with
    // snap2 + classified regime for the final market.

    // Phase 1 — Flow probe #1 for every base (securable; opt-in available fallback).
    let baseIdx = 0;
    for (const base of bases) {
      if (isCancelled()) throw new Error("Market sync cancelled");
      baseIdx++;
      const ctx = filterIds
        ? `Blank: ${base.name}`
        : `Blank ${baseIdx}/${bases.length}: ${base.name}`;
      progress(`${ctx} Flow probe #1…`);
      clearBaseBuySlice(market, base.id);

      const typeNames = tradeTypeNamesForBase(base);
      const entry: BaseBuyDebugTrace = {
        baseId: base.id,
        baseName: base.name,
        typeNamesTried: [],
        finalBuy: null,
        searches: [],
      };

      let blankHit: NonNullable<
        Awaited<ReturnType<typeof searchBuyPriceEx>>
      > | null = null;
      let typeNameUsed = typeNames[0] ?? base.name;

      for (const typeName of typeNames) {
        entry.typeNamesTried.push(typeName);
        try {
          // Flow probe must watch Instant Buyout refill — not whisper listings.
          let hit = flowProbeEnabled
            ? await searchBuyPriceEx(
                typeName,
                leagueId,
                fx,
                progress,
                `${ctx} #1 mkt`,
                isCancelled,
                buyFloor,
                buyCeiling,
                coldBuyDepth,
                { forceStatus: "securable" },
              )
            : await searchBuyPriceEx(
                typeName,
                leagueId,
                fx,
                progress,
                `${ctx} #1`,
                isCancelled,
                buyFloor,
                buyCeiling,
                coldBuyDepth,
                { includeAvailable },
              );
          // No marketplace book → optional in-person fallback, skip flow (#2).
          if (!hit && flowProbeEnabled && includeAvailable) {
            hit = await searchBuyPriceEx(
              typeName,
              leagueId,
              fx,
              progress,
              `${ctx} #1 fallback`,
              isCancelled,
              buyFloor,
              buyCeiling,
              coldBuyDepth,
              { forceStatus: "available" },
            );
          }
          if (hit) {
            entry.searches.push(...hit.traces);
            if (isFinitePositive(hit.price)) {
              typeNameUsed = typeName;
              blankHit = hit;
              commitBlankBuyPrice(
                market,
                base.id,
                hit.priced,
                "unknown",
                buyCountB,
                stats,
              );
              break;
            }
          }
        } catch (e) {
          if (isCancelled()) throw e;
          console.warn(`[tablet-market] blank ${typeName}`, e);
          entry.searches.push(
            buildSearchTrace({
              kind: "buy-online",
              label: `${ctx} ${typeName}`,
              typeName,
              rows: [],
              priced: [],
              estimate: null,
              estimateNote: "error",
              floorEx: buyFloor,
              ceilingEx: buyCeiling,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
          progress(
            `${ctx} — ${e instanceof Error ? e.message : String(e)}; skipping…`,
          );
        }
      }
      if (!blankHit) {
        console.warn(`[tablet-market] no 10-use blank listings for ${base.name}`);
      }

      const trashForce = flowProbeEnabled
        ? ("securable" as const)
        : undefined;
      progress(`Magic: ${base.name} #1`);
      const magicSnap1 = await searchTrashBookPreferMarket(
        (status) => magicTabletQuery(typeNameUsed, status),
        leagueId,
        fx,
        progress,
        `Magic: ${base.name} #1`,
        typeNameUsed,
        isCancelled,
        buyFloor,
        buyCeiling,
        sellCeiling,
        buyCountB,
        includeAvailable,
        { sell: "sell-magic", buy: "buy-magic" },
        { forceStatus: trashForce, regime: "unknown" },
      );
      entry.searches.push(magicSnap1.buyTrace);
      if (magicSnap1.buy != null && isFinitePositive(magicSnap1.buy)) {
        stampMeasuredMap(market, "magicBuyByBase", base.id, magicSnap1.buy);
      }
      if (magicSnap1.sell != null && isFinitePositive(magicSnap1.sell)) {
        stampMeasuredMap(market, "magicSellByBase", base.id, magicSnap1.sell);
      }

      progress(`Junk: ${base.name} #1`);
      const rareSnap1 = await searchTrashBookPreferMarket(
        (status) => junkTabletQuery(typeNameUsed, status),
        leagueId,
        fx,
        progress,
        `Junk: ${base.name} #1`,
        typeNameUsed,
        isCancelled,
        buyFloor,
        buyCeiling,
        sellCeiling,
        buyCountB,
        includeAvailable,
        { sell: "sell-junk", buy: "buy-junk" },
        { forceStatus: trashForce, regime: "unknown" },
      );
      entry.searches.push(rareSnap1.buyTrace);
      if (rareSnap1.buy != null && isFinitePositive(rareSnap1.buy)) {
        stampMeasuredMap(market, "junkBuyByBase", base.id, rareSnap1.buy);
      }
      if (rareSnap1.sell != null && isFinitePositive(rareSnap1.sell)) {
        stampMeasuredJunk(market, base.id, rareSnap1.sell);
      }

      pendingBuys.push({
        base,
        ctx,
        typeName: typeNameUsed,
        snap1: blankHit,
        magicSnap1,
        rareSnap1,
        fetchedAt: Date.now(),
        entry,
      });
    }

    // Middle work — per-base trash books (rare+magic) + SAB after all probe #1.
    const pendingByBase = new Map(pendingBuys.map((p) => [p.base.id, p]));
    let comboDone = 0;
    // Closed SAB sell worklist (S/A solos, SS/SA/AA duos, all-S 3/4; no SB)
    const plans = bases.map((base) => ({
      base,
      work: buildSabSyncWorklist(base.id, combosPerBase),
    }));
    const comboTotal = plans.reduce((n, p) => n + p.work.length, 0);
    for (const { base, work } of plans) {
      clearBaseSellSlice(market, base.id);

      const pending = pendingByBase.get(base.id);
      const typeName =
        pending?.typeName ?? tradeTypeNamesForBase(base)[0] ?? base.name;
      if (isCancelled()) throw new Error("Market sync cancelled");

      for (const item of work) {
        if (isCancelled()) throw new Error("Market sync cancelled");
        comboDone++;
        const ctx = filterIds
          ? `SAB ${comboDone}/${comboTotal || 1}: ${base.name}`
          : `SAB ${Math.min(comboDone, comboTotal)}/${comboTotal || 1}: ${base.name}`;
        progress(ctx);
        const { price, trace } = await searchSellPricePreferMarket(
          (status) =>
            item.stats.length === 1
              ? soloModTabletQuery(
                  typeName,
                  item.stats[0]!.id,
                  item.stats[0]!.min,
                  status,
                  item.stats[0]!.max,
                )
              : multiModTabletQuery(typeName, item.stats, status),
          leagueId,
          fx,
          progress,
          ctx,
          typeName,
          isCancelled,
          sellCeiling,
          SELL_LISTING_SAMPLE,
          includeAvailable,
        );
        comboDebug.push({
          baseId: base.id,
          baseName: base.name,
          comboKey: item.comboKey,
          finalSell: price,
          search: trace,
        });

        if (price != null && isFinitePositive(price)) {
          applySabSyncHit(market, base.id, item, price);
          stats.combosPriced++;
        }
      }
      emitPartial();
    }

    // Phase 2 — remainder wait, then probe#2 for blank + magic + rare.
    for (const pending of pendingBuys) {
      if (isCancelled()) throw new Error("Market sync cancelled");
      const {
        base,
        ctx,
        typeName,
        snap1,
        magicSnap1,
        rareSnap1,
        fetchedAt,
        entry,
      } = pending;
      const canFlowProbe = flowProbeEnabled && snap1?.status === "securable";
      const trashFlow =
        flowProbeEnabled &&
        (magicSnap1?.status === "securable" ||
          rareSnap1?.status === "securable");

      let regime: MarketFlowRegime = "unknown";
      let priced = snap1?.priced ?? [];
      let status = snap1?.status ?? "securable";
      let mix = snap1?.mix ?? "";
      let sampleSize = snap1?.sampleSize ?? 0;
      let actualGapMs: number | undefined;

      if (canFlowProbe || trashFlow) {
        const waitMore = remainingFlowProbeWaitMs(
          fetchedAt,
          Date.now(),
          flowProbeMs,
        );
        if (waitMore > FLOW_PROBE_WAIT_SKIP_MS) {
          await sleepCancellable(
            waitMore,
            isCancelled,
            progress,
            "Flow probe wait",
          );
        }
        actualGapMs = Date.now() - fetchedAt;
        progress(`${ctx} Flow probe #2…`);
      } else {
        progress(`${ctx} commit…`);
      }

      if (canFlowProbe && snap1) {
        try {
          const snap2 = await searchBuyPriceEx(
            typeName,
            leagueId,
            fx,
            progress,
            `${ctx} #2 mkt`,
            isCancelled,
            buyFloor,
            buyCeiling,
            coldBuyDepth,
            { forceStatus: "securable" },
          );
          if (snap2) {
            entry.searches.push(...snap2.traces);
            regime = classifyMarketFlow(snap1.priced, snap2.priced);
            priced = snap2.priced.length ? snap2.priced : snap1.priced;
            status = snap2.status;
            mix = snap2.mix;
            sampleSize = priced.length;
          } else {
            regime = "cold";
          }
        } catch (e) {
          if (isCancelled()) throw e;
          console.warn(`[tablet-market] flow probe ${typeName}`, e);
          regime = "unknown";
        }
      }

      const kEff = effectiveBuyCountForRegime(regime, buyCountB);
      const price =
        priced.length > 0
          ? commitBlankBuyPrice(
              market,
              base.id,
              priced,
              regime,
              buyCountB,
              stats,
            )
          : null;
      if (priced.length) {
        entry.searches.push(
          buildSearchTrace({
            kind: "buy-securable",
            label: `${ctx} flow=${regime} mean@${kEff} · ${status}`,
            typeName,
            statusOption: status,
            rows: [],
            priced,
            estimate: price,
            estimateNote: `flow=${regime} · ${buyMeanEstimateNote(priced.length, buyCountB, regime)} · ${status}`,
            floorEx: buyFloor,
            ceilingEx: buyCeiling,
          }),
        );
      }

      const restampTrash = async (
        snapA: TrashSnap | null,
        buildBody: (
          status: "securable" | "available",
        ) => TabletTradeSearchBody,
        kinds: {
          sell: "sell-junk" | "sell-magic";
          buy: "buy-junk" | "buy-magic";
        },
        buyField: "junkBuyByBase" | "magicBuyByBase",
        sellField: "junkSellByBase" | "magicSellByBase",
        comboKey: string,
        label: string,
      ) => {
        if (!snapA) return;
        let book = snapA;
        if (flowProbeEnabled && snapA.status === "securable") {
          const snapB = await searchTrashBookPreferMarket(
            buildBody,
            leagueId,
            fx,
            progress,
            `${label} #2`,
            typeName,
            isCancelled,
            buyFloor,
            buyCeiling,
            sellCeiling,
            buyCountB,
            includeAvailable,
            kinds,
            { forceStatus: "securable", regime: "unknown" },
          );
          entry.searches.push(snapB.buyTrace);
          const bookRegime = classifyMarketFlow(
            snapA.buyPriced,
            snapB.buyPriced,
          );
          const k2 = effectiveBuyCountForRegime(bookRegime, buyCountB);
          const buy2 = estimateBuyPriceMeanOfCheapestEx(snapB.buyPriced, k2);
          book = {
            ...snapB,
            buy: buy2 ?? snapB.buy ?? snapA.buy,
            sell: snapB.sell ?? snapA.sell,
          };
        }
        comboDebug.push({
          baseId: base.id,
          baseName: base.name,
          comboKey,
          finalSell: book.sell,
          search: book.sellTrace,
        });
        if (book.buy != null && isFinitePositive(book.buy)) {
          stampMeasuredMap(market, buyField, base.id, book.buy);
        }
        if (book.sell != null && isFinitePositive(book.sell)) {
          stampMeasuredMap(market, sellField, base.id, book.sell);
        }
      };
      await restampTrash(
        magicSnap1,
        (s) => magicTabletQuery(typeName, s),
        { sell: "sell-magic", buy: "buy-magic" },
        "magicBuyByBase",
        "magicSellByBase",
        "__magic__",
        `Magic: ${base.name}`,
      );
      await restampTrash(
        rareSnap1,
        (s) => junkTabletQuery(typeName, s),
        { sell: "sell-junk", buy: "buy-junk" },
        "junkBuyByBase",
        "junkSellByBase",
        "__junk__",
        `Junk: ${base.name}`,
      );

      if (price != null && isFinitePositive(price)) {
        entry.finalBuy = price;
        entry.finalStatus = status;
        console.info(
          `[tablet-market] ${base.name} buy=${price.toFixed(1)}ex ` +
            `n=${sampleSize} mix=${mix} flow=${regime} mean@${kEff}` +
            (actualGapMs != null ? ` gapMs=${actualGapMs}` : ""),
        );
      }
      baseDebug.push(entry);
      emitPartial();
    }
  } catch (e) {
    return {
      market,
      status: {
        state: "error",
        message: e instanceof Error ? e.message : String(e),
        partial: stats.basesPriced + stats.combosPriced > 0,
      },
      stats,
      debug: makeDebug(),
    };
  }

  for (const [key, value] of Object.entries(market.modValueMap)) {
    if (!isFinitePositive(value)) delete market.modValueMap[key];
  }

  // Seed listing anchors from measured sells so Magic-Pipeline isn't stuck on NaN
  {
    const sells = Object.values(market.modValueMap).filter(isFinitePositive);
    const junks = Object.values(market.junkSellByBase ?? {}).filter(
      isFinitePositive,
    );
    const hi = sells.length ? Math.max(...sells) : Number.NaN;
    const mid = sells.length
      ? [...sells].sort((a, b) => a - b)[Math.floor(sells.length / 2)]!
      : Number.NaN;
    const lo = junks.length
      ? Math.min(...junks)
      : sells.length
        ? Math.min(...sells)
        : Number.NaN;
    market.listingAnchors = {
      tradeDivine: Number.isFinite(hi)
        ? Math.max(hi, exaltPerDivine)
        : exaltPerDivine,
      merchantHigh: Number.isFinite(hi) ? hi : Number.NaN,
      merchantMid: Number.isFinite(mid) ? mid : Number.NaN,
      merchantLow: Number.isFinite(lo) ? lo : Number.NaN,
    };
  }

  const scopeLabel = filterIds
    ? bases.map((b) => b.name.replace(/ Tablet$/i, "")).join("+")
    : null;
  const listingTag = includeAvailable ? "+whisper" : "mkt-only";
  const sourceParts = [
    `r${MARKET_SYNC_REVISION}`,
    scopeLabel ? `only:${scopeLabel}` : null,
    stats.currenciesPriced ? "ninja orbs" : null,
    stats.basesPriced
      ? `${stats.basesPriced} bases(mean@hot${BUY_DEPTH_HOT}/B${buyCountB}/warm${BUY_DEPTH_N}${flowProbeEnabled ? "+flow" : ""},10u,any-currency,${listingTag},p65,+magic+rare-flow)`
      : null,
    stats.combosPriced
      ? `${stats.combosPriced} SAB-combos(sell,${listingTag},p65,noSB)`
      : null,
    `${exaltPerChaos.toFixed(0)}ex/c`,
    `${exaltPerDivine.toFixed(0)}ex/div`,
  ].filter(Boolean);

  return {
    market,
    status: {
      state: "ready",
      updatedAt: Date.now(),
      source: sourceParts.length
        ? `Live: ${sourceParts.join(", ")}`
        : "No trade listings measured (bases/combos NaN)",
    },
    stats,
    debug: makeDebug(),
  };
}

export function summarizeMarketForUi(
  rows: TabletEVResult[],
  status: MarketSyncStatus,
): string {
  if (status.state === "loading") return status.detail;
  if (status.state === "error") return status.message;
  if (status.state === "ready") {
    const top = rows.find((r) => Number.isFinite(r.netEV));
    return top
      ? `${status.source} · Top: ${top.baseName} (${top.netEV.toFixed(2)}ex EV)`
      : status.source;
  }
  return "Waiting for live market sync (unmeasured = NaN)";
}

function surveyModQuery(
  baseName: string,
  item: SurveyWorkItem,
  opts?: {
    includeUses?: boolean;
    status?: "available" | "any" | "securable" | "online";
  },
): TabletTradeSearchBody {
  const includeUses = opts?.includeUses !== false;
  const status = opts?.status ?? "securable";
  const filters = [
    ...(includeUses ? [fullUsesFilter(1)] : []),
    ...item.stats.map((s) => ({
      id: s.id,
      value: s.min != null ? { min: s.min } : undefined,
    })),
  ];
  return {
    query: {
      status: { option: status },
      type: baseName,
      stats: [{ type: "and", filters }],
      filters: {
        type_filters: {
          filters: {
            category: { option: "map.tablet" },
            rarity: { option: "nonunique" },
          },
        },
        trade_filters: {
          filters: { indexed: { option: "1month" } },
        },
      },
    },
    sort: { price: "asc" },
  };
}

/**
 * Long-running Breach tier survey with durable resume, global RL gate,
 * defer-on-429, and crash isolation (one item never aborts the job).
 */
export async function runTabletTierSurvey(opts?: {
  baseId?: string;
  seed?: TierSurveyDocument | null;
  onProgress?: (detail: string, doc: TierSurveyDocument) => void;
  isCancelled?: () => boolean;
}): Promise<TierSurveyDocument> {
  const baseId = opts?.baseId ?? "breach_tablet";
  const base = TABLET_BASES[baseId];
  const isCancelled = opts?.isCancelled ?? (() => false);
  const gate = new SurveyTradeGate();

  const ninja = usePoeninja();
  const leagueId = resolveTabletLeagueId();
  const rates = buildExaltFx(ninja);

  if (!leagueId || !rates || !base) {
    const failed =
      opts?.seed ??
      createSurveyDocument({
        baseId,
        leagueId: leagueId ?? "unknown",
        fx: { exaltPerChaos: 1, exaltPerDivine: 1 },
      });
    failed.status = "error";
    failed.message = !leagueId
      ? "No softcore challenge league available"
      : !rates
        ? "poe.ninja FX unavailable"
        : `Unknown base ${baseId}`;
    return failed;
  }

  const doc =
    opts?.seed &&
    opts.seed.baseId === baseId &&
    opts.seed.revision === TIER_SURVEY_REVISION &&
    opts.seed.leagueId === leagueId
      ? opts.seed
      : createSurveyDocument({
          baseId,
          leagueId,
          fx: {
            exaltPerChaos: rates.exaltPerChaos,
            exaltPerDivine: rates.exaltPerDivine,
          },
        });

  if (!doc.deferredKeys) doc.deferredKeys = [];
  if (!doc.surveyPass) doc.surveyPass = 1;

  const progress: ProgressFn = (d) => opts?.onProgress?.(d, doc);
  progress(`League: ${leagueId} (softcore challenge)`);

  reorderSurveyQueueSplintersLast(doc);
  const deferredSplinters = deferUnfinishedSplinters(doc);
  if (deferredSplinters > 0) {
    progress(
      `Splinters deferred to end of survey (${deferredSplinters} items)`,
    );
  }

  doc.status = "running";
  doc.leagueId = leagueId;
  doc.fx = {
    exaltPerChaos: rates.exaltPerChaos,
    exaltPerDivine: rates.exaltPerDivine,
  };
  const fx = rates;
  const typeName = tradeTypeNamesForBase(base)[0];
  const sellCeiling = SELL_MAX_EX;

  const record = (
    item: SurveyWorkItem,
    price: number | null,
    totalHits?: number,
    error?: string,
  ) => {
    const dump = doc.anchors.dumpEx;
    const { octave, octaveRound } = computeOctave(price, dump);
    doc.observations[item.key] = {
      key: item.key,
      kind: item.kind,
      label: item.label,
      modIds: item.modIds,
      sellEx: price,
      totalHits,
      octave,
      octaveRound,
      error,
      updatedAt: Date.now(),
    };
    doc.deferredKeys = (doc.deferredKeys ?? []).filter((k) => k !== item.key);
    doc.updatedAt = Date.now();
  };

  const deferItem = (item: SurveyWorkItem, reason: string) => {
    if (!(doc.deferredKeys ?? []).includes(item.key)) {
      doc.deferredKeys = [...(doc.deferredKeys ?? []), item.key];
    }
    doc.updatedAt = Date.now();
    progress(`Deferred ${item.key} (${reason})`);
  };

  const recomputeOctaves = () => {
    for (const obs of Object.values(doc.observations)) {
      const o = computeOctave(obs.sellEx, doc.anchors.dumpEx);
      obs.octave = o.octave;
      obs.octaveRound = o.octaveRound;
    }
  };

  const maybeFollowUps = () => {
    if (doc.followUpsGenerated) return;
    const incomplete = doc.queue.some((q) => !doc.observations[q.key]);
    if (incomplete) return;
    const extras = appendDoubleFollowUps(doc);
    if (extras.length) {
      doc.queue.push(...extras);
      progress(`Phase 3: +${extras.length} same-side 2-stat follow-ups`);
    }
    doc.followUpsGenerated = true;
  };

  const handleRateLimit = async (
    item: SurveyWorkItem,
    errMsg: string,
    ctx: string,
  ): Promise<"continue" | "paused"> => {
    const sec = parseRateLimitWaitSec(errMsg) ?? 60;
    await gate.noteRateLimit(sec, progress);
    if (gate.shouldPause()) {
      doc.status = "paused";
      doc.message = `Paused after repeated long rate limits (${ctx})`;
      progress(doc.message);
      return "paused";
    }
    const isAnchor =
      item.kind === "anchor-blank" || item.kind === "anchor-dump";
    if (isAnchor || doc.surveyPass === 2) {
      // Anchors / pass-2: one more attempt next loop iteration (still no obs)
      return "continue";
    }
    deferItem(item, `RL ${sec}s`);
    return "continue";
  };

  const sellOnce = async (
    label: string,
    body: TabletTradeSearchBody,
  ): Promise<{ price: number | null; trace: SearchDebugTrace }> => {
    await gate.acquire(progress);
    if (isCancelled()) throw new Error("Survey cancelled");
    return searchSellPriceEx(
      body,
      leagueId,
      fx,
      progress,
      label,
      typeName,
      isCancelled,
      sellCeiling,
      SURVEY_LISTING_SAMPLE,
    );
  };

  /** Instant Buyout first; mixed available only if mkt yields no price. */
  const sellOncePreferMarket = async (
    label: string,
    buildBody: (
      status: "securable" | "available",
    ) => TabletTradeSearchBody,
  ): Promise<{ price: number | null; trace: SearchDebugTrace }> => {
    let fallback: { price: number | null; trace: SearchDebugTrace } | null =
      null;
    for (const status of ["securable", "available"] as const) {
      const hit = await sellOnce(`${label} ${status}`, buildBody(status));
      if (hit.trace.error && /rate limit/i.test(hit.trace.error)) return hit;
      if (hit.price != null && isFinitePositive(hit.price)) return hit;
      if (!fallback) fallback = hit;
    }
    return fallback!;
  };

  try {
    while (true) {
      if (isCancelled()) {
        doc.status = "cancelled";
        doc.message = "Survey cancelled";
        progress(doc.message);
        return doc;
      }

      maybeFollowUps();
      let { pending, done, total } = surveyProgress(doc);

      if (!pending.length) {
        if (
          (doc.surveyPass ?? 1) === 1 &&
          (doc.deferredKeys?.length ?? 0) > 0
        ) {
          doc.surveyPass = 2;
          gate.resetPauseCounters();
          progress(
            `Pass 2: retrying ${doc.deferredKeys!.length} deferred items`,
          );
          ({ pending, done, total } = surveyProgress(doc));
        }
        if (!pending.length) break;
      }

      const item = pending[0];
      const ctx = `Survey ${done + 1}/${total} [p${doc.surveyPass ?? 1}]: ${item.label}`;
      progress(ctx);

      try {
        if (item.kind === "anchor-dump") {
          const { price, trace } = await sellOncePreferMarket(ctx, (status) =>
            junkTabletQuery(typeName, status),
          );
          if (trace.error && /rate limit/i.test(trace.error)) {
            if ((await handleRateLimit(item, trace.error, ctx)) === "paused") {
              return doc;
            }
            continue;
          }
          await gate.noteSuccess();
          const blank = doc.anchors.blankBuyEx;
          const blankFloor =
            blank != null && blank > 0 ? blank * 0.2 : BUY_DUST_FLOOR_EX;
          const usable =
            price != null &&
            price >= Math.max(BUY_DUST_FLOOR_EX, blankFloor * 0.5)
              ? price
              : null;
          doc.anchors.dumpEx = usable ?? blankFloor;
          record(item, usable ?? doc.anchors.dumpEx, trace.totalHits, trace.error);
          if (usable == null) {
            progress(
              `Dump dust/empty — using ${doc.anchors.dumpEx!.toFixed(1)}ex floor`,
            );
          }
          recomputeOctaves();
          continue;
        }

        if (item.kind === "anchor-blank") {
          try {
            await gate.acquire(progress);
            const hit = await searchBuyPriceEx(
              typeName,
              leagueId,
              fx,
              progress,
              ctx,
              isCancelled,
              BUY_DUST_FLOOR_EX,
              BUY_MAX_EX,
            );
            await gate.noteSuccess();
            const price = hit?.price ?? null;
            doc.anchors.blankBuyEx = price;
            record(item, price, hit?.sampleSize);
            if (
              (doc.anchors.dumpEx == null || !(doc.anchors.dumpEx > 0)) &&
              price != null &&
              price > 0
            ) {
              doc.anchors.dumpEx = price * 0.2;
              recomputeOctaves();
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/rate limit/i.test(msg)) {
              if ((await handleRateLimit(item, msg, ctx)) === "paused") {
                return doc;
              }
              continue;
            }
            record(item, null, undefined, msg);
          }
          continue;
        }

        const isSplinterItem = item.modIds.some((id) =>
          id.includes("splinter_qty"),
        );

        let { price, trace } = await sellOncePreferMarket(ctx, (status) =>
          surveyModQuery(typeName, item, { status }),
        );

        if (trace.error && /rate limit/i.test(trace.error)) {
          if ((await handleRateLimit(item, trace.error, ctx)) === "paused") {
            return doc;
          }
          continue;
        }

        if (
          isSplinterItem &&
          !trace.error &&
          (trace.totalHits == null || trace.totalHits === 0)
        ) {
          progress(`${ctx} — splinter 0 hits, retry without uses`);
          ({ price, trace } = await sellOncePreferMarket(
            `${ctx} (no-uses)`,
            (status) =>
              surveyModQuery(typeName, item, {
                includeUses: false,
                status,
              }),
          ));
          if (trace.error && /rate limit/i.test(trace.error)) {
            if ((await handleRateLimit(item, trace.error, ctx)) === "paused") {
              return doc;
            }
            continue;
          }
        }

        await gate.noteSuccess();
        record(item, price, trace.totalHits, trace.error);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "Survey cancelled" || isCancelled()) {
          doc.status = "cancelled";
          doc.message = "Survey cancelled";
          return doc;
        }
        if (/rate limit/i.test(msg)) {
          if ((await handleRateLimit(item, msg, ctx)) === "paused") {
            return doc;
          }
          continue;
        }
        // Crash isolation — record and move on
        record(item, null, undefined, msg);
        progress(`${ctx} — error recorded, continuing`);
      }
    }

    doc.status = "complete";
    doc.message = `Complete: ${Object.keys(doc.observations).length} observations`;
    progress(doc.message);
    return doc;
  } catch (e) {
    // Last-resort isolation
    doc.status = "error";
    doc.message = e instanceof Error ? e.message : String(e);
    progress(doc.message);
    return doc;
  }
}
