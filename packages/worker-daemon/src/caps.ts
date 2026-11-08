import { execFile } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { arch, cpus, freemem, hostname, loadavg, networkInterfaces, totalmem } from "node:os";
import type { Capabilities } from "@papercliped-engine/worker-fabric";

/** What this machine is and can do. Everything is detected, nothing is assumed; a missing tool is simply absent. */

const sh = (cmd: string, args: string[], ms = 4000) =>
  new Promise<string | null>((res) => execFile(cmd, args, { timeout: ms, maxBuffer: 1 << 20 }, (e, out, err) => res(e ? null : String(out || err).trim())));

const TOOLS: [string, string[]][] = [["git", ["--version"]], ["gh", ["--version"]], ["node", ["--version"]], ["npm", ["--version"]], ["pnpm", ["--version"]], ["python3", ["--version"]], ["uv", ["--version"]], ["docker", ["--version"]], ["make", ["--version"]], ["gcc", ["--version"]], ["cargo", ["--version"]], ["ollama", ["--version"]], ["epaperclip-aider", ["--version"]]];

export async function detectTools(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(TOOLS.map(async ([t, a]) => {
    const v = await sh(t, a);
    const m = v ? /\d+\.\d+(\.\d+)?/.exec(v) : null;
    if (m) out[t === "python3" ? "python" : t === "epaperclip-aider" ? "aider" : t] = m[0];
  }));
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
  if (existsSync("/etc/nv_tegra_release") || /jetson|tegra|orin/i.test(model)) return { present: true, kind: "jetson", name: model || "NVIDIA Jetson" };
  const smi = await sh("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  if (smi) return { present: true, kind: "nvidia", name: smi.split("\n")[0] };
  return { present: false };
}

export interface InferenceProbe { url: string; models: { name: string; sizeMb?: number }[] }

/** Asks Ollama which models it has. Never loads one. */
export async function probeOllama(urls: string[], fetchFn: typeof fetch = fetch): Promise<InferenceProbe | null> {
  for (const u of urls) {
    try {
      const r = await fetchFn(`${u.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { models?: { name: string; size?: number }[] };
      return { url: u, models: (j.models ?? []).map((m) => ({ name: m.name, ...(m.size ? { sizeMb: Math.round(m.size / 1048576) } : {}) })) };
    } catch { /* try the next address */ }
  }
  return null;
}

export function networks(ts: string | null): Capabilities["networks"] {
  const out: Capabilities["networks"] = [];
  if (ts) out.push({ provider: "tailscale", address: ts });
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) {
    if (a.internal || a.family !== "IPv4" || a.address === ts) continue;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push({ provider: "lan", address: a.address });
    else if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) out.push({ provider: "other", address: a.address });
  }
  return out;
}

export async function tailscaleIp(): Promise<string | null> {
  return (await sh("tailscale", ["ip", "-4"]))?.split("\n")[0]?.trim() || null;
}

export async function detectCapabilities(o: { workspaceRoot: string; ollamaUrl: string; maxContext: number | null }): Promise<Capabilities> {
  const ts = await tailscaleIp();
  const candidates = [o.ollamaUrl, process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith("http") ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : "", "http://127.0.0.1:11434", ts ? `http://${ts}:11434` : ""].filter(Boolean);
  const [tools, gpu, inf] = await Promise.all([detectTools(), detectGpu(), probeOllama(candidates)]);
  const storage: Capabilities["storage"] = [];
  for (const p of new Set([existsSync(o.workspaceRoot) ? o.workspaceRoot : "/"])) {
    try { const s = statfsSync(p); storage.push({ path: p, totalGb: Math.round((s.blocks * s.bsize) / 1e9), freeGb: Math.round((s.bavail * s.bsize) / 1e9) }); } catch { /* unreadable */ }
  }
  const c = cpus();
  const os = osRelease();
  return {
    os, arch: arch() === "x64" ? "amd64" : arch() === "arm64" ? "arm64" : arch(), hostname: hostname(), cpu: { model: c[0]?.model ?? "unknown", cores: c.length }, memMb: Math.round(totalmem() / 1048576),
    gpu, storage, tools, inference: inf ? { runtime: "ollama", url: inf.url, models: inf.models, ...(o.maxContext ? { maxContext: o.maxContext } : {}) } : null, networks: networks(ts), workspaceRoot: o.workspaceRoot,
  };
}

export const vitals = () => ({ loadAvg: loadavg()[0] ?? null, freeMemMb: Math.round(freemem() / 1048576) });
