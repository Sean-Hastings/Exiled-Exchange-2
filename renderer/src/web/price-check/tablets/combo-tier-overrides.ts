import {
  modComboToRareTier,
  modQualityTierForBase,
  splitAffixSides,
  type RareTier,
} from "./mod-tiers";
import { TABLET_BASES } from "./mod-weights";

/** Revision-bumped on schema change. */
export const COMBO_TIER_OVERRIDE_REVISION = 1;

const STORAGE_KEY = "ee2-tablet-combo-tier-overrides-v1";

export interface ComboTierOverrideEntry {
  comboKey: string;
  baseId: string;
  modIds: string[];
  tier: RareTier;
  /** User-defined combo not in auto A/S/SS set. */
  isCustom?: boolean;
  updatedAt: number;
}

export interface ComboTierOverrideDocument {
  revision: number;
  byBase: Record<string, Record<string, ComboTierOverrideEntry>>;
}

/** Same-tab live edits (may shadow persisted until saved). */
const SESSION_COMBO_TIER: Record<
  string,
  Record<string, ComboTierOverrideEntry>
> = {};

let persistedDoc: ComboTierOverrideDocument | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Canonical combo key aligned with trade sync / measured sales.
 * 1p1s: `prefix+suffix`; solo: `__solo__:id`; multi: sorted ids joined with `+`.
 */
export function canonicalComboKey(baseId: string, modIds: string[]): string {
  if (!modIds.length) return "";
  if (modIds.length === 1) return `__solo__:${modIds[0]}`;

  const { prefixes, suffixes } = splitAffixSides(modIds);
  if (prefixes.length === 1 && suffixes.length === 1) {
    return `${prefixes[0]}+${suffixes[0]}`;
  }
  return [...modIds].sort().join("+");
}

export function validateComboMods(baseId: string, modIds: string[]): boolean {
  const base = TABLET_BASES[baseId];
  if (!base || !modIds.length || modIds.length > 4) return false;
  const pool = new Set([
    ...base.allowedPrefixPool,
    ...base.allowedSuffixPool,
  ]);
  if (!modIds.every((id) => pool.has(id))) return false;
  const { prefixes, suffixes } = splitAffixSides(modIds);
  return prefixes.length <= 2 && suffixes.length <= 2;
}

export function getComboTierOverride(
  baseId: string,
  comboKey: string,
): ComboTierOverrideEntry | undefined {
  const session = SESSION_COMBO_TIER[baseId]?.[comboKey];
  if (session) return session;
  return persistedDoc?.byBase[baseId]?.[comboKey];
}

export function hasSessionComboTier(
  baseId: string,
  comboKey: string,
): boolean {
  return !!SESSION_COMBO_TIER[baseId]?.[comboKey];
}

export function hasComboTierOverride(
  baseId: string,
  comboKey: string,
): boolean {
  return !!getComboTierOverride(baseId, comboKey);
}

export function getSessionComboTier(
  baseId: string,
  comboKey: string,
): RareTier | undefined {
  return SESSION_COMBO_TIER[baseId]?.[comboKey]?.tier;
}

export function rareTierForCombo(
  modIds: string[],
  baseId: string,
): { tier: RareTier; source: "override" | "auto" } {
  const comboKey = canonicalComboKey(baseId, modIds);
  const override = getComboTierOverride(baseId, comboKey);
  if (override) return { tier: override.tier, source: "override" };

  // Solo combo overrides (e.g. `__solo__:ritual_omen_t1→A`) only match the
  // exact solo key. Alchemy/MDP use multi-mod keys — promote when exactly one
  // mod has a solo override and every other affix is Junk/B filler.
  const soloHits: Array<{ modId: string; tier: RareTier }> = [];
  for (const modId of modIds) {
    const solo = getComboTierOverride(baseId, `__solo__:${modId}`);
    if (solo) soloHits.push({ modId, tier: solo.tier });
  }
  if (soloHits.length === 1) {
    const hit = soloHits[0]!;
    const othersAreFiller = modIds.every(
      (id) =>
        id === hit.modId ||
        modQualityTierForBase(baseId, id) === "Junk" ||
        modQualityTierForBase(baseId, id) === "B",
    );
    if (othersAreFiller) {
      return { tier: hit.tier, source: "override" };
    }
  }

  return { tier: modComboToRareTier(modIds, baseId), source: "auto" };
}

export function setSessionComboTier(
  baseId: string,
  modIds: string[],
  tier: RareTier | null,
  opts?: { isCustom?: boolean },
): void {
  const comboKey = canonicalComboKey(baseId, modIds);
  if (!comboKey) return;

  if (tier == null) {
    delete SESSION_COMBO_TIER[baseId]?.[comboKey];
    return;
  }

  const entry: ComboTierOverrideEntry = {
    comboKey,
    baseId,
    modIds: [...modIds],
    tier,
    isCustom: opts?.isCustom,
    updatedAt: Date.now(),
  };

  if (!SESSION_COMBO_TIER[baseId]) SESSION_COMBO_TIER[baseId] = {};
  SESSION_COMBO_TIER[baseId][comboKey] = entry;
  persistComboOverride(entry);
}

export function removeComboOverride(baseId: string, modIds: string[]): void {
  const comboKey = canonicalComboKey(baseId, modIds);
  if (!comboKey) return;
  delete SESSION_COMBO_TIER[baseId]?.[comboKey];
  removePersistedOverride(baseId, comboKey);
  scheduleSave();
}

export function clearSessionComboTiers(baseId?: string): void {
  if (baseId) delete SESSION_COMBO_TIER[baseId];
  else {
    for (const k of Object.keys(SESSION_COMBO_TIER)) {
      delete SESSION_COMBO_TIER[k];
    }
  }
}

function removePersistedOverride(baseId: string, comboKey: string): void {
  if (!persistedDoc?.byBase[baseId]) return;
  delete persistedDoc.byBase[baseId][comboKey];
  if (!Object.keys(persistedDoc.byBase[baseId]).length) {
    delete persistedDoc.byBase[baseId];
  }
}

export function persistComboOverride(entry: ComboTierOverrideEntry): void {
  if (!persistedDoc) {
    persistedDoc = {
      revision: COMBO_TIER_OVERRIDE_REVISION,
      byBase: {},
    };
  }
  if (!persistedDoc.byBase[entry.baseId]) {
    persistedDoc.byBase[entry.baseId] = {};
  }
  persistedDoc.byBase[entry.baseId][entry.comboKey] = entry;
  scheduleSave();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (persistedDoc) saveComboTierOverrides(persistedDoc);
  }, 300);
}

export function loadComboTierOverrides(): ComboTierOverrideDocument | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ComboTierOverrideDocument;
    if (parsed.revision !== COMBO_TIER_OVERRIDE_REVISION) return null;
    if (!parsed.byBase || typeof parsed.byBase !== "object") return null;
    persistedDoc = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function saveComboTierOverrides(doc: ComboTierOverrideDocument): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch {
    /* ignore quota */
  }
}

export function hydrateComboTierOverrides(): void {
  loadComboTierOverrides();
}

/** Merged session + persisted overrides for one base. */
export function comboTierOverridesForBase(
  baseId: string,
): ComboTierOverrideEntry[] {
  const map = new Map<string, ComboTierOverrideEntry>();
  for (const entry of Object.values(persistedDoc?.byBase[baseId] ?? {})) {
    map.set(entry.comboKey, entry);
  }
  for (const entry of Object.values(SESSION_COMBO_TIER[baseId] ?? {})) {
    map.set(entry.comboKey, entry);
  }
  return [...map.values()];
}

/**
 * Session merged into persisted — full byBase snapshot for repo Apply.
 * Does not mutate persistedDoc; callers write via tier-overrides-store.
 */
export function snapshotComboTierOverrides(): ComboTierOverrideDocument {
  const byBase: Record<string, Record<string, ComboTierOverrideEntry>> = {};
  const baseIds = new Set([
    ...Object.keys(persistedDoc?.byBase ?? {}),
    ...Object.keys(SESSION_COMBO_TIER),
  ]);
  for (const baseId of baseIds) {
    const merged: Record<string, ComboTierOverrideEntry> = {};
    for (const entry of comboTierOverridesForBase(baseId)) {
      merged[entry.comboKey] = { ...entry, modIds: [...entry.modIds] };
    }
    if (Object.keys(merged).length) byBase[baseId] = merged;
  }
  return {
    revision: COMBO_TIER_OVERRIDE_REVISION,
    byBase,
  };
}

/**
 * Load combo overrides from a repo document into persisted RAM + localStorage.
 * Session overlays for covered bases are cleared so persisted wins on read.
 */
export function hydrateComboTierFromDoc(
  byBase: Record<string, Record<string, ComboTierOverrideEntry>> | null | undefined,
): void {
  if (!byBase || typeof byBase !== "object") {
    persistedDoc = {
      revision: COMBO_TIER_OVERRIDE_REVISION,
      byBase: {},
    };
    saveComboTierOverrides(persistedDoc);
    return;
  }

  const next: ComboTierOverrideDocument = {
    revision: COMBO_TIER_OVERRIDE_REVISION,
    byBase: {},
  };
  for (const [baseId, map] of Object.entries(byBase)) {
    if (!baseId || !map || typeof map !== "object") continue;
    const cleaned: Record<string, ComboTierOverrideEntry> = {};
    for (const [comboKey, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.tier !== "string" || !Array.isArray(entry.modIds)) continue;
      cleaned[comboKey] = {
        comboKey: typeof entry.comboKey === "string" ? entry.comboKey : comboKey,
        baseId: typeof entry.baseId === "string" ? entry.baseId : baseId,
        modIds: entry.modIds.filter((id): id is string => typeof id === "string"),
        tier: entry.tier as ComboTierOverrideEntry["tier"],
        isCustom: entry.isCustom,
        updatedAt:
          typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
            ? entry.updatedAt
            : Date.now(),
      };
    }
    if (Object.keys(cleaned).length) next.byBase[baseId] = cleaned;
  }
  persistedDoc = next;
  saveComboTierOverrides(next);
  // Drop session shadows so getComboTierOverride reads hydrated persisted.
  for (const baseId of Object.keys(SESSION_COMBO_TIER)) {
    delete SESSION_COMBO_TIER[baseId];
  }
}

/** Test isolation — clears session, persisted RAM, and localStorage. */
export function resetComboTierOverridesForTests(): void {
  for (const k of Object.keys(SESSION_COMBO_TIER)) delete SESSION_COMBO_TIER[k];
  persistedDoc = null;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

hydrateComboTierOverrides();
