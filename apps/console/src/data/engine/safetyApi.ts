import { NodeApiError } from "./nodeApi.ts";

/** The emergency controls (services/epaperclip/src/features/safety.ts, docs/SAFETY.md). */

export interface KillSwitch {
  on: boolean;
  at: number;
  by?: string;
  stopped?: { vmid: number; name: string | null }[];
  paused?: { companyId: string; agentId: string }[];
  failures?: string[];
  unreachableOrganizations?: number;
}
export interface SafetyState { canManage: boolean; killSwitch: KillSwitch | null; vault: { keyId: string } | null }
export interface RecoveryFile { v: 1; kind: "epaperclip-vault-key"; kid: string; created: string; [k: string]: unknown }

export const KILL_PHRASE = "STOP EVERYTHING";
export const RESTORE_PHRASE = "RESTORE VAULT KEY";

async function req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-EPC-Request": "1" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
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

export const safetyApi = {
  state: () => req<SafetyState>("GET", "/api/safety"),
  killSwitch: () => req<{ killSwitch: KillSwitch }>("POST", "/api/safety/kill-switch", { confirm: KILL_PHRASE }),
  resume: (unpauseAgents: boolean) => req<{ killSwitch: KillSwitch; resumedAgents: number; failures: string[] }>("POST", "/api/safety/resume", { unpauseAgents }),
  exportRecovery: (passphrase: string) => req<RecoveryFile>("POST", "/api/vault/recovery/export", { passphrase }),
  restore: (file: RecoveryFile, passphrase: string) => req<{ restored: boolean; same: boolean; restartRequired: boolean; keptPreviousKey: boolean }>("POST", "/api/vault/recovery/restore", { file, passphrase, confirm: RESTORE_PHRASE }),
};
