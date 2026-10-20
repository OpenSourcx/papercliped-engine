import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { release as osRelease } from "node:os";
import { kernelNewer } from "./nodeSystem.ts";
import type { PinRuntime } from "./pin-core.ts";

/**
 * The Proxmox side of "does this device need a restart, and what changed": read from the host itself, with no Proxmox
 * credentials, so it can also run in the background. A new kernel is only used after a reboot, so the kernel that is
 * running (what the operating system reports) is compared with the newest one installed (/lib/modules). Package history
 * is Debian's own log of every apt run (/var/log/apt/history.log); it is only read, never changed.
 *
 * Proxmox package upgrades themselves are not run from here. Proxmox has no API for an upgrade, and an unattended
 * `dist-upgrade` on a hypervisor can restart services under running machines, so it is done in a shell the person opens
 * from the console, with the backup warning first.
 */

export interface Kernel {
  running: string | null;
  newestInstalled: string | null;
  rebootRequired: boolean;
}

const PVE_KERNEL = /^(\d+\.\d+\.\d+-\d+-pve)$/;
const files = (rt: PinRuntime) => ({
  modules: rt.opts.update?.modulesDir ?? "/lib/modules",
  history: rt.opts.update?.aptHistory ?? "/var/log/apt/history.log",
  release: rt.opts.update?.kernelRelease ?? osRelease(),
});

export function kernelState(rt: PinRuntime): Kernel {
  const f = files(rt);
  const running = PVE_KERNEL.exec(f.release.replace(/^(\d+\.\d+\.\d+-\d+-pve).*$/, "$1"))?.[1] ?? null;
  let newest: string | null = null;
  try {
    for (const d of readdirSync(f.modules)) if (PVE_KERNEL.test(d) && (!newest || kernelNewer(d, newest))) newest = d;
  } catch {
    /* no module folder to read: nothing to compare */
  }
  return { running: running ?? (f.release || null), newestInstalled: newest, rebootRequired: !!(running && newest && kernelNewer(newest, running)) };
}

export interface AptRun {
  at: number | null;
  command: string;
  upgraded: number;
  installed: number;
  removed: number;
  /** A few package names, for the list. */
  packages: string[];
  kernel: boolean;
}

const MAX_LOG = 2 * 1024 * 1024;

const count = (v: string) => (v ? v.split("),").length : 0);
const names = (v: string) => v.split("),").map((x) => x.trim().split(":")[0].split(" ")[0]).filter(Boolean);

/** Debian's apt history: one block per run, newest first. Runs that changed nothing are left out. */
export function aptHistory(rt: PinRuntime, limit = 30): AptRun[] {
  const f = files(rt);
  let text: string;
  try {
    if (!existsSync(f.history) || statSync(f.history).size > 64 * MAX_LOG) return [];
    text = readFileSync(f.history, "utf8").slice(-MAX_LOG);
  } catch {
    return [];
  }
  const out: AptRun[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const field = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
    const start = field("Start-Date");
    if (!start) continue;
    const up = field("Upgrade");
    const inst = field("Install");
    const rem = field("Remove") || field("Purge");
    if (!up && !inst && !rem) continue;
    const t = Date.parse(start.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/, "$1T$2"));
    const pkgs = [...names(up), ...names(inst)];
    out.push({ at: Number.isNaN(t) ? null : t, command: field("Commandline").slice(0, 120), upgraded: count(up), installed: count(inst), removed: count(rem), packages: pkgs.slice(0, 6), kernel: pkgs.some((p) => /^(?:proxmox|pve)-kernel-\d/.test(p)) });
  }
  return out.reverse().slice(0, limit);
}
