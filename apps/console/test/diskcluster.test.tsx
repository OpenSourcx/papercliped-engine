// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

let live = true;
vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live, setup: { deviceName: "pve" } }) }));

import { StorageHealthPage } from "../src/pages/disks/StorageHealth.tsx";
import { StorageToolsButton } from "../src/pages/storage/StorageTools.tsx";
import { BackupJobsPage } from "../src/pages/backups/BackupJobs.tsx";
import { CephManage, CephSetupCard } from "../src/pages/cluster/CephManage.tsx";
import { QdeviceCard, RemoteMigrateButton } from "../src/pages/cluster/ClusterTools.tsx";
import { ClusterResourcesPage } from "../src/pages/cluster/ResourcesPage.tsx";
import { SdnRoutedPage } from "../src/pages/cluster/SdnRouted.tsx";

interface Call { method: string; path: string; query: URLSearchParams; body: any }
let calls: Call[];
let handlers: Record<string, (c: Call) => unknown>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(() => {
  live = true;
  calls = [];
  handlers = {};
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const call: Call = { method: init.method ?? "GET", path: url.pathname, query: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.path === "/api/node/nodes") return json({ local: "pve", nodes: [{ node: "pve", online: true }, { node: "pve2", online: true }] });
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
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

const health = {
  node: "pve", level: "critical", thresholds: { wearWarn: 25, wearCrit: 10, usageWarn: 85, usageCrit: 95 },
  alerts: [{ level: "critical", kind: "disk-wear", subject: "/dev/nvme0n1", message: "/dev/nvme0n1 has 3% of its life left. Plan a replacement now." }, { level: "warning", kind: "pool-health", subject: "rpool", message: "The ZFS pool rpool is degraded." }],
  disks: [{ devpath: "/dev/nvme0n1", type: "nvme", model: "Fast", serial: "N1", sizeBytes: 1e12, usedBy: "unused", health: "PASSED", wearoutPct: 3, level: "critical", facts: { temperature: 45, powerOnHours: 12345, reallocated: null, pending: null, percentUsed: 97, spare: 8 } }],
  pools: [{ name: "rpool", health: "DEGRADED", sizeBytes: 1e12, allocBytes: 5e11, freeBytes: 5e11, fragmentation: 3, percentUsed: 50, level: "warning" }],
  thin: [], storages: [{ storage: "nas", type: "cifs", shared: true, total: 1e12, used: 9.7e11, percentUsed: 97, level: "critical" }], inactive: [], denied: { disks: false, pools: false, storages: false },
};

describe("storage health", () => {
  it("says so in the demo and fetches nothing", async () => {
    live = false;
    wrap(<StorageHealthPage />);
    expect(await screen.findByText(/works on a connected device/)).toBeTruthy();
    expect(calls.filter((c) => c.path !== "/api/node/nodes")).toHaveLength(0);
  });

  it("lists alerts first, then disks with wear and temperature", async () => {
    handlers["GET /api/disk-health"] = () => health;
    wrap(<StorageHealthPage />);
    expect(await screen.findByText(/3% of its life left/)).toBeTruthy();
    expect(screen.getByText("The ZFS pool rpool is degraded.")).toBeTruthy();
    expect(screen.getByText("45 °C")).toBeTruthy();
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(screen.getAllByText("Act now").length).toBeTruthy();
  });

  it("builds maintenance commands for a pool from the guide, never running them", async () => {
    handlers["GET /api/disk-health"] = () => health;
    handlers["GET /api/disk-health/zfs/rpool"] = () => ({ node: "pve", name: "rpool", state: "DEGRADED", status: null, action: null, scan: "resilver in progress", errors: "none", tree: [], disks: ["nvme-A-part3", "nvme-B-part3"], storages: [], volumes: [], actions: [] });
    handlers["GET /api/disk-health/zfs/rpool/guide"] = (c) => ({ steps: [{ title: "Start a scrub", command: `zpool ${c.query.get("action")} rpool`, note: null, risk: "low" }], cautions: [] });
    wrap(<StorageHealthPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Details and maintenance/ }));
    expect(await screen.findByText("zpool status rpool")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "scrub" } });
    expect(await screen.findByText("zpool scrub rpool")).toBeTruthy();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("space and tools", () => {
  const usage = { node: "pve", storage: "local", type: "dir", active: true, shared: false, total: 100e9, used: 60e9, avail: 40e9, percent: 60, byType: [{ content: "backup", label: "Backups", count: 4, bytes: 13e9 }], other: 1e9, byGuest: [], largest: [], denied: { status: false, content: false } };

  it("shows what fills a storage", async () => {
    handlers["GET /api/storage-tools/local/usage"] = () => usage;
    handlers["GET /api/storage-tools/local/rrd"] = () => ({ points: [] });
    wrap(<StorageToolsButton id="local" />);
    fireEvent.click(screen.getByRole("button", { name: /Space and tools/ }));
    expect(await screen.findByText(/Backups · 4/)).toBeTruthy();
    expect(screen.getAllByText(/Other/).length).toBeGreaterThan(0);
  });

  it("previews a prune, and deletes only after the storage's name is typed", async () => {
    handlers["GET /api/storage-tools/local/usage"] = () => usage;
    handlers["GET /api/storage-tools/local/rrd"] = () => ({ points: [] });
    handlers["GET /api/storage-tools/local/prune"] = () => ({ node: "pve", storage: "local", using: "these settings", retention: { keepLast: 1 }, items: [{ volid: "local:backup/a", vmid: 200, type: "qemu", ctime: 1, mark: "remove", size: 4e9 }, { volid: "local:backup/b", vmid: 200, type: "qemu", ctime: 2, mark: "keep", size: 4e9 }], counts: { keep: 1, remove: 1, protected: 0, renamed: 0 }, bytesToFree: 4e9, note: "A preview." });
    handlers["POST /api/storage-tools/local/prune"] = () => ({ task: null });
    wrap(<StorageToolsButton id="local" />);
    fireEvent.click(screen.getByRole("button", { name: /Space and tools/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Retention" }));
    fireEvent.change(screen.getByLabelText("Last"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const prune = await screen.findByRole("button", { name: /Prune 1 backup/ });
    expect(sent("POST", "/api/storage-tools/local/prune")).toHaveLength(0);
    fireEvent.click(prune);
    const go = screen.getByRole("button", { name: "Prune" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getAllByRole("textbox").at(-1)!, { target: { value: "local" } });
    expect((go as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(sent("POST", "/api/storage-tools/local/prune")).toHaveLength(1));
    expect(sent("POST", "/api/storage-tools/local/prune")[0].body).toMatchObject({ keepLast: 1, confirm: "local" });
  });
});

describe("backup jobs", () => {
  const job = { id: "nightly", enabled: true, schedule: "21:00", storage: "local", node: null, mode: "snapshot", compress: "zstd", selection: "pool", vmids: [], exclude: [], pool: "web", comment: "", notesTemplate: null, notificationMode: null, fleecing: { enabled: true, storage: "local-lvm" }, bwlimit: null, performance: { maxWorkers: null, pbsEntriesMax: null }, zstd: null, ionice: null, repeatMissed: false, protected: false, stdexcludes: true, excludePath: [], pbsChangeDetectionMode: null, stopwait: null, prune: { keepLast: 3 }, nextRun: null, digest: "d".repeat(40) };

  it("shows who a job covers and its options, and lists machines no job covers", async () => {
    handlers["GET /api/backup-tools/jobs"] = () => ({ jobs: [job], nodes: ["pve"], pools: ["web"], storages: ["local"] });
    handlers["GET /api/backup-tools/not-backed-up"] = () => ({ guests: [{ vmid: 202, name: "vm-other", type: "qemu", node: "pve" }] });
    wrap(<BackupJobsPage />);
    expect(await screen.findByText("nightly")).toBeTruthy();
    expect(screen.getByText("A pool")).toBeTruthy();
    expect(screen.getByText("fleecing")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Not covered" }));
    expect(await screen.findByText("vm-other")).toBeTruthy();
  });

  it("sends the digest when saving an edit", async () => {
    handlers["GET /api/backup-tools/jobs"] = () => ({ jobs: [job], nodes: ["pve"], pools: ["web"], storages: ["local"] });
    handlers["PUT /api/backup-tools/jobs/nightly"] = () => ({ ok: true });
    wrap(<BackupJobsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Schedule"), { target: { value: "sat 02:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("PUT", "/api/backup-tools/jobs/nightly")).toHaveLength(1));
    expect(sent("PUT", "/api/backup-tools/jobs/nightly")[0].body).toMatchObject({ schedule: "sat 02:00", digest: "d".repeat(40), selection: "pool", pool: "web" });
  });
});

describe("Ceph manage", () => {
  const ceph: any = { node: "pve", installed: true, denied: false, osds: [{ id: 0, name: "osd.0", host: "pve", status: "up", in: true }, { id: 3, name: "osd.3", host: "pve", status: "down", in: false }], pools: [{ name: "vm-pool", used: 3e9 }], monitors: [{ name: "pve", state: "leader" }], managers: [{ name: "pve", state: "active" }], metadataServers: [], filesystems: [] };

  it("destroys an OSD only when it is out and down, with its name typed", async () => {
    handlers["GET /api/cluster/ceph/crush"] = () => ({ node: "pve", denied: false, error: null, text: null, summary: null });
    handlers["POST /api/cluster/ceph/osd/3/destroy"] = () => ({ task: "UPID:pve:1:1:1:cephdestroyosd:x:sam@pve:" });
    handlers["GET /api/node/tasks/UPID%3Apve%3A1%3A1%3A1%3Acephdestroyosd%3Ax%3Asam%40pve%3A"] = () => ({});
    wrap(<CephManage c={ceph} />);
    const buttons = screen.getAllByRole("button", { name: "Destroy…" });
    // osd.0 is up and in, so its button is off; osd.3 is the first one that works.
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(buttons[1]);
    const go = screen.getByRole("button", { name: "Destroy OSD" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getAllByRole("textbox").at(-1)!, { target: { value: "osd.3" } });
    fireEvent.click(go);
    await waitFor(() => expect(sent("POST", "/api/cluster/ceph/osd/3/destroy")).toHaveLength(1));
    expect(sent("POST", "/api/cluster/ceph/osd/3/destroy")[0].body).toMatchObject({ confirm: "osd.3", cleanup: true });
  });

  it("needs the pool's name typed and carries the second yes for data", async () => {
    handlers["GET /api/cluster/ceph/crush"] = () => ({ node: "pve", denied: false, error: null, text: null, summary: null });
    handlers["POST /api/cluster/ceph/pools/vm-pool/delete"] = () => ({ task: "UPID:x" });
    wrap(<CephManage c={ceph} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("switch", { name: /destroy the/ }));
    fireEvent.change(screen.getAllByRole("textbox").at(-1)!, { target: { value: "vm-pool" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete pool" }));
    await waitFor(() => expect(sent("POST", "/api/cluster/ceph/pools/vm-pool/delete")).toHaveLength(1));
    expect(sent("POST", "/api/cluster/ceph/pools/vm-pool/delete")[0].body).toMatchObject({ confirm: "vm-pool", acknowledgeData: true });
  });

  it("gives the install command where Ceph isn't set up", async () => {
    handlers["GET /api/cluster/ceph/setup"] = () => ({ node: "pve", installed: false, releases: [{ name: "squid", version: "19.2", installable: true }], denied: false, installCommand: "pveceph install --repository no-subscription --version squid", initCommand: "" });
    wrap(<CephSetupCard />);
    expect(await screen.findByText("pveceph install --repository no-subscription --version squid")).toBeTruthy();
    const write = screen.getByRole("button", { name: "Write configuration" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
  });
});

describe("quorum device and remote migration", () => {
  it("builds the setup commands for an address and runs nothing", async () => {
    handlers["GET /api/cluster/qdevice"] = () => ({ clustered: true, configured: false, text: null, denied: false, nodes: 2, evenNodes: true, recommendation: "An even number of nodes can split evenly." });
    handlers["GET /api/cluster/qdevice/guide"] = (c) => ({ steps: [{ title: "Set it up", where: "any node", command: `pvecm qdevice setup ${c.query.get("address")}`, note: null }], cautions: [] });
    wrap(<QdeviceCard />);
    fireEvent.click(await screen.findByRole("button", { name: /Set one up/ }));
    fireEvent.change(screen.getByLabelText("Address of the outside machine"), { target: { value: "10.0.0.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Show the steps" }));
    expect(await screen.findByText("pvecm qdevice setup 10.0.0.9")).toBeTruthy();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("needs the machine number typed, sends the token once and clears it", async () => {
    handlers["GET /api/cluster/remote-migrate/200"] = () => ({ vmid: 200, name: "vm-lab", type: "qemu", node: "pve", running: false, bridges: ["vmbr0"], storages: ["local-lvm"], blockers: [], experimental: true });
    handlers["POST /api/cluster/remote-migrate/200"] = () => ({ task: "UPID:pve:1:1:1:qmigrate:x:sam@pve:" });
    wrap(<RemoteMigrateButton vmid={200} />);
    fireEvent.click(screen.getByRole("button", { name: /Move to another cluster/ }));
    await screen.findByLabelText("Other cluster's address");
    fireEvent.change(screen.getByLabelText("Other cluster's address"), { target: { value: "dc2.example.com" } });
    fireEvent.change(screen.getByLabelText(/Its certificate fingerprint/), { target: { value: "AA:BB" } });
    fireEvent.change(screen.getByLabelText(/API token ID/), { target: { value: "root@pam!move" } });
    fireEvent.change(screen.getByLabelText(/Token secret/), { target: { value: "11111111-2222-3333-4444-555555555555" } });
    const go = screen.getByRole("button", { name: "Move" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "200" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(sent("POST", "/api/cluster/remote-migrate/200")).toHaveLength(1));
    expect(sent("POST", "/api/cluster/remote-migrate/200")[0].body).toMatchObject({ host: "dc2.example.com", tokenId: "root@pam!move", targetStorage: "local-lvm", targetBridge: "vmbr0", confirm: "200" });
  });
});

describe("cluster resources and routed networks", () => {
  it("summarizes the cluster and filters the table", async () => {
    handlers["GET /api/cluster/resources"] = () => ({
      summary: { nodes: { total: 3, online: 2 }, cpu: { cores: 8, usedCores: 1.6 }, memory: { used: 4e9, total: 16e9 }, storage: { used: 1e11, total: 1e12 }, guests: { vms: { running: 1, total: 2 }, containers: { running: 1, total: 2 }, templates: 1 } },
      resources: [
        { id: "qemu/200", type: "qemu", vmid: 200, node: "pve", name: "vm-lab", status: "running", shared: false, template: false, tags: [], content: [], cpu: 0.1, maxcpu: 2, mem: 1e9, maxmem: 2e9, disk: null, maxdisk: 32e9, pool: "web" },
        { id: "storage/pve/local", type: "storage", storage: "local", node: "pve", status: "available", shared: false, template: false, tags: [], content: [], cpu: null, maxcpu: null, mem: null, maxmem: null, disk: 6e10, maxdisk: 1e11, pool: null },
      ],
      pools: ["web"], generated: 1,
    });
    wrap(<ClusterResourcesPage />);
    expect(await screen.findByText("vm-lab")).toBeTruthy();
    expect(screen.getByText(/1 of 2 virtual machines/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Storage" }));
    expect(screen.queryByText("vm-lab")).toBeNull();
    expect(screen.getByText("local")).toBeTruthy();
  });

  const sdn = { controllers: [{ controller: "bgp1", type: "evpn", asn: 65000, peers: "10.0.0.2" }], evpnZones: [], fabrics: [], fabricNodes: [], prefixLists: [], routeMaps: [], supported: { controllers: true, fabrics: false, prefixLists: false, routeMaps: false }, denied: false, controllerTypes: ["evpn"], protocols: [], matchKeys: [], setKeys: [], redistributeSources: {} };

  it("lists controllers, says plainly when fabrics don't exist yet, and creates a controller", async () => {
    handlers["GET /api/cluster/sdn"] = () => sdn;
    handlers["POST /api/cluster/sdn/controllers"] = () => ({ ok: true });
    wrap(<SdnRoutedPage />);
    expect(await screen.findByText("bgp1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /New EVPN controller/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "evpn2" } });
    fireEvent.change(screen.getByLabelText(/Peers/), { target: { value: "10.0.0.2,10.0.0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(sent("POST", "/api/cluster/sdn/controllers")).toHaveLength(1));
    expect(sent("POST", "/api/cluster/sdn/controllers")[0].body).toEqual({ type: "evpn", controller: "evpn2", asn: 65000, peers: "10.0.0.2,10.0.0.3" });
    fireEvent.click(screen.getByRole("tab", { name: /Fabrics/ }));
    expect(await screen.findByText(/doesn't have fabrics yet/)).toBeTruthy();
  });
});
