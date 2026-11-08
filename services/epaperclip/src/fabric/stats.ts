import type { Stats } from "@papercliped-engine/worker-fabric";

/**
 * Recent device statistics per worker. Two resolutions, both bounded:
 *  - `recent`: the last RECENT_MAX full samples (15 s apart by default, so about an hour), memory only.
 *  - `history`: one compact point every HISTORY_EVERY_MS for HISTORY_MAX points (24 h), saved with the fabric state so a
 *    restart of the host keeps the charts.
 * A worker is authenticated but its numbers are still clamped and its lists capped before they are stored or shown.
 */
export const RECENT_MAX = 240;
export const HISTORY_MAX = 288;
export const HISTORY_EVERY_MS = 5 * 60_000;

export interface HistoryPoint { at: number; cpu: number | null; memPct: number | null; gpu: number | null; temp: number | null; load: number | null; diskFree: number | null; loaded: number }

const num = (v: unknown, lo = -1e9, hi = 1e12): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const str = (v: unknown, n = 80): string => (typeof v === "string" ? v.slice(0, n) : "");
const SVC = new Set(["active", "inactive", "failed", "unknown"]);

export function cleanStats(x: unknown, now: number): Stats | null {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const mem = s.mem ?? {};
  const svc = (k: string) => (SVC.has(s.services?.[k]) ? s.services[k] : "unknown");
  const load = Array.isArray(s.load) && s.load.length === 3 && s.load.every((n: unknown) => num(n) !== null) ? ([s.load[0], s.load[1], s.load[2]] as [number, number, number]) : null;
  const g = s.gpu && typeof s.gpu === "object" ? s.gpu : null;
  const o = s.ollama && typeof s.ollama === "object" ? s.ollama : null;
  const temps: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.temps ?? {}).slice(0, 24)) { const t = num(v, -50, 200); if (t !== null) temps[str(k, 40)] = t; }
  return {
    at: now, uptimeS: num(s.uptimeS, 0), load,
    cpu: { pct: num(s.cpu?.pct, 0, 100), cores: num(s.cpu?.cores, 0, 4096) ?? 0, tempC: num(s.cpu?.tempC, -50, 200) },
    mem: { totalMb: num(mem.totalMb, 0) ?? 0, usedMb: num(mem.usedMb, 0) ?? 0, availMb: num(mem.availMb, 0) ?? 0, swapTotalMb: num(mem.swapTotalMb, 0) ?? 0, swapUsedMb: num(mem.swapUsedMb, 0) ?? 0 },
    disk: (Array.isArray(s.disk) ? s.disk : []).slice(0, 4).map((d: any) => ({ path: str(d?.path, 120), totalGb: num(d?.totalGb, 0) ?? 0, freeGb: num(d?.freeGb, 0) ?? 0 })), // eslint-disable-line @typescript-eslint/no-explicit-any
    gpu: g ? { kind: g.kind === "nvidia" ? "nvidia" : "jetson", name: str(g.name), utilPct: num(g.utilPct, 0, 100), tempC: num(g.tempC, -50, 200), memUsedMb: num(g.memUsedMb, 0), memTotalMb: num(g.memTotalMb, 0), source: str(g.source, 20) } : null,
    temps, services: { worker: svc("worker"), ollama: svc("ollama"), tailscale: svc("tailscale") },
    ollama: o ? {
      up: o.up === true, version: o.version ? str(o.version, 30) : null, running: num(o.running, 0, 1000) ?? 0, queued: num(o.queued, 0, 100000) ?? 0,
      loaded: (Array.isArray(o.loaded) ? o.loaded : []).slice(0, 8).map((m: any) => ({ name: str(m?.name, 100), sizeMb: num(m?.sizeMb, 0) ?? 0, expiresAt: m?.expiresAt ? str(m.expiresAt, 40) : null })), // eslint-disable-line @typescript-eslint/no-explicit-any
      available: (Array.isArray(o.available) ? o.available : []).slice(0, 64).map((m: any) => ({ name: str(m?.name, 100), sizeMb: num(m?.sizeMb, 0) ?? 0 })), // eslint-disable-line @typescript-eslint/no-explicit-any
    } : null,
    pulls: (Array.isArray(s.pulls) ? s.pulls : []).slice(0, 4).map((p: any) => ({ name: str(p?.name, 100), pct: num(p?.pct, 0, 100), status: str(p?.status, 60), done: p?.done === true, ...(p?.error ? { error: str(p.error, 200) } : {}) })), // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

export const toPoint = (s: Stats): HistoryPoint => ({
  at: s.at, cpu: s.cpu.pct, memPct: s.mem.totalMb ? Math.round((s.mem.usedMb / s.mem.totalMb) * 1000) / 10 : null, gpu: s.gpu?.utilPct ?? null,
  temp: s.gpu?.tempC ?? s.cpu.tempC ?? null, load: s.load?.[0] ?? null, diskFree: s.disk[0]?.freeGb ?? null, loaded: s.ollama?.loaded.length ?? 0,
});

export class StatsStore {
  private readonly recent = new Map<string, Stats[]>();
  private lastPoint = new Map<string, number>();
  private history: Record<string, HistoryPoint[]>;
  constructor(history: Record<string, HistoryPoint[]> = {}) {
    this.history = history;
    for (const [id, pts] of Object.entries(history)) this.lastPoint.set(id, pts[pts.length - 1]?.at ?? 0);
  }
  /** Returns true when a history point was added (the caller then persists `snapshot()`). */
  add(id: string, s: Stats): boolean {
    const r = this.recent.get(id) ?? [];
    r.push(s);
    if (r.length > RECENT_MAX) r.splice(0, r.length - RECENT_MAX);
    this.recent.set(id, r);
    if (s.at - (this.lastPoint.get(id) ?? 0) < HISTORY_EVERY_MS) return false;
    const h = (this.history[id] ??= []);
    h.push(toPoint(s));
    if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
    this.lastPoint.set(id, s.at);
    return true;
  }
  get(id: string) {
    const r = this.recent.get(id) ?? [];
    return { latest: r[r.length - 1] ?? null, recent: r.map(toPoint), history: this.history[id] ?? [] };
  }
  latest(id: string): Stats | null { return this.recent.get(id)?.at(-1) ?? null; }
  drop(id: string) { this.recent.delete(id); delete this.history[id]; this.lastPoint.delete(id); }
  snapshot() { return this.history; }
}
