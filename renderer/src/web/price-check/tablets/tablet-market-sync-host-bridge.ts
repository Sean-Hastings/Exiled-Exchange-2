import { Host } from "../../background/IPC";
import { useLeagues } from "../../background/Leagues";
import { ensureTabletMarketSynced } from "./tablet-market-store";

/**
 * Main HTTP server asks for a full market refresh when it starts and when a
 * client websocket connects. Trade cookies live in the renderer, so the work
 * still runs here — the trigger is server-side, not Vue mount.
 */
export function installTabletMarketSyncHostBridge() {
  Host.onEvent("MAIN->CLIENT::tablet-market-sync", () => {
    void (async () => {
      const leagues = useLeagues();
      if (!leagues.list.value.length) {
        await leagues.load();
      }
      await ensureTabletMarketSynced(true);
    })();
  });
}
