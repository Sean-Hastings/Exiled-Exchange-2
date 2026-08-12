import type { Widget, Anchor } from "@/web/overlay/widgets";

export interface TabletEVWidget extends Widget {
  anchor: Anchor;
  toggleKey: string | null;
}