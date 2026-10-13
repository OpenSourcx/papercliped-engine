import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@papercliped-engine/proxmox-client";
import { createApp } from "../src/app.ts";
import { startPinRuntime } from "../src/features/pin-automations.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeAccessPve } from "./fakes-access.ts";

/**
 * Test support for Pin's runtime: a Proxmox that can be driven (guests with usage and tags, power and snapshot calls that
 * check the caller's privileges the way Proxmox does, API tokens with privilege separation, a task list, a node that can
 * go offline, failures on demand), a release feed, and a running host service with the runner configured but not on a
 * timer, so a test moves the clock and calls `tick()` itself.
 */

const GiB = 1024 ** 3;
const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data }) });
const err = (message: string, status = 500) => ({ status, body: JSON.stringify({ message: `${message}\n` }) });

export interface FakeGuest {
  type: "lxc" | "qemu";
  name: string;
  status: "running" | "stopped";
  mem: number;
  maxmem: number;
  cpu: number;
  tags: string;
  pool?: string;
}

export function fakePinPve() {
  const base = fakeAccessPve();
  base.roles.set("PVEVMUser", { privs: ["VM.Audit", "VM.Console", "VM.PowerMgmt", "VM.Snapshot", "VM.Backup"], special: true });
  // lee may manage one machine but not hand out permissions.
  base.acl.push({ path: "/vms/101", ugid: "lee@pve", type: "user", roleid: "PVEVMAdmin", propagate: 1 });
  base.acl.push({ path: "/", ugid: "lee@pve", type: "user", roleid: "PVEAuditor", propagate: 1 });

  const guests = new Map<number, FakeGuest>([
    [101, { type: "lxc", name: "web", status: "running", mem: 1.5 * GiB, maxmem: 2 * GiB, cpu: 0.1, tags: "prod" }],
    [102, { type: "lxc", name: "cache", status: "running", mem: 0.4 * GiB, maxmem: 2 * GiB, cpu: 0.05, tags: "protected" }],
    [200, { type: "qemu", name: "db", status: "stopped", mem: 0, maxmem: 4 * GiB, cpu: 0, tags: "" }],
  ]);
  const snapshots = new Map<number, string[]>();
  const taskList: { upid: string; type: string; id?: string; user: string; status?: string; starttime: number; endtime?: number; node: string }[] = [];
  const st = {
    /** Transient 500s to answer before power and snapshot calls succeed. */
    flaky: 0,
    /** Answer every power call with this error instead. */
    refusePower: null as { status: number; message: string } | null,
    /** The task Proxmox starts ends with this error. */
    taskFails: null as string | null,
    nodeOnline: true,
    unreachable: false,
  };
  const calls: { method: string; path: string; params: Record<string, string>; who: string }[] = [];
  let n = 0;

  /** Who is calling, and the privileges they hold at a path, the way Proxmox works them out. */
  const principalOf = (headers: Record<string, string>): { user: string; token?: string; privsep?: boolean } | null => {
    const auth = headers.Authorization ?? "";
    if (auth.startsWith("PVEAPIToken=")) {
      const m = /^PVEAPIToken=([^!]+)!([^=]+)=(.+)$/.exec(auth);
      const tk = m ? base.tokens.get(m[1])?.get(m[2]) : undefined;
      const owner = m ? base.users.get(m[1]) : undefined;
      if (!m || !tk || tk.secret !== m[3] || !owner || owner.enable === 0) return null;
      return { user: m[1], token: m[2], privsep: tk.privsep === 1 };
    }
    const user = base.tickets.get(decodeURIComponent((headers.Cookie ?? "").replace("PVEAuthCookie=", "")));
    return user ? { user } : null;
  };
  const privs = (p: { user: string; token?: string; privsep?: boolean }, path: string): Set<string> => {
    const out = new Set<string>();
    const subjects: { type: string; id: string }[] = [];
    if (p.token && p.privsep) subjects.push({ type: "token", id: `${p.user}!${p.token}` });
    else {
      subjects.push({ type: "user", id: p.user });
      for (const g of base.users.get(p.user)?.groups ?? []) subjects.push({ type: "group", id: g });
    }
    for (const a of base.acl) {
      if (!subjects.some((s) => s.type === a.type && s.id === a.ugid)) continue;
      if (a.path === path || (a.propagate && (a.path === "/" || path === a.path || path.startsWith(`${a.path}/`)))) for (const x of base.roles.get(a.roleid)?.privs ?? []) out.add(x);
    }
    return out;
  };

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = decodeURIComponent(u.pathname.replace("/api2/json", ""));
    const params: Record<string, string> = Object.fromEntries([...u.searchParams, ...new URLSearchParams(req.body ?? "")]);
    if (st.unreachable && path !== "/access/ticket") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const mine = /^\/(cluster\/resources$|nodes\/pve\/(tasks$|(lxc|qemu)\/\d+\/(status|snapshot)))/.test(path);
    if (!mine) return base.transport(req);
    const who = principalOf(req.headers);
    if (!who) return { status: 401, body: JSON.stringify({ message: "invalid credentials" }) };
    calls.push({ method: req.method, path, params, who: who.token ? `${who.user}!${who.token}` : who.user });
    const need = (priv: string, at: string) => (privs(who, at).has(priv) ? null : err(`Permission check failed (${at}, ${priv})`, 403));

    if (path === "/cluster/resources") {
      if (params.type === "storage") return base.transport(req);
      if (params.type === "node") return ok([{ id: "node/pve", type: "node", node: "pve", status: st.nodeOnline ? "online" : "offline" }]);
      const vm = [...guests].filter(([id]) => privs(who, `/vms/${id}`).has("VM.Audit")).map(([vmid, g]) => ({ id: `${g.type}/${vmid}`, type: g.type, vmid, node: "pve", name: g.name, status: g.status, mem: g.mem, maxmem: g.maxmem, cpu: g.cpu, maxcpu: 2, disk: 1 * GiB, maxdisk: 8 * GiB, tags: g.tags, pool: g.pool }));
      return ok(params.type === "vm" ? vm : [...vm, { id: "node/pve", type: "node", node: "pve", status: st.nodeOnline ? "online" : "offline" }]);
    }
    if (path === "/nodes/pve/tasks") return ok(taskList.slice(-Number(params.limit ?? 50)).reverse());

    const g = /^\/nodes\/pve\/(lxc|qemu)\/(\d+)\/(status\/(start|stop|shutdown|reboot)|snapshot(?:\/([^/]+)(\/rollback)?)?)$/.exec(path)!;
    const vmid = Number(g[2]);
    const guest = guests.get(vmid);
    if (!guest || guest.type !== g[1]) return err(`Configuration file 'nodes/pve/${g[1]}/${vmid}.conf' does not exist`, 500);
    const task = (type: string) => {
      const upid = `UPID:pve:${String(++n).padStart(8, "0")}:00000001:00000001:${type}:${vmid}:${who.user}:`;
      base.tasks.set(upid, st.taskFails ? [st.taskFails, `TASK ERROR: ${st.taskFails}`] : ["TASK OK"]);
      return upid;
    };
    if (g[4]) {
      const d = need("VM.PowerMgmt", `/vms/${vmid}`);
      if (d) return d;
      if (st.refusePower) return err(st.refusePower.message, st.refusePower.status);
      if (st.flaky > 0) {
        st.flaky--;
        return err("temporary failure", 503);
      }
      const upid = task(`${g[1] === "lxc" ? "vz" : "qm"}${g[4]}`);
      if (!st.taskFails) guest.status = g[4] === "start" || g[4] === "reboot" ? "running" : "stopped";
      return ok(upid);
    }
    // snapshots
    if (g[5] && req.method === "DELETE") {
      const d = need("VM.Snapshot", `/vms/${vmid}`);
      if (d) return d;
      snapshots.set(vmid, (snapshots.get(vmid) ?? []).filter((x) => x !== g[5]));
      return ok(task("qmdelsnapshot"));
    }
    if (g[5] && g[6]) {
      const d = need("VM.Snapshot.Rollback", `/vms/${vmid}`);
      if (d) return d;
      return ok(task("qmrollback"));
    }
    if (req.method === "POST") {
      const d = need("VM.Snapshot", `/vms/${vmid}`);
      if (d) return d;
      if (st.flaky > 0) {
        st.flaky--;
        return err("temporary failure", 503);
      }
      snapshots.set(vmid, [...(snapshots.get(vmid) ?? []), params.snapname]);
      return ok(task("qmsnapshot"));
    }
    return ok(snapshots.get(vmid) ?? []);
  };

  /** Adds a finished task to the task list, as Proxmox would after something ran. */
  const finishedTask = (t: { type: string; id?: string; user?: string; status?: string; at: number }) => {
    const upid = `UPID:pve:${String(++n).padStart(8, "0")}:00000001:00000001:${t.type}:${t.id ?? ""}:${t.user ?? "sam@pve"}:`;
    taskList.push({ upid, type: t.type, id: t.id, user: t.user ?? "sam@pve", status: t.status ?? "OK", starttime: Math.floor(t.at / 1000) - 5, endtime: Math.floor(t.at / 1000), node: "pve" });
    return upid;
  };

  return { ...base, transport, guests, snapshots, st, calls, finishedTask, taskList, privs };
}

export const FEED_BODY = (tag: string, extra: Record<string, unknown> = {}) => JSON.stringify({ tag_name: tag, name: tag, body: "Fixes and a calmer inbox.\n\n- One\n- Two", html_url: `https://github.com/OpenSourcx/papercliped-engine/releases/tag/${tag}`, published_at: "2026-10-01T00:00:00Z", draft: false, prerelease: false, ...extra });

/** A running host service with Pin's runtime configured, a clock the test controls and no timers. */
export async function startPinApp(o: { version?: string | null; helper?: boolean; feed?: { status: number; body: string } | "unreachable"; engine?: Parameters<typeof createApp>[0]["engine"]; pveTransport?: (base: Transport) => Transport; providers?: (url: string, init: RequestInit) => Promise<Response>; staticDir?: string | null } = {}) {
  const pve = fakePinPve();
  const clock = { t: new Date(2026, 9, 13, 12, 0, 0).getTime() };
  const now = () => clock.t;
  const root = mkdtempSync(join(tmpdir(), "epc-pin-"));
  const prefix = join(root, "opt");
  mkdirSync(prefix, { recursive: true });
  const versionFile = join(prefix, "VERSION");
  if (o.version !== null) writeFileSync(versionFile, `${o.version ?? "0.1.0"}\n`);
  if (o.helper) {
    mkdirSync(join(prefix, "update"), { recursive: true });
    writeFileSync(join(prefix, "update", "run.sh"), "#!/bin/sh\n");
  }
  const state = new StateStore(mkdtempSync(join(tmpdir(), "epc-pin-state-")));
  const feed = { current: o.feed ?? { status: 200, body: FEED_BODY("v0.2.0") } as { status: number; body: string } | "unreachable", requests: [] as { url: string; headers: Record<string, string> }[] };
  const outbound = async (url: string, init: RequestInit): Promise<Response> => {
    if (!url.startsWith("https://feed.test/")) return o.providers ? o.providers(url, init) : new Response("{}", { status: 404 });
    feed.requests.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    if (feed.current === "unreachable") throw new TypeError("fetch failed");
    return new Response(feed.current.body, { status: feed.current.status });
  };
  const transport = o.pveTransport ? o.pveTransport(pve.transport) : pve.transport;
  const sessions = new SessionStore(now);
  const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport }, sessions, staticDir: o.staticDir ?? null, secureCookies: false, state, now, fetch: outbound, engine: o.engine });
  const { rt, runner } = startPinRuntime(state, { pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport }, now, sleep: async () => {}, fetch: outbound, update: { versionFile, feedUrl: "https://feed.test/latest", helperDir: join(prefix, "update") } }, { run: false });
  const server: Server = createServer(app);
  server.on("upgrade", app.upgrade);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signIn = async (username: string) => {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username, password: "right", realm: "pve" }) });
    if (r.status !== 200) throw new Error(`sign-in failed ${r.status}`);
    return r.headers.get("set-cookie")!.split(";")[0];
  };
  const call = (method: string, path: string, auth: { cookie?: string; bearer?: string } = {}, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(method !== "GET" && auth.cookie ? { "X-EPC-Request": "1" } : {}), ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const close = async () => {
    runner.stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { pve, state, rt, runner, base, clock, signIn, call, close, feed, prefix, versionFile, stateDir: state.dir! };
}
