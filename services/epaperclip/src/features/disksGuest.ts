import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { getProp, parseProps, serializeProps, setProps } from "../hardware.ts";
import type { FeatureCtx } from "./index.ts";
import { CheckError, bindPath, digest, driveKey, driveString, freeKey, isoVolume, mpChanges, newVmDisk, readDrive, vmDiskChanges, DRIVE_KEY_RE, MP_KEY_RE } from "./disksCheck.ts";

/** Per-machine disk management: add, edit, detach, reattach, destroy, move, reassign, CD/DVD drives and container mount points. */

type Cfg = Record<string, string | number>;
const seg = encodeURIComponent;
const UNUSED_RE = /^unused\d{1,3}$/;
const GUEST_ROUTE = /^\/api\/guests\/(\d+)\/disks(?:\/(add|cdrom|mount)|\/((?:scsi|virtio|sata|ide|mp|unused)\d{1,3}|rootfs)\/(edit|detach|reattach|destroy|move|reassign))?$/;

const isStr = (v: unknown): v is string => typeof v === "string";
const volName = (volume: string) => volume.split("/").pop()!.split(":").pop()!;

export async function handleGuestDisks(ctx: FeatureCtx): Promise<boolean> {
  const m = ctx.path.match(GUEST_ROUTE);
  if (!m) return false;
  const { HttpError } = ctx;
  const vmid = Number(m[1]);

  const find = async (pve: ProxmoxClient, id: number) => {
    const g = (await pve.clusterResources()).find((r) => r.vmid === id);
    if (!g || (g.type !== "lxc" && g.type !== "qemu")) throw new HttpError(404, "not_found", "Unknown machine");
    return { node: g.node ?? ctx.node, type: g.type as "lxc" | "qemu", status: g.status ?? "unknown", name: g.name ?? String(id) };
  };
  const cfgUrl = (g: { node: string; type: string }, id: number, tail = "config") => `/nodes/${seg(g.node)}/${g.type}/${id}/${tail}`;

  if (ctx.method === "GET" && !m[2] && !m[3]) {
    const out = await ctx.asUser(async (pve) => {
      const g = await find(pve, vmid);
      const cfg = await pve.call<Cfg>("GET", cfgUrl(g, vmid));
      const pendingList = g.status === "running" ? await pve.call<{ key: string; value?: unknown; pending?: unknown; delete?: number }[]>("GET", cfgUrl(g, vmid, "pending")).catch(() => []) : [];
      const isAdmin = await ctx.isNodeAdmin(pve);
      return describe(g, cfg, pendingList, isAdmin);
    });
    return ctx.json(200, out), true;
  }
  if (ctx.method !== "POST") throw new HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  const b = await ctx.readJson();
  const dg = digest(b.digest);
  const action = m[2] ?? m[4];
  const key = m[3];

  const result = await ctx.asUser(async (pve): Promise<unknown> => {
    const g = await find(pve, vmid);
    if (g.type === "qemu" && action === "mount") throw new HttpError(400, "bad_request", "Mount points are for containers");
    if (g.type === "lxc" && (action === "add" || action === "cdrom")) throw new HttpError(400, "bad_request", action === "add" ? "Containers get extra disks as mount points" : "Containers have no CD drive");
    const url = cfgUrl(g, vmid);
    const cfg = await pve.call<Cfg>("GET", url);
    // Refuse early when the page is stale; Proxmox checks the digest again on the write itself.
    if (cfg.digest !== dg) throw new HttpError(409, "stale", "This machine changed since the page loaded. Reload and try again.");
    const put = (params: Record<string, string | number | boolean | undefined>) => pve.call<string | null>("PUT", url, { ...params, digest: dg });
    const needKey = (k: string | undefined): string => (k && k in cfg ? k : (() => { throw new HttpError(404, "not_found", "That disk is not on this machine"); })());

    if (action === "add") {
      const d = newVmDisk(b);
      const k = freeKey(cfg, d.bus);
      const changes = vmDiskChanges(d.bus, b);
      if (d.format) changes.format = d.format;
      await put({ [k]: driveString(`${d.storage}:${d.sizeGb}`, changes) });
      return { key: k };
    }

    if (action === "mount") {
      const k = (() => { for (let i = 0; i < 256; i++) if (!(`mp${i}` in cfg)) return `mp${i}`; throw new CheckError("All mount points are taken"); })();
      const changes = mpChanges(b, true);
      let base: string;
      if (b.bind !== undefined && b.bind !== null && b.bind !== "") {
        if (!(await ctx.isNodeAdmin(pve))) throw new HttpError(403, "forbidden", "Bind mounts hand a host folder to a container, so only Proxmox administrators may add them.");
        base = bindPath(b.bind);
      } else {
        if (!isStr(b.storage) || !/^[\w.-]{1,64}$/.test(b.storage)) throw new CheckError("Pick a storage for the mount point");
        if (!Number.isInteger(b.sizeGb) || (b.sizeGb as number) < 1 || (b.sizeGb as number) > 131072) throw new CheckError("Size is a whole number of GB, 1 or more");
        base = `${b.storage}:${b.sizeGb}`;
      }
      await put({ [k]: driveString(base, changes) });
      return { key: k };
    }

    if (action === "cdrom") {
      const iso = b.iso === "none" ? "none" : b.iso === "physical" ? "cdrom" : isoVolume(b.iso);
      let k: string;
      if (b.key !== undefined && b.key !== null) {
        k = driveKey(b.key);
        if (!(k in cfg) || getProp(parseProps(String(cfg[k])), "media") !== "cdrom") throw new CheckError("That is not a CD drive");
      } else {
        k = ["ide2", "ide0", "ide1", "ide3", "sata0", "sata1", "sata2", "sata3", "sata4", "sata5"].find((x) => !(x in cfg)) ?? (() => { throw new CheckError("No free slot for a CD drive"); })();
      }
      const existing = k in cfg ? parseProps(String(cfg[k])) : [];
      const rest = existing.slice(1).filter(([x]) => x !== "size");
      await put({ [k]: serializeProps([[iso, null], ...(rest.some(([x]) => x === "media") ? rest : [...rest, ["media", "cdrom"] as [string, string]])]) });
      return { key: k };
    }

    const k = needKey(key);

    if (action === "edit") {
      if (k.startsWith("unused")) throw new CheckError("Attach the disk before changing its options");
      const existing = String(cfg[k]);
      const props = parseProps(existing);
      if (getProp(props, "media") === "cdrom") throw new CheckError("Use the CD drive controls for this drive");
      if (g.type === "qemu") {
        if (!DRIVE_KEY_RE.test(k)) throw new CheckError("That disk can't be edited here");
        await put({ [k]: serializeProps(setProps(props, vmDiskChanges(k.replace(/\d+$/, ""), b))) });
      } else {
        const changes = mpChanges(b, false);
        if (k === "rootfs") delete changes.mp;
        const bind = !String(cfg[k]).split(",")[0].includes(":");
        if (bind && !(await ctx.isNodeAdmin(pve))) throw new HttpError(403, "forbidden", "Only Proxmox administrators may change bind mounts.");
        await put({ [k]: serializeProps(setProps(props, changes)) });
      }
      return { ok: true };
    }

    if (action === "detach") {
      if (k === "rootfs") throw new CheckError("The root disk can't be detached");
      if (UNUSED_RE.test(k)) throw new CheckError("This disk is already detached");
      await put({ delete: k });
      return { ok: true };
    }

    if (action === "reattach") {
      if (!UNUSED_RE.test(k)) throw new CheckError("Only detached disks can be attached");
      const volume = String(cfg[k]).split(",")[0];
      let target: string;
      if (g.type === "qemu") {
        const bus = isStr(b.bus) ? b.bus : "scsi";
        target = freeKey(cfg, bus);
        const changes = vmDiskChanges(bus, b);
        await put({ [target]: driveString(volume, changes) });
      } else {
        target = (() => { for (let i = 0; i < 256; i++) if (!(`mp${i}` in cfg)) return `mp${i}`; throw new CheckError("All mount points are taken"); })();
        await put({ [target]: driveString(volume, mpChanges(b, true)) });
      }
      // Proxmox drops the detached entry once the volume is attached; report it if it did not, but never delete it ourselves.
      const after = await pve.call<Cfg>("GET", url);
      return { key: target, staleUnused: k in after && String(after[k]).split(",")[0] === volume };
    }

    if (action === "destroy") {
      if (!UNUSED_RE.test(k)) throw new CheckError("Detach the disk first; only detached disks can be destroyed");
      const volume = String(cfg[k]).split(",")[0];
      if (b.confirm !== volName(volume)) throw new HttpError(409, "confirm", `Type the volume's name (${volName(volume)}) to confirm.`);
      if (g.type === "qemu") await pve.call("PUT", `/nodes/${seg(g.node)}/qemu/${vmid}/unlink`, { idlist: k, force: true });
      else await put({ delete: k });
      return { ok: true, volume };
    }

    if (action === "move") {
      const storage = isStr(b.storage) && /^[\w.-]{1,64}$/.test(b.storage) ? b.storage : (() => { throw new CheckError("Pick the storage to move the disk to"); })();
      if (getProp(parseProps(String(cfg[k])), "media") === "cdrom") throw new CheckError("CD drives have nothing to move");
      const bw = b.bwlimit === undefined || b.bwlimit === null || b.bwlimit === "" ? undefined : Number.isInteger(b.bwlimit) && (b.bwlimit as number) >= 0 ? (b.bwlimit as number) : (() => { throw new CheckError("Bandwidth limit is KiB/s, 0 or more"); })();
      const del = b.deleteSource === true;
      if (g.type === "qemu") {
        const format = b.format === undefined || b.format === null || b.format === "" ? undefined : ["raw", "qcow2", "vmdk"].includes(String(b.format)) ? String(b.format) : (() => { throw new CheckError("Format is raw, QCOW2 or VMDK"); })();
        return { task: await pve.call<string>("POST", `/nodes/${seg(g.node)}/qemu/${vmid}/move_disk`, { disk: k, storage, format, delete: del, bwlimit: bw, digest: dg }) };
      }
      return { task: await pve.call<string>("POST", `/nodes/${seg(g.node)}/lxc/${vmid}/move_volume`, { volume: k, storage, delete: del, bwlimit: bw, digest: dg }) };
    }

    if (action === "reassign") {
      const to = Number(b.targetVmid);
      if (!Number.isInteger(to) || to < 100 || to === vmid) throw new CheckError("Pick another machine");
      const t = await find(pve, to);
      if (t.type !== g.type) throw new CheckError(g.type === "qemu" ? "Disks can only move to another virtual machine" : "Volumes can only move to another container");
      if (t.node !== g.node) throw new CheckError("The other machine is on another device; move it here first");
      const tcfg = await pve.call<Cfg>("GET", cfgUrl(t, to));
      const targetKey = b.targetKey === undefined || b.targetKey === null || b.targetKey === "" ? undefined : g.type === "qemu" ? driveKey(b.targetKey) : isStr(b.targetKey) && (MP_KEY_RE.test(b.targetKey) || b.targetKey === "rootfs") ? b.targetKey : (() => { throw new CheckError("Unknown target volume"); })();
      if (targetKey && targetKey in tcfg) throw new CheckError(`${targetKey} is already used on #${to}`);
      const common = { "target-vmid": to, "target-digest": isStr(tcfg.digest) ? tcfg.digest : undefined, digest: dg };
      if (g.type === "qemu") return { task: await pve.call<string>("POST", `/nodes/${seg(g.node)}/qemu/${vmid}/move_disk`, { disk: k, "target-disk": targetKey, ...common }) };
      return { task: await pve.call<string>("POST", `/nodes/${seg(g.node)}/lxc/${vmid}/move_volume`, { volume: k, "target-volume": targetKey, ...common }) };
    }
    throw new HttpError(404, "not_found", "Not found");
  });
  return ctx.json(200, result), true;
}

/** The full disk picture of a machine for the Hardware tab. */
function describe(g: { type: "lxc" | "qemu"; status: string; name: string }, cfg: Cfg, pendingList: { key: string; value?: unknown; pending?: unknown; delete?: number }[], isAdmin: boolean) {
  const pending: Record<string, { value: string | null; removed: boolean }> = {};
  for (const p of pendingList) {
    if (p.pending !== undefined || p.delete) pending[p.key] = { value: p.pending !== undefined ? String(p.pending) : null, removed: !!p.delete };
  }
  const entries = (dict: Cfg, staged: boolean): Record<string, unknown>[] => Object.entries(dict).flatMap(([k, v]): Record<string, unknown>[] => {
    const raw = String(v);
    if (g.type === "qemu") {
      if (/^(scsi|virtio|sata|ide)\d+$/.test(k)) {
        const d = readDrive(raw);
        const kind = d.media === "cdrom" ? "cdrom" : d.volume.endsWith("cloudinit") || /vm-\d+-cloudinit/.test(d.volume) ? "cloudinit" : "disk";
        return [{ key: k, kind, staged, bus: k.replace(/\d+$/, ""), ...d }];
      }
      if (k === "efidisk0" || k === "tpmstate0") return [{ key: k, kind: k === "efidisk0" ? "efidisk" : "tpm", staged, bus: "", ...readDrive(raw) }];
    } else if (k === "rootfs" || /^mp\d+$/.test(k)) {
      const p = parseProps(raw);
      const volume = p[0]?.[0] ?? raw;
      const bind = !volume.includes(":");
      return [{ key: k, kind: k === "rootfs" ? "rootfs" : bind ? "bind" : "mount", staged, volume, storage: bind ? null : volume.split(":")[0], mp: k === "rootfs" ? "/" : getProp(p, "mp") ?? null, sizeGb: readDrive(raw).sizeGb, backup: getProp(p, "backup") === "1" || k === "rootfs" ? getProp(p, "backup") !== "0" : false, acl: getProp(p, "acl") === "1", quota: getProp(p, "quota") === "1", replicate: getProp(p, "replicate") !== "0", ro: getProp(p, "ro") === "1", mountoptions: (getProp(p, "mountoptions") ?? "").split(";").filter(Boolean) }];
    }
    return [];
  });
  const effective: Cfg = { ...cfg };
  for (const [k, p] of Object.entries(pending)) {
    if (p.removed) delete effective[k];
    else if (p.value !== null) effective[k] = p.value;
  }
  const disks = entries(effective, false).map((e) => ({ ...e, staged: (e.key as string) in pending }));
  const unused = Object.entries(cfg).filter(([k]) => UNUSED_RE.test(k)).map(([k, v]) => ({ key: k, volume: String(v).split(",")[0], name: volName(String(v).split(",")[0]), storage: String(v).split(":")[0] || null }));
  return {
    type: g.type,
    status: g.status,
    digest: typeof cfg.digest === "string" ? cfg.digest : null,
    locked: typeof cfg.lock === "string" ? cfg.lock : null,
    isAdmin,
    pendingKeys: Object.keys(pending),
    disks,
    unused,
    hotplug: g.type === "qemu" ? (cfg.hotplug === undefined ? true : String(cfg.hotplug).split(",").includes("disk") || String(cfg.hotplug) === "1") : true,
  };
}
