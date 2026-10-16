import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeCluster, FINGERPRINT, ROOT_PASSWORD, type ClusterFakeOptions } from "./fakes-cluster.ts";

let server: Server | undefined;
let base = "";
let pve: ReturnType<typeof fakeCluster>;
let seen: string[] = [];

async function boot(opts: ClusterFakeOptions = {}) {
  pve = fakeCluster(opts);
  seen = [];
  const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false, state: new StateStore(mkdtempSync(join(tmpdir(), "epc-cluster-"))) });
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function signIn(username = "sam") {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username, password: "right", realm: "pve" }) });
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const send = async (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = { "X-EPC-Request": "1" }) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  seen.push(text);
  return { status: r.status, json: (text ? JSON.parse(text) : null) as any };
};
const calls = (method: string, path: string) => pve.calls.filter((c) => c.method === method && c.path === path);
const form = (body: string) => Object.fromEntries(new URLSearchParams(body));

describe("sign-in, same-site and permissions", () => {
  it("needs a Proxmox session and the same-site header; an unprivileged account can read but not change", async () => {
    await boot();
    expect((await send("", "GET", "/api/cluster/overview")).status).toBe(401);
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/ha/arm", { action: "arm" }, {})).status).toBe(403);
    const lee = await signIn("lee");
    const r = await send(lee, "POST", "/api/cluster/replication/101-0/run-now", {});
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/permission/);
    expect((await send(sam, "GET", "/api/cluster/nothing")).status).toBe(404);
    expect((await send(sam, "DELETE", "/api/cluster/overview")).status).toBe(405);
  });
});

describe("the cluster", () => {
  it("describes a three-node cluster with quorum, votes and who is online", async () => {
    await boot();
    const sam = await signIn();
    const r = (await send(sam, "GET", "/api/cluster/overview")).json;
    expect(r).toMatchObject({ clustered: true, name: "lab", quorate: true, pveMajor: 9, local: "pve", onlineCount: 2, votes: 3 });
    expect(r.nodes.map((n: any) => [n.name, n.online, n.local, n.votes])).toEqual([["pve", true, true, 1], ["pve2", true, false, 1], ["pve3", false, false, 1]]);
    expect(r.nodes[0].links).toEqual([{ n: 0, address: "10.0.0.2" }]);
    expect(r.nodes[0].guests).toEqual({ running: 1, total: 2 });
    expect(r.totem.clusterName).toBe("lab");
  });

  it("answers calmly on a single device", async () => {
    await boot({ single: true });
    const sam = await signIn();
    const r = await send(sam, "GET", "/api/cluster/overview");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ clustered: false, name: null, totem: null, qdevice: null, canChange: true });
    expect(r.json.nodes).toHaveLength(1);
    expect((await send(sam, "GET", "/api/cluster/join-info")).status).toBe(409);
    const ha = await send(sam, "GET", "/api/cluster/ha");
    expect(ha.status).toBe(200);
    expect(ha.json.resources).toEqual([]);
    const ceph = await send(sam, "GET", "/api/cluster/ceph");
    expect(ceph.json.installed).toBe(false);
    const repl = await send(sam, "GET", "/api/cluster/replication");
    expect(repl.status).toBe(200);
    expect(repl.json.nodes).toHaveLength(1);
  });

  it("produces join information that its own parser reads back, and refuses anything else", async () => {
    await boot();
    const sam = await signIn();
    const info = (await send(sam, "GET", "/api/cluster/join-info")).json;
    expect(info).toMatchObject({ ipAddress: "10.0.0.2", fingerprint: FINGERPRINT, node: "pve" });
    const decoded = JSON.parse(Buffer.from(info.info, "base64").toString("utf8"));
    expect(decoded).toMatchObject({ ipAddress: "10.0.0.2", fingerprint: FINGERPRINT, peerLinks: { link0: "10.0.0.2" } });
    const parsed = await send(sam, "POST", "/api/cluster/join-info/parse", { text: info.info });
    expect(parsed.json).toEqual({ ipAddress: "10.0.0.2", fingerprint: FINGERPRINT, peerLinks: { link0: "10.0.0.2" } });
    expect((await send(sam, "POST", "/api/cluster/join-info/parse", { text: "not base64 json" })).status).toBe(400);
    const evil = Buffer.from(JSON.stringify({ ipAddress: "10.0.0.2; rm -rf /", fingerprint: FINGERPRINT })).toString("base64");
    expect((await send(sam, "POST", "/api/cluster/join-info/parse", { text: evil })).status).toBe(400);
    const badFp = Buffer.from(JSON.stringify({ ipAddress: "10.0.0.2", fingerprint: "AB:CD" })).toString("base64");
    expect((await send(sam, "POST", "/api/cluster/join-info/parse", { text: badFp })).status).toBe(400);
  });

  it("creates a cluster only after its name is typed, with checked links", async () => {
    await boot({ single: true });
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/create", { name: "lab" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/create", { name: "bad name!", confirm: "bad name!" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/create", { name: "lab", confirm: "lab", links: [{ address: "not an ip!" }] })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/create", { name: "lab", confirm: "lab", links: [{ address: "10.0.0.2", priority: 999 }] })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/create", { name: "lab", confirm: "lab", surprise: 1 })).status).toBe(400);
    expect(calls("POST", "/cluster/config")).toHaveLength(0);
    const ok = await send(sam, "POST", "/api/cluster/create", { name: "lab", confirm: "lab", links: [{ address: "10.0.0.2", priority: 5 }, { address: "192.168.1.2" }] });
    expect(ok.status).toBe(200);
    expect(ok.json.task).toMatch(/^UPID:pve:/);
    expect(form(calls("POST", "/cluster/config")[0].body)).toEqual({ clustername: "lab", link0: "10.0.0.2,priority=5", link1: "192.168.1.2" });
    expect((await send(sam, "GET", "/api/cluster/overview")).json.clustered).toBe(true);
    expect((await send(sam, "POST", "/api/cluster/create", { name: "lab", confirm: "lab" })).status).toBe(409);
  });

  it("refuses to create or join when the device is already clustered", async () => {
    await boot();
    const sam = await signIn();
    const r = await send(sam, "POST", "/api/cluster/join", { hostname: "10.0.0.9", fingerprint: FINGERPRINT, password: ROOT_PASSWORD, confirm: "pve" });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("already_clustered");
  });

  it("joins with the fingerprint, keeps the password write-only and scrubs it from errors", async () => {
    await boot({ single: true });
    pve.st.guests.length = 0;
    const sam = await signIn();
    const body = { hostname: "10.0.0.9", fingerprint: FINGERPRINT.toLowerCase(), password: ROOT_PASSWORD, confirm: "pve", links: [{ address: "10.0.0.2" }] };
    expect((await send(sam, "POST", "/api/cluster/join", { ...body, confirm: "" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/join", { ...body, fingerprint: "AB:CD" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/join", { ...body, links: [{ address: "10.0.0.2", priority: 3 }] })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/join", { ...body, password: "" })).status).toBe(400);
    const wrong = await send(sam, "POST", "/api/cluster/join", { ...body, password: "echo-me-back-123" });
    expect(wrong.status).toBe(502);
    expect(JSON.stringify(wrong.json)).not.toContain("echo-me-back-123");
    const ok = await send(sam, "POST", "/api/cluster/join", body);
    expect(ok.status).toBe(200);
    expect(ok.json.signOutExpected).toBe(true);
    expect(pve.st.joinedWith).toMatchObject({ hostname: "10.0.0.9", fingerprint: FINGERPRINT, link0: "10.0.0.2" });
    expect(seen.join("\n")).not.toContain(ROOT_PASSWORD);
  });

  it("won't join a device that already has machines", async () => {
    await boot({ single: true });
    const sam = await signIn();
    const r = await send(sam, "POST", "/api/cluster/join", { hostname: "10.0.0.9", fingerprint: FINGERPRINT, password: ROOT_PASSWORD, confirm: "pve" });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("has_guests");
    expect(calls("POST", "/cluster/config/join")).toHaveLength(0);
  });

  it("removes a node that is off, after its name is typed, and explains what that leaves behind", async () => {
    await boot();
    const sam = await signIn();
    const g = (await send(sam, "GET", "/api/cluster/nodes/pve3/removal")).json;
    expect(g).toMatchObject({ node: "pve3", online: false, local: false });
    expect(g.steps.length).toBeGreaterThan(3);
    expect((await send(sam, "GET", "/api/cluster/nodes/pve2/removal")).json.guests.map((x: any) => x.vmid)).toEqual([103, 104]);
    expect((await send(sam, "POST", "/api/cluster/nodes/pve3/remove", {})).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/nodes/pve2/remove", { confirm: "pve2" })).json.code).toBe("node_online");
    expect((await send(sam, "POST", "/api/cluster/nodes/pve/remove", { confirm: "pve" })).json.code).toBe("local_node");
    expect((await send(sam, "POST", "/api/cluster/nodes/ghost/remove", { confirm: "ghost" })).status).toBe(404);
    expect((await send(sam, "POST", "/api/cluster/nodes/..%2Fx/remove", { confirm: "../x" })).status).toBe(400);
    expect(calls("DELETE", "/cluster/config/nodes/pve3")).toHaveLength(0);
    expect((await send(sam, "POST", "/api/cluster/nodes/pve3/remove", { confirm: "pve3" })).status).toBe(200);
    expect(pve.st.removed).toEqual(["pve3"]);
  });

  it("reads the cluster log", async () => {
    await boot();
    const sam = await signIn();
    const r = await send(sam, "GET", "/api/cluster/log?max=10");
    expect(r.json.entries[0]).toMatchObject({ node: "pve", tag: "pvedaemon", message: "starting cluster" });
    expect((await send(sam, "GET", "/api/cluster/log?max=100000")).status).toBe(400);
  });
});

describe("high availability", () => {
  it("shows rules on a Proxmox that has them", async () => {
    await boot();
    const sam = await signIn();
    const r = (await send(sam, "GET", "/api/cluster/ha")).json;
    expect(r).toMatchObject({ mode: "rules", rulesSupported: true, pveMajor: 9 });
    expect(r.resources[0]).toMatchObject({ sid: "vm:103", vmid: 103, name: "app", node: "pve2", state: "started", current: "started" });
    expect(r.rules[0]).toMatchObject({ rule: "keep-app-home", type: "node-affinity", resources: ["vm:103"], nodes: [{ node: "pve2", priority: 2 }, { node: "pve", priority: 1 }] });
    expect(r.status).toMatchObject({ quorate: true, master: { node: "pve" }, armedState: "armed" });
    expect(r.status.lrms).toHaveLength(3);
    expect(r.fencing).toMatchObject({ mode: "watchdog", canArm: true });
  });

  it("shows groups on an older Proxmox and refuses what it doesn't have", async () => {
    await boot({ pveVersion: "8.4.1" });
    const sam = await signIn();
    const r = (await send(sam, "GET", "/api/cluster/ha")).json;
    expect(r).toMatchObject({ mode: "groups", rulesSupported: false, pveMajor: 8, rules: [] });
    expect(r.groups[0]).toMatchObject({ group: "prefer-pve2", restricted: false });
    expect(r.resources[0].group).toBe("prefer-pve2");
    expect(r.fencing.canArm).toBe(false);
    const fb = await send(sam, "POST", "/api/cluster/ha/resources", { sid: "vm:102", failback: true });
    expect(fb.status).toBe(409);
    expect((await send(sam, "POST", "/api/cluster/ha/rules", { rule: "r1", type: "node-affinity", resources: ["vm:102"], nodes: [{ node: "pve" }] })).status).toBe(409);
    expect((await send(sam, "POST", "/api/cluster/ha/arm", { action: "disarm", resourceMode: "freeze", confirm: "disarm" })).status).toBe(409);
    const ok = await send(sam, "POST", "/api/cluster/ha/resources", { sid: "vm:102", group: "prefer-pve2", maxRestart: 2 });
    expect(ok.status).toBe(200);
    expect(form(calls("POST", "/cluster/ha/resources")[0].body)).toEqual({ sid: "vm:102", group: "prefer-pve2", max_restart: "2" });
  });

  it("adds, edits and removes a resource with strict checks", async () => {
    await boot();
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/ha/resources", { sid: "100" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ha/resources", { sid: "ct:102" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ha/resources", { sid: "vm:555" })).status).toBe(404);
    expect((await send(sam, "POST", "/api/cluster/ha/resources", { sid: "vm:9000" })).json.code).toBe("template");
    expect((await send(sam, "POST", "/api/cluster/ha/resources", { sid: "vm:102", state: "exploding" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ha/resources", { sid: "vm:102", maxRestart: -1 })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ha/resources", { sid: "vm:102", group: "nope" })).status).toBe(404);
    expect((await send(sam, "POST", "/api/cluster/ha/resources", { sid: "vm:102", extra: 1 })).status).toBe(400);
    const add = await send(sam, "POST", "/api/cluster/ha/resources", { sid: "ct:101", state: "started", failback: false, comment: "web" });
    expect(add.status).toBe(200);
    expect(form(calls("POST", "/cluster/ha/resources")[0].body)).toEqual({ sid: "ct:101", state: "started", failback: "0", comment: "web" });
    const list = (await send(sam, "GET", "/api/cluster/ha")).json;
    const digest = list.resources[0].digest;
    const put = await send(sam, "PUT", "/api/cluster/ha/resources/ct:101", { state: "stopped", comment: null, maxRestart: 3, digest });
    expect(put.status).toBe(200);
    expect(form(calls("PUT", "/cluster/ha/resources/ct:101")[0].body)).toEqual({ state: "stopped", max_restart: "3", delete: "comment", digest });
    const stale = await send(sam, "PUT", "/api/cluster/ha/resources/ct:101", { state: "started", digest });
    expect(stale.status).toBe(502);
    expect(stale.json.error).toMatch(/modified/);
    expect((await send(sam, "PUT", "/api/cluster/ha/resources/ct:101", {})).status).toBe(400);
    expect((await send(sam, "DELETE", "/api/cluster/ha/resources/ct:101", {})).status).toBe(200);
    expect(calls("DELETE", "/cluster/ha/resources/ct:101")).toHaveLength(1);
  });

  it("migrates or relocates through the HA manager to an online node only", async () => {
    await boot();
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/ha/resources/vm:103/migrate", { node: "pve3" })).json.code).toBe("node_offline");
    expect((await send(sam, "POST", "/api/cluster/ha/resources/vm:103/migrate", { node: "pve2" })).json.code).toBe("same_node");
    expect((await send(sam, "POST", "/api/cluster/ha/resources/vm:103/migrate", { node: "ghost" })).status).toBe(404);
    expect((await send(sam, "POST", "/api/cluster/ha/resources/vm:103/relocate", { node: "pve" })).json.queued).toBe(true);
    expect((pve.st as any).haMove).toEqual({ sid: "vm:103", how: "relocate", node: "pve" });
  });

  it("manages groups: nodes are checked, a group in use can't be deleted and deleting needs its name", async () => {
    await boot({ pveVersion: "8.4.1" });
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/ha/groups", { group: "g1", nodes: [{ node: "ghost" }] })).status).toBe(404);
    expect((await send(sam, "POST", "/api/cluster/ha/groups", { group: "g1", nodes: [{ node: "pve" }, { node: "pve" }] })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ha/groups", { group: "g1", nodes: [{ node: "pve", priority: 5000 }] })).status).toBe(400);
    const ok = await send(sam, "POST", "/api/cluster/ha/groups", { group: "g1", nodes: [{ node: "pve", priority: 2 }, { node: "pve2" }], restricted: true });
    expect(ok.status).toBe(200);
    expect(form(calls("POST", "/cluster/ha/groups")[0].body)).toEqual({ group: "g1", nodes: "pve:2,pve2", restricted: "1" });
    expect((await send(sam, "DELETE", "/api/cluster/ha/groups/prefer-pve2", {})).status).toBe(400);
    const inUse = await send(sam, "DELETE", "/api/cluster/ha/groups/prefer-pve2", { confirm: "prefer-pve2" });
    expect(inUse.status).toBe(409);
    expect(inUse.json.error).toMatch(/vm:103/);
    expect((await send(sam, "DELETE", "/api/cluster/ha/groups/g1", { confirm: "g1" })).status).toBe(200);
    expect((await send(sam, "PUT", "/api/cluster/ha/groups/g1", { restricted: true, nodes: [{ node: "pve2" }], comment: "x" })).status).toBe(200);
    expect(form(calls("PUT", "/cluster/ha/groups/g1")[0].body)).toEqual({ nodes: "pve2", restricted: "1", comment: "x" });
  });

  it("manages rules and takes the rule's type from Proxmox, not from the page", async () => {
    await boot();
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/ha/rules", { rule: "a", type: "colour" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ha/rules", { rule: "a", type: "resource-affinity", resources: ["vm:103"], affinity: "negative" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ha/rules", { rule: "a", type: "resource-affinity", resources: ["vm:103", "ct:101"] })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ha/rules", { rule: "a", type: "resource-affinity", resources: ["vm:103", "ct:101"], affinity: "negative", nodes: [{ node: "pve" }] })).status).toBe(400);
    const ok = await send(sam, "POST", "/api/cluster/ha/rules", { rule: "apart", type: "resource-affinity", resources: ["vm:103", "ct:101"], affinity: "negative", comment: "keep apart" });
    expect(ok.status).toBe(200);
    expect(form(calls("POST", "/cluster/ha/rules")[0].body)).toEqual({ rule: "apart", type: "resource-affinity", resources: "vm:103,ct:101", affinity: "negative", comment: "keep apart" });
    const node = await send(sam, "POST", "/api/cluster/ha/rules", { rule: "home", type: "node-affinity", resources: ["vm:103"], nodes: [{ node: "pve", priority: 3 }], strict: true });
    expect(node.status).toBe(200);
    expect(form(calls("POST", "/cluster/ha/rules")[1].body)).toMatchObject({ nodes: "pve:3", strict: "1" });
    expect((await send(sam, "PUT", "/api/cluster/ha/rules/keep-app-home", { type: "resource-affinity", digest: "r1" })).json.code).toBe("type");
    expect((await send(sam, "PUT", "/api/cluster/ha/rules/keep-app-home", { strict: true, digest: "r1" })).status).toBe(200);
    expect(form(calls("PUT", "/cluster/ha/rules/keep-app-home")[0].body)).toEqual({ type: "node-affinity", strict: "1", digest: "r1" });
    expect((await send(sam, "PUT", "/api/cluster/ha/rules/keep-app-home", { strict: true, digest: "old" })).status).toBe(502);
    expect((await send(sam, "DELETE", "/api/cluster/ha/rules/keep-app-home", {})).status).toBe(200);
  });

  it("disarming needs a typed word and a choice for what happens to machines", async () => {
    await boot();
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/ha/arm", { action: "disarm", resourceMode: "freeze" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ha/arm", { action: "disarm", confirm: "disarm" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ha/arm", { action: "disarm", resourceMode: "freeze", confirm: "disarm" })).status).toBe(200);
    expect(form(calls("POST", "/cluster/ha/status/disarm-ha")[0].body)).toEqual({ "resource-mode": "freeze" });
    expect((await send(sam, "GET", "/api/cluster/ha")).json.status.armedState).toBe("disarmed");
    expect((await send(sam, "POST", "/api/cluster/ha/arm", { action: "arm" })).status).toBe(200);
  });

  it("reports the HA state of one machine", async () => {
    await boot();
    const sam = await signIn();
    expect((await send(sam, "GET", "/api/cluster/ha/guest/103")).json).toMatchObject({ managed: true, sid: "vm:103", state: "started", current: "started" });
    expect((await send(sam, "GET", "/api/cluster/ha/guest/102")).json).toMatchObject({ managed: false });
  });
});

describe("replication", () => {
  it("lists jobs with the status from the node that runs them", async () => {
    await boot();
    const sam = await signIn();
    const r = (await send(sam, "GET", "/api/cluster/replication")).json;
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]).toMatchObject({ id: "101-0", guest: 101, guestName: "web", source: "pve", target: "pve2", schedule: "*/15", state: "ok", failCount: 0, lastSync: 1_760_000_000, nextSync: 1_760_000_900, comment: "web copy" });
    expect(r.guests.map((g: any) => g.vmid)).not.toContain(9000);
    expect((await send(sam, "GET", "/api/cluster/replication?guest=103")).json.jobs).toEqual([]);
    expect((await send(sam, "GET", "/api/cluster/replication?guest=12")).status).toBe(400);
  });

  it("creates a job with the next free number and refuses what can't work", async () => {
    await boot();
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/replication", { guest: 101, target: "pve2" })).json.code).toBe("duplicate");
    expect((await send(sam, "POST", "/api/cluster/replication", { guest: 101, target: "pve" })).json.code).toBe("same_node");
    expect((await send(sam, "POST", "/api/cluster/replication", { guest: 101, target: "pve3" })).json.code).toBe("node_offline");
    expect((await send(sam, "POST", "/api/cluster/replication", { guest: 101, target: "ghost" })).status).toBe(404);
    expect((await send(sam, "POST", "/api/cluster/replication", { guest: 9000, target: "pve2" })).json.code).toBe("template");
    expect((await send(sam, "POST", "/api/cluster/replication", { guest: 555, target: "pve2" })).status).toBe(404);
    expect((await send(sam, "POST", "/api/cluster/replication", { guest: 102, target: "pve2", schedule: "bad; rm" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/replication", { guest: 102, target: "pve2", rate: 0 })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/replication", { guest: 102, target: "pve2", id: "x" })).status).toBe(400);
    const ok = await send(sam, "POST", "/api/cluster/replication", { guest: 102, target: "pve2", schedule: "mon..fri 02:00", rate: 50, comment: "nightly" });
    expect(ok.json.id).toBe("102-0");
    expect(form(calls("POST", "/cluster/replication")[0].body)).toEqual({ id: "102-0", type: "local", target: "pve2", schedule: "mon..fri 02:00", rate: "50", comment: "nightly" });
    const second = await send(sam, "POST", "/api/cluster/replication", { guest: 101, target: "pve3".replace("3", "2") });
    expect(second.status).toBe(409);
  });

  it("edits with a digest, clears settings, and deleting needs the id typed", async () => {
    await boot();
    const sam = await signIn();
    const put = await send(sam, "PUT", "/api/cluster/replication/101-0", { schedule: "hourly", rate: null, disable: true, digest: "p1" });
    expect(put.status).toBe(200);
    expect(form(calls("PUT", "/cluster/replication/101-0")[0].body)).toEqual({ schedule: "hourly", disable: "1", delete: "rate", digest: "p1" });
    expect((await send(sam, "PUT", "/api/cluster/replication/101-0", { schedule: "hourly", digest: "old" })).status).toBe(502);
    expect((await send(sam, "PUT", "/api/cluster/replication/101-0", {})).status).toBe(400);
    expect((await send(sam, "PUT", "/api/cluster/replication/not-an-id", { schedule: "hourly" })).status).toBe(400);
    expect((await send(sam, "DELETE", "/api/cluster/replication/101-0", {})).status).toBe(400);
    expect(calls("DELETE", "/cluster/replication/101-0")).toHaveLength(0);
    expect((await send(sam, "DELETE", "/api/cluster/replication/101-0", { confirm: "101-0", keep: true })).status).toBe(200);
    expect(form(calls("DELETE", "/cluster/replication/101-0")[0].body)).toEqual({}); // DELETE params ride in the URL
    expect(calls("DELETE", "/cluster/replication/101-0")).toHaveLength(1);
  });

  it("runs a job now on the node that owns it and reads its log", async () => {
    await boot();
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/replication/101-0/run-now", {})).status).toBe(200);
    expect((pve.st as any).replNow).toEqual({ node: "pve", id: "101-0" });
    const log = (await send(sam, "GET", "/api/cluster/replication/101-0/log")).json;
    expect(log).toMatchObject({ node: "pve", lines: ["start replication job", "end replication job"], total: 2 });
    expect((await send(sam, "GET", "/api/cluster/replication/101-0/log?start=1")).json.lines).toEqual(["end replication job"]);
  });
});

describe("migration", () => {
  it("explains where a machine can go and why not", async () => {
    await boot();
    const sam = await signIn();
    const r = (await send(sam, "GET", "/api/cluster/migrate/102?target=pve2")).json;
    expect(r).toMatchObject({ vmid: 102, type: "qemu", node: "pve", running: false });
    expect(r.targets.map((t: any) => [t.node, t.allowed])).toEqual([["pve2", true], ["pve3", false]]);
    expect(r.targets[1].reasons[0]).toMatch(/offline/);
    expect(r.localDisks).toEqual([{ volid: "local-lvm:vm-102-disk-0", size: 34359738368, cdrom: false, unused: false }]);
    expect(r.modes).toMatchObject({ online: false, offline: true, localDisks: true });
    const app = (await send(sam, "GET", "/api/cluster/migrate/103")).json;
    expect(app.ha).toEqual({ sid: "vm:103", state: "started" });
    expect(app.modes.online).toBe(true);
    const ct = (await send(sam, "GET", "/api/cluster/migrate/101")).json;
    expect(ct.modes).toMatchObject({ online: true, restart: true, localDisks: false });
    expect((await send(sam, "GET", "/api/cluster/migrate/555")).status).toBe(404);
    expect((await send(sam, "GET", "/api/cluster/migrate/102?target=ghost")).status).toBe(404);
    const stores = (await send(sam, "GET", "/api/cluster/migrate/102/storages?target=pve2")).json.storages;
    expect(stores.map((s: any) => s.storage)).toEqual(["ceph", "local-lvm"]);
  });

  it("migrates a stopped machine and hands back a task on the source node", async () => {
    await boot();
    const sam = await signIn();
    const r = await send(sam, "POST", "/api/cluster/migrate/102", { target: "pve2", withLocalDisks: true, targetStorage: "local-lvm", bwlimit: 51200 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ queued: false, node: "pve" });
    expect(r.json.task).toMatch(/^UPID:pve:/);
    expect(form(calls("POST", "/nodes/pve/qemu/102/migrate")[0].body)).toEqual({ target: "pve2", bwlimit: "51200", "with-local-disks": "1", targetstorage: "local-lvm" });
    const log = await send(await signIn(), "GET", `/api/node/tasks/${encodeURIComponent(r.json.task)}`);
    expect(log.json.lines.join("\n")).toMatch(/migration finished/);
  });

  it("runs a running container as a restart migration and a running VM online", async () => {
    await boot();
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/migrate/101", { target: "pve2" })).status).toBe(200);
    expect(form(calls("POST", "/nodes/pve/lxc/101/migrate")[0].body)).toEqual({ target: "pve2", restart: "1" });
    pve.st.ha.resources.delete("vm:103");
    expect((await send(sam, "POST", "/api/cluster/migrate/103", { target: "pve", online: true, withLocalDisks: true, migrationNetwork: "10.0.0.0/24", migrationType: "secure", withConntrackState: true })).status).toBe(200);
    expect(form(calls("POST", "/nodes/pve2/qemu/103/migrate")[0].body)).toEqual({ target: "pve", online: "1", "with-local-disks": "1", migration_type: "secure", migration_network: "10.0.0.0/24", "with-conntrack-state": "1" });
  });

  it("refuses combinations that cannot work before Proxmox is asked", async () => {
    await boot();
    const sam = await signIn();
    const post = (id: number, b: Record<string, unknown>) => send(sam, "POST", `/api/cluster/migrate/${id}`, b);
    expect((await post(102, { target: "pve" })).json.code).toBe("same_node");
    expect((await post(102, { target: "pve3" })).json.code).toBe("node_offline");
    expect((await post(102, { target: "ghost" })).status).toBe(404);
    expect((await post(102, { target: "pve2", online: true })).json.code).toBe("not_running");
    expect((await post(102, { target: "pve2", restart: true })).status).toBe(400);
    expect((await post(101, { target: "pve2", online: true, restart: true })).status).toBe(400);
    expect((await post(101, { target: "pve2", withLocalDisks: true })).status).toBe(400);
    expect((await post(102, { target: "pve2", targetStorage: "bad storage;" })).status).toBe(400);
    expect((await post(102, { target: "pve2", bwlimit: -5 })).status).toBe(400);
    expect((await post(102, { target: "pve2", migrationNetwork: "10.0.0.0/99" })).status).toBe(400);
    expect((await post(102, { target: "pve2", migrationType: "fast" })).status).toBe(400);
    expect((await post(102, { target: "pve2", force: true })).json.code).toBe("confirm");
    expect((await post(102, { target: "pve2", online: "yes" })).status).toBe(400);
    pve.st.guests.find((g) => g.vmid === 102)!.lock = "backup";
    expect((await post(102, { target: "pve2" })).json.code).toBe("locked");
    expect(calls("POST", "/nodes/pve/qemu/102/migrate")).toHaveLength(0);
  });

  it("moves an HA-managed machine through the HA manager, which has no task", async () => {
    await boot();
    const sam = await signIn();
    const r = await send(sam, "POST", "/api/cluster/migrate/103", { target: "pve" });
    expect(r.json).toMatchObject({ queued: true, ha: "vm:103", how: "migrate" });
    expect((pve.st as any).haMove).toEqual({ sid: "vm:103", how: "migrate", node: "pve" });
    expect(calls("POST", "/nodes/pve2/qemu/103/migrate")).toHaveLength(0);
    expect((await send(sam, "POST", "/api/cluster/migrate/103", { target: "pve", targetStorage: "ceph" })).json.code).toBe("ha_managed");
  });

  it("backs up machines on different nodes with one task per node", async () => {
    await boot();
    const sam = await signIn();
    const r = await send(sam, "POST", "/api/cluster/backup/run", { vmids: [101, 103, 104], storage: "local", mode: "snapshot" });
    expect(r.status).toBe(200);
    expect(r.json.tasks.map((t: any) => [t.node, t.vmids])).toEqual([["pve", [101]], ["pve2", [103, 104]]]);
    expect(form((pve.st as any).vzdump[1].body)).toMatchObject({ vmid: "103,104", storage: "local", mode: "snapshot" });
    const all = await send(sam, "POST", "/api/cluster/backup/run", { all: true, storage: "local" });
    expect(all.json.tasks.map((t: any) => t.node)).toEqual(["pve", "pve2"]);
    expect((await send(sam, "POST", "/api/cluster/backup/run", { vmids: [555], storage: "local" })).status).toBe(404);
    expect((await send(sam, "POST", "/api/cluster/backup/run", { vmids: [101], storage: "bad storage" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/backup/run", { vmids: [101], storage: "local", mode: "weird" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/backup/run", { storage: "local" })).status).toBe(400);
  });
});

describe("Ceph", () => {
  it("says calmly that Ceph isn't set up", async () => {
    await boot();
    const sam = await signIn();
    const r = await send(sam, "GET", "/api/cluster/ceph");
    expect(r.status).toBe(200);
    expect(r.json.installed).toBe(false);
  });

  it("shows health, monitors, OSDs, pools and flags", async () => {
    await boot({ ceph: true });
    const sam = await signIn();
    const r = (await send(sam, "GET", "/api/cluster/ceph")).json;
    expect(r).toMatchObject({ installed: true, node: "pve" });
    expect(r.status).toMatchObject({ health: "HEALTH_OK", monitors: { total: 2, quorum: ["pve", "pve2"] }, osds: { total: 3, up: 3, in: 3 }, pgs: { total: 128 } });
    expect(r.monitors.map((m: any) => [m.name, m.state])).toEqual([["pve", "leader"], ["pve2", "peon"]]);
    expect(r.osds.map((o: any) => [o.id, o.host, o.status, o.in])).toEqual([[0, "pve", "up", true], [1, "pve", "up", true], [2, "pve2", "up", true]]);
    expect(r.pools[0]).toMatchObject({ name: "vm-pool", size: 3, minSize: 2, pgNum: 128, autoscale: "on", application: "rbd" });
    expect(r.flags.find((f: any) => f.name === "noout")).toMatchObject({ value: false });
    expect((await send(sam, "GET", "/api/cluster/ceph?node=pve2")).json.node).toBe("pve2");
    expect((await send(sam, "GET", "/api/cluster/ceph?node=ghost")).status).toBe(404);
  });

  it("reads the configuration without letting a key line out", async () => {
    await boot({ ceph: true });
    const sam = await signIn();
    const r = (await send(sam, "GET", "/api/cluster/ceph/config")).json;
    expect(r.config).toContain("mon_host = 10.0.0.2");
    expect(r.config).not.toContain("SECRETKEYSECRET");
    expect(r.rules).toEqual([{ name: "replicated_rule", id: 0 }]);
    expect(r.log).toEqual(["cluster [INF] overall HEALTH_OK"]);
  });

  it("takes an OSD out only after it is typed, and scrubs and brings it back without", async () => {
    await boot({ ceph: true });
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/ceph/osd/1/out", {})).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ceph/osd/1/out", { confirm: "osd.2" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ceph/osd/1/out", { confirm: "osd.1" })).status).toBe(200);
    expect((await send(sam, "GET", "/api/cluster/ceph")).json.osds[1].in).toBe(false);
    expect((await send(sam, "POST", "/api/cluster/ceph/osd/1/in", {})).status).toBe(200);
    expect((await send(sam, "POST", "/api/cluster/ceph/osd/1/scrub", { deep: true })).status).toBe(200);
    expect(form(calls("POST", "/nodes/pve/ceph/osd/1/scrub")[0].body)).toEqual({ deep: "1" });
    // Destroying an OSD is now possible, but only with its name typed (see cluster-more.test.ts).
    expect((await send(sam, "POST", "/api/cluster/ceph/osd/1/destroy", {})).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ceph/osd/x/out", {})).status).toBe(404);
  });

  it("sets flags (pause needs typing), mutes warnings and validates the codes", async () => {
    await boot({ ceph: true });
    const sam = await signIn();
    expect((await send(sam, "PUT", "/api/cluster/ceph/flags", { flag: "noout", value: true })).status).toBe(200);
    expect(form(calls("PUT", "/cluster/ceph/flags/noout")[0].body)).toEqual({ value: "1" });
    expect((await send(sam, "GET", "/api/cluster/ceph")).json.status.health).toBe("HEALTH_WARN");
    expect((await send(sam, "PUT", "/api/cluster/ceph/flags", { flag: "pause", value: true })).status).toBe(400);
    expect((await send(sam, "PUT", "/api/cluster/ceph/flags", { flag: "pause", value: true, confirm: "pause" })).status).toBe(200);
    expect((await send(sam, "PUT", "/api/cluster/ceph/flags", { flag: "pause", value: false })).status).toBe(200);
    expect((await send(sam, "PUT", "/api/cluster/ceph/flags", { flag: "rm -rf", value: true })).status).toBe(400);
    expect((await send(sam, "PUT", "/api/cluster/ceph/health-mute", { code: "OSDMAP_FLAGS", value: true, ttl: "2h" })).status).toBe(200);
    expect(form((pve.st as any).muteCalls[0].body)).toEqual({ value: "1", ttl: "2h" });
    expect((await send(sam, "PUT", "/api/cluster/ceph/health-mute", { code: "lower", value: true })).status).toBe(400);
    expect((await send(sam, "PUT", "/api/cluster/ceph/health-mute", { code: "OSDMAP_FLAGS", value: true, ttl: "forever" })).status).toBe(400);
    expect((await send(sam, "GET", "/api/cluster/ceph")).json.mutes).toEqual(["OSDMAP_FLAGS"]);
  });

  it("creates and tunes pools with limits that keep data safe", async () => {
    await boot({ ceph: true });
    const sam = await signIn();
    expect((await send(sam, "POST", "/api/cluster/ceph/pools", { name: "a/b" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ceph/pools", { name: "one", size: 1 })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ceph/pools", { name: "one", size: 2, minSize: 3 })).status).toBe(400);
    expect((await send(sam, "POST", "/api/cluster/ceph/pools", { name: "one", application: "mystery" })).status).toBe(400);
    const ok = await send(sam, "POST", "/api/cluster/ceph/pools", { name: "fast", size: 3, minSize: 2, pgNum: 64, autoscale: "on", application: "rbd", addStorages: true });
    expect(ok.status).toBe(200);
    expect(form(calls("POST", "/nodes/pve/ceph/pool")[0].body)).toEqual({ name: "fast", size: "3", min_size: "2", pg_num: "64", pg_autoscale_mode: "on", application: "rbd", add_storages: "1" });
    expect((await send(sam, "PUT", "/api/cluster/ceph/pools/fast", { size: 2 })).status).toBe(400);
    expect((await send(sam, "PUT", "/api/cluster/ceph/pools/fast", { size: 2, confirm: "fast" })).status).toBe(200);
    expect((await send(sam, "PUT", "/api/cluster/ceph/pools/fast", { autoscale: "warn", minSize: 1 })).status).toBe(200);
    expect((await send(sam, "PUT", "/api/cluster/ceph/pools/fast", {})).status).toBe(400);
    expect((await send(sam, "PUT", "/api/cluster/ceph/pools/fast", { pgNum: 4 })).status).toBe(400);
    expect((await send(sam, "DELETE", "/api/cluster/ceph/pools/fast", {})).status).toBe(405);
  });
});

describe("the node selector for existing screens", () => {
  it("sends host-level calls to the node in X-EPC-Node and checks it first", async () => {
    await boot();
    const sam = await signIn();
    const withNode = (node: string) => ({ "X-EPC-Request": "1", "X-EPC-Node": node });
    await send(sam, "GET", "/api/network", undefined, withNode("pve2"));
    expect(pve.calls.some((c) => c.path === "/nodes/pve2/network")).toBe(true);
    pve.calls.length = 0;
    await send(sam, "GET", "/api/network", undefined, { "X-EPC-Request": "1" });
    expect(pve.calls.some((c) => c.path === "/nodes/pve/network")).toBe(true);
    expect(pve.calls.some((c) => c.path === "/nodes/pve2/network")).toBe(false);
    pve.calls.length = 0;
    await send(sam, "GET", "/api/network", undefined, withNode("pve"));
    expect(pve.calls.some((c) => c.path === "/nodes/pve/network")).toBe(true);
    const ghost = await send(sam, "GET", "/api/network", undefined, withNode("ghost"));
    expect(ghost.status).toBe(404);
    expect(ghost.json.code).toBe("unknown_node");
    expect((await send(sam, "GET", "/api/network", undefined, withNode("../etc"))).status).toBe(400);
    expect((await send(sam, "GET", "/api/network", undefined, withNode("pve2; drop"))).status).toBe(400);
  });

  it("applies to backups, storage and tasks as well", async () => {
    await boot();
    const sam = await signIn();
    const h = { "X-EPC-Request": "1", "X-EPC-Node": "pve2" };
    await send(sam, "GET", "/api/storage/local/content", undefined, h);
    await send(sam, "GET", "/api/tasks", undefined, h);
    expect(pve.calls.some((c) => c.path.startsWith("/nodes/pve2/storage/local/content"))).toBe(true);
    expect(pve.calls.some((c) => c.path === "/nodes/pve2/tasks")).toBe(true);
  });
});

describe("nothing secret leaves the host service", () => {
  it("never shows the peer password or a key in any answer", async () => {
    await boot({ single: true, ceph: false });
    pve.st.guests.length = 0;
    const sam = await signIn();
    await send(sam, "POST", "/api/cluster/join", { hostname: "10.0.0.9", fingerprint: FINGERPRINT, password: "hunter2-hunter2", confirm: "pve" });
    expect(seen.join("\n")).not.toContain("hunter2-hunter2");
  });
});
