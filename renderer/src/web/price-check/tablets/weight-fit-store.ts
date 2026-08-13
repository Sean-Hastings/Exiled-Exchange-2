import { shallowRef } from "vue";
import type { FittedWeightSnapshot, TrashWeightMode } from "./roll-seen-types";
import { clearChaosTransitionCache } from "./tablet-mdp";
import { TABLET_BASES } from "./mod-weights";

const FIT_STORAGE_KEY = "ee2-tablet-weight-fit-v1";

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Validate shape + finite weights before trusting persisted / applied fits. */
export function sanitizeFittedSnapshot(
  raw: unknown,
): FittedWeightSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.baseId !== "string" || !TABLET_BASES[s.baseId]) return null;
  if (!isFiniteNumber(s.fittedAt)) return null;
  if (typeof s.converged !== "boolean") return null;
  if (s.trashMode !== "seed" && s.trashMode !== "constant") return null;
  if (!isFiniteNumber(s.iterations) || s.iterations < 0) return null;
  if (!isFiniteNumber(s.maxAbsErr)) return null;
  if (!isFiniteNumber(s.maxRelErr)) return null;
  if (!s.weightOverrides || typeof s.weightOverrides !== "object") return null;
  if (!Array.isArray(s.posteriors)) return null;

  const weightOverrides: Record<string, number> = {};
  for (const [k, v] of Object.entries(
    s.weightOverrides as Record<string, unknown>,
  )) {
    if (typeof k !== "string" || !k) return null;
    if (!isFiniteNumber(v) || v < 0) return null;
    weightOverrides[k] = v;
  }

  // Do not trust converged:true with non-object / empty garbage inconsistently —
  // converged false is fine with empty overrides; converged true may have {}.
  const trashMode = s.trashMode as TrashWeightMode;
  const snap: FittedWeightSnapshot = {
    baseId: s.baseId,
    fittedAt: s.fittedAt,
    weightOverrides,
    trashMode,
    maxAbsErr: s.maxAbsErr,
    maxRelErr: s.maxRelErr,
    converged: s.converged,
    iterations: s.iterations,
    posteriors: s.posteriors as FittedWeightSnapshot["posteriors"],
  };
  if (s.trashWeight === null || isFiniteNumber(s.trashWeight)) {
    snap.trashWeight = s.trashWeight as number | null | undefined;
  }
  if (typeof s.failureReason === "string") {
    snap.failureReason = s.failureReason;
  }
  return snap;
}

function loadFits(): FittedWeightSnapshot[] {
  try {
    const raw = localStorage.getItem(FIT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeFittedSnapshot)
      .filter((s): s is FittedWeightSnapshot => s != null);
  } catch {
    return [];
  }
}

function saveFits(fits: FittedWeightSnapshot[]) {
  try {
    localStorage.setItem(FIT_STORAGE_KEY, JSON.stringify(fits));
  } catch {
    /* ignore */
  }
}

/** Last fitted snapshots per base (derived; raw roll log is source of truth). */
export const tabletWeightFits = shallowRef<FittedWeightSnapshot[]>(loadFits());

/**
 * Runtime overrides applied to EV/MDP when Apply Fit is on and converged.
 * null ⇒ committed/seed weights only.
 */
export const tabletRuntimeWeightOverrides = shallowRef<Record<
  string,
  Record<string, number>
> | null>(null);

export function upsertWeightFit(snap: FittedWeightSnapshot) {
  const clean = sanitizeFittedSnapshot(snap);
  if (!clean) return;
  const next = tabletWeightFits.value.filter((f) => f.baseId !== clean.baseId);
  next.push(clean);
  tabletWeightFits.value = next;
  saveFits(next);
}

export function getWeightFitForBase(
  baseId: string,
): FittedWeightSnapshot | null {
  return tabletWeightFits.value.find((f) => f.baseId === baseId) ?? null;
}

/** Apply converged runtime overrides for a base (what-if, not mod-weights.ts). */
export function applyRuntimeWeightFit(baseId: string): boolean {
  const snap = getWeightFitForBase(baseId);
  if (!snap?.converged) return false;
  const clean = sanitizeFittedSnapshot(snap);
  if (!clean?.converged) return false;
  // Re-check finite weights before apply
  for (const v of Object.values(clean.weightOverrides)) {
    if (!Number.isFinite(v) || v < 0) return false;
  }
  const cur = { ...(tabletRuntimeWeightOverrides.value ?? {}) };
  cur[baseId] = { ...clean.weightOverrides };
  tabletRuntimeWeightOverrides.value = cur;
  clearChaosTransitionCache();
  return true;
}

export function clearRuntimeWeightFit(baseId?: string) {
  if (!baseId) {
    tabletRuntimeWeightOverrides.value = null;
  } else {
    const cur = { ...(tabletRuntimeWeightOverrides.value ?? {}) };
    delete cur[baseId];
    tabletRuntimeWeightOverrides.value =
      Object.keys(cur).length ? cur : null;
  }
  clearChaosTransitionCache();
}

export function runtimeOverridesForBase(
  baseId: string,
): Record<string, number> | undefined {
  return tabletRuntimeWeightOverrides.value?.[baseId];
}
