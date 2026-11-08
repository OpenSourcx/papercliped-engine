import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateIdentity, manageMessage, signWith, type ManageAction, type ManageEnvelope } from "@papercliped-engine/worker-fabric";
import { WorkerFiles } from "../src/config.ts";
import { Manager, ManageError } from "../src/manage.ts";

const host = generateIdentity();
function setup(o: { fetchFn?: typeof fetch; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "epw-mgr-"));
  const files = new WorkerFiles(dir);
  const c = files.config();
  c.hostKey = host.publicKey; c.workerId = "wrk_aaaaaaaaaaaa";
  files.saveConfig(c);
  const calls: string[][] = [];
  const admin = join(dir, "epw-admin");
  writeFileSync(admin, "#!/bin/sh\n");
  const m = new Manager({ files, ollamaUrl: () => "http://127.0.0.1:11434", now: o.now ?? Date.now, fetchFn: o.fetchFn, adminPath: admin, exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, out: "line1\nline2" }; }, freeGb: () => 50, statsNow: async () => ({ at: 1 }) as never });
  return { m, calls, dir };
}
let n = 0;
const sign = (action: ManageAction, params: Record<string, unknown> = {}, over: Partial<ManageEnvelope> = {}, key = host): ManageEnvelope => {
  const e = { action, params, workerId: "wrk_aaaaaaaaaaaa", ts: Date.now(), nonce: `nonce-${++n}-abcdef`, ...over };
  return { ...e, sig: signWith(key, Buffer.from(manageMessage(e))) };
};

describe("host-signed management", () => {
  it("accepts a signed request once and refuses replay", async () => {
    const { m } = setup();
    const e = sign("logs", { unit: "ollama", lines: 20 });
    expect(await m.handle(e)).toMatchObject({ unit: "ollama", text: "line1\nline2" });
    await expect(m.handle(e)).rejects.toThrow(/already used/);
  });
  it("refuses wrong key, wrong worker, tampered params and stale time", async () => {
    const { m } = setup();
    await expect(m.handle(sign("logs", { unit: "ollama" }, {}, generateIdentity()))).rejects.toThrow(/not signed by the host/);
    await expect(m.handle(sign("logs", { unit: "ollama" }, { workerId: "wrk_bbbbbbbbbbbb" }))).rejects.toThrow(/different worker/);
    await expect(m.handle(sign("logs", { unit: "ollama" }, { ts: Date.now() - 10 * 60_000 }))).rejects.toThrow(/stale/);
    const t = sign("logs", { unit: "ollama" });
    await expect(m.handle({ ...t, params: { unit: "worker" } })).rejects.toThrow(/not signed/);
  });
  it("only fixed actions with validated parameters", async () => {
    const { m, calls } = setup();
    await expect(m.handle(sign("logs", { unit: "sshd" }))).rejects.toThrow(/unit must be/);
    await expect(m.handle(sign("model-pull", { name: "x; rm -rf /" }))).rejects.toThrow(/valid model name/);
    await expect(m.handle(sign("model-remove", { name: "$(id)" }))).rejects.toThrow(/valid model name/);
    await expect(m.handle(sign("bogus" as ManageAction))).rejects.toThrow(/unknown action/);
    await expect(m.handle(sign("update", { url: "http://x/y.tgz", sha256: "a".repeat(64) }))).rejects.toThrow(/https/);
    expect(calls).toEqual([]);
  });
  it("restarts through the sudo helper by exact verb", async () => {
    const { m, calls } = setup();
    expect(await m.handle(sign("restart-ollama"))).toEqual({ done: true });
    expect(calls[0]).toEqual(["sudo", "-n", expect.stringMatching(/epw-admin$/), "restart-ollama"]);
  });
  it("says so when the helper is missing", async () => {
    const { m, dir } = setup();
    const f = new WorkerFiles(dir);
    const m2 = new Manager({ files: f, ollamaUrl: () => null, adminPath: join(dir, "nope") });
    await expect(m2.handle(sign("restart-worker"))).rejects.toBeInstanceOf(ManageError);
    void m;
  });
  it("pulls with progress and removes models through Ollama", async () => {
    const seen: string[] = [];
    const fetchFn: typeof fetch = async (u, init) => {
      seen.push(`${init?.method ?? "GET"} ${String(u)}`);
      if (String(u).endsWith("/api/pull")) return new Response('{"status":"pulling"}\n{"status":"pulling","total":100,"completed":50}\n{"status":"success"}\n');
      return new Response("{}");
    };
    const { m } = setup({ fetchFn });
    expect(await m.handle(sign("model-pull", { name: "qwen2.5-coder:3b" }))).toEqual({ started: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(m.pulls()).toEqual([{ name: "qwen2.5-coder:3b", pct: 100, status: "success", done: true }]);
    expect(await m.handle(sign("model-remove", { name: "qwen2.5-coder:3b" }))).toEqual({ removed: "qwen2.5-coder:3b" });
    expect(seen).toEqual(["POST http://127.0.0.1:11434/api/pull", "DELETE http://127.0.0.1:11434/api/delete"]);
  });
});
