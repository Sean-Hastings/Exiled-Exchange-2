export type TabletCategory =
  | "Breach"
  | "Delirium"
  | "Expedition"
  | "Ritual"
  | "Boss"
  | "Abyss"
  | "Irradiated"
  | "Temple";

export interface TabletModDefinition {
  id: string;
  name: string;
  /** Substring / regex source matched against clipboard mod lines */
  statPattern: RegExp;
  /** Canonical `stat.ref` from stats.ndjson when available */
  statRef?: string;
  tradeStatId: string;
  tier: number;
  weight: number;
  minValue: number;
  maxValue: number;
  isPrefix: boolean;
  category: TabletCategory;
  /** Relative market desirability for EV / regex prioritization (higher = better) */
  valueScore: number;
  /** Short stash-tab search fragment (<= ~8 chars preferred) */
  regexHint: string;
}

export interface TabletBaseDefinition {
  id: string;
  name: string;
  /** Alternate clipboard names (legacy "Precursor" naming, etc.) */
  aliases: string[];
  category: TabletCategory;
  tag: string;
  allowedPrefixPool: string[];
  allowedSuffixPool: string[];
  maxAffixes: number;
}

export interface ParsedTabletMod {
  id: string;
  rawText: string;
  rolledValue: number;
  tier?: number;
  isPrefix: boolean;
  valueScore: number;
}

export interface ParsedTabletItem {
  isTablet: true;
  tabletBaseKey: string;
  category: TabletCategory;
  baseName: string;
  rarity?: string;
  isCorrupted: boolean;
  parsedMods: ParsedTabletMod[];
  usesRemaining?: number;
}