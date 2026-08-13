import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import { modQualityTier } from "./mod-tiers";
import { surveyModsForBase } from "./tier-survey-plan";
import type {
  SurveyObservation,
  SurveyWorkItem,
  TierSurveyDocument,
} from "./tier-survey-types";
import { TIER_SURVEY_REVISION } from "./tier-survey-types";

/**
 * Default calibration base for the hand-entry survey (market-dense).
 *
 * Soft-deprecated as the primary price-entry UX — prefer TierUncertaintyPanel
 * for “which mods are we least sure how to tier?”. Automated Breach /
 * tier-survey-* paths are unchanged. Anchors (blank/dump) remain available
 * here as a secondary path.
 */
export const MANUAL_SURVEY_BASE_ID = "temple_tablet";

const STORAGE_KEY = "ee2-manual-temple-tier-survey-v1";

/** One step in the trade-site manual pricing pass (filters + your sell price). */
export interface ManualSurveyStep {
  key: string;
  kind: SurveyWorkItem["kind"];
  label: string;
  /** Short cue for browsing listings */
  lookFor: string;
  /** Trade Type filter (e.g. "Temple Tablet") */
  typeName: string;
  /** Trade explicit filter label to search/add; null for anchors */
  filterName: string | null;
  /** Min value to set on the trade filter (tier floor) */
  filterMin: number | null;
  /** Max roll for this mod tier (display only) */
  filterMax: number | null;
  /** Human range cue, e.g. "min 10 (rolls 10–30)" */
  filterRangeLabel: string | null;
  modIds: string[];
  quality?: string;
}

export interface ManualSurveyAnswer {
  key: string;
  /** Your personal sell price in exalted; null when noResults */
  sellEx: number | null;
  noResults: boolean;
  updatedAt: number;
}

export interface ManualSurveySession {
  revision: number;
  baseId: string;
  startedAt: number;
  updatedAt: number;
  /** Dump floor you entered (ex); used for octave math */
  dumpEx: number | null;
  blankBuyEx: number | null;
  answers: Record<string, ManualSurveyAnswer>;
  /** Index into steps() — last focused card */
  cursor: number;
}

function tradeTypeName(baseId: string): string {
  return TABLET_BASES[baseId]?.name ?? baseId;
}

function filterNameForMod(modId: string): string {
  const m = TABLET_MOD_WEIGHTS[modId];
  if (!m) return modId;
  return (m.statRef ?? m.name).trim();
}

function filterRangeLabel(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `min ${min} (rolls ${min}–${max})`;
  if (min != null) return `min ${min}`;
  return `max ${max}`;
}

/** Clipboard text for the active trade filter (name, or type for anchors). */
export function filterCopyText(step: ManualSurveyStep): string {
  if (step.filterName) return step.filterName;
  return step.typeName;
}

/**
 * Fast manual queue: anchors + singles only (~17).
 * Full pair grid is too slow for hand entry — calibrate tiers from singles.
 */
export function buildManualSurveySteps(
  baseId = MANUAL_SURVEY_BASE_ID,
): ManualSurveyStep[] {
  const base = TABLET_BASES[baseId];
  const label = base?.name ?? baseId;
  const typeName = tradeTypeName(baseId);
  const { prefixes, suffixes } = surveyModsForBase(baseId);
  const steps: ManualSurveyStep[] = [
    {
      key: "anchor:blank",
      kind: "anchor-blank",
      label: "Blank buy",
      lookFor: `Near-blank rare ${label} — price you'd buy at (ex)`,
      typeName,
      filterName: null,
      filterMin: null,
      filterMax: null,
      filterRangeLabel: null,
      modIds: [],
    },
    {
      key: "anchor:dump",
      kind: "anchor-dump",
      label: "Dump floor",
      lookFor: `Junk rare ${label} — price you'd dump/sell at (ex)`,
      typeName,
      filterName: null,
      filterMin: null,
      filterMax: null,
      filterRangeLabel: null,
      modIds: [],
    },
  ];

  for (const m of [...prefixes, ...suffixes]) {
    const def = TABLET_MOD_WEIGHTS[m.id];
    const min =
      def && Number.isFinite(def.minValue) && def.minValue > 0
        ? def.minValue
        : m.minValue > 0
          ? m.minValue
          : null;
    const max =
      def && Number.isFinite(def.maxValue) && def.maxValue > 0
        ? def.maxValue
        : null;
    steps.push({
      key: `single:${m.id}`,
      kind: "single",
      label: `single ${m.id}`,
      lookFor: `${modQualityTier(m.id)} · ${filterNameForMod(m.id)}`,
      typeName,
      filterName: filterNameForMod(m.id),
      filterMin: min,
      filterMax: max,
      filterRangeLabel: filterRangeLabel(min, max),
      modIds: [m.id],
      quality: m.quality,
    });
  }
  return steps;
}

/** @deprecated Prefer buildManualSurveySteps */
export const buildManualBreachSteps = buildManualSurveySteps;

export function emptyManualSession(
  baseId = MANUAL_SURVEY_BASE_ID,
): ManualSurveySession {
  const now = Date.now();
  return {
    revision: TIER_SURVEY_REVISION,
    baseId,
    startedAt: now,
    updatedAt: now,
    dumpEx: null,
    blankBuyEx: null,
    answers: {},
    cursor: 0,
  };
}

export function loadManualSession(): ManualSurveySession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ManualSurveySession;
    if (parsed.baseId !== MANUAL_SURVEY_BASE_ID) return null;
    if (parsed.revision !== TIER_SURVEY_REVISION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveManualSession(session: ManualSurveySession): void {
  session.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* ignore quota */
  }
}

export function clearManualSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function recordManualAnswer(
  session: ManualSurveySession,
  step: ManualSurveyStep,
  opts: { sellEx?: number | null; noResults?: boolean },
): ManualSurveySession {
  const noResults = !!opts.noResults;
  const sellEx = noResults
    ? null
    : opts.sellEx != null && Number.isFinite(opts.sellEx) && opts.sellEx >= 0
      ? opts.sellEx
      : null;

  if (!noResults && sellEx == null) return session;

  const next: ManualSurveySession = {
    ...session,
    answers: { ...session.answers },
  };

  next.answers[step.key] = {
    key: step.key,
    sellEx,
    noResults,
    updatedAt: Date.now(),
  };

  if (step.kind === "anchor-blank" && sellEx != null) {
    next.blankBuyEx = sellEx;
  }
  if (step.kind === "anchor-dump" && sellEx != null) {
    next.dumpEx = sellEx;
  }
  if (
    step.kind === "anchor-blank" &&
    sellEx != null &&
    (next.dumpEx == null || !(next.dumpEx > 0))
  ) {
    next.dumpEx = sellEx * 0.2;
  }

  next.updatedAt = Date.now();
  saveManualSession(next);
  return next;
}

function computeOctave(
  sellEx: number | null,
  dumpEx: number | null,
): { octave: number | null; octaveRound: number | null } {
  if (sellEx == null || !(sellEx > 0) || dumpEx == null || !(dumpEx > 0)) {
    return { octave: null, octaveRound: null };
  }
  const octave = Math.log2(sellEx / dumpEx);
  return { octave, octaveRound: Math.round(octave) };
}

/** Convert manual answers into a TierSurveyDocument for analyzeTierSurvey. */
export function manualSessionToSurveyDoc(
  session: ManualSurveySession,
  steps: ManualSurveyStep[],
  fx?: { exaltPerChaos: number; exaltPerDivine: number },
): TierSurveyDocument {
  const dump = session.dumpEx;
  const observations: Record<string, SurveyObservation> = {};

  for (const step of steps) {
    const a = session.answers[step.key];
    if (!a) continue;
    const { octave, octaveRound } = computeOctave(a.sellEx, dump);
    observations[step.key] = {
      key: step.key,
      kind: step.kind,
      label: step.label,
      modIds: step.modIds,
      sellEx: a.noResults ? null : a.sellEx,
      totalHits: a.noResults ? 0 : undefined,
      octave,
      octaveRound,
      error: a.noResults ? "no results (manual)" : undefined,
      updatedAt: a.updatedAt,
    };
  }

  const answered = Object.keys(session.answers).length;
  const complete = answered >= steps.length;
  const baseName = TABLET_BASES[session.baseId]?.name ?? session.baseId;

  return {
    revision: TIER_SURVEY_REVISION,
    baseId: session.baseId,
    baseName,
    leagueId: "manual",
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    status: complete ? "complete" : "running",
    message: complete
      ? `Manual complete: ${answered}/${steps.length}`
      : `Manual in progress: ${answered}/${steps.length}`,
    fx: fx ?? { exaltPerChaos: 1, exaltPerDivine: 1 },
    anchors: {
      dumpEx: session.dumpEx,
      blankBuyEx: session.blankBuyEx,
    },
    queue: steps.map((s) => ({
      key: s.key,
      kind: s.kind,
      label: s.label,
      stats: [],
      modIds: s.modIds,
    })),
    observations,
    followUpsGenerated: true,
    surveyPass: 1,
    deferredKeys: [],
  };
}

export function manualProgress(
  session: ManualSurveySession,
  steps: ManualSurveyStep[],
): { done: number; total: number; nextIndex: number } {
  let done = 0;
  let nextIndex = steps.length;
  for (let i = 0; i < steps.length; i++) {
    if (session.answers[steps[i].key]) done += 1;
    else if (nextIndex === steps.length) nextIndex = i;
  }
  return { done, total: steps.length, nextIndex };
}
