// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

let live = true;
vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live, setup: { deviceName: "pve" } }) }));
vi.mock("../src/terminal/LazyTerminal.tsx", () => ({ Terminal: () => <div>terminal</div> }));

import { BackupPage } from "../src/pages/node/Backup.tsx";
import { BulkPage } from "../src/pages/node/Bulk.tsx";
import { HardwarePage } from "../src/pages/node/Hardware.tsx";
import { MappingsManagePage } from "../src/pages/node/MappingsManage.tsx";
import { ResourceTreePage } from "../src/pages/node/ResourceTree.tsx";
import { SdnPage } from "../src/pages/node/Sdn.tsx";

interface Call { method: string; path: string; query: URLSearchParams; body: any }
let calls: Call[];
let handlers: Record<string, (c: Call) => unknown>;
let nodes: { node: string; online: boolean }[];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const key = (method: string, path: string) => `${method} ${path}`;

beforeEach(() => {
  live = true;
  calls = [];
  nodes = [{ node: "pve", online: true }];
  handlers = {};
  localStorage.clear();
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const call: Call = { method: init.method ?? "GET", path: url.pathname, query: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.path === "/api/node/nodes") return json({ local: "pve", nodes: nodes.map((n) => ({ ...n, cpu: null, maxcpu: null, mem: null, maxmem: null, uptime: null })) });
    const h = handlers[key(call.method, call.path)];
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

describe("hardware", () => {
  it("shows CPU, boot mode and devices, and the packages", async () => {
    handlers["GET /api/node/hardware"] = () => ({ node: "pve", statusDenied: false, cpu: { model: "AMD EPYC", sockets: 1, cores: 16, threads: 32, mhz: 3000, flags: "fpu", hvm: true, usage: 0.1, load: [0.1, 0.2, 0.3], ioWait: 0 }, memory: { total: 16e9, used: 4e9 }, swap: null, rootfs: null, ksm: null, boot: { mode: "efi", secureboot: false }, kernel: "Linux 6", kernelRelease: "6.8", machine: "x86_64", pveVersion: "pve-manager/9", uptime: 100, pci: [{ id: "0000:01:00.0", class: "0x03", vendor: "0x10de", vendorName: "NVIDIA", device: "0x22", deviceName: "GA102", iommuGroup: 14, mdev: true }], pciDenied: false, usb: [], usbDenied: false, description: "" });
    handlers["GET /api/node/versions"] = () => ({ node: "pve", packages: [{ package: "proxmox-ve", version: "9.0.0", state: "Installed", oldVersion: null, title: null, running: null, manager: null }], running: null, manager: null });
    wrap(<HardwarePage />);
    expect(await screen.findByText("AMD EPYC")).toBeTruthy();
    expect(screen.getByText(/UEFI/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "PCI and USB" }));
    expect(await screen.findByText("0000:01:00.0")).toBeTruthy();
    expect(screen.getByText("Mediated types")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Package versions" }));
    expect(await screen.findByText("proxmox-ve")).toBeTruthy();
  });
});

describe("bulk actions", () => {
  beforeEach(() => {
    handlers["GET /api/node/resources"] = () => ({ totals: {}, pools: [], rows: [{ id: "qemu/100", type: "qemu", node: "pve", vmid: 100, name: "web", status: "running", template: false, pool: null, tags: [] }, { id: "lxc/101", type: "lxc", node: "pve", vmid: 101, name: "ct", status: "stopped", template: false, pool: null, tags: [] }] });
    handlers["POST /api/node/bulk/startall"] = () => ({ task: "UPID:pve:1:1:1:startall::sam@pve:" });
    handlers["POST /api/node/bulk/stopall"] = () => ({ task: "UPID:pve:1:1:1:stopall::sam@pve:" });
  });
  it("starts the chosen machines without a confirmation", async () => {
    wrap(<BulkPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Start 2 machines/ }));
    await waitFor(() => expect(posted("POST", "/api/node/bulk/startall")).toHaveLength(1));
    expect(posted("POST", "/api/node/bulk/startall")[0].body).toMatchObject({ vms: [100, 101], force: true });
  });
  it("makes you type the node name before shutting down", async () => {
    wrap(<BulkPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Shut down 2 machines/ }));
    const go = await screen.findByRole("button", { name: "Shut down" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "pve" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("POST", "/api/node/bulk/stopall")).toHaveLength(1));
    expect(posted("POST", "/api/node/bulk/stopall")[0].body).toMatchObject({ confirm: "pve" });
  });
});

describe("resources", () => {
  it("shows totals and groups by pool", async () => {
    handlers["GET /api/node/resources"] = () => ({ totals: { nodes: { online: 1, total: 1 }, cpu: { used: 1, total: 4 }, memory: { used: 2e9, total: 8e9 }, storage: { used: 1e9, total: 4e9 }, guests: { running: 1, stopped: 0, templates: 0, vms: 1, containers: 0 } }, pools: [{ pool: "prod", comment: null }], rows: [{ id: "qemu/100", type: "qemu", node: "pve", vmid: 100, name: "web", status: "running", template: false, pool: "prod", tags: ["web"] }] });
    wrap(<ResourceTreePage />);
    expect(await screen.findByText("Whole datacenter")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Pool" }));
    expect(await screen.findByLabelText("Resources: prod")).toBeTruthy();
  });
});

describe("backup", () => {
  beforeEach(() => {
    handlers["GET /api/node/backup/jobs"] = () => ({ jobs: [{ id: "daily", nextRun: 1800000000, type: "vzdump", digest: "d", values: { schedule: "02:00", storage: "pbs", all: true, mode: "snapshot", enabled: true } }], denied: false, uncovered: [{ vmid: 102, name: "db", type: "qemu" }], uncoveredDenied: false, storages: ["pbs"], pools: [], schema: {} });
    handlers["DELETE /api/node/backup/jobs/daily"] = () => ({ ok: true });
  });
  it("lists jobs, warns about uncovered machines and deletes after typing the name", async () => {
    wrap(<BackupPage />);
    expect(await screen.findByText("daily")).toBeTruthy();
    expect(screen.getByText(/1 machine isn't in any backup job/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Delete daily"));
    const go = await screen.findByRole("button", { name: "Delete job" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "daily" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("DELETE", "/api/node/backup/jobs/daily")).toHaveLength(1));
    expect(posted("DELETE", "/api/node/backup/jobs/daily")[0].body).toEqual({ confirm: "daily" });
  });
});

describe("sdn", () => {
  it("shows staged changes and asks for the word rollback", async () => {
    handlers["GET /api/node/sdn"] = () => ({ zones: [{ id: "lab", type: "vlan", state: "new", digest: null, values: { bridge: "vmbr0" }, secretsSet: [] }], vnets: [], ipams: [], dns: [], controllers: [], pending: 1, denied: false, error: null, types: { zones: { vlan: { label: "VLAN", schema: {}, required: ["bridge"] } }, ipams: {}, dns: {}, controllers: {} }, vnetSchema: {}, subnetSchema: {}, firewallSchema: {} });
    handlers["POST /api/node/sdn/rollback"] = () => ({ ok: true });
    handlers["POST /api/node/sdn/apply"] = () => ({ task: "UPID:pve:1:1:1:reloadnetworkall::sam@pve:" });
    wrap(<SdnPage />);
    expect(await screen.findByText("1 change is staged")).toBeTruthy();
    expect(screen.getByText("lab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
    const go = await screen.findByRole("button", { name: "Discard changes" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "rollback" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("POST", "/api/node/sdn/rollback")[0].body).toEqual({ confirm: "rollback" }));
  });
});

describe("mappings", () => {
  it("lists a PCI mapping with its problems and deletes after typing the name", async () => {
    handlers["GET /api/node/mappings"] = () => ({ denied: false, checkedNode: "pve", usb: [], dir: [], pci: [{ id: "gpu0", description: "GPU", mdev: false, liveMigration: false, digest: "d", map: [{ node: "pve", path: "0000:01:00", id: "10de:2204", subsystemId: "", iommugroup: 14, description: "" }], checks: [{ severity: "warning", message: "IOMMU group shared" }] }] });
    handlers["DELETE /api/node/mappings/pci/gpu0"] = () => ({ ok: true });
    wrap(<MappingsManagePage />);
    expect(await screen.findByText("IOMMU group shared")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Delete gpu0"));
    const go = await screen.findByRole("button", { name: "Delete mapping" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "gpu0" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("DELETE", "/api/node/mappings/pci/gpu0")).toHaveLength(1));
  });
});
