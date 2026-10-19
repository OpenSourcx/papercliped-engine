import { NodeApiError } from "./nodeApi.ts";

/** Pin's saved chats, SOUL.md and MEMORY.md on the device (services/epaperclip/src/features/pin-library.ts, docs/PIN.md). */

async function req<T>(method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-EPC-Request": "1" },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new NodeApiError(0, "Can't reach this device", "offline");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string };
    throw new NodeApiError(res.status, d.error ?? `Request failed (${res.status})`, d.code ?? null);
  }
  return data as T;
}

const enc = encodeURIComponent;

export interface ChatMeta { id: string; title: string; createdAt: number; updatedAt: number; count: number }
export interface StoredTool { id: string; name: string; status: string; args?: Record<string, unknown>; label?: string; result?: string; error?: string; vmid?: number }
export interface StoredMessage { id: string; from: "you" | "pin"; at: number; text: string; tool?: StoredTool; error?: { message: string; code?: string } }
export interface SavedChat extends ChatMeta { messages: StoredMessage[] }

export type MemoryFile = "soul" | "memory";
export interface MemoryView {
  soul: string;
  memory: string;
  /** True while a file is still the starting text nobody has changed. */
  soulIsDefault: boolean;
  memoryIsDefault: boolean;
  rev: number;
  editedAt?: number;
  limits: { soul: number; memory: number };
}
export interface Revision { rev: number; file: MemoryFile; at: number; by: string }

export const pinLibrary = {
  chats: () => req<{ chats: ChatMeta[] }>("GET", "/api/pin/chats"),
  chat: (id: string) => req<{ chat: SavedChat }>("GET", `/api/pin/chats/${enc(id)}`),
  rename: (id: string, title: string) => req<{ chat: ChatMeta }>("PATCH", `/api/pin/chats/${enc(id)}`, { title }),
  remove: (id: string) => req<{ ok: true }>("DELETE", `/api/pin/chats/${enc(id)}`),
  memory: () => req<MemoryView>("GET", "/api/pin/memory"),
  save: (file: MemoryFile, text: string, baseRev?: number) => req<MemoryView>("PUT", `/api/pin/memory/${file}`, { text, ...(baseRev === undefined ? {} : { baseRev }) }),
  history: () => req<{ revisions: Revision[] }>("GET", "/api/pin/memory/history"),
  restore: (rev: number) => req<MemoryView>("POST", "/api/pin/memory/restore", { rev }),
};
