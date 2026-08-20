import { shallowRef } from "vue";
import { createEmptyMarketCache } from "./default-market";
import type { MarketPriceCache } from "./tablet-ev-calculator";
import type { MarketSyncDebug } from "./market-sync-debug";
import {
  MARKET_SYNC_REVISION,
  mergeMarketSyncDebug,
  runTabletTierSurvey,
  type MarketSyncStatus,
  syncTabletMarketFromTrade,
} from "./tablet-market-sync";
import { BUY_DEPTH_COLD_DEFAULT } from "./trade-price-estimators";
import type { TierSurveyDocument } from "./tier-survey-types";
import { TIER_SURVEY_REVISION } from "./tier-survey-types";
import { applyTempleManualSurveyMarket } from "./temple-manual-market";

const STORAGE_KEY = "ee2-tablet-market-cache";
/** Normative buy-count B key (mean of cheapest B). */
const BUY_COUNT_B_KEY = "ee2-tablet-buy-count-b";
/** Legacy patience key — read-only migration fallback; never write. */
const BUY_PATIENCE_KEY = "ee2-tablet-buy-patience-depth";
const CRAFT_COUNT_C_KEY = "ee2-tablet-craft-count-c";
/** Include in-person / trade-site (`available`) listings. Default off. */
const INCLUDE_WHISPER_KEY = "ee2-tablet-include-whisper";

const CRAFT_COUNT_C_DEFAULT = 20;

interface PersistedMarket {
  revision: number;
  updatedAt: number;
  market: MarketPriceCache;
  source: string;
}

export interface TabletMarketSyncOpts {
  /** When set, only re-price these bases and merge into the existing cache. */
  baseIds?: string[];
  /** Buy count B — mean of cheapest B asks for EV blank cost. */
  buyCountB?: number;
  /**
   * @deprecated Use buyCountB. Kept as a read alias for one revision.
   */
  coldBuyDepth?: number;
  /** Re-query delay for hot/cold detection (ms). */
  flowProbeMs?: number;
  /** Set false to skip the second buy snapshot. */
  flowProbe?: boolean;
  /** Include in-person / trade-site listings (`available` fallback). */
  includeAvailable?: boolean;
  /** Standard capped worklist vs deep uncapped + solo-S roll prongs. */
  syncMode?: "standard" | "deep";
}

function clampBuyB(n: number): number {
  return Math.max(5, Math.min(50, Math.round(n)));
}

function clampCraftC(n: number): number {
  return Math.max(1, Math.min(500, Math.round(n)));
}

function loadBuyCountB(): number {
  try {
    const raw = localStorage.getItem(BUY_COUNT_B_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return clampBuyB(n);
    }
    // Migrate once from legacy patience key (read-only thereafter)
    const legacy = localStorage.getItem(BUY_PATIENCE_KEY);
    if (legacy) {
      const n = Number(legacy);
      if (Number.isFinite(n)) {
        const migrated = clampBuyB(n);
        try {
          localStorage.setItem(BUY_COUNT_B_KEY, String(migrated));
        } catch {
          /* ignore */
        }
        return migrated;
      }
    }
    return BUY_DEPTH_COLD_DEFAULT;
  } catch {
    return BUY_DEPTH_COLD_DEFAULT;
  }
}

function loadCraftCountC(): number {
  try {
    const raw = localStorage.getItem(CRAFT_COUNT_C_KEY);
    if (!raw) return CRAFT_COUNT_C_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return CRAFT_COUNT_C_DEFAULT;
    return clampCraftC(n);
  } catch {
    return CRAFT_COUNT_C_DEFAULT;
  }
}

function loadIncludeWhisper(): boolean {
  try {
    return localStorage.getItem(INCLUDE_WHISPER_KEY) === "true";
  } catch {
    return false;
  }
}

/** Buy count B — mean of cheapest B; persisted under ee2-tablet-buy-count-b. */
export const tabletBuyCountB = shallowRef(loadBuyCountB());

/** Craft count C — batch risk size only; does not enter buy price. */
export const tabletCraftCountC = shallowRef(loadCraftCountC());

/** Include in-person / trade-site listings. Default off (Instant Buyout only). */
export const tabletIncludeWhisper = shallowRef(loadIncludeWhisper());

/**
 * @deprecated Alias of tabletBuyCountB for one revision.
 */
export const tabletColdBuyDepth = tabletBuyCountB;

export function setTabletBuyCountB(depth: number) {
  const next = clampBuyB(depth);
  tabletBuyCountB.value = next;
  try {
    localStorage.setItem(BUY_COUNT_B_KEY, String(next));
    // Do not write the legacy patience key (§2.5).
  } catch {
    /* ignore */
  }
}

/** @deprecated Use setTabletBuyCountB */
export function setTabletColdBuyDepth(depth: number) {
  setTabletBuyCountB(depth);
}

export function setTabletCraftCountC(count: number) {
  const next = clampCraftC(count);
  tabletCraftCountC.value = next;
  try {
    localStorage.setItem(CRAFT_COUNT_C_KEY, String(next));
  } catch {
    /* ignore */
  }
}

export function setTabletIncludeWhisper(on: boolean) {
  tabletIncludeWhisper.value = !!on;
  try {
    localStorage.setItem(INCLUDE_WHISPER_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
}

function loadPersisted(): PersistedMarket | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedMarket;
    if (parsed.revision !== MARKET_SYNC_REVISION) return null;
    if (!parsed.market?.basePrices || !parsed.market?.currencyCosts) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(
  market: MarketPriceCache,
  updatedAt: number,
  source: string,
) {
  try {
    const payload: PersistedMarket = {
      revision: MARKET_SYNC_REVISION,
      updatedAt,
      market,
      source,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota / private mode
  }
}

/** Persist; Temple survey seeds NaN/missing sales only (never clobbers live). */
function commitMarket(
  market: MarketPriceCache,
  updatedAt: number,
  source: string,
): MarketPriceCache {
  const next = applyTempleManualSurveyMarket(market);
  savePersisted(next, updatedAt, source);
  return next;
}

function hydrateFromStorage(): {
  market: MarketPriceCache;
  status: MarketSyncStatus;
} {
  const hit = loadPersisted();
  if (!hit) {
    const market = applyTempleManualSurveyMarket(createEmptyMarketCache());
    return {
      market,
      status: {
        state: "ready",
        updatedAt: Date.now(),
        source: "temple survey gaps (no trade cache yet)",
      },
    };
  }
  return {
    // Fill-only: live finite Temple sells from cache are preserved
    market: applyTempleManualSurveyMarket(hit.market),
    status: {
      state: "ready",
      updatedAt: hit.updatedAt,
      source: `${hit.source} + temple survey(gaps)`,
    },
  };
}

const hydrated = hydrateFromStorage();

/** Shared live market snapshot for dashboard + price-check banner */
export const tabletMarketCache = shallowRef<MarketPriceCache>(hydrated.market);

export const tabletMarketStatus = shallowRef<MarketSyncStatus>(hydrated.status);

/** Last sync's listing-level debug trace (not persisted). */
export const tabletMarketDebug = shallowRef<MarketSyncDebug | null>(null);

let inflight: Promise<void> | null = null;
let syncGeneration = 0;

export async function ensureTabletMarketSynced(
  force = false,
  opts?: TabletMarketSyncOpts,
): Promise<void> {
  const baseIds = opts?.baseIds?.length ? [...opts.baseIds] : undefined;
  const partial = !!baseIds?.length;

  // Partial refresh always runs; full sync can skip when already ready
  if (inflight && !force && !partial) return inflight;
  if (!force && !partial && tabletMarketStatus.value.state === "ready") return;

  const gen = ++syncGeneration;
  const previous = inflight;

  inflight = (async () => {
    if (previous) {
      tabletMarketStatus.value = {
        state: "loading",
        detail: `r${MARKET_SYNC_REVISION}: cancelling previous sync…`,
      };
      try {
        await previous;
      } catch {
        /* ignore */
      }
      if (gen !== syncGeneration) return;
    }

    const label = partial
      ? opts?.syncMode === "deep"
        ? `Deep refresh ${baseIds!.length} tablet type(s) (r${MARKET_SYNC_REVISION})…`
        : `Syncing ${baseIds!.length} tablet type(s) (r${MARKET_SYNC_REVISION})…`
      : `Syncing trade prices (r${MARKET_SYNC_REVISION})…`;
    tabletMarketStatus.value = {
      state: "loading",
      detail: label,
    };
    try {
      const buyCountB =
        opts?.buyCountB ?? opts?.coldBuyDepth ?? tabletBuyCountB.value;
      const result = await syncTabletMarketFromTrade({
        // SAB closed worklist safety max (was success-cap 8/16 under junk×premium)
        combosPerBase: 40,
        baseIds,
        seedMarket: tabletMarketCache.value,
        buyCountB,
        coldBuyDepth: buyCountB,
        flowProbeMs: opts?.flowProbeMs,
        flowProbe: opts?.flowProbe,
        includeAvailable:
          opts?.includeAvailable ?? tabletIncludeWhisper.value,
        syncMode: opts?.syncMode,
        isCancelled: () => gen !== syncGeneration,
        onProgress: (detail) => {
          if (gen !== syncGeneration) return;
          tabletMarketStatus.value = {
            state: "loading",
            detail: `r${MARKET_SYNC_REVISION}: ${detail}`,
          };
        },
        onPartialMarket: (cloned, debug) => {
          if (gen !== syncGeneration) return;
          tabletMarketCache.value = commitMarket(
            cloned,
            Date.now(),
            `r${MARKET_SYNC_REVISION} live (refreshing)`,
          );
          if (debug) {
            const touched = [
              ...new Set([
                ...debug.bases.map((b) => b.baseId),
                ...debug.combos.map((c) => c.baseId),
              ]),
            ];
            tabletMarketDebug.value = mergeMarketSyncDebug(
              tabletMarketDebug.value,
              debug,
              touched,
            );
          }
        },
      });
      if (gen !== syncGeneration) return;
      if (
        result.status.state === "error" &&
        result.status.message === "Market sync cancelled"
      ) {
        return;
      }
      const stamped =
        result.status.state === "ready"
          ? commitMarket(
              result.market,
              result.status.updatedAt,
              `${result.status.source} + temple survey(gaps)`,
            )
          : applyTempleManualSurveyMarket(result.market);
      tabletMarketCache.value = stamped;
      tabletMarketStatus.value =
        result.status.state === "ready"
          ? {
              ...result.status,
              source: `${result.status.source} + temple survey(gaps)`,
            }
          : result.status;
      if (result.debug) {
        tabletMarketDebug.value = partial
          ? mergeMarketSyncDebug(tabletMarketDebug.value, result.debug, baseIds!)
          : result.debug;
      }
      if (
        result.status.state === "error" &&
        result.status.partial &&
        result.stats.basesPriced > 0
      ) {
        tabletMarketCache.value = commitMarket(
          result.market,
          Date.now(),
          `${result.status.message} + temple survey(gaps)`,
        );
      }
    } catch (e) {
      if (gen !== syncGeneration) return;
      tabletMarketStatus.value = {
        state: "error",
        message: e instanceof Error ? e.message : String(e),
        partial: false,
      };
    } finally {
      if (gen === syncGeneration) inflight = null;
    }
  })();

  return inflight;
}

/** Deep roll-curve refresh for one tablet base (uncapped SAB + solo-S prongs). */
export async function ensureTabletMarketDeepRefresh(
  baseId: string,
): Promise<void> {
  return ensureTabletMarketSynced(true, { baseIds: [baseId], syncMode: "deep" });
}

const SURVEY_STORAGE_KEY = "ee2-tablet-tier-survey-breach";

export const tabletTierSurvey = shallowRef<TierSurveyDocument | null>(null);
export const tabletTierSurveyDetail = shallowRef<string>("");

let surveyGeneration = 0;
let surveyInflight: Promise<TierSurveyDocument> | null = null;

function loadSurvey(): TierSurveyDocument | null {
  try {
    const raw = localStorage.getItem(SURVEY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TierSurveyDocument;
    if (parsed.revision !== TIER_SURVEY_REVISION) return null;
    if (parsed.baseId !== "breach_tablet") return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSurvey(doc: TierSurveyDocument) {
  try {
    localStorage.setItem(SURVEY_STORAGE_KEY, JSON.stringify(doc));
  } catch {
    /* ignore */
  }
  tabletTierSurvey.value = doc;
}

/** Resume or start Breach tier trade survey (Electron session cookies). */
export async function ensureBreachTierSurvey(
  forceNew = false,
  externalSeed: TierSurveyDocument | null = null,
): Promise<TierSurveyDocument> {
  if (surveyInflight && !forceNew) return surveyInflight;
  const gen = ++surveyGeneration;

  let seed: TierSurveyDocument | null = null;
  if (!forceNew) {
    if (externalSeed && externalSeed.revision === TIER_SURVEY_REVISION) {
      seed = externalSeed;
    } else {
      seed = loadSurvey();
    }
    if (seed?.status === "complete") seed = null;
  }

  if (seed) tabletTierSurvey.value = seed;

  surveyInflight = (async () => {
    const doc = await runTabletTierSurvey({
      baseId: "breach_tablet",
      seed,
      isCancelled: () => gen !== surveyGeneration,
      onProgress: (detail, d) => {
        if (gen !== surveyGeneration) return;
        tabletTierSurveyDetail.value = detail;
        saveSurvey(d);
      },
    });
    if (gen === surveyGeneration) {
      saveSurvey(doc);
      tabletTierSurveyDetail.value = doc.message ?? doc.status;
      surveyInflight = null;
    }
    return doc;
  })();

  return surveyInflight;
}

export function cancelBreachTierSurvey() {
  surveyGeneration++;
  surveyInflight = null;
  tabletTierSurveyDetail.value = "Cancel requested…";
}

// hydrate
{
  const hit = loadSurvey();
  if (hit) tabletTierSurvey.value = hit;
}
