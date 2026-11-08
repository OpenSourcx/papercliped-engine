import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkerClient, VERSION, type Status } from "./client.ts";
import { detectCapabilities } from "./caps.ts";
import { WorkerFiles } from "./config.ts";
import { StatsCollector } from "./stats.ts";
import { createHash } from "node:crypto";
import { LIMITS, manageMessage, verifyRaw, type ManageEnvelope } from "@papercliped-engine/worker-fabric";

const files = new WorkerFiles();
const [, , cmd = "help", ...rest] = process.argv;
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };

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
      console.log(JSON.stringify(await detectCapabilities({ workspaceRoot: c.workspaceRoot, ollamaUrl: c.ollamaUrl, maxContext: c.inference.maxContext }), null, 2));
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
      for (const e of c.endpoints) {
        const u = e.url.replace(/^ws/, "http").replace(/\/fabric\/v1\/connect$/, "/fabric/v1/health");
        const ok = await fetch(u, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false);
        row(ok, `${e.provider} endpoint ${e.url} ${ok ? "reachable" : "not reachable"}`);
      }
      const caps = await detectCapabilities({ workspaceRoot: c.workspaceRoot, ollamaUrl: c.ollamaUrl, maxContext: c.inference.maxContext });
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
    case "stats": {
      const c = files.config();
      const col = new StatsCollector({}, () => ({ workspaceRoot: c.workspaceRoot, ollamaUrls: [c.ollamaUrl, "http://127.0.0.1:11434"].filter(Boolean), gate: () => null, pulls: () => [] }));
      await col.collect();
      await new Promise((r) => setTimeout(r, 500));
      console.log(JSON.stringify(await col.collect(), null, 2));
      return;
    }
    case "verify-update": {
      // Used by the root helper (epw-admin) before it installs anything: --pub FILE (host key, root-owned) --request FILE --tarball FILE --worker-id ID
      const rd = (n: string) => { const v = flag(n); if (!v) throw new Error(`--${n} is required`); return v; };
      const pub = readFileSync(rd("pub"), "utf8").trim();
      const env = JSON.parse(readFileSync(rd("request"), "utf8")) as ManageEnvelope;
      const sha = createHash("sha256").update(readFileSync(rd("tarball"))).digest("hex");
      const fail = (m: string) => { console.error(`refused: ${m}`); process.exit(2); };
      if (env.action !== "update") fail("not an update request");
      if (env.workerId !== rd("worker-id")) fail("request is for another worker");
      if (!verifyRaw(pub, Buffer.from(manageMessage(env)), env.sig)) fail("signature is not from the pinned host key");
      if (Math.abs(Date.now() - env.ts) > 10 * 60_000 + LIMITS.manageSkewMs) fail("request is too old");
      if (env.params.sha256 !== sha) fail("tarball does not match the signed checksum");
      console.log("ok");
      return;
    }
    case "version":
      console.log(VERSION);
      return;
    default:
      console.log("epaperclip-worker <run|adopt|status|config|diagnose|caps|stats|verify-update|version>");
  }
}
void chmodSync;
main().catch((e) => { console.error((e as Error).message); process.exit(1); });
