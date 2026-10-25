import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { ProxmoxError, type GuestType, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import type { Connect } from "../console.ts";

/**
 * Running commands inside a machine, as the signed-in person, with no ssh and no key kept on the host.
 *
 *   VM         through the QEMU guest agent (`agent/exec`): needs the agent running in the guest, a Linux guest with /bin/sh,
 *              and the privilege Proxmox asks for (VM.GuestAgent.Unrestricted; VM.Monitor on older versions).
 *   Container  through the terminal Proxmox gives that person (the same one the console uses, VM.Console). The command is
 *              sent as a base64 script between two markers the shell prints, so the output is exactly what it printed.
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
}

export interface Guest {
  type: GuestType;
  vmid: number;
  node: string;
}

/** The most output handed back to a caller; the rest is cut and the result says so. */
export const MAX_OUTPUT = 64 * 1024;
const COLLECT_MAX = 256 * 1024;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[()][A-Z0-9]|\u001b[=>]/g;
const clean = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI, "");

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
  return new Promise<ExecResult>((resolve, reject) => {
    pve.terminalTarget(g.node, { type: "lxc", vmid: g.vmid }).then((target) => {
      const ws = h.connect({ url: target.url, headers: target.headers, handshake: target.handshake });
      const nonce = randomBytes(6).toString("hex");
      const START = `__EPC_S_${nonce}__`;
      const END = new RegExp(`__EPC_E_${nonce}_(\\d+)__`);
      let buf = "";
      let greeted = false;
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let sent = false;
      const frame = (data: string) => `0:${Buffer.byteLength(data)}:${data}`;
      const done = (r: ExecResult | Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          // already closed
        }
        r instanceof Error ? reject(r) : resolve(r);
      };
      const result = (timedOut: boolean): ExecResult => {
        const text = clean(buf);
        const start = text.indexOf(START);
        const body = start >= 0 ? text.slice(start + START.length).replace(/^\n/, "") : "";
        const m = END.exec(body);
        const out = (m ? body.slice(0, m.index) : body).replace(/\n+$/, "");
        const c = cut(out);
        return { exitCode: m ? Number(m[1]) : null, output: c.output, timedOut, truncated: c.truncated || buf.length >= COLLECT_MAX };
      };
      const send = () => {
        if (sent) return;
        sent = true;
        const b64 = Buffer.from(script, "utf8").toString("base64");
        // The markers are built by the shell, so the typed line never contains them literally (a terminal that echoes can't confuse the parse).
        const line =
          `stty -echo 2>/dev/null; printf '__EPC_%s_%s__\\n' S ${nonce}; printf %s ${b64} | base64 -d | sh 2>&1; printf '\\n__EPC_%s_%s_%s__\\n' E ${nonce} "$?"\n`;
        ws.send(frame(line));
      };
      timer = setTimeout(() => {
        try {
          ws.send(frame("\u0003"));
        } catch {
          // closed
        }
        done(result(true));
      }, timeoutMs);
      ws.on("open", () => ws.send(target.handshake));
      ws.on("error", (e) => done(new Error(`Couldn't reach that machine's terminal (${(e as NodeJS.ErrnoException).code ?? e.message}).`)));
      ws.on("close", () => done(buf.includes(START) ? result(false) : new Error("The terminal closed before the command ran.")));
      ws.on("message", (data) => {
        const text = data.toString();
        if (!greeted) {
          greeted = true;
          if (!text.startsWith("OK")) return done(new Error(/permission|forbidden|denied/i.test(text) ? "Your Proxmox account can't open a terminal on that machine (it needs VM.Console)." : "Proxmox refused the terminal session."));
          // The shell may still be starting; a newline wakes the prompt, then the command goes in.
          ws.send(frame("\n"));
          setTimeout(send, 400);
          const rest = text.slice(2);
          if (rest) buf += rest;
          return;
        }
        if (buf.length < COLLECT_MAX) buf += text;
        const seen = clean(buf);
        if (!seen.includes(START) && /(^|\n)[^\n]{0,60}login:\s*$/.test(seen)) return done(new Error("That container's console asks for a login, so a command can't be run in it. Give it no root password, or turn on console autologin."));
        if (!sent) return;
        if (END.test(seen.slice(seen.indexOf(START) >= 0 ? seen.indexOf(START) : seen.length))) done(result(false));
      });
    }, reject);
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
