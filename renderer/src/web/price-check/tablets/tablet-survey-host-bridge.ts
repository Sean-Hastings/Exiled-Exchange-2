import { watch } from "vue";
import { Host } from "../../background/IPC";
import {
  cancelBreachTierSurvey,
  ensureBreachTierSurvey,
  tabletTierSurvey,
  tabletTierSurveyDetail,
} from "./tablet-market-store";
import type { TierSurveyDocument } from "./tier-survey-types";

/**
 * Responds to MAIN->CLIENT::tablet-tier-survey so localhost REST / CLI can
 * drive Breach tier surveys with Electron trade cookies.
 */
export function installTabletTierSurveyHostBridge() {
  let activeRequestId: string | null = null;

  const emit = (
    requestId: string,
    status: "running" | "complete" | "error" | "cancelled" | "paused",
    detail?: string,
    survey?: TierSurveyDocument | null,
  ) => {
    Host.sendEvent({
      name: "CLIENT->MAIN::tablet-tier-survey",
      payload: {
        requestId,
        status,
        detail,
        survey: survey ?? undefined,
      },
    });
  };

  watch(
    [tabletTierSurveyDetail, tabletTierSurvey],
    ([detail, doc]) => {
      if (!activeRequestId) return;
      const st =
        doc?.status === "paused"
          ? "paused"
          : doc?.status === "complete"
            ? "complete"
            : doc?.status === "cancelled"
              ? "cancelled"
              : doc?.status === "error"
                ? "error"
                : "running";
      // Only push running checkpoints here; terminal statuses sent after await
      if (st !== "running") return;
      emit(
        activeRequestId,
        "running",
        detail || doc?.message || "Survey running…",
        doc,
      );
    },
    { flush: "post" },
  );

  Host.onEvent("MAIN->CLIENT::tablet-tier-survey", async (payload) => {
    if (payload.action === "cancel") {
      cancelBreachTierSurvey();
      const rid = payload.requestId;
      activeRequestId = null;
      emit(rid, "cancelled", "Cancel requested", tabletTierSurvey.value);
      return;
    }

    activeRequestId = payload.requestId;
    emit(payload.requestId, "running", "Survey starting…");

    try {
      const seed =
        payload.forceNew === false && payload.seed
          ? (payload.seed as TierSurveyDocument)
          : null;
      const doc = await ensureBreachTierSurvey(
        payload.forceNew !== false,
        seed,
      );
      activeRequestId = null;
      const terminal =
        doc.status === "complete"
          ? "complete"
          : doc.status === "cancelled"
            ? "cancelled"
            : doc.status === "paused"
              ? "paused"
              : "error";
      emit(payload.requestId, terminal, doc.message ?? doc.status, doc);
    } catch (e) {
      activeRequestId = null;
      emit(
        payload.requestId,
        "error",
        e instanceof Error ? e.message : String(e),
      );
    }
  });
}
