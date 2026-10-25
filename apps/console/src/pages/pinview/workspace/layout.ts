import { useCallback, useState } from "react";
import { readJson, writeJson } from "../../../lib/storage.ts";

/** A tile in the right-hand column: the plan (tasks), files (tabs with an optional tree), a terminal, artifacts or pull requests. */
export type TileKind = "plan" | "files" | "terminal" | "artifacts" | "prs";

/** The workspace's arrangement, kept per browser the way a desktop app keeps its window layout. */
export interface Layout {
  sideOpen: boolean;
  sideWidth: number;
  cards: boolean;
  tiles: TileKind[];
  /** Height of each tile but the last, which takes what is left. */
  tileHeights: Partial<Record<TileKind, number>>;
  tilesWidth: number;
  fileTree: boolean;
}

const KEY = "epc.pinview.layout2";
export const DEFAULT_LAYOUT: Layout = { sideOpen: true, sideWidth: 272, cards: false, tiles: [], tileHeights: {}, tilesWidth: 520, fileTree: true };

export function useLayout() {
  const [layout, setLayout] = useState<Layout>(() => ({ ...DEFAULT_LAYOUT, ...readJson<Partial<Layout>>(KEY, {}) }));
  const set = useCallback((patch: Partial<Layout> | ((l: Layout) => Partial<Layout>)) => setLayout((l) => {
    const next = { ...l, ...(typeof patch === "function" ? patch(l) : patch) };
    writeJson(KEY, next);
    return next;
  }), []);
  /** Opens a tile (at the top, like a new pane), or closes it when it is already open. */
  const toggleTile = useCallback((k: TileKind) => set((l) => ({ tiles: l.tiles.includes(k) ? l.tiles.filter((t) => t !== k) : [k, ...l.tiles] })), [set]);
  const showTile = useCallback((k: TileKind) => set((l) => ({ tiles: l.tiles.includes(k) ? l.tiles : [k, ...l.tiles] })), [set]);
  const closeTile = useCallback((k: TileKind) => set((l) => ({ tiles: l.tiles.filter((t) => t !== k) })), [set]);
  return { layout, set, toggleTile, showTile, closeTile };
}
