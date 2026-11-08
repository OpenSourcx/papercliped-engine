import type { StatusKind } from "../../ui/primitives.tsx";
import type { Capabilities, Worker } from "../../data/engine/fabric.ts";

export interface Health { kind: StatusKind; label: string; detail: string }

/** One health word per worker, in the console's status vocabulary. State never rides on colour alone (Status adds an icon). */
export function healthOf(w: Worker): Health {
  if (w.state === "revoked") return { kind: "critical", label: "Revoked", detail: "This identity can never connect again." };
  if (w.state === "pending") return { kind: "paused", label: "Waiting for approval", detail: "Not adopted yet." };
  if (w.disabled) return { kind: "off", label: "Disabled", detail: "No new work is scheduled here." };
  if (!w.online) return { kind: "warning", label: "Offline", detail: "It reconnects by itself when it can reach this host." };
  if (w.draining) return { kind: "paused", label: "Draining", detail: "Finishing current work; nothing new is scheduled." };
  const low = w.usage.freeMemMb !== null && w.usage.freeMemMb < 256;
  if (low) return { kind: "warning", label: "Low memory", detail: `${w.usage.freeMemMb} MB free.` };
  return { kind: "good", label: "Online", detail: "Ready for work." };
}

export const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb} MB`);

export function hardwareSummary(c: Capabilities | null): string {
  if (!c) return "Hardware not reported yet";
  return `${c.cpu.cores} cores, ${gb(c.memMb)}${c.gpu.present ? `, ${c.gpu.name ?? "GPU"}` : ""}`;
}

export const gpuText = (c: Capabilities) => (c.gpu.present ? (c.gpu.name ?? "GPU present") + (c.gpu.kind ? ` (${c.gpu.kind})` : "") : "None");

export const modelNames = (c: Capabilities): string[] => c.inference?.models.map((m) => m.name) ?? [];

/** "just now", "3 min ago", "2 h ago", "5 d ago"; null means never. `now` is a parameter so tests are stable. */
export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "Never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return "Just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const clock = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** mm:ss until `expiresAt`, or null once it has passed. */
export function countdown(expiresAt: number, now = Date.now()): string | null {
  const s = Math.ceil((expiresAt - now) / 1000);
  if (s <= 0) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const providerLabel = (p: string) => ({ tailscale: "Tailscale", lan: "Local network", custom: "Custom", other: "Other" })[p] ?? p;

/** Active leases first; the worker's own count is authoritative, the list is what the detail page shows. */
export const leaseCount = (w: Worker) => w.usage.shellLeases;
