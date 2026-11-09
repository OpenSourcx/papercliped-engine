/**
 * Explains why an LXC container task failed, in plain words with an exact fix.
 *
 * Proxmox reports a failed `pct start` as a task whose exit status is something like "startup for container '104' failed"
 * and whose log ends with LXC's own generic lines:
 *
 *   sync_wait: 34 An error occurred in another process (expected sequence number 7)
 *   __lxc_start: 2288 Failed to spawn container "104"
 *
 * Those lines only say that the container's init process died. The real reason is in the lines before them, in the host's
 * journal (AppArmor denials, cgroup and namespace errors) or in LXC's debug log, which the API does not serve. This module
 * matches the evidence we can read against the known causes and, when nothing matches, says so and lists the checks in the
 * order they usually pay off. It never claims a cause it did not see.
 *
 * Pure: no network, no clock. A copy lives in plugins/proxmox-sandbox/src/lxc-diagnose.ts (a standalone package) and a test
 * keeps the two identical.
 */

export interface LxcDiagnosis {
  /** Stable id of the matched cause, or "unknown-start-failure" / "unknown". */
  id: string;
  title: string;
  /** One or two sentences, no jargon beyond the names an administrator would type. */
  plain: string;
  /** Exact things to do, in order. Commands run on the Proxmox host as root. */
  fix: string[];
  /** The log and journal lines that led here (redacted), at most 25. */
  evidence: string[];
  /** "matched" when a known pattern was found in the evidence; "generic" when only LXC's generic failure was. */
  confidence: "matched" | "generic";
}

export interface LxcDiagnoseInput {
  /** The task's exit status, e.g. "startup for container '104' failed". */
  exitstatus?: string;
  /** The task log lines (text only). */
  log: string[];
  /** Host journal lines around the failure (optional). */
  journal?: string[];
  vmid?: number;
  /** The container's config as Proxmox returns it (optional). */
  config?: Record<string, unknown>;
  /** The storage holding its disk (optional). */
  storage?: { name?: string; type?: string; active?: boolean; availBytes?: number };
  /** Result of starting the same container with no container features, when that was tried: true = it started. */
  startsWithoutFeatures?: boolean;
  /**
   * The host's processor architecture ("amd64" or "arm64"), when known. Proxmox's create task log records the template's
   * own architecture ("Detected container architecture: arm64"); comparing the two turns an otherwise generic init death
   * into a certain cause.
   */
  hostArch?: string;
}

interface Rule {
  id: string;
  title: string;
  re: RegExp;
  plain: (m: RegExpExecArray, i: LxcDiagnoseInput) => string;
  fix: (m: RegExpExecArray, i: LxcDiagnoseInput) => string[];
}

const ct = (i: LxcDiagnoseInput) => (i.vmid !== undefined ? String(i.vmid) : "<vmid>");
const store = (i: LxcDiagnoseInput) => i.storage?.name ?? "<storage>";

/** Ordered: the first rule whose pattern is found wins, so the specific ones come before the broad ones. */
const RULES: Rule[] = [
  {
    id: "template-missing",
    title: "The container template file is missing",
    re: /(?:volume [^\n]* does not exist|no such file or directory[^\n]*(?:vztmpl|\.tar\.(?:zst|gz|xz))|unable to open (?:archive|file)[^\n]*(?:vztmpl|\.tar\.))/i,
    plain: () => "Proxmox could not find the base operating-system template it was told to build the container from.",
    fix: () => ["Run setup again: it downloads the template again.", "Or on the host: pveam update && pveam download <template storage> debian-12-standard_12.7-1_amd64.tar.zst"],
  },
  {
    id: "template-corrupt",
    title: "The downloaded container template is damaged",
    re: /(?:unexpected end of file|zstd: [^\n]*(?:corrupt|unknown header|read error|unsupported format)|not in gzip format|tar: [^\n]*(?:error is not recoverable|unexpected eof)|bad (?:archive|checksum)|checksum (?:verification )?(?:failed|mismatch)|sha512sum[^\n]*(?:mismatch|differs)|unable to detect os distribution)/i,
    plain: () => "The base template on this host is incomplete or damaged (an interrupted download or a full disk), so the container's files could not be unpacked.",
    fix: () => ["Setup removes the damaged file and downloads it again on its own. If it keeps happening, the template storage is full or unreliable: check 'df -h' for that storage.", "By hand: pveam remove <template storage>:vztmpl/<file> && pveam download <template storage> <file>"],
  },
  {
    id: "wrong-architecture",
    title: "The template is for a different processor type",
    re: /(?:exec format error|cannot execute binary file|invalid elf|wrong elf class|unsupported architecture|failed to execute[^\n]*init[^\n]*(?:no such file|exec format)|qemu-[a-z0-9_-]+-static)/i,
    plain: () => "The container's programs were built for a different CPU architecture than this Proxmox host (for example an arm64 template on an amd64 host).",
    fix: () => ["Use a template that matches the host: 'dpkg --print-architecture' on the host, then choose the *_amd64 or *_arm64 Debian template with the same suffix.", "Remove the wrong template from the template storage and run setup again."],
  },
  {
    id: "no-space",
    title: "The storage is full",
    re: /(?:no space left on device|storage '?[\w.-]+'? is full|not enough (?:free )?space|thin pool[^\n]*(?:full|out of (?:data )?space)|quota exceeded|disk quota)/i,
    plain: (_m, i) => `The storage for container disks${i.storage?.name ? ` ("${i.storage.name}")` : ""} has no room left, so the container's disk could not be set up.`,
    fix: (_m, i) => [`Free space on ${store(i)} (Datacenter, Storage, then ${store(i)}), or choose a storage with more room in Agent containers.`, "Thin-provisioned LVM: 'lvs' shows Data% and Meta%; 100% means the pool is full."],
  },
  {
    id: "storage-unavailable",
    title: "The storage is not available",
    re: /(?:storage '?([\w.-]+)'? is not online|can't activate storage|unable to activate storage|storage '?[\w.-]+'? (?:does not exist|is disabled|not available)|activating (?:LV|storage) [^\n]*failed|can't mount|mount error)/i,
    plain: (m, i) => `The storage "${m[1] ?? store(i)}" is not online on this node (an unmounted drive, a network share that is down, or a disabled storage).`,
    fix: (m, i) => [`Check it: 'pvesm status' on the host. "${m[1] ?? store(i)}" must say active.`, "If it is a drive or share, mount it ('mount -a'), then run setup again."],
  },
  {
    id: "storage-ownership",
    title: "The storage does not allow unprivileged containers",
    re: /(?:(?:chown|lchown|fchown|setfacl|setxattr|mknod)[^\n]*(?:operation not permitted|permission denied|not supported)|(?:operation not permitted|operation not supported)[^\n]*(?:chown|xattr|mknod)|failed to (?:change|set) owner|read-only file system)/i,
    plain: (_m, i) =>
      `The filesystem behind ${i.storage?.name ? `"${i.storage.name}"` : "the container storage"}${i.storage?.type ? ` (${i.storage.type})` : ""} refused to give files to the container's mapped owner. An unprivileged container's files belong to uid 100000 and up, which needs a filesystem that supports ownership, permissions and extended attributes.`,
    fix: (_m, i) => [
      "Use a storage on ext4, xfs, btrfs, ZFS or LVM. NTFS, exFAT, FAT, and network shares that squash root (NFS root_squash, CIFS without uid/gid mapping) cannot hold unprivileged containers.",
      "A drive added as 'directory' storage: on the host run 'findmnt -T <its path>' and check FSTYPE is not ntfs, exfat, vfat or fuseblk, and that the options do not include ro, noexec or nodev.",
      `Choose a different Container storage in Agent containers and run setup again (current: ${store(i)}).`,
    ],
  },
  {
    id: "mount-denied",
    title: "The host refused to mount the container's disk",
    re: /(?:failed to mount[^\n]*(?:permission denied|operation not permitted|invalid argument)|mount: [^\n]*(?:permission denied|wrong fs type|bad superblock)|failed to (?:mount|setup) (?:rootfs|root)|(?:noexec|nodev|nosuid)[^\n]*mount)/i,
    plain: (_m, i) => `Mounting the container's root disk from ${store(i)} failed. Usually the drive is mounted noexec/nodev, or its filesystem is damaged or not supported for containers.`,
    fix: (_m, i) => [`On the host: 'findmnt -T <path of ${store(i)}>'. Remount without noexec/nodev (edit /etc/fstab, then 'mount -o remount <mountpoint>').`, "A damaged filesystem: run 'fsck' on it while it is unmounted."],
  },
  {
    id: "idmap",
    title: "The host has no user-id range for unprivileged containers",
    re: /(?:newuidmap|newgidmap|\/etc\/sub[ug]id|failed to (?:write|set|setup|create) (?:the )?(?:uid|gid|id)[ _-]?map|lxc_map_ids|invalid argument - [^\n]*id.?map|idmap)/i,
    plain: () => "Unprivileged containers run as user ids 100000 to 165535 on the host. This host has no such range reserved for root, or a custom lxc.idmap clashes with it.",
    fix: () => ["On the host, both of these files must contain the line 'root:100000:65536': cat /etc/subuid /etc/subgid", "If a line is missing: echo 'root:100000:65536' >> /etc/subuid && echo 'root:100000:65536' >> /etc/subgid", "Remove any hand-written 'lxc.idmap' lines from /etc/pve/lxc/<vmid>.conf."],
  },
  {
    id: "apparmor",
    title: "AppArmor blocked the container",
    re: /(?:apparmor[^\n]*(?:denied|failed|error|profile|not (?:enabled|loaded))|apparmor_parser|failed to (?:load|change|set) [^\n]*apparmor|lxc-container-default[^\n]*(?:denied|failed))/i,
    plain: () => "The host's AppArmor security profile for containers is missing, failed to load, or denied something the container needs (often when the Proxmox host is itself inside a container or VM).",
    fix: () => ["On the host: journalctl -k | grep -i apparmor | tail -20 shows the denied operation.", "Reload the profiles: systemctl restart apparmor, then run setup again.", "A Proxmox host that is itself an LXC container cannot run nested containers without nesting and AppArmor unconfined on the outer container; run Proxmox on bare metal or in a VM."],
  },
  {
    id: "cgroup",
    title: "The host's control groups are not usable for containers",
    re: /(?:cgroup[^\n]*(?:no such file|permission denied|read-only|not (?:mounted|available|writable)|failed|invalid|unavailable|operation not permitted)|failed to (?:create|mount|find|enable|setup)[^\n]*cgroup|cgfsng|\/sys\/fs\/cgroup[^\n]*(?:denied|failed)|lxc_cgroup)/i,
    plain: () => "LXC could not create a control group for the container. The host's cgroup filesystem is missing, read-only, or not delegated to LXC.",
    fix: () => ["On the host: 'stat -fc %T /sys/fs/cgroup' should print cgroup2fs; 'ls /sys/fs/cgroup' should list cgroup.controllers.", "If the kernel command line forces cgroup v1 ('systemd.unified_cgroup_hierarchy=0'), remove it and reboot.", "Read the pre-start hook output: /usr/share/lxc/hooks/lxc-pve-prestart-hook <vmid> lxc pre-start"],
  },
  {
    id: "namespaces",
    title: "The kernel refused to create the container's namespaces",
    re: /(?:cannot allocate memory[^\n]*(?:clone|namespace)|failed to clone|clone3?\b[^\n]*(?:operation not permitted|invalid argument)|clone_newuser|max_user_namespaces|unprivileged_userns|unshare[^\n]*operation not permitted|user namespaces? (?:are )?(?:disabled|not (?:supported|enabled)))/i,
    plain: () => "The kernel would not create a new user or process namespace for the container: namespaces are disabled, a per-user limit is exhausted, or the host is out of memory.",
    fix: () => ["On the host: sysctl user.max_user_namespaces (a large number, not 0) and sysctl kernel.unprivileged_userns_clone if present (should be 1).", "Check memory: free -m. A host with no free memory fails here.", "Proxmox inside a container or restricted VM: user namespaces must be allowed by the outer layer."],
  },
  {
    id: "features",
    title: "A container feature the host does not allow",
    re: /(?:keyctl|failed to mount ["']?(?:proc|sysfs|sys|devpts|tmpfs)["']?|permission denied - [^\n]*mount[^\n]*(?:proc|sys)|seccomp[^\n]*(?:failed|invalid|error)|failed to (?:load|setup) seccomp|lxc\.cap\.(?:drop|keep)|failed to (?:drop|keep) capabilit)/i,
    plain: (_m, i) => `The container could not set up its /proc, /sys or security filters${i.config?.features ? ` with features "${String(i.config.features)}"` : ""}. The agent template asks for nesting so that systemd works; some hosts refuse that.`,
    fix: () => ["Look for the denied operation in the host journal: journalctl -k -b | grep -iE 'apparmor|seccomp|audit' | tail -30", "If the host is an LXC container or a restricted VM, enable nesting on the outer layer."],
  },
  {
    id: "network",
    title: "The network bridge could not be attached",
    re: /(?:bridge[^\n]*(?:does not exist|not found|doesn't exist|is down|no such device)|no such device[^\n]*(?:vmbr|veth|fwbr|tap)|failed to (?:create|attach|move)[^\n]*(?:veth|bridge|netdev)|can't (?:bring up|create)[^\n]*(?:veth|fwpr|fwln)|network '?[\w.-]+'? not (?:found|configured)|lxc_network|setup_network)/i,
    plain: (_m, i) => `Proxmox could not plug the container into the network bridge${i.config?.net0 ? ` (${String(i.config.net0)})` : ""}. The bridge is missing, down, or the firewall bridge could not be built.`,
    fix: () => ["On the host: ip -br link show type bridge. The bridge chosen in Agent containers must be listed and UP.", "After editing /etc/network/interfaces apply it in the Proxmox UI (Node, Network, Apply configuration) or run 'ifreload -a'.", "If the Proxmox firewall is enabled for this container, check 'systemctl status pve-firewall'."],
  },
  {
    id: "devices",
    title: "A device the container needs is unavailable",
    re: /(?:\/dev\/(?:fuse|net\/tun|pts|ptmx|console)[^\n]*(?:no such|denied|failed|not permitted)|failed to (?:create|setup|mount)[^\n]*(?:\/dev|devpts|console)|setup_(?:dev|console|pts)|lxc_setup_devpts|failed to allocate (?:a )?pty)/i,
    plain: () => "The container could not create its /dev entries or console (devpts), usually because the host's devpts or console settings are restricted.",
    fix: () => ["On the host: mount | grep devpts should show devpts mounted with ptmxmode=666 or newinstance.", "Check dmesg | tail -30 for denied device operations."],
  },
  {
    id: "locked",
    title: "Another task is already working on this container",
    re: /(?:can't lock file|got lock timeout|trying to acquire (?:cfs )?lock|ct is locked|is locked \(|lock-timeout|container is already running)/i,
    plain: () => "Proxmox has this container locked because another task (a previous start, backup or snapshot) is still running or was interrupted.",
    fix: (_m, i) => [`On the host: pct list shows the lock; if no task is really running, clear it with: pct unlock ${ct(i)}`, "Node, Tasks in the Proxmox UI lists the running task."],
  },
  {
    id: "no-init",
    title: "The container has no working init program",
    re: /(?:failed to exec[^\n]*(?:\/sbin\/init|init)|no such file or directory[^\n]*\/sbin\/init|unable to find init|failed to execute init|\/sbin\/init[^\n]*not found)/i,
    plain: () => "The container started but there is no init program to run: the root disk is empty or the template was unpacked incompletely.",
    fix: (_m, i) => [`On the host: pct mount ${ct(i)} && ls /var/lib/lxc/${ct(i)}/rootfs/sbin/init ; pct unmount ${ct(i)}`, "If it is empty, remove the template file and run setup again so it is downloaded and unpacked afresh."],
  },
  {
    id: "memory",
    title: "The host ran out of memory",
    re: /(?:out of memory|oom[- ]kill|memory cgroup out of memory|killed process)/i,
    plain: () => "The container was killed or could not start because the host ran out of memory.",
    fix: () => ["On the host: free -m. Stop something, or lower the container memory in Agent containers."],
  },
  {
    id: "pre-start-hook",
    title: "Proxmox's pre-start check failed",
    re: /(?:lxc\.hook\.pre-start|lxc-pve-prestart-hook|run_buffer: \d+ script exited with status)/i,
    plain: () => "Proxmox runs a preparation script before the container starts, and it failed. Its message is in the lines above this one.",
    fix: (_m, i) => [`Run the hook by hand to see the message: /usr/share/lxc/hooks/lxc-pve-prestart-hook ${ct(i)} lxc pre-start`, "It mounts the root disk; errors about the storage or filesystem point at the storage, not at ePaperclip."],
  },
];

const GENERIC = /(?:sync_wait[^\n]*(?:expected sequence number|an error occurred in another process)|failed to spawn container|__lxc_start|startup for container [^\n]*failed|lxc_spawn|lxc_init)/i;

/** Lines worth keeping as evidence: the whole log when short, else the tail plus every line that looks like an error. */
function pickEvidence(lines: string[], rule?: RegExp): string[] {
  const clean = lines.map((l) => l.trimEnd()).filter(Boolean);
  if (clean.length <= 25) return clean;
  const keep = new Set<number>();
  clean.forEach((l, i) => {
    if (rule?.test(l) || GENERIC.test(l) || /error|fail|denied|refus|cannot|can't|unable/i.test(l) || i >= clean.length - 8) keep.add(i);
  });
  return [...keep].sort((a, b) => a - b).slice(-25).map((i) => clean[i]);
}

/** Journal lines that can belong to a failed container start: kernel security and cgroup messages, LXC, and this vmid. */
export function relevantJournal(lines: string[], vmid?: number): string[] {
  const id = vmid !== undefined ? new RegExp(`(?:\\b${vmid}\\b|pve-container@${vmid})`) : null;
  return lines.filter((l) => /apparmor|audit|seccomp|cgroup|lxc|pve-container|veth|fwbr|vmbr|oom|segfault|kernel:/i.test(l) && (!id || id.test(l) || /apparmor|audit|seccomp|cgroup|oom/i.test(l)));
}

/**
 * Lines that carry secrets or sessions are masked before anything is shown or stored: token secrets (`user@realm!name=uuid`),
 * Proxmox cookies and CSRF tokens, Authorization headers, PEM private keys, and `password`/`secret`/`ticket` assignments.
 */
export function redactLines(lines: string[]): string[] {
  let inKey = false;
  return lines.map((raw) => {
    let l = raw;
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(l)) inKey = true;
    if (inKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(l)) inKey = false;
      return "[private key removed]";
    }
    l = l.replace(/([\w.-]+@[\w.-]+![\w.-]+)=[0-9a-f-]{8,}/gi, "$1=[removed]");
    l = l.replace(/(PVEAPIToken=[^\s=]+=)\S+/gi, "$1[removed]");
    l = l.replace(/(PVEAuthCookie|CSRFPreventionToken|Authorization)(\s*[:=]\s*)\S+(?:\s+\S+)?/gi, "$1$2[removed]");
    l = l.replace(/\b(password|passwd|secret|ticket|token|api[_-]?key)(\s*[:=]\s*)(?!\[removed\])\S+/gi, "$1$2[removed]");
    l = l.replace(/\bssh-(?:ed25519|rsa) [A-Za-z0-9+/=]{40,}/g, "ssh-key [removed]");
    return l;
  });
}

/** The architecture of the process reading the log, when it runs on the Proxmox node itself. "" when it cannot be told. */
function processArch(): string {
  const a = (globalThis as { process?: { arch?: string } }).process?.arch;
  return a === "arm64" ? "arm64" : a === "x64" ? "amd64" : "";
}

export function diagnoseLxc(input: LxcDiagnoseInput): LxcDiagnosis {
  const log = redactLines(input.log);
  const journal = redactLines(relevantJournal(input.journal ?? [], input.vmid));
  const all = [...log, ...journal];
  const text = all.join("\n");
  // A template for another processor is a certain cause when both architectures are written in the log Proxmox produced
  // while unpacking it ("Detected container architecture: arm64" on an amd64 host). Checked first: every later rule would
  // otherwise report the generic init death.
  const detected = /Detected container architecture:\s*(amd64|arm64)/i.exec(text)?.[1]?.toLowerCase();
  const wantArch = (input.hostArch ?? processArch()).toLowerCase();
  if (detected && wantArch && detected !== wantArch) {
    return {
      id: "template-arch-mismatch",
      title: "The template is for a different processor",
      plain: `Proxmox unpacked a template built for ${detected}, but this host is ${wantArch}. Its /sbin/init cannot run here, so the container's first process dies before the system starts. This is why the container fails even though the storage, permissions and nesting are fine.`,
      fix: [
        `Use the ${wantArch} Debian template. ePaperclip now picks the template that matches this host automatically; run setup again so it rebuilds the template from the right one.`,
        `The wrong template file can be removed: pveam remove ${input.storage?.name ?? "<template storage>"}:vztmpl/<the ${detected} file>`,
      ],
      evidence: pickEvidence(all, /Detected container architecture|exec format error|Failed to spawn|sync_wait/i),
      confidence: "matched",
    };
  }
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (m) return { id: r.id, title: r.title, plain: r.plain(m, input), fix: r.fix(m, input), evidence: pickEvidence(all, r.re), confidence: "matched" };
  }
  // A probe result beats the generic text.
  if (input.startsWithoutFeatures === true && /nesting|keyctl/.test(String(input.config?.features ?? ""))) {
    return {
      id: "features-blocked",
      title: "This host does not allow container nesting",
      plain: `The container starts when its features (${String(input.config?.features)}) are removed and fails with them, so the host refuses nesting for unprivileged containers.`,
      fix: ["Look for the denied operation: journalctl -k -b | grep -iE 'apparmor|audit' | tail -30", "If Proxmox itself runs inside a container or VM, enable nesting on the outer layer; on bare metal make sure AppArmor is healthy: systemctl status apparmor"],
      evidence: pickEvidence(all),
      confidence: "matched",
    };
  }
  const seq = /expected sequence number (\d+)/i.exec(text)?.[1];
  if (GENERIC.test(text) || /startup for container/i.test(input.exitstatus ?? "")) {
    const s = input.storage;
    const hints: string[] = [];
    if (s?.type && /^(dir|nfs|cifs|glusterfs|cephfs|ntfs)$/i.test(s.type)) hints.push(`The container disk is on ${s.type} storage "${s.name ?? ""}". Check the drive's filesystem and mount options on the host: findmnt -T <its path> (it must not be ntfs/exfat/vfat, nor mounted noexec/nodev/ro).`);
    if (s?.active === false) hints.push(`Storage "${s.name ?? ""}" is not active; run 'pvesm status'.`);
    if (typeof s?.availBytes === "number" && s.availBytes < 2 * 1024 ** 3) hints.push(`Storage "${s.name ?? ""}" has only ${(s.availBytes / 1024 ** 3).toFixed(1)} GiB free.`);
    if (input.startsWithoutFeatures === false) hints.push("Starting it without any container features failed the same way, so nesting is not the cause.");
    return {
      id: "unknown-start-failure",
      title: "The container's init process died while starting",
      plain: `LXC reports that the container's first process failed${seq ? ` at step ${seq}` : ""}, but Proxmox's task log does not say why: the reason is in LXC's own debug log on the host. Nothing in the task log or the host journal matched a known cause.${hints.length ? " " + hints.join(" ") : ""}`,
      fix: [
        `On the host, run LXC in the foreground with debug output and read the first ERROR line: lxc-start -n ${ct(input)} -F -l DEBUG -o /tmp/lxc-${ct(input)}.log ; grep -E 'ERROR|WARN' /tmp/lxc-${ct(input)}.log | head -30`,
        `Proxmox's own task log: ls -t /var/log/pve/tasks/*/*:vzstart:${ct(input)}:* | head -1 | xargs cat ; and the journal: journalctl -b -u pve-container@${ct(input)} ; journalctl -k -b | tail -50`,
        "The usual causes, in order: (1) the drive behind the storage is ntfs/exfat or mounted noexec/nodev; (2) /etc/subuid and /etc/subgid lack 'root:100000:65536'; (3) AppArmor or cgroup problems when Proxmox runs inside a container or VM; (4) a wrong-architecture or damaged template; (5) a full or inactive storage.",
        "ePaperclip cannot read LXC's debug log through the Proxmox API; the lxc-start command above is the way to see the real error.",
      ],
      evidence: pickEvidence(all),
      confidence: "generic",
    };
  }
  return {
    id: "unknown",
    title: "Proxmox did not say why",
    plain: `The task ended with "${input.exitstatus ?? "an error"}" and its log held no known cause.`,
    fix: ["Open the task in the Proxmox UI (Node, Tasks) and read the full log.", "On the host: journalctl -b | tail -100"],
    evidence: pickEvidence(all),
    confidence: "generic",
  };
}

/** One paragraph for an error line: what happened and the first thing to do. */
export function summarizeDiagnosis(d: LxcDiagnosis): string {
  return `${d.title}. ${d.plain}${d.fix[0] ? ` Fix: ${d.fix[0]}` : ""}`;
}
