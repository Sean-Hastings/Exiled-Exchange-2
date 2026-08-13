import { TABLET_BASES } from "./mod-weights";
import type { AffixSide, ModHitObservation } from "./roll-seen-types";
import {
  ROLL_SEEN_REVISION,
  type RawSeenAggregate,
  type RawSeenCell,
  type RollSeenBatch,
  type RollSeenDocument,
  type SidePoolTrials,
} from "./roll-seen-types";

const STORAGE_KEY = "ee2-tablet-roll-seen-v1";
const MAX_BATCHES = 200;

/** Optional repo mirror (installed by tablet-roll-seen-host-bridge). */
let repoPersist: ((doc: RollSeenDocument) => void) | null = null;

export function setRollSeenRepoPersist(
  fn: ((doc: RollSeenDocument) => void) | null,
): void {
  repoPersist = fn;
}

function writeLocalCache(doc: RollSeenDocument): RollSeenDocument {
  const trimmed: RollSeenDocument = {
    ...doc,
    updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : Date.now(),
    batches: doc.batches.slice(-MAX_BATCHES),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore quota / private mode */
  }
  return trimmed;
}

export class SideAttributionError extends Error {
  readonly modId: string;
  constructor(modId: string, reason: "neither" | "both") {
    super(
      reason === "both"
        ? `Mod ${modId} is in both prefix and suffix pools`
        : `Mod ${modId} is in neither prefix nor suffix pool`,
    );
    this.name = "SideAttributionError";
    this.modId = modId;
  }
}

/** Derive affix side from TABLET_BASES pools; reject neither/both. */
export function attributeModSide(
  baseId: string,
  modId: string,
): AffixSide {
  const base = TABLET_BASES[baseId];
  if (!base) {
    throw new SideAttributionError(modId, "neither");
  }
  const inP = base.allowedPrefixPool.includes(modId);
  const inS = base.allowedSuffixPool.includes(modId);
  if (inP && inS) throw new SideAttributionError(modId, "both");
  if (inP) return "prefix";
  if (inS) return "suffix";
  throw new SideAttributionError(modId, "neither");
}

export function batchSideTrials(batch: RollSeenBatch): {
  prefixTrials: number;
  suffixTrials: number;
  totalTrials: number;
} {
  const total =
    batch.prefixTrials != null && batch.suffixTrials != null
      ? batch.prefixTrials + batch.suffixTrials
      : batch.affixesPerTablet * batch.tablets;
  const prefixTrials =
    batch.prefixTrials != null
      ? batch.prefixTrials
      : Math.floor(total / 2);
  const suffixTrials =
    batch.suffixTrials != null
      ? batch.suffixTrials
      : total - prefixTrials;
  return { prefixTrials, suffixTrials, totalTrials: total };
}

function emptyDoc(): RollSeenDocument {
  return {
    revision: ROLL_SEEN_REVISION,
    updatedAt: Date.now(),
    batches: [],
  };
}

function isFiniteNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && Number.isInteger(n);
}

function sanitizeHit(h: unknown): ModHitObservation | null {
  if (!h || typeof h !== "object") return null;
  const rec = h as Record<string, unknown>;
  if (typeof rec.modId !== "string" || !rec.modId) return null;
  if (rec.hits === null || rec.hits === undefined) {
    return { modId: rec.modId, hits: null };
  }
  if (typeof rec.hits !== "number" || !Number.isFinite(rec.hits) || rec.hits < 0) {
    return null;
  }
  return { modId: rec.modId, hits: Math.floor(rec.hits) };
}

/** Drop corrupt batches; keep only schema-shaped entries. */
export function sanitizeRollSeenDocument(raw: unknown): RollSeenDocument {
  if (!raw || typeof raw !== "object") return emptyDoc();
  const doc = raw as Record<string, unknown>;
  if (doc.revision !== ROLL_SEEN_REVISION) return emptyDoc();
  if (!Array.isArray(doc.batches)) return emptyDoc();

  const batches: RollSeenBatch[] = [];
  for (const b of doc.batches) {
    if (!b || typeof b !== "object") continue;
    const rec = b as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id) continue;
    if (typeof rec.baseId !== "string" || !TABLET_BASES[rec.baseId]) continue;
    if (!isFiniteNonNegInt(rec.affixesPerTablet) || rec.affixesPerTablet < 1) {
      continue;
    }
    if (!isFiniteNonNegInt(rec.tablets) || rec.tablets < 1) continue;
    if (typeof rec.createdAt !== "number" || !Number.isFinite(rec.createdAt)) {
      continue;
    }
    if (typeof rec.updatedAt !== "number" || !Number.isFinite(rec.updatedAt)) {
      continue;
    }
    if (!Array.isArray(rec.hits)) continue;

    const hits: ModHitObservation[] = [];
    for (const h of rec.hits) {
      const cleaned = sanitizeHit(h);
      if (cleaned) hits.push(cleaned);
    }

    const batch: RollSeenBatch = {
      id: rec.id,
      baseId: rec.baseId,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      affixesPerTablet: rec.affixesPerTablet,
      tablets: rec.tablets,
      hits,
    };
    if (typeof rec.leagueId === "string") batch.leagueId = rec.leagueId;
    if (typeof rec.note === "string") batch.note = rec.note;
    if (isFiniteNonNegInt(rec.prefixTrials)) batch.prefixTrials = rec.prefixTrials;
    if (isFiniteNonNegInt(rec.suffixTrials)) batch.suffixTrials = rec.suffixTrials;
    batches.push(batch);
  }

  return {
    revision: ROLL_SEEN_REVISION,
    updatedAt:
      typeof doc.updatedAt === "number" && Number.isFinite(doc.updatedAt)
        ? doc.updatedAt
        : Date.now(),
    batches,
  };
}

export function loadRollSeen(): RollSeenDocument {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyDoc();
    return sanitizeRollSeenDocument(JSON.parse(raw));
  } catch {
    return emptyDoc();
  }
}

export function saveRollSeen(doc: RollSeenDocument): void {
  const trimmed = writeLocalCache({
    ...doc,
    updatedAt: Date.now(),
  });
  repoPersist?.(trimmed);
}

/**
 * Mirror a repo-loaded document into localStorage only (no re-push).
 * Used when hydrating: repo file is source of truth on load.
 */
export function applyRollSeenFromRepo(raw: unknown): RollSeenDocument {
  return writeLocalCache(sanitizeRollSeenDocument(raw));
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `rs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Validate sparse hits (side attribution) before persist. */
export function validateBatchHits(
  baseId: string,
  hits: ModHitObservation[],
): void {
  for (const h of hits) {
    attributeModSide(baseId, h.modId);
  }
}

export function upsertBatch(
  doc: RollSeenDocument,
  batch: Omit<RollSeenBatch, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
  },
): RollSeenDocument {
  validateBatchHits(batch.baseId, batch.hits);
  const now = Date.now();
  const existingIdx = batch.id
    ? doc.batches.findIndex((b) => b.id === batch.id)
    : -1;
  const next: RollSeenBatch = {
    id: batch.id ?? (existingIdx >= 0 ? doc.batches[existingIdx]!.id : newId()),
    baseId: batch.baseId,
    createdAt:
      existingIdx >= 0 ? doc.batches[existingIdx]!.createdAt : now,
    updatedAt: now,
    leagueId: batch.leagueId,
    note: batch.note,
    affixesPerTablet: batch.affixesPerTablet,
    tablets: batch.tablets,
    prefixTrials: batch.prefixTrials,
    suffixTrials: batch.suffixTrials,
    hits: batch.hits.map((h) => ({
      modId: h.modId,
      hits: h.hits,
    })),
  };
  const batches = [...doc.batches];
  if (existingIdx >= 0) batches[existingIdx] = next;
  else batches.push(next);
  const out: RollSeenDocument = {
    revision: ROLL_SEEN_REVISION,
    updatedAt: now,
    batches,
  };
  saveRollSeen(out);
  return out;
}

export function deleteBatch(
  doc: RollSeenDocument,
  batchId: string,
): RollSeenDocument {
  const out: RollSeenDocument = {
    revision: ROLL_SEEN_REVISION,
    updatedAt: Date.now(),
    batches: doc.batches.filter((b) => b.id !== batchId),
  };
  saveRollSeen(out);
  return out;
}

/**
 * Aggregate raw cells + sideTrials.
 * Empty/null hits skipped; explicit 0 included; bad observations skipped (warn).
 * Never throws on corrupt persisted mods.
 */
export function aggregateRawSeen(doc: RollSeenDocument): RawSeenAggregate {
  const cellMap = new Map<string, RawSeenCell>();
  const sideMap = new Map<string, SidePoolTrials>();

  const bumpSide = (baseId: string, side: AffixSide, n: number) => {
    const key = `${baseId}|${side}`;
    const cur = sideMap.get(key);
    if (cur) cur.sideTrials += n;
    else sideMap.set(key, { baseId, side, sideTrials: n });
  };

  for (const batch of doc.batches) {
    if (!TABLET_BASES[batch.baseId]) {
      console.warn("[roll-seen] skip batch unknown baseId", batch.baseId);
      continue;
    }
    const { prefixTrials, suffixTrials } = batchSideTrials(batch);
    bumpSide(batch.baseId, "prefix", prefixTrials);
    bumpSide(batch.baseId, "suffix", suffixTrials);

    for (const obs of batch.hits) {
      if (obs.hits == null) continue;
      let side: AffixSide;
      try {
        side = attributeModSide(batch.baseId, obs.modId);
      } catch (err) {
        console.warn(
          "[roll-seen] skip bad observation",
          batch.baseId,
          obs.modId,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      const sideTrials = side === "prefix" ? prefixTrials : suffixTrials;
      const key = `${batch.baseId}|${side}|${obs.modId}`;
      const cur = cellMap.get(key);
      if (cur) {
        cur.hits += obs.hits;
        cur.trials += sideTrials;
        cur.batchCount += 1;
      } else {
        cellMap.set(key, {
          baseId: batch.baseId,
          side,
          modId: obs.modId,
          hits: obs.hits,
          trials: sideTrials,
          batchCount: 1,
        });
      }
    }
  }

  return {
    revision: ROLL_SEEN_REVISION,
    updatedAt: doc.updatedAt,
    cells: [...cellMap.values()],
    sideTrials: [...sideMap.values()],
  };
}
