import { NodeApiError } from "./nodeApi.ts";

/** Files inside a machine (services/epaperclip/src/features/machine-files.ts), read and written as the signed-in person. */

async function req<T>(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-EPC-Request": "1" },
      body: method === "PUT" ? JSON.stringify(body ?? {}) : undefined,
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


export interface FileEntry { name: string; kind: "dir" | "file" | "link" | "linkdir"; size: number; mtime: number }
export interface Listing { path: string; entries: FileEntry[]; truncated: boolean }
export interface MachineFile { path: string; size: number; content: string | null; tooLarge: boolean; binary: boolean; etag: string | null }

/** The largest file the editor opens, matching the host. */
export const MAX_EDIT = 48 * 1024;

export const machineFilesApi = {
  list: (vmid: number, path: string) => req<Listing>("GET", `/api/guests/${vmid}/files?path=${encodeURIComponent(path)}`),
  read: (vmid: number, path: string) => req<MachineFile>("GET", `/api/guests/${vmid}/file?path=${encodeURIComponent(path)}`),
  write: (vmid: number, path: string, content: string, etag: string | null) => req<{ path: string; size: number; etag: string }>("PUT", `/api/guests/${vmid}/file`, { path, content, ...(etag ? { etag } : {}) }),
};
