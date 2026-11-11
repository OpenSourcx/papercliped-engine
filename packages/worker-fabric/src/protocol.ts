/** Messages inside the encrypted channel, and the capability report. */

export interface Capabilities {
  os: { name: string; version: string };
  arch: string;
  hostname: string;
  cpu: { model: string; cores: number };
  memMb: number;
  gpu: { present: boolean; name?: string; kind?: "jetson" | "nvidia" | "apple" | "other"; vramMb?: number };
  storage: { path: string; totalGb: number; freeGb: number }[];
  tools: Record<string, string>;
  inference: { runtime: "ollama"; url: string; models: { name: string; sizeMb?: number }[]; maxContext?: number } | null;
  networks: { provider: "tailscale" | "lan" | "other"; address: string }[];
  workspaceRoot: string;
  /** Who the person chose to execute setup steps: Pin through the helper, or themselves with Pin guiding. */
  setupMode?: "pin" | "self";
}

export interface Heartbeat {
  at: number;
  loadAvg: number | null;
  freeMemMb: number | null;
  running: number;
  inferenceRunning: number;
  inferenceQueued: number;
}

/** worker -> host, unsolicited. */
export type WorkerEvent =
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
  | { id: string; op: "inference.install"; args: { action: "ollama" | "pull"; model?: string } }
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
} as const;
