import { computed, shallowRef, readonly } from "vue";
import { createGlobalState } from "@vueuse/core";
import { AppConfig, poeWebApi } from "@/web/Config";
import { Host } from "./IPC";

// pc-ggg, pc-garena
// const PERMANENT_SC = ['Standard', '標準模式']
// const PERMANENT_HC = ["Hardcore", "專家模式"];

interface TradeLeague {
  id: string;
  text: string;
}

interface League {
  id: string;
  isPopular: boolean;
  text: string;
}

const PERMANENT_LEAGUE =
  /^(Standard|Hardcore|標準模式|專家模式)$/i;
const HARDCORE_LEAGUE = /^(HC\s|Hardcore|專家)/i;

/** Current temporary softcore challenge (e.g. "Runes of Aldur"), not Standard/HC. */
export function pickSoftcoreChallengeLeague(
  list: readonly { id: string }[],
): string | undefined {
  const scChallenge = list.find(
    (l) => !PERMANENT_LEAGUE.test(l.id) && !HARDCORE_LEAGUE.test(l.id),
  );
  if (scChallenge) return scChallenge.id;
  const soft = list.find((l) => !HARDCORE_LEAGUE.test(l.id));
  return soft?.id ?? list[0]?.id;
}

export const useLeagues = createGlobalState(() => {
  const isLoading = shallowRef(false);
  const error = shallowRef<string | null>(null);
  const tradeLeagues = shallowRef<League[]>([]);

  const selectedId = computed<string | undefined>({
    get() {
      return tradeLeagues.value.length ? AppConfig().leagueId : undefined;
    },
    set(id) {
      AppConfig().leagueId = id;
    },
  });

  const selected = computed(() => {
    const { leagueId } = AppConfig();
    if (!tradeLeagues.value || !leagueId) return undefined;
    const listed = tradeLeagues.value.find((league) => league.id === leagueId);
    return {
      id: leagueId,
      realm: AppConfig().realm,
      isPopular: !isPrivateLeague(leagueId) && Boolean(listed?.isPopular),
    };
  });

  async function load() {
    isLoading.value = true;
    error.value = null;

    try {
      // TODO: swap back to /api/leagues?realm=poe2 when available (allows detection of Hardcore leagues)
      const response = await Host.proxy(
        `${poeWebApi()}/api/trade2/data/leagues`,
      );
      if (!response.ok)
        throw new Error(JSON.stringify(Object.fromEntries(response.headers)));
      const leagues: { result: TradeLeague[] } = await response.json();
      tradeLeagues.value = leagues.result.map((league) => {
        return { id: league.id, isPopular: true, text: league.text };
      });

      const leagueIsAlive = tradeLeagues.value.some(
        (league) => league.id === selectedId.value,
      );
      const scChallenge = pickSoftcoreChallengeLeague(tradeLeagues.value);
      // Prefer softcore challenge when unset, dead, or wrongly defaulted to Standard.
      // (Old bug: length>2 picked index 2 = Standard instead of challenge SC at 0.)
      const shouldPreferChallenge =
        !leagueIsAlive ||
        !selectedId.value ||
        (!isPrivateLeague(selectedId.value) &&
          PERMANENT_LEAGUE.test(selectedId.value) &&
          !!scChallenge &&
          selectedId.value !== scChallenge);

      if (shouldPreferChallenge && !isPrivateLeague(selectedId.value ?? "")) {
        if (scChallenge) {
          selectedId.value = scChallenge;
        } else if (tradeLeagues.value.length) {
          selectedId.value = tradeLeagues.value[0].id;
        }
      }
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      isLoading.value = false;
    }
  }

  return {
    isLoading,
    error,
    selectedId,
    selected,
    list: readonly(tradeLeagues),
    load,
  };
});

function isPrivateLeague(id: string) {
  if (id.includes("Ruthless")) {
    return true;
  }
  return /\(PL\d+\)$/.test(id);
}
