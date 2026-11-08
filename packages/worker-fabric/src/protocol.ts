/** Messages inside the encrypted channel, and the capability report. */

export interface Capabilities {
  os: { name: string; version: string };
  arch: string;
  hostname: string;
  cpu: { model: string; cores: number };
  memMb: number;
  gpu: { present: boolean; name?: string; kind?: "jetson" | "nvidia" | "other" };
  storage: { path: string; totalGb: number; freeGb: number }[];
  tools: Record<string, string>;
  inference: { runtime: "ollama"; url: string; models: { name: string; sizeMb?: number }[]; maxContext?: number } | null;
  networks: { provider: "tailscale" | "lan" | "other"; address: string }[];
  workspaceRoot: string;
}

export interface Heartbeat {
  at: number;
  loadAvg: number | null;
  freeMemMb: number | null;
  running: number;
  inferenceRunning: number;
  inferenceQueued: number;
}

/** One device-statistics sample. Everything optional is absent when the machine does not offer it (no GPU, no swap, no systemd). */
export interface Stats {
  at: number;
  uptimeS: number | null;
  load: [number, number, number] | null;
  cpu: { pct: number | null; cores: number; tempC: number | null };
  mem: { totalMb: number; usedMb: number; availMb: number; swapTotalMb: number; swapUsedMb: number };
  disk: { path: string; totalGb: number; freeGb: number }[];
  gpu: { kind: "jetson" | "nvidia"; name: string; utilPct: number | null; tempC: number | null; memUsedMb: number | null; memTotalMb: number | null; source: string } | null;
  /** All thermal zones that report a temperature, in degrees C. */
  temps: Record<string, number>;
  services: Record<"worker" | "ollama" | "tailscale", "active" | "inactive" | "failed" | "unknown">;
  ollama: { up: boolean; version: string | null; loaded: { name: string; sizeMb: number; expiresAt: string | null }[]; available: { name: string; sizeMb: number }[]; running: number; queued: number } | null;
  pulls: { name: string; pct: number | null; status: string; done: boolean; error?: string }[];
}

/** Management actions the host can ask a worker to do. The host signs each request (see ManageEnvelope). */
export type ManageAction = "restart-worker" | "restart-ollama" | "model-pull" | "model-remove" | "update" | "logs" | "stats";
export interface ManageEnvelope { action: ManageAction; params: Record<string, unknown>; workerId: string; ts: number; nonce: string; sig: string }
/** The exact bytes the host signs. Both sides build it with this one function. */
export const manageMessage = (e: Omit<ManageEnvelope, "sig">): string => `epw-manage-v1\n${e.workerId}\n${e.action}\n${e.ts}\n${e.nonce}\n${JSON.stringify(sortKeys(e.params))}`;
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/** worker -> host, unsolicited. */
export type WorkerEvent =
  | { ev: "stats"; stats: Stats }
  | { ev: "caps"; caps: Capabilities; version: string }
  | { ev: "hb"; hb: Heartbeat }
  | { ev: "out"; id: string; stream: "stdout" | "stderr"; data: string }
  | { ev: "exit"; id: string; exitCode: number | null; signal: string | null; timedOut: boolean };

/** host -> worker request; the worker answers with a Response carrying the same id. */
export type Request =
  | { id: string; op: "ws.ensure"; args: { path: string; mode?: "directory" | "worktree"; repo?: string; ref?: string } }
  | { id: string; op: "ws.remove"; args: { path: string } }
  | { id: string; op: "exec"; args: { command: string; args?: string[]; cwd: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number; owner: string } }
  | { id: string; op: "cancel"; args: { target: string; owner?: string } }
  | { id: string; op: "caps.refresh"; args: Record<string, never> }
  | { id: string; op: "manage"; args: ManageEnvelope }
  | { id: string; op: "hello.ok"; args: { workerId: string; name: string; hbMs: number } }
  | { id: string; op: "revoked"; args: Record<string, never> };

export interface Response {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Protocol limits shared by both sides. */
export const LIMITS = {
  /** Largest single output chunk the worker sends. */
  chunkBytes: 32 * 1024,
  /** Heartbeat interval; the host marks a worker offline after three missed beats. */
  heartbeatMs: 10_000,
  /** How long a pairing code or pending request lives. */
  pairingTtlMs: 15 * 60_000,
  maxPending: 20,
  /** A signed management request older (or newer) than this is refused. */
  manageSkewMs: 120_000,
  statsMs: 15_000,
} as const;
