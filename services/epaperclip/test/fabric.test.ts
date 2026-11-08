import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientHandshake, decodePairing, encodePairing, generateIdentity } from "@papercliped-engine/worker-fabric";
import { adoptOnline, control, newWorker, sleep, startHost, tmp, until, type Host, type Worker } from "./fabric-harness.ts";

const hosts: Host[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  for (const w of workers.splice(0)) w.client.stop();
  for (const h of hosts.splice(0)) await h.close();
});
const host = async (o: Parameters<typeof startHost>[0] = {}) => { const h = await startHost(o); hosts.push(h); return h; };
const worker = (o: Parameters<typeof newWorker>[0] = {}) => { const w = newWorker(o); workers.push(w); return w; };

describe("pairing and identity", () => {
  it("adopts a worker with a single-use code and records its capabilities", async () => {
    const h = await host();
    const w = worker();
    const id = await adoptOnline(h, w, "alpha");
    const view = h.hub.workers().find((x) => x.id === id)!;
    expect(view).toMatchObject({ name: "alpha", state: "adopted", online: true, capabilities: { arch: "arm64", gpu: { present: true } } });
    expect(view.fingerprint).toHaveLength(32);
    expect(JSON.stringify(h.hub.auditList().events)).toContain("worker.adopt");
    // The worker saves its id when it receives `ready`, a moment after the host counts it online.
    await until(() => w.files.config().workerId === id, 5000, "worker saved its id");
    expect(w.files.config().pairing).toBeNull();
  });

  it("rejects a replayed pairing code from another machine", async () => {
    const h = await host();
    const a = worker();
    const { code } = h.hub.createPairing("tester", { name: "one" });
    a.client.adopt(code);
    await a.client.start();
    await until(() => h.hub.workers().some((x) => x.online), 8000, "first adoption");
    const b = worker();
    b.client.adopt(code); // same code, different machine key
    await b.client.start();
    await until(() => h.hub.auditList().events.some((e) => e.action === "pairing.rejected"), 8000, "rejection");
    expect(h.hub.workers()).toHaveLength(1);
    expect(h.hub.pairings()).toMatchObject([{ state: "used", workerId: h.hub.workers()[0]!.id }]);
    expect(b.client.status.state).not.toBe("online");
  });

  it("rejects an expired pairing code and a wrong secret", async () => {
    let t = 1_000_000;
    const h = await host({ now: () => t });
    const { code } = h.hub.createPairing("tester");
    t += 16 * 60_000;
    const w = worker();
    w.client.adopt(code);
    await w.client.start();
    await until(() => h.hub.auditList().events.some((e) => e.action === "pairing.rejected"), 8000, "expired rejection");
    expect(h.hub.workers()).toHaveLength(0);
    w.client.stop();
    const h2 = await host();
    const { code: c2 } = h2.hub.createPairing("tester");
    const w2 = worker();
    w2.client.adopt(encodePairing({ ...decodePairing(c2), secret: "x".repeat(27) }));
    await w2.client.start();
    await sleep(600);
    expect(h2.hub.workers()).toHaveLength(0);
  });

  it("refuses a pairing code to a host that is not the pinned one (wrong host key)", async () => {
    const h = await host();
    const imposter = await host();
    const w = worker();
    const { code } = h.hub.createPairing("tester");
    w.client.adopt(code);
    // Point the worker at the imposter's address but keep the real host key pin.
    const c = w.files.config();
    c.endpoints = [{ provider: "custom", url: imposter.url }];
    w.files.saveConfig(c);
    await w.client.start();
    await sleep(700);
    expect(imposter.hub.workers()).toHaveLength(0);
    expect(w.client.status.state).not.toBe("online");
    expect(h.hub.workers()).toHaveLength(0);
  });

  it("rejects an unknown worker identity trying to authenticate", async () => {
    const h = await host();
    const w = worker();
    const c = w.files.config();
    c.hostKey = h.hub.hostKey().publicKey;
    c.endpoints = [{ provider: "custom", url: h.url }];
    c.workerId = "wrk_deadbeefcafe";
    w.files.saveConfig(c);
    await w.client.start();
    await until(() => h.hub.auditList().events.some((e) => e.action === "connect.unknown"), 8000, "unknown rejection");
    expect(h.hub.workers()).toHaveLength(0);
  });

  it("pending adoption needs a person: approve and deny", async () => {
    const h = await host();
    const w = worker({ name: "pending-one" });
    w.client.requestAdoption(h.hub.hostKey().publicKey, [{ provider: "custom", url: h.url }]);
    await w.client.start();
    const p = await until(() => h.hub.pendingList()[0], 8000, "pending request");
    expect(p.verification).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(w.client.status.verification ?? (await until(() => w.client.status.verification, 3000, "verification shown"))).toBe(p.verification);
    expect(h.hub.workers()).toHaveLength(0);
    h.hub.approvePending("admin", p.id, { name: "approved" });
    await until(() => h.hub.workers().find((x) => x.online && x.name === "approved"), 8000, "approved worker online");

    const w2 = worker({ name: "denied-one" });
    w2.client.requestAdoption(h.hub.hostKey().publicKey, [{ provider: "custom", url: h.url }]);
    await w2.client.start();
    const p2 = await until(() => h.hub.pendingList()[0], 8000, "second pending");
    h.hub.denyPending("admin", p2.id);
    await sleep(500);
    expect(h.hub.workers().filter((x) => x.name === "denied-one")).toHaveLength(0);
  });
});

describe("connection lifecycle", () => {
  it("reconnects after a dropped connection, a worker restart and a host restart", async () => {
    const stateDir = tmp("state");
    const h1 = await host({ stateDir });
    const port = Number(new URL(h1.url).port);
    const w = worker();
    const id = await adoptOnline(h1, w, "durable");
    // Worker restart
    w.client.stop();
    await until(() => !h1.hub.workers()[0]!.online, 5000, "offline after stop");
    const again = newWorker({ dir: w.dir });
    workers.push(again);
    await again.client.start();
    await until(() => h1.hub.workers()[0]!.online, 8000, "back online after worker restart");
    expect(h1.hub.workers()[0]!.id).toBe(id);
    // Host restart on the same port and state
    await h1.close();
    hosts.splice(hosts.indexOf(h1), 1);
    const h2 = await host({ stateDir, port });
    expect(h2.hub.hostKey().publicKey).toBe(h1.hub.hostKey().publicKey);
    await until(() => h2.hub.workers()[0]?.online, 10_000, "reconnected to restarted host");
    expect(h2.hub.workers()[0]!.id).toBe(id);
  });

  it("keeps an adopted worker working without any cloud service", async () => {
    // The host here has no Connect, no Papercliped and no internet dependency at all: adoption and operation are local.
    const h = await host();
    const w = worker();
    await adoptOnline(h, w, "local-only");
    expect(h.hub.workers()[0]!.online).toBe(true);
  });

  it("marks a silent worker offline", async () => {
    const h = await host({ hbMs: 200 });
    const w = worker();
    await adoptOnline(h, w, "quiet");
    w.client.stop();
    await until(() => !h.hub.workers()[0]!.online, 5000, "offline");
  });

  it("updates capabilities on refresh", async () => {
    const h = await host();
    const w = worker();
    const id = await adoptOnline(h, w, "caps");
    await h.hub.refresh(id);
    await until(() => h.hub.auditList().events.filter((e) => e.action === "caps.update").length >= 2, 5000, "second report");
  });
});

describe("revocation", () => {
  it("revoked identity is closed at once and can never reconnect, even after a host restart", async () => {
    const stateDir = tmp("state");
    const h = await host({ stateDir });
    const w = worker();
    const id = await adoptOnline(h, w, "doomed");
    h.hub.revoke("admin", id);
    await until(() => !h.hub.workers()[0]!.online, 5000, "disconnected");
    expect(h.hub.workers()[0]).toMatchObject({ state: "revoked" });
    await sleep(1200);
    expect(h.hub.workers()[0]!.online).toBe(false);
    await until(() => w.files.config().revoked, 5000, "worker recorded its revocation");
    // A fresh process with the same key files tries anyway.
    const port = Number(new URL(h.url).port);
    await h.close();
    hosts.splice(hosts.indexOf(h), 1);
    const h2 = await host({ stateDir, port });
    const clone = newWorker({ dir: w.dir });
    workers.push(clone);
    const c = clone.files.config();
    c.revoked = false; // even if the worker is tampered with to try again
    clone.files.saveConfig(c);
    await clone.client.start();
    await until(() => h2.hub.auditList().events.some((e) => e.action === "connect.revoked"), 8000, "revoked rejection after restart");
    expect(h2.hub.workers()[0]!.online).toBe(false);
    // Forgetting the record keeps the key on the deny list.
    h2.hub.forget("admin", id);
    await sleep(800);
    expect(h2.hub.workers()).toHaveLength(0);
  });

  it("will not forget a worker that was not revoked", async () => {
    const h = await host();
    const w = worker();
    const id = await adoptOnline(h, w, "live");
    expect(() => h.hub.forget("admin", id)).toThrow(/Revoke/);
  });
});

describe("leases, workspaces and execution", () => {
  async function setup(opts: { companies?: string[] | null } = {}) {
    const h = await host();
    const w = worker();
    const id = await adoptOnline(h, w, "exec", opts.companies ?? null);
    const token = h.hub.issueControlToken("co1");
    return { h, w, id, token };
  }
  const acquire = (h: Host, token: string, agent: string, extra: Record<string, unknown> = {}) =>
    control(h, token, "/control/v1/leases", { agentId: agent, runId: `run-${agent}-${Math.random().toString(36).slice(2, 8)}`, environmentId: "env1", ...extra });
  const exec = (h: Host, token: string, lease: string, body: Record<string, unknown>) => control(h, token, `/control/v1/leases/${lease}/exec`, body, true);

  it("runs shell commands with streamed output in an isolated workspace", async () => {
    const { h, w, token } = await setup();
    const a = await acquire(h, token, "agent-a");
    expect(a.status).toBe(201);
    expect(a.json.workspace).toContain("/co1/agent-a/");
    expect(existsSync(a.json.workspace)).toBe(true);
    const r = await exec(h, token, a.json.leaseId, { command: "sh", args: ["-c", "echo one; sleep 0.2; echo two >&2; pwd; exit 3"] });
    const out = r.lines.filter((l) => l.ev === "out");
    expect(out.map((l) => l.data).join("")).toContain("one");
    expect(out.find((l) => l.stream === "stderr")?.data).toContain("two");
    expect(out.map((l) => l.data).join("")).toContain(a.json.workspace);
    expect(r.lines.at(-1)).toMatchObject({ ev: "exit", exitCode: 3, timedOut: false });
    expect(w.root).toBeTruthy();
  });

  it("separates multiple logical agents and refuses a duplicate workspace lease", async () => {
    const { h, token } = await setup();
    const a = await acquire(h, token, "agent-a", { workspaceKey: "main" });
    const b = await acquire(h, token, "agent-b", { workspaceKey: "main" });
    expect(a.json.workspace).not.toBe(b.json.workspace);
    await exec(h, token, a.json.leaseId, { command: "sh", args: ["-c", "echo secret-a > file.txt"] });
    const read = await exec(h, token, b.json.leaseId, { command: "sh", args: ["-c", "ls; cat file.txt 2>&1 || true"] });
    expect(read.lines.map((l) => l.data ?? "").join("")).not.toContain("secret-a");
    const dup = await acquire(h, token, "agent-a", { workspaceKey: "main" });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe("lease_conflict");
    // A command is not pointed at another agent's folder; the rest of the machine is the agent's to use (the shell is not sandboxed).
    const out = await exec(h, token, a.json.leaseId, { command: "pwd", cwd: b.json.workspace });
    expect(out.lines.at(-1)).toMatchObject({ ev: "error", code: "outside_workspace" });
    const tmpRun = await exec(h, token, a.json.leaseId, { command: "pwd", cwd: "/tmp" });
    expect(tmpRun.lines.map((l) => l.data ?? "").join("")).toContain("/tmp");
    expect((await exec(h, token, a.json.leaseId, { command: "pwd", cwd: "relative/dir" })).lines.at(-1)).toMatchObject({ ev: "error", code: "bad_request" });
  });

  it("enforces shell capacity and frees it on release", async () => {
    const { h, id, token } = await setup();
    h.hub.updateWorker("admin", id, { shellSlots: 2 });
    const l1 = await acquire(h, token, "a1");
    const l2 = await acquire(h, token, "a2");
    const l3 = await acquire(h, token, "a3");
    expect(l3.status).toBe(409);
    expect(l3.json.code).toBe("no_capacity");
    await control(h, token, `/control/v1/leases/${l1.json.leaseId}/release`, {});
    const l4 = await acquire(h, token, "a3");
    expect(l4.status).toBe(201);
    expect(l2.status).toBe(201);
  });

  it("cancels a running command when the lease is stopped, and keeps the workspace", async () => {
    const { h, token } = await setup();
    const l = await acquire(h, token, "agent-c");
    const p = exec(h, token, l.json.leaseId, { command: "sh", args: ["-c", "echo started; sleep 30; echo never"] });
    await sleep(500);
    const t0 = Date.now();
    const stop = await control(h, token, `/control/v1/leases/${l.json.leaseId}/stop`, {});
    expect(stop.json.state).toBe("stopped");
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(r.lines.at(-1)).toMatchObject({ ev: "exit" });
    expect(r.lines.at(-1).exitCode === 0).toBe(false);
    expect(existsSync(l.json.workspace)).toBe(true);
  });

  it("times out a command", async () => {
    const { h, token } = await setup();
    const l = await acquire(h, token, "agent-t");
    const r = await exec(h, token, l.json.leaseId, { command: "sleep", args: ["20"], timeoutMs: 400 });
    expect(r.lines.at(-1)).toMatchObject({ ev: "exit", timedOut: true });
  });

  it("resume and destroy: destroy removes the run and workspace but never the worker", async () => {
    const { h, id, token } = await setup();
    const l = await acquire(h, token, "agent-d", { reuse: true });
    await exec(h, token, l.json.leaseId, { command: "sh", args: ["-c", "echo keep > keep.txt"] });
    await control(h, token, `/control/v1/leases/${l.json.leaseId}/release`, {});
    expect(existsSync(join(l.json.workspace, "keep.txt"))).toBe(true);
    const resumed = await control(h, token, `/control/v1/leases/${l.json.leaseId}/resume`, {});
    expect(resumed.status).toBe(200);
    // A second acquire for the same agent and workspace after release comes back to the same place.
    const d = await control(h, token, `/control/v1/leases/${l.json.leaseId}/destroy`, {});
    expect(d.json.state).toBe("destroyed");
    expect(existsSync(l.json.workspace)).toBe(false);
    expect(h.hub.leases()).toHaveLength(0);
    expect(h.hub.workers().find((x) => x.id === id)).toMatchObject({ state: "adopted", online: true });
    const gone = await control(h, token, `/control/v1/leases/${l.json.leaseId}/resume`, {});
    expect([404, 410]).toContain(gone.status);
    // Destroy is idempotent.
    expect((await control(h, token, `/control/v1/leases/${l.json.leaseId}/destroy`, {})).json.state).toBe("destroyed");
  });

  it("the control API has no way to touch the node itself", async () => {
    const { h, id, token } = await setup();
    for (const p of [`/control/v1/workers/${id}/revoke`, `/control/v1/workers/${id}/destroy`, `/control/v1/workers/${id}`, "/control/v1/workers", "/control/v1/shutdown"]) {
      const r = await control(h, token, p, {});
      expect(r.status).toBe(404);
    }
    expect(h.hub.workers().find((x) => x.id === id)).toMatchObject({ state: "adopted" });
  });

  it("scopes tokens and workers to organizations", async () => {
    const { h, token } = await setup({ companies: ["co1"] });
    expect((await control(h, "fct_nope", "/control/v1/probe", {})).status).toBe(401);
    expect((await control(h, token, "/control/v1/probe", { companyId: "other" })).status).toBe(403);
    const other = h.hub.issueControlToken("co2");
    const r = await acquire(h, other, "agent-x");
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("no_match");
    const probe = await control(h, token, "/control/v1/probe", {});
    expect(probe.json.ok).toBe(true);
  });

  it("reports an offline worker clearly and recovers when it returns", async () => {
    const { h, w, token } = await setup();
    const l = await acquire(h, token, "agent-o");
    w.client.stop();
    await until(() => !h.hub.workers()[0]!.online, 5000, "offline");
    const again = await acquire(h, token, "agent-p");
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("offline");
    const r = await exec(h, token, l.json.leaseId, { command: "echo", args: ["x"] });
    expect(r.lines.at(-1)).toMatchObject({ ev: "error", code: "offline" });
    // Destroy while offline is owed and done on reconnect.
    const gone = await control(h, token, `/control/v1/leases/${l.json.leaseId}/destroy`, {});
    expect(gone.json.state).toBe("destroyed");
    expect(existsSync(l.json.workspace)).toBe(true);
    const back = newWorker({ dir: w.dir });
    workers.push(back);
    await back.client.start();
    await until(() => !existsSync(l.json.workspace), 8000, "owed removal done on reconnect");
  });

  it("a lease survives a host restart", async () => {
    const stateDir = tmp("state");
    const h1 = await host({ stateDir });
    const port = Number(new URL(h1.url).port);
    const w = worker();
    await adoptOnline(h1, w, "persist");
    const token = h1.hub.issueControlToken("co1");
    const l = await acquire(h1, token, "agent-r");
    await h1.close();
    hosts.splice(hosts.indexOf(h1), 1);
    const cport = Number(new URL(h1.control).port);
    const h2 = await host({ stateDir, port, controlPort: cport });
    await until(() => h2.hub.workers()[0]?.online, 10_000, "reconnect");
    const r = await exec(h2, token, l.json.leaseId, { command: "echo", args: ["still here"] });
    expect(r.lines.map((x) => x.data ?? "").join("")).toContain("still here");
  });

  it("redacts secret environment values from streamed output", async () => {
    const { h, token } = await setup();
    const l = await acquire(h, token, "agent-s");
    const r = await exec(h, token, l.json.leaseId, { command: "sh", args: ["-c", "echo $API_TOKEN"], env: { API_TOKEN: "super-secret-value-123" } });
    const all = r.lines.map((x) => x.data ?? "").join("");
    expect(all).not.toContain("super-secret-value-123");
    expect(all).toContain("[redacted]");
  });

  it("schedules across workers deterministically and honours requirements", async () => {
    const h = await host();
    const a = worker({ caps: { arch: "amd64", gpu: { present: false }, tools: { git: "2", docker: "24" } } });
    const b = worker({ caps: { arch: "arm64", gpu: { present: true } } });
    await adoptOnline(h, a, "box-a");
    await adoptOnline(h, b, "box-b");
    const token = h.hub.issueControlToken("co1");
    const gpu = await acquire(h, token, "g", { requirements: { gpu: true } });
    expect(gpu.json.workerName).toBe("box-b");
    const dock = await acquire(h, token, "d", { requirements: { tools: ["docker"] } });
    expect(dock.json.workerName).toBe("box-a");
    const none = await acquire(h, token, "n", { requirements: { arch: "riscv64" } });
    expect(none.status).toBe(409);
  });

  it("drain and disable stop new work", async () => {
    const { h, id, token } = await setup();
    h.hub.updateWorker("admin", id, { drain: true });
    expect((await acquire(h, token, "x")).status).toBe(409);
    h.hub.updateWorker("admin", id, { drain: false });
    expect((await acquire(h, token, "x")).status).toBe(201);
    h.hub.updateWorker("admin", id, { disabled: true });
    expect((await acquire(h, token, "y")).status).toBe(409);
  });
});

describe("workspace safety on the worker", () => {
  it("refuses paths outside the root, symlink escapes and root removal", async () => {
    const { safePath, ensureWorkspace, removeWorkspace } = await import("../../../packages/worker-daemon/src/workspace.ts");
    const root = tmp("root");
    const outside = tmp("outside");
    expect(() => safePath(root, "/etc/passwd")).toThrow();
    expect(() => safePath(root, `${root}/../x`)).toThrow();
    expect(() => safePath(root, root)).toThrow();
    mkdirSync(join(root, "co"), { recursive: true });
    symlinkSync(outside, join(root, "co", "link"));
    expect(() => safePath(root, join(root, "co", "link", "x"))).toThrow(/escapes/);
    await expect(removeWorkspace(root, join(root, "co"))).rejects.toThrow();
    const ok = await ensureWorkspace(root, { path: join(root, "co", "ag", "run1") });
    expect(existsSync(ok)).toBe(true);
    writeFileSync(join(ok, "f"), "x");
    await removeWorkspace(root, ok);
    expect(existsSync(ok)).toBe(false);
  });

  it("creates a git worktree per run from a shared cache", async () => {
    const { execFileSync } = await import("node:child_process");
    const { ensureWorkspace, removeWorkspace } = await import("../../../packages/worker-daemon/src/workspace.ts");
    const repo = tmp("repo");
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, stdio: "pipe" });
    g("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "hello\n");
    g("add", "."); g("commit", "-q", "-m", "init");
    const root = tmp("root");
    const w1 = await ensureWorkspace(root, { path: join(root, "co", "a", "r1"), mode: "worktree", repo });
    const w2 = await ensureWorkspace(root, { path: join(root, "co", "b", "r2"), mode: "worktree", repo });
    expect(existsSync(join(w1, "README.md"))).toBe(true);
    writeFileSync(join(w1, "only-a.txt"), "a");
    expect(existsSync(join(w2, "only-a.txt"))).toBe(false);
    await removeWorkspace(root, w1);
    expect(existsSync(w1)).toBe(false);
    expect(existsSync(join(w2, "README.md"))).toBe(true);
  });
});

describe("channel hardening", () => {
  it("drops garbage and half-open handshakes without registering anything", async () => {
    const h = await host();
    const { default: WS } = await import("ws");
    const ws = new WS(h.url);
    await new Promise((r) => ws.on("open", r));
    ws.send("not json at all");
    await new Promise((r) => ws.on("close", r));
    const ws2 = new WS(h.url);
    await new Promise((r) => ws2.on("open", r));
    const hs = new ClientHandshake(generateIdentity(), h.hub.hostKey().publicKey);
    ws2.send(hs.hello("auth", "wrk_000000000000"));
    const challenge = await new Promise<string>((r) => ws2.once("message", (d) => r(d.toString())));
    const { authFrame } = hs.finish(challenge);
    ws2.send(authFrame);
    await new Promise((r) => ws2.on("close", r));
    expect(h.hub.workers()).toHaveLength(0);
  });
});
