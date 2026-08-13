# Tablet Calibration & Batch Risk Spec

**Status:** ready to implement (spec-only; no app feature code in this doc)  
**Revision:** final normative freeze — 2026-08-13  
**Branch:** `tablet-flipping`  
**Scope:** Exiled-Exchange-2 tablet flipping — knobs B/C, experiential roll log → weight fitting, §3 batch risk, §9 outer mixture, tier-uncertainty panel  
**Primary code roots:**

- `renderer/src/web/price-check/tablets/`
- `renderer/src/web/tablets/`
- `main/src/tablet-survey-api.ts` (export pattern reference only; v1 roll-seen is clipboard-first)

---

## 1. Goals / non-goals

### Goals

1. **Buy knob B** — blank unit cost for EV/strategy math = **mean of the cheapest B asks** (not “Nth cheapest”). Persist B separately from market-flow / hot depth used only for sync probing.
2. **Craft knob C** — independent batch size for risk UI (1a/1b). Farmed blanks must not inflate buy prices via C.
3. **Risk UI (per tablet type, presented together with point EV):**
   - **1a:** 95% sure total liquid **spend** for crafting **C** tablets under recommended strategy **Y** ≤ **Z_cap** (ex). Spend only — no mid-batch sale offsets / drawdown.
   - **1b:** 95% sure **profit** for that batch ≥ **Z_profit** (ex).
   - **Y** = recommended policy from the **existing point-estimate MDP** (`recommendPolicy` / blanks + rare tiers).
4. **Experiential roll log** — capture sparse hit counts over known trial counts; empty field = **unmeasured**, never coerced to zero.
5. **Weights pipeline** — persist **raw** (trials + hits) → **Beta–Binomial** posterior (**display CI only**) → MLE \(\hat p\) → fit `weightOverrides` via IPS (`trashMode: "seed"` default; trash = Junk tier only). **Dirichlet** is for **§9 outer mixture draws only** — never used as the display CI. Confidence stays on raw / Beta display posterior, not stuffed into weight scalars.
6. **§3 / §9** — keep point MDP for **Y** and point EV; add batch (spend, profit) law over C; outer mixture over posterior weight draws for wider Z bands and EV bands. v1 §3 is **MC-first**; grid optional later.
7. **Tier panel** — repurpose Manual Tier Survey toward “which mods are we least sure how to tier (S/A/B/Junk)?”; once tiered, live market for the few that matter. **Phase 6 is in the ship bar** (locked design includes tier panel).

### Non-goals (v1)

- No distributional / Bayesian MDP replacement.
- No Bellman sidecar, no policy optimization under posterior draws.
- No per-method pool splits (alch vs chaos vs magic share one weight universe per `(tabletType × prefix|suffix)`).
- No inventing hit rates from empty fields.
- No mid-batch inventory mark-to-market / sale-offset spend accounting.
- No automatic promotion of `WEIGHT_BENCH` community claims into overrides without a local raw sample.
- No VitePress user-doc rewrite; this file is an engineering spec.
- No true 3-item Reforge batch coupling in risk (use MDP-consistent 1/3 approx + badge; see §3.6 / §9 open risks).

---

## 2. Data model

### 2.1 Concepts

| Symbol | Meaning |
|--------|---------|
| `baseId` | e.g. `breach_tablet`, `temple_tablet` (`TABLET_BASES` keys) |
| `side` | `"prefix" \| "suffix"` — separate weight universes |
| `modId` | id in `TABLET_MOD_WEIGHTS` / pool lists |
| `affixesPerTablet` | typically **4** for alchemy rare (2p+2s); **2** for magic T+A (1p+1s). UI-entered. |
| `tablets` | number of tablets in the logged batch |
| `T` | total affix rolls = `affixesPerTablet × tablets` |
| Prefix trials / suffix trials | ≈ `T/2` each (default split; UI may override if known). Approximate for 2p+2s; acceptable for v1. |
| Hit count for mod `m` | number of times `m` appeared among side-matched trials |
| Empty hit field | **unmeasured** (`null`) — not 0 |

**Pool rule:** one weight universe per `(baseId × side)`. Roll method does **not** split pools. Breach ≠ Temple.

**Trash vs cared:** `modQualityTier(modId)` from `mod-tiers.ts` — **Junk → trash** for fitting; S/A/B are non-trash. Optional fit opts may mark extra `forceCaredModIds` (e.g. historical Temple junk targets), but the default partition is Junk-only trash.

### 2.2 Raw seen schema (TypeScript)

New file: `renderer/src/web/price-check/tablets/roll-seen-types.ts`

```ts
/** Schema revision for persisted / exported roll logs. */
export const ROLL_SEEN_REVISION = 1 as const;

export type AffixSide = "prefix" | "suffix";

/** Per-mod hit observation. null hits = unmeasured (not zero). */
export interface ModHitObservation {
  modId: string;
  /** Affix appearances of this mod in the side's trial budget. */
  hits: number | null;
}

/**
 * One experiential sentence / batch entry.
 * UI: "Rolled {affixesPerTablet} affixes × {tablets} tablets;
 *      {mod}: {hits} …"
 */
export interface RollSeenBatch {
  id: string; // uuid
  baseId: string;
  createdAt: number;
  updatedAt: number;
  /** Patch / league tags for IDE analysis (optional). */
  leagueId?: string;
  note?: string;
  affixesPerTablet: number; // default 4
  tablets: number;
  /**
   * Optional explicit trial budgets. If omitted:
   *   totalTrials = affixesPerTablet * tablets
   *   prefixTrials = floor(total/2), suffixTrials = total - prefixTrials
   */
  prefixTrials?: number;
  suffixTrials?: number;
  /** Sparse: only cared non-trash mods the user filled. */
  hits: ModHitObservation[];
}

export interface RollSeenDocument {
  revision: typeof ROLL_SEEN_REVISION;
  updatedAt: number;
  batches: RollSeenBatch[];
}

/** Aggregated raw counts for one (baseId × side × modId). */
export interface RawSeenCell {
  baseId: string;
  side: AffixSide;
  modId: string;
  /** Sum of measured hits across batches that recorded this mod. */
  hits: number;
  /**
   * Sum of side trial budgets from batches where this mod was measured
   * (hits !== null). Batches that left the field empty do not contribute.
   */
  trials: number;
  /** Number of batches that measured this mod. */
  batchCount: number;
}

/** Cumulative side trial budget for one (baseId × side) pool — Dirichlet α_trash. */
export interface SidePoolTrials {
  baseId: string;
  side: AffixSide;
  /**
   * Sum of that side's trial budgets across all batches for this base
   * (every log entry contributes, even if no hits were filled for that side).
   */
  sideTrials: number;
}

export interface RawSeenAggregate {
  revision: typeof ROLL_SEEN_REVISION;
  updatedAt: number;
  cells: RawSeenCell[];
  /** One entry per (baseId × side) that has received any batch contribution. */
  sideTrials: SidePoolTrials[];
}
```

**Aggregation rule:**

1. **Cells:** For each batch, if `hits` entry for `modId` is `null`/absent → skip. If present (including `0`) → add `hits` to cell hits and add that batch’s **side** trial count to cell trials.
2. **`sideTrials` (normative):** When applying a log entry, always accumulate the batch’s side trial budgets onto the pool:
   - `sideTrials_prefix += prefixTrials` (default `⌊T/2⌋` when omitted)
   - `sideTrials_suffix += suffixTrials` (default `T − prefixTrials`)
   Hits only increment cells for **filled** mods; `sideTrials` increments regardless of which mods were measured.

#### Side attribution (normative)

`ModHitObservation` has no `side` field. Side is derived at aggregation time:

1. Look up `TABLET_BASES[baseId].allowedPrefixPool` and `.allowedSuffixPool`.
2. If `modId` is in the prefix pool only → `side = "prefix"`.
3. If `modId` is in the suffix pool only → `side = "suffix"`.
4. If in **neither** or **both** → **reject** the observation (do not aggregate; surface a validation error in the roll logger / fit UI). Do not guess.

### 2.2.1 Fitter target \(\hat p\) vs display posterior (normative)

| Quantity | Definition | Use |
|----------|------------|-----|
| **\(\hat p_m\)** (fitter target) | **MLE** \(hits_m / trials_m\) when `trials_m > 0`; else undefined (unmeasured) | Weight fitter (§3.4), App B zero-hit rule, residual checks |
| **Posterior mean / CI** | Beta mean \(\alpha/(\alpha+\beta)\) and equal-tailed 95% CI | **Display / confidence UI only** — never the fitter target |

Zero measured hits ⇒ \(\hat p = 0\) (MLE). Posterior mean under Beta(1,1+n) is never 0; that is intentional and must not feed the fitter.

### 2.3 Posterior / fit artifacts (derived, not primary truth)

```ts
export interface ModPosteriorSummary {
  baseId: string;
  side: AffixSide;
  modId: string;
  /** Beta(α, β) with α = hits + α0, β = (trials - hits) + β0 */
  alpha: number;
  beta: number;
  mean: number;       // α/(α+β) — DISPLAY ONLY
  /** Equal-tailed 95% CI on appearance rate (side trial basis). */
  ci95: [number, number];
  trials: number;
  hits: number;
  /** MLE rate hits/trials; fitter target when measured. */
  mleRate: number;
}

export type TrashWeightMode = "seed" | "constant";

/** Options for `fitWeightOverridesFromRates` / Apply Fit (defaults: seed, maxIters 200). */
export interface FitWeightOverridesOpts {
  trashMode?: TrashWeightMode;
  trashConstant?: number;
  forceCaredModIds?: string[];
  maxIters?: number;
}

export interface FittedWeightSnapshot {
  baseId: string;
  fittedAt: number;
  /** Ready to merge into TabletBaseDefinition.weightOverrides */
  weightOverrides: Record<string, number>;
  /** Trash mode used this fit */
  trashMode: TrashWeightMode;
  /**
   * When trashMode === "constant": the uniform trash weight.
   * When trashMode === "seed": omitted / null (per-id frozen seeds).
   */
  trashWeight?: number | null;
  /** Max abs/rel residual among fitted non-trash mods */
  maxAbsErr: number;
  maxRelErr: number;
  /** false ⇒ do not apply overrides; UI shows residuals only */
  converged: boolean;
  /** Human-readable failure reason when !converged */
  failureReason?: string;
  iterations: number;
  posteriors: ModPosteriorSummary[];
}
```

### 2.4 Export format (workspace / IDE)

JSON file (pretty-printed), parallel to `breach_survey.json` style:

```json
{
  "rollSeen": {
    "revision": 1,
    "updatedAt": 0,
    "batches": [ /* RollSeenBatch[] */ ]
  },
  "aggregate": {
    "revision": 1,
    "updatedAt": 0,
    "cells": [ /* RawSeenCell[] */ ],
    "sideTrials": [ /* SidePoolTrials[] */ ]
  },
  "meta": {
    "app": "exiled-exchange-2",
    "feature": "tablet-roll-seen",
    "exportedAt": 0
  }
}
```

Optional companion on export (when a fit was run):

```json
{
  "fit": { /* FittedWeightSnapshot */ }
}
```

**v1 export path (normative):** clipboard-first (`Copy aggregate` / `Export raw JSON` → clipboard). Optional file write via a **small dedicated IPC / Save dialog** in Phase 7. Do **not** stretch `tablet-survey-api.ts` (long-running Breach survey job) into a generic JSON writer for Phase 2.

### 2.5 Storage paths

| Layer | Path / key | Contents |
|-------|------------|----------|
| **App live** | `localStorage` key `ee2-tablet-roll-seen-v1` | `RollSeenDocument` (same pattern as `ee2-tablet-market-cache`, `ee2-manual-temple-tier-survey-v1`) |
| **App derived cache** | `localStorage` key `ee2-tablet-weight-fit-v1` | last `FittedWeightSnapshot[]` per base (optional; recompute from raw is source of truth) |
| **App knobs** | `ee2-tablet-buy-count-b`, `ee2-tablet-craft-count-c` | integers B, C |
| **Repo / IDE export** | user Save dialog / clipboard (default suggestion name: `tablet_roll_seen.json`) | full export JSON |
| **Optional CLI mirror** | Phase 7: small `main/src/tablet-roll-seen-api.ts` with `--export-tablet-roll-seen=path` | write aggregate for offline analysis |

**Buy-key migration (normative):** On first load, if `ee2-tablet-buy-count-b` is absent and `ee2-tablet-buy-patience-depth` exists, copy patience → B. After migration, **stop writing** the old patience key (read-only fallback only until removed). Do not maintain dual write sources.

**Do not** commit live user roll logs into git by default. Repo-export is an explicit user action (“Export raw counts”).

**Committed code overrides:** fitted point `weightOverrides` may still land in `mod-weights.ts` (as Temple already does) after human review — that is a code change, not the raw log.

### 2.6 Batch risk result types

New file: `renderer/src/web/price-check/tablets/batch-risk-types.ts`

```ts
import type { CraftPolicy } from "./tablet-mdp";

export interface BatchRiskKnobs {
  /** Buy count — mean of cheapest B asks → blank unit cost */
  buyCountB: number;
  /** Craft count — batch size for 1a/1b */
  craftCountC: number;
  /** Spend / profit percentile (default 0.95) */
  percentile: number; // 0.95
}

export interface BatchLawResult {
  baseId: string;
  policy: CraftPolicy;
  craftCountC: number;
  /** Point weights used (or one outer draw) */
  mode: "point" | "mixture-draw";
  /** CDF samples or analytic summary */
  spendEx: { mean: number; p95: number; samples?: number[] };
  profitEx: { mean: number; p05: number; samples?: number[] };
  /** 1a: Z_cap = spend p95; 1b: Z_profit = profit p05 (95% sure profit ≥ Z) */
  zCapEx: number;
  zProfitEx: number;
  method: "analytic" | "grid" | "mc";
  /**
   * When policy uses Reforge: always set (v1 always approximates).
   * UI shows “approx” badge; bands are not claimed as exact calibrated 95%.
   */
  reforgeApprox?: boolean;
  note?: string;
}

export interface MixtureRiskResult {
  baseId: string;
  policy: CraftPolicy;
  craftCountC: number;
  outerDraws: number;
  /** Mixture CDF percentiles (pooled MC samples — see §3.7) */
  zCapEx: number;
  zProfitEx: number;
  /**
   * Mixture band on whiteEV from solvePolicy(fixed Y, draw weights):
   * empirical p05–p95 across outer draws (DEFAULT). Point whiteEV stays separate.
   */
  evMeanEx: number;
  /** [p05, p95] of per-draw whiteEV */
  evBand: [number, number];
  reforgeApprox?: boolean;
  inner: BatchLawResult[]; // optional debug; UI may drop
}
```

---

## 3. Algorithms

### 3.1 Buy price: mean of cheapest B

**Change** blank base cost used for EV/MDP from Nth-ask semantics to mean-of-cheapest-B.

Current (`trade-price-estimators.ts`):

- Sort ascending; return **Nth** ask.
- Thin books (`|sorted| < 6`): **median**.
- Mid books: **~35% depth** heuristic (`buyEstimateNote`).

**Target for EV / market `basePrices` path — `estimateBuyPriceMeanOfCheapestEx` (normative):**

| Book size \(n = |sorted|\) | Buy estimate |
|----------------------------|--------------|
| \(n < 6\) | **Median** (existing thin-book safety); document in `buyEstimateNote` |
| \(n \ge 6\) | \(\displaystyle \text{buyEx}(B) = \frac{1}{k}\sum_{i=1}^{k} \text{sorted}_i,\quad k=\min(B, n)\) |

**Retire ~35% mid-book heuristic** for the mean-of-B path. It must not run inside `estimateBuyPriceMeanOfCheapestEx`.

**Mid-book when \(6 \le n < B\):** \(k = n\) ⇒ **mean of all asks**. This is an intentional second behavior change beyond Nth→mean (often moves blank cost a lot). Phase 1 DoD must call out the EV shift; tests must cover **6–49 listing** books.

Legacy `estimateBuyPriceEx` may keep Nth + thin median + 35% for **debug / flow-probe labels only**, or be deprecated after call-site migration. EV/`basePrices` must not use it.

**Regime → effective depth then mean (normative) — replaces today’s `buyDepthForRegime` `max(HOT, min(cold, 25))` path for EV/`basePrices`:**

| Regime | Effective count for mean-of-cheapest | Note string |
|--------|--------------------------------------|-------------|
| **hot** | \(k_{\text{eff}} = \min(B,\ 10)\) → mean of cheapest \(k_{\text{eff}}\) (then thin-median if \(n < 6\)) | `mean@hot10` / `mean@min(B,10)` |
| **cold** | \(k_{\text{eff}} = B\) → mean of cheapest \(\min(B, n)\) | `mean@B` |
| **warm / unknown** | \(k_{\text{eff}} = \min(B,\ 25)\) → mean of cheapest \(k_{\text{eff}}\) | `mean@warm25` / `mean@min(B,25)` |

Do **not** use `max(BUY_DEPTH_HOT, min(coldBuyDepth, BUY_DEPTH_N))` (or equivalent) as the EV blank-cost depth. Flow-probe / sync probing may still read hot/cold signals; the **price reduction** for `basePrices` is always mean-of-cheapest with the \(k_{\text{eff}}\) table above.

**API split:**

| Function | Role |
|----------|------|
| `estimateBuyPriceMeanOfCheapestEx(listings, B)` | **NEW** — EV/MDP blank cost |
| `estimateBuyPriceEx(listings, n)` | **KEEP** for flow-probe / debug “buy@N” only |
| `buyDepthForRegime` | May remain for **probe labels**; EV/`basePrices` use the regime → \(k_{\text{eff}}\) table above, then mean-of-cheapest |

**Persistence:** rename UI from “Cold buy@” → **Buy count B**; store `ee2-tablet-buy-count-b` (default **25**, clamp 5–50). Migrate old patience key once; stop writing it (§2.5).

**Sync:** `tablet-market-sync.ts` must write `market.basePrices[baseId]` using **mean-of-B**, not Nth. Update `buyEstimateNote` strings to `mean@B` / `mean@min(B,n)` / `mean@hot10` / `mean@warm25`.

### 3.2 Craft count C

- Independent integer, default **20**, clamp 1–500 (UI); risk math may warn above ~100.
- Does **not** enter `estimateBuyPrice*`.
- Feeds §3 / §9 only (+ display “batch of C”).

### 3.3 Posterior (raw → display rates)

Per measured cell `(baseId, side, modId)` with trials \(n\), hits \(h\):

- Likelihood: \(h \sim \mathrm{Binomial}(n, p)\) (appearance on a side trial; see §3.4 for mapping to pool weights).
- Prior: \(\mathrm{Beta}(\alpha_0, \beta_0)\) with defaults **α₀ = β₀ = 1** (uniform) unless a seed prior from current `modWeightForBase` implied rate is opted in later (v1: uniform).
- Posterior: \(\mathrm{Beta}(\alpha_0+h,\ \beta_0+n-h)\).
- **Display:** posterior mean + 95% CI (beta quantile, equal-tailed).
- **Fitter target:** MLE \(\hat p = h/n\) (§2.2.1). Not the posterior mean.

**Multi-mod consistency:** hits for different mods on the same side are **not** a full multinomial in the UI logger (user only fills cared mods). Treat each cared mod’s Beta as **marginal** for display; trash absorbs residual mass in the weight fitter / Dirichlet draws. Do not force \(\sum \hat p = 1\) across sparse mods at log time.

### 3.4 Weight fitting → `weightOverrides`

**Goal:** find non-negative weights \(w_m\) such that implied **one-affix** appearance rates match **MLE** \(\hat p_m\) within tolerance.

**Pool:** `allowedPrefixPool` / `allowedSuffixPool` for `baseId`.

#### Exported fit opts (normative)

`FitWeightOverridesOpts` is defined in §2.3. **Apply Fit** always calls `fitWeightOverridesFromRates(..., opts?)` with production defaults: `trashMode: "seed"`, `maxIters: 200`, no `trashConstant`, no forced cared unless the UI explicitly adds them.

#### Trash partition (normative) — Blocker fix

| Set | Membership | Fit behavior |
|-----|------------|--------------|
| **Trash** | `modQualityTier(m) === "Junk"` only (plus any ids explicitly listed in fit opts as trash) | See trash mode below |
| **Cared (fitted)** | Non-junk mods with a **measured** finite MLE \(\hat p\) (or `forceCaredModIds`) | Iteratively scaled to match \(\hat p\) |
| **Unmeasured non-junk** | S/A/B (or other non-junk) with no measured cell | **Omit from fit**; **ALWAYS HOLD** at seed `TABLET_MOD_WEIGHTS.weight` / existing committed overrides after rate→weight conversion. **Never** stomp to \(w_{\text{trash}}\). **Never** give them prior-only Dirichlet category mass (§3.7). |

#### Trash weight mode (normative)

| Mode | When | Behavior |
|------|------|----------|
| **`seed` (DEFAULT)** | Production fits, Temple replay, §9 mixture | For each Junk mod id, **freeze** \(w_m = \mathtt{modWeightForBase}(\mathrm{baseId}, m)\) (committed override or seed) for the duration of the fit. Do not collapse to a uniform constant. Do **not** redistribute a trash-lump rate uniformly onto Junk ids. |
| **`constant` (tests only)** | Synthetic unit tests | Fix every trash mod to a single \(w_{\text{trash}}\) (e.g. `trashConstant: 1200`). Uniform trash weight is allowed **only** in this mode. |

When fitting Temple under `seed` mode: committed junk overrides stay as-is (frozen); do not replace them with uniform 1200.

**Model (one-affix / chaos-style, matching Temple comment in `mod-weights.ts`):**

\[
P(\text{mod } m \mid \text{side}) = \frac{w_m}{\sum_{j \in \text{side pool}} w_j}
\]

For **unordered 2-without-replacement** rare rolls, appearance rate of \(m\) on a side with 2 slots is **not** identical to \(w_m/W\). v1 **fit target** = one-affix / chaos appearance (as Temple crystal fit). Document clearly in UI: “weights fitted to one-affix appearance; MDP still uses 2p+2s with these weights.”

**Algorithm `fitWeightOverridesFromRates` (IPS — only rate→weight path):**

1. Partition pool into `cared` (measured non-junk with finite MLE \(\hat p\), including \(\hat p = 0\)) and `trash` (Junk only). Unmeasured non-junk → leave at seed; not in either iterative set as “fit targets.”
2. Apply trash mode (`seed` default unless opts say `constant`).
3. **Init (normative):** ALWAYS initialize each **non-junk measured** cared weight from seed `modWeightForBase(baseId, m)` — **not** \(w_m \propto \hat p_m\).
4. **Preflight failure:** let \(P = \sum_{m \in \text{cared}} \hat p_m\). If \(P \ge 1 - \varepsilon_{\text{mass}}\) with \(\varepsilon_{\text{mass}} = 10^{-6}\), set `converged: false`, `failureReason: "sum_mle_ge_one"`, **do not apply** overrides; return residuals / diagnostics only.
5. Iterate **iterative proportional scaling (IPS)**, `maxIters` from opts (default **200**):
   - Compute \(W = \sum w\) over full side pool (cared + trash + unmeasured-held seeds).
   - For each cared \(m\) with \(\hat p_m > 0\): implied \(p_m = w_m / W\); if \(p_m > \epsilon\) (\(\epsilon = 10^{-12}\)), scale \(w_m \leftarrow w_m \cdot \hat p_m / p_m\).
   - For each cared \(m\) with \(\hat p_m = 0\) (measured zero-hit): keep driving \(w_m\) toward 0 via scale steps; during IPS clamp with floor \(\varepsilon_w = 10^{-9}\) for numerical stability only.
   - Keep trash (and unmeasured seeds) **fixed**; scale cared only.
6. Stop early when for all cared \(m\) the App B tolerance holds; else after `maxIters` set `converged: false`, `failureReason: "max_iters"`.
7. **Emit overrides (normative):**
   - Measured zero-hit (\(\hat p = 0\)): if converged, emit override weight **`0`** (excluded from pool / “remove from pool”). IPS floor \(10^{-9}\) is transitional only — do not leave \(\varepsilon_w\) in the applied snapshot when target is 0.
   - Other cared mods that differ from defaults: emit fitted \(w_m\).
   - Constant-mode trash entries when used.
   - Never write overrides that stomp unmeasured non-junk to trash weight.

**Apply Fit UI rule:** If `converged === false`, **do not** enable / apply runtime overrides; show residuals and `failureReason` only. When `converged === true`, Apply Fit uses the defaults above (`trashMode: "seed"`, etc.).

**Confidence:** never encode CI width into \(w_m\). Expose `ModPosteriorSummary` (MLE + Beta–Binomial display CI) beside overrides.

#### Regression tests (normative) — no false Temple wc=2210 requirement

| Test | Requirement |
|------|-------------|
| **Synthetic recover** | Construct known side weights \(W\), known trash (constant or seed), known cared \(w^\*\); compute one-affix rates; run fitter; recover cared \(w\) within App B tolerance. **Primary** fitter regression. |
| **Temple sample (optional note)** | May replay historical crystal hits under **side-trial** basis with `trashMode: "seed"` (frozen committed non-crystal overrides). Do **not** require `wc ≈ 2210` under uniform trash 1200 — that number assumed a different trash partition and total-affix (not side-trial) basis. |
| **Zero-hit emit** | Measured \(\hat p = 0\) converges to applied override `0` (not \(\varepsilon_w\)). |
| **Init from seed** | First IPS iterate starts from `modWeightForBase`, not \(\propto \hat p\). |

### 3.5 Point MDP path + weight plumbing (normative)

Keep:

- `recommendPolicy(market, baseId)` → **Y**.
- `TabletEVEngine.calculateBaseEV` / `calculateAllBaseEVs` → point EV.

#### Mandatory API plumbing (blocker)

Runtime / mixture weights **must** inject without stomping shared chaos caches. Normative surface:

```ts
modWeightForBase(
  baseId: string,
  modId: string,
  opts?: { runtimeOverrides?: Record<string, number> },
): number
// Order: runtimeOverrides[modId] → TABLET_BASES[baseId].weightOverrides[modId] → TABLET_MOD_WEIGHTS[modId].weight

buildTierSaleTable(
  market: MarketPriceCache,
  baseId: string,
  opts?: { runtimeOverrides?: Record<string, number> },
): TierSaleTable

// Chaos / pair builders that call modWeightForBase must accept the same opts
// (or a weightLookup closure) and must not use a baseId-only cache key.
```

**Chaos cache key (normative):** `(baseId, weightFingerprint)` where fingerprint = stable hash of sorted `[modId, weight]` pairs actually used for that build (runtime overrides merged view). `clearChaosTransitionCache()` remains available; prefer keyed cache over global clear-only.

**Point path bit-identical:** When no runtime fit / no mixture overrides are active, point MDP + EV results must be **bit-identical** to pre-change behavior **aside from** the intentional buy-mean price shift (§3.1).

**Injection UX:** Default UI uses **committed** `TABLET_BASES[baseId].weightOverrides`. “Apply fitted overrides” checkbox merges runtime fit for what-if without editing `mod-weights.ts` (only when `converged`).

### 3.6 §3 — Batch law under fixed weights + policy Y

**Inputs:** `baseId`, `CraftPolicy` Y, `MarketPriceCache` (blank cost from mean-of-B), `craftCountC`, weights via override-aware `modWeightForBase`, percentile \(q=0.95\).

#### v1 method selection (normative) — MC-first

| Priority | Method | v1 status |
|----------|--------|-----------|
| **1 (DEFAULT)** | **MC** via `sampleCraftPath` | **Ship this.** Default `N = 20_000` i.i.d. batches for point §3; chaos cap below. |
| 2 (optional later) | Analytic / grid | Phase 4.5+ only. If implemented: bins **0.1 ex**; document max atoms and wall-clock; fall back to MC when budget exceeded. |

Do not block Phase 4 on analytic/grid.

**Chaos cap for risk:** `maxChaosPerItem = 50` (separate from UI Simulate’s default 10_000). Truncated mass sells current tier as-is (same as sim truncate semantics). Mark truncated fraction in debug/note if non-trivial.

#### `sampleCraftPath` I/O (normative)

Factor from `simulatePolicy` into:

```ts
sampleCraftPath(
  sales: TierSaleTable, // from buildTierSaleTable(..., opts?)
  policy: CraftPolicy,
  rng: Rng,
  opts?: { maxChaosPerItem?: number }, // risk default 50
): {
  spend: number;    // liquid currency paid; NEVER subtract sales
  revenue: number;  // terminal sale
  profit: number;   // revenue - spend
  chaosRolls: number;
  truncated: boolean;
}
```

**Spend initialization (must match `simulatePolicy` economics):**

\[
\text{spend}_0 =
  \mathtt{baseCost}
  + \begin{cases}
      \mathtt{magicOrbCost} & Y.\text{blank} = \texttt{Magic-Pipeline} \\
      \mathtt{alchOrbCost} & Y.\text{blank} = \texttt{Scour-Alch}
    \end{cases}
\]

Then add chaos / vaal orb costs exactly as `simulatePolicy` does today.

- `Scour-Alch`: `alchOrbCost` is alchemy only (`scouring` is 0 in PoE2 defaults) — do not invent a scour fee.
- **NaN / missing `baseCost`:** risk UI **N/A** (“need market sync”); do not fabricate Z.
- **`Skip-Blanks`:** risk **N/A** (hide or show N/A).
- Rare **Dump** is not a `RareAction`; dump ≡ List on Trash. Corrupt `Dump` and `List` share the same tier ask in the solver — risk revenue uses the same `corruptSaleEx`.

**Randomness per craft (one tablet):**

1. Pay blank + orb cost as above.
2. Draw initial rare tier from `alchDist` / `magicDist`.
3. Follow **Y.rare** / **Y.corrupt** (List / Chaos / Reforge / Vaal / Dump≡List) with the same transitions as `simulatePolicy`.
4. Accumulate spend (no sale offsets), revenue, profit.

**Batch of C:** independent crafts (i.i.d. under fixed weights) for v1.

\[
S_C = \sum_{i=1}^{C} \text{spend}_i,\quad \Pi_C = \sum_{i=1}^{C} \text{profit}_i
\]

**Outputs:**

- \(Z_{\text{cap}} = F_{S_C}^{-1}(0.95)\)
- \(Z_{\text{profit}} = F_{\Pi_C}^{-1}(0.05)\)

**Inner method interface** (`batch-law.ts`):

```ts
export interface BatchLawSolver {
  compute(input: {
    baseId: string;
    market: MarketPriceCache;
    policy: CraftPolicy;
    craftCountC: number;
    percentile?: number; // default 0.95
    weightOverrides?: Record<string, number>;
    /** Risk chaos cap; default 50 */
    maxChaosPerItem?: number;
    /** Point §3 default 20_000; mixture inner may use 5_000 */
    mcBatches?: number;
  }): BatchLawResult;
}
```

#### Reforge rule (ONE normative rule) — `sampleCraftPath` must match MDP

If **any** `policy.rare[*] === "Reforge"`:

1. **`sampleCraftPath` MUST** model each Reforge transition as **MDP-consistent**: expected continuation value \(= \frac{1}{3}\) of the expected fresh-alch continuation under `qRareAction` / `solveRareValues` (equivalently \(\frac{1}{3}\) of expected list revenue under `alchDist` when that is what the MDP uses), **0 bench fee**. Do **not** use `simulatePolicy`’s current full-redraw / shortcut sampling for risk MC.
2. Set `reforgeApprox: true` on the result.
3. Risk UI **always shows 1a/1b** with an **“approx” badge** and footnote: “Reforge uses MDP 1/3 expected continuation; batch coupling not modeled — bands are approximate.”

Do **not** hide risk (N/A) for Reforge in v1. Do **not** claim exact calibrated 95% bands when the badge is shown.

**Simulate UI may differ until shared:** dashboard `simulatePolicy` / Simulate may keep its current redraw shortcut until both paths call the same MDP-consistent helper. Document that Simulate ≠ risk Reforge semantics until unified; risk/`sampleCraftPath` follows this section.

`simulatePolicy` / dashboard **Simulate** may continue to return net profit with sales; that is **not** 1a spend (see §5.1 footnote).

### 3.7 §9 — Outer mixture over Dirichlet weight draws

**Not** a new MDP. For each outer draw \(d = 1..D\):

**Draw counts (normative):**

| Mode | \(D\) |
|------|-------|
| Interactive (default UI) | **50** |
| Full (explicit “Full mixture” / non-interactive) | **200** |

**Perf (normative):** compute **async / chunked** (Worker or chunked main-thread with yield). **Cancel** in-flight work on `baseId` change or knob change. Prefer not to block UI > ~2s without a progress indicator.

#### Dirichlet α recipe from sparse `RawSeenCell` (ONE formula — normative)

Per `(baseId × side)` pool:

1. **Categories** = **measured cared mods** in that pool **+ one trash lump**.  
   - **Unmeasured cared (non-junk) are NOT categories** — they receive no Dirichlet mass and are **ALWAYS held at seed/override** after conversion (same as point fit). No prior-only Dirichlet mass moving them.
2. Let `sideTrials` be the pool’s `sideTrials` field from `RawSeenAggregate` (§2.2). Let \(H = \sum_i \mathrm{hits}_i\) over measured cared categories only.
3. For each measured cared mod \(i\): \(\alpha_i = 1 + \mathrm{hits}_i\).
4. \(\alpha_{\mathrm{trash}} = 1 + \max(0,\ \mathtt{sideTrials} - H)\).
5. Draw \(\mathbf{p} \sim \mathrm{Dirichlet}(\boldsymbol{\alpha})\). Map \(p_i\) → cared targets, \(p_{\mathrm{trash}}\) → junk lump rate (not a per-Junk-id rate).
6. **Rate→weight (DEFAULT — no OR):** convert via **`fitWeightOverridesFromRates`** with targets \(\hat p\) replaced by the draw, **same IPS** and **same `trashMode` as the point fit** (`"seed"` default).  
   - Under `"seed"`: **NEVER** redistribute the trash lump uniformly onto Junk ids; trash weights stay frozen seeds while IPS fits cared.  
   - Under `"constant"` (tests only): uniform trash weight via `trashConstant` is allowed.

**Independent Beta** (reject/renormalize if \(\sum p > 1-\varepsilon\)): **debug fallback only**, not the default. Do not ship UI mixture on independent Beta.

**Do not** use a closed-form rate→weight map. Mixture and point share one IPS fitter.

#### Outer loop

1. Draw rates + IPS-fit weights as above for each side.
2. Run **§3** with those weights and **same Y** from point MDP — do **not** re-solve policy per draw. Overrides must flow through §3.5 plumbing + chaos fingerprint.
3. Collect per-draw sample banks / Z / mean profit; also compute per-draw `whiteEV` via `solvePolicy` with **draw weights + fixed Y**.

#### Mixture CDF when inner has no samples (ONE default)

**DEFAULT (normative):** When mixture (§9) is on, the inner §3 solver **must** use **MC with sample banks** (`spendEx.samples` / `profitEx.samples` required). Mixture CDF = **pool all inner batch samples across outer draws** (method A) → single empirical CDF → one \(Z_{\text{cap}}, Z_{\text{profit}}\).

- Do **not** run analytic/grid-only inner under mixture without samples.
- Label UI: “95% under weight uncertainty (mixture).”

**Not used as default:** percentile-of-per-draw-\(Z\) (method B). May exist later as a debug compare; must not be the unlabeled default.

#### EV bands (DEFAULT — normative)

**Always report both:**

1. **Point** `whiteEV` from the existing point MDP path (unchanged column).
2. **Mixture band on `whiteEV`:** for each outer draw, `solvePolicy(fixed Y, draw weights)` → collect `whiteEV`; report empirical **p05–p95** (and mean) beside point EV. Do **not** replace the point EV column.

**Deferred (not v1 default):** bands on \(E[\Pi_C]/C]\). Do not dual-OR “whiteEV **or** \(E[\Pi_C]/C]\)” in the ship path.

### 3.8 Tier uncertainty ranking

Export from `mod-tiers.ts` (or a thin wrapper):

```ts
/** True iff modId has an entry in EXPLICIT_TIER_BY_MOD_ID (export hasExplicitTier). */
export function hasExplicitTier(modId: string): boolean;
```

**Score (normative, implementable, ordinal ranking — not a calibrated probability):**

\[
\begin{aligned}
\text{uncertainty}(m) =\ &
  2\cdot\mathbf{1}[\neg\texttt{hasExplicitTier}(m)] \\
&+ 2\cdot\mathbf{1}[\neg\texttt{saleTouching}(m)] \\
&+ 1\cdot\mathbf{1}[\texttt{modQualityTier}(m)\text{ comes from valueScore fallback only}] \\
&+ 1\cdot\mathbf{1}[\text{no auto-survey observation for } m]
\end{aligned}
\]

**`saleTouching(m)` (normative):** `true` if **any** of:

1. Any key in `modValueMap` for that `baseId` contains mod id `m` as a **prefix-side or suffix-side** token when the key is split on `'+'` (exact token match after split), **or**
2. `listingAnchors` (when present on the market/cache shape) mention `m`.

Otherwise `false`. Do not invent fuzzy substring matches beyond the `'+'`-split token rule.

Drop undefined “low survey octave confidence.” The last term means: no observation in automated Breach/`tier-survey-*` (or generalized auto survey) docs for that mod — not manual Temple session noise.

Present top uncertain mods for selected `baseId`; actions: set S/A/B/Junk (writes session → eventually `mod-tiers.ts` or runtime overlay), then deep-link “Refresh selected” market for combos that include that mod.

**Auto survey stays:** automated `tier-survey-*` + `tablet-survey-api` / `breach_survey.json` paths remain. Only the **manual price-first** UX is replaced/soft-deprecated by the uncertainty panel.

---

## 4. Module / file map

### 4.1 New files

| File | Responsibilities |
|------|------------------|
| `renderer/src/web/price-check/tablets/roll-seen-types.ts` | Types + `ROLL_SEEN_REVISION` |
| `renderer/src/web/price-check/tablets/roll-seen-store.ts` | `loadRollSeen`, `saveRollSeen`, `upsertBatch`, `deleteBatch`, `aggregateRawSeen(doc)` (side attribution + **sideTrials** accumulate), localStorage |
| `renderer/src/web/price-check/tablets/roll-seen-export.ts` | `buildRollSeenExportPayload`, **clipboard JSON helper**; optional Save-dialog IPC later |
| `renderer/src/web/price-check/tablets/weight-posterior.ts` | `betaPosterior` (display CI); `summarizePosteriors(aggregate)`; Dirichlet `drawSideRates(...)` per §3.7 α recipe + `sideTrials`; independent Beta = debug |
| `renderer/src/web/price-check/tablets/weight-fitter.ts` | `FitWeightOverridesOpts`, `fitWeightOverridesFromRates` → `FittedWeightSnapshot`; IPS init from seed; zero-hit → 0; maxIters/ε/failure; seed vs constant trash |
| `renderer/src/web/price-check/tablets/batch-risk-types.ts` | `BatchRiskKnobs`, `BatchLawResult`, `MixtureRiskResult` |
| `renderer/src/web/price-check/tablets/craft-path-sample.ts` | `sampleCraftPath` (§3.6 I/O); Reforge = MDP 1/3 expected continuation (not sim redraw); shared with §3 MC; Simulate may differ until unified |
| `renderer/src/web/price-check/tablets/batch-law.ts` | `computeBatchLaw` (MC-first), implements §3 |
| `renderer/src/web/price-check/tablets/batch-risk-mixture.ts` | `computeMixtureRisk` §9; async/cancel; D=50/200; pooled MC samples |
| `renderer/src/web/price-check/tablets/tier-uncertainty.ts` | `rankTierUncertainty(baseId, market, survey?)` using §3.8 formula |
| `renderer/src/web/tablets/RollSeenPanel.vue` | Experiential roll logger UI |
| `renderer/src/web/tablets/BatchRiskPanel.vue` | 1a/1b + method badge + mixture toggle + Reforge approx badge |
| `renderer/src/web/tablets/TierUncertaintyPanel.vue` | Replaces/repurposes primary Manual Survey UX |
| `main/src/tablet-roll-seen-api.ts` *(Phase 7)* | Dedicated file export/import (not survey job API) |
| `renderer/specs/web/price-check/tablets/weight-fitter.spec.ts` | Synthetic recover; unconverged; trash seed vs constant |
| `renderer/specs/web/price-check/tablets/weight-posterior.spec.ts` | Beta CI / empty≠0; Dirichlet α + sideTrials; unmeasured not categories |
| `renderer/specs/web/price-check/tablets/batch-law.spec.ts` | Spend≠sale-offset; Skip-Blanks N/A; Reforge approx flag; chaos cap |
| `renderer/specs/web/price-check/tablets/roll-seen-store.spec.ts` | Aggregation + side reject neither/both |
| `renderer/specs/web/price-check/tablets/trade-price-estimators.spec.ts` | Mean-of-B; mid-book 6–49; warm/hot/cold |
| `renderer/specs/web/price-check/tablets/batch-risk-mixture.spec.ts` | D=1 matches §3; pooled samples; cancel smoke — **no** flaky Z_cap≥point |
| `docs/tablet-calibration-risk-spec.md` | This document |

### 4.2 Files to modify (function-level)

| File | Changes |
|------|---------|
| `trade-price-estimators.ts` | Add `estimateBuyPriceMeanOfCheapestEx`; retire 35% on that path; notes; keep Nth for debug |
| `tablet-market-sync.ts` | Mean-of-B for `basePrices`; plumb `buyCountB`; warm/unknown semantics; `mean@…` status |
| `tablet-market-store.ts` | Persist B + C; migrate patience → B; **stop writing** old key; pass B into sync |
| `tablet-mdp.ts` | Extract/import `sampleCraftPath`; thread `runtimeOverrides` through `buildTierSaleTable` / chaos / pairs; cache key `(baseId, weightFingerprint)` |
| `tablet-ev-calculator.ts` | Knobs; `batchRisk` / `mixtureRisk`; runtime overrides; `recommendPolicy` remains Y source |
| `mod-weights.ts` | Docblock → roll-seen pipeline; optional `getSidePool`; **no** auto-write overrides in v1 |
| `mod-tiers.ts` | Export `hasExplicitTier`; optional runtime tier overlay |
| `manual-tier-survey.ts` | Soft-deprecate price-first entry; auto survey untouched |
| `ManualTierSurveyPanel.vue` | Slim / wrap `TierUncertaintyPanel` |
| `TabletEVDashboard.vue` | B + C; embed panels; Simulate ≠ 1a footnote; rename Cold buy@ |
| `index.ts` | Re-export new modules |
| `temple-manual-market.ts` | Unchanged authority for Temple sales unless tier panel writes survey answers |

### 4.3 Call graph (point path preserved)

```
UI knobs B,C
  → setTabletBuyCountB / setTabletCraftCountC
  → ensureTabletMarketSynced({ buyCountB })
       → estimateBuyPriceMeanOfCheapestEx(..., Beff)
       → market.basePrices[baseId]
  → TabletEVEngine(market)
       → recommendPolicy → Y, whiteEV          [POINT — bit-identical aside from buy-mean]
       → calculateAllBaseEVs                   [POINT]
       → computeBatchLaw(Y, C, point weights)  [§3 MC]
       → computeMixtureRisk(Y, C, posteriors)  [§9 async, cancelable]
```

---

## 5. UI changes

All in / under `TabletEVDashboard.vue` unless noted. Panels are **phased and collapsible** (dashboard is already dense).

### 5.1 Dashboard knobs

Toolbar (replace single “Cold buy@”):

| Control | Binding | Default | Notes |
|---------|---------|---------|-------|
| **Buy B** | `tabletBuyCountB` | 25 | Mean of cheapest B; tooltip explains EV blank cost |
| **Craft C** | `tabletCraftCountC` | 20 | Batch risk only |

Keep: Force Market Refresh, Refresh Selected, Copy Stash Regex, Simulate, Debug.

**Footnote near Simulate (normative):** “Simulate net profit includes sales; **≠ 1a spend** (1a is liquid spend only, no sale offsets).”

### 5.2 Roll logger (`RollSeenPanel.vue`)

Sentence-style form for selected `baseId`:

> Rolled **\[affixesPerTablet\]** affixes on each of **\[tablets\]** tablets (T=…).  
> Hits — for each cared non-trash mod (filtered by `modQualityTier` ≠ Junk):  
> `temple_crystal_t1: [____]` …  
> Empty = unmeasured.

Actions: **Add batch**, list prior batches (edit/delete), **Fit weights** (runs posterior + fitter, shows residuals; Apply disabled if `!converged`), **Export raw JSON** / **Copy aggregate** (clipboard-first).

Show posterior CI + MLE \(\hat p\) beside each measured mod after fit (read-only). Validate side attribution on add (reject neither/both pools).

### 5.3 CI / confidence panel

Compact block under selected row strategy summary:

- Per cared mod: trials, hits, MLE \(\hat p\), posterior mean, 95% CI, fit residual vs override.
- Badge: `seed weights` | `runtime fit` | `committed overrides` | `fit failed`.

### 5.4 Batch risk block (`BatchRiskPanel.vue`)

Presented **together** for selected tablet type:

- Policy Y label (`formatSplitStrategy`).
- **1a:** “95% sure spend for C crafts ≤ **Z_cap** ex” (total spend).
- **1b:** “95% sure profit ≥ **Z_profit** ex”.
- Toggle: **Point weights (§3)** vs **Mixture (§9)** (wider bands; interactive D=50).
- Method chip: `mc` (v1); later `grid` / `analytic`.
- **Reforge “approx” badge** when `reforgeApprox`.
- Loading / cancel on base change for mixture.
- Footnote: “Spend ignores mid-batch sales. Y from point MDP.”

### 5.5 Tier uncertainty panel (`TierUncertaintyPanel.vue`)

- Ranked list: mod name, current tier, uncertainty reasons (from §3.8 indicators), “Set tier” S/A/B/Junk.
- Secondary: “Price on trade” → copy filter + optional sell-ex save into generalized manual session.
- Not primarily a full price-entry workflow; anchors (blank/dump) remain available but de-emphasized.

Manual Temple survey button → opens this panel (Temple still default base when none selected). **Automated** Breach survey remains available separately.

---

## 6. Integration with existing MDP / EV / market sync

### 6.1 What must not break

- `recommendPolicy` / `solveOptimalRarePolicy` / `buildTierSaleTable` point path (bit-identical when no runtime overrides, aside from buy-mean).
- `TabletEVEngine.calculateAllBaseEVs` row table (Net EV, ex/hr, Blank→, Rare→).
- `simulateCrafts` button behavior (internals may switch to `sampleCraftPath`; net-with-sales semantics preserved for Simulate).
- Temple `applyTempleManualSurveyMarket` authority on sales.
- Hot/cold/warm flow probe timing (`FLOW_PROBE_MS`) — only the **price reduction** from listings changes (mean vs Nth).
- Automated tier survey / `tablet-survey-api` Breach path.

### 6.2 Weight application order

`modWeightForBase(baseId, modId, opts?)`:

1. `opts.runtimeOverrides[modId]` (if present)  
2. Else `TABLET_BASES[baseId].weightOverrides[modId]`  
3. Else `TABLET_MOD_WEIGHTS[modId].weight`

§9 draws pass explicit override maps into `buildTierSaleTable` / chaos / pair builders / path sampler without mutating global refs — **thread opts**; cache by `(baseId, weightFingerprint)`.

### 6.3 Chaos transition cache

Prefer cache key `(baseId, weightFingerprint)`. Call `clearChaosTransitionCache()` on fit apply / teardown if needed. Fingerprint must change when mixture draws change weights.

### 6.4 Market sync

- `TabletMarketSyncOpts.coldBuyDepth` → rename to `buyCountB` (keep read alias for one revision; do not keep writing old storage key).
- Status text: `mean@B` / `mean@hot10` / `mean@warm25`.

---

## 7. Tests to add

| Spec file | Cases |
|-----------|--------|
| `trade-price-estimators.spec.ts` | Mean of cheapest B; \(n < B\) ⇒ mean of all; thin book median; **6–49 listing mid-book** (no 35% heuristic); hot/cold/warm effective B; note strings |
| `roll-seen-store.spec.ts` | Empty excluded; explicit 0 included; prefix/suffix split; multi-batch sum; **reject neither/both pool membership** |
| `weight-posterior.spec.ts` | Beta mean/CI display; MLE separate; unmeasured absent; Dirichlet α from sideTrials; trash lump; IPS convert (no closed form) |
| `weight-fitter.spec.ts` | **Synthetic known-W recover** within tolerance; trash `seed` freeze; `constant` mode for synthetic; init from seed; zero-hit → 0; sum MLE ≥ 1 → `converged:false` no apply; maxIters failure; **no** required wc=2210 under trash 1200 |
| `craft-path-sample` / `batch-law.spec.ts` | Spend never sale-offset; C=1; Skip-Blanks → N/A; NaN base → N/A; spend init Magic vs Alch; chaos cap 50; Reforge sets `reforgeApprox` + MDP 1/3 (not sim redraw) |
| `batch-risk-mixture.spec.ts` | **D=1 matches §3** on same seed; mixture requires/pools MC samples; outer whiteEV p05–p95; cancel-on-base-change smoke; **do not** assert mixture Z_cap ≥ point Z_cap |
| `tablet-mdp.spec.ts` / `tablet-ev-calculator.spec.ts` | Point EV bit-identical without runtime fit (aside from buy-mean); chaos cache fingerprint isolation across draws |
| `tier-uncertainty.spec.ts` | `hasExplicitTier` + `saleTouching` (`modValueMap` `'+'` split / listingAnchors); measured sale ranks lower than score-fallback / no-sale |

---

## 8. Implementation phases (ordered, shippable)

### Phase 0 — Spec freeze ✅

- This document merged on `tablet-flipping` (post-audit revision).

### Phase 1 — Buy mean-of-B + craft knob C (plumbing)

- Implement `estimateBuyPriceMeanOfCheapestEx` (retire 35% on this path; mid-book = mean of all when \(n < B\)).
- Persist B/C; migrate UI; stop writing old patience key; wire sync → `basePrices` with warm/unknown rule.
- Tests for buy estimator including 6–49 books.
- **Ship:** dashboard knobs; blank costs update; point EV still works.
- **Known EV shift:** blank costs (and thus point EV) will move vs Nth+35% heuristic — document in release notes / DoD.

### Phase 2 — Roll seen store + UI logger + export

- Types, store (side attribution), aggregate, `RollSeenPanel`, **clipboard** export.
- **Ship:** users can log Temple/Breach hits without fitting.

### Phase 3 — Posterior + weight fitter

- `weight-posterior.ts`, `weight-fitter.ts` (seed trash default, failure contract), CI panel, “Apply runtime fit” only if converged.
- Synthetic fitter regression (not wc=2210 uniform-trash).
- Begin override plumbing on `modWeightForBase` if needed for Apply Fit preview.
- **Ship:** fitted overrides preview; confidence on raw.

### Phase 4 — §3 batch law + risk UI

- Complete weight plumbing + chaos fingerprint (§3.5) **before** or as part of this phase.
- `craft-path-sample.ts`, `batch-law.ts` (MC-first, chaos cap 50), `BatchRiskPanel` (point weights), Reforge approx badge.
- Refactor `simulatePolicy` to shared sampler.
- **Ship:** 1a/1b under Y for selected base.

### Phase 5 — §9 outer mixture

- `batch-risk-mixture.ts`; Dirichlet default; force MC sample banks; pool samples; D=50 interactive / D=200 full; async + cancel.
- Chaos cache fingerprinting across draws.
- **Ship:** wider Z under weight uncertainty.

### Phase 6 — Tier uncertainty panel (**in ship bar**)

- `tier-uncertainty.ts` + `hasExplicitTier` + panel; soft-deprecate price-first Manual Survey; **auto survey stays**.
- Optional runtime tier overlay.
- **Ship:** “what to tier next” workflow. **Required for DoD** (locked design).

### Phase 7 — Polish / dedicated file export API / docs cross-links

- Optional `tablet-roll-seen-api.ts`; promote reviewed overrides into `mod-weights.ts` via PR (human).
- Update internal comments in `mod-weights.ts` / `WEIGHT_BENCH`.
- Optional grid §3 (Phase 4.5 carry-over).

---

## 9. Open risks / edge cases — recommended defaults

| Risk | Default (normative) |
|------|---------------------|
| Sparse multi-mod MLE sum ≥ 1 | Fitter `converged: false`; do not apply; show residuals |
| Sparse Dirichlet / display | Dirichlet α = 1+hits cared + trash lump from `sideTrials`; unmeasured held at seed; IPS convert; Beta–Binomial = display CI only; independent Beta debug-only |
| 2p+2s appearance ≠ one-affix fit target | Fit to one-affix; document; MDP keeps 2p+2s |
| Magic-Pipeline vs Alch trial accounting in roll log | Default `affixesPerTablet=4`; user sets 2 for magic slam logs; don’t mix methods in one batch without note |
| Chaos / reforge spend variance | Risk chaos cap **50**; MC-first; Reforge = MDP 1/3 + **approx** badge |
| Hot / cold / warm B | hot `mean@min(B,10)`; cold `mean@B`; warm/unknown `mean@min(B,25)` — **not** legacy `max(HOT,min(cold,25))` |
| Unmeasured blank cost (NaN) | Risk N/A |
| `Skip-Blanks` Y | Risk N/A |
| localStorage quota | Cap stored batches (e.g. 200); export+trim oldest |
| Mixture runtime cost | Interactive D=50, full D=200; inner MC banks; async/chunked; **cancel on base change** |
| Empty hit vs 0 | UI placeholder gray “—”; serialize `null`; never `0` on blur of empty |
| Breach≠Temple pools | Aggregate key always includes `baseId`; side from pools |
| Promoting fits to repo | Manual PR only; runtime fit never auto-writes `mod-weights.ts` |
| Unmeasured non-junk during fit / mixture | Always hold seed/override; never Dirichlet category; never \(w_{\text{trash}}\) |
| Mixture EV bands | Point whiteEV + mixture whiteEV p05–p95; \(E[\Pi_C]/C]\) deferred |
| Simulate vs risk Reforge | `sampleCraftPath` = MDP 1/3; Simulate may differ until shared |
| Simulate vs 1a | Simulate net ≠ 1a spend (UI footnote) |
| Old patience key | Migrate once; stop writing |

---

## 10. Definition of done

1. **B** is mean-of-cheapest-B for `market.basePrices` / EV (no 35% heuristic; mid-book = mean of all when \(n < B\); warm/unknown = `mean@min(B,25)`, hot `mean@min(B,10)`, cold `mean@B` — not legacy `max(HOT,…)`); **C** only affects risk; farmed blanks cannot change B. **Phase 1 documents intentional EV shift** vs legacy Nth+35%.
2. Roll log persists raw trials/hits + aggregate `sideTrials`; clipboard export works; empty ≠ zero; side attribution rejects neither/both.
3. Fitter targets **MLE** \(\hat p\); IPS init from seed; zero-hit → override `0`; `FitWeightOverridesOpts` defaults (`trashMode: "seed"`); produces `weightOverrides` within **min(0.1% abs, 3% rel)** when converged; `!converged` ⇒ no apply; **Beta–Binomial CI = display only**; trash = Junk seed-frozen; unmeasured non-junk always held.
4. Point MDP **Y** + point EV **bit-identical** when no runtime fit (aside from buy-mean). Override plumbing + `(baseId, weightFingerprint)` chaos cache in place.
5. Risk UI shows **1a Z_cap** and **1b Z_profit** for C under Y; spend ignores sales; MC-first; chaos cap 50; `sampleCraftPath` Reforge = MDP 1/3 (not sim redraw); NaN/`Skip-Blanks` → N/A.
6. §9 mixture: Dirichlet α recipe + IPS (same `trashMode`); interactive D=50 / full D=200; **MC sample banks pooled**; EV = point whiteEV + mixture whiteEV p05–p95; async + cancel; no distributional MDP.
7. Tier panel ranks uncertain mods via §3.8 formula + `saleTouching` + `hasExplicitTier`; Manual Survey is not the primary price-entry path; **auto survey stays**.
8. Vitest coverage per §7 (including mid-book 6–49, synthetic fitter, mixture D=1≡§3, no flaky Z monotonicity).
9. **Phases 1–6** merged and manually smoke-tested on Temple + Breach in the overlay dashboard (tier panel included).

---

## Appendix A — Current anchors (code today)

- Buy Nth (+ thin median + ~35% mid-book): `estimateBuyPriceEx` in `trade-price-estimators.ts`
- Patience UI: `coldBuyDepth` / `setTabletColdBuyDepth` in `tablet-market-store.ts` + `TabletEVDashboard.vue` (`ee2-tablet-buy-patience-depth`)
- Weights: `TABLET_BASES.*.weightOverrides`, `modWeightForBase(baseId, modId)` (no opts yet), `WEIGHT_BENCH`
- Chaos cache: `baseId`-only today — must become `(baseId, weightFingerprint)`
- MDP: `recommendPolicy`, `simulatePolicy`, `buildTierSaleTable`
- EV UI: `TabletEVEngine`, `TabletEVDashboard.vue`
- Manual survey: `manual-tier-survey.ts`, `ManualTierSurveyPanel.vue`
- Auto survey: `tier-survey-*`, `main/src/tablet-survey-api.ts` → `breach_survey.json`
- File export precedent for large surveys: `tablet-survey-api.ts` (not Phase 2 roll-seen path)

## Appendix B — Tolerance formula (normative)

For each cared mod with **MLE** target rate \(\hat p > 0\) and implied \(p\):

\[
|p - \hat p| \le \min(0.001,\ 0.03 \cdot \hat p)
\]

If \(\hat p = 0\) (measured zero hits, MLE): require \(p \le 0.001\) during IPS; on converged apply, emit override weight **0** (§3.4).

## Appendix C — Audit revision changelog (normative freeze)

Post product-audit + feasibility-audit must-fixes incorporated into this document (spec-only; no application code).

**2026-08-13 final freeze:** locked Dirichlet α/`sideTrials`, IPS-only mixture convert, seed-hold unmeasured, IPS init from seed + zero→0, warm=`min(B,25)`, EV bands = point whiteEV + mixture p05–p95, `FitWeightOverridesOpts`, `saleTouching`, `sampleCraftPath` Reforge = MDP 1/3 (not sim redraw), Goal 5 Beta vs Dirichlet wording.

---

## Appendix D — Must-fix → section map

| Source | Must-fix | Spec sections |
|--------|-----------|---------------|
| Product 1 | Fitter \(\hat p\) = MLE; Beta–Binomial display-only; Dirichlet = §9 only | §1 Goal 5, §2.2.1, §3.3, §3.4, App B |
| Product 2 | Trash = Junk only; unmeasured non-junk always seed-hold | §2.1, §3.4 trash partition, §3.7 |
| Product 3 | Side = pool membership; reject neither/both | §2.2 Side attribution |
| Product 4 | Retire 35%; mid-book mean-of-all; warm=`min(B,25)`; DoD EV shift; tests 6–49 | §3.1, §7, §8 Phase 1, §10.1 |
| Product 5 | Synthetic fitter regression; no wc=2210@trash1200 | §3.4 Regression tests, §7 |
| Product 6 | Override plumbing + chaos fingerprint; bit-identical point | §3.5, §6.2–6.3, §10.4 |
| Product 7 | §9 Dirichlet α + IPS (`trashMode` seed); no closed form; no uniform Junk split | §3.7 |
| Product 8 | Tier score + `saleTouching` + `hasExplicitTier`; Phase 6 in DoD | §3.8, §8 Phase 6, §10.7/10.9 |
| Product 9 | Replace flaky mixture test; Reforge approx badge | §3.6 Reforge, §7 mixture specs, §5.4 |
| Feasibility 1 | Same override + fingerprint (blocker) | §3.5, §6.2–6.3 |
| Feasibility 2 | Mixture CDF: force MC banks when mixture on | §3.7 Mixture CDF |
| Feasibility 3 | maxIters/ε/sum-\(\hat p\)/converged:false no-apply; IPS init seed; zero→0 | §3.4 steps 3–7, §5.2 |
| Feasibility 4 | Mean-of-B mid-book + warm/unknown `min(B,25)` | §3.1 |
| Feasibility 5 | Trash freeze seed; constant = tests; `FitWeightOverridesOpts` | §2.3, §3.4 |
| Feasibility 6 | §3 MC-first; chaos cap 50; grid optional | §3.6 |
| Feasibility 7 | D=50/200; cancel; async/chunked; EV p05–p95 whiteEV | §3.7 |
| Feasibility 8 | `sampleCraftPath` Reforge MDP 1/3 ≠ sim redraw; approx badge | §3.6 Reforge |
| Feasibility 9 | `sampleCraftPath` spend init + NaN→N/A | §3.6 sampleCraftPath I/O |
| Final freeze | `sideTrials` α_trash; mixture IPS-only; Goal 5 wording | §2.2, §1.5, §3.7, App C |
| Minors | unknown regime, auto survey stays, clipboard-first, Simulate≠1a, stop writing patience key | §3.1, §3.8, §2.4–2.5, §5.1, §9 table |
