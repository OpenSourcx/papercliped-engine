import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { type Cfg } from "@papercliped-engine/proxmox-client/machine-schema";
import { planCloudInit, planCloudInitDrive, readCloudInit } from "@papercliped-engine/proxmox-client/machine-extra";
import { guarded } from "./nodeCommon.ts";
import type { FeatureCtx, FeatureHandler } from "./index.ts";
import { asBadRequest, findGuest, guardedConfig, guestUrl, soft, writeChange, type Found } from "./machineCommon.ts";

/**
 * Cloud-Init on an existing VM: the drive, user, password (write-only), SSH keys, DNS, addresses per network device,
 * upgrade on first boot, custom files (snippets), regenerating the image and the generated files. See docs/MACHINE.md.
 */

const ROUTE = /^\/api\/guests\/(\d+)\/cloudinit(?:\/(drive\/remove|regenerate|dump))?$/;

export const handleMachineCloud: FeatureHandler = async (ctx) => {
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
  const sub = m[2];
  if (ctx.method === "GET") {
    if (sub && sub !== "dump") return false;
    const out = await ctx.asUser(async (pve) => {
      const g = await findGuest(ctx, pve, vmid);
      if (g.type !== "qemu") throw new ctx.HttpError(400, "bad_request", "Cloud-Init is for virtual machines");
      if (sub === "dump") {
        const type = ctx.url.searchParams.get("type");
        if (type !== "user" && type !== "network" && type !== "meta") throw new ctx.HttpError(400, "bad_request", "Choose user, network or meta");
        const text = await pve.call<string>("GET", guestUrl(g, vmid, "cloudinit/dump"), { type });
        return { type, text: scrubDump(typeof text === "string" ? text : "") };
      }
      return read(ctx, pve, g, vmid);
    });
    return ctx.json(200, out), true;
  }
  if (ctx.method !== "POST") throw new ctx.HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  const b = await ctx.readJson(48 * 1024);
  const out = await ctx.asUser(async (pve) => {
    const g = await findGuest(ctx, pve, vmid);
    if (g.type !== "qemu") throw new ctx.HttpError(400, "bad_request", "Cloud-Init is for virtual machines");
    if (sub === "regenerate") {
      await pve.call("PUT", guestUrl(g, vmid, "cloudinit"));
      return { ok: true };
    }
    const { cfg, digest } = await guardedConfig(ctx, pve, g, vmid, b);
    const body = { ...b };
    delete body.digest;
    if (sub === "drive/remove") {
      const change = planCloudInitDrive(cfg, body);
      return writeChange(pve, g, vmid, change, digest);
    }
    const storages = body.drive !== undefined ? (await soft(pve.nodeStorages(g.node, "images")))?.filter((s) => s.active !== 0).map((s) => s.storage) : undefined;
    const change = planCloudInit(cfg, body, { storages });
    const secret = typeof body.password === "string" ? body.password : undefined;
    return guarded([secret], () => writeChange(pve, g, vmid, change, digest));
  });
  return ctx.json(200, out), true;
}

/** The generated files can carry what was typed; the password hash is never shown. */
function scrubDump(text: string): string {
  return text
    .split("\n")
    .map((l) => (/^\s*(password|passwd|chpasswd)\b/i.test(l) || /^\s*-?\s*(passwd|hashed_passwd|plain_text_passwd):/i.test(l) ? l.replace(/(:\s*).*/, "$1<hidden>") : l))
    .join("\n")
    .slice(0, 64 * 1024);
}

async function read(ctx: FeatureCtx, pve: ProxmoxClient, g: Found, vmid: number) {
  const cfg = await pve.call<Cfg>("GET", guestUrl(g, vmid, "config"));
  const [pend, stores] = await Promise.all([
    pve.call<{ key: string; value?: unknown; pending?: unknown; delete?: number }[]>("GET", guestUrl(g, vmid, "cloudinit")).catch((e) => (e instanceof ProxmoxError && e.status === 403 ? [] : Promise.reject(e))),
    soft(pve.nodeStorages(g.node, "images")),
  ]);
  const snippetStores = await soft(pve.nodeStorages(g.node, "snippets"));
  const snippets = (await Promise.all((snippetStores ?? []).filter((s) => s.active !== 0).map((s) => soft(pve.storageContent(g.node, s.storage, "snippets")).then((l) => (l ?? []).map((x: { volid: string }) => x.volid))))).flat().slice(0, 500);
  const secret = new Set(["cipassword"]);
  return {
    view: readCloudInit(cfg),
    digest: typeof cfg.digest === "string" ? cfg.digest : null,
    locked: typeof cfg.lock === "string" ? cfg.lock : null,
    status: g.status,
    template: g.template,
    storages: (stores ?? []).filter((s) => s.active !== 0).map((s) => s.storage),
    snippets,
    // Values Proxmox hasn't put in the generated image yet.
    changed: (Array.isArray(pend) ? pend : []).filter((p) => p.pending !== undefined || p.delete).map((p) => ({ key: p.key, pending: secret.has(p.key) ? null : p.pending === undefined ? null : String(p.pending), remove: Boolean(p.delete) })),
    isAdmin: await ctx.isNodeAdmin(pve),
  };
}

