import { useCallback, useState } from "react";
import { readJson, writeJson } from "../../../lib/storage.ts";

/** Which view the side panel shows, chosen in the activity bar. */
export type SideView = "chats" | "explorer" | "artifacts" | "prs" | "search";
export type BottomTab = "terminal" | "steps";

/** The workspace's arrangement, kept per browser like an editor keeps its window layout. */
export interface Layout {
  side: SideView;
  sideOpen: boolean;
  sideWidth: number;
  editorWidth: number;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  bottomHeight: number;
  details: boolean;
}

const KEY = "epc.pinview.layout";
export const DEFAULT_LAYOUT: Layout = { side: "chats", sideOpen: true, sideWidth: 288, editorWidth: 520, bottomOpen: false, bottomTab: "terminal", bottomHeight: 260, details: false };

export function useLayout() {
  const [layout, setLayout] = useState<Layout>(() => ({ ...DEFAULT_LAYOUT, ...readJson<Partial<Layout>>(KEY, {}) }));
  const set = useCallback((patch: Partial<Layout> | ((l: Layout) => Partial<Layout>)) => setLayout((l) => {
    const next = { ...l, ...(typeof patch === "function" ? patch(l) : patch) };
    writeJson(KEY, next);
    return next;
  }), []);
  /** The activity bar: clicking the open view closes the side panel, clicking another switches to it. */
  const showSide = useCallback((v: SideView) => set((l) => (l.sideOpen && l.side === v ? { sideOpen: false } : { side: v, sideOpen: true })), [set]);
  return { layout, set, showSide };
}
