import {
  applyRollSeenFromRepo,
  loadRollSeen,
  sanitizeRollSeenDocument,
  setRollSeenRepoPersist,
} from "./roll-seen-store";
import type { RollSeenDocument } from "./roll-seen-types";

const API = "/api/tablet-roll-seen";

export type RollSeenSyncStatus =
  | "idle"
  | "loading"
  | "synced"
  | "bootstrapped"
  | "local-only"
  | "saving"
  | "error";

export type RollSeenSyncState = {
  status: RollSeenSyncStatus;
  path: string | null;
  error: string | null;
  lastSavedAt: number | null;
};

let syncState: RollSeenSyncState = {
  status: "idle",
  path: null,
  error: null,
  lastSavedAt: null,
};

const listeners = new Set<(s: RollSeenSyncState) => void>();

function setSyncState(patch: Partial<RollSeenSyncState>) {
  syncState = { ...syncState, ...patch };
  for (const l of listeners) l(syncState);
}

export function getRollSeenSyncState(): RollSeenSyncState {
  return syncState;
}

export function onRollSeenSyncState(
  cb: (s: RollSeenSyncState) => void,
): () => void {
  listeners.add(cb);
  cb(syncState);
  return () => {
    listeners.delete(cb);
  };
}

type GetResponse = {
  ok?: boolean;
  path?: string;
  exists?: boolean;
  doc?: unknown;
  error?: string;
};

type PostResponse = {
  ok?: boolean;
  path?: string;
  error?: string;
};

export async function pushRollSeenToRepo(
  doc: RollSeenDocument,
): Promise<{ ok: boolean; path: string | null; error?: string }> {
  setSyncState({ status: "saving", error: null });
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc }),
    });
    const body = (await res.json()) as PostResponse;
    if (!res.ok || !body.ok) {
      const err = body.error ?? `HTTP ${res.status}`;
      setSyncState({ status: "error", error: err });
      return { ok: false, path: body.path ?? syncState.path, error: err };
    }
    setSyncState({
      status: "synced",
      path: body.path ?? syncState.path,
      error: null,
      lastSavedAt: Date.now(),
    });
    return { ok: true, path: body.path ?? null };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    setSyncState({ status: "error", error: err });
    return { ok: false, path: syncState.path, error: err };
  }
}

/**
 * Repo file is source of truth on load (mirrored into localStorage as cache).
 * Bootstrap: if repo is empty/missing but localStorage has batches, push local → repo.
 */
export async function hydrateRollSeenFromRepo(): Promise<RollSeenDocument> {
  setSyncState({ status: "loading", error: null });
  try {
    const localBefore = loadRollSeen();
    const res = await fetch(API);
    if (!res.ok) {
      setSyncState({
        status: "local-only",
        error: `HTTP ${res.status}`,
      });
      return localBefore;
    }
    const body = (await res.json()) as GetResponse;
    const path = body.path ?? null;
    const repoSanitized = sanitizeRollSeenDocument(body.doc ?? null);

    // Migration: empty/missing repo + existing local batches → push local once.
    if (
      (!body.exists || repoSanitized.batches.length === 0) &&
      localBefore.batches.length > 0
    ) {
      const pushed = await pushRollSeenToRepo(localBefore);
      setSyncState({
        status: pushed.ok ? "bootstrapped" : "error",
        path: pushed.path ?? path,
        error: pushed.error ?? null,
        lastSavedAt: pushed.ok ? Date.now() : syncState.lastSavedAt,
      });
      return localBefore;
    }

    const mirrored = applyRollSeenFromRepo(repoSanitized);
    setSyncState({
      status: "synced",
      path,
      error: null,
    });
    return mirrored;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    setSyncState({ status: "local-only", error: err });
    return loadRollSeen();
  }
}

/** Wire auto-save: every successful local persist also POSTs to the repo file. */
export function installTabletRollSeenRepoSync() {
  setRollSeenRepoPersist((doc) => {
    void pushRollSeenToRepo(doc);
  });
  return hydrateRollSeenFromRepo();
}
