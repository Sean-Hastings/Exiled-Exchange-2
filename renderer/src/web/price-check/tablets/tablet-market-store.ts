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
import type { TierSurveyDocument } from "./tier-survey-types";
import { TIER_SURVEY_REVISION } from "./tier-survey-types";

const STORAGE_KEY = "ee2-tablet-market-cache";

interface PersistedMarket {
  revision: number;
  updatedAt: number;
  market: MarketPriceCache;
  source: string;
}

export interface TabletMarketSyncOpts {
  /** When set, only re-price these bases and merge into the existing cache. */
  baseIds?: string[];
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

function hydrateFromStorage(): {
  market: MarketPriceCache;
  status: MarketSyncStatus;
} {
  const hit = loadPersisted();
  if (!hit) {
    return {
      market: createEmptyMarketCache(),
      status: { state: "idle" },
    };
  }
  return {
    market: hit.market,
    status: {
      state: "ready",
      updatedAt: hit.updatedAt,
      source: `${hit.source} (cached)`,
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
      ? `Syncing ${baseIds!.length} tablet type(s) (r${MARKET_SYNC_REVISION})…`
      : `Syncing trade prices (r${MARKET_SYNC_REVISION})…`;
    tabletMarketStatus.value = {
      state: "loading",
      detail: label,
    };
    try {
      const result = await syncTabletMarketFromTrade({
        combosPerBase: 8,
        baseIds,
        seedMarket: partial ? tabletMarketCache.value : undefined,
        isCancelled: () => gen !== syncGeneration,
        onProgress: (detail) => {
          if (gen !== syncGeneration) return;
          tabletMarketStatus.value = {
            state: "loading",
            detail: `r${MARKET_SYNC_REVISION}: ${detail}`,
          };
        },
      });
      if (gen !== syncGeneration) return;
      if (
        result.status.state === "error" &&
        result.status.message === "Market sync cancelled"
      ) {
        return;
      }
      tabletMarketCache.value = result.market;
      tabletMarketStatus.value = result.status;
      if (result.debug) {
        tabletMarketDebug.value = partial
          ? mergeMarketSyncDebug(tabletMarketDebug.value, result.debug, baseIds!)
          : result.debug;
      }
      if (result.status.state === "ready") {
        savePersisted(
          result.market,
          result.status.updatedAt,
          result.status.source,
        );
      } else if (
        result.status.state === "error" &&
        result.status.partial &&
        result.stats.basesPriced > 0
      ) {
        savePersisted(result.market, Date.now(), result.status.message);
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
