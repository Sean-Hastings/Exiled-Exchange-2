/**
 * Price curves over discrete mod roll values (uniform within [min, max]).
 *
 * Fit p(v) = A · exp(k · v) from measured anchors only — never invent a
 * midpoint sell. Survey should measure low / mid / high rolls explicitly;
 * extra anchors improve the log-linear fit.
 */

export interface RollPriceAnchor {
  /** Integer (or discrete) roll value */
  roll: number;
  /** Observed sell ask in exalted */
  sellEx: number;
}

export interface ModRollPriceCurve {
  modId: string;
  minValue: number;
  maxValue: number;
  /** p(v) = A * exp(k * v) */
  A: number;
  k: number;
  anchors: RollPriceAnchor[];
  /** E[p] under uniform discrete rolls on integers min..max inclusive */
  expectedSellEx: number;
}

export function discreteRolls(minValue: number, maxValue: number): number[] {
  const lo = Math.ceil(Math.min(minValue, maxValue));
  const hi = Math.floor(Math.max(minValue, maxValue));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];
  const out: number[] = [];
  for (let v = lo; v <= hi; v++) out.push(v);
  return out;
}

/**
 * Sample prongs for live S-tier roll-curve measurement: lo / mid / hi.
 * Mid = rolls[floor((n-1)/2)]. Crystal [5,10] → 5,7,10.
 * If n≤2 return all rolls; if n=1 return [that].
 */
export function rollSampleProngs(minValue: number, maxValue: number): number[] {
  const rolls = discreteRolls(minValue, maxValue);
  if (rolls.length <= 2) return rolls;
  const lo = rolls[0]!;
  const hi = rolls[rolls.length - 1]!;
  const mid = rolls[Math.floor((rolls.length - 1) / 2)]!;
  return [lo, mid, hi];
}

/** Cache key for a per-base live mod roll curve. */
export function modRollCurveKey(baseId: string, modId: string): string {
  return `${baseId}/${modId}`;
}

/**
 * Log-linear least squares: ln(p) = ln(A) + k·v.
 * Requires ≥2 anchors with sellEx > 0.
 */
export function fitExponentialRollCurve(
  anchors: RollPriceAnchor[],
): { A: number; k: number } | null {
  const pts = anchors.filter(
    (a) =>
      Number.isFinite(a.roll) &&
      Number.isFinite(a.sellEx) &&
      a.sellEx > 0,
  );
  if (pts.length < 2) return null;

  const n = pts.length;
  let sumV = 0;
  let sumL = 0;
  let sumVV = 0;
  let sumVL = 0;
  for (const p of pts) {
    const v = p.roll;
    const l = Math.log(p.sellEx);
    sumV += v;
    sumL += l;
    sumVV += v * v;
    sumVL += v * l;
  }
  const denom = n * sumVV - sumV * sumV;
  if (!(Math.abs(denom) > 1e-12)) {
    // All rolls identical — flat price at geometric mean
    const A = Math.exp(sumL / n);
    return { A, k: 0 };
  }
  const k = (n * sumVL - sumV * sumL) / denom;
  const lnA = (sumL - k * sumV) / n;
  const A = Math.exp(lnA);
  if (!(A > 0) || !Number.isFinite(A) || !Number.isFinite(k)) return null;
  return { A, k };
}

export function priceAtRoll(
  curve: Pick<ModRollPriceCurve, "A" | "k">,
  roll: number,
): number {
  const p = curve.A * Math.exp(curve.k * roll);
  return Number.isFinite(p) && p > 0 ? p : Number.NaN;
}

/** Discrete uniform average of p(v) over integer rolls in [min, max]. */
export function expectedSellFromCurve(
  curve: Pick<ModRollPriceCurve, "A" | "k" | "minValue" | "maxValue">,
): number {
  const rolls = discreteRolls(curve.minValue, curve.maxValue);
  if (!rolls.length) return Number.NaN;
  let sum = 0;
  for (const v of rolls) {
    const p = priceAtRoll(curve, v);
    if (!Number.isFinite(p)) return Number.NaN;
    sum += p;
  }
  return sum / rolls.length;
}

/**
 * Build a curve from measured anchors. Does not invent mid/high/low prices —
 * caller must supply real trade checks (ideally low, mid, and high rolls).
 */
export function buildModRollPriceCurve(opts: {
  modId: string;
  minValue: number;
  maxValue: number;
  anchors: RollPriceAnchor[];
}): ModRollPriceCurve | null {
  const fit = fitExponentialRollCurve(opts.anchors);
  if (!fit) return null;
  const partial = {
    ...fit,
    minValue: opts.minValue,
    maxValue: opts.maxValue,
  };
  const expectedSellEx = expectedSellFromCurve(partial);
  if (!Number.isFinite(expectedSellEx)) return null;
  return {
    modId: opts.modId,
    minValue: opts.minValue,
    maxValue: opts.maxValue,
    A: fit.A,
    k: fit.k,
    anchors: opts.anchors.map((a) => ({ ...a })),
    expectedSellEx,
  };
}
