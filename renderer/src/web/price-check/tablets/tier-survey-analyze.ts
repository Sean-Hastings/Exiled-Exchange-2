import { modQualityTier, type SidePattern } from "./mod-tiers";
import type {
  SurveyObservation,
  TierSurveyAnalysis,
  TierSurveyDocument,
} from "./tier-survey-types";

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computeOctave(
  sellEx: number | null | undefined,
  dumpEx: number | null | undefined,
): { octave: number | null; octaveRound: number | null } {
  if (
    sellEx == null ||
    dumpEx == null ||
    !(sellEx > 0) ||
    !(dumpEx > 0)
  ) {
    return { octave: null, octaveRound: null };
  }
  const octave = Math.log2(sellEx / dumpEx);
  return { octave, octaveRound: Math.round(octave) };
}

export function coarsePattern(modIds: string[]): string {
  if (!modIds.length) return "anchor";
  if (modIds.length === 1) return `solo_${modQualityTier(modIds[0])}`;

  const nS = modIds.filter((id) => modQualityTier(id) === "S").length;
  const nA = modIds.filter((id) => modQualityTier(id) === "A").length;
  const nB = modIds.filter((id) => modQualityTier(id) === "B").length;
  if (nS >= 2) return "SS";
  if (nS >= 1 && nA >= 1) return "SA";
  if (nS >= 1) return "S";
  if (nA >= 2) return "AA";
  if (nA >= 1 && nB >= 1) return "AB";
  if (nA >= 1) return "A";
  if (nB >= 1) return "B";
  return "Junk";
}

const LADDER: SidePattern[] = ["SS", "SA", "S", "AA", "A", "B", "Empty"];

export function analyzeTierSurvey(doc: TierSurveyDocument): TierSurveyAnalysis {
  const dump = doc.anchors.dumpEx ?? 0;
  const notes: string[] = [];
  if (!(dump > 0)) {
    notes.push("No dump anchor — octaves unavailable; use raw sells only.");
  }
  notes.push(
    "Breach is the calibration base. Other tablet types inherit this ladder with lower precision until surveyed.",
  );

  const priced = Object.values(doc.observations).filter(
    (o): o is SurveyObservation & { sellEx: number } =>
      o.sellEx != null && o.sellEx > 0 && o.kind !== "anchor-blank",
  );

  const byPatternMap = new Map<string, number[]>();
  for (const o of priced) {
    if (o.kind === "anchor-dump") continue;
    const pat = coarsePattern(o.modIds);
    const arr = byPatternMap.get(pat) ?? [];
    if (o.octave != null) arr.push(o.octave);
    else if (dump > 0) {
      const { octave } = computeOctave(o.sellEx, dump);
      if (octave != null) arr.push(octave);
    }
    byPatternMap.set(pat, arr);
  }

  // Also keep sell medians
  const sellByPat = new Map<string, number[]>();
  for (const o of priced) {
    if (o.kind === "anchor-dump") continue;
    const pat = coarsePattern(o.modIds);
    const arr = sellByPat.get(pat) ?? [];
    arr.push(o.sellEx);
    sellByPat.set(pat, arr);
  }

  const byPattern = [...byPatternMap.entries()]
    .map(([pattern, octs]) => {
      const sells = sellByPat.get(pattern) ?? [];
      return {
        pattern,
        n: Math.max(octs.length, sells.length),
        medianOctave: median(octs),
        medianSellEx: median(sells),
        sells,
      };
    })
    .sort(
      (a, b) =>
        (b.medianOctave ?? -99) - (a.medianOctave ?? -99),
    );

  const suggestedSideOrder = LADDER.filter((p) => p !== "Empty").slice().sort(
    (a, b) => {
      const ma =
        byPattern.find((x) => x.pattern === a)?.medianOctave ??
        ({
          SS: 6,
          SA: 5,
          S: 4,
          AA: 3,
          A: 2,
          B: 1,
        }[a] ?? 0);
      const mb =
        byPattern.find((x) => x.pattern === b)?.medianOctave ??
        ({
          SS: 6,
          SA: 5,
          S: 4,
          AA: 3,
          A: 2,
          B: 1,
        }[b] ?? 0);
      return mb - ma;
    },
  );

  // Synergy: pair vs max single
  const synergies: TierSurveyAnalysis["synergies"] = [];
  for (const o of priced) {
    if (o.kind !== "pair" && o.kind !== "double") continue;
    if (o.octave == null || o.modIds.length < 2) continue;
    const singles = o.modIds.map((id) => {
      const s = doc.observations[`single:${id}`];
      return s?.octave ?? null;
    });
    if (singles.some((x) => x == null)) continue;
    const maxSingle = Math.max(...(singles as number[]));
    const lift = o.octave - maxSingle;
    if (lift >= 0.5) {
      synergies.push({
        key: o.key,
        pairOctave: o.octave,
        maxSingleOctave: maxSingle,
        lift,
        modIds: o.modIds,
      });
    }
  }
  synergies.sort((a, b) => b.lift - a.lift);

  if (!synergies.length) {
    notes.push("No strong cross/same-side synergy lifts (≥0.5 octave) measured yet.");
  }

  return {
    baseId: doc.baseId,
    dumpEx: dump,
    blankBuyEx: doc.anchors.blankBuyEx,
    nObservations: priced.length,
    byPattern,
    suggestedSideOrder,
    synergies: synergies.slice(0, 25),
    notes,
  };
}

/** Human-readable markdown report. */
export function formatSurveyAnalysisMarkdown(
  analysis: TierSurveyAnalysis,
): string {
  const lines: string[] = [
    `# Tier survey analysis — ${analysis.baseId}`,
    "",
    `Dump ${analysis.dumpEx.toFixed(1)}ex · blank ${
      analysis.blankBuyEx != null
        ? analysis.blankBuyEx.toFixed(1) + "ex"
        : "n/a"
    } · n=${analysis.nObservations}`,
    "",
    "## Notes",
    ...analysis.notes.map((n) => `- ${n}`),
    "",
    "## Pattern clusters (by median log2(sell/dump))",
    "",
    "| Pattern | n | median octave | median sell |",
    "|---------|---|---------------|-------------|",
  ];
  for (const row of analysis.byPattern) {
    lines.push(
      `| ${row.pattern} | ${row.n} | ${
        row.medianOctave != null ? row.medianOctave.toFixed(2) : "—"
      } | ${
        row.medianSellEx != null ? row.medianSellEx.toFixed(0) + "ex" : "—"
      } |`,
    );
  }
  lines.push(
    "",
    `## Suggested side order (data-informed): ${analysis.suggestedSideOrder.join(
      " > ",
    )}`,
    "",
    "## Synergy lifts (pair octave − max single)",
    "",
  );
  if (!analysis.synergies.length) {
    lines.push("_none_");
  } else {
    lines.push("| Combo | lift | pair oct | max single |");
    lines.push("|-------|------|----------|------------|");
    for (const s of analysis.synergies) {
      lines.push(
        `| ${s.modIds.join("+")} | +${s.lift.toFixed(2)} | ${s.pairOctave.toFixed(
          2,
        )} | ${s.maxSingleOctave.toFixed(2)} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
