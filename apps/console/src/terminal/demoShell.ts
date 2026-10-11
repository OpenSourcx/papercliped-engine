/**
 * A simulated shell for the demo console. It answers common commands from the machine's demo data so the Console tab
 * can be tried without a host. The real console uses the same TerminalTransport interface over Proxmox's terminal
 * proxy (see transport.ts); nothing here runs on a real machine.
 */

export interface ShellMachine {
  kind: "lxc" | "qemu" | "host";
  name: string;
  os: string;
  ip: string | null;
  cores: number;
  memUsed: number;
  memMax: number;
  diskMax: number;
  uptimeSec: number;
}

export type ShellResult = { out: string; clear?: boolean; exit?: boolean };

const GiB = 1024 ** 3;
const human = (b: number) => (b >= GiB ? `${(b / GiB).toFixed(1)}G` : `${Math.round(b / 1024 ** 2)}M`);

const FS: Record<string, string[]> = {
  "/": ["bin", "boot", "dev", "etc", "home", "opt", "proc", "root", "srv", "tmp", "usr", "var"],
  "/root": ["paperclip-workspace", ".bashrc", ".profile"],
  "/root/paperclip-workspace": ["README.md", "package.json", "src"],
  "/etc": ["hostname", "hosts", "os-release", "resolv.conf"],
  "/var": ["lib", "log", "tmp"],
};

export const COMMANDS = ["help", "ls", "cd", "pwd", "whoami", "hostname", "uname", "uptime", "free", "df", "cat", "ip", "ps", "top", "echo", "date", "clear", "history", "exit", "apt", "systemctl", "nproc"];

export class DemoShell {
  cwd = "/root";
  readonly history: string[] = [];
  readonly m: ShellMachine;
  constructor(m: ShellMachine) {
    this.m = m;
  }

  get hostname() {
    return this.m.name;
  }

  prompt(): string {
    const dir = this.cwd === "/root" ? "~" : this.cwd.replace(/^\/root/, "~");
    return `\x1b[1;32mroot@${this.hostname}\x1b[0m:\x1b[1;34m${dir}\x1b[0m# `;
  }

  banner(): string {
    const what = this.m.kind === "host" ? "Proxmox VE host shell" : this.m.kind === "qemu" ? "virtual machine console" : "container console";
    return [
      `\x1b[38;5;179mePaperclip\x1b[0m ${what} · ${this.m.name}`,
      `\x1b[2mDemo shell: commands answer from demo data. Type 'help' for what works.\x1b[0m`,
      "",
    ].join("\r\n");
  }

  private resolve(path: string): string {
    if (!path || path === "~") return "/root";
    const base = path.startsWith("/") ? [] : this.cwd.split("/").filter(Boolean);
    for (const part of path.replace(/^~/, "/root").split("/").filter(Boolean)) {
      if (part === "..") base.pop();
      else if (part !== ".") base.push(part);
    }
    return "/" + base.join("/");
  }

  run(line: string): ShellResult {
    const input = line.trim();
    if (!input) return { out: "" };
    this.history.push(input);
    const [cmd, ...args] = input.split(/\s+/);
    const m = this.m;
    const uptime = () => {
      const d = Math.floor(m.uptimeSec / 86400), h = Math.floor((m.uptimeSec % 86400) / 3600), min = Math.floor((m.uptimeSec % 3600) / 60);
      return `up ${d ? `${d} day${d > 1 ? "s" : ""}, ` : ""}${h}:${String(min).padStart(2, "0")}`;
    };
    switch (cmd) {
      case "help":
        return { out: `Available in the demo shell:\r\n  ${COMMANDS.join("  ")}` };
      case "clear":
        return { out: "", clear: true };
      case "exit":
      case "logout":
        return { out: "logout", exit: true };
      case "pwd":
        return { out: this.cwd };
      case "whoami":
        return { out: "root" };
      case "hostname":
        return { out: this.hostname };
      case "nproc":
        return { out: String(m.cores) };
      case "uname":
        return { out: args.includes("-a") ? `Linux ${this.hostname} 6.18.0-pve #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux` : "Linux" };
      case "date":
        return { out: new Date().toString() };
      case "uptime":
        return { out: ` ${new Date().toTimeString().slice(0, 8)} ${uptime()},  1 user,  load average: 0.08, 0.12, 0.10` };
      case "echo":
        return { out: args.join(" ").replace(/^["']|["']$/g, "") };
      case "history":
        return { out: this.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join("\r\n") };
      case "cd": {
        const target = this.resolve(args[0] ?? "~");
        if (!FS[target]) return { out: `bash: cd: ${args[0]}: No such file or directory` };
        this.cwd = target;
        return { out: "" };
      }
      case "ls": {
        const path = this.resolve(args.find((a) => !a.startsWith("-")) ?? ".");
        const entries = FS[path];
        if (!entries) return { out: `ls: cannot access '${path}': No such file or directory` };
        const shown = args.some((a) => a.includes("a")) ? entries : entries.filter((e) => !e.startsWith("."));
        if (args.some((a) => a.startsWith("-") && a.includes("l"))) return { out: shown.map((e) => `${FS[`${path === "/" ? "" : path}/${e}`] ? "drwxr-xr-x" : "-rw-r--r--"} 1 root root  4096 Oct 11 09:12 ${e}`).join("\r\n") };
        return { out: shown.map((e) => (FS[`${path === "/" ? "" : path}/${e}`] ? `\x1b[1;34m${e}\x1b[0m` : e)).join("  ") };
      }
      case "cat": {
        const f = this.resolve(args[0] ?? "");
        if (f === "/etc/hostname") return { out: this.hostname };
        if (f === "/etc/os-release") return { out: `PRETTY_NAME="${m.os}"\r\nNAME="${m.os.split(" ")[0]}"\r\nID=${m.os.split(" ")[0].toLowerCase()}` };
        if (f.endsWith("README.md")) return { out: "# paperclip-workspace\r\nAgent workspace synced by ePaperclip." };
        return { out: `cat: ${args[0] ?? ""}: No such file or directory` };
      }
      case "free":
        return { out: `               total        used        free\r\nMem:           ${human(m.memMax).padStart(5)}       ${human(m.memUsed).padStart(5)}       ${human(m.memMax - m.memUsed).padStart(5)}\r\nSwap:             0B          0B          0B` };
      case "df":
        return { out: `Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/root       ${human(m.diskMax).padStart(4)}  ${human(m.diskMax * 0.31).padStart(4)}  ${human(m.diskMax * 0.69).padStart(4)}  31% /` };
      case "ip":
        return { out: `1: lo: <LOOPBACK,UP> mtu 65536\r\n    inet 127.0.0.1/8 scope host lo\r\n2: eth0: <BROADCAST,MULTICAST,UP> mtu 1500\r\n    inet ${m.ip ?? "10.10.0.2"}/24 scope global eth0` };
      case "ps":
      case "top":
        return { out: `  PID USER     %CPU %MEM COMMAND\r\n    1 root      0.0  0.3 /sbin/init\r\n   88 root      0.0  0.2 /lib/systemd/systemd-journald\r\n  412 root      0.3  1.1 sshd\r\n  903 root      ${(Math.random() * 8 + 1).toFixed(1)}  6.4 node /usr/bin/paperclip-runner` };
      case "systemctl":
        return { out: args[0] === "status" ? `● ${args[1] ?? "system"} - active (running)` : "Usage: systemctl status <unit>" };
      case "apt":
      case "apt-get":
        return { out: args[0] === "update" ? "Hit:1 http://deb.debian.org/debian trixie InRelease\r\nReading package lists... Done\r\nAll packages are up to date." : "The demo shell can't install packages." };
      case "sudo":
        return { out: "You are already root." };
      case "vim":
      case "vi":
      case "nano":
      case "htop":
        return { out: `${cmd}: full-screen programs need the live console, not the demo shell.` };
      default:
        return { out: `bash: ${cmd}: command not found` };
    }
  }

  complete(partial: string): string[] {
    const words = partial.split(/\s+/);
    if (words.length <= 1) return COMMANDS.filter((c) => c.startsWith(words[0] ?? ""));
    const last = words[words.length - 1];
    const dir = this.resolve(last.includes("/") ? last.slice(0, last.lastIndexOf("/") + 1) || "/" : ".");
    const prefix = last.includes("/") ? last.slice(last.lastIndexOf("/") + 1) : last;
    return (FS[dir] ?? []).filter((e) => e.startsWith(prefix)).map((e) => words.slice(0, -1).concat((last.includes("/") ? last.slice(0, last.lastIndexOf("/") + 1) : "") + e).join(" "));
  }
}
