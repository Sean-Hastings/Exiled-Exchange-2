/**
 * Offline / in-app trade survey for calibrating tablet combo tiering.
 *
 * Breach is the reference base (dense collection). Other tablet types reuse the
 * same RareTier buckets / SIDE_SCORE ladder but map mods into S/A/B by hand
 * until their own surveys exist — expect lower precision there.
 */

import type { ModQualityTier } from "./strat-types";

export type SurveyQueryKind =
  | "anchor-dump"
  | "anchor-blank"
  | "single"
  | "pair"
  | "double"; // 2-constraint (same-side or multi-stat)

export interface SurveyModRef {
  id: string;
  tradeStatId: string;
  isPrefix: boolean;
  quality: ModQualityTier;
  valueScore: number;
  minValue: number;
  name: string;
}

export interface SurveyWorkItem {
  key: string;
  kind: SurveyQueryKind;
  label: string;
  /** Ordered trade stat filters (beyond uses-remaining). */
  stats: Array<{ id: string; min?: number; modId?: string }>;
  modIds: string[];
}

export interface SurveyObservation {
  key: string;
  kind: SurveyQueryKind;
  label: string;
  modIds: string[];
  sellEx: number | null;
  totalHits?: number;
  /** log2(sell / dump), null if missing */
  octave: number | null;
  /** nearest integer power-of-2 band */
  octaveRound: number | null;
  error?: string;
  updatedAt: number;
}

export interface TierSurveyDocument {
  revision: number;
  baseId: string;
  baseName: string;
  leagueId: string;
  startedAt: number;
  updatedAt: number;
  status: "running" | "complete" | "error" | "cancelled" | "paused";
  message?: string;
  fx: {
    exaltPerChaos: number;
    exaltPerDivine: number;
  };
  anchors: {
    dumpEx: number | null;
    blankBuyEx: number | null;
  };
  /** Planned queue (for resume). */
  queue: SurveyWorkItem[];
  /** Completed observations by key. */
  observations: Record<string, SurveyObservation>;
  /** Phase-3 follow-ups appended after singles/pairs. */
  followUpsGenerated: boolean;
  /** Pass 1 defers hard RL items; pass 2 retries them. */
  surveyPass?: 1 | 2;
  /** Keys skipped in pass 1 after rate-limit (retry in pass 2). */
  deferredKeys?: string[];
}

export interface TierSurveyAnalysis {
  baseId: string;
  dumpEx: number;
  blankBuyEx: number | null;
  nObservations: number;
  /** Mean octave by SidePattern-like label derived from mod qualities. */
  byPattern: Array<{
    pattern: string;
    n: number;
    medianOctave: number | null;
    medianSellEx: number | null;
    sells: number[];
  }>;
  /** Suggested SIDE_SCORE ordering from median octaves (Breach-calibrated). */
  suggestedSideOrder: string[];
  /** Cross synergy: pair octave − max(single octaves). */
  synergies: Array<{
    key: string;
    pairOctave: number;
    maxSingleOctave: number;
    lift: number;
    modIds: string[];
  }>;
  notes: string[];
}

export const TIER_SURVEY_REVISION = 8;
