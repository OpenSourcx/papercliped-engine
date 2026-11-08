import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import type { Stats } from "@papercliped-engine/worker-fabric";

/**
 * Device statistics. Everything is read without root: /proc, /sys, `systemctl is-active`, `nvidia-smi` and the local Ollama API.
 * `root` and `exec`/`fetchFn` are injected so tests can run against recorded fixtures of a real Jetson Orin Nano.
 */

export interface StatsDeps {
  root?: string;
  exec?: (cmd: string, args: string[]) => Promise<string | null>;
  fetchFn?: typeof fetch;
  now?: () => number;
}

const run = (cmd: string, args: string[]) =>
  new Promise<string | null>((res) => execFile(cmd, args, { timeout: 3000, maxBuffer: 1 << 20 }, (e, out) => res(e && !String(out).trim() ? null : String(out).trim())));

const read = (root: string, p: string): string | null => { try { return readFileSync(join(root, p), "utf8"); } catch { return null; } };
const round1 = (n: number) => Math.round(n * 10) / 10;

/** First `cpu ` line of /proc/stat as [busy, total] jiffies. iowait counts as idle. */
export function parseCpuStat(text: string | null): { busy: number; total: number } | null {
  const l = text?.split("\n").find((x) => x.startsWith("cpu "));
  if (!l) return null;
  const v = l.trim().split(/\s+/).slice(1).map(Number);
  if (v.length < 4 || v.some((n) => !Number.isFinite(n))) return null;
  const idle = (v[3] ?? 0) + (v[4] ?? 0);
  const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

export function parseMeminfo(text: string | null): Stats["mem"] | null {
  if (!text) return null;
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? NaN);
  const total = kb("MemTotal"), avail = kb("MemAvailable"), st = kb("SwapTotal"), sf = kb("SwapFree");
  if (!Number.isFinite(total) || !Number.isFinite(avail)) return null;
  const mb = (k: number) => Math.round(k / 1024);
  return { totalMb: mb(total), availMb: mb(avail), usedMb: mb(total - avail), swapTotalMb: Number.isFinite(st) ? mb(st) : 0, swapUsedMb: Number.isFinite(st) && Number.isFinite(sf) ? mb(st - sf) : 0 };
}

/** Thermal zones: type -> degrees C. Zones that report no data (a Jetson's cv0..cv2) are skipped. */
export function readTemps(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  let zones: string[] = [];
  try { zones = readdirSync(join(root, "sys/class/thermal")).filter((z) => z.startsWith("thermal_zone")).sort((a, b) => Number(a.slice(12)) - Number(b.slice(12))); } catch { return out; }
  for (const z of zones) {
    const type = read(root, `sys/class/thermal/${z}/type`)?.trim();
    const t = Number(read(root, `sys/class/thermal/${z}/temp`)?.trim());
    if (type && Number.isFinite(t) && t > -50000 && t < 200000) out[type] = round1(t / 1000);
  }
  return out;
}

const JETSON_GPU_LOAD = ["sys/devices/platform/bus@0/17000000.gpu/load", "sys/devices/platform/17000000.gpu/load", "sys/devices/platform/gpu.0/load", "sys/devices/platform/17000000.ga10b/load", "sys/devices/platform/gpu.0/devfreq/17000000.gpu/load"];

export function parseNvidiaSmi(csv: string | null): { name: string; utilPct: number | null; tempC: number | null; memUsedMb: number | null; memTotalMb: number | null } | null {
  const l = csv?.split("\n")[0];
  if (!l) return null;
  const f = l.split(",").map((x) => x.trim());
  if (f.length < 5 || !f[0]) return null;
  const n = (s: string | undefined) => { const v = Number(String(s ?? "").replace(/[^\d.]/g, "")); return s && /\d/.test(s) && Number.isFinite(v) ? v : null; };
  return { name: f[0], utilPct: n(f[1]), tempC: n(f[2]), memUsedMb: n(f[3]), memTotalMb: n(f[4]) };
}

async function readGpu(root: string, exec: NonNullable<StatsDeps["exec"]>, temps: Record<string, number>): Promise<Stats["gpu"]> {
  const model = read(root, "proc/device-tree/model")?.replace(/\0/g, "").trim() ?? "";
  const jetson = existsSync(join(root, "etc/nv_tegra_release")) || /jetson|tegra|orin/i.test(model);
  const smi = parseNvidiaSmi(await exec("nvidia-smi", ["--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]));
  if (jetson) {
    // Orin reports "[N/A]" through nvidia-smi; the load node (0..1000) is world readable.
    let util = smi?.utilPct ?? null;
    let source = smi?.utilPct != null ? "nvidia-smi" : "none";
    if (util == null) for (const p of JETSON_GPU_LOAD) { const v = Number(read(root, p)?.trim()); if (Number.isFinite(v) && read(root, p) !== null) { util = round1(v / 10); source = "sysfs"; break; } }
    return { kind: "jetson", name: model || smi?.name || "NVIDIA Jetson", utilPct: util, tempC: smi?.tempC ?? temps["gpu-thermal"] ?? null, memUsedMb: smi?.memUsedMb ?? null, memTotalMb: smi?.memTotalMb ?? null, source };
  }
  if (smi) return { kind: "nvidia", name: smi.name, utilPct: smi.utilPct, tempC: smi.tempC, memUsedMb: smi.memUsedMb, memTotalMb: smi.memTotalMb, source: "nvidia-smi" };
  return null;
}

const active = (s: string | null): Stats["services"]["worker"] => (s === "active" || s === "inactive" || s === "failed" ? s : s === "activating" || s === "reloading" ? "active" : "unknown");

export interface OllamaView { up: boolean; version: string | null; loaded: { name: string; sizeMb: number; expiresAt: string | null }[]; available: { name: string; sizeMb: number }[] }

export async function readOllama(urls: string[], fetchFn: typeof fetch = fetch): Promise<(OllamaView & { url: string }) | null> {
  for (const u of urls) {
    const base = u.replace(/\/+$/, "");
    const get = async (p: string) => { const r = await fetchFn(`${base}${p}`, { signal: AbortSignal.timeout(2500) }); if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as Record<string, unknown>; };
    try {
      const tags = (await get("/api/tags")) as { models?: { name: string; size?: number }[] };
      const [ps, ver] = await Promise.all([get("/api/ps").catch(() => ({})) as Promise<{ models?: { name: string; size?: number; expires_at?: string }[] }>, get("/api/version").catch(() => ({})) as Promise<{ version?: string }>]);
      const mb = (b?: number) => Math.round((b ?? 0) / 1048576);
      return { url: u, up: true, version: typeof ver.version === "string" ? ver.version : null, available: (tags.models ?? []).map((m) => ({ name: m.name, sizeMb: mb(m.size) })), loaded: (ps.models ?? []).map((m) => ({ name: m.name, sizeMb: mb(m.size), expiresAt: m.expires_at ?? null })) };
    } catch { /* next address */ }
  }
  return null;
}

export interface StatsCfg { workspaceRoot: string; ollamaUrls: string[]; gate: () => { running: number; queued: number } | null; pulls: () => Stats["pulls"] }

/** Keeps the previous CPU reading so utilisation is a delta, as `top` does. */
export class StatsCollector {
  private prev: { busy: number; total: number } | null = null;
  private readonly d: Required<Pick<StatsDeps, "root" | "exec" | "now">> & { fetchFn: typeof fetch };
  private readonly cfg: () => StatsCfg;
  constructor(deps: StatsDeps = {}, cfg: () => StatsCfg = () => ({ workspaceRoot: "/", ollamaUrls: [], gate: () => null, pulls: () => [] })) {
    this.cfg = cfg;
    this.d = { root: deps.root ?? "/", exec: deps.exec ?? run, now: deps.now ?? Date.now, fetchFn: deps.fetchFn ?? fetch };
  }

  async collect(): Promise<Stats> {
    const { root, exec } = this.d;
    const cfg = this.cfg();
    const cs = parseCpuStat(read(root, "proc/stat"));
    let pct: number | null = null;
    if (cs && this.prev && cs.total > this.prev.total) pct = round1(((cs.busy - this.prev.busy) / (cs.total - this.prev.total)) * 100);
    if (cs) this.prev = cs;
    const mem = parseMeminfo(read(root, "proc/meminfo")) ?? { totalMb: 0, usedMb: 0, availMb: 0, swapTotalMb: 0, swapUsedMb: 0 };
    const la = read(root, "proc/loadavg")?.trim().split(/\s+/).slice(0, 3).map(Number);
    const up = Number(read(root, "proc/uptime")?.split(" ")[0]);
    const cores = (read(root, "proc/cpuinfo")?.match(/^processor\s*:/gm) ?? []).length || (read(root, "proc/stat")?.match(/^cpu\d+ /gm) ?? []).length;
    const temps = readTemps(root);
    const disk: Stats["disk"] = [];
    for (const p of new Set([cfg.workspaceRoot, "/"])) {
      try { const s = statfsSync(join(root, p)); disk.push({ path: p, totalGb: round1((s.blocks * s.bsize) / 1e9), freeGb: round1((s.bavail * s.bsize) / 1e9) }); } catch { /* path missing */ }
    }
    const [gpu, w, o, t, oll] = await Promise.all([
      readGpu(root, exec, temps),
      exec("systemctl", ["is-active", "epaperclip-worker"]), exec("systemctl", ["is-active", "ollama"]), exec("systemctl", ["is-active", "tailscaled"]),
      readOllama(cfg.ollamaUrls, this.d.fetchFn),
    ]);
    const g = cfg.gate();
    const cpuTemp = temps["cpu-thermal"] ?? temps["x86_pkg_temp"] ?? temps["coretemp"] ?? temps["k10temp"] ?? null;
    return {
      at: this.d.now(), uptimeS: Number.isFinite(up) ? Math.round(up) : null, load: la && la.length === 3 && la.every(Number.isFinite) ? [la[0]!, la[1]!, la[2]!] : null,
      cpu: { pct, cores, tempC: cpuTemp }, mem, disk, gpu, temps,
      services: { worker: active(w), ollama: active(o), tailscale: active(t) },
      ollama: oll ? { up: true, version: oll.version, loaded: oll.loaded, available: oll.available, running: g?.running ?? 0, queued: g?.queued ?? 0 } : null,
      pulls: cfg.pulls(),
    };
  }
}
