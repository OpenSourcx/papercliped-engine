import { createConnection } from "node:net";
import { hostname } from "node:os";
import { ProxmoxError, type GuestType, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import type { Connect } from "../console.ts";

/**
 * Running commands inside a machine, as the signed-in person, with no ssh and no key kept on the host.
 *
 *   VM         through the QEMU guest agent (`agent/exec`): needs the agent running in the guest, a Linux guest with /bin/sh,
 *              and the privilege Proxmox asks for (VM.GuestAgent.Unrestricted; VM.Monitor on older versions).
 *   Container  through the local root-owned, socket-activated exec helper, which independently verifies VM.Console.
 *              Private lxc-attach pipes carry the script on stdin; the shared console is never opened. Local guests only.
 *
 * Proxmox's own permissions decide who may do either; nothing here widens them. The caller (Pin's actions) decides when to
 * ask the person first (docs/PIN.md).
 */

export interface ExecResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface ExecHost {
  pve: () => Promise<ProxmoxClient>;
  connect: Connect;
  sleep?: (ms: number) => Promise<void>;
  execSocket?: string;
  localNode?: string;
}

export interface Guest {
  type: GuestType;
  vmid: number;
  node: string;
}

/** The most output handed back to a caller; the rest is cut and the result says so. */
export const MAX_OUTPUT = 64 * 1024;
function cut(text: string): { output: string; truncated: boolean } {
  return text.length > MAX_OUTPUT ? { output: `${text.slice(0, MAX_OUTPUT)}\n… (output cut at ${MAX_OUTPUT / 1024} KiB)`, truncated: true } : { output: text, truncated: false };
}

export async function execInGuest(h: ExecHost, g: Guest, script: string, o: { timeoutMs: number }): Promise<ExecResult> {
  const pve = await h.pve();
  return g.type === "qemu" ? execInVm(h, pve, g, script, o.timeoutMs) : execInContainer(h, pve, g, script, o.timeoutMs);
}

async function execInVm(h: ExecHost, pve: ProxmoxClient, g: Guest, script: string, timeoutMs: number): Promise<ExecResult> {
  const sleep = h.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let pid: number;
  try {
    pid = (await pve.agentExec(g.node, g.vmid, ["/bin/sh", "-c", script])).pid;
  } catch (e) {
    if (e instanceof ProxmoxError && /agent is not running|not running|timeout/i.test(e.detail ?? e.message)) throw new Error("The QEMU guest agent isn't running in that machine, so nothing can be run inside it. Install qemu-guest-agent in the guest and turn on the Guest Agent option.");
    if (e instanceof ProxmoxError && e.status === 403) throw new Error("Your Proxmox account can't run commands in that machine (it needs VM.GuestAgent.Unrestricted, or VM.Monitor on older Proxmox).");
    throw e;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await pve.agentExecStatus(g.node, g.vmid, pid);
    if (st.exited === 1 || st.exited === true) {
      const out = st["out-data"] ?? "";
      const err = st["err-data"] ?? "";
      const text = `${out}${err ? `${out && !out.endsWith("\n") ? "\n" : ""}[stderr]\n${err}` : ""}`;
      const c = cut(text);
      return { exitCode: typeof st.exitcode === "number" ? st.exitcode : null, output: c.output, timedOut: false, truncated: c.truncated || !!st["out-truncated"] || !!st["err-truncated"] };
    }
    if (Date.now() >= deadline) return { exitCode: null, output: "", timedOut: true, truncated: false };
    await sleep(400);
  }
}

function execInContainer(h: ExecHost, pve: ProxmoxClient, g: Guest, script: string, timeoutMs: number): Promise<ExecResult> {
  const local = h.localNode ?? process.env.EPC_PVE_NODE ?? hostname().split(".")[0];
  if (g.node !== local) return Promise.reject(new Error(`Commands in containers must run on the node that hosts the container (${g.node}). Open ePaperclip on that node; remote forwarding is not available.`));
  return new Promise((resolve, reject) => {
    const socket = createConnection(h.execSocket ?? "/run/epaperclip-exec/exec.sock");
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("The container exec helper did not answer before its deadline.")); }, timeoutMs + 10_000);
    socket.on("connect", () => {
      socket.end(JSON.stringify({ vmid: g.vmid, node: g.node, script, timeoutMs, auth: pve.execAuth() }));
    });
    socket.on("data", b => {
      data += b.toString();
      if (Buffer.byteLength(data) > 512 * 1024) socket.destroy(new Error("Exec helper response exceeded its limit."));
    });
    socket.on("error", () => {
      clearTimeout(timer);
      reject(new Error(`Commands in containers need the ePaperclip exec helper on node ${g.node}. Install or update ePaperclip there and enable epaperclip-exec.socket.`));
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(data) as ExecResult & { error?: string };
        if (r.error) return reject(new Error(r.error));
        if (!(r.exitCode === null || Number.isInteger(r.exitCode)) || typeof r.output !== "string" || typeof r.timedOut !== "boolean" || typeof r.truncated !== "boolean") throw new Error();
        resolve(r);
      } catch { reject(new Error("The container exec helper returned an invalid response.")); }
    });
  });
}

// ---- Risk of a command line

/** Commands that only read, and the arguments of the few that read or change depending on them. */
const READ_ONLY = new Set(["find", "ls", "cat", "head", "tail", "df", "du", "free", "uptime", "ps", "whoami", "id", "hostname", "uname", "date", "pwd", "nproc", "lscpu", "lsblk", "lsmod", "lspci", "lsusb", "stat", "file", "which", "wc", "grep", "env", "printenv", "dmesg", "ss", "netstat", "pveversion", "readlink", "realpath", "basename", "dirname", "echo", "printf", "true", "test", "id", "groups", "last", "w", "who", "lsof", "mount", "findmnt", "blkid", "locale", "timedatectl"]);
const SUBCOMMANDS: Record<string, RegExp> = {
  systemctl: /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|show|cat)$/,
  journalctl: /.*/,
  apt: /^(list|policy|show|search)$/,
  "apt-cache": /^(policy|show|search|depends|rdepends)$/,
  dpkg: /^(-l|-L|-s|--list|--listfiles|--status|-S|--search)$/,
  ip: /^(a|addr|address|r|route|l|link|-br|-brief|-4|-6|neigh|n)$/,
  docker: /^(ps|images|logs|inspect|version|info|stats|top|port|volume|network)$/,
  podman: /^(ps|images|logs|inspect|version|info|stats|top|port)$/,
  git: /^(status|log|diff|show|branch|remote|rev-parse|describe)$/,
  node: /^(-v|--version)$/,
  npm: /^(ls|list|view|outdated|-v|--version)$/,
  python3: /^(-V|--version)$/,
  pip: /^(list|show|freeze)$/,
  pip3: /^(list|show|freeze)$/,
  crontab: /^-l$/,
};
/** Files that hold credentials or keys. Reading one asks first even though reading changes nothing. */
export const SENSITIVE = /(\/etc\/(shadow|gshadow|sudoers|ssh\/ssh_host_\w+_key)|\.ssh\/(id_|authorized_keys)|\.(env|netrc|pgpass|git-credentials|npmrc|pypirc|aws\/credentials)\b|\.(pem|key|p12|pfx|kdbx)\b|\/proc\/[^\s/]*\/environ|secret|token|passw(or)?d|credential)/i;
const SHELL_META = /[;&|<>`$()\n\\{}*?!~#"']/;
/** Anything whose effect can't be taken back, or that can take a machine's data or availability with it. */
const DESTRUCTIVE = /(^|[\s;&|(`])(rm|rmdir|unlink|shred|wipefs|mkfs(\.\w+)?|dd|fdisk|sfdisk|sgdisk|parted|lvremove|vgremove|pvremove|lvreduce|zfs\s+destroy|zpool\s+destroy|userdel|deluser|truncate|dropdb|mkswap)(\s|$)|(^|[\s;&|])>\s*\/dev\/|:\s*\(\)\s*\{|\bdrop\s+(database|table)\b|\bdelete\s+from\b|\bchmod\s+-R\b|\bchown\s+-R\b|\bfind\b[^|;&]*\s(-delete|-exec)\b|\bgit\s+(reset\s+--hard|clean|push\s+(-f|--force))|\b(docker|podman)\s+(rm|rmi|system\s+prune|volume\s+(rm|prune)|network\s+(rm|prune))\b|\bapt(-get)?\s+(remove|purge|autoremove)\b|\b(shutdown|reboot|poweroff|halt|init\s+[06])\b/i;

/**
 * "safe" for a single plain command that only reads, "destructive" when the line looks like it deletes or overwrites or
 * stops the machine, "disruptive" for everything else (it changes something, or can't be told apart from something that
 * does). The line is never run to find out; unknown means ask.
 */
export function commandRisk(line: string): "safe" | "disruptive" | "destructive" {
  const cmd = line.trim();
  if (DESTRUCTIVE.test(cmd)) return "destructive";
  // Reading a secret is not harmless: the output goes back to the model provider.
  if (SENSITIVE.test(cmd)) return "disruptive";
  if (!cmd || SHELL_META.test(cmd)) return "disruptive";
  const [name, ...args] = cmd.split(/\s+/);
  const base = name.split("/").pop()!;
  if (READ_ONLY.has(base)) {
    if (base === "mount" && args.length > 0) return "disruptive";
    if (base === "env" && args.some((a) => !a.startsWith("-"))) return "disruptive";
    if (base === "timedatectl" && args.length > 0 && !/^(status|show|list-timezones)$/.test(args[0])) return "disruptive";
    return "safe";
  }
  const sub = SUBCOMMANDS[base];
  if (sub) {
    const first = args.find((a) => !a.startsWith("--") || /^--(version|list|status)$/.test(a)) ?? args[0];
    if (base === "journalctl") return args.some((a) => /^--(vacuum|rotate|flush|setup-keys)/.test(a)) ? "disruptive" : "safe";
    return first !== undefined && sub.test(first) ? "safe" : "disruptive";
  }
  return "disruptive";
}
