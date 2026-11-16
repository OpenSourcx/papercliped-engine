/**
 * Runs deploy/epaperclip-mcp-check.sh for real against the real relay and a fake engine. Only the Proxmox pieces are stand-ins:
 * `pct exec` runs the command on this machine (so "inside the container" is here), and `ss` and `sshd -T` print what a host would.
 */
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMcpRelay, type McpRelay } from "../src/mcp-relay.js";
import { hasBinary } from "./helpers.js";

const run = promisify(execFile);
const script = path.resolve(__dirname, "../../../deploy/epaperclip-mcp-check.sh");
const TOKEN = "run-token-SECRET";
let dir: string, engine: http.Server, relay: McpRelay, bin: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "mcp-check-"));
  bin = path.join(dir, "bin"); mkdirSync(bin);
  engine = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"unauthorized"}'); }
      const id = (JSON.parse(b || "{}") as { id?: number }).id ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [{ name: "connections_search" }, { name: "connection_request" }] } }));
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
  relay = await startMcpRelay({ target: `http://127.0.0.1:${(engine.address() as AddressInfo).port}` });
});
afterEach(async () => { await relay.close(); await new Promise<void>((r) => engine.close(() => r())); rmSync(dir, { recursive: true, force: true }); });

function fakes(opts: { listen?: string; sshd?: string; running?: boolean } = {}) {
  const w = (name: string, body: string) => { writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
  w("pct", `case "$1" in
  status) echo "status: ${opts.running === false ? "stopped" : "running"}" ;;
  config) echo "tags: epaperclip" ;;
  exec) shift; shift; shift; exec "$@" ;;
esac`);
  w("ss", `echo "LISTEN 0 511 ${opts.listen ?? "127.0.0.1:" + relay.port} 0.0.0.0:*"`);
  w("sshd", `echo "${opts.sshd ?? "allowtcpforwarding remote\\npermitlisten 127.0.0.1:" + relay.port}"`);
  w("timeout", 'shift; exec "$@"');
  w("id", 'echo 0');
  // The retained run config the script reads its token from.
  const runDir = path.join(dir, "engine", "companies", "c", "agents", "a", "claude-runtime", "runs", "run-1", "mcp"); mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "mcp-config.json"), JSON.stringify({ mcpServers: {
    "Paperclip connections": { type: "http", url: `http://127.0.0.1:3100/mcp/runtime-tools`, headers: { Authorization: `Bearer ${TOKEN}` } },
    "Paperclip projects": { type: "http", url: `http://127.0.0.1:3100/api/mcp/project-tools`, headers: { Authorization: `Bearer ${TOKEN}` } } } }));
  mkdirSync(path.join(dir, "prefix", "plugins", "proxmox-sandbox", "dist"), { recursive: true });
  for (const f of ["mcp-relay.js", "mcp-tunnel.js"]) writeFileSync(path.join(dir, "prefix", "plugins", "proxmox-sandbox", "dist", f), "");
  writeFileSync(path.join(dir, "prefix", "VERSION"), "1.0.3-rc1\n");
}
const go = async (...args: string[]) => {
  try { const r = await run("bash", [script, "101", ...args], { env: { PATH: `${bin}:${process.env.PATH}`, EPC_PREFIX: path.join(dir, "prefix"), EPC_ENGINE_HOME: path.join(dir, "engine"), EPC_ENGINE_PORT: String(relay.port), HOME: dir }, timeout: 60_000 }); return { code: 0, out: r.stdout }; }
  catch (e) { const x = e as { code?: number; stdout?: string; stderr?: string }; return { code: x.code ?? 1, out: (x.stdout ?? "") + (x.stderr ?? "") }; }
};

describe.skipIf(!hasBinary("curl") || process.getuid?.() !== 0)("epaperclip-mcp-check.sh", () => {
  it("passes against the real relay, with the run's own token, without printing it", async () => {
    fakes();
    const r = await go("--run", "run-1");
    expect(r.out).not.toContain(TOKEN);
    expect(r.out).toContain("RESULT: PASS");
    expect(r.out).toMatch(/GET \/api\/health from the container: 404/);
    expect(r.out).toMatch(/POST \/mcp\/runtime-tools with no token: 401/);
    expect(r.out).toMatch(/POST \/api\/mcp\/project-tools tools\/list with the run's token: 200, 2 tools: connections_search, connection_request/);
    expect(r.code).toBe(0);
  });

  it("without a token it still shows both routes reach the engine's own authentication", async () => {
    fakes();
    const r = await go();
    expect(r.out).toContain("RESULT: PASS");
    expect(r.out).toContain("skipped (no token given)");
  });

  it("reports an expired token as reaching the engine, not as a failure of the route", async () => {
    fakes();
    const dirRun = path.join(dir, "engine", "companies", "c", "agents", "a", "claude-runtime", "runs", "run-1", "mcp", "mcp-config.json");
    writeFileSync(dirRun, JSON.stringify({ mcpServers: { x: { url: "http://127.0.0.1:3100/mcp/runtime-tools", headers: { Authorization: "Bearer old" } } } }));
    const r = await go("--run", "run-1");
    expect(r.out).toMatch(/tools\/list: 401 \(the run's token is revoked or expired/);
    expect(r.out).toContain("RESULT: PASS");
  });

  it("fails when the engine port is open beyond loopback, or sshd is not set, or the container is stopped", async () => {
    fakes({ listen: "0.0.0.0:" + relay.port });
    expect((await go()).out).toMatch(/FAIL {2}port \d+ is not loopback-only/);
    fakes({ sshd: "allowtcpforwarding no" });
    expect((await go()).out).toMatch(/FAIL {2}its sshd is not set for the forward/);
    fakes({ running: false });
    const stopped = await go();
    expect(stopped.out).toMatch(/is not running/);
    expect(stopped.code).toBe(1);
  });

  it("fails when a route is not forwarded", async () => {
    fakes();
    await relay.close();
    relay = { port: relay.port, close: async () => undefined };
    // Nothing listens any more: the container sees a dead port.
    const r = await go();
    expect(r.out).toMatch(/FAIL/);
    expect(r.code).toBe(1);
  });
});
