import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { CPU_TYPES, SECRET_PARAMS, WizardError, buildCt, buildVm, maskSecrets, storageFormats, type Built, type WizardContext } from "@papercliped-engine/proxmox-client/wizard-schema";
import type { FeatureCtx, FeatureHandler } from "./index.ts";
import { guarded, soft } from "./nodeCommon.ts";

/**
 * The Create virtual machine and Create container wizards (see docs/WIZARDS.md). The console collects choices; this
 * file loads what the node offers (storages, templates, ISOs, bridges, CPU models, PCI and USB devices, resource
 * groups), checks the whole request against the shared schema, shows the exact Proxmox parameters before anything is
 * created (secrets hidden) and creates the machine as the signed-in person, so Proxmox's own permissions decide.
 * Passwords, keys and cloud-init secrets are write-only: they are sent to Proxmox and never returned or logged.
 */

const seg = encodeURIComponent;
type Json = Record<string, unknown>;
const MAX_SPEC = 96 * 1024;

export const handleWizard: FeatureHandler = async (ctx: FeatureCtx) => {
  if (!ctx.path.startsWith("/api/wizard/")) return false;
  try {
    return await route(ctx);
  } catch (e) {
    if (e instanceof WizardError) throw new ctx.HttpError(400, "invalid", e.message);
    throw e;
  }
};

const storageKind = (kind: string) => (kind === "ct" ? "rootdir" : "images");

async function route(ctx: FeatureCtx): Promise<boolean> {
  const { method, path } = ctx;
  if (method === "GET" && path === "/api/wizard/options") {
    ctx.session();
    return ctx.json(200, await ctx.asUser((pve, s) => options(ctx, pve, s.username))), true;
  }
  if (method === "GET" && path === "/api/wizard/vmid") {
    ctx.session();
    const raw = ctx.url.searchParams.get("vmid") ?? "";
    if (!/^\d{3,9}$/.test(raw) || Number(raw) < 100 || Number(raw) > 999_999_999) return ctx.json(200, { free: false, message: "Use a number from 100 to 999999999" }), true;
    return ctx.json(200, await ctx.asUser((pve) => vmidFree(pve, Number(raw)))), true;
  }
  if (method === "POST" && (path === "/api/wizard/preview" || path === "/api/wizard/create")) {
    ctx.sameSite();
    ctx.session();
    const body = await ctx.readJson(MAX_SPEC);
    for (const k of Object.keys(body)) if (!["kind", "spec"].includes(k)) throw new ctx.HttpError(400, "bad_request", `Unknown field “${k}”`);
    const kind = body.kind === "vm" || body.kind === "ct" ? body.kind : null;
    if (!kind) throw new ctx.HttpError(400, "bad_request", "Choose container or virtual machine");
    const create = path === "/api/wizard/create";
    const out = await ctx.asUser(async (pve) => {
      const known = await context(ctx, pve, kind);
      // Check the request first with no machine number; the number is chosen below.
      const first = build(kind, body.spec, null, known);
      let vmid = first.vmid;
      if (vmid !== null) {
        const v = await vmidFree(pve, vmid);
        if (!v.free) throw new ctx.HttpError(409, "vmid_taken", v.message);
      } else vmid = await pve.nextId();
      const built = build(kind, body.spec, vmid, known);
      if (!create) return { preview: true as const, vmid, params: maskSecrets(built.params), warnings: built.warnings };
      const secrets = SECRET_PARAMS.map((k) => built.params[k]).map((v) => (typeof v === "string" ? v : undefined));
      const task = await guarded(secrets, () => (kind === "vm" ? pve.createVm(ctx.node, built.params) : pve.createLxc(ctx.node, built.params)));
      return { preview: false as const, vmid, task, warnings: built.warnings };
    });
    if (out.preview) return ctx.json(200, { vmid: out.vmid, params: out.params, warnings: out.warnings }), true;
    return ctx.json(202, { vmid: out.vmid, task: out.task, warnings: out.warnings }), true;
  }
  return false;
}

function build(kind: "vm" | "ct", spec: unknown, vmid: number | null, known: WizardContext): Built {
  return kind === "vm" ? buildVm(spec, vmid, known) : buildCt(spec, vmid, known);
}

async function vmidFree(pve: ProxmoxClient, vmid: number): Promise<{ free: boolean; message: string }> {
  try {
    await pve.checkVmidFree(vmid);
    return { free: true, message: "" };
  } catch (e) {
    if (e instanceof ProxmoxError && e.status !== 401 && e.status !== 403) return { free: false, message: `#${vmid} is already used by another machine` };
    throw e;
  }
}

/** What the node says is valid, so the shared checks can be exact. Parts that can't be read are left unchecked. */
async function context(ctx: FeatureCtx, pve: ProxmoxClient, kind: "vm" | "ct"): Promise<WizardContext> {
  const node = ctx.node;
  const [stores, bridges, models, pools] = await Promise.all([
    soft(pve.nodeStorages(node, storageKind(kind))),
    soft(listBridges(pve, node)),
    kind === "vm" ? soft(pve.call<{ name: string }[]>("GET", `/nodes/${seg(node)}/capabilities/qemu/cpu`)) : Promise.resolve({ data: null, denied: false, error: null }),
    soft(pve.pools()),
  ]);
  return {
    diskStorages: stores.data ? Object.fromEntries(stores.data.filter((s) => s.active !== 0).map((s) => [s.storage, { type: s.type }])) : undefined,
    bridges: bridges.data?.map((b) => b.id),
    cpuModels: models.data ? models.data.map((m) => m.name) : undefined,
    pools: pools.data && pools.data.length ? pools.data.map((p) => p.poolid) : undefined,
  };
}

async function listBridges(pve: ProxmoxClient, node: string): Promise<{ id: string; kind: "bridge" | "vnet" }[]> {
  const nets = await pve.call<{ iface: string; type?: string }[]>("GET", `/nodes/${seg(node)}/network`, { type: "any_bridge" });
  const vnets = await soft(pve.call<{ vnet: string }[]>("GET", "/cluster/sdn/vnets"));
  return [...nets.map((n) => ({ id: n.iface, kind: "bridge" as const })), ...(vnets.data ?? []).map((v) => ({ id: v.vnet, kind: "vnet" as const }))];
}

interface RawStorage {
  storage: string;
  type: string;
  avail?: number;
  total?: number;
  active?: number;
}

async function options(ctx: FeatureCtx, pve: ProxmoxClient, username: string) {
  const node = ctx.node;
  const notes: string[] = [];
  const active = <T extends { active?: number }>(l: T[]) => l.filter((s) => s.active !== 0);
  const [tplStores, ctStores, isoStores, vmStores, pools, nextid, bridges, models, machines, pci, usb, pciMaps, usbMaps, admin] = await Promise.all([
    soft(pve.nodeStorages(node, "vztmpl")),
    soft(pve.nodeStorages(node, "rootdir")),
    soft(pve.nodeStorages(node, "iso")),
    soft(pve.nodeStorages(node, "images")),
    soft(pve.pools()),
    pve.nextId(),
    soft(listBridges(pve, node)),
    soft(pve.call<{ name: string; vendor?: string; custom?: number }[]>("GET", `/nodes/${seg(node)}/capabilities/qemu/cpu`)),
    soft(pve.call<{ id: string; type: string; version?: string }[]>("GET", `/nodes/${seg(node)}/capabilities/qemu/machines`)),
    soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/hardware/pci`, { "pci-class-blacklist": "05;06;0b" })),
    soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/hardware/usb`)),
    soft(pve.call<{ id: string; description?: string }[]>("GET", "/cluster/mapping/pci")),
    soft(pve.call<{ id: string; description?: string }[]>("GET", "/cluster/mapping/usb")),
    ctx.isNodeAdmin(pve),
  ]);
  const templates = (await Promise.all(active(tplStores.data ?? []).map((s) => soft(pve.storageContent(node, s.storage, "vztmpl")).then((r) => r.data ?? [])))).flat();
  const isos = (await Promise.all(active(isoStores.data ?? []).map((s) => soft(pve.storageContent(node, s.storage, "iso")).then((r) => r.data ?? [])))).flat();
  const disk = (l: RawStorage[] | null) => active(l ?? []).map((s) => ({ storage: s.storage, type: s.type, avail: s.avail ?? null, formats: storageFormats(s.type) }));
  if (pci.denied || usb.denied) notes.push("Your account can't list this device's PCI or USB hardware, so only saved mappings are offered.");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const customCpu = (models.data ?? []).filter((m) => m.custom === 1 || (!(CPU_TYPES as readonly string[]).includes(m.name) && m.name.startsWith("custom-"))).map((m) => m.name);
  return {
    nextid,
    node,
    templates: (templates as { volid: string; size?: number }[]).map((t) => ({ volid: t.volid, name: t.volid.split("/").pop() ?? t.volid, size: t.size ?? null })),
    isos: (isos as { volid: string; size?: number }[]).map((t) => ({ volid: t.volid, name: t.volid.split("/").pop() ?? t.volid, size: t.size ?? null })),
    vmStorages: disk(vmStores.data),
    ctStorages: disk(ctStores.data),
    pools: (pools.data ?? []).map((p) => p.poolid),
    bridges: bridges.data ?? [],
    cpuTypes: { common: CPU_TYPES, custom: customCpu, host: (models.data ?? []).map((m) => ({ name: m.name, vendor: m.vendor ?? null })).slice(0, 400) },
    machines: (machines.data ?? []).map((m) => m.id).filter((id) => /^(pc-i440fx|pc-q35)-\d+\.\d+$/.test(id)),
    // Raw PCI and USB passthrough needs root@pam in Proxmox; everyone else can use saved mappings.
    rawPassthrough: username === "root@pam",
    pci: (pci.data ?? []).map((d) => ({ id: str(d.id), vendor: str(d.vendor_name), device: str(d.device_name), group: typeof d.iommugroup === "number" ? d.iommugroup : null })).filter((d) => d.id),
    usb: (usb.data ?? []).filter((d) => Number(d.level) > 0).map((d) => ({ host: `${str(d.vendid)}:${str(d.prodid)}`, port: `${d.busnum}-${d.port}`, name: [str(d.manufacturer), str(d.product)].filter(Boolean).join(" ") || "USB device" })).filter((d) => /^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(d.host)),
    pciMappings: (pciMaps.data ?? []).map((m) => ({ id: m.id, description: m.description ?? null })),
    usbMappings: (usbMaps.data ?? []).map((m) => ({ id: m.id, description: m.description ?? null })),
    isAdmin: admin,
    notes,
  };
}
