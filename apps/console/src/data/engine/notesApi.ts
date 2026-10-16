import { call, enc, qs } from "./nodeApi.ts";

/**
 * Notes on the host service (services/epaperclip/src/features/notes*.ts, docs/NOTES.md). Every call is made by the
 * signed-in person and returns only their own notes (and ones an organization they belong to shared with them).
 */

export type LinkKind = "machine" | "storage" | "org" | "task";
export interface NoteLink { kind: LinkKind; id: string; label: string }
export interface SecretWarning { id: string; kind: string; label: string; line: number; length: number }

export interface NoteSummary {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  pinned: boolean;
  links: NoteLink[];
  share: { orgId: string; orgName: string } | null;
  hasVault: boolean;
  source: "manual" | "capture" | "sorted" | "import" | "pin";
  createdAt: number;
  updatedAt: number;
  snippet: string;
  mine: boolean;
  owner?: string;
}
export interface NoteFull extends Omit<NoteSummary, "snippet" | "hasVault"> {
  body: string;
  vault: { id: string; kind: string; label: string }[];
}
export interface NotesList {
  notes: NoteSummary[];
  total: number;
  folders: { path: string; count: number }[];
  tags: { tag: string; count: number }[];
  settings: { autoFile: boolean };
  limits: { notes: number; body: number; totalBody: number; used: number };
  batches: { id: string; at: number; kind: string; created: number; updated: number; undone: boolean }[];
}
export interface Proposal {
  key: string;
  noteId?: string;
  title: string;
  body: string;
  folder: string;
  folderIsNew: boolean;
  tags: string[];
  links: NoteLink[];
  confidence: number;
  reasons: string[];
  secrets: SecretWarning[];
  source: "model" | "rules";
}
export interface Draft { id: string; createdAt: number; engine: "model" | "rules"; fallback: string | null; proposals: Proposal[]; secretCount: number }
export interface Applied { created: NoteSummary[]; updated: NoteSummary[]; batch: string | null; secrets: { redacted: number; vaulted: number; kept: number } }
export type SecretMode = "redact" | "vault" | "keep";
export interface Edit { key: string; include?: boolean; title?: string; folder?: string; tags?: string[]; links?: NoteLink[]; body?: string }
export interface NoteInput { title?: string; body?: string; folder?: string; tags?: string[]; links?: NoteLink[]; pinned?: boolean; expectedUpdatedAt?: number }
export interface LinkOptions { machines: { vmid: number; name: string; type: string }[]; storages: string[]; orgs: { id: string; name: string }[] }

const post = <T,>(path: string, body?: unknown) => call<T>("POST", `/api/notes${path}`, body ?? {});

export const notesApi = {
  list: (q: { q?: string; folder?: string; tag?: string; pinned?: boolean; machine?: string | number }) => call<NotesList>("GET", `/api/notes${qs({ q: q.q, folder: q.folder, tag: q.tag, pinned: q.pinned ? 1 : undefined, machine: q.machine })}`),
  get: (id: string) => call<{ note: NoteFull; warnings: SecretWarning[] }>("GET", `/api/notes/${id}`),
  create: (b: NoteInput) => post<{ note: NoteFull; warnings: SecretWarning[] }>("", b),
  capture: (text: string) => post<{ note: NoteFull; warnings: SecretWarning[] }>("/capture", { text }),
  update: (id: string, b: NoteInput) => call<{ note: NoteFull; warnings: SecretWarning[] }>("PUT", `/api/notes/${id}`, b),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/api/notes/${id}`),
  secrets: (id: string, action: "redact" | "vault") => post<{ note: NoteFull; count: number }>(`/${id}/secrets`, { action }),
  reveal: (id: string, sid: string) => post<{ value: string; label: string }>(`/${id}/secrets/${sid}/reveal`),
  share: (id: string, orgId: string | null) => post<{ note: NoteFull }>(`/${id}/share`, { orgId }),
  shared: () => call<{ notes: NoteSummary[] }>("GET", "/api/notes/shared"),
  sharedNote: (owner: string, id: string) => call<{ note: NoteFull }>("GET", `/api/notes/shared/${enc(owner)}/${id}`),
  options: () => call<LinkOptions>("GET", "/api/notes/options"),
  sort: (b: { text?: string; inbox?: boolean; noteIds?: string[] }) => post<{ draft: Draft | null; autoFiled: Applied | null }>("/sort", b),
  accept: (draft: string, b: { edits?: Edit[]; only?: string[]; secrets?: SecretMode }) => post<Applied>(`/sort/${draft}/accept`, b),
  discard: (draft: string) => call<{ ok: true }>("DELETE", `/api/notes/sort/${draft}`),
  undo: (batch: string) => post<{ removed: number; restored: number }>(`/batches/${batch}/undo`),
  setAutoFile: (autoFile: boolean) => call<{ settings: { autoFile: boolean } }>("PUT", "/api/notes/settings", { autoFile }),
  createFolder: (path: string) => post<{ path: string }>("/folders", { path }),
  renameFolder: (from: string, to: string) => call<{ path: string }>("PUT", "/api/notes/folders", { from, to }),
  deleteFolder: (path: string) => call<{ ok: true }>("DELETE", `/api/notes/folders${qs({ path })}`),
  importFile: async (file: File) => {
    const res = await fetch("/api/notes/import", { method: "POST", credentials: "same-origin", headers: { "X-EPC-Request": "1", "Content-Type": "application/octet-stream" }, body: file });
    const data = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, number | string | null>;
    if (!res.ok) throw new Error(data.error ?? `Import failed (${res.status})`);
    return data as unknown as { imported: number; duplicates: number; skipped: number; noSpace: number; batch: string | null; secrets: number };
  },
  exportUrl: "/api/notes/export",
};
