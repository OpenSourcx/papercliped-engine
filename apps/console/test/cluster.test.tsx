// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

let live = true;
vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live, setup: { deviceName: "pve" } }) }));

import { CephPage } from "../src/pages/cluster/CephPage.tsx";
import { ClusterConfigPage } from "../src/pages/cluster/ClusterPage.tsx";
import { HaPage } from "../src/pages/cluster/HaPage.tsx";
import { MigrateModal } from "../src/pages/cluster/Migrate.tsx";
import { ReplicationPage } from "../src/pages/cluster/ReplicationPage.tsx";
import { getSelectedNode, nodeHeaders, setSelectedNode } from "../src/lib/selectedNode.ts";

interface Call { method: string; path: string; query: URLSearchParams; body: any }
let calls: Call[];
let handlers: Record<string, (c: Call) => unknown>;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const members = (names: [string, boolean][]) => names.map(([name, online], i) => ({ name, nodeid: i + 1, ip: `10.0.0.${i + 2}`, online, local: i === 0, votes: 1, links: [{ n: 0, address: `10.0.0.${i + 2}` }], level: null, guests: { running: 1, total: 2 } }));
const overview = (clustered: boolean) => ({
  clustered, name: clustered ? "lab" : null, quorate: true, configVersion: 3, local: "pve", pveVersion: "9.0.3", pveMajor: 9,
  nodes: clustered ? members([["pve", true], ["pve2", true], ["pve3", false]]) : members([["pve", true]]),
  onlineCount: clustered ? 2 : 1, votes: clustered ? 3 : 1, totem: clustered ? { link_mode: "passive", secauth: "on" } : null, qdevice: clustered ? { configured: false, text: null } : null,
  joinApiVersion: 1, guestsHere: { running: 0, total: 0 }, denied: { status: false, config: false }, canChange: true,
});

beforeEach(() => {
  live = true;
  calls = [];
  handlers = {};
  localStorage.clear();
  setSelectedNode(null);
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const call: Call = { method: init.method ?? "GET", path: url.pathname, query: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.path === "/api/node/nodes") return json({ local: "pve", nodes: [{ node: "pve", online: true }] });
    const h = handlers[`${call.method} ${call.path}`];
    if (!h) return json({ error: "Not found" }, 404);
    const out = h(call);
    return out instanceof Response ? out : json(out);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={["/pve/x"]}>{ui}</MemoryRouter></QueryClientProvider>);
const posted = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("live only and a single device", () => {
  it("says so in the demo and fetches nothing", async () => {
    live = false;
    wrap(<ClusterConfigPage />);
    expect(await screen.findByText(/works on a connected device/)).toBeTruthy();
    expect(calls.filter((c) => c.path !== "/api/node/nodes")).toHaveLength(0);
  });

  it("explains calmly that this device is not in a cluster and offers Create cluster", async () => {
    handlers["GET /api/cluster/overview"] = () => overview(false);
    wrap(<ClusterConfigPage />);
    expect(await screen.findByText("This device is not in a cluster")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create cluster/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Join a cluster/ })).toBeTruthy();
  });

  it.each([["High availability", <HaPage key="ha" />], ["Replication", <ReplicationPage key="r" />]])("%s screen shows the not-in-a-cluster message instead of an error", async (_n, page) => {
    handlers["GET /api/cluster/overview"] = () => overview(false);
    wrap(page);
    expect(await screen.findByText("This device is not in a cluster")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create cluster" })).toBeTruthy();
    expect(screen.queryByText(/Couldn't read/)).toBeNull();
  });
});

describe("create and join", () => {
  beforeEach(() => {
    handlers["GET /api/cluster/overview"] = () => overview(false);
    handlers["GET /api/cluster/log"] = () => ({ entries: [] });
  });

  it("creates only after the cluster name is typed", async () => {
    handlers["POST /api/cluster/create"] = () => ({ task: "UPID:pve:1:1:1:clustercreate::sam@pve:", node: "pve" });
    handlers["GET /api/node/tasks/UPID%3Apve%3A1%3A1%3A1%3Aclustercreate%3A%3Asam%40pve%3A"] = () => ({ node: "pve", status: "stopped", exitstatus: "OK", lines: ["done"], next: 1, total: 1 });
    wrap(<ClusterConfigPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Create cluster/ }));
    const go = await screen.findByRole("button", { name: "Create cluster" });
    type("Cluster name", "lab");
    expect((go as HTMLButtonElement).disabled).toBe(true);
    type(/Type .* to confirm/, "lab");
    expect((go as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(posted("POST", "/api/cluster/create")).toHaveLength(1));
    expect(posted("POST", "/api/cluster/create")[0].body).toEqual({ name: "lab", confirm: "lab", links: [] });
  });

  it("joins with a write-only password and the device name typed", async () => {
    handlers["POST /api/cluster/join-info/parse"] = () => ({ ipAddress: "10.0.0.9", fingerprint: "AA:BB", peerLinks: {} });
    handlers["POST /api/cluster/join"] = () => ({ task: "UPID:pve:2:1:1:clusterjoin::sam@pve:", node: "pve", signOutExpected: true });
    wrap(<ClusterConfigPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Join a cluster/ }));
    type("Join information", "eyJ4IjoxfQ==");
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    await waitFor(() => expect((screen.getByLabelText("Address of a node in the cluster") as HTMLInputElement).value).toBe("10.0.0.9"));
    expect((screen.getByLabelText("Certificate fingerprint") as HTMLInputElement).value).toBe("AA:BB");
    const pw = screen.getByLabelText("Root password of that node") as HTMLInputElement;
    expect(pw.type).toBe("password");
    fireEvent.change(pw, { target: { value: "s3cret-pw" } });
    const go = screen.getByRole("button", { name: "Join cluster" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    type(/Type .* to confirm/, "pve");
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(posted("POST", "/api/cluster/join")).toHaveLength(1));
    expect(posted("POST", "/api/cluster/join")[0].body).toMatchObject({ hostname: "10.0.0.9", password: "s3cret-pw", confirm: "pve" });
    expect(document.body.textContent).not.toContain("s3cret-pw");
  });
});

describe("a cluster", () => {
  beforeEach(() => {
    handlers["GET /api/cluster/overview"] = () => overview(true);
    handlers["GET /api/cluster/log"] = () => ({ entries: [{ time: 1_760_000_000, node: "pve", tag: "pmxcfs", user: null, pid: 1, priority: 6, message: "started" }] });
  });

  it("shows quorum, nodes and votes, and the log", async () => {
    wrap(<ClusterConfigPage />);
    expect(await screen.findByText("Quorate")).toBeTruthy();
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getAllByText("pve3").length).toBeGreaterThan(0);
    expect(screen.getByText("This device")).toBeTruthy();
    expect(await screen.findByText(/pmxcfs: started/)).toBeTruthy();
  });

  it("removes a node only after its name is typed", async () => {
    handlers["GET /api/cluster/nodes/pve3/removal"] = () => ({ node: "pve3", online: false, local: false, guests: [{ vmid: 105, name: "old", type: "qemu" }], haResources: [], replicationJobs: [], steps: ["Power it off."] });
    handlers["POST /api/cluster/nodes/pve3/remove"] = () => ({ ok: true });
    wrap(<ClusterConfigPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove pve3" }));
    expect(await screen.findByText(/old \(105\)/)).toBeTruthy();
    const go = screen.getByRole("button", { name: "Remove node" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "pve3" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("POST", "/api/cluster/nodes/pve3/remove")[0].body).toEqual({ confirm: "pve3" }));
    expect(screen.queryByRole("button", { name: "Remove pve" })).toBeNull();
  });
});

const ha = (rules: boolean) => ({
  pveVersion: rules ? "9.0.3" : "8.4.1", pveMajor: rules ? 9 : 8, mode: rules ? "rules" : "groups", rulesSupported: rules, groupsSupported: true, denied: false, available: true,
  resources: [{ sid: "vm:103", type: "vm", vmid: 103, name: "app", node: "pve2", state: "started", group: rules ? null : "prefer", maxRestart: 1, maxRelocate: 1, failback: rules ? true : null, autoRebalance: null, comment: "", digest: "d1", current: "started", status: "ok" }],
  groups: rules ? [] : [{ group: "prefer", nodes: [{ node: "pve2", priority: 2 }, { node: "pve" }], restricted: false, nofailback: false, comment: "", digest: "g1" }],
  rules: rules ? [{ rule: "home", type: "node-affinity", resources: ["vm:103"], nodes: [{ node: "pve2", priority: 2 }], strict: false, affinity: "positive", comment: "", disabled: false, digest: "r1", state: null }] : [],
  status: { quorate: true, quorumText: "OK", master: { node: "pve", status: "pve (active)", timestamp: 1 }, lrms: [{ node: "pve", status: "pve (idle)", mode: null, timestamp: 1 }], armedState: rules ? "armed" : null, resourceMode: null, managerNode: "pve" },
  fencing: { mode: "watchdog", armed: rules ? "armed" : null, canArm: rules },
  nodes: [{ node: "pve", online: true }, { node: "pve2", online: true }, { node: "pve3", online: false }],
});

describe("high availability", () => {
  beforeEach(() => {
    handlers["GET /api/cluster/overview"] = () => overview(true);
    handlers["GET /api/cluster/replication"] = () => ({ jobs: [], denied: false, guests: [{ vmid: 102, name: "db", node: "pve", type: "qemu" }], nodes: [], statusUnavailable: [] });
  });

  it("lists resources, and the tab says Rules on a Proxmox that has them", async () => {
    handlers["GET /api/cluster/ha"] = () => ha(true);
    wrap(<HaPage />);
    expect(await screen.findByText("app")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Rules/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Rules/ }));
    expect(await screen.findByText("home")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add rule/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add group/ })).toBeNull();
  });

  it("shows groups on an older Proxmox, and removing one needs its name", async () => {
    handlers["GET /api/cluster/ha"] = () => ha(false);
    handlers["DELETE /api/cluster/ha/groups/prefer"] = () => ({ ok: true });
    wrap(<HaPage />);
    fireEvent.click(await screen.findByRole("tab", { name: /Groups/ }));
    expect(screen.queryByRole("button", { name: /Add rule/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Remove…" }));
    const go = screen.getByRole("button", { name: "Remove group" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "prefer" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("DELETE", "/api/cluster/ha/groups/prefer")[0].body).toEqual({ confirm: "prefer" }));
  });

  it("adds a machine with the chosen settings", async () => {
    handlers["GET /api/cluster/ha"] = () => ha(true);
    handlers["POST /api/cluster/ha/resources"] = () => ({ ok: true });
    wrap(<HaPage />);
    const add = (await screen.findByRole("button", { name: /Add machine/ })) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    await screen.findByLabelText("Machine");
    type("Restart attempts", "2");
    fireEvent.click(screen.getByRole("button", { name: "Add resource" }));
    await waitFor(() => expect(posted("POST", "/api/cluster/ha/resources")).toHaveLength(1));
    expect(posted("POST", "/api/cluster/ha/resources")[0].body).toMatchObject({ sid: "vm:102", state: "started", maxRestart: 2, maxRelocate: 1, failback: true });
  });

  it("disarms only after the word is typed and a mode is chosen", async () => {
    handlers["GET /api/cluster/ha"] = () => ha(true);
    handlers["POST /api/cluster/ha/arm"] = () => ({ ok: true });
    wrap(<HaPage />);
    fireEvent.click(await screen.findByRole("tab", { name: /Status and fencing/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Disarm HA/ }));
    const go = screen.getByRole("button", { name: "Disarm HA" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "disarm" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("POST", "/api/cluster/ha/arm")[0].body).toEqual({ action: "disarm", resourceMode: "freeze", confirm: "disarm" }));
  });
});

describe("replication", () => {
  const job = { id: "101-0", guest: 101, guestName: "web", guestType: "lxc", jobnum: 0, source: "pve", target: "pve2", schedule: "*/15", rate: null, comment: "", disabled: false, digest: "p1", lastSync: Math.floor(Date.now() / 1000) - 600, lastTry: null, nextSync: null, duration: 4.2, failCount: 0, error: null, syncing: false, state: "ok" };
  beforeEach(() => {
    handlers["GET /api/cluster/overview"] = () => overview(true);
    handlers["GET /api/cluster/replication"] = () => ({ jobs: [job], denied: false, guests: [{ vmid: 102, name: "db", node: "pve", type: "qemu" }], nodes: [{ node: "pve", online: true }, { node: "pve2", online: true }], statusUnavailable: [] });
  });

  it("shows jobs with their state and runs one now", async () => {
    handlers["POST /api/cluster/replication/101-0/run-now"] = () => ({ ok: true });
    wrap(<ReplicationPage />);
    expect(await screen.findByText("In sync")).toBeTruthy();
    expect(screen.getByText("10 minutes ago")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(posted("POST", "/api/cluster/replication/101-0/run-now")).toHaveLength(1));
  });

  it("creates a job from the form", async () => {
    handlers["POST /api/cluster/replication"] = () => ({ id: "102-0" });
    wrap(<ReplicationPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add job/ }));
    await screen.findByLabelText("Target node");
    type("Schedule preset", "hourly");
    fireEvent.click(screen.getByRole("button", { name: "Add job" }));
    await waitFor(() => expect(posted("POST", "/api/cluster/replication")).toHaveLength(1));
    expect(posted("POST", "/api/cluster/replication")[0].body).toMatchObject({ guest: 102, target: "pve2", schedule: "hourly" });
  });

  it("removes a job only after its id is typed, and can keep the copies", async () => {
    handlers["DELETE /api/cluster/replication/101-0"] = () => ({ ok: true });
    wrap(<ReplicationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove…" }));
    const go = screen.getByRole("button", { name: "Remove job" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Keep the copies on the target" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "101-0" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("DELETE", "/api/cluster/replication/101-0")[0].body).toEqual({ confirm: "101-0", keep: true }));
  });

  it("shows a failing job's error in words", async () => {
    handlers["GET /api/cluster/replication"] = () => ({ jobs: [{ ...job, state: "error", error: "no ZFS on target", failCount: 3 }], denied: false, guests: [], nodes: [{ node: "pve", online: true }, { node: "pve2", online: true }], statusUnavailable: ["pve3"] });
    wrap(<ReplicationPage />);
    expect(await screen.findByText("Failing")).toBeTruthy();
    expect(screen.getByText("no ZFS on target")).toBeTruthy();
    expect(screen.getByText(/3 failed tries/)).toBeTruthy();
    expect(screen.getByText(/No status from pve3/)).toBeTruthy();
  });
});

describe("migration", () => {
  const check = (over: Record<string, unknown> = {}) => ({
    vmid: 102, name: "db", type: "qemu", node: "pve", status: "stopped", running: false, template: false, locked: null,
    targets: [{ node: "pve2", online: true, allowed: true, reasons: [] }, { node: "pve3", online: false, allowed: false, reasons: ["The node is offline"] }],
    localDisks: [{ volid: "local-lvm:vm-102-disk-0", size: 34359738368, cdrom: false, unused: false }], localResources: [], mappedResources: [], dependentHa: [], conntrack: false, ha: null,
    modes: { online: false, offline: true, localDisks: true, restart: false }, ...over,
  });
  beforeEach(() => {
    handlers["GET /api/cluster/migrate/102/storages"] = () => ({ storages: [{ storage: "local-lvm", type: "lvmthin", shared: false, avail: 5e11, total: 1e12 }] });
  });

  it("offers only nodes that can take the machine and explains the others", async () => {
    handlers["GET /api/cluster/migrate/102"] = () => check();
    wrap(<MigrateModal vmid={102} onClose={() => {}} />);
    expect(await screen.findByText("Migrate db")).toBeTruthy();
    const opt = screen.getByRole("option", { name: /pve3/ }) as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
    expect(screen.getByText(/The node is offline/)).toBeTruthy();
    expect(screen.getByText(/local-lvm:vm-102-disk-0/)).toBeTruthy();
  });

  it("migrates and follows the task", async () => {
    handlers["GET /api/cluster/migrate/102"] = () => check();
    handlers["POST /api/cluster/migrate/102"] = () => ({ queued: false, task: "UPID:pve:3:1:1:qmigrate::sam@pve:", node: "pve" });
    handlers["GET /api/node/tasks/UPID%3Apve%3A3%3A1%3A1%3Aqmigrate%3A%3Asam%40pve%3A"] = () => ({ node: "pve", status: "stopped", exitstatus: "OK", lines: ["migration finished successfully"], next: 1, total: 1 });
    wrap(<MigrateModal vmid={102} onClose={() => {}} />);
    await screen.findByText("Migrate db");
    await waitFor(() => expect((screen.getByLabelText("Store them on") as HTMLSelectElement).options.length).toBeGreaterThan(1));
    type("Store them on", "local-lvm");
    fireEvent.click(screen.getByRole("button", { name: "Migrate" }));
    await waitFor(() => expect(posted("POST", "/api/cluster/migrate/102")).toHaveLength(1));
    expect(posted("POST", "/api/cluster/migrate/102")[0].body).toMatchObject({ target: "pve2", targetStorage: "local-lvm" });
    expect(await screen.findByText(/migration finished successfully/)).toBeTruthy();
  });

  it("tells you the HA manager does the move when the machine is under HA", async () => {
    handlers["GET /api/cluster/migrate/102"] = () => check({ ha: { sid: "vm:102", state: "started" }, localDisks: [] });
    handlers["POST /api/cluster/migrate/102"] = () => ({ queued: true, ha: "vm:102", how: "migrate", node: "pve" });
    wrap(<MigrateModal vmid={102} onClose={() => {}} />);
    expect(await screen.findByText("Managed by high availability")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Migrate" }));
    expect(await screen.findByText(/The HA manager will migrate/)).toBeTruthy();
  });

  it("asks for the machine number before migrating despite local devices", async () => {
    handlers["GET /api/cluster/migrate/102"] = () => check({ localResources: ["hostpci0"], localDisks: [] });
    wrap(<MigrateModal vmid={102} onClose={() => {}} />);
    await screen.findByText("Devices tied to this node");
    const go = screen.getByRole("button", { name: "Migrate" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Migrate anyway" }));
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type .* to confirm/), { target: { value: "102" } });
    expect(go.disabled).toBe(false);
  });
});

describe("Ceph", () => {
  it("says calmly that Ceph isn't set up", async () => {
    handlers["GET /api/cluster/ceph"] = () => ({ node: "pve", installed: false, denied: false, reason: "binary not installed" });
    wrap(<CephPage />);
    expect(await screen.findByText("Ceph isn't set up on this cluster")).toBeTruthy();
  });

  const ceph = {
    node: "pve", installed: true, denied: false,
    status: { health: "HEALTH_WARN", checks: [{ code: "OSDMAP_FLAGS", severity: "HEALTH_WARN", message: "noout flag set", muted: false }], fsid: "f", monitors: { total: 2, quorum: ["pve", "pve2"] }, osds: { total: 2, up: 2, in: 2 }, pgs: { total: 128, states: [{ state: "active+clean", count: 128 }] }, usage: { used: 3e9, available: 6e11, total: 6.03e11 }, io: { readBytes: 1000, writeBytes: 2000, readOps: 3, writeOps: 4 } },
    monitors: [{ name: "pve", host: "pve", addr: "10.0.0.2", rank: 0, quorum: true, state: "leader", version: "19.2.1" }], managers: [], metadataServers: [],
    osds: [{ id: 0, name: "osd.0", host: "pve", status: "up", in: true, deviceClass: "ssd", used: 1e9, total: 2e11, percentUsed: 0.5, pgs: 40, commitLatencyMs: 1, applyLatencyMs: 1, version: "19.2.1" }],
    pools: [{ name: "vm-pool", size: 3, minSize: 2, pgNum: 128, autoscale: "on", crushRule: "r", application: "rbd", used: 3e9, percentUsed: 0.05, type: "replicated", targetSizeRatio: null }],
    filesystems: [], flags: [{ name: "noout", description: "", value: true }, { name: "pause", description: "", value: false }], mutes: [],
  };

  it("shows health with warnings and mutes one", async () => {
    handlers["GET /api/cluster/ceph"] = () => ceph;
    handlers["PUT /api/cluster/ceph/health-mute"] = () => ({ ok: true });
    wrap(<CephPage />);
    expect((await screen.findAllByText("Warning")).length).toBeGreaterThan(0);
    expect(screen.getByText("noout flag set")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mute for a day" }));
    await waitFor(() => expect(posted("PUT", "/api/cluster/ceph/health-mute")[0].body).toEqual({ code: "OSDMAP_FLAGS", value: true, ttl: "1d" }));
  });

  it("takes an OSD out only after osd.N is typed, and pause needs typing too", async () => {
    handlers["GET /api/cluster/ceph"] = () => ceph;
    handlers["POST /api/cluster/ceph/osd/0/out"] = () => ({ ok: true });
    handlers["PUT /api/cluster/ceph/flags"] = () => ({ ok: true });
    wrap(<CephPage />);
    fireEvent.click(await screen.findByRole("tab", { name: /OSDs/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Take out…" }));
    const go = screen.getByRole("button", { name: "Take out" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "osd.0" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("POST", "/api/cluster/ceph/osd/0/out")[0].body).toMatchObject({ confirm: "osd.0" }));
    fireEvent.click(screen.getByRole("tab", { name: /Overview/ }));
    fireEvent.click(await screen.findByRole("switch", { name: "pause" }));
    expect(posted("PUT", "/api/cluster/ceph/flags")).toHaveLength(0);
    expect(await screen.findByText("Pause all reads and writes?")).toBeTruthy();
    const dlg = screen.getByRole("dialog");
    expect((within(dlg).getByRole("button", { name: "Pause Ceph" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the node selector for existing screens", () => {
  it("sends the chosen node as a header, and nothing for this device", () => {
    expect(nodeHeaders()).toEqual({});
    setSelectedNode("pve2");
    expect(getSelectedNode()).toBe("pve2");
    expect(nodeHeaders()).toEqual({ "X-EPC-Node": "pve2" });
    expect(JSON.parse(localStorage.getItem("epc.node")!)).toBe("pve2");
    setSelectedNode(null);
    expect(nodeHeaders()).toEqual({});
  });
});
