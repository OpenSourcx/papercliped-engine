import { NotebookPen } from "lucide-react";
import { NotesPage } from "../pages/pin/notes/NotesPage.tsx";
import type { Feature } from "./registry.ts";

/**
 * Pin: Notes. A page in the Host group of the sidebar: folders, tags, search, pinned and shared notes, a quick capture
 * box, and "Sort a pile", where Pin files pasted text with a review first. Live only: the demo has no host to save to
 * (the page says so instead of inventing data).
 */
export const notesFeature: Feature = {
  id: "notes",
  routes: [{ path: "notes", element: <NotesPage /> }],
  nav: [{ section: "Host", to: "notes", label: "Notes", icon: NotebookPen, order: 80, liveOnly: true }],
};
