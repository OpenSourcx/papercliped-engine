import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FEED_BODY, startPinApp } from "./fakes-pin.ts";
import { inQuietHours } from "../src/features/pin-notify.ts";
import { compareVersions, parseVersion, readFeed } from "../src/features/pin-update.ts";
import { DEFAULT_PREFS } from "../src/features/pin-core.ts";

let h: Awaited<ReturnType<typeof startPinApp>>;
let sam: string;
let lee: string;
const j = async (r: Response): Promise<any> => r.json();

const memGuard = { name: "Memory guard", trigger: { type: "condition", when: { metric: "memory_percent", op: ">", value: 50, forSeconds: 0 }, cooldownSeconds: 0, everySeconds: 60 }, scope: { guestType: "lxc" }, then: { action: "shutdown" } };
const setMode = (user: string, mode: string) => h.state.setSetting("pin.settings", { [user]: { mode } });
async function create(cookie: string, body: unknown = memGuard) {
  const r = await h.call("POST", "/api/pin/automations", { cookie }, body);
  return { status: r.status, body: await j(r) };
}

beforeEach(async () => {
  h = await startPinApp({ helper: true });
  sam = await h.signIn("sam");
  lee = await h.signIn("lee");
});
afterEach(() => h.close());

describe("automation identity", () => {
  it("makes a privilege-separated token holding only the role the action needs on its scope", async () => {
    const r = await create(sam, { ...memGuard, scope: { guestType: "lxc", vmids: [101] } });
    expect(r.status).toBe(201);
    expect(r.body.automation.permissions).toBe("scoped");
    const id = r.body.automation.id;
    const tok = h.pve.tokens.get("sam@pve")!.get(`epcauto-${id}`)!;
    expect(tok.privsep).toBe(1);
    expect(h.pve.acl.filter((a) => a.type === "token")).toEqual([{ path: "/vms/101", ugid: `sam@pve!epcauto-${id}`, type: "token", roleid: "PVEVMUser", propagate: 1 }]);
    expect(JSON.stringify(r.body)).not.toContain(tok.secret);
    expect(JSON.stringify(h.state.getSetting("pin.automations"))).not.toContain(tok.secret);
  });

  it("refuses an owner who can't delegate, unless they choose to act with their own permissions", async () => {
    const r = await create(lee, memGuard);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("needs_permissions");
    expect([...(h.pve.tokens.get("lee@pve") ?? [])]).toHaveLength(0);
    const ok = await create(lee, { ...memGuard, allowOwnerPermissions: true });
    expect(ok.status).toBe(201);
    expect(ok.body.automation.permissions).toBe("owner");
  });

  it("validates strictly and shows a plain read-back first", async () => {
    expect((await create(sam, { ...memGuard, then: { action: "destroy" } })).status).toBe(400);
    expect((await create(sam, { ...memGuard, extra: 1 })).status).toBe(400);
    const p = await j(await h.call("POST", "/api/pin/automations/preview", { cookie: sam }, memGuard));
    expect(p.readBack).toMatch(/shut it down, checking every minute/);
    expect((await h.call("POST", "/api/pin/automations", { cookie: "epc_session=x" }, memGuard)).status).toBe(401);
  });

  it("deleting removes the Proxmox token and the secret", async () => {
    const id = (await create(sam)).body.automation.id;
    const d = await j(await h.call("DELETE", `/api/pin/automations/${id}`, { cookie: sam }));
    expect(d.tokenRemoved).toBe(true);
    expect(h.pve.tokens.get("sam@pve")!.has(`epcauto-${id}`)).toBe(false);
    expect(h.state.getSecret(`pin.automation.${id}`)).toBeNull();
  });
});

describe("the runner", () => {
  it("in Agent mode acts as the automation's token, waits for the task and records the run", async () => {
    setMode("sam@pve", "agent");
    const id = (await create(sam)).body.automation.id;
    await h.runner.tick();
    expect(h.pve.guests.get(101)!.status).toBe("stopped");
    const power = h.pve.calls.find((c) => c.path.endsWith("/status/shutdown"))!;
    expect(power.who).toBe(`sam@pve!epcauto-${id}`);
    const runs = (await j(await h.call("GET", "/api/pin/automations/runs", { cookie: sam }))).runs;
    expect(runs[0]).toMatchObject({ status: "ok", trigger: "schedule" });
    expect(runs[0].steps[0]).toMatchObject({ vmid: 101, result: "done" });
    // Protected machine 102 is over the line too but is never touched; it only notifies.
    expect(h.pve.guests.get(102)!.status).toBe("running");
  });

  it("protected machines only notify", async () => {
    setMode("sam@pve", "agent");
    h.pve.guests.get(102)!.mem = 1.9 * 1024 ** 3;
    h.pve.guests.get(101)!.mem = 0;
    await create(sam);
    await h.runner.tick();
    expect(h.pve.guests.get(102)!.status).toBe("running");
    const inbox = (await j(await h.call("GET", "/api/pin/notifications", { cookie: sam }))).notifications;
    expect(inbox.some((n: any) => n.kind === "automation" && /protected/.test(n.body))).toBe(true);
  });

  it("in Assistant mode writes a one-step plan instead of acting", async () => {
    const id = (await create(sam)).body.automation.id;
    await h.runner.tick();
    expect(h.pve.guests.get(101)!.status).toBe("running");
    const plans = (await j(await h.call("GET", "/api/pin/plans", { cookie: sam }))).plans;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ createdBy: "automation", automationId: id, status: "pending" });
    // A second pass doesn't pile up a second proposal for the same machine.
    h.clock.t += 61_000;
    await h.runner.tick();
    expect((await j(await h.call("GET", "/api/pin/plans", { cookie: sam }))).plans).toHaveLength(1);
  });

  it("is not due before its interval, and a schedule runs once at its time", async () => {
    setMode("sam@pve", "agent");
    await create(sam, { name: "Nightly snapshot", trigger: { type: "schedule", dailyAt: "13:00" }, scope: { guestType: "lxc", tag: "prod" }, then: { action: "snapshot" } });
    await h.runner.tick();
    expect(h.pve.snapshots.get(101)).toBeUndefined();
    h.clock.t += 61 * 60_000;
    await h.runner.tick();
    expect(h.pve.snapshots.get(101)).toHaveLength(1);
    await h.runner.tick();
    expect(h.pve.snapshots.get(101)).toHaveLength(1);
  });

  it("never overlaps: a second pass and a manual run while one is going do nothing extra", async () => {
    setMode("sam@pve", "agent");
    const id = (await create(sam)).body.automation.id;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.rt.sleep = () => gate;
    h.pve.st.flaky = 1;
    const first = h.runner.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.runner.isRunning(id)).toBe(true);
    await h.runner.tick();
    const manual = await h.call("POST", `/api/pin/automations/${id}/run`, { cookie: sam });
    expect(manual.status).toBe(409);
    release();
    await first;
    expect(h.pve.calls.filter((c) => c.path.endsWith("/status/shutdown") && c.path.includes("/101/"))).toHaveLength(2);
  });

  it("retries a temporary failure a bounded number of times, and never retries a refusal", async () => {
    setMode("sam@pve", "agent");
    await create(sam, { ...memGuard, scope: { guestType: "lxc", vmids: [101] } });
    h.pve.st.flaky = 2;
    await h.runner.tick();
    expect(h.pve.guests.get(101)!.status).toBe("stopped");
    h.pve.guests.get(101)!.status = "running";
    h.pve.st.flaky = 5;
    h.clock.t += 61_000;
    await h.runner.tick();
    const failed = h.rt.store.runs().at(-1)!;
    expect(failed.status).toBe("failed");
    expect(failed.steps[0].attempts).toBe(3);
    h.pve.st.flaky = 0;
    h.pve.st.refusePower = { status: 403, message: "Permission check failed" };
    h.clock.t += 2 * 3600_000;
    const before = h.pve.calls.length;
    await h.runner.tick();
    expect(h.pve.calls.slice(before).filter((c) => c.path.endsWith("/status/shutdown"))).toHaveLength(1);
  });

  it("backs off, pauses after three failed runs, surfaces it in the inbox, and resume clears it", async () => {
    setMode("sam@pve", "agent");
    const id = (await create(sam, { ...memGuard, scope: { guestType: "lxc", vmids: [101] } })).body.automation.id;
    h.pve.st.refusePower = { status: 403, message: "nope" };
    for (let i = 0; i < 3; i++) {
      await h.runner.tick();
      h.clock.t += 5 * 60_000;
    }
    const a = (await j(await h.call("GET", `/api/pin/automations/${id}`, { cookie: sam }))).automation;
    expect(a.paused).toMatchObject({ by: "runner" });
    expect(a.consecutiveFailures).toBe(3);
    const n = h.pve.calls.length;
    await h.runner.tick();
    expect(h.pve.calls.length).toBe(n);
    const inbox = (await j(await h.call("GET", "/api/pin/notifications", { cookie: sam }))).notifications;
    expect(inbox.some((x: any) => x.level === "critical" && /paused/.test(x.title))).toBe(true);
    h.pve.st.refusePower = null;
    await h.call("POST", `/api/pin/automations/${id}/resume`, { cookie: sam });
    await h.runner.tick();
    expect(h.pve.guests.get(101)!.status).toBe("stopped");
  });

  it("a Proxmox task that ends in error fails the run", async () => {
    setMode("sam@pve", "agent");
    await create(sam, { ...memGuard, scope: { guestType: "lxc", vmids: [101] } });
    h.pve.st.taskFails = "start failed: boom";
    await h.runner.tick();
    expect(h.rt.store.runs().at(-1)!.status).toBe("failed");
  });

  it("pauses at once when Proxmox no longer accepts the owner's token, and pause/resume are the owner's", async () => {
    setMode("sam@pve", "agent");
    const id = (await create(sam)).body.automation.id;
    h.pve.users.get("sam@pve")!.enable = 0;
    await h.runner.tick();
    const a = h.rt.store.automation(id)!;
    expect(a.paused?.by).toBe("runner");
    expect((await h.call("POST", `/api/pin/automations/${id}/pause`, { cookie: lee })).status).toBe(404);
  });

  it("marks runs a restart interrupted as failed", async () => {
    h.rt.store.putRun({ id: "r1", automationId: "x", automationName: "x", owner: "sam@pve", trigger: "schedule", startedAt: 1, finishedAt: null, status: "running", steps: [] });
    h.runner.recover();
    expect(h.rt.store.runs()[0]).toMatchObject({ status: "failed" });
  });
});

describe("notifications", () => {
  it("collects task, backup and node events once, quietly", async () => {
    h.pve.finishedTask({ type: "qmstart", id: "200", user: "sam@pve", at: h.clock.t - 60_000 });
    h.pve.finishedTask({ type: "vzdump", id: "101", user: "root@pam", status: "job errors", at: h.clock.t - 30_000 });
    h.pve.st.nodeOnline = true;
    let r = await j(await h.call("GET", "/api/pin/notifications?refresh=1", { cookie: sam }));
    const by = (k: string) => r.notifications.find((n: any) => n.kind === k);
    expect(by("task_finished")).toMatchObject({ level: "info", peek: false, read: false });
    expect(by("backup_failed")).toMatchObject({ level: "critical", peek: true });
    h.pve.st.nodeOnline = false;
    h.clock.t += 30_000;
    r = await j(await h.call("GET", "/api/pin/notifications?refresh=1", { cookie: sam }));
    expect(by("node_event")).toMatchObject({ level: "critical" });
    r = await j(await h.call("GET", "/api/pin/notifications?refresh=1", { cookie: sam }));
    expect(r.notifications.filter((n: any) => n.kind === "backup_failed")).toHaveLength(1);
    expect(r.unread).toBe(3);
  });

  it("only tells people about what they may see: lee's own tasks, not sam's", async () => {
    h.pve.finishedTask({ type: "qmstart", id: "200", user: "sam@pve", at: h.clock.t - 1000 });
    const r = await j(await h.call("GET", "/api/pin/notifications?refresh=1", { cookie: lee }));
    expect(r.notifications.filter((n: any) => n.kind === "task_finished")).toHaveLength(0);
  });

  it("honours mutes, quiet kinds and quiet hours, validates preferences, and marks read", async () => {
    const put = (b: unknown) => h.call("PUT", "/api/pin/notification-prefs", { cookie: sam }, b);
    expect((await put({ muted: ["nope"] })).status).toBe(400);
    expect((await put({ quietHours: { from: "25:00" } })).status).toBe(400);
    expect((await put({ extra: 1 })).status).toBe(400);
    await put({ muted: ["task_finished"], quietHours: { enabled: true, from: "00:00", to: "23:59" } });
    h.pve.finishedTask({ type: "qmstart", id: "200", user: "sam@pve", at: h.clock.t - 1000 });
    h.pve.finishedTask({ type: "vzdump", id: "101", user: "sam@pve", status: "error", at: h.clock.t - 500 });
    const r = await j(await h.call("GET", "/api/pin/notifications?refresh=1", { cookie: sam }));
    expect(r.notifications.map((n: any) => n.kind)).toEqual(["backup_failed"]);
    expect(r.notifications[0].peek).toBe(false);
    await h.call("POST", "/api/pin/notifications/read", { cookie: sam }, { all: true });
    expect((await j(await h.call("GET", "/api/pin/notifications", { cookie: sam }))).unread).toBe(0);
    await h.call("POST", "/api/pin/notifications/clear", { cookie: sam });
    expect((await j(await h.call("GET", "/api/pin/notifications", { cookie: sam }))).notifications).toHaveLength(0);
    expect((await h.call("POST", "/api/pin/notifications/read", { cookie: sam }, { ids: ["x"] })).status).toBe(400);
  });

  it("quiet hours can run past midnight", () => {
    const p = { ...DEFAULT_PREFS, quietHours: { enabled: true, from: "22:00", to: "07:00" } };
    expect(inQuietHours(p, new Date(2026, 9, 13, 23, 0).getTime())).toBe(true);
    expect(inQuietHours(p, new Date(2026, 9, 13, 6, 59).getTime())).toBe(true);
    expect(inQuietHours(p, new Date(2026, 9, 13, 12, 0).getTime())).toBe(false);
  });
});

describe("Agent mode plans", () => {
  const plan = (steps: unknown[]) => import("../src/features/pin-agent.ts").then((m) => m.createPlan(h.rt, { owner: "sam@pve", title: "Maintenance", steps, createdBy: "pin" }));
  const post = (id: string, sid: string, what: string, b: unknown = {}, cookie = sam) => h.call("POST", `/api/pin/plans/${id}/steps/${sid}/${what}`, { cookie }, b);

  it("validates steps strictly", async () => {
    await expect(plan([{ kind: "power", vmid: 101, action: "destroy" }])).rejects.toThrow(/power action/);
    await expect(plan([{ kind: "power", vmid: 5, action: "start" }])).rejects.toThrow(/vmid/);
    await expect(plan([{ kind: "snapshot", vmid: 101, name: "1bad" }])).rejects.toThrow(/snapshot name/);
    await expect(plan([{ kind: "snapshot", vmid: 101, name: "ok1", extra: 1 }])).rejects.toThrow(/no field/);
    await expect(plan([])).rejects.toThrow(/1 to 8/);
  });

  it("runs nothing until approved, in order, and destructive steps need the typed phrase", async () => {
    const p = await plan([{ kind: "snapshot", vmid: 101, name: "pre-stop" }, { kind: "power", vmid: 101, action: "shutdown" }]);
    expect(p.steps[1]).toMatchObject({ destructive: true, confirmPhrase: "shutdown 101" });
    expect(h.pve.guests.get(101)!.status).toBe("running");
    expect((await post(p.id, p.steps[1].id, "approve")).status).toBe(409);
    expect((await post(p.id, p.steps[0].id, "approve", {}, lee)).status).toBe(404);
    expect((await post(p.id, p.steps[0].id, "approve")).status).toBe(200);
    expect(h.pve.snapshots.get(101)).toEqual(["pre-stop"]);
    const bad = await post(p.id, p.steps[1].id, "approve", { confirm: "yes" });
    expect(bad.status).toBe(409);
    expect((await j(bad)).code).toBe("confirm");
    expect(h.pve.guests.get(101)!.status).toBe("running");
    const done = await j(await post(p.id, p.steps[1].id, "approve", { confirm: "shutdown 101" }));
    expect(done.plan.status).toBe("done");
    expect(h.pve.guests.get(101)!.status).toBe("stopped");
    expect(done.plan.steps.map((s: any) => s.decidedBy)).toEqual(["sam@pve", "sam@pve"]);
    const audit = (await j(await h.call("GET", "/api/access/audit", { cookie: sam }))).entries as any[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["pin.plan.propose", "pin.plan.approve", "pin.plan.step.done"]));
  });

  it("a failed step ends the plan and skips the rest; reject cancels; plans can't be approved with a token", async () => {
    const p = await plan([{ kind: "power", vmid: 200, action: "start" }, { kind: "snapshot", vmid: 200, name: "after" }]);
    h.pve.st.refusePower = { status: 403, message: "no" };
    const r = await j(await post(p.id, p.steps[0].id, "approve"));
    expect(r.plan.status).toBe("failed");
    expect(r.plan.steps.map((s: any) => s.state)).toEqual(["failed", "skipped"]);
    expect(r.plan.steps[0].error).toMatch(/permission/);
    const q = await plan([{ kind: "snapshot", vmid: 101, name: "a1" }, { kind: "snapshot", vmid: 101, name: "b1" }]);
    const rej = await j(await post(q.id, q.steps[0].id, "reject"));
    expect(rej.plan.status).toBe("cancelled");
    expect(h.pve.snapshots.get(101)).toBeUndefined();
    const t = await j(await h.call("POST", "/api/access/epc-tokens", { cookie: sam }, { name: "ci" }));
    const s = await plan([{ kind: "snapshot", vmid: 101, name: "c1" }]);
    expect((await h.call("POST", `/api/pin/plans/${s.id}/steps/${s.steps[0].id}/approve`, { bearer: t.token }, {})).status).toBe(403);
    expect((await h.call("GET", `/api/pin/plans/${s.id}`, { bearer: t.token })).status).toBe(200);
  });
});

describe("update awareness", () => {
  it("shows installed vs latest from the feed, sending nothing identifying", async () => {
    const r = await j(await h.call("GET", "/api/pin/update", { cookie: sam }));
    expect(r).toMatchObject({ installed: "0.1.0", state: "available", canManage: true, canUpdate: true });
    expect(r.latest.version).toBe("0.2.0");
    expect(r.latest.url).toMatch(/^https:\/\/github\.com\/OpenSourcx\/papercliped-engine\//);
    expect(h.feed.requests).toHaveLength(1);
    expect(Object.keys(h.feed.requests[0].headers).sort()).toEqual(["Accept", "User-Agent"]);
    expect(h.feed.requests[0].headers["User-Agent"]).not.toMatch(/0\.1\.0|sam/);
    // Cached: no second request. A non-administrator never triggers one.
    await h.call("GET", "/api/pin/update", { cookie: sam });
    const l = await j(await h.call("GET", "/api/pin/update", { cookie: lee }));
    expect(l.canManage).toBe(false);
    expect(h.feed.requests).toHaveLength(1);
  });

  it("says so when the feed is unreachable, the entry isn't a release, or checks are off", async () => {
    h.feed.current = "unreachable";
    expect((await j(await h.call("POST", "/api/pin/update/check", { cookie: sam }))).error).toMatch(/Couldn't reach/);
    // Only release candidates so far is a fact about the project, not a broken feed.
    h.feed.current = { status: 200, body: FEED_BODY("v9.9.9", { prerelease: true }) };
    const onlyRc = await j(await h.call("POST", "/api/pin/update/check", { cookie: sam }));
    expect(onlyRc).toMatchObject({ error: null, state: "no_stable", latest: null, channel: "stable" });
    expect(onlyRc.preview.version).toBe("9.9.9");
    await h.call("PUT", "/api/pin/update/settings", { cookie: sam }, { check: false });
    const n = h.feed.requests.length;
    const r = await j(await h.call("GET", "/api/pin/update", { cookie: sam }));
    expect(r.state).toBe("off");
    expect(h.feed.requests.length).toBe(n);
  });

  it("offers final releases to a stable device and release candidates only to one that opted in", async () => {
    const list = JSON.stringify([JSON.parse(FEED_BODY("v0.3.0-rc2", { prerelease: true })), JSON.parse(FEED_BODY("v0.2.0")), JSON.parse(FEED_BODY("v0.3.0-rc1", { prerelease: true })), JSON.parse(FEED_BODY("v0.1.5", { draft: true }))]);
    h.feed.current = { status: 200, body: list };
    const stable = await j(await h.call("POST", "/api/pin/update/check", { cookie: sam }));
    expect(stable).toMatchObject({ channel: "stable", state: "available" });
    expect(stable.latest.version).toBe("0.2.0");
    expect(stable.preview.version).toBe("0.3.0-rc2");
    const rc = await j(await h.call("PUT", "/api/pin/update/settings", { cookie: sam }, { channel: "rc" }));
    expect(rc).toMatchObject({ channel: "rc", state: "available", preview: null });
    expect(rc.latest.version).toBe("0.3.0-rc2");
    expect((await h.call("PUT", "/api/pin/update/settings", { cookie: sam }, { channel: "nightly" })).status).toBe(400);
    expect((await h.call("PUT", "/api/pin/update/settings", { cookie: lee }, { channel: "rc" })).status).toBe(403);
    // A release candidate can be handed to the helper once the device follows them, and only then.
    const ok = await h.call("POST", "/api/pin/update", { cookie: sam }, { action: "update", confirm: "update 0.3.0-rc2" });
    expect(ok.status).toBe(202);
    expect(readFileSync(join(h.stateDir, "update", "request"), "utf8")).toMatch(/^action=update\nversion=0\.3\.0-rc2\n/);
  });

  it("does not offer a candidate to a device that follows final releases only", async () => {
    h.feed.current = { status: 200, body: JSON.stringify([JSON.parse(FEED_BODY("v0.3.0-rc2", { prerelease: true })), JSON.parse(FEED_BODY("v0.2.0"))]) };
    await h.call("POST", "/api/pin/update/check", { cookie: sam });
    expect((await h.call("POST", "/api/pin/update", { cookie: sam }, { action: "update", confirm: "update 0.3.0-rc2" })).status).toBe(409);
  });

  it("hands a confirmed request to the root helper; refuses everyone else and everything unconfirmed", async () => {
    await h.call("GET", "/api/pin/update", { cookie: sam });
    const go = (b: unknown, cookie = sam) => h.call("POST", "/api/pin/update", { cookie }, b);
    expect((await go({ action: "update", confirm: "update 0.2.0" }, lee)).status).toBe(403);
    expect((await go({ action: "update", confirm: "update" })).status).toBe(409);
    expect((await go({ action: "rollback", confirm: "rollback" })).status).toBe(409);
    expect(existsSync(join(h.stateDir, "update", "request"))).toBe(false);
    const ok = await go({ action: "update", confirm: "update 0.2.0" });
    expect(ok.status).toBe(202);
    const file = readFileSync(join(h.stateDir, "update", "request"), "utf8");
    expect(file).toMatch(/^action=update\nversion=0\.2\.0\nrequestedBy=sam@pve\nat=\d+\n$/);
  });

  it("reads the helper's status and refuses a second update while one runs", async () => {
    await h.call("GET", "/api/pin/update", { cookie: sam });
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(h.stateDir, "update"), { recursive: true });
    writeFileSync(join(h.stateDir, "update", "status"), `phase=installing\nmessage=Test-starting the new version\nversion=0.2.0\nat=${Math.floor(h.clock.t / 1000)}\n`);
    const r = await j(await h.call("GET", "/api/pin/update", { cookie: sam }));
    expect(r.inProgress).toBe(true);
    expect(r.status.phase).toBe("installing");
    expect((await h.call("POST", "/api/pin/update", { cookie: sam }, { action: "update", confirm: "update 0.2.0" })).status).toBe(409);
  });

  it("compares versions and cleans the feed", () => {
    expect(compareVersions(parseVersion("0.9.0")!, parseVersion("v0.10.0")!)).toBeLessThan(0);
    expect(compareVersions(parseVersion("1.0.0-rc1")!, parseVersion("1.0.0")!)).toBeLessThan(0);
    // Release candidates are numbered, not spelled: rc13 is newer than rc9, and rc2 older than rc10.
    const v = (x: string) => parseVersion(x)!;
    expect(compareVersions(v("1.0.0-rc9"), v("1.0.0-rc13"))).toBeLessThan(0);
    expect(compareVersions(v("1.0.0-rc13"), v("1.0.0-rc9"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.0.0-rc2"), v("1.0.0-rc10"))).toBeLessThan(0);
    expect(compareVersions(v("1.0.0-rc10"), v("1.0.0-rc10"))).toBe(0);
    expect(compareVersions(v("1.0.0-beta1"), v("1.0.0-rc1"))).toBeLessThan(0);
    expect(["1.0.0-rc9", "1.0.0-rc13", "1.0.0", "1.0.0-rc10", "0.9.0"].sort((a, b) => compareVersions(v(b), v(a)))).toEqual(["1.0.0", "1.0.0-rc13", "1.0.0-rc10", "1.0.0-rc9", "0.9.0"]);
    expect(parseVersion("dev")).toBeNull();
    const l = readFeed(FEED_BODY("v1.2.3", { html_url: "https://evil.test/x", body: "a\u0000b" }));
    expect(l.url).not.toContain("evil");
    expect(l.notes).toBe("ab");
  });
});

describe("read-only MCP endpoint", () => {
  const rpc = (bearer: string | undefined, body: unknown, cookie?: string) => h.call("POST", "/api/mcp", { bearer, cookie }, body);
  let token: string;
  beforeEach(async () => {
    token = (await j(await h.call("POST", "/api/access/epc-tokens", { cookie: sam }, { name: "bridge", privsep: true }))).token;
  });

  it("needs a Bearer token, never the console cookie", async () => {
    expect((await rpc(undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" }, sam)).status).toBe(401);
    expect((await rpc("epc_0000000000000000_" + "a".repeat(43), { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  it("initializes, lists only read-only tools, and runs them as the token's person", async () => {
    const init = await j(await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }));
    expect(init.result.protocolVersion).toBe("2025-03-26");
    const list = await j(await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_machines");
    expect(names).not.toContain("power_machine");
    expect(names).not.toContain("propose_plan");
    const call = await j(await rpc(token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_machines", arguments: {} } }));
    expect(call.result.isError).toBe(false);
    // A privilege-separated token sees only what Proxmox lets it: nothing, until it is given permissions.
    expect(JSON.parse(call.result.content[0].text).machines).toEqual([]);
    const full = (await j(await h.call("POST", "/api/access/epc-tokens", { cookie: sam }, { name: "full" }))).token;
    const all = await j(await rpc(full, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_machines", arguments: {} } }));
    expect(JSON.parse(all.result.content[0].text).machines.map((m: any) => m.vmid)).toEqual(expect.arrayContaining([101, 200]));
    const act = await j(await rpc(token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "power_machine", arguments: { vmid: 101, action: "stop" } } }));
    expect(act.error.code).toBe(-32602);
    expect(h.pve.guests.get(101)!.status).toBe("running");
    const note = await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect((await j(await rpc(token, { jsonrpc: "2.0", id: 5, method: "resources/list" }))).error.code).toBe(-32601);
    expect((await h.call("GET", "/api/mcp", { bearer: token })).status).toBe(405);
  });
});

describe("update policy, reminders, schedule and history", () => {
  const setPolicy = (b: unknown, cookie = sam) => h.call("PUT", "/api/pin/update/settings", { cookie }, b);
  const inbox = async () => (await j(await h.call("GET", "/api/pin/notifications", { cookie: sam }))).notifications as { key: string; kind: string; title: string }[];
  const requestFile = () => join(h.stateDir, "update", "request");

  it("validates what can be set, for administrators only", async () => {
    expect((await setPolicy({ pauseDays: 36 })).status).toBe(400);
    expect((await setPolicy({ pauseDays: -1 })).status).toBe(400);
    expect((await setPolicy({ mode: "always" })).status).toBe(400);
    expect((await setPolicy({ window: { at: "25:00" } })).status).toBe(400);
    expect((await setPolicy({ window: { day: 9 } })).status).toBe(400);
    expect((await setPolicy({ window: { hours: 12 } })).status).toBe(400);
    expect((await setPolicy({ nope: 1 })).status).toBe(400);
    expect((await setPolicy({ mode: "window" }, lee)).status).toBe(403);
    const ok = await j(await setPolicy({ mode: "window", window: { day: 0, at: "04:30", hours: 3 }, pauseDays: 7 }));
    expect(ok.policy).toMatchObject({ mode: "window", window: { day: 0, at: "04:30", hours: 3 } });
    expect(ok.paused).toBe(true);
    expect(ok.policy.pausedUntil - h.clock.t).toBe(7 * 86_400_000);
    expect((await j(await setPolicy({ pauseDays: 0 }))).paused).toBe(false);
  });

  it("reminds administrators who looked, once a day, and not while snoozed or paused", async () => {
    await h.call("GET", "/api/pin/update", { cookie: sam }); // sam looks, so sam is who gets reminded
    await h.runner.tick();
    const first = (await inbox()).filter((n) => n.kind === "update");
    expect(first.length).toBeGreaterThan(0);
    await h.runner.tick();
    expect((await inbox()).filter((n) => n.kind === "update")).toHaveLength(first.length);
    await setPolicy({ snoozeHours: 48 });
    h.clock.t += 86_400_000;
    sam = await h.signIn("sam"); // a day on, the earlier sign-in has timed out
    await h.runner.tick();
    expect((await inbox()).filter((n) => n.kind === "update")).toHaveLength(first.length);
    await setPolicy({ snoozeHours: 0, pauseDays: 5 });
    await h.runner.tick();
    expect((await inbox()).filter((n) => n.kind === "update")).toHaveLength(first.length);
    await setPolicy({ pauseDays: 0 });
    await h.runner.tick();
    expect((await inbox()).filter((n) => n.kind === "update").length).toBe(first.length + 1);
  });

  it("installs by itself only inside the maintenance window, and not when paused", async () => {
    await h.call("GET", "/api/pin/update", { cookie: sam });
    await setPolicy({ mode: "window", window: { day: "daily", at: "03:00", hours: 2 } }); // the harness clock is noon
    await h.runner.tick();
    expect(existsSync(requestFile())).toBe(false);
    await setPolicy({ window: { at: "11:30", hours: 2 }, pauseDays: 2 });
    await h.runner.tick();
    expect(existsSync(requestFile())).toBe(false);
    await setPolicy({ pauseDays: 0 });
    await h.runner.tick();
    expect(readFileSync(requestFile(), "utf8")).toMatch(/^action=update\nversion=0\.2\.0\nrequestedBy=schedule\n/);
  });

  it("writes down what happened, and never retries a failed scheduled update on its own", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    await h.call("GET", "/api/pin/update", { cookie: sam });
    await setPolicy({ mode: "window", window: { day: "daily", at: "11:30", hours: 2 } });
    await h.runner.tick();
    expect(existsSync(requestFile())).toBe(true);
    rmSync(requestFile());
    mkdirSync(join(h.stateDir, "update"), { recursive: true });
    writeFileSync(join(h.stateDir, "update", "status"), `phase=failed\nmessage=The download was refused\nversion=0.2.0\nat=${Math.floor((h.clock.t + 60_000) / 1000)}\n`);
    h.clock.t += 120_000;
    await h.runner.tick();
    const hist = (await j(await h.call("GET", "/api/pin/update/history", { cookie: sam }))).entries;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ action: "update", from: "0.1.0", to: "0.2.0", by: "schedule", result: "failed" });
    h.clock.t += 60_000;
    await h.runner.tick();
    expect(existsSync(requestFile())).toBe(false);
    expect((await inbox()).some((n) => /didn't finish/.test(n.title))).toBe(true);
    expect((await h.call("GET", "/api/pin/update/history", { cookie: lee })).status).toBe(403);
  });

  it("records an update done in the host's shell", async () => {
    const { writeFileSync } = await import("node:fs");
    await h.call("GET", "/api/pin/update", { cookie: sam });
    writeFileSync(h.versionFile, "0.2.0\n");
    const hist = (await j(await h.call("GET", "/api/pin/update/history", { cookie: sam }))).entries;
    expect(hist[0]).toMatchObject({ from: "0.1.0", to: "0.2.0", by: "host shell", result: "done" });
  });
});

describe("what Proxmox did: restart needed and package history", () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const point = (release: string, kernels: string[], apt?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "epc-kern-"));
    for (const k of kernels) mkdirSync(join(dir, k));
    const hist = join(dir, "history.log");
    if (apt !== undefined) writeFileSync(hist, apt);
    h.rt.opts.update = { ...h.rt.opts.update, modulesDir: dir, kernelRelease: release, aptHistory: hist };
  };
  const status = async () => j(await h.call("GET", "/api/pin/update", { cookie: sam }));

  it("knows when the installed kernel is newer than the running one", async () => {
    point("6.8.12-4-pve", ["6.8.12-4-pve", "6.8.12-9-pve", "6.5.13-5-pve"]);
    expect((await status()).system).toMatchObject({ running: "6.8.12-4-pve", newestInstalled: "6.8.12-9-pve", rebootRequired: true });
    point("6.8.12-9-pve", ["6.8.12-4-pve", "6.8.12-9-pve"]);
    expect((await status()).system.rebootRequired).toBe(false);
    point("6.8.12-4-pve", []);
    expect((await status()).system).toMatchObject({ newestInstalled: null, rebootRequired: false });
  });

  it("reminds about the restart, loudly once and then quietly each day", async () => {
    point("6.8.12-4-pve", ["6.8.12-4-pve", "6.8.12-9-pve"]);
    await h.call("GET", "/api/pin/update", { cookie: sam });
    const n = async () => ((await j(await h.call("GET", "/api/pin/notifications", { cookie: sam }))).notifications as { key: string; level: string }[]).filter((x) => x.key.startsWith("reboot:"));
    await h.runner.tick();
    const first = await n();
    expect(first).toHaveLength(1);
    expect(first[0].level).toBe("warning");
    await h.runner.tick();
    expect(await n()).toHaveLength(1);
    h.clock.t += 86_400_000;
    sam = await h.signIn("sam");
    await h.runner.tick();
    const next = await n();
    expect(next).toHaveLength(2);
    expect(next[0].level).toBe("info");
  });

  it("reads Debian's apt history without changing it", async () => {
    const log = [
      "Start-Date: 2026-10-14  08:01:22", "Commandline: apt-get dist-upgrade", "Upgrade: pve-manager:amd64 (9.2.1, 9.2.3), proxmox-kernel-6.8:amd64 (6.8.12-4, 6.8.12-9)", "End-Date: 2026-10-14  08:03:40", "",
      "Start-Date: 2026-10-15  09:00:00", "Commandline: apt-get update", "End-Date: 2026-10-15  09:00:05", "",
      "Start-Date: 2026-10-16  10:00:00", "Commandline: apt install htop", "Install: htop:amd64 (3.3.0)", "End-Date: 2026-10-16  10:00:09", "",
    ].join("\n");
    point("6.8.12-4-pve", [], log);
    const r = (await j(await h.call("GET", "/api/pin/update/history", { cookie: sam }))).system as { command: string; upgraded: number; installed: number; kernel: boolean; packages: string[] }[];
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ command: "apt install htop", installed: 1, upgraded: 0, kernel: false });
    expect(r[1]).toMatchObject({ command: "apt-get dist-upgrade", upgraded: 2, kernel: true });
    expect(r[1].packages).toEqual(["pve-manager", "proxmox-kernel-6.8"]);
    point("6.8.12-4-pve", []);
    expect((await j(await h.call("GET", "/api/pin/update/history", { cookie: sam }))).system).toEqual([]);
  });
});

describe("candidate numbering in the feed", () => {
  it("offers the highest-numbered candidate, and a device on it is up to date", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(h.versionFile, "1.0.0-rc13\n");
    h.feed.current = { status: 200, body: JSON.stringify(["v1.0.0-rc9", "v1.0.0-rc13", "v1.0.0-rc10", "v1.0.0-rc12"].map((t) => JSON.parse(FEED_BODY(t, { prerelease: true })))) };
    await h.call("PUT", "/api/pin/update/settings", { cookie: sam }, { channel: "rc" });
    const r = await j(await h.call("POST", "/api/pin/update/check", { cookie: sam }));
    expect(r.latest.version).toBe("1.0.0-rc13");
    expect(r.state).toBe("current");
    writeFileSync(h.versionFile, "1.0.0-rc9\n");
    expect((await j(await h.call("POST", "/api/pin/update/check", { cookie: sam }))).state).toBe("available");
  });
});

describe("the signed update feed", () => {
  const { generateKeyPairSync, sign } = require("node:crypto") as typeof import("node:crypto");
  const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const keys = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const pem = keys.publicKey.export({ type: "spki", format: "pem" }) as string;
  const feed = (releases: unknown[]) => JSON.stringify({ format: 1, generatedAt: "2026-10-20T00:00:00Z", channels: {}, releases });
  const entry = (version: string, channel: "stable" | "rc", extra: Record<string, unknown> = {}) => ({ version, channel, publishedAt: "2026-10-01T00:00:00Z", notes: `notes ${version}`, url: `https://github.com/OpenSourcx/papercliped-engine/releases/tag/v${version}`, withdrawn: false, ...extra });
  const serve = (body: string, key = keys.privateKey, github = FEED_BODY("v0.2.0")) => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "epc-key-")), "release-signing.pub");
    writeFileSync(keyFile, pem);
    const seen: string[] = [];
    h.rt.opts.update = { ...h.rt.opts.update, signedFeedUrl: "https://feed.test/updates/feed.json", pubKeyFile: keyFile };
    h.rt.opts.fetch = async (url: string) => {
      seen.push(url);
      if (url.endsWith("feed.json")) return new Response(body);
      if (url.endsWith("feed.sig")) return new Response(sign(null, Buffer.from(body), key).toString("base64"));
      return new Response(github);
    };
    return seen;
  };
  const check = async () => j(await h.call("POST", "/api/pin/update/check", { cookie: sam }));

  it("uses the feed when its signature verifies, and never offers a withdrawn release", async () => {
    serve(feed([entry("0.4.0", "stable", { withdrawn: true, withdrawnReason: "It broke restarts." }), entry("0.3.0", "stable"), entry("0.5.0-rc1", "rc")]));
    const r = await check();
    expect(r).toMatchObject({ source: "feed", feedNote: null, state: "available" });
    expect(r.latest.version).toBe("0.3.0");
    expect(r.latest.notes).toBe("notes 0.3.0");
  });

  it("ignores a feed signed by some other key, says so, and falls back to GitHub's list", async () => {
    serve(feed([entry("9.9.9", "stable")]), other.privateKey);
    const r = await check();
    expect(r).toMatchObject({ source: "github", state: "available" });
    expect(r.latest.version).toBe("0.2.0");
    expect(r.feedNote).toMatch(/signature/);
  });

  it("falls back quietly when the feed is simply unreachable, and when no release key is pinned", async () => {
    serve(feed([]));
    h.rt.opts.fetch = async (url: string) => (url.includes("/updates/") ? new Response("nope", { status: 503 }) : new Response(FEED_BODY("v0.2.0")));
    expect(await check()).toMatchObject({ source: "github", feedNote: null, error: null });
    h.rt.opts.update = { ...h.rt.opts.update, pubKeyFile: "/nonexistent/key.pub" };
    expect(await check()).toMatchObject({ source: "github" });
  });

  it("tells a device running a withdrawn release to move on", async () => {
    serve(feed([entry("0.1.0", "stable", { withdrawn: true, withdrawnReason: "Updates could not restart the engine." }), entry("0.2.0", "stable")]));
    await h.call("GET", "/api/pin/update", { cookie: sam });
    const r = await check();
    expect(r.installedWithdrawn).toBe("Updates could not restart the engine.");
    await h.runner.tick();
    const n = ((await j(await h.call("GET", "/api/pin/notifications", { cookie: sam }))).notifications as { key: string; level: string }[]).find((x) => x.key === "withdrawn:0.1.0");
    expect(n?.level).toBe("critical");
  });
});
