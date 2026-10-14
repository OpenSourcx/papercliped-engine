import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { MachineError, planCpu, planCtOptions, planDevice, planMachine, planMemoryExtras, planNuma, planVmOptions, readSettings, type Cfg, type Change, type DeviceKind, type Json, type PlanContext } from "@papercliped-engine/proxmox-client/machine-schema";
import { planPassthrough } from "@papercliped-engine/proxmox-client/machine-extra";
import type { FeatureCtx, FeatureHandler } from "./index.ts";
import { asBadRequest, findGuest, guardedConfig, guestUrl, isRoot, seg, soft, writeChange, type Found } from "./machineCommon.ts";

/**
 * Processor details, memory extras, machine type and SCSI controller, small devices (random number generator,
 * watchdog, shared folders, parallel ports), the VM and container Options beyond the basics, host devices (PCI, USB,
 * container devices) and pending changes. Everything runs as the signed-in person, so Proxmox decides who may do what.
 * Edits carry the configuration digest from the last read. See docs/MACHINE.md.
 */

type Row = Record<string, unknown>;
const ROUTE = /^\/api\/guests\/(\d+)\/(settings|settings\/choices|settings\/(cpu|numa|memory|machine|vmoptions|ctoptions|rng|watchdog|virtiofs|parallel)|host-devices|pending|pending\/revert)$/;

export const handleMachineSettings: FeatureHandler = async (ctx) => {
  const m = ctx.path.match(ROUTE);
  if (!m) return false;
  try {
    return await route(ctx, m);
  } catch (e) {
    return asBadRequest(ctx, e);
  }
};

async function route(ctx: FeatureCtx, m: RegExpMatchArray): Promise<boolean> {
  const vmid = Number(m[1]);
  const what = m[2];
  if (ctx.method === "GET") {
    const out = await ctx.asUser(async (pve, s) => {
      const g = await findGuest(ctx, pve, vmid);
      if (what === "settings") return settings(ctx, pve, g, vmid);
      if (what === "settings/choices") return choices(ctx, pve, g);
      if (what === "host-devices") return hostDevices(ctx, pve, g, s.username);
      if (what === "pending") return pending(pve, g, vmid);
      throw new ctx.HttpError(405, "method", "Method not allowed");
    });
    return ctx.json(200, out), true;
  }
  if (ctx.method !== "POST") throw new ctx.HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  const b = await ctx.readJson(48 * 1024);
  const out = await ctx.asUser(async (pve, s) => {
    const g = await findGuest(ctx, pve, vmid);
    const { cfg, digest: dg } = await guardedConfig(ctx, pve, g, vmid, b);
    const body = { ...b };
    delete body.digest;
    if (what === "pending/revert") {
      const keys = Array.isArray(b.keys) ? b.keys : null;
      if (!keys || !keys.length || keys.length > 64 || !keys.every((k) => typeof k === "string" && /^[A-Za-z][\w-]{0,40}$/.test(k))) throw new ctx.HttpError(400, "bad_request", "Pick the pending changes to revert");
      if (g.status !== "running") throw new ctx.HttpError(409, "not_running", "Only a running machine has pending changes");
      await pve.call("PUT", guestUrl(g, vmid, "config"), { revert: (keys as string[]).join(","), digest: dg });
      return { ok: true, pending: true, warnings: [] };
    }
    const group = m[3];
    if (what === "host-devices") {
      const root = isRoot(s.username);
      const [pciMaps, usbMaps] = await Promise.all([soft(pve.call<{ id: string }[]>("GET", "/cluster/mapping/pci")), soft(pve.call<{ id: string }[]>("GET", "/cluster/mapping/usb"))]);
      const change = planPassthrough(g.type, cfg, body, { root, pciMappings: pciMaps?.map((x) => x.id), usbMappings: usbMaps?.map((x) => x.id) });
      return { ...(await writeChange(pve, g, vmid, change, dg)), key: Object.keys(change.set)[0] ?? change.delete[0] };
    }
    if (!group) throw new ctx.HttpError(404, "not_found", "Not found");
    const vmOnly = group !== "ctoptions";
    if (vmOnly && g.type !== "qemu") throw new MachineError("These settings are for virtual machines");
    if (!vmOnly && g.type !== "lxc") throw new MachineError("These settings are for containers");
    const admin = await ctx.isNodeAdmin(pve);
    const pc: PlanContext = { admin };
    if (group === "cpu") {
      const [models, flags] = await Promise.all([soft(pve.call<{ name: string }[]>("GET", `/nodes/${seg(g.node)}/capabilities/qemu/cpu`)), soft(pve.call<{ name: string }[]>("GET", `/nodes/${seg(g.node)}/capabilities/qemu/cpu-flags`))]);
      pc.cpuModels = models?.map((x) => x.name);
      pc.cpuFlags = flags?.map((x) => x.name);
    }
    if (group === "virtiofs") pc.dirMappings = (await soft(pve.call<{ id: string }[]>("GET", "/cluster/mapping/dir")))?.map((x) => x.id);
    if (group === "vmoptions" && body.vmstatestorage) pc.storages = (await soft(pve.nodeStorages(g.node, "images")))?.map((x) => x.storage);
    const change = plan(group, cfg, body, pc);
    return { ...(await writeChange(pve, g, vmid, change, dg)), key: Object.keys(change.set)[0] ?? null };
  });
  return ctx.json(200, out), true;
}

function plan(group: string, cfg: Cfg, body: Json, pc: PlanContext): Change {
  if (group === "cpu") return planCpu(cfg, body, pc);
  if (group === "numa") return planNuma(cfg, body);
  if (group === "memory") return planMemoryExtras(cfg, body);
  if (group === "machine") return planMachine(cfg, body);
  if (group === "vmoptions") return planVmOptions(cfg, body, pc);
  if (group === "ctoptions") return planCtOptions(cfg, body, pc);
  return planDevice(cfg, group as DeviceKind, body, pc);
}

async function settings(ctx: FeatureCtx, pve: ProxmoxClient, g: Found, vmid: number) {
  const cfg = await pve.call<Cfg>("GET", guestUrl(g, vmid, "config"));
  const list = g.status === "running" ? await soft(pve.call<{ key: string; pending?: unknown; delete?: number }[]>("GET", guestUrl(g, vmid, "pending"))) : null;
  const [admin] = await Promise.all([ctx.isNodeAdmin(pve)]);
  return {
    ...readSettings(g.type, cfg),
    status: g.status,
    name: g.name,
    template: g.template,
    digest: typeof cfg.digest === "string" ? cfg.digest : null,
    locked: typeof cfg.lock === "string" ? cfg.lock : null,
    isAdmin: admin,
    pendingKeys: (list ?? []).filter((p) => p.pending !== undefined || p.delete).map((p) => p.key),
  };
}

/** What the editors offer; a list this account can't read comes back empty, never as an error. */
async function choices(ctx: FeatureCtx, pve: ProxmoxClient, g: Found) {
  const n = seg(g.node);
  const vm = g.type === "qemu";
  const [models, flags, machines, dirs, stores] = await Promise.all([
    vm ? soft(pve.call<{ name: string; vendor?: string; custom?: number }[]>("GET", `/nodes/${n}/capabilities/qemu/cpu`)) : null,
    vm ? soft(pve.call<{ name: string; description?: string }[]>("GET", `/nodes/${n}/capabilities/qemu/cpu-flags`)) : null,
    vm ? soft(pve.call<{ id: string; type?: string; version?: string }[]>("GET", `/nodes/${n}/capabilities/qemu/machines`)) : null,
    vm ? soft(pve.call<{ id: string; description?: string }[]>("GET", "/cluster/mapping/dir")) : null,
    soft(pve.nodeStorages(g.node, "images")),
  ]);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    cpuModels: (models ?? []).slice(0, 400).map((x) => ({ name: x.name, vendor: x.vendor ?? null, custom: x.custom === 1 })),
    cpuFlags: (flags ?? []).slice(0, 200).map((x) => ({ name: x.name, description: str(x.description) })),
    machines: (machines ?? []).map((x) => ({ id: x.id, type: x.type ?? null, version: x.version ?? null })),
    dirMappings: (dirs ?? []).map((x) => ({ id: x.id, description: str(x.description) })),
    storages: (stores ?? []).filter((s) => s.active !== 0).map((s) => s.storage),
  };
}

async function pending(pve: ProxmoxClient, g: Found, vmid: number) {
  const list = await pve.call<Row[]>("GET", guestUrl(g, vmid, "pending")).catch((e) => (e instanceof ProxmoxError && e.status === 403 ? [] : Promise.reject(e)));
  const secret = new Set(["cipassword", "password"]);
  return {
    running: g.status === "running",
    items: (Array.isArray(list) ? list : [])
      .filter((p) => p.pending !== undefined || p.delete)
      .map((p) => ({
        key: String(p.key),
        current: secret.has(String(p.key)) ? null : p.value === undefined ? null : String(p.value),
        pending: secret.has(String(p.key)) ? null : p.pending === undefined ? null : String(p.pending),
        remove: Boolean(p.delete),
      })),
  };
}

async function hostDevices(ctx: FeatureCtx, pve: ProxmoxClient, g: Found, username: string) {
  const n = seg(g.node);
  const vm = g.type === "qemu";
  const note = (e: unknown) => (e instanceof ProxmoxError && e.status === 403 ? "Your Proxmox account can't list host devices (it needs Sys.Audit for PCI and Sys.Modify for USB)." : "Proxmox couldn't list host devices.");
  const notes: { pci: string | null; usb: string | null; dev: string | null } = { pci: null, usb: null, dev: null };
  const [pci, usb] = vm
    ? await Promise.all([
        pve.call<Row[]>("GET", `/nodes/${n}/hardware/pci`, { "pci-class-blacklist": "05;06;0b" }).catch((e) => ((notes.pci = note(e)), [] as Row[])),
        pve.call<Row[]>("GET", `/nodes/${n}/hardware/usb`).catch((e) => ((notes.usb = note(e)), [] as Row[])),
      ])
    : [[], []];
  const maps = async (kind: "pci" | "usb") => {
    const list = vm ? await soft(pve.call<{ id: string; description?: string; mdev?: number; map?: string[] }[]>("GET", `/cluster/mapping/${kind}`)) : null;
    return (list ?? []).filter((x) => typeof x.id === "string").map((x) => ({ id: x.id, description: typeof x.description === "string" ? x.description : "", entries: Array.isArray(x.map) ? x.map.length : 0, mdev: x.mdev === 1 }));
  };
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const root = isRoot(username);
  return {
    root,
    pci: (Array.isArray(pci) ? pci : []).slice(0, 500).map((d) => ({ id: s(d.id) ?? "", vendor: s(d.vendor_name) ?? s(d.vendor), device: s(d.device_name) ?? s(d.device), class: s(d.class), iommuGroup: typeof d.iommugroup === "number" ? d.iommugroup : -1, mdev: d.mdev === true || d.mdev === 1 })).filter((d) => d.id),
    usb: (Array.isArray(usb) ? usb : []).filter((d) => d.class !== 9).slice(0, 500).map((d) => ({ id: `${s(d.vendid) ?? ""}:${s(d.prodid) ?? ""}`, port: s(d.usbpath) ?? `${d.busnum}-${d.port}`, name: [s(d.manufacturer), s(d.product)].filter(Boolean).join(" ") || "USB device", speed: s(d.speed) })),
    mappings: { pci: await maps("pci"), usb: await maps("usb") },
    notes,
    explainer: root
      ? null
      : "Proxmox lets only root@pam hand a raw host device to a machine. You can use a saved mapping instead: an administrator creates it under Datacenter, Resource mappings, and gives your account the Mapping.Use permission on it.",
    machine: vm ? "qemu" : "lxc",
  };
}

