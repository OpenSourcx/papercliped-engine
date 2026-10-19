import { NodeApiError } from "./nodeApi.ts";

/** The host's system vault (services/epaperclip/src/features/vault.ts, docs/VAULT.md). Values are write-only. */

async function req<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
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

export interface Target { companyId: string; agentId: string }
export interface VaultItem {
  id: string;
  name: string;
  description: string;
  share: "pin" | "ceos";
  targets: Target[];
  last4: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  syncedTo: string[];
}
export interface Ceo { companyId: string; companyName: string; agentId: string; name: string }
export interface VaultInput { name?: string; value?: string; description?: string; share?: "pin" | "ceos"; targets?: Target[] }

export const vaultApi = {
  list: () => req<{ items: VaultItem[]; canManage: boolean }>("GET", "/api/vault"),
  ceos: () => req<{ ceos: Ceo[] }>("GET", "/api/vault/ceos"),
  create: (b: VaultInput) => req<{ item: VaultItem; problems: string[] }>("POST", "/api/vault", b),
  update: (id: string, b: VaultInput) => req<{ item: VaultItem; problems: string[] }>("PATCH", `/api/vault/${encodeURIComponent(id)}`, b),
  remove: (id: string) => req<{ ok: true }>("DELETE", `/api/vault/${encodeURIComponent(id)}`),
  sync: () => req<{ items: VaultItem[]; problems: Record<string, string[]> }>("POST", "/api/vault/sync", {}),
};
