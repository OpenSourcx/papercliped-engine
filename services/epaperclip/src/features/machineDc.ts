import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { checkBulk, planCustomCpu } from "@papercliped-engine/proxmox-client/machine-extra";
import type { FeatureCtx, FeatureHandler } from "./index.ts";
import { asBadRequest, soft } from "./machineCommon.ts";
import { resolveNode, seg } from "./nodeCommon.ts";

/**
 * Mediated (vGPU) device types for a PCI device, the node's virtualization capabilities, custom CPU models and bulk power
 * actions on several machines. (Host hardware lists and resource mappings are in the node area: dcMapping.ts.) Everything runs as the signed-in person. See docs/MACHINE.md.
 */

type Row = Record<string, unknown>;
const ROUTE = /^\/api\/(hardware\/(pci\/mdev)|capabilities\/qemu|cpu-models(?:\/([A-Za-z][\w-]{1,63})(\/delete)?)?|bulk\/(guests|node))$/;

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

async function route(ctx: FeatureCtx, m: RegExpMatchArray): Promise<boolean> {
  const { method } = ctx;
  if (method === "GET") {
    const out = await ctx.asUser(async (pve) => {
      if (m[1]?.startsWith("hardware")) return hardware(ctx, pve);
      if (m[1] === "capabilities/qemu") return capabilities(ctx, pve);
      if (m[0].startsWith("/api/cpu-models")) return cpuModels(pve);
      throw new ctx.HttpError(405, "method", "Method not allowed");
    });
    return ctx.json(200, out), true;
  }
  if (method !== "POST") throw new ctx.HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  const b = await ctx.readJson(96 * 1024);

  if (m[0].startsWith("/api/cpu-models")) {
    const out = await ctx.asUser(async (pve) => {
      if (m[4]) {
        if (b.confirm !== m[3]) throw new ctx.HttpError(409, "confirm", `Type ${m[3]} to confirm.`);
        await pve.call("DELETE", `/cluster/qemu/custom-cpu-models/${seg(m[3])}`);
        return { ok: true };
      }
      if (m[3]) {
        const body: Record<string, unknown> = { ...b, cputype: m[3] };
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

  if (m[5]) {
    const req = checkBulk(b);
    if (req.action !== "start" && b.confirm !== String(req.vms.length)) throw new ctx.HttpError(409, "confirm", `Type ${req.vms.length} to confirm acting on ${req.vms.length} machine${req.vms.length === 1 ? "" : "s"}.`);
    const out = await ctx.asUser(async (pve) => {
      const known = (await pve.clusterResources()).filter((r) => (r.type === "qemu" || r.type === "lxc") && typeof r.vmid === "number");
      const missing = req.vms.filter((v) => !known.some((r) => r.vmid === v));
      if (missing.length) throw new ctx.HttpError(404, "not_found", `No machine #${missing[0]}`);
      if (known.some((r) => req.vms.includes(r.vmid!) && r.template === 1)) throw new ctx.HttpError(409, "template", "Templates can't be started, stopped or moved");
      if (m[5] === "node") {
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

async function hardware(ctx: FeatureCtx, pve: ProxmoxClient) {
  const node = await resolveNode(ctx, pve);
  const id = ctx.url.searchParams.get("id") ?? "";
  if (!/^[0-9A-Fa-f:.]{7,20}$/.test(id) && !/^[A-Za-z][\w-]{1,63}$/.test(id)) throw new ctx.HttpError(400, "bad_request", "A PCI device looks like 0000:01:00.0");
  const r = await soft(pve.call<Row[]>("GET", `/nodes/${seg(node)}/hardware/pci/${seg(id)}/mdev`));
  return { id, types: (r ?? []).map((t) => ({ type: s(t.type) ?? "", name: s(t.name), description: s(t.description) ?? "", available: typeof t.available === "number" ? t.available : 0 })).filter((t) => t.type) };
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

async function cpuModels(pve: ProxmoxClient) {
  const list = await pve.call<Row[]>("GET", "/cluster/qemu/custom-cpu-models").catch((e) => (e instanceof ProxmoxError && e.status === 403 ? null : Promise.reject(e)));
  const perm = await soft(pve.call<Record<string, Record<string, number>>>("GET", "/access/permissions", { path: "/mapping/cpu" }));
  return {
    visible: list !== null,
    canModify: perm?.["/mapping/cpu"]?.["Mapping.Modify"] === 1,
    models: (list ?? []).map((x) => ({ cputype: String(x.cputype ?? "").replace(/^custom-/, ""), reportedModel: s(x["reported-model"]) ?? "", flags: s(x.flags), hidden: x.hidden === 1 || x.hidden === true, hvVendorId: s(x["hv-vendor-id"]), physBits: s(x["phys-bits"]), digest: s(x.digest) })).filter((x) => x.cputype),
  };
}

