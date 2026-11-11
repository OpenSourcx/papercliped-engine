import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Capabilities } from "@papercliped-engine/worker-fabric";
import { WorkerClient, VERSION, type Status } from "./client.ts";
import { detectCapabilities } from "./caps.ts";
import { WorkerFiles } from "./config.ts";
import { hasCommand, ollamaInstall } from "./platform.ts";
import { bestModel, recommendModels, usableMemory } from "@papercliped-engine/worker-fabric";

const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) => {
  const p = spawn(cmd, args, { stdio: "inherit" });
  p.on("error", rej);
  p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${String(code)}`))));
});

const files = new WorkerFiles();
const [, , cmd = "help", ...rest] = process.argv;
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };

function printDevice(caps: Capabilities) {
  console.log(`  host      ${caps.hostname} · ${caps.os.name} ${caps.os.version} ${caps.arch}`);
  console.log(`  cpu       ${caps.cpu.model} · ${caps.cpu.cores} cores`);
  console.log(`  memory    ${caps.memMb} MiB`);
  console.log(`  gpu       ${caps.gpu.present ? `${caps.gpu.name}${caps.gpu.vramMb ? ` · ${(caps.gpu.vramMb / 1024).toFixed(1)} GB` : ""}` : "none detected"}`);
  console.log(`  disk      ${caps.storage.map((s) => `${s.path} ${s.freeGb}/${s.totalGb} GB free`).join(", ") || "unknown"}`);
  console.log(`  ollama    ${caps.inference ? `${caps.inference.url} · ${caps.inference.models.length} model(s)` : "not found"}`);
}

function printRecommendations(caps: Capabilities) {
  const { vramGb, ramGb } = usableMemory(caps);
  const recs = recommendModels(caps);
  console.log(`\nModels for this worker (usable ~${Math.round(ramGb)} GB RAM${caps.gpu.present ? `, ~${Math.round(vramGb)} GB VRAM` : ""})`);
  const fits = recs.filter((r) => r.fit !== "too_big");
  if (fits.length === 0) {
    console.log("  No catalogue model fits this machine. Add RAM/disk or run a smaller worker.");
  }
  for (const r of fits) {
    console.log(`  [${r.fit === "gpu" ? "GPU" : "CPU"}] ${r.spec.id.padEnd(20)} ~${r.spec.sizeGb} GB · ${r.reason}`);
  }
  const tooBig = recs.find((r) => r.fit === "too_big");
  if (tooBig) console.log(`  largest skipped: ${tooBig.spec.id} — ${tooBig.reason}`);
  const best = bestModel(caps);
  if (best.fit !== "too_big") console.log(`\nSuggested first pull: ${best.spec.id} — ${best.spec.note}`);
}

async function main() {
  switch (cmd) {
    case "run": {
      const client = new WorkerClient({ files, log });
      client.onStatus = (s: Status) => { try { writeFileSync(join(files.dir, "status.json"), JSON.stringify({ ...s, at: Date.now(), version: VERSION, pid: process.pid })); } catch { /* status is best effort */ } };
      await client.start();
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { client.stop(); setTimeout(() => process.exit(0), 300); });
      return;
    }
    case "adopt": {
      const code = rest.find((a) => !a.startsWith("--"));
      const c = new WorkerClient({ files, log });
      if (code) c.adopt(code);
      else if (flag("url") && flag("host-key")) c.requestAdoption(flag("host-key")!, [{ provider: flag("provider") ?? "custom", url: flag("url")! }]);
      else throw new Error("Usage: epaperclip-worker adopt <pairing code>\n   or: epaperclip-worker adopt --url ws://host:7843/fabric/v1/connect --host-key <key shown in the console>");
      const name = flag("name");
      if (name) { const cfg = files.config(); cfg.name = name; files.saveConfig(cfg); }
      console.log("Saved. The worker service connects within a few seconds; approve it in the ePaperclip console if asked.\nCheck progress with: epaperclip-worker status");
      return;
    }
    case "status": {
      const f = join(files.dir, "status.json");
      const cfg = files.config();
      const s = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Status & { at: number; version: string }) : null;
      console.log(`ePaperclip Worker ${VERSION}`);
      console.log(`  worker id : ${cfg.workerId ?? "(not adopted)"}`);
      console.log(`  state     : ${s ? s.state : "unknown (service not running?)"}${s?.detail ? ` - ${s.detail}` : ""}`);
      if (s?.verification) console.log(`  verification code: ${s.verification}`);
      console.log(`  last update: ${s ? new Date(s.at).toISOString() : "-"}`);
      console.log(`  endpoints : ${cfg.endpoints.map((e) => `${e.provider} ${e.url}`).join(", ") || "-"}`);
      return;
    }
    case "caps": {
      const c = files.config();
      console.log(JSON.stringify(await detectCapabilities({ workspaceRoot: c.workspaceRoot, ollamaUrl: c.ollamaUrl, maxContext: c.inference.maxContext, setupMode: c.setupMode }), null, 2));
      return;
    }
    case "recommend":
    case "models": {
      const c = files.config();
      const caps = await detectCapabilities({ workspaceRoot: c.workspaceRoot, ollamaUrl: c.ollamaUrl, maxContext: c.inference.maxContext, setupMode: c.setupMode });
      printDevice(caps);
      printRecommendations(caps);
      return;
    }
    case "setup": {
      const c = files.config();
      const caps = await detectCapabilities({ workspaceRoot: c.workspaceRoot, ollamaUrl: c.ollamaUrl, maxContext: c.inference.maxContext, setupMode: c.setupMode });
      const model = flag("model") ?? bestModel(caps).spec.id;
      const installOllama = rest.includes("--install-ollama");
      const pull = rest.includes("--pull");
      const adoptCode = flag("adopt");
      const name = flag("name");
      const ollamaUrl = flag("ollama-url");
      let mode = flag("mode");
      if (mode && mode !== "pin" && mode !== "self") throw new Error("--mode must be pin or self");
      if (!mode) {
        if (process.stdin.isTTY) {
          const { createInterface } = await import("node:readline/promises");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          console.log("\nHow should this machine be set up?");
          console.log("  1) Let Pin set it up — Pin installs Ollama and a fitting model with your approval");
          console.log("  2) Guide me — Pin walks me through each command; I run it");
          const answer = (await rl.question("Choose [1]: ")).trim();
          rl.close();
          mode = answer === "2" || /self|guide/i.test(answer) ? "self" : "pin";
        } else {
          // Non-interactive runs get the least-privileged mode. Pin-managed installs must be chosen: --mode pin.
          mode = "self";
        }
      }
      c.setupMode = mode as "pin" | "self";
      console.log("ePaperclip worker setup\n");
      console.log(`  host      ${caps.hostname} · ${caps.os.name} ${caps.os.version} ${caps.arch}`);
      console.log(`  cpu       ${caps.cpu.model} · ${caps.cpu.cores} cores`);
      console.log(`  memory    ${caps.memMb} MiB`);
      console.log(`  gpu       ${caps.gpu.present ? `${caps.gpu.name}${caps.gpu.vramMb ? ` · ${(caps.gpu.vramMb / 1024).toFixed(1)} GB` : ""}` : "none detected"}`);
      console.log(`  disk      ${caps.storage.map((s) => `${s.path} ${s.freeGb}/${s.totalGb} GB free`).join(", ") || "unknown"}`);
      console.log(`  ollama    ${caps.inference ? `${caps.inference.url} · ${caps.inference.models.length} model(s)` : "not found"}`);
      console.log("");
      printRecommendations(caps);
      console.log(`\nSetup authority: ${mode === "pin" ? "Pin installs with your approval" : "you run the steps; Pin guides"}`);
      console.log("\nPlan");
      if (mode === "pin") {
        console.log("  1. pair with ePaperclip/Pin using the code from Workers");
        console.log(`  2. Pin installs Ollama if needed and pulls ${model} with your approval`);
        console.log("  3. Pin verifies the result and creates the worker environment");
        console.log("  4. approve the worker; Pin can then schedule agents here.");
      } else {
        if (!caps.tools.ollama) console.log(`  1. install Ollama${installOllama ? " (running now)" : `: ${ollamaInstall(process.platform, hasCommand("brew")).command}`}`);
        else console.log("  1. Ollama is already installed");
        console.log(`  2. pull a model${pull ? " (running now)" : ""}: ollama pull ${model}`);
        console.log("  3. pair with ePaperclip/Pin: epaperclip-worker adopt <code from Workers>");
        console.log("  4. approve the worker; Pin can then schedule agents here.");
      }
      if (installOllama) {
        if (caps.tools.ollama) console.log("Ollama is already installed; skipping.");
        else {
          const how = ollamaInstall(process.platform, hasCommand("brew"));
          if (!how.automatic) throw new Error(`Install Ollama yourself: ${how.command}`);
          if (how.needsRoot && process.getuid?.() !== 0) throw new Error("Installing Ollama needs root; run with sudo or install it yourself.");
          await run("sh", ["-c", how.command]);
        }
      }
      if (ollamaUrl) {
        if (!/^https?:\/\//.test(ollamaUrl)) throw new Error("ollama-url must start with http:// or https://");
        c.ollamaUrl = ollamaUrl;
      }
      if (name) c.name = name;
      files.saveConfig(c);
      if (pull) {
        if (!caps.tools.ollama) throw new Error("Ollama is not installed yet; install it first or omit --pull.");
        await run("ollama", ["pull", model]);
      }
      if (adoptCode) {
        new WorkerClient({ files, log }).adopt(adoptCode);
        console.log("Adopted. Open Workers in ePaperclip/Pin and approve it if asked.");
      }
      return;
    }
    case "diagnose": {
      const c = files.config();
      let bad = 0;
      const row = (ok: boolean, m: string) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${m}`); };
      row(Number(process.versions.node.split(".")[0]) >= 22, `node ${process.version} (needs 22 or newer)`);
      const idf = join(files.dir, "identity.json");
      row(existsSync(idf) ? (statSync(idf).mode & 0o077) === 0 : true, existsSync(idf) ? "identity.json is private (0600)" : "no identity yet (created on first run)");
      row(existsSync(c.workspaceRoot), `workspace root ${c.workspaceRoot} exists`);
      row(!!c.hostKey, c.hostKey ? "paired with a host" : "not paired: run `epaperclip-worker adopt <code>`");
      console.log(`     setup mode: ${c.setupMode ?? "not chosen"}`);
      for (const e of c.endpoints) {
        const u = e.url.replace(/^ws/, "http").replace(/\/fabric\/v1\/connect$/, "/fabric/v1/health");
        const ok = await fetch(u, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false);
        row(ok, `${e.provider} endpoint ${e.url} ${ok ? "reachable" : "not reachable"}`);
      }
      const caps = await detectCapabilities({ workspaceRoot: c.workspaceRoot, ollamaUrl: c.ollamaUrl, maxContext: c.inference.maxContext, setupMode: c.setupMode });
      console.log(`     ${caps.os.name} ${caps.os.version} ${caps.arch}, ${caps.cpu.cores} cores, ${caps.memMb} MiB, gpu: ${caps.gpu.present ? caps.gpu.name : "none"}`);
      console.log(`     tools: ${Object.entries(caps.tools).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
      console.log(`     inference: ${caps.inference ? `${caps.inference.url} models ${caps.inference.models.map((m) => m.name).join(", ")}` : "no Ollama found"}`);
      process.exitCode = bad ? 1 : 0;
      return;
    }
    case "config": {
      // epaperclip-worker config name=Orion ollamaUrl=http://100.93.29.26:11434 maxContext=4096 slots=1
      const c = files.config();
      const num = (v: string, what: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a whole number of at least 1`); return n; };
      for (const kv of rest) {
        const i = kv.indexOf("=");
        if (i < 1) throw new Error("Usage: epaperclip-worker config key=value ... (name, ollamaUrl, prefer, workspaceRoot, maxContext, slots, gatePort)");
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (k === "name") c.name = v;
        else if (k === "ollamaUrl") { if (v && !/^https?:\/\//.test(v)) throw new Error("ollamaUrl must start with http:// or https://"); c.ollamaUrl = v; }
        else if (k === "prefer") c.prefer = v || null;
        else if (k === "workspaceRoot") { if (!v.startsWith("/")) throw new Error("workspaceRoot must be an absolute path"); c.workspaceRoot = v; }
        else if (k === "maxContext") c.inference.maxContext = v ? num(v, k) : null;
        else if (k === "slots") c.inference.slots = num(v, k);
        else if (k === "gatePort") c.inference.gatePort = num(v, k);
        else throw new Error(`Unknown setting ${k}`);
      }
      files.saveConfig(c);
      console.log(JSON.stringify({ name: c.name, ollamaUrl: c.ollamaUrl, prefer: c.prefer, workspaceRoot: c.workspaceRoot, inference: c.inference }, null, 2));
      return;
    }
    case "version":
      console.log(VERSION);
      return;
    default:
      console.log("epaperclip-worker <run|adopt|status|config|diagnose|caps|recommend|setup|version>");
  }
}
void chmodSync;
main().catch((e) => { console.error((e as Error).message); process.exit(1); });
