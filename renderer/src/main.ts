import { createApp, watch } from "vue";
import App from "./web/App.vue";
import * as I18n from "./web/i18n";
import * as Data from "./assets/data";
import { initConfig, AppConfig } from "./web/Config";
import { Host } from "./web/background/IPC";
import { installTabletTierSurveyHostBridge } from "./web/price-check/tablets/tablet-survey-host-bridge";
import { installTabletRollSeenRepoSync } from "./web/price-check/tablets/tablet-roll-seen-host-bridge";
import { installTabletTierOverridesRepoSync } from "./web/price-check/tablets/tablet-tier-overrides-host-bridge";
import { installTabletMarketSyncHostBridge } from "./web/price-check/tablets/tablet-market-sync-host-bridge";
(async function () {
  await initConfig();
  const i18nPlugin = await I18n.init(AppConfig().language);
  await Data.init(AppConfig().language);
  // Listener must be registered before the websocket opens or the server-start
  // sync event is dropped.
  installTabletMarketSyncHostBridge();
  await Host.init();
  installTabletTierSurveyHostBridge();
  void installTabletRollSeenRepoSync();
  void installTabletTierOverridesRepoSync();

  watch(
    () => AppConfig().language,
    async () => {
      await Data.loadForLang(AppConfig().language);
      await I18n.loadLang(AppConfig().language);
    },
  );

  const app = createApp(App);
  app.use(i18nPlugin);
  app.mount("#app");
  if (import.meta.env.DEV) {
    app.config.performance = true;
    console.error("DEV MODE");
  }
})();
