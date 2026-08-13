import { aggregateRawSeen } from "./roll-seen-store";
import type {
  FittedWeightSnapshot,
  RawSeenAggregate,
  RollSeenDocument,
} from "./roll-seen-types";

export interface RollSeenExportPayload {
  rollSeen: RollSeenDocument;
  aggregate: RawSeenAggregate;
  meta: {
    app: "exiled-exchange-2";
    feature: "tablet-roll-seen";
    exportedAt: number;
  };
  fit?: FittedWeightSnapshot;
}

export function buildRollSeenExportPayload(
  doc: RollSeenDocument,
  opts?: { fit?: FittedWeightSnapshot },
): RollSeenExportPayload {
  const payload: RollSeenExportPayload = {
    rollSeen: doc,
    aggregate: aggregateRawSeen(doc),
    meta: {
      app: "exiled-exchange-2",
      feature: "tablet-roll-seen",
      exportedAt: Date.now(),
    },
  };
  if (opts?.fit) payload.fit = opts.fit;
  return payload;
}

/** Clipboard-first export (pretty JSON). */
export async function copyRollSeenJsonToClipboard(
  doc: RollSeenDocument,
  opts?: { fit?: FittedWeightSnapshot; aggregateOnly?: boolean },
): Promise<void> {
  const payload = buildRollSeenExportPayload(doc, { fit: opts?.fit });
  const text = opts?.aggregateOnly
    ? JSON.stringify(
        {
          aggregate: payload.aggregate,
          meta: payload.meta,
          ...(opts?.fit ? { fit: opts.fit } : {}),
        },
        null,
        2,
      )
    : JSON.stringify(payload, null, 2);
  await navigator.clipboard.writeText(text);
}
