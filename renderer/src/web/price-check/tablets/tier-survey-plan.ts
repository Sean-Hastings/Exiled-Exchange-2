import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import { modQualityTier } from "./mod-tiers";
import type {
  SurveyModRef,
  SurveyWorkItem,
  TierSurveyDocument,
} from "./tier-survey-types";
import { TIER_SURVEY_REVISION } from "./tier-survey-types";

const JUNK_PREFIX_SAMPLES = ["junk_gold_t1", "junk_xp_t1"] as const;
const JUNK_SUFFIX_SAMPLES = [
  "junk_extra_shrine_t1",
  "junk_extra_strongbox_t1",
] as const;

/** Trade API only accepts real `explicit.stat_<digits>` ids. */
export function isTradeQueryableStatId(tradeStatId: string): boolean {
  return /^explicit\.stat_\d+$/.test(tradeStatId);
}

function modRef(id: string): SurveyModRef | null {
  const m = TABLET_MOD_WEIGHTS[id];
  if (!m) return null;
  if (!isTradeQueryableStatId(m.tradeStatId)) return null;
  return {
    id,
    tradeStatId: m.tradeStatId,
    isPrefix: m.isPrefix,
    quality: modQualityTier(id),
    valueScore: m.valueScore,
    minValue: m.minValue,
    name: m.name,
  };
}

/** Breach-focused survey mod set: mechanic pool + a few junk baselines. */
export function surveyModsForBase(baseId: string): {
  prefixes: SurveyModRef[];
  suffixes: SurveyModRef[];
} {
  const base = TABLET_BASES[baseId];
  if (!base) return { prefixes: [], suffixes: [] };

  const isJunkId = (id: string) => id.startsWith("junk_");
  const mechP = base.allowedPrefixPool.filter((id) => !isJunkId(id));
  const mechS = base.allowedSuffixPool.filter((id) => !isJunkId(id));

  const prefixes = [...mechP, ...JUNK_PREFIX_SAMPLES]
    .map(modRef)
    .filter((m): m is SurveyModRef => !!m);
  const suffixes = [...mechS, ...JUNK_SUFFIX_SAMPLES]
    .map(modRef)
    .filter((m): m is SurveyModRef => !!m);

  // Dedupe by id
  const dedupe = (arr: SurveyModRef[]) => {
    const seen = new Set<string>();
    return arr.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  };
  return { prefixes: dedupe(prefixes), suffixes: dedupe(suffixes) };
}

function surveyStat(m: SurveyModRef): {
  id: string;
  min: number;
  modId: string;
} {
  // Use each mod's tier floor (same as market-sync combos). Blanket min:1
  // returned 0 hits for splinter / map qty on SC even when listings exist;
  // dump4 found splinters with minValue 10–20 on the same tradeStatId.
  const min = Number.isFinite(m.minValue) && m.minValue > 0 ? m.minValue : 1;
  return { id: m.tradeStatId, min, modId: m.id };
}

function singleItem(m: SurveyModRef): SurveyWorkItem {
  return {
    key: `single:${m.id}`,
    kind: "single",
    label: `single ${m.id} (${m.quality})`,
    stats: [surveyStat(m)],
    modIds: [m.id],
  };
}

function pairItem(p: SurveyModRef, s: SurveyModRef): SurveyWorkItem {
  return {
    key: `pair:${p.id}+${s.id}`,
    kind: "pair",
    label: `pair ${p.id}+${s.id} (${p.quality}|${s.quality})`,
    stats: [surveyStat(p), surveyStat(s)],
    modIds: [p.id, s.id],
  };
}

function doubleItem(a: SurveyModRef, b: SurveyModRef): SurveyWorkItem {
  const ids = [a.id, b.id].sort();
  return {
    key: `double:${ids[0]}+${ids[1]}`,
    kind: "double",
    label: `2-stat ${a.id}+${b.id} (${a.quality}+${b.quality}, same-side)`,
    stats: [surveyStat(a), surveyStat(b)],
    modIds: [a.id, b.id],
  };
}

/** Splinter qty/stack filters are thin + RL-heavy; survey them last. */
export function surveyItemTouchesSplinter(item: {
  modIds?: string[];
  key?: string;
}): boolean {
  if (item.modIds?.some((id) => id.includes("splinter"))) return true;
  return typeof item.key === "string" && item.key.includes("splinter");
}

function partitionSplintersLast(items: SurveyWorkItem[]): SurveyWorkItem[] {
  const early: SurveyWorkItem[] = [];
  const late: SurveyWorkItem[] = [];
  for (const item of items) {
    (surveyItemTouchesSplinter(item) ? late : early).push(item);
  }
  return [...early, ...late];
}

/**
 * Move unfinished splinter work into deferredKeys so pass 1 fills
 * everything else first; pass 2 retries deferred (non-splinter then splinter).
 */
export function deferUnfinishedSplinters(doc: TierSurveyDocument): number {
  if (!doc.deferredKeys) doc.deferredKeys = [];
  let n = 0;
  for (const item of doc.queue) {
    if (doc.observations[item.key]) continue;
    if (!surveyItemTouchesSplinter(item)) continue;
    if (doc.deferredKeys.includes(item.key)) continue;
    doc.deferredKeys.push(item.key);
    n += 1;
  }
  if (n > 0) doc.updatedAt = Date.now();
  return n;
}

/** Keep anchors first; push splinter singles/pairs/doubles to the tail. */
export function reorderSurveyQueueSplintersLast(doc: TierSurveyDocument): void {
  const anchors = doc.queue.filter(
    (q) => q.kind === "anchor-blank" || q.kind === "anchor-dump",
  );
  const rest = doc.queue.filter(
    (q) => q.kind !== "anchor-blank" && q.kind !== "anchor-dump",
  );
  doc.queue = [...anchors, ...partitionSplintersLast(rest)];
}

/**
 * Phase 1–2 queue: anchors + singles + full 1p×1s grid for survey mods.
 * Phase 3 (doubles) is appended after singles are measured — see
 * {@link appendDoubleFollowUps}.
 * Splinter-touching items are queued last (also deferred to pass 2 on run).
 */
export function buildBreachSurveyQueue(baseId = "breach_tablet"): SurveyWorkItem[] {
  const base = TABLET_BASES[baseId];
  if (!base) return [];
  const { prefixes, suffixes } = surveyModsForBase(baseId);
  const queue: SurveyWorkItem[] = [
    {
      key: "anchor:blank",
      kind: "anchor-blank",
      label: "blank buy",
      stats: [],
      modIds: [],
    },
    {
      key: "anchor:dump",
      kind: "anchor-dump",
      label: "junk/rare dump floor",
      stats: [],
      modIds: [],
    },
  ];

  const body: SurveyWorkItem[] = [];
  for (const m of [...prefixes, ...suffixes]) {
    body.push(singleItem(m));
  }
  for (const p of prefixes) {
    for (const s of suffixes) {
      body.push(pairItem(p, s));
    }
  }
  queue.push(...partitionSplintersLast(body));
  return queue;
}

/**
 * Phase 3: 2-constraint same-side queries where both singles clear a price
 * floor (default: ≥ dump × 4, or octave ≥ 2 when dump known).
 */
export function appendDoubleFollowUps(
  doc: TierSurveyDocument,
  opts?: { minSellEx?: number; minOctave?: number },
): SurveyWorkItem[] {
  const { prefixes, suffixes } = surveyModsForBase(doc.baseId);
  const dump = doc.anchors.dumpEx;
  const minSell =
    opts?.minSellEx ??
    (dump != null && dump > 0 ? dump * 4 : 100);
  const minOct = opts?.minOctave ?? 2;

  const hot = (id: string): boolean => {
    const obs = doc.observations[`single:${id}`];
    if (!obs || obs.sellEx == null) return false;
    if (obs.octave != null && obs.octave >= minOct) return true;
    return obs.sellEx >= minSell;
  };

  const added: SurveyWorkItem[] = [];
  const seen = new Set(Object.keys(doc.observations));
  for (const q of doc.queue) seen.add(q.key);

  const considerPairs = (side: SurveyModRef[]) => {
    for (let i = 0; i < side.length; i++) {
      for (let j = i + 1; j < side.length; j++) {
        const a = side[i];
        const b = side[j];
        if (!hot(a.id) || !hot(b.id)) continue;
        // Skip junk|junk doubles — low info
        if (a.quality === "Junk" && b.quality === "Junk") continue;
        const item = doubleItem(a, b);
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        added.push(item);
      }
    }
  };

  considerPairs(prefixes);
  considerPairs(suffixes);

  // Also: if a pair sells much hotter than max(single), re-query is already
  // the pair itself — add same-side double when both mods of a hot pair are
  // prefixes or both suffixes (rare for 1p1s keys). Handled above.

  return added;
}

export function createSurveyDocument(opts: {
  baseId: string;
  leagueId: string;
  fx: { exaltPerChaos: number; exaltPerDivine: number };
}): TierSurveyDocument {
  const base = TABLET_BASES[opts.baseId];
  const now = Date.now();
  return {
    revision: TIER_SURVEY_REVISION,
    baseId: opts.baseId,
    baseName: base?.name ?? opts.baseId,
    leagueId: opts.leagueId,
    startedAt: now,
    updatedAt: now,
    status: "running",
    fx: opts.fx,
    anchors: { dumpEx: null, blankBuyEx: null },
    queue: buildBreachSurveyQueue(opts.baseId),
    observations: {},
    followUpsGenerated: false,
    surveyPass: 1,
    deferredKeys: [],
  };
}

export function surveyProgress(doc: TierSurveyDocument): {
  done: number;
  total: number;
  pending: SurveyWorkItem[];
} {
  const deferred = new Set(doc.deferredKeys ?? []);
  const pass = doc.surveyPass ?? 1;
  const pendingAll = doc.queue.filter((q) => {
    if (doc.observations[q.key]) return false;
    if (pass === 1) return !deferred.has(q.key);
    return deferred.has(q.key);
  });
  // Prefer non-splinter within the active pass so RL-heavy splinter
  // work never blocks the rest of the queue.
  const early = pendingAll.filter((q) => !surveyItemTouchesSplinter(q));
  const late = pendingAll.filter((q) => surveyItemTouchesSplinter(q));
  const pending = early.length ? early : late;
  return {
    done: doc.queue.length - doc.queue.filter((q) => !doc.observations[q.key]).length,
    total: doc.queue.length,
    pending,
  };
}
