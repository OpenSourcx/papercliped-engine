import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { planCloudInit, AGENT_PATH, AGENT_READS, checkAgentAction, checkClone, checkDelete, checkPower, checkSnapshotDescription, spiceFile, type CloneOptions } from "@papercliped-engine/proxmox-client/machine-extra";
import type { Cfg } from "@papercliped-engine/proxmox-client/machine-schema";
import type { FeatureCtx, FeatureHandler } from "./index.ts";
import { asBadRequest, findGuest, guestUrl, seg, soft, type Found } from "./machineCommon.ts";
import { guarded } from "./nodeCommon.ts";

/**
 * Running machines: suspend, resume and hibernate with their options, shutdown timeouts, clone with every option
 * (including a Cloud-Init finish), delete options, snapshot descriptions and rollback-and-start, the SPICE file, the
 * QEMU monitor and the guest agent (information, trim, freeze, password, run a command, read a file).
 */

const ROUTE = /^\/api\/guests\/(\d+)\/(status|clone-options|delete|spice|monitor|agent|agent\/(info|osinfo|fsinfo|users|time|timezone|vcpus|memory-blocks|host-name)|snapshots\/([A-Za-z][\w-]{0,39})\/(config|describe|restore))$/;

export const handleMachineRun: FeatureHandler = async (ctx) => {
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
  const snap = m[4];
  if (ctx.method === "GET") {
    const out = await ctx.asUser(async (pve) => {
      const g = await findGuest(ctx, pve, vmid);
      if (what === "clone-options") return cloneChoices(ctx, pve, g, vmid);
      if (m[3]) return agentRead(ctx, pve, g, vmid, m[3]);
      if (snap && m[5] === "config") return snapshotConfig(pve, g, vmid, snap);
      throw new ctx.HttpError(405, "method", "Method not allowed");
    });
    return ctx.json(200, out), true;
  }
  if (ctx.method !== "POST") throw new ctx.HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  const b = await ctx.readJson(96 * 1024);

  if (what === "status") {
    const task = await ctx.asUser(async (pve) => {
      const g = await findGuest(ctx, pve, vmid);
      const req = checkPower(g.type, b);
      if (g.template) throw new ctx.HttpError(409, "template", `${g.name} is a template; clone it to get a machine you can start.`);
      if (req.action === "resume" && g.status !== "running") throw new ctx.HttpError(409, "not_running", "Only a paused machine can be resumed");
      return pve.call<string>("POST", guestUrl(g, vmid, `status/${req.path}`), req.params);
    });
    return ctx.json(202, { task }), true;
  }
  if (what === "delete") {
    const task = await ctx.asUser(async (pve) => {
      const g = await findGuest(ctx, pve, vmid);
      const o = checkDelete(b);
      if (o.confirm !== g.name) throw new ctx.HttpError(409, "confirm", `Type the machine's name (${g.name}) to confirm.`);
      if (g.status === "running") throw new ctx.HttpError(409, "running", `${g.name} is running. Shut it down first.`);
      const cfg = await pve.call<Cfg>("GET", guestUrl(g, vmid, "config"));
      if (String(cfg.protection ?? "0") === "1") throw new ctx.HttpError(409, "protected", `${g.name} is protected. Turn protection off first.`);
      return pve.call<string>("DELETE", guestUrl(g, vmid), { purge: o.purge, "destroy-unreferenced-disks": o.destroyUnreferenced, ...(o.skipLock ? { skiplock: true } : {}) });
    });
    return ctx.json(202, { task }), true;
  }
  if (what === "clone-options") return ctx.json(202, await ctx.asUser((pve, s) => cloneNow(ctx, pve, vmid, b, s.username))), true;
  if (what === "spice") {
    const out = await ctx.asUser(async (pve) => {
      const g = await findGuest(ctx, pve, vmid);
      if (g.type !== "qemu") throw new ctx.HttpError(400, "bad_request", "Containers use the text console");
      if (g.status !== "running") throw new ctx.HttpError(409, "not_running", "Start the VM to open its SPICE console");
      for (const k of Object.keys(b)) if (k !== "proxy") throw new ctx.HttpError(400, "bad_request", `Unknown field “${k}”`);
      const proxy = b.proxy === undefined || b.proxy === "" ? undefined : typeof b.proxy === "string" && /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|\[?[0-9A-Fa-f:.]{2,45}\]?)(?::\d{1,5})?$/.test(b.proxy) ? b.proxy : (() => { throw new ctx.HttpError(400, "bad_request", "The address looks like pve.lan or 192.168.1.10"); })();
      const r = await pve.call<Record<string, unknown>>("POST", guestUrl(g, vmid, "spiceproxy"), proxy ? { proxy } : {});
      return { filename: `${g.name}-${vmid}.vv`.replace(/[^A-Za-z0-9._-]/g, "_"), file: spiceFile(r) };
    });
    return ctx.json(200, out), true;
  }
  if (what === "monitor") {
    const out = await ctx.asUser(async (pve) => {
      const g = await findGuest(ctx, pve, vmid);
      if (g.type !== "qemu") throw new ctx.HttpError(400, "bad_request", "Only VMs have a QEMU monitor");
      if (g.status !== "running") throw new ctx.HttpError(409, "not_running", "Start the VM to use its monitor");
      for (const k of Object.keys(b)) if (k !== "command") throw new ctx.HttpError(400, "bad_request", `Unknown field “${k}”`);
      const command = typeof b.command === "string" && b.command.trim().length > 0 && b.command.length <= 512 && !/[\r\n\u0000]/.test(b.command) ? b.command.trim() : (() => { throw new ctx.HttpError(400, "bad_request", "A monitor command is one line, for example info status"); })();
      const text = await pve.call<string>("POST", guestUrl(g, vmid, "monitor"), { command });
      return { command, output: typeof text === "string" ? text.slice(0, 64 * 1024) : "" };
    });
    return ctx.json(200, out), true;
  }
  if (what === "agent") return ctx.json(200, await ctx.asUser(async (pve) => agentDo(ctx, pve, await findGuest(ctx, pve, vmid), vmid, b))), true;
  if (snap) {
    const out = await ctx.asUser(async (pve) => {
      const g = await findGuest(ctx, pve, vmid);
      if (m[5] === "describe") {
        await pve.call("PUT", guestUrl(g, vmid, `snapshot/${seg(snap)}/config`), { description: checkSnapshotDescription(b) });
        return { ok: true };
      }
      // restore: roll back, optionally starting afterwards. The snapshot's name must be typed.
      for (const k of Object.keys(b)) if (!["confirm", "start"].includes(k)) throw new ctx.HttpError(400, "bad_request", `Unknown field “${k}”`);
      if (b.confirm !== snap) throw new ctx.HttpError(409, "confirm", `Type ${snap} to confirm.`);
      if (b.start !== undefined && typeof b.start !== "boolean") throw new ctx.HttpError(400, "bad_request", "Start afterwards is on or off");
      const task = await pve.call<string>("POST", guestUrl(g, vmid, `snapshot/${seg(snap)}/rollback`), b.start === true ? { start: true } : {});
      return { task };
    });
    return ctx.json(m[5] === "restore" ? 202 : 200, out), true;
  }
  return false;
}

async function snapshotConfig(pve: ProxmoxClient, g: Found, vmid: number, snap: string) {
  const cfg = await pve.call<Cfg>("GET", guestUrl(g, vmid, `snapshot/${seg(snap)}/config`));
  const hide = new Set(["cipassword", "password", "sshkeys", "ssh-public-keys"]);
  const pick = ["cores", "sockets", "memory", "swap", "bios", "machine", "ostype", "net0", "scsi0", "rootfs", "vmstate", "snaptime", "parent", "description", "name", "hostname"];
  return {
    name: snap,
    description: typeof cfg.description === "string" ? cfg.description : "",
    vmstate: typeof cfg.vmstate === "string" ? cfg.vmstate : null,
    time: typeof cfg.snaptime === "number" ? cfg.snaptime : null,
    settings: Object.fromEntries(Object.entries(cfg).filter(([k]) => pick.includes(k) && !hide.has(k)).map(([k, v]) => [k, String(v)])),
  };
}

async function cloneChoices(ctx: FeatureCtx, pve: ProxmoxClient, g: Found, vmid: number) {
  const vm = g.type === "qemu";
  const [nodes, next, pools, snaps, stores, cfg] = await Promise.all([
    soft(pve.call<{ node: string; status?: string }[]>("GET", "/nodes")),
    soft(pve.nextId()),
    soft(pve.pools()),
    soft(pve.snapshots(g.node, g.type, vmid)),
    soft(pve.nodeStorages(g.node, vm ? "images" : "rootdir")),
    soft(pve.call<Cfg>("GET", guestUrl(g, vmid, "config"))),
  ]);
  const hasNet = Object.keys(cfg ?? {}).filter((k) => /^net\d+$/.test(k)).length;
  void ctx;
  return {
    type: g.type,
    name: g.name,
    template: g.template,
    nextid: next,
    nodes: (nodes ?? []).filter((n) => n.status !== "offline").map((n) => n.node),
    pools: (pools ?? []).map((p) => p.poolid),
    snapshots: (snaps ?? []).filter((s) => s.name !== "current").map((s) => s.name),
    storages: (stores ?? []).filter((s) => s.active !== 0).map((s) => ({ storage: s.storage, type: s.type })),
    // A linked clone needs a template; VM formats only matter for a full clone onto file storage.
    canLink: g.template,
    cloudInit: vm,
    nets: hasNet,
  };
}

const CLONE_WAIT_MS = 120_000;
const DISK_KEYS = ["scsi0", "virtio0", "sata0", "ide0", "scsi1", "virtio1"];

async function cloneNow(ctx: FeatureCtx, pve: ProxmoxClient, vmid: number, b: Record<string, unknown>, _username: string) {
  const g = await findGuest(ctx, pve, vmid);
  const o: CloneOptions = checkClone(g.type, g.template, b);
  if (o.snapname && g.template) throw new ctx.HttpError(400, "bad_request", "A template has no snapshots to clone from");
  if (o.target) {
    const nodes = await soft(pve.call<{ node: string }[]>("GET", "/nodes"));
    if (nodes && !nodes.some((n) => n.node === o.target)) throw new ctx.HttpError(400, "bad_request", `This cluster has no node called ${o.target}`);
  }
  const newid = o.newid ?? (await pve.nextId());
  if (o.newid !== null) {
    try {
      await pve.checkVmidFree(newid);
    } catch (e) {
      if (e instanceof ProxmoxError && e.status !== 401 && e.status !== 403) throw new ctx.HttpError(409, "vmid_taken", `#${newid} is already used by another machine`);
      throw e;
    }
  }
  const params: Record<string, string | number | boolean | undefined> = {
    newid,
    [g.type === "lxc" ? "hostname" : "name"]: o.name ?? undefined,
    full: o.full,
    target: o.target ?? undefined,
    storage: o.full ? o.storage ?? undefined : undefined,
    format: o.full ? o.format ?? undefined : undefined,
    snapname: o.snapname ?? undefined,
    pool: o.pool ?? undefined,
    bwlimit: o.bwlimit ?? undefined,
    description: o.description ?? `Cloned from ${g.name} (#${vmid}) in ePaperclip`,
  };
  const task = await pve.call<string>("POST", guestUrl(g, vmid, "clone"), params);
  const wantsMore = !!o.cloudInit || o.start || o.growGb !== null;
  if (!wantsMore) return { vmid: newid, task, applied: null, steps: [] as { step: string; ok: boolean; message: string }[] };

  // Finish the new machine once the copy is done: Cloud-Init values, a bigger disk, start.
  const node = o.target ?? g.node;
  const steps: { step: string; ok: boolean; message: string }[] = [];
  try {
    await pve.waitTask(g.node, task, { timeoutMs: CLONE_WAIT_MS });
  } catch (e) {
    const slow = e instanceof ProxmoxError && e.status === 504;
    return { vmid: newid, task, applied: false, steps, note: slow ? "The copy is still running. Open the new machine when it's done to finish Cloud-Init and start it." : "The clone didn't finish, so nothing more was changed." };
  }
  const newUrl = (tail: string) => `/nodes/${seg(node)}/${g.type}/${newid}/${tail}`;
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      steps.push({ step: name, ok: true, message: (await fn()) || "Done" });
    } catch (e) {
      steps.push({ step: name, ok: false, message: e instanceof ProxmoxError ? e.detail ?? "Proxmox refused this step" : e instanceof Error ? e.message : "Failed" });
    }
  };
  if (o.cloudInit) {
    await step("Cloud-Init", async () => {
      const cfg = await pve.call<Cfg>("GET", newUrl("config"));
      const ci = { ...o.cloudInit! } as Record<string, unknown>;
      const change = planCloudInit(cfg, ci, {});
      const params2: Record<string, string> = { ...change.set };
      if (change.delete.length) params2.delete = change.delete.join(",");
      await guarded([typeof ci.password === "string" ? ci.password : undefined], () => pve.call("PUT", newUrl("config"), params2));
      return "User, keys and addresses set";
    });
  }
  if (o.growGb !== null) {
    await step("Grow disk", async () => {
      const cfg = await pve.call<Cfg>("GET", newUrl("config"));
      const key = DISK_KEYS.find((k) => k in cfg && !/cloudinit|media=cdrom/.test(String(cfg[k])));
      if (!key) throw new Error("No data disk to grow");
      await pve.resizeDisk(node, g.type, newid, key, `+${o.growGb}G`);
      return `${key} grown by ${o.growGb} GiB`;
    });
  }
  if (o.start) await step("Start", async () => void (await pve.call("POST", newUrl("status/start"))));
  return { vmid: newid, task, applied: steps.every((s) => s.ok), steps };
}

// ---- Guest agent

const agentDownText = "The guest agent isn't answering. Turn it on (Hardware, Options) and install and start qemu-guest-agent inside the machine.";

function agentError(ctx: FeatureCtx, e: unknown): never {
  if (e instanceof ProxmoxError && e.status !== 401 && e.status !== 403) {
    if (/agent|not running|timeout/i.test(e.detail ?? "")) throw new ctx.HttpError(409, "agent_down", agentDownText);
    if (/not (supported|implemented)|unsupported|disabled/i.test(e.detail ?? "")) throw new ctx.HttpError(409, "agent_unsupported", "This guest agent version doesn't support that.");
  }
  throw e;
}

function requireAgentVm(ctx: FeatureCtx, g: Found) {
  if (g.type !== "qemu") throw new ctx.HttpError(400, "bad_request", "The guest agent is for virtual machines");
  if (g.status !== "running") throw new ctx.HttpError(409, "not_running", "Start the VM to talk to its guest agent");
}

async function agentRead(ctx: FeatureCtx, pve: ProxmoxClient, g: Found, vmid: number, what: string) {
  requireAgentVm(ctx, g);
  if (!(AGENT_READS as readonly string[]).includes(what)) throw new ctx.HttpError(404, "not_found", "Not found");
  try {
    const r = await pve.call<{ result?: unknown }>("GET", guestUrl(g, vmid, `agent/${AGENT_PATH[what]}`));
    const result = r && typeof r === "object" && "result" in r ? r.result : r;
    return { what, result: trim(result) };
  } catch (e) {
    return agentError(ctx, e);
  }
}

/** Keeps replies a sensible size. */
function trim(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 4096 ? `${v.slice(0, 4096)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trim(x, depth + 1));
  if (v && typeof v === "object" && depth < 6) return Object.fromEntries(Object.entries(v as object).slice(0, 100).map(([k, x]) => [k, trim(x, depth + 1)]));
  return v;
}

async function agentDo(ctx: FeatureCtx, pve: ProxmoxClient, g: Found, vmid: number, b: Record<string, unknown>) {
  requireAgentVm(ctx, g);
  const req = checkAgentAction(b);
  const url = (tail: string) => guestUrl(g, vmid, `agent/${tail}`);
  try {
    if (req.action === "ping") {
      await pve.call("POST", url("ping"));
      return { ok: true, message: "The guest agent answered." };
    }
    if (req.action === "fstrim") {
      const r = await pve.call<{ result?: { paths?: { path: string; trimmed?: number; error?: string }[] } }>("POST", url("fstrim"));
      return { ok: true, message: "Unused space was handed back to the storage.", result: trim(r?.result?.paths ?? r) };
    }
    if (req.action === "freeze" || req.action === "thaw" || req.action === "freeze-status") {
      if (req.action === "freeze" && b.confirm !== "freeze") throw new ctx.HttpError(409, "confirm", "Type freeze to confirm. The machine's file systems stop writing until you thaw them.");
      const path = req.action === "freeze" ? "fsfreeze-freeze" : req.action === "thaw" ? "fsfreeze-thaw" : "fsfreeze-status";
      const r = await pve.call<{ result?: unknown }>("POST", url(path));
      const result = r && typeof r === "object" && "result" in r ? r.result : r;
      return { ok: true, message: req.action === "freeze" ? "File systems frozen. Thaw them when you are done." : req.action === "thaw" ? "File systems thawed." : `File systems are ${String(result)}.`, result: trim(result) };
    }
    if (req.action === "set-password") {
      await guarded([req.password], () => pve.call("POST", url("set-user-password"), { username: req.user!, password: req.password! }));
      return { ok: true, message: `Password changed for ${req.user}.` };
    }
    if (req.action === "read-file") {
      const r = await pve.call<{ content?: string; truncated?: boolean; "bytes-read"?: number }>("GET", url("file-read"), { file: req.file!, count: 65_536 });
      return { ok: true, file: req.file, content: typeof r?.content === "string" ? r.content.slice(0, 96 * 1024) : "", truncated: r?.truncated === true };
    }
    // exec: run the command and wait briefly for it to end.
    if (b.confirm !== "run") throw new ctx.HttpError(409, "confirm", "Type run to confirm. The command runs inside the machine as the agent's user (usually root).");
    const started = await pve.call<{ pid?: number }>("POST", url("exec"), { command: req.command!, ...(req.input ? { "input-data": req.input } : {}) });
    const pid = started?.pid;
    if (typeof pid !== "number") return { ok: false, message: "The agent didn't start the command." };
    for (let i = 0; i < 20; i++) {
      const st = await pve.call<{ exited?: number; exitcode?: number; "out-data"?: string; "err-data"?: string; "out-truncated"?: number; "err-truncated"?: number }>("GET", url("exec-status"), { pid });
      if (st?.exited) return { ok: true, finished: true, exitcode: st.exitcode ?? null, out: String(st["out-data"] ?? "").slice(0, 64 * 1024), err: String(st["err-data"] ?? "").slice(0, 64 * 1024) };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: true, finished: false, pid, message: "The command is still running. It keeps going inside the machine." };
  } catch (e) {
    return agentError(ctx, e);
  }
}

