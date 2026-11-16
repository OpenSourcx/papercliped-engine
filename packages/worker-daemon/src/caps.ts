import { execFile } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { arch, cpus, hostname, loadavg, networkInterfaces, totalmem, userInfo } from "node:os";
import type { Capabilities, Heartbeat } from "@papercliped-engine/worker-fabric";
import { workerLimits, codingProfile } from "@papercliped-engine/worker-fabric";
import { memorySnapshot } from "./memory.ts";
import { workerPath } from "./environment.ts";
import { readQualifications } from "./qualification.ts";

/** What this machine is and can do. Everything is detected, nothing is assumed; a missing tool is simply absent. */

const sh = (cmd: string, args: string[], ms = 4000) =>
  new Promise<string | null>((res) => execFile(cmd, args, { env: { ...process.env, PATH: workerPath() }, timeout: ms, maxBuffer: 1 << 20 }, (e, out, err) => res(e ? null : String(out || err).trim())));

const TOOLS: [string, string[]][] = [["git", ["--version"]], ["gh", ["--version"]], ["node", ["--version"]], ["npm", ["--version"]], ["pnpm", ["--version"]], ["python3", ["--version"]], ["uv", ["--version"]], ["docker", ["--version"]], ["make", ["--version"]], ["gcc", ["--version"]], ["cargo", ["--version"]], ["ollama", ["--version"]]];

export async function detectTools(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(TOOLS.map(async ([t, a]) => {
    const v = await sh(t, a);
    const m = v ? /\d+\.\d+(\.\d+)?/.exec(v) : null;
    if (m) out[t === "python3" ? "python" : t] = m[0];
  }));
  for (const name of ["aider", "opencode"]) {
    const v = await sh(name, ["--version"], 10_000);
    const m = v && /\d+\.\d+(\.\d+)?/.exec(v);
    if (m) out[name] = m[0];
  }
  return out;
}

function osRelease(): { name: string; version: string } {
  try {
    const t = readFileSync("/etc/os-release", "utf8");
    const g = (k: string) => new RegExp(`^${k}="?([^"\\n]*)"?`, "m").exec(t)?.[1] ?? "";
    return { name: g("NAME") || "Linux", version: g("VERSION_ID") };
  } catch {
    return { name: process.platform, version: "" };
  }
}

async function detectGpu(): Promise<Capabilities["gpu"]> {
  let model = "";
  try { model = readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, ""); } catch { /* not a device-tree machine */ }
  if (existsSync("/etc/nv_tegra_release") || /jetson|tegra|orin/i.test(model)) {
    // Jetson uses unified memory; the GPU can address a large share of system RAM.
    return { present: true, kind: "jetson", name: model || "NVIDIA Jetson", vramMb: Math.round((totalmem() / 1048576) * 0.6) };
  }
  if (process.platform === "darwin" && arch() === "arm64") {
    // Apple Silicon has unified memory and Ollama uses Metal; the GPU can address roughly two thirds of system RAM.
    return { present: true, kind: "apple", name: cpus()[0]?.model ?? "Apple Silicon", vramMb: Math.round((totalmem() / 1048576) * 0.66) };
  }
  const smi = await sh("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  if (smi) {
    const vram = await sh("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
    const vramMb = vram ? Math.max(...vram.split("\n").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x))) : undefined;
    return { present: true, kind: "nvidia", name: smi.split("\n")[0], ...(vramMb ? { vramMb } : {}) };
  }
  return { present: false };
}

export interface InferenceProbe { url: string; models: { name: string; sizeMb?: number; digest?: string }[] }

/** Asks Ollama which models it has. Never loads one. */
export async function probeOllama(urls: string[], fetchFn: typeof fetch = fetch): Promise<InferenceProbe | null> {
  for (const u of urls) {
    try {
      const r = await fetchFn(`${u.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { models?: { name: string; size?: number; digest?: string }[] };
      return { url: u, models: (j.models ?? []).map((m) => ({ name: m.name, digest: m.digest, ...(m.size ? { sizeMb: Math.round(m.size / 1048576) } : {}) })) };
    } catch { /* try the next address */ }
  }
  return null;
}

export async function runningModels(caps: Capabilities | null, fetchFn: typeof fetch = fetch): Promise<NonNullable<Heartbeat["loadedModels"]>> {
  if (!caps?.inference) return [];
  try {
    const res = await fetchFn(`${caps.inference.url.replace(/\/+$/, "")}/api/ps`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return [];
    const data = await res.json() as { models?: { name: string; digest: string; size: number; size_vram: number; context_length: number }[] };
    const discrete = caps.gpu.present && caps.gpu.kind !== "jetson" && caps.gpu.kind !== "apple";
    return (data.models ?? []).filter((m) => typeof m.name === "string" && typeof m.digest === "string" && Number.isFinite(m.size) && Number.isFinite(m.context_length))
      .map((m) => ({ name: m.name, digest: m.digest, context: m.context_length, ramMb: Math.max(0, Math.floor((m.size - (discrete ? m.size_vram || 0 : 0)) / 1048576)) }));
  } catch { return []; }
}

export function networks(ts: string | null, inspect: typeof networkInterfaces = networkInterfaces): Capabilities["networks"] {
  const out: Capabilities["networks"] = [];
  if (ts) out.push({ provider: "tailscale", address: ts });
  let interfaces: ReturnType<typeof networkInterfaces>;
  try { interfaces = inspect(); } catch { return out; } // Restricted containers may deny interface enumeration.
  for (const list of Object.values(interfaces)) for (const a of list ?? []) {
    if (a.internal || a.family !== "IPv4" || a.address === ts) continue;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push({ provider: "lan", address: a.address });
    else if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) out.push({ provider: "other", address: a.address });
  }
  return out;
}

export async function tailscaleIp(): Promise<string | null> {
  // The macOS app keeps its command line tool inside the app bundle, off PATH.
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    const ip = (await sh(bin, ["ip", "-4"]))?.split("\n")[0]?.trim();
    if (ip) return ip;
  }
  return null;
}

export async function detectCapabilities(o: { workspaceRoot: string; ollamaUrl: string; maxContext: number | null; setupMode?: "pin" | "self" | null; stateDir?: string }): Promise<Capabilities> {
  const ts = await tailscaleIp();
  const candidates = [o.ollamaUrl, process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith("http") ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : "", "http://127.0.0.1:11434", ts ? `http://${ts}:11434` : ""].filter(Boolean);
  const [tools, gpu, inf] = await Promise.all([detectTools(), detectGpu(), probeOllama(candidates)]);
  const storage: Capabilities["storage"] = [];
  for (const p of new Set([existsSync(o.workspaceRoot) ? o.workspaceRoot : "/"])) {
    try { const s = statfsSync(p); storage.push({ path: p, totalGb: Math.round((s.blocks * s.bsize) / 1e9), freeGb: Math.round((s.bavail * s.bsize) / 1e9) }); } catch { /* unreadable */ }
  }
  const c = cpus();
  const os = osRelease();
  const memory = memorySnapshot();
  const limits = workerLimits({ memMb: memory.totalMb, cpu: { model: "", cores: c.length } });
  const user = userInfo().username;
  const uid = process.getuid?.() ?? null;
  const qualifications = (o.stateDir ? readQualifications(o.stateDir) : []).filter((q) =>
    q.executedAs === `${uid}:${user}` && q.aiderVersion === tools.aider &&
    inf?.models.some((m) => m.name === q.model && m.digest === q.digest) &&
    q.maxContext === Math.min(o.maxContext ?? 4096, codingProfile(q.model)?.maxContext ?? Infinity));
  return {
    os, arch: arch() === "x64" ? "amd64" : arch() === "arm64" ? "arm64" : arch(), hostname: hostname(), cpu: { model: c[0]?.model ?? "unknown", cores: c.length }, memMb: memory.totalMb,
    memory, execution: { user, uid, ...limits },
    gpu, storage, tools, inference: inf ? { runtime: "ollama", url: inf.url, models: inf.models, maxContext: o.maxContext ?? 4096, qualifications } : null, networks: networks(ts), workspaceRoot: o.workspaceRoot,
    ...(o.setupMode ? { setupMode: o.setupMode } : {}),
  };
}

export const vitals = () => { const m = memorySnapshot(); return { loadAvg: loadavg()[0] ?? null, freeMemMb: m.availableMb, swapUsedMb: m.swapUsedMb }; };
