import type { StateStore } from "../state.ts";
import { INBOX, LIMITS, bad, cleanFolder, cleanTags, oneLine, titleFrom } from "./notes-core.ts";
import { checkBody, createNote, fileNotes, notesFor } from "./notes-ops.ts";
import { scanSecrets } from "./notes-secrets.ts";

/**
 * Pin's note-writing steps, as plan steps: they sit in a plan until the person approves them (docs/PIN.md), exactly like
 * a power or snapshot step. Pin never writes a note on its own. A plan is stored in plain form in the host's state, so
 * secrets in a note's text are redacted when the step is written down, not when it runs.
 */

export type NoteStepKind = "note_create" | "notes_file";
export const NOTE_STEP_KEYS: Record<NoteStepKind, string[]> = {
  note_create: ["kind", "title", "body", "folder", "tags"],
  notes_file: ["kind", "noteIds", "folder", "addTags"],
};
export const isNoteStep = (k: string): k is NoteStepKind => k === "note_create" || k === "notes_file";

const NOTE_ID = /^[0-9a-f]{16}$/;

export function parseNoteStep(kind: NoteStepKind, r: Record<string, unknown>): { kind: NoteStepKind; args: Record<string, unknown> } {
  if (kind === "note_create") {
    const scan = scanSecrets(checkBody(r.body));
    if (!scan.redacted.trim()) throw bad("a note needs some text");
    const title = oneLine(r.title, LIMITS.title) || titleFrom(scan.redacted);
    return { kind, args: { title, body: scan.redacted, folder: r.folder === undefined ? INBOX : cleanFolder(r.folder), tags: cleanTags(r.tags), redacted: scan.findings.length } };
  }
  if (!Array.isArray(r.noteIds) || r.noteIds.length === 0 || r.noteIds.length > 50 || !r.noteIds.every((i) => typeof i === "string" && NOTE_ID.test(i))) throw bad("noteIds must be 1 to 50 note ids from search_notes");
  const folder = r.folder === undefined ? undefined : cleanFolder(r.folder);
  const addTags = cleanTags(r.addTags);
  if (!folder && !addTags.length) throw bad("file_notes needs a folder or tags to add");
  return { kind, args: { noteIds: [...new Set(r.noteIds as string[])], ...(folder ? { folder } : {}), ...(addTags.length ? { addTags } : {}) } };
}

export function describeNoteStep(kind: NoteStepKind, a: Record<string, unknown>): string {
  if (kind === "note_create") return `Save note "${a.title}" in ${a.folder}${a.redacted ? ` (${a.redacted} likely secret${a.redacted === 1 ? "" : "s"} left out)` : ""}`;
  const n = (a.noteIds as string[]).length;
  return `File ${n} note${n === 1 ? "" : "s"}${a.folder ? ` in ${a.folder}` : ""}${Array.isArray(a.addTags) && a.addTags.length ? ` with tag${a.addTags.length === 1 ? "" : "s"} ${(a.addTags as string[]).join(", ")}` : ""}`;
}

/** Runs an approved step as the person who approved it. */
export function runNoteStep(state: StateStore, user: string, kind: NoteStepKind, a: Record<string, unknown>): string {
  const rt = notesFor(state);
  if (kind === "note_create") {
    createNote(rt, user, { title: a.title, body: a.body, folder: a.folder, tags: a.tags }, "pin");
    return "Saved the note.";
  }
  const r = fileNotes(rt, user, { noteIds: a.noteIds as string[], folder: a.folder, addTags: a.addTags });
  return r.filed === 0 ? "None of those notes exist any more." : `Filed ${r.filed} note${r.filed === 1 ? "" : "s"}.`;
}
