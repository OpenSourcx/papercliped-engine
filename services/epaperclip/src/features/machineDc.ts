import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { checkBulk, parseMapEntry, planCustomCpu, planMapping } from "@papercliped-engine/proxmox-client/machine-extra";
import type { FeatureCtx, FeatureHandler } from "./index.ts";
import { asBadRequest, soft } from "./machineCommon.ts";
import { resolveNode, seg } from "./nodeCommon.ts";

/**
 * Host hardware for passthrough (PCI devices with IOMMU groups and mediated types, USB devices), the node's
 * virtualization capabilities, resource mappings (PCI, USB, directory), custom CPU models and bulk power actions on
 * several machines. Everything runs as the signed-in person. See docs/MACHINE.md.
 */

type Row = Record<string, unknown>;
const ROUTE = /^\/api\/(hardware\/(pci|pci\/mdev|usb)|capabilities\/qemu|mappings\/(pci|usb|dir)(?:\/([A-Za-z][\w-]{1,63})(\/delete)?)?|cpu-models(?:\/([A-Za-z][\w-]{1,63})(\/delete)?)?|bulk\/(guests|node))$/;

export const handleMachineDc: FeatureHandler = async (ctx) => {
  const m = ctx.path.match(ROUTE);
  if (!m) return false;
  try {
    return await route(ctx, m);
  } catch (e) {
    return asBadRequest(ctx, e);
  }
};

const s = (v: unknown) => (typeof v === "string" ? v : null);
const denied = (e: unknown, what: string) => (e instanceof ProxmoxError && e.status === 403 ? `Your Proxmox account can't read ${what}.` : `Proxmox couldn't read ${what}.`);

async function route(ctx: FeatureCtx, m: RegExpMatchArray): Promise<boolean> {
  const { method } = ctx;
  if (method === "GET") {
    const out = await ctx.asUser(async (pve) => {
      if (m[1]?.startsWith("hardware")) return hardware(ctx, pve, m[2]);
      if (m[1] === "capabilities/qemu") return capabilities(ctx, pve);
      if (m[3]) return mappings(ctx, pve, m[3] as "pci" | "usb" | "dir");
      if (m[0].startsWith("/api/cpu-models")) return cpuModels(pve);
      throw new ctx.HttpError(405, "method", "Method not allowed");
    });
    return ctx.json(200, out), true;
  }
  if (method !== "POST") throw new ctx.HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  const b = await ctx.readJson(96 * 1024);

  if (m[3]) {
    const kind = m[3] as "pci" | "usb" | "dir";
    const out = await ctx.asUser(async (pve) => {
      if (m[5]) {
        if (b.confirm !== m[4]) throw new ctx.HttpError(409, "confirm", `Type ${m[4]} to confirm.`);
        await pve.call("DELETE", `/cluster/mapping/${kind}/${seg(m[4])}`);
        return { ok: true };
      }
      if (m[4]) {
        const dg = typeof b.digest === "string" && /^[0-9a-f]{40}$/.test(b.digest) ? b.digest : null;
        if (!dg) throw new ctx.HttpError(400, "bad_request", "This page is out of date. Reload and try again");
        const body: Record<string, unknown> = { ...b, id: m[4] };
        delete body.digest;
        const plan = planMapping(kind, body, false);
        const params: Record<string, string | boolean | string[] | undefined> = { map: plan.params.map, digest: dg };
        if (plan.params.description !== undefined) params.description = plan.params.description;
        if (plan.clearDescription && b.description !== undefined) params.delete = "description";
        if (plan.params.mdev !== undefined) params.mdev = plan.params.mdev;
        await pve.call("PUT", `/cluster/mapping/${kind}/${seg(m[4])}`, params as Record<string, string | boolean | string[]>);
        return { ok: true };
      }
      const plan = planMapping(kind, b, true);
      const existing = await soft(pve.call<{ id: string }[]>("GET", `/cluster/mapping/${kind}`));
      if (existing?.some((x) => x.id === plan.id)) throw new ctx.HttpError(409, "exists", `A mapping called ${plan.id} already exists`);
      await pve.call("POST", `/cluster/mapping/${kind}`, plan.params as Record<string, string | boolean | string[]>);
      return { ok: true, id: plan.id };
    });
    return ctx.json(200, out), true;
  }

  if (m[0].startsWith("/api/cpu-models")) {
    const out = await ctx.asUser(async (pve) => {
      if (m[7]) {
        if (b.confirm !== m[6]) throw new ctx.HttpError(409, "confirm", `Type ${m[6]} to confirm.`);
        await pve.call("DELETE", `/cluster/qemu/custom-cpu-models/${seg(m[6])}`);
        return { ok: true };
      }
      if (m[6]) {
        const body: Record<string, unknown> = { ...b, cputype: m[6] };
        const dg = typeof b.digest === "string" && /^[0-9a-f]{40}$/.test(b.digest) ? b.digest : undefined;
        delete body.digest;
        const p = planCustomCpu(body, false);
        await pve.call("PUT", `/cluster/qemu/custom-cpu-models/${seg(p.cputype)}`, { ...p.params, ...(p.del.length ? { delete: p.del.join(",") } : {}), digest: dg } as Record<string, string | boolean | undefined>);
        return { ok: true };
      }
      const p = planCustomCpu(b, true);
      await pve.call("POST", "/cluster/qemu/custom-cpu-models", { cputype: p.cputype, ...p.params } as Record<string, string | boolean | undefined>);
      return { ok: true, cputype: p.cputype };
    });
    return ctx.json(200, out), true;
  }

  if (m[8]) {
    const req = checkBulk(b);
    if (req.action !== "start" && b.confirm !== String(req.vms.length)) throw new ctx.HttpError(409, "confirm", `Type ${req.vms.length} to confirm acting on ${req.vms.length} machine${req.vms.length === 1 ? "" : "s"}.`);
    const out = await ctx.asUser(async (pve) => {
      const known = (await pve.clusterResources()).filter((r) => (r.type === "qemu" || r.type === "lxc") && typeof r.vmid === "number");
      const missing = req.vms.filter((v) => !known.some((r) => r.vmid === v));
      if (missing.length) throw new ctx.HttpError(404, "not_found", `No machine #${missing[0]}`);
      if (known.some((r) => req.vms.includes(r.vmid!) && r.template === 1)) throw new ctx.HttpError(409, "template", "Templates can't be started, stopped or moved");
      if (m[8] === "node") {
        const node = await resolveNode(ctx, pve, b);
        const path = { start: "startall", shutdown: "stopall", suspend: "suspendall", migrate: "migrateall" }[req.action];
        const params: Record<string, string | number | boolean | undefined> = { vms: req.vms.join(","), ...(req.maxWorkers ? { "max-workers": req.maxWorkers } : {}) };
        if (req.action === "shutdown") Object.assign(params, { "force-stop": req.forceStop, ...(req.timeout !== null ? { timeout: req.timeout } : {}) });
        if (req.action === "migrate") Object.assign(params, { target: req.target!, "with-local-disks": req.withLocalDisks });
        return { task: await pve.call<string>("POST", `/nodes/${seg(node)}/${path}`, params) };
      }
      const params: Record<string, string | number | boolean | string[] | undefined> = { vms: req.vms.map(String), ...(req.maxWorkers ? { "max-workers": req.maxWorkers } : {}) };
      if (req.action === "start" && req.timeout !== null) params.timeout = req.timeout;
      if (req.action === "shutdown") Object.assign(params, { "force-stop": req.forceStop, ...(req.timeout !== null ? { timeout: req.timeout } : {}) });
      if (req.action === "suspend" && req.toDisk) params["to-disk"] = true;
      if (req.action === "migrate") Object.assign(params, { target: req.target!, online: req.online, "with-local-disks": req.withLocalDisks });
      try {
        return { task: await pve.call<string>("POST", `/cluster/bulk-action/guest/${req.action}`, params as Record<string, string | number | boolean | string[]>) };
      } catch (e) {
        // Older Proxmox versions don't have the cluster-wide action; the machines then have to be on this node.
        if (e instanceof ProxmoxError && (e.status === 501 || e.status === 404)) throw new ctx.HttpError(409, "unsupported", "This Proxmox version has no cluster-wide bulk actions. Use the node's actions instead.");
        throw e;
      }
    });
    return ctx.json(202, out), true;
  }
  return false;
}

async function hardware(ctx: FeatureCtx, pve: ProxmoxClient, what: string) {
  const node = await resolveNode(ctx, pve);
  const n = seg(node);
  if (what === "pci/mdev") {
    const id = ctx.url.searchParams.get("id") ?? "";
    if (!/^[0-9A-Fa-f:.]{7,20}$/.test(id) && !/^[A-Za-z][\w-]{1,63}$/.test(id)) throw new ctx.HttpError(400, "bad_request", "A PCI device looks like 0000:01:00.0");
    const r = await soft(pve.call<Row[]>("GET", `/nodes/${n}/hardware/pci/${seg(id)}/mdev`));
    return { id, types: (r ?? []).map((t) => ({ type: s(t.type) ?? "", name: s(t.name), description: s(t.description) ?? "", available: typeof t.available === "number" ? t.available : 0 })).filter((t) => t.type) };
  }
  if (what === "usb") {
    let note: string | null = null;
    const list = await pve.call<Row[]>("GET", `/nodes/${n}/hardware/usb`).catch((e) => ((note = denied(e, "USB devices (it needs Sys.Modify)")), [] as Row[]));
    return {
      node,
      note,
      devices: (Array.isArray(list) ? list : []).slice(0, 500).map((d) => ({ id: `${s(d.vendid) ?? ""}:${s(d.prodid) ?? ""}`, bus: Number(d.busnum), port: s(d.usbpath) ?? `${d.busnum}-${d.port}`, level: Number(d.level), name: [s(d.manufacturer), s(d.product)].filter(Boolean).join(" ") || "USB device", serial: s(d.serial), speed: s(d.speed), hub: Number(d.class) === 9 })),
    };
  }
  let note: string | null = null;
  const verbose = ctx.url.searchParams.get("all") === "1";
  const list = await pve.call<Row[]>("GET", `/nodes/${n}/hardware/pci`, verbose ? { "pci-class-blacklist": "" } : { "pci-class-blacklist": "05;06;0b" }).catch((e) => ((note = denied(e, "PCI devices (it needs Sys.Audit)")), [] as Row[]));
  const maps = await soft(pve.call<{ id: string; map?: string[] }[]>("GET", "/cluster/mapping/pci"));
  const mapped = new Map<string, string[]>();
  for (const x of maps ?? []) for (const e of x.map ?? []) {
    const p = parseMapEntry(String(e));
    if (p.node !== node) continue;
    for (const path of p.path.split(";")) mapped.set(path, [...(mapped.get(path) ?? []), x.id]);
  }
  return {
    node,
    note,
    devices: (Array.isArray(list) ? list : []).slice(0, 1000).map((d) => {
      const id = s(d.id) ?? "";
      const short = id.replace(/^0000:/, "");
      return {
        id,
        vendor: s(d.vendor_name) ?? s(d.vendor),
        device: s(d.device_name) ?? s(d.device),
        vendorId: s(d.vendor),
        deviceId: s(d.device),
        subsystem: [s(d.subsystem_vendor_name), s(d.subsystem_device_name)].filter(Boolean).join(" ") || null,
        class: s(d.class),
        iommuGroup: typeof d.iommugroup === "number" ? d.iommugroup : -1,
        mdev: d.mdev === true || d.mdev === 1,
        mappings: [...new Set([...(mapped.get(id) ?? []), ...(mapped.get(short) ?? [])])],
      };
    }).filter((d) => d.id),
  };
}

async function capabilities(ctx: FeatureCtx, pve: ProxmoxClient) {
  const node = await resolveNode(ctx, pve);
  const n = seg(node);
  const [cpu, flags, machines, migration] = await Promise.all([
    soft(pve.call<Row[]>("GET", `/nodes/${n}/capabilities/qemu/cpu`)),
    soft(pve.call<Row[]>("GET", `/nodes/${n}/capabilities/qemu/cpu-flags`)),
    soft(pve.call<Row[]>("GET", `/nodes/${n}/capabilities/qemu/machines`)),
    soft(pve.call<Row>("GET", `/nodes/${n}/capabilities/qemu/migration`)),
  ]);
  return {
    node,
    cpu: (cpu ?? []).slice(0, 500).map((c) => ({ name: s(c.name) ?? "", vendor: s(c.vendor), custom: c.custom === 1 })).filter((c) => c.name),
    flags: (flags ?? []).slice(0, 300).map((f) => ({ name: s(f.name) ?? "", description: s(f.description) ?? "", supported: f.supported === undefined ? null : f.supported === true || f.supported === 1 })).filter((f) => f.name),
    machines: (machines ?? []).slice(0, 300).map((x) => ({ id: s(x.id) ?? "", type: s(x.type), version: s(x.version), changes: s(x.changes) })).filter((x) => x.id),
    migration: migration ? { cpu: s(migration.cpu), hasDirtyBitmaps: migration["has-dbus-vmstate"] === true || migration["has-dbus-vmstate"] === 1 } : null,
  };
}

async function mappings(ctx: FeatureCtx, pve: ProxmoxClient, kind: "pci" | "usb" | "dir") {
  const [list, perm, nodes] = await Promise.all([
    pve.call<Row[]>("GET", `/cluster/mapping/${kind}`, { "check-node": ctx.node }).catch((e) => (e instanceof ProxmoxError && e.status === 403 ? null : Promise.reject(e))),
    soft(pve.call<Record<string, Record<string, number>>>("GET", "/access/permissions", { path: `/mapping/${kind}` })),
    soft(pve.call<{ node: string }[]>("GET", "/nodes")),
  ]);
  const one = async (id: string): Promise<string | null> => {
    const r = await soft(pve.call<Row>("GET", `/cluster/mapping/${kind}/${seg(id)}`));
    return r && typeof r.digest === "string" ? r.digest : null;
  };
  const items = await Promise.all(
    (list ?? []).filter((x) => typeof x.id === "string").map(async (x) => ({
      id: String(x.id),
      description: s(x.description) ?? "",
      mdev: x.mdev === 1 || x.mdev === true,
      map: (Array.isArray(x.map) ? x.map : []).map((e) => parseMapEntry(String(e))),
      checks: (Array.isArray(x.checks) ? x.checks : []).slice(0, 20).map((c: Row) => ({ severity: s(c.severity) ?? "warning", message: s(c.message) ?? "" })),
      digest: s(x.digest) ?? (await one(String(x.id))),
    })),
  );
  const perms = perm?.[`/mapping/${kind}`] ?? {};
  return { kind, visible: list !== null, canModify: perms["Mapping.Modify"] === 1, nodes: (nodes ?? []).map((x) => x.node), mappings: items };
}

async function cpuModels(pve: ProxmoxClient) {
  const list = await pve.call<Row[]>("GET", "/cluster/qemu/custom-cpu-models").catch((e) => (e instanceof ProxmoxError && e.status === 403 ? null : Promise.reject(e)));
  const perm = await soft(pve.call<Record<string, Record<string, number>>>("GET", "/access/permissions", { path: "/mapping/cpu" }));
  return {
    visible: list !== null,
    canModify: perm?.["/mapping/cpu"]?.["Mapping.Modify"] === 1,
    models: (list ?? []).map((x) => ({ cputype: String(x.cputype ?? "").replace(/^custom-/, ""), reportedModel: s(x["reported-model"]) ?? "", flags: s(x.flags), hidden: x.hidden === 1 || x.hidden === true, hvVendorId: s(x["hv-vendor-id"]), physBits: s(x["phys-bits"]), digest: s(x.digest) })).filter((x) => x.cputype),
  };
}

