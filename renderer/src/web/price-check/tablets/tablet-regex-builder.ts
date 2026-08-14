import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import { modQualityTierForBase } from "./mod-tiers";

export interface RegexTargetMod {
  id: string;
  name: string;
  minDesiredValue?: number;
  regexHint?: string;
  highlightCategory: "high_value" | "reroll" | "brick";
  /** Higher = kept longer when trimming to 50 chars */
  priority?: number;
}

export interface TierJudgementRegex {
  /** Stash triage label (S / A / B); unmatched → Trash */
  tier: "S" | "A" | "B";
  regex: string;
  modIds: string[];
  note: string;
}

const STASH_LIMIT = 50;

function numberRangePattern(min: number, max = 99): string {
  if (min <= 0) return "\\d+";
  if (min >= 10 && min <= 99) {
    const tens = Math.floor(min / 10);
    const ones = min % 10;
    if (min === max) return String(min);
    if (ones === 0) {
      return `${tens}\\d|[${tens + 1}-9]\\d`;
    }
    if (tens === Math.floor(max / 10) || max >= 99) {
      return `${tens}[${ones}-9]|[${tens + 1}-9]\\d`;
    }
  }
  if (min >= 1 && min <= 9) {
    return `[${min}-9]|\\d\\d`;
  }
  return `${min}`;
}

/**
 * Compress high-value tablet mod targets into a stash-tab regex
 * that respects PoE2's 50-character search limit.
 */
export class TabletRegexBuilder {
  public static buildOptimizedRegex(targets: RegexTargetMod[]): string {
    const sorted = [...targets].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );

    const patterns: string[] = [];
    for (const target of sorted) {
      patterns.push(this.patternFor(target));
    }

    const unique = [...new Set(patterns.filter(Boolean))];
    return this.fitToLimit(unique);
  }

  public static buildForModIds(
    modIds: string[],
    hints: Record<string, { hint: string; min?: number; priority?: number }>,
  ): string {
    return this.buildOptimizedRegex(
      modIds.map((id) => ({
        id,
        name: id,
        regexHint: hints[id]?.hint,
        minDesiredValue: hints[id]?.min,
        priority: hints[id]?.priority ?? 0,
        highlightCategory: "high_value",
      })),
    );
  }

  private static patternFor(target: RegexTargetMod): string {
    if (target.regexHint) {
      if (target.minDesiredValue != null) {
        const range = numberRangePattern(target.minDesiredValue);
        if (!target.regexHint.includes("|") && target.regexHint.length <= 6) {
          return `(${range})%.*${target.regexHint}`;
        }
      }
      return target.regexHint;
    }

    if (target.id.includes("pack_size")) {
      const min = target.minDesiredValue ?? 8;
      return `(${numberRangePattern(min)})%.*pa`;
    }
    if (target.id.includes("splinter")) {
      return "spl";
    }
    if (target.id.includes("logbook")) {
      return "logb";
    }
    if (
      target.id.includes("simulacrum") ||
      target.id.includes("delirium_splinter")
    ) {
      return "simu";
    }
    if (target.id.includes("desecrated")) {
      return "dese";
    }
    if (target.id.includes("waystone") || target.id.includes("ways")) {
      return "ways";
    }

    const token = target.name
      .replace(/[^a-zA-Z]/g, "")
      .slice(0, 4)
      .toLowerCase();
    return token || target.id.slice(0, 4);
  }

  private static fitToLimit(patterns: string[]): string {
    if (!patterns.length) return '""';

    let working = [...patterns];
    let merged = `"${working.join("|")}"`;

    while (merged.length > STASH_LIMIT && working.length > 1) {
      working.pop();
      merged = `"${working.join("|")}"`;
    }

    if (merged.length > STASH_LIMIT) {
      const innerBudget = STASH_LIMIT - 2;
      const truncated = working[0].slice(0, Math.max(innerBudget, 1));
      merged = `"${truncated}"`;
    }

    return merged;
  }

  public static withinLimit(regex: string): boolean {
    return regex.length <= STASH_LIMIT;
  }
}

function regexForModIds(ids: string[]): string {
  const mods = ids
    .map((id) => TABLET_MOD_WEIGHTS[id])
    .filter((m): m is NonNullable<typeof m> => !!m);
  if (!mods.length) return '""';
  return TabletRegexBuilder.buildOptimizedRegex(
    mods.map((m) => ({
      id: m.id,
      name: m.name,
      regexHint: m.regexHint,
      // Floor of roll range — do not invent a midpoint threshold
      minDesiredValue: Math.ceil(m.minValue),
      priority: m.valueScore,
      highlightCategory: "high_value" as const,
    })),
  );
}

/**
 * Per-tier stash regexes for a tablet base (quality S / A / B mods).
 *
 * Apply in order S → A → B. Anything that matches none → Trash.
 *
 * Stash cannot score multi-affix combos, so:
 *   S-quality hit → usually MDP rare A (solo S); true MDP S needs support
 *   A-quality hit → usually MDP rare B
 *   B-quality hit → soft mid (often still dump/reforge economics)
 */
export function buildRareTierJudgementRegexes(
  baseId: string,
): TierJudgementRegex[] {
  const base = TABLET_BASES[baseId];
  if (!base) return [];

  const pool = [...base.allowedPrefixPool, ...base.allowedSuffixPool];
  const sMods = pool.filter((id) => modQualityTierForBase(baseId, id) === "S");
  const aMods = pool.filter((id) => modQualityTierForBase(baseId, id) === "A");
  const bMods = pool.filter((id) => modQualityTierForBase(baseId, id) === "B");

  return [
    {
      tier: "S",
      regex: regexForModIds(sMods),
      modIds: sMods,
      note:
        baseId === "temple_tablet"
          ? "S-quality (Temple: crystal → MDP S)"
          : aMods.length
            ? "S-quality. Solo → MDP A ask; true MDP S needs S+A/SS support"
            : "S-quality. Solo → MDP A (no A-support mods on this base)",
    },
    {
      tier: "A",
      regex: regexForModIds(aMods),
      modIds: aMods,
      note: aMods.length
        ? "A-quality. Solo → MDP rare B"
        : "No A-quality mods — use S hits as MDP A",
    },
    {
      tier: "B",
      regex: regexForModIds(bMods),
      modIds: bMods,
      note: "B-quality mid band. No S/A/B match → Trash",
    },
  ];
}
