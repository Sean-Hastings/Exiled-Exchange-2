import {
  applyTierOverridesFromRepo,
  loadTierOverrides,
  sanitizeTierOverridesDocument,
  setTierOverridesRepoPersist,
} from "./tier-overrides-store";
import type { TabletTierOverridesDocument } from "./tier-overrides-store";

const API = "/api/tablet-tier-overrides";

export type TierOverridesSyncStatus =
  | "idle"
  | "loading"
  | "synced"
  | "bootstrapped"
  | "local-only"
  | "saving"
  | "error";

export type TierOverridesSyncState = {
  status: TierOverridesSyncStatus;
  path: string | null;
  error: string | null;
  lastSavedAt: number | null;
};

let syncState: TierOverridesSyncState = {
  status: "idle",
  path: null,
  error: null,
  lastSavedAt: null,
};

const listeners = new Set<(s: TierOverridesSyncState) => void>();

function setSyncState(patch: Partial<TierOverridesSyncState>) {
  syncState = { ...syncState, ...patch };
  for (const l of listeners) l(syncState);
}

export function getTierOverridesSyncState(): TierOverridesSyncState {
  return syncState;
}

export function onTierOverridesSyncState(
  cb: (s: TierOverridesSyncState) => void,
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

function docHasContent(doc: TabletTierOverridesDocument): boolean {
  return (
    Object.keys(doc.modTiersByBase).length > 0 ||
    Object.keys(doc.comboByBase).length > 0
  );
}

export async function pushTierOverridesToRepo(
  doc: TabletTierOverridesDocument,
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
 * Bootstrap: if repo is empty/missing but localStorage has content, push local → repo.
 */
export async function hydrateTierOverridesFromRepo(): Promise<TabletTierOverridesDocument> {
  setSyncState({ status: "loading", error: null });
  try {
    const localBefore = loadTierOverrides();
    const res = await fetch(API);
    if (!res.ok) {
      setSyncState({
        status: "local-only",
        error: `HTTP ${res.status}`,
      });
      return applyTierOverridesFromRepo(localBefore);
    }
    const body = (await res.json()) as GetResponse;
    const path = body.path ?? null;
    const repoSanitized = sanitizeTierOverridesDocument(body.doc ?? null);

    if (
      (!body.exists || !docHasContent(repoSanitized)) &&
      docHasContent(localBefore)
    ) {
      const pushed = await pushTierOverridesToRepo(localBefore);
      applyTierOverridesFromRepo(localBefore);
      setSyncState({
        status: pushed.ok ? "bootstrapped" : "error",
        path: pushed.path ?? path,
        error: pushed.error ?? null,
        lastSavedAt: pushed.ok ? Date.now() : syncState.lastSavedAt,
      });
      return localBefore;
    }

    const mirrored = applyTierOverridesFromRepo(repoSanitized);
    setSyncState({
      status: "synced",
      path,
      error: null,
    });
    return mirrored;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    setSyncState({ status: "local-only", error: err });
    return applyTierOverridesFromRepo(loadTierOverrides());
  }
}

/** Wire Apply-path save: commitTierOverrides POSTs to the repo file. */
export function installTabletTierOverridesRepoSync() {
  setTierOverridesRepoPersist((doc) => {
    void pushTierOverridesToRepo(doc);
  });
  return hydrateTierOverridesFromRepo();
}
