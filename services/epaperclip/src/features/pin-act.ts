import { ProxmoxError, type GuestType, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { WizardError, buildCt, buildVm, type WizardContext } from "@papercliped-engine/proxmox-client/wizard-schema";
import type { Connect } from "../console.ts";
import { MAX_OUTPUT, SENSITIVE, commandRisk, execInGuest } from "./guest-exec.ts";

/**
 * What Pin can do in Agent mode, and how much of it runs without asking.
 *
 * Every action is one entry in `ACTS`: its tool schema, a strict parser, a plain-language label, a risk class and the
 * code that does it on Proxmox as the signed-in person (so Proxmox's own permissions still decide). The person's
 * permission setting decides what happens when Pin calls one:
 *
 *   plan     Pin only writes plans; no action tool is offered.
 *   ask      Every action waits for the person's approval.
 *   accept   Safe actions run now (create, start, snapshot, clone, back up, grow a disk, change settings); anything that
 *            interrupts a machine or can't be undone waits.
 *   auto     Everything runs except what can't be undone (delete, roll back).
 *   bypass   Everything runs, no questions. Switched on deliberately, and still bound by the person's Proxmox permissions.
 *
 * Passwords are never part of a tool call: Pin can't see or invent one, and a container made without one is opened from
 * its console as root.
 */

export type Risk = "safe" | "disruptive" | "destructive";
export type Permission = "plan" | "ask" | "accept" | "auto" | "bypass";
export const PERMISSIONS: readonly Permission[] = ["plan", "ask", "accept", "auto", "bypass"];
export const DEFAULT_PERMISSION: Permission = "ask";

/** What to do with an action of this risk under this permission: run it, ask first, or leave it to a written plan. */
export function gate(permission: Permission, risk: Risk): "run" | "ask" | "plan" {
  if (permission === "plan") return "plan";
  if (permission === "bypass") return "run";
  if (permission === "auto") return risk === "destructive" ? "ask" : "run";
  if (permission === "accept") return risk === "safe" ? "run" : "ask";
  return "ask";
}

export class ActProblem extends Error {
  readonly code = "bad_action";
  constructor(message: string) {
    super(message);
  }
}
const bad = (m: string) => new ActProblem(m);

export interface ActHost {
  node: string;
  username: string;
  pve: () => Promise<ProxmoxClient>;
  /** Legacy console connector, unused by private guest execution. */
  connect?: Connect;
  sleep?: (ms: number) => Promise<void>;
  /** Longest an action may hold its caller waiting for Proxmox (an approval request must answer in time); longer tasks keep running and are reported as such. */
  maxWaitMs?: number;
}

export interface ActResult {
  result: string;
  upid?: string;
  /** A machine the action made, so the console can link to it. */
  vmid?: number;
}

type Args = Record<string, unknown>;

export interface ActDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parse(raw: Args): Args;
  risk(a: Args): Risk;
  /** One line a person can read, and what must be typed to approve it when it can't be undone. */
  describe(a: Args, names?: ReadonlyMap<number, string>): { label: string; phrase: string | null };
  run(h: ActHost, a: Args): Promise<ActResult>;
}

// ---- Strict value checks

const HOST = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const STORAGE = /^[A-Za-z0-9][\w.-]{0,39}$/;
const BRIDGE = /^[A-Za-z][\w.-]{0,14}$/;
const SNAP = /^[A-Za-z][\w-]{1,39}$/;
const VOLID = /^[A-Za-z][\w.-]*:(iso|vztmpl)\/[\w][\w.+-]*$/;
const TEMPLATE_FILE = /^[\w][\w.+-]{2,199}\.tar\.(zst|xz|gz)$/;
const OS_WORDS = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,60}$/;
const DISK = /^(rootfs|mp\d{1,2}|scsi\d{1,2}|virtio\d{1,2}|sata\d|ide\d)$/;
const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const TAG = /^[A-Za-z0-9][\w.+-]{0,29}$/;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

function only(raw: Args, keys: string[], what: string): void {
  for (const k of Object.keys(raw)) if (!keys.includes(k)) throw bad(`${what} has no field “${k}”`);
}
function int(v: unknown, lo: number, hi: number, what: string, dflt?: number): number {
  if (v === undefined || v === null) {
    if (dflt === undefined) throw bad(`${what} is needed`);
    return dflt;
  }
  if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw bad(`${what} must be a whole number from ${lo} to ${hi}`);
  return v as number;
}
function str(v: unknown, re: RegExp, what: string, optional = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    throw bad(`${what} is needed`);
  }
  if (typeof v !== "string" || !re.test(v)) throw bad(`${what} isn't valid`);
  return v;
}
function flag(v: unknown, what: string, dflt: boolean): boolean {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw bad(`${what} must be true or false`);
  return v;
}
const vmidOf = (v: unknown): number => int(v, 100, 999_999_999, "vmid");
const ipOk = (s: string) => s.split("/")[0].split(".").every((n) => Number(n) <= 255);

// ---- Finding things on the node

interface Located {
  type: GuestType;
  where: string;
  name: string;
  status: string;
}

async function locate(pve: ProxmoxClient, node: string, vmid: number): Promise<Located> {
  const g = (await pve.clusterResources()).find((r) => r.vmid === vmid && (r.type === "lxc" || r.type === "qemu"));
  if (!g) throw bad(`There is no machine ${vmid} that you can see.`);
  return { type: g.type as GuestType, where: g.node ?? node, name: g.name ?? String(vmid), status: g.status ?? "unknown" };
}

const vm = (id: unknown, names?: ReadonlyMap<number, string>) => `machine ${id}${typeof id === "number" && names?.get(id) ? ` (${names.get(id)})` : ""}`;

/** Waits for a Proxmox task. Returns "" when it finished, or a sentence when it is still running after the longest wait (it keeps going on Proxmox). A task that fails throws. */
async function done(h: ActHost, pve: ProxmoxClient, where: string, upid: unknown, ms: number): Promise<string> {
  if (typeof upid !== "string" || !upid.startsWith("UPID:")) return "";
  try {
    await pve.waitTask(where, upid, { timeoutMs: Math.min(ms, h.maxWaitMs ?? ms), pollMs: 2000, sleep: h.sleep });
    return "";
  } catch (e) {
    if (e instanceof ProxmoxError && e.status === 504) return ` It is still running on Proxmox (task ${upid}); task_status shows how it ends.`;
    throw e;
  }
}

async function wizardContext(pve: ProxmoxClient, node: string, kind: "ct" | "vm", username: string): Promise<WizardContext> {
  const ctx: WizardContext = { root: username === "root@pam" };
  try {
    const st = await pve.nodeStorages(node, kind === "ct" ? "rootdir" : "images");
    ctx.diskStorages = Object.fromEntries(st.map((s) => [s.storage, { type: s.type }]));
  } catch {
    /* not listed for this account: the checks that need it are skipped, Proxmox decides */
  }
  try {
    ctx.bridges = (await pve.network(node)).interfaces.filter((i) => /bridge/i.test(i.type)).map((i) => i.iface);
  } catch {
    /* same */
  }
  return ctx;
}

const firstStorage = async (pve: ProxmoxClient, node: string, content: string, want?: string): Promise<string> => {
  const list = (await pve.nodeStorages(node, content)).filter((s) => (s.avail ?? 1) > 0);
  if (want) {
    if (!list.some((s) => s.storage === want)) throw bad(`Storage ${want} can't hold ${content} here. Available: ${list.map((s) => s.storage).join(", ") || "none"}.`);
    return want;
  }
  if (!list.length) throw bad(`No storage on this node can hold ${content}.`);
  return (list.find((s) => s.storage === "local-lvm" || s.storage === "local-zfs") ?? list.sort((a, b) => (b.avail ?? 0) - (a.avail ?? 0))[0]).storage;
};

const bridgeOf = async (pve: ProxmoxClient, node: string, want?: string): Promise<string> => {
  if (want) return want;
  try {
    const b = (await pve.network(node)).interfaces.filter((i) => /bridge/i.test(i.type)).map((i) => i.iface);
    if (b.includes("vmbr0")) return "vmbr0";
    if (b.length) return b[0];
  } catch {
    /* fall through */
  }
  return "vmbr0";
};

/** A container template as a volume id: given already, found on a storage by a name like "debian-12", or downloaded from Proxmox's catalog. */
export async function resolveTemplate(h: ActHost, pve: ProxmoxClient, input: string): Promise<{ volid: string; downloaded: boolean }> {
  if (/^[A-Za-z][\w.-]*:vztmpl\/[\w][\w.+-]*$/.test(input)) return { volid: input, downloaded: false };
  const want = input.toLowerCase().trim().replace(/[\s_]+/g, "-");
  const stores = await pve.nodeStorages(h.node, "vztmpl");
  const have: string[] = [];
  for (const s of stores) {
    try {
      for (const it of await pve.storageContent(h.node, s.storage, "vztmpl")) have.push(it.volid);
    } catch {
      /* a storage that can't be listed is skipped */
    }
  }
  const local = have.filter((v) => v.toLowerCase().includes(want)).sort().reverse();
  if (local.length) return { volid: local[0], downloaded: false };
  const catalog = (await pve.templateCatalog(h.node)).filter((t) => t.template.toLowerCase().includes(want)).sort((a, b) => b.template.localeCompare(a.template));
  if (!catalog.length) throw bad(`No container template matches “${input}”. Use list_container_templates to see what is available.`);
  const store = stores.find((s) => s.storage === "local")?.storage ?? stores[0]?.storage;
  if (!store) throw bad("No storage on this node can hold container templates.");
  const upid = await pve.downloadTemplate(h.node, store, catalog[0].template);
  if (await done(h, pve, h.node, upid, 900_000)) throw bad(`The template ${catalog[0].template} is still downloading. Try again in a minute.`);
  return { volid: `${store}:vztmpl/${catalog[0].template}`, downloaded: true };
}

// ---- The actions

const noProps = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });

const POWER = ["start", "shutdown", "stop", "reboot"] as const;
const VERB: Record<string, string> = { start: "Start", shutdown: "Shut down", stop: "Stop", reboot: "Reboot" };
const PAST: Record<string, string> = { start: "Started", shutdown: "Shut down", stop: "Stopped", reboot: "Rebooted" };


// ---- Inside a machine

const sq = (v: string) => `'${v.replace(/'/g, `'"'"'`)}'`;
/** Base64 characters per in-machine command when writing a file, well under a terminal's shortest input line. */
const WRITE_CHUNK = 2000;
/** Files whose change can stop a machine from booting or logging in; writing one needs the person's typed word. */
const SYSTEM_PATH = /^\/(boot|dev|proc|sys)(\/|$)|^\/etc\/(passwd|shadow|gshadow|group|sudoers(\.d\/.*)?|fstab|ssh\/sshd_config|pam\.d\/.*)$|^\/(bin|sbin|lib\w*|usr\/(bin|sbin|lib\w*))(\/|$)/;
function pathOf(v: unknown): string {
  if (typeof v !== "string" || !v.startsWith("/") || v.length > 512 || /[\0\n\r]/.test(v) || v.split("/").includes("..")) throw bad("path must be an absolute path without “..”");
  return v;
}

/** Runs a script in a running machine as the signed-in person and reports the exit code and output in words. */
async function runInMachine(h: ActHost, vmid: number, script: string, timeoutMs: number): Promise<ActResult> {
  const pve = await h.pve();
  const g = await locate(pve, h.node, vmid);
  if (g.status !== "running") throw bad(`${g.name} (${vmid}) isn't running. Start it first.`);
  const r = await execInGuest({ pve: h.pve, connect: h.connect!, sleep: h.sleep }, { type: g.type, vmid, node: g.where }, script, { timeoutMs }).catch((e: unknown) => {
    throw bad(e instanceof Error ? e.message : "Couldn't run that in the machine");
  });
  const head = r.timedOut && g.type === "lxc" ? `Timed out after ${Math.round(timeoutMs / 1000)} s; the command and its children were stopped.` : r.timedOut ? `Still running after ${Math.round(timeoutMs / 1000)} s, so it was stopped waiting (a VM's command can keep running in the guest).` : r.exitCode === 0 ? "Exit 0." : r.exitCode === null ? "Finished with no exit code." : `Exit code ${r.exitCode}.`;
  return { result: `${head} In ${g.name} (${vmid}).${r.output ? `\n${r.output}` : "\n(no output)"}` };
}

export const ACTS: Record<string, ActDef> = {
  power_machine: {
    name: "power_machine",
    description: "Start, shut down (clean), stop (cut power) or reboot a machine.",
    parameters: noProps({ vmid: { type: "integer" }, action: { type: "string", enum: [...POWER] } }, ["vmid", "action"]),
    parse(r) {
      only(r, ["vmid", "action"], "power_machine");
      if (!POWER.includes(r.action as (typeof POWER)[number])) throw bad(`action must be one of ${POWER.join(", ")}`);
      return { vmid: vmidOf(r.vmid), action: r.action };
    },
    risk: (a) => (a.action === "start" ? "safe" : "disruptive"),
    describe: (a, n) => ({ label: `${VERB[a.action as string]} ${vm(a.vmid, n)}`, phrase: a.action === "start" ? null : `${a.action} ${a.vmid}` }),
    async run(h, a) {
      const pve = await h.pve();
      const g = await locate(pve, h.node, a.vmid as number);
      const upid = await pve.guestPower(g.where, g.type, a.vmid as number, a.action as (typeof POWER)[number]);
      const tail = await done(h, pve, g.where, upid, 180_000);
      return { result: `${PAST[a.action as string]} ${g.name} (${a.vmid}).${tail}`, upid };
    },
  },

  snapshot_machine: {
    name: "snapshot_machine",
    description: "Take a snapshot of a machine.",
    parameters: noProps({ vmid: { type: "integer" }, name: { type: "string", description: "2 to 40 letters, digits, - or _, starting with a letter" }, description: { type: "string" } }, ["vmid", "name"]),
    parse(r) {
      only(r, ["vmid", "name", "description"], "snapshot_machine");
      return { vmid: vmidOf(r.vmid), name: str(r.name, SNAP, "The snapshot name"), ...(r.description !== undefined ? { description: clean(r.description, 200) } : {}) };
    },
    risk: () => "safe",
    describe: (a, n) => ({ label: `Take snapshot ${a.name} of ${vm(a.vmid, n)}`, phrase: null }),
    async run(h, a) {
      const pve = await h.pve();
      const g = await locate(pve, h.node, a.vmid as number);
      const upid = await pve.createSnapshot(g.where, g.type, a.vmid as number, a.name as string, a.description as string | undefined);
      const tail = await done(h, pve, g.where, upid, 300_000);
      return { result: `Took snapshot ${a.name} of ${g.name} (${a.vmid}).${tail}`, upid };
    },
  },

  delete_snapshot: {
    name: "delete_snapshot",
    description: "Delete a snapshot of a machine. This can't be undone.",
    parameters: noProps({ vmid: { type: "integer" }, name: { type: "string" } }, ["vmid", "name"]),
    parse(r) {
      only(r, ["vmid", "name"], "delete_snapshot");
      return { vmid: vmidOf(r.vmid), name: str(r.name, SNAP, "The snapshot name") };
    },
    risk: () => "destructive",
    describe: (a, n) => ({ label: `Delete snapshot ${a.name} of ${vm(a.vmid, n)}`, phrase: `delete ${a.vmid}` }),
    async run(h, a) {
      const pve = await h.pve();
      const g = await locate(pve, h.node, a.vmid as number);
      const upid = await pve.deleteSnapshot(g.where, g.type, a.vmid as number, a.name as string);
      const tail = await done(h, pve, g.where, upid, 300_000);
      return { result: `Deleted snapshot ${a.name} of ${g.name} (${a.vmid}).${tail}`, upid };
    },
  },

  rollback_snapshot: {
    name: "rollback_snapshot",
    description: "Roll a machine back to a snapshot. Everything changed since the snapshot is lost.",
    parameters: noProps({ vmid: { type: "integer" }, name: { type: "string" } }, ["vmid", "name"]),
    parse(r) {
      only(r, ["vmid", "name"], "rollback_snapshot");
      return { vmid: vmidOf(r.vmid), name: str(r.name, SNAP, "The snapshot name") };
    },
    risk: () => "destructive",
    describe: (a, n) => ({ label: `Roll ${vm(a.vmid, n)} back to snapshot ${a.name}`, phrase: `rollback ${a.vmid}` }),
    async run(h, a) {
      const pve = await h.pve();
      const g = await locate(pve, h.node, a.vmid as number);
      const upid = await pve.rollbackSnapshot(g.where, g.type, a.vmid as number, a.name as string);
      const tail = await done(h, pve, g.where, upid, 600_000);
      return { result: `Rolled ${g.name} (${a.vmid}) back to ${a.name}.${tail}`, upid };
    },
  },

  create_container: {
    name: "create_container",
    description:
      "Create an LXC container (and start it). `template` is a volume id (local:vztmpl/...), or just an OS name like \"debian-12\" or \"ubuntu-24.04\": it is found on the node or downloaded from Proxmox's catalog. Storage and bridge default to sensible ones on this node. No password is set: it is opened from its console as root.",
    parameters: noProps(
      {
        hostname: { type: "string", description: "Letters, digits and - (up to 63)" },
        template: { type: "string", description: "A volid like local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst, or an OS name like debian-12" },
        disk_gb: { type: "integer", minimum: 1, maximum: 4096, description: "Root disk size, default 8" },
        cores: { type: "integer", minimum: 1, maximum: 128, description: "Default 1" },
        memory_mb: { type: "integer", minimum: 16, maximum: 1048576, description: "Default 512" },
        swap_mb: { type: "integer", minimum: 0, maximum: 1048576, description: "Default 512" },
        storage: { type: "string", description: "Where the root disk goes; default: the best one on this node" },
        bridge: { type: "string", description: "Network bridge, default vmbr0" },
        ipv4: { type: "string", description: "\"dhcp\" (default) or an address with prefix like 192.168.1.50/24" },
        gateway: { type: "string", description: "Gateway for a static address" },
        start: { type: "boolean", description: "Start it after creating (default true)" },
        unprivileged: { type: "boolean", description: "Default true; leave it unless something needs more" },
        nesting: { type: "boolean", description: "Allow containers inside it (Docker), default false" },
        ssh_public_key: { type: "string", description: "A public key to allow for root, if the person gave one" },
      },
      ["hostname", "template"],
    ),
    parse(r) {
      only(r, ["hostname", "template", "disk_gb", "cores", "memory_mb", "swap_mb", "storage", "bridge", "ipv4", "gateway", "start", "unprivileged", "nesting", "ssh_public_key"], "create_container");
      const ipv4 = r.ipv4 === undefined || r.ipv4 === "dhcp" ? "dhcp" : str(r.ipv4, CIDR, "The address (like 192.168.1.50/24)");
      if (ipv4 !== "dhcp" && !ipOk(ipv4!)) throw bad("The address isn't valid");
      const gw = str(r.gateway, IPV4, "The gateway", true);
      if (gw && !ipOk(gw)) throw bad("The gateway isn't valid");
      const key = r.ssh_public_key === undefined ? undefined : clean(r.ssh_public_key, 2000);
      if (key !== undefined && !/^(ssh-(rsa|ed25519)|ecdsa-sha2-[\w-]+|sk-[\w@.-]+) [A-Za-z0-9+/=]+( [^\n]{0,100})?$/.test(key)) throw bad("That doesn't look like an SSH public key");
      const template = typeof r.template === "string" ? r.template.trim() : "";
      if (!template || (!OS_WORDS.test(template) && !/^[A-Za-z][\w.-]*:vztmpl\/[\w][\w.+-]*$/.test(template))) throw bad("template must be a volume id or an OS name like debian-12");
      return {
        hostname: str(r.hostname, HOST, "The hostname"),
        template,
        disk_gb: int(r.disk_gb, 1, 4096, "Disk size", 8),
        cores: int(r.cores, 1, 128, "Cores", 1),
        memory_mb: int(r.memory_mb, 16, 1_048_576, "Memory", 512),
        swap_mb: int(r.swap_mb, 0, 1_048_576, "Swap", 512),
        ...(r.storage !== undefined ? { storage: str(r.storage, STORAGE, "The storage") } : {}),
        ...(r.bridge !== undefined ? { bridge: str(r.bridge, BRIDGE, "The bridge") } : {}),
        ipv4,
        ...(gw ? { gateway: gw } : {}),
        start: flag(r.start, "start", true),
        unprivileged: flag(r.unprivileged, "unprivileged", true),
        nesting: flag(r.nesting, "nesting", false),
        ...(key ? { ssh_public_key: key } : {}),
      };
    },
    risk: () => "safe",
    describe: (a) => ({ label: `Create container “${a.hostname}” from ${a.template} (${a.cores} core${a.cores === 1 ? "" : "s"}, ${a.memory_mb} MB, ${a.disk_gb} GB${a.ipv4 === "dhcp" ? "" : `, ${a.ipv4}`})`, phrase: null }),
    async run(h, a) {
      const pve = await h.pve();
      const t = await resolveTemplate(h, pve, a.template as string);
      const storage = await firstStorage(pve, h.node, "rootdir", a.storage as string | undefined);
      const bridge = await bridgeOf(pve, h.node, a.bridge as string | undefined);
      const vmid = await pve.nextId();
      const spec = {
        general: { hostname: a.hostname, start: a.start, unprivileged: a.unprivileged, tags: ["pin"], description: `Created by Pin for ${h.username}`, ...(a.ssh_public_key ? { sshKeys: a.ssh_public_key } : {}) },
        template: t.volid,
        disk: { storage, sizeGb: a.disk_gb },
        cpu: { cores: a.cores },
        memory: { mb: a.memory_mb, swapMb: a.swap_mb },
        network: [{ bridge, ipv4: a.ipv4 === "dhcp" ? { mode: "dhcp" } : { mode: "static", cidr: a.ipv4, ...(a.gateway ? { gw: a.gateway } : {}) } }],
        ...(a.nesting ? { features: { nesting: true } } : {}),
      };
      const built = buildCt(spec, vmid, await wizardContext(pve, h.node, "ct", h.username));
      const upid = await pve.createLxc(h.node, built.params);
      const tail = await done(h, pve, h.node, upid, 600_000);
      let ip = "";
      if (a.start && !tail) {
        // A container on DHCP shows its address a few seconds after it starts.
        for (let i = 0; i < 8 && !ip; i++) {
          await (h.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(2500);
          try {
            ip = (await pve.lxcInterfaces(h.node, vmid)).find((x) => x.name !== "lo" && x.inet)?.inet ?? "";
          } catch {
            /* not up yet */
          }
        }
      }
      return { result: `Created container ${a.hostname} as machine ${vmid} on storage ${storage}, bridge ${bridge}${t.downloaded ? " (the template was downloaded first)" : ""}${a.start ? `, started${ip ? `; address ${ip}` : "; address not known yet"}` : ""}.${built.warnings.length ? ` Notes: ${built.warnings.join(" ")}` : ""}${tail}`, upid, vmid };
    },
  },

  create_vm: {
    name: "create_vm",
    description: "Create a virtual machine with an empty disk, optionally with an ISO attached to install from. It is not started unless asked. Storage and bridge default to sensible ones on this node.",
    parameters: noProps(
      {
        name: { type: "string" },
        memory_mb: { type: "integer", minimum: 128, maximum: 1048576, description: "Default 2048" },
        cores: { type: "integer", minimum: 1, maximum: 128, description: "Default 2" },
        disk_gb: { type: "integer", minimum: 1, maximum: 16384, description: "Default 32" },
        storage: { type: "string" },
        bridge: { type: "string" },
        iso: { type: "string", description: "An ISO volume id like local:iso/debian-12.iso (see list_isos)" },
        ostype: { type: "string", enum: ["l26", "win11", "win10", "other"], description: "Default l26 (Linux)" },
        start: { type: "boolean", description: "Default false" },
      },
      ["name"],
    ),
    parse(r) {
      only(r, ["name", "memory_mb", "cores", "disk_gb", "storage", "bridge", "iso", "ostype", "start"], "create_vm");
      const ostype = r.ostype === undefined ? "l26" : r.ostype;
      if (!["l26", "win11", "win10", "other"].includes(ostype as string)) throw bad("ostype must be l26, win11, win10 or other");
      return {
        name: str(r.name, HOST, "The name"),
        memory_mb: int(r.memory_mb, 128, 1_048_576, "Memory", 2048),
        cores: int(r.cores, 1, 128, "Cores", 2),
        disk_gb: int(r.disk_gb, 1, 16_384, "Disk size", 32),
        ...(r.storage !== undefined ? { storage: str(r.storage, STORAGE, "The storage") } : {}),
        ...(r.bridge !== undefined ? { bridge: str(r.bridge, BRIDGE, "The bridge") } : {}),
        ...(r.iso !== undefined ? { iso: str(r.iso, /^[A-Za-z][\w.-]*:iso\/[\w][\w.+-]*$/, "The ISO volume id") } : {}),
        ostype,
        start: flag(r.start, "start", false),
      };
    },
    risk: () => "safe",
    describe: (a) => ({ label: `Create virtual machine “${a.name}” (${a.cores} core${a.cores === 1 ? "" : "s"}, ${a.memory_mb} MB, ${a.disk_gb} GB${a.iso ? `, installing from ${a.iso}` : ""})`, phrase: null }),
    async run(h, a) {
      const pve = await h.pve();
      const storage = await firstStorage(pve, h.node, "images", a.storage as string | undefined);
      const bridge = await bridgeOf(pve, h.node, a.bridge as string | undefined);
      const vmid = await pve.nextId();
      const spec = {
        general: { name: a.name, start: a.start, tags: ["pin"], description: `Created by Pin for ${h.username}` },
        os: a.iso ? { media: "iso", iso: a.iso, ostype: a.ostype } : { media: "none", ostype: a.ostype },
        system: {},
        cpu: { cores: a.cores },
        memory: { mb: a.memory_mb },
        disks: [{ bus: "scsi", storage, sizeGb: a.disk_gb }],
        network: [{ model: "virtio", bridge }],
      };
      const built = buildVm(spec, vmid, await wizardContext(pve, h.node, "vm", h.username));
      const upid = await pve.createVm(h.node, built.params);
      const tail = await done(h, pve, h.node, upid, 600_000);
      return { result: `Created virtual machine ${a.name} as machine ${vmid} on storage ${storage}, bridge ${bridge}${a.start ? ", started" : "; it is not started"}.${built.warnings.length ? ` Notes: ${built.warnings.join(" ")}` : ""}${tail}`, upid, vmid };
    },
  },

  clone_machine: {
    name: "clone_machine",
    description: "Make a full copy of a machine under a new id and name.",
    parameters: noProps({ vmid: { type: "integer" }, name: { type: "string", description: "Name for the copy" } }, ["vmid", "name"]),
    parse(r) {
      only(r, ["vmid", "name"], "clone_machine");
      return { vmid: vmidOf(r.vmid), name: str(r.name, HOST, "The name for the copy") };
    },
    risk: () => "safe",
    describe: (a, n) => ({ label: `Clone ${vm(a.vmid, n)} as “${a.name}”`, phrase: null }),
    async run(h, a) {
      const pve = await h.pve();
      const g = await locate(pve, h.node, a.vmid as number);
      const newid = await pve.nextId();
      const upid = await pve.cloneGuest(g.where, g.type, a.vmid as number, { newid, [g.type === "lxc" ? "hostname" : "name"]: a.name as string, full: 1 });
      const tail = await done(h, pve, g.where, upid, 1_800_000);
      return { result: `Cloned ${g.name} (${a.vmid}) as ${a.name}, machine ${newid}.${tail}`, upid, vmid: newid };
    },
  },

  backup_machine: {
    name: "backup_machine",
    description: "Back a machine up now to a backup storage (snapshot mode, compressed).",
    parameters: noProps({ vmid: { type: "integer" }, storage: { type: "string", description: "A storage that holds backups; default: the first one" } }, ["vmid"]),
    parse(r) {
      only(r, ["vmid", "storage"], "backup_machine");
      return { vmid: vmidOf(r.vmid), ...(r.storage !== undefined ? { storage: str(r.storage, STORAGE, "The storage") } : {}) };
    },
    risk: () => "safe",
    describe: (a, n) => ({ label: `Back up ${vm(a.vmid, n)} now${a.storage ? ` to ${a.storage}` : ""}`, phrase: null }),
    async run(h, a) {
      const pve = await h.pve();
      const g = await locate(pve, h.node, a.vmid as number);
      const storage = await firstStorage(pve, h.node, "backup", a.storage as string | undefined);
      const upid = await pve.vzdump(h.node, { vmid: a.vmid as number, storage, mode: "snapshot", compress: "zstd" });
      const tail = await done(h, pve, h.node, upid, 3_600_000);
      return { result: `Backed up ${g.name} (${a.vmid}) to ${storage}.${tail}`, upid };
    },
  },

  resize_disk: {
    name: "resize_disk",
    description: "Grow one of a machine's disks by some gigabytes (disks can't shrink). `disk` is rootfs for a container or scsi0, virtio0, sata0 ... for a VM.",
    parameters: noProps({ vmid: { type: "integer" }, disk: { type: "string" }, grow_gb: { type: "integer", minimum: 1, maximum: 4096 } }, ["vmid", "disk", "grow_gb"]),
    parse(r) {
      only(r, ["vmid", "disk", "grow_gb"], "resize_disk");
      return { vmid: vmidOf(r.vmid), disk: str(r.disk, DISK, "The disk name"), grow_gb: int(r.grow_gb, 1, 4096, "Growth") };
    },
    risk: () => "safe",
    describe: (a, n) => ({ label: `Grow ${a.disk} of ${vm(a.vmid, n)} by ${a.grow_gb} GB`, phrase: null }),
    async run(h, a) {
      const pve = await h.pve();
      const g = await locate(pve, h.node, a.vmid as number);
      await pve.resizeDisk(g.where, g.type, a.vmid as number, a.disk as string, `+${a.grow_gb}G`);
      return { result: `Grew ${a.disk} of ${g.name} (${a.vmid}) by ${a.grow_gb} GB. The file system inside still has to be grown.` };
    },
  },

  set_machine_config: {
    name: "set_machine_config",
    description: "Change a machine's name, cores, memory, swap (containers), start at boot, description, tags or console_mode. Console mode affects only the interactive console; private execution does not depend on it. Some changes apply at its next restart.",
    parameters: noProps(
      {
        vmid: { type: "integer" },
        name: { type: "string" },
        cores: { type: "integer", minimum: 1, maximum: 128 },
        memory_mb: { type: "integer", minimum: 16, maximum: 1048576 },
        swap_mb: { type: "integer", minimum: 0, maximum: 1048576 },
        onboot: { type: "boolean" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" }, maxItems: 10 },
        console_mode: { type: "string", enum: ["shell", "tty", "console"] },
      },
      ["vmid"],
    ),
    parse(r) {
      only(r, ["vmid", "name", "cores", "memory_mb", "swap_mb", "onboot", "description", "tags", "console_mode"], "set_machine_config");
      const out: Args = { vmid: vmidOf(r.vmid) };
      if (r.name !== undefined) out.name = str(r.name, HOST, "The name");
      if (r.cores !== undefined) out.cores = int(r.cores, 1, 128, "Cores");
      if (r.memory_mb !== undefined) out.memory_mb = int(r.memory_mb, 16, 1_048_576, "Memory");
      if (r.swap_mb !== undefined) out.swap_mb = int(r.swap_mb, 0, 1_048_576, "Swap");
      if (r.onboot !== undefined) out.onboot = flag(r.onboot, "onboot", false);
      if (r.description !== undefined) out.description = clean(r.description, 500);
      if (r.tags !== undefined) {
        if (!Array.isArray(r.tags) || r.tags.length > 10 || !r.tags.every((t) => typeof t === "string" && TAG.test(t))) throw bad("tags must be up to 10 short words");
        out.tags = r.tags;
      }
      if (r.console_mode !== undefined) {
        if (r.console_mode !== "shell" && r.console_mode !== "tty" && r.console_mode !== "console") throw bad("console_mode must be shell, tty or console");
        out.console_mode = r.console_mode;
      }
      if (Object.keys(out).length === 1) throw bad("Say what to change");
      return out;
    },
    risk: () => "safe",
    describe: (a, n) => ({ label: `Change ${vm(a.vmid, n)}: ${Object.entries(a).filter(([k]) => k !== "vmid").map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(",") : String(v)}`).join(", ")}`, phrase: null }),
    async run(h, a) {
      const pve = await h.pve();
      const g = await locate(pve, h.node, a.vmid as number);
      const p: Record<string, string | number | boolean | undefined> = {};
      if (a.name !== undefined) p[g.type === "lxc" ? "hostname" : "name"] = a.name as string;
      if (a.cores !== undefined) p.cores = a.cores as number;
      if (a.memory_mb !== undefined) p.memory = a.memory_mb as number;
      if (a.swap_mb !== undefined) {
        if (g.type !== "lxc") throw bad("Swap is a container setting");
        p.swap = a.swap_mb as number;
      }
      if (a.onboot !== undefined) p.onboot = a.onboot ? 1 : 0;
      if (a.description !== undefined) p.description = a.description as string;
      if (a.tags !== undefined) p.tags = (a.tags as string[]).join(";");
      if (a.console_mode !== undefined) {
        if (g.type !== "lxc") throw bad("Console mode is a container setting");
        p.cmode = a.console_mode as string;
      }
      await pve.setGuestConfig(g.where, g.type, a.vmid as number, p);
      return { result: `Updated ${g.name} (${a.vmid}). ${g.status === "running" ? "Some changes apply at its next restart." : ""}`.trim() };
    },
  },

  delete_machine: {
    name: "delete_machine",
    description: "Delete a stopped machine and its disks. This can't be undone.",
    parameters: noProps({ vmid: { type: "integer" } }, ["vmid"]),
    parse(r) {
      only(r, ["vmid"], "delete_machine");
      return { vmid: vmidOf(r.vmid) };
    },
    risk: () => "destructive",
    describe: (a, n) => ({ label: `Delete ${vm(a.vmid, n)} and its disks`, phrase: `destroy ${a.vmid}` }),
    async run(h, a) {
      const pve = await h.pve();
      const g = await locate(pve, h.node, a.vmid as number);
      if (g.status === "running") throw bad(`${g.name} (${a.vmid}) is running. Shut it down first.`);
      const upid = await pve.destroyGuest(g.where, g.type, a.vmid as number);
      const tail = await done(h, pve, g.where, upid, 600_000);
      return { result: `Deleted ${g.name} (${a.vmid}).${tail}`, upid };
    },
  },

  machine_exec: {
    name: "machine_exec",
    description:
      "Run a shell command INSIDE a running machine (a container, or a VM with the QEMU guest agent) and get its output and exit code. It runs as root in a Linux shell. Use it to install and configure software, read logs, check services, build and test. One command or a short script per call; long jobs should be started in the background with their output in a file (`nohup cmd > /tmp/job.log 2>&1 &`) and checked later. A command that runs past its timeout is stopped, together with everything it started; a background job started by a command that finished keeps running. Reading commands run without asking in most modes; anything that changes the machine is held for approval unless the person turned that off.",
    parameters: noProps({ vmid: { type: "integer" }, command: { type: "string", description: "The shell command or short script to run" }, timeout_s: { type: "integer", minimum: 1, maximum: 600, description: "Seconds to wait (default 60)" } }, ["vmid", "command"]),
    parse(r) {
      only(r, ["vmid", "command", "timeout_s"], "machine_exec");
      if (typeof r.command !== "string" || !r.command.trim()) throw bad("command is needed");
      if (r.command.length > 8000 || r.command.includes("\0")) throw bad("command must be text up to 8000 characters");
      return { vmid: vmidOf(r.vmid), command: r.command, timeout_s: int(r.timeout_s, 1, 600, "timeout_s", 60) };
    },
    risk: (a) => commandRisk(a.command as string),
    describe: (a, n) => {
      const first = (a.command as string).split("\n")[0].trim();
      const label = `Run \`${first.length > 140 ? `${first.slice(0, 140)}…` : first}\`${(a.command as string).includes("\n") ? " (and more lines)" : ""} in ${vm(a.vmid, n)}`;
      return { label, phrase: commandRisk(a.command as string) === "destructive" ? `run ${a.vmid}` : null };
    },
    run: (h, a) => runInMachine(h, a.vmid as number, a.command as string, (a.timeout_s as number) * 1000),
  },

  machine_read_file: {
    name: "machine_read_file",
    description: "Read a text file inside a running machine (up to 64 KiB). Files that hold credentials or keys are held for approval.",
    parameters: noProps({ vmid: { type: "integer" }, path: { type: "string", description: "Absolute path" } }, ["vmid", "path"]),
    parse(r) {
      only(r, ["vmid", "path"], "machine_read_file");
      return { vmid: vmidOf(r.vmid), path: pathOf(r.path) };
    },
    risk: (a) => (SENSITIVE.test(a.path as string) ? "disruptive" : "safe"),
    describe: (a, n) => ({ label: `Read ${a.path} in ${vm(a.vmid, n)}`, phrase: null }),
    run: (h, a) => runInMachine(h, a.vmid as number, `head -c ${MAX_OUTPUT - 1024} -- ${sq(a.path as string)}`, 30_000),
  },

  machine_write_file: {
    name: "machine_write_file",
    description: "Write (or append to) a text file inside a running machine. Creates the folder if needed. Up to 64 KiB per call. Changes the machine, so it is held for approval in most modes.",
    parameters: noProps({ vmid: { type: "integer" }, path: { type: "string", description: "Absolute path" }, content: { type: "string" }, append: { type: "boolean" }, mode: { type: "string", description: "Octal permissions such as 0644" } }, ["vmid", "path", "content"]),
    parse(r) {
      only(r, ["vmid", "path", "content", "append", "mode"], "machine_write_file");
      if (typeof r.content !== "string" || r.content.length > 64 * 1024 || r.content.includes("\0")) throw bad("content must be text up to 64 KiB");
      return { vmid: vmidOf(r.vmid), path: pathOf(r.path), content: r.content, append: flag(r.append, "append", false), ...(r.mode !== undefined ? { mode: str(r.mode, /^[0-7]{3,4}$/, "The mode") } : {}) };
    },
    risk: (a) => (SYSTEM_PATH.test(a.path as string) ? "destructive" : "disruptive"),
    describe: (a, n) => ({ label: `${a.append ? "Append to" : "Write"} ${a.path} (${Buffer.byteLength(a.content as string)} bytes) in ${vm(a.vmid, n)}`, phrase: SYSTEM_PATH.test(a.path as string) ? `write ${a.vmid}` : null }),
    run: async (h, a) => {
      const p = sq(a.path as string);
      const b64 = Buffer.from(a.content as string, "utf8").toString("base64");
      const write = (src: string) => `set -e; mkdir -p "$(dirname ${p})"; ${src} | base64 -d ${a.append ? ">>" : ">"} ${p}${a.mode ? `; chmod ${a.mode} ${p}` : ""}; echo wrote ${p}`;
      if (b64.length <= WRITE_CHUNK) return runInMachine(h, a.vmid as number, write(`printf %s ${b64}`), 30_000);
      // A container's command travels through its terminal, whose input line can be as short as 4 KiB: stage the content in
      // pieces, then decode it in one go.
      const stage = sq(`/tmp/.epc-write-${Date.now().toString(36)}.b64`);
      for (let i = 0; i < b64.length; i += WRITE_CHUNK) {
        const r = await runInMachine(h, a.vmid as number, `set -e; printf %s ${b64.slice(i, i + WRITE_CHUNK)} ${i === 0 ? ">" : ">>"} ${stage}`, 30_000);
        if (!r.result.startsWith("Exit 0.")) return r;
      }
      return runInMachine(h, a.vmid as number, `${write(`cat ${stage}`)}; rm -f ${stage}`, 30_000);
    },
  },

  download_template: {
    name: "download_template",
    description: "Download a container template from Proxmox's catalog onto a storage (see list_container_templates for names).",
    parameters: noProps({ template: { type: "string", description: "A catalog file name like debian-12-standard_12.7-1_amd64.tar.zst" }, storage: { type: "string" } }, ["template"]),
    parse(r) {
      only(r, ["template", "storage"], "download_template");
      return { template: str(r.template, TEMPLATE_FILE, "The template file name"), ...(r.storage !== undefined ? { storage: str(r.storage, STORAGE, "The storage") } : {}) };
    },
    risk: () => "safe",
    describe: (a) => ({ label: `Download template ${a.template}${a.storage ? ` to ${a.storage}` : ""}`, phrase: null }),
    async run(h, a) {
      const pve = await h.pve();
      const storage = await firstStorage(pve, h.node, "vztmpl", (a.storage as string | undefined) ?? "local").catch(() => firstStorage(pve, h.node, "vztmpl"));
      const upid = await pve.downloadTemplate(h.node, storage, a.template as string);
      const tail = await done(h, pve, h.node, upid, 900_000);
      return { result: `Downloaded ${a.template} to ${storage}.${tail}`, upid };
    },
  },
};

export const ACT_NAMES = Object.keys(ACTS);

/** The tool list Pin is offered for actions: only when the permission lets it act or ask. */
export const ACT_TOOLS = Object.values(ACTS).map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));

// ---- Read tools that give Pin the facts it needs to act well

export const READ_TOOLS = [
  { name: "list_container_templates", description: "Container templates available: the ones already on this node's storages, and the OS names Proxmox can download.", parameters: noProps({}) },
  { name: "list_isos", description: "ISO images on this node's storages (volume ids to install a virtual machine from).", parameters: noProps({}) },
  { name: "list_bridges", description: "This node's network bridges and their addresses.", parameters: noProps({}) },
  { name: "list_snapshots", description: "A machine's snapshots.", parameters: noProps({ vmid: { type: "integer" } }, ["vmid"]) },
  { name: "list_backups", description: "Backups on this node's storages, optionally for one machine.", parameters: noProps({ vmid: { type: "integer" } }) },
  { name: "task_status", description: "Whether a Proxmox task (its UPID) is still running, how it ended, and the end of its log.", parameters: noProps({ upid: { type: "string" } }, ["upid"]) },
] as const;

export const READ_NAMES: readonly string[] = READ_TOOLS.map((t) => t.name);

export async function runRead(name: string, args: Args, h: ActHost): Promise<unknown> {
  const pve = await h.pve();
  const node = h.node;
  if (name === "list_container_templates") {
    const stores = await pve.nodeStorages(node, "vztmpl");
    const local: string[] = [];
    for (const s of stores) {
      try {
        for (const it of await pve.storageContent(node, s.storage, "vztmpl")) local.push(it.volid);
      } catch {
        /* skipped */
      }
    }
    const catalog = (await pve.templateCatalog(node).catch(() => [])).filter((t) => (t.section ?? "system") === "system").slice(0, 60).map((t) => ({ template: t.template, os: t.os ?? null, version: t.version ?? null, headline: t.headline ?? null }));
    return { onNode: local, downloadable: catalog, storages: stores.map((s) => s.storage) };
  }
  if (name === "list_isos") {
    const stores = await pve.nodeStorages(node, "iso");
    const out: string[] = [];
    for (const s of stores) {
      try {
        for (const it of await pve.storageContent(node, s.storage, "iso")) out.push(it.volid);
      } catch {
        /* skipped */
      }
    }
    return { isos: out };
  }
  if (name === "list_bridges") {
    const n = await pve.network(node);
    return { bridges: n.interfaces.filter((i) => /bridge/i.test(i.type)).map((i) => ({ name: i.iface, address: i.cidr ?? i.address ?? null, ports: i.bridge_ports ?? null })) };
  }
  if (name === "list_snapshots") {
    const vmid = vmidOf(args.vmid);
    const g = await locate(pve, node, vmid);
    return { machine: vmid, snapshots: (await pve.snapshots(g.where, g.type, vmid)).filter((s) => s.name !== "current").map((s) => ({ name: s.name, description: s.description ?? "", at: s.snaptime ?? null })) };
  }
  if (name === "list_backups") {
    const want = args.vmid === undefined ? undefined : vmidOf(args.vmid);
    const stores = await pve.nodeStorages(node, "backup");
    const out: { volid: string; vmid: number | null; size: number | null; at: number | null }[] = [];
    for (const s of stores) {
      try {
        for (const it of await pve.storageContentAll(node, s.storage, "backup")) if (want === undefined || it.vmid === want) out.push({ volid: it.volid, vmid: it.vmid ?? null, size: it.size ?? null, at: it.ctime ?? null });
      } catch {
        /* skipped */
      }
    }
    return { backups: out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 40) };
  }
  if (name === "task_status") {
    const upid = typeof args.upid === "string" && /^UPID:[\w.:@-]{10,300}$/.test(args.upid) ? args.upid : null;
    if (!upid) throw bad("upid must be a task id that starts with UPID:");
    const s = await pve.taskStatus(node, upid);
    const log = s.status === "stopped" ? (await pve.taskLog(node, upid, 400).catch(() => [])).slice(-8).map((l) => l.t) : [];
    return { status: s.status, exit: s.exitstatus ?? null, lastLines: log };
  }
  throw bad(`There is no tool called ${name}.`);
}

/** A failure in words the model (and the person) can use. */
export function actFailure(e: unknown): string {
  if (e instanceof ActProblem || e instanceof WizardError) return e.message.slice(0, 400);
  if (e instanceof ProxmoxError) {
    if (e.status === 403) return "Proxmox says the person doesn't have permission for this.";
    return `Proxmox couldn't do it${e.detail ? `: ${e.detail.slice(0, 300)}` : "."}`;
  }
  if (e instanceof Error && /fetch|ECONN|timed out/i.test(e.message)) return "Couldn't reach Proxmox.";
  return "It failed.";
}
