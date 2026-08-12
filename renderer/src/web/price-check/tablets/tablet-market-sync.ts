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
import { TABLET_BASES, getHighValueModsForBase } from "./mod-weights";
import { createEmptyMarketCache } from "./default-market";
import { isFinitePositive } from "./market-sanity";
import {
  BUY_DEPTH_N,
  BUY_DUST_FLOOR_EX,
  BUY_MAX_EX,
  SELL_MAX_EX,
  buyEstimateNote,
  estimateBuyPriceEx,
  estimateSellPriceEx,
  listingAmountToExalt,
  type ExaltFx,
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
export const MARKET_SYNC_REVISION = 17;

/** Buy blanks: enough depth for buy@N after mixed-currency re-sort. */
const BUY_LISTING_SAMPLE = 30;
/** Second buy leg priced in exalt so API sort ≈ exalt order. */
const BUY_EXALT_SAMPLE = 25;
/** Sell comps only need a floor / thin stale sample — not a full book. */
const SELL_LISTING_SAMPLE = 20;
const JUNK_LISTING_SAMPLE = 15;
/** Survey fetch depth — fewer FETCH tokens per search. */
const SURVEY_LISTING_SAMPLE = 8;
const FETCH_BATCH = 10;
/** Sample big enough to skip a second buy-status search. */
const ONLINE_GOOD_ENOUGH = 8;
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
 * - securable = Instant Buyout (merchant tab / marketplace)
 * - available = Instant Buyout AND In Person
 * - online    = In Person (Online) ONLY — excludes marketplace
 * - any       = includes offline ghosts
 *
 * Trade sorts by *raw* currency amount (1 divine before 50 vaal), so a single
 * mixed-currency page is exalt-biased. We merge an any-currency leg with an
 * exalted-only leg, convert everything to exalt, then estimate.
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
): Promise<{
  price: number;
  sampleSize: number;
  status: "securable" | "available";
  mix: string;
  traces: SearchDebugTrace[];
} | null> {
  const traces: SearchDebugTrace[] = [];

  type BuyBand = {
    status: "available" | "securable";
    kind: "buy-available" | "buy-securable";
    note: string;
  };
  const bands: BuyBand[] = [
    {
      status: "available",
      kind: "buy-available",
      note: "instant buyout + in-person online",
    },
    {
      status: "securable",
      kind: "buy-securable",
      note: "marketplace / instant buyout only",
    },
  ];

  let best: {
    price: number;
    sampleSize: number;
    status: "securable" | "available";
    mix: string;
  } | null = null;

  for (const band of bands) {
    const legs: Array<{
      priceCurrency?: string;
      sample: number;
      tag: string;
    }> = [
      {
        sample: BUY_LISTING_SAMPLE,
        tag: "any-ccy (API raw-amount sort)",
      },
      {
        priceCurrency: "exalted",
        sample: BUY_EXALT_SAMPLE,
        tag: "exalted-only (sort≈exalt)",
      },
    ];

    const mergedRows: ListingDebugRow[] = [];
    const seen = new Set<string>();

    for (const leg of legs) {
      const body = blankTabletQuery(
        typeName,
        band.status,
        leg.priceCurrency,
      );
      const hit = await searchPricedListings(
        body,
        leagueId,
        fx,
        progress,
        `${ctx} ${band.status}${leg.priceCurrency ? ` ${leg.priceCurrency}` : ""}`,
        isCancelled,
        buyFloor,
        buyCeiling,
        leg.sample,
      );
      const legPriced = hit.priced;
      const legPrice = estimateBuyPriceEx(legPriced, BUY_DEPTH_N);
      traces.push(
        buildSearchTrace({
          kind: band.kind,
          label: `${ctx} ${band.status} · ${leg.tag}`,
          typeName,
          statusOption: band.status,
          queryBody: body,
          queryId: hit.queryId,
          totalHits: hit.totalHits,
          rows: hit.rows,
          priced: legPriced,
          estimate: legPrice,
          estimateNote: `${buyEstimateNote(legPriced.length, BUY_DEPTH_N)} · ${leg.tag}`,
          floorEx: buyFloor,
          ceilingEx: buyCeiling,
        }),
      );

      for (const row of hit.rows) {
        const key = `${row.amount}|${row.currency}|${row.indexedAt ?? ""}|${row.keep}`;
        if (seen.has(key)) continue;
        seen.add(key);
        mergedRows.push(row);
      }
    }

    const priced = keptToPriced(mergedRows);
    const price = estimateBuyPriceEx(priced, BUY_DEPTH_N);
    traces.push(
      buildSearchTrace({
        kind: band.kind,
        label: `${ctx} ${band.status} · merged any+exalt (${band.note})`,
        typeName,
        statusOption: band.status,
        rows: mergedRows
          .slice()
          .sort(
            (a, b) =>
              (a.priceEx ?? Number.POSITIVE_INFINITY) -
              (b.priceEx ?? Number.POSITIVE_INFINITY),
          ),
        priced,
        estimate: price,
        estimateNote: `${buyEstimateNote(priced.length, BUY_DEPTH_N)} · merged (ex-sorted display)`,
        floorEx: buyFloor,
        ceilingEx: buyCeiling,
      }),
    );

    if (price == null || !priced.length) continue;

    const candidate = {
      price,
      sampleSize: priced.length,
      status: band.status,
      mix: currencyMixSummary(priced),
    };

    if (
      priced.length >= BUY_DEPTH_N ||
      priced.length >= ONLINE_GOOD_ENOUGH
    ) {
      return { ...candidate, traces };
    }

    if (!best || candidate.sampleSize > best.sampleSize) {
      best = candidate;
    }
  }

  if (!best) return null;
  return { ...best, traces };
}

/** Sell (crafted value): cheapest stale (≥1d) else live floor × 0.95. */
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
    );
    const price = estimateSellPriceEx(hit.priced, { ceilingEx: sellCeiling });
    return {
      price,
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
        estimate: price,
        estimateNote: price != null ? "live floor / near-stale" : "empty",
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

function fullUsesFilter(minUses = FULL_USES) {
  return {
    id: USES_REMAINING_STAT,
    // min only — tablets cap at 10; avoid excluding edge index quirks with max
    value: { min: minUses },
  };
}

function blankTabletQuery(
  baseName: string,
  status: "securable" | "available" | "online" | "any" = "available",
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

function comboTabletQuery(
  baseName: string,
  prefixTradeId: string,
  suffixTradeId: string,
  prefixMin?: number,
  suffixMin?: number,
): TabletTradeSearchBody {
  return {
    query: {
      // Prefer live market for sell comps; offline ghosts inflate thin combo books
      status: { option: "available" },
      type: baseName,
      stats: [
        {
          type: "and",
          filters: [
            // Any remaining uses — crafted stock is often partially used
            fullUsesFilter(1),
            {
              id: prefixTradeId,
              value: prefixMin != null ? { min: prefixMin } : undefined,
            },
            {
              id: suffixTradeId,
              value: suffixMin != null ? { min: suffixMin } : undefined,
            },
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

/** Broad junk/rare floor — rolled rares of this base with uses left. */
function junkTabletQuery(baseName: string): TabletTradeSearchBody {
  return {
    query: {
      status: { option: "available" },
      type: baseName,
      stats: [
        {
          type: "and",
          filters: [fullUsesFilter(1)],
        },
      ],
      filters: {
        type_filters: {
          filters: {
            category: { option: "map.tablet" },
            // Rare only — whites would collapse junk ≈ blank buy
            rarity: { option: "rare" },
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

function cloneMarketCache(src: MarketPriceCache): MarketPriceCache {
  return {
    basePrices: { ...src.basePrices },
    currencyCosts: { ...src.currencyCosts },
    modValueMap: { ...src.modValueMap },
    modPremiums: src.modPremiums ? { ...src.modPremiums } : {},
    junkSellByBase: src.junkSellByBase ? { ...src.junkSellByBase } : {},
    listingAnchors: src.listingAnchors
      ? { ...src.listingAnchors }
      : undefined,
    fx: src.fx ? { ...src.fx } : undefined,
  };
}

/** Wipe measured prices for one base so a partial refresh cannot leave stale combos. */
function clearBaseMarketSlice(market: MarketPriceCache, baseId: string) {
  market.basePrices[baseId] = Number.NaN;
  if (market.junkSellByBase) delete market.junkSellByBase[baseId];
  const base = TABLET_BASES[baseId];
  if (!base) return;
  const ids = new Set([
    ...base.allowedPrefixPool,
    ...base.allowedSuffixPool,
  ]);
  for (const key of Object.keys(market.modValueMap)) {
    const [p, s] = key.split("+");
    if (ids.has(p) && ids.has(s)) delete market.modValueMap[key];
  }
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
  onProgress?: (detail: string) => void;
  isCancelled?: () => boolean;
}): Promise<MarketSyncResult> {
  const combosPerBase = opts?.combosPerBase ?? 8;
  const progress = opts?.onProgress ?? (() => undefined);
  const isCancelled = opts?.isCancelled ?? (() => false);
  const filterIds = opts?.baseIds?.length
    ? new Set(opts.baseIds.filter((id) => !!TABLET_BASES[id]))
    : null;

  const leagueId = resolveTabletLeagueId();
  if (!leagueId) {
    return {
      market: createEmptyMarketCache(),
      status: {
        state: "error",
        message: "No softcore challenge league — prices unavailable (NaN)",
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

  // Drop stale measurements for bases we're about to re-price
  for (const base of bases) {
    clearBaseMarketSlice(market, base.id);
  }

  try {
    let baseIdx = 0;
    for (const base of bases) {
      if (isCancelled()) throw new Error("Market sync cancelled");
      baseIdx++;
      const ctx = filterIds
        ? `Blank: ${base.name}`
        : `Blank ${baseIdx}/${bases.length}: ${base.name}`;
      progress(`${ctx} (10 uses)…`);

      const typeNames = tradeTypeNamesForBase(base);
      const entry: BaseBuyDebugTrace = {
        baseId: base.id,
        baseName: base.name,
        typeNamesTried: [],
        finalBuy: null,
        searches: [],
      };

      for (const typeName of typeNames) {
        entry.typeNamesTried.push(typeName);
        try {
          const hit = await searchBuyPriceEx(
            typeName,
            leagueId,
            fx,
            progress,
            ctx,
            isCancelled,
            buyFloor,
            buyCeiling,
          );
          if (hit) {
            entry.searches.push(...hit.traces);
            if (isFinitePositive(hit.price)) {
              market.basePrices[base.id] = hit.price;
              stats.basesPriced++;
              entry.finalBuy = hit.price;
              entry.finalStatus = hit.status;
              console.info(
                `[tablet-market] ${base.name} buy=${hit.price.toFixed(1)}ex ` +
                  `n=${hit.sampleSize} mix=${hit.mix} (${hit.status})`,
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
      baseDebug.push(entry);
      if (entry.finalBuy == null) {
        console.warn(`[tablet-market] no 10-use blank listings for ${base.name}`);
      }

      // Junk/rare floor for EV long-tail (unmeasured combos)
      if (entry.typeNamesTried[0]) {
        const junkCtx = filterIds
          ? `Junk: ${base.name}`
          : `Junk ${baseIdx}/${bases.length}: ${base.name}`;
        progress(junkCtx);
        const { price, trace } = await searchSellPriceEx(
          junkTabletQuery(entry.typeNamesTried[0]),
          leagueId,
          fx,
          progress,
          junkCtx,
          entry.typeNamesTried[0],
          isCancelled,
          sellCeiling,
          JUNK_LISTING_SAMPLE,
        );
        // Re-tag kind for debug clarity
        trace.kind = "sell-junk";
        comboDebug.push({
          baseId: base.id,
          baseName: base.name,
          comboKey: "__junk__",
          finalSell: price,
          search: trace,
        });
        if (price != null && isFinitePositive(price)) {
          market.junkSellByBase = market.junkSellByBase ?? {};
          market.junkSellByBase[base.id] = price;
        }
      }
    }

    let comboDone = 0;
    const comboTotal = bases.length * combosPerBase;
    for (const base of bases) {
      const highValue = getHighValueModsForBase(base.id, 60).slice(
        0,
        Math.max(combosPerBase * 3, 6),
      );
      const prefixes = highValue.filter((m) => m.isPrefix);
      const suffixes = highValue.filter((m) => !m.isPrefix);
      let comboCount = 0;
      const typeName = tradeTypeNamesForBase(base)[0];

      for (const p of prefixes) {
        for (const s of suffixes) {
          if (comboCount >= combosPerBase) break;
          if (isCancelled()) throw new Error("Market sync cancelled");
          const key = `${p.id}+${s.id}`;
          comboDone++;
          const ctx = filterIds
            ? `Combo ${comboCount + 1}/${combosPerBase}: ${base.name}`
            : `Combo ${Math.min(comboDone, comboTotal)}/${comboTotal}: ${base.name}`;
          progress(ctx);
          const { price, trace } = await searchSellPriceEx(
            comboTabletQuery(
              typeName,
              p.tradeStatId,
              s.tradeStatId,
              // Floor of the tier range — midpoint over-constrained thin books
              Math.ceil(p.minValue),
              Math.ceil(s.minValue),
            ),
            leagueId,
            fx,
            progress,
            ctx,
            typeName,
            isCancelled,
            sellCeiling,
          );
          comboDebug.push({
            baseId: base.id,
            baseName: base.name,
            comboKey: key,
            finalSell: price,
            search: trace,
          });
          if (price != null && isFinitePositive(price)) {
            market.modValueMap[key] = price;
            stats.combosPriced++;
            comboCount++;
          }
        }
        if (comboCount >= combosPerBase) break;
      }
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
  const sourceParts = [
    `r${MARKET_SYNC_REVISION}`,
    scopeLabel ? `only:${scopeLabel}` : null,
    stats.currenciesPriced ? "ninja orbs" : null,
    stats.basesPriced
      ? `${stats.basesPriced} bases(buy@${BUY_DEPTH_N},10u)`
      : null,
    stats.combosPriced ? `${stats.combosPriced} combos(sell)` : null,
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
  const status = opts?.status ?? "available";
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
          const { price, trace } = await sellOnce(ctx, junkTabletQuery(typeName));
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

        let { price, trace } = await sellOnce(
          ctx,
          surveyModQuery(typeName, item),
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
          ({ price, trace } = await sellOnce(
            `${ctx} (no-uses)`,
            surveyModQuery(typeName, item, { includeUses: false }),
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
