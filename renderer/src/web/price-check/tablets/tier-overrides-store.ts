import type { RareTier } from "./mod-tiers";
import { hydrateSessionModTiers } from "./mod-tiers";
import type { ModQualityTier } from "./strat-types";
import type { ComboTierOverrideEntry } from "./combo-tier-overrides";
import { hydrateComboTierFromDoc } from "./combo-tier-overrides";

const STORAGE_KEY = "ee2-tablet-tier-overrides-v1";

export const TIER_OVERRIDES_REVISION = 1;

const MOD_QUALITY_TIERS: readonly ModQualityTier[] = [
  "S",
  "A",
  "B",
  "Junk",
];
const RARE_TIERS: readonly RareTier[] = ["SS", "S", "A", "B", "Trash"];

export interface TabletTierOverridesDocument {
  revision: number;
  updatedAt: number;
  modTiersByBase: Record<string, Record<string, ModQualityTier>>;
  comboByBase: Record<string, Record<string, ComboTierOverrideEntry>>;
}

/** Optional repo mirror (installed by tablet-tier-overrides-host-bridge). */
let repoPersist: ((doc: TabletTierOverridesDocument) => void) | null = null;

export function setTierOverridesRepoPersist(
  fn: ((doc: TabletTierOverridesDocument) => void) | null,
): void {
  repoPersist = fn;
}

export function emptyTierOverridesDocument(): TabletTierOverridesDocument {
  return {
    revision: TIER_OVERRIDES_REVISION,
    updatedAt: 0,
    modTiersByBase: {},
    comboByBase: {},
  };
}

function isModQualityTier(v: unknown): v is ModQualityTier {
  return (
    typeof v === "string" &&
    (MOD_QUALITY_TIERS as readonly string[]).includes(v)
  );
}

function isRareTier(v: unknown): v is RareTier {
  return typeof v === "string" && (RARE_TIERS as readonly string[]).includes(v);
}

function sanitizeComboEntry(
  comboKey: string,
  baseId: string,
  raw: unknown,
): ComboTierOverrideEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (!isRareTier(rec.tier)) return null;
  if (!Array.isArray(rec.modIds)) return null;
  const modIds = rec.modIds.filter((id): id is string => typeof id === "string");
  if (!modIds.length) return null;
  return {
    comboKey: typeof rec.comboKey === "string" ? rec.comboKey : comboKey,
    baseId: typeof rec.baseId === "string" ? rec.baseId : baseId,
    modIds,
    tier: rec.tier,
    isCustom: !!rec.isCustom,
    updatedAt:
      typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt)
        ? rec.updatedAt
        : Date.now(),
  };
}

/** Drop corrupt entries; keep only schema-shaped docs. */
export function sanitizeTierOverridesDocument(
  raw: unknown,
): TabletTierOverridesDocument {
  if (!raw || typeof raw !== "object") return emptyTierOverridesDocument();
  const doc = raw as Record<string, unknown>;
  if (doc.revision !== TIER_OVERRIDES_REVISION) {
    return emptyTierOverridesDocument();
  }

  const modTiersByBase: Record<string, Record<string, ModQualityTier>> = {};
  const rawMods = doc.modTiersByBase;
  if (rawMods && typeof rawMods === "object") {
    for (const [baseId, map] of Object.entries(
      rawMods as Record<string, unknown>,
    )) {
      if (!baseId || !map || typeof map !== "object") continue;
      const cleaned: Record<string, ModQualityTier> = {};
      for (const [modId, tier] of Object.entries(
        map as Record<string, unknown>,
      )) {
        if (!modId || !isModQualityTier(tier)) continue;
        cleaned[modId] = tier;
      }
      if (Object.keys(cleaned).length) modTiersByBase[baseId] = cleaned;
    }
  }

  const comboByBase: Record<string, Record<string, ComboTierOverrideEntry>> =
    {};
  const rawCombos = doc.comboByBase;
  if (rawCombos && typeof rawCombos === "object") {
    for (const [baseId, map] of Object.entries(
      rawCombos as Record<string, unknown>,
    )) {
      if (!baseId || !map || typeof map !== "object") continue;
      const cleaned: Record<string, ComboTierOverrideEntry> = {};
      for (const [comboKey, entry] of Object.entries(
        map as Record<string, unknown>,
      )) {
        const sanitized = sanitizeComboEntry(comboKey, baseId, entry);
        if (sanitized) cleaned[comboKey] = sanitized;
      }
      if (Object.keys(cleaned).length) comboByBase[baseId] = cleaned;
    }
  }

  return {
    revision: TIER_OVERRIDES_REVISION,
    updatedAt:
      typeof doc.updatedAt === "number" && Number.isFinite(doc.updatedAt)
        ? doc.updatedAt
        : 0,
    modTiersByBase,
    comboByBase,
  };
}

function writeLocalCache(
  doc: TabletTierOverridesDocument,
): TabletTierOverridesDocument {
  const trimmed: TabletTierOverridesDocument = {
    ...doc,
    revision: TIER_OVERRIDES_REVISION,
    updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore quota / private mode */
  }
  return trimmed;
}

export function loadTierOverrides(): TabletTierOverridesDocument {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyTierOverridesDocument();
    return sanitizeTierOverridesDocument(JSON.parse(raw));
  } catch {
    return emptyTierOverridesDocument();
  }
}

function applyTierOverridesInMemory(doc: TabletTierOverridesDocument): void {
  hydrateSessionModTiers(doc.modTiersByBase);
  hydrateComboTierFromDoc(doc.comboByBase);
}

/**
 * Persist to localStorage + optional repo POST (Apply path).
 * Also hydrates in-memory session / combo stores from the committed doc.
 */
export function commitTierOverrides(
  doc: TabletTierOverridesDocument,
): TabletTierOverridesDocument {
  const sanitized = sanitizeTierOverridesDocument({
    ...doc,
    updatedAt: Date.now(),
  });
  const trimmed = writeLocalCache(sanitized);
  applyTierOverridesInMemory(trimmed);
  repoPersist?.(trimmed);
  return trimmed;
}

/**
 * Mirror a repo-loaded document into localStorage + session/combo RAM
 * (no re-push). Used when hydrating: repo file is source of truth on load.
 */
export function applyTierOverridesFromRepo(
  raw: unknown,
): TabletTierOverridesDocument {
  const sanitized = sanitizeTierOverridesDocument(raw);
  const trimmed = writeLocalCache(sanitized);
  applyTierOverridesInMemory(trimmed);
  return trimmed;
}

/** Apply local cache into session/combo (offline / before repo hydrate). */
export function hydrateTierOverridesFromLocalCache(): TabletTierOverridesDocument {
  const doc = loadTierOverrides();
  applyTierOverridesInMemory(doc);
  return doc;
}

/** Test isolation. */
export function resetTierOverridesForTests(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  hydrateSessionModTiers({});
  hydrateComboTierFromDoc({});
}
