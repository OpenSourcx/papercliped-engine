import { api, ApiError, type SdnState, type GuestHardware, type HardwareChange, type IfaceSpec, type NetIface, type NicSpec, type SnapshotInfo, type BackupJob, type BackupJobSpec, type BackupRun, type RestoreSpec, type CatalogTemplate, type ContentKind, type MachineOptions, type StorageItem, type TaskDetail, type TaskEntry, type UrlDownload, type LibraryLatest } from "./api.ts";
import type { Guest, HostStorage } from "./types.ts";
import { demoNetworkConfig } from "./demoNet.ts";

/**
 * Storage, templates, uploads and tasks: the same calls live (through the host service, as the signed-in user) and in
 * the demo (in this browser), so the screens don't care which one they talk to.
 */
export interface Backend {
  content: (storage: string, kind?: ContentKind) => Promise<StorageItem[]>;
  deleteVolume: (storage: string, volid: string) => Promise<{ task: string | null }>;
  catalog: () => Promise<CatalogTemplate[]>;
  downloadTemplate: (storage: string, template: string) => Promise<{ task: string }>;
  downloadUrl: (storage: string, d: UrlDownload) => Promise<{ task: string }>;
  /** The newest installer a vendor lists for a Library system, with the vendor's checksum. */
  libraryLatest: (id: string) => Promise<LibraryLatest>;
  upload: (storage: string, content: "iso" | "vztmpl", file: File, onProgress: (f: number) => void, signal?: AbortSignal) => Promise<{ task: string }>;
  tasks: (limit?: number, vmid?: number) => Promise<TaskEntry[]>;
  destroyMachine: (vmid: number, confirm: string) => Promise<{ task: string | null }>;
  convertToTemplate: (vmid: number, confirm: string) => Promise<{ task: string | null }>;
  task: (upid: string) => Promise<TaskDetail>;
  machineOptions: () => Promise<MachineOptions>;
  backupJobs: () => Promise<BackupJob[]>;
  saveBackupJob: (id: string | null, spec: BackupJobSpec) => Promise<unknown>;
  toggleBackupJob: (id: string, enabled: boolean) => Promise<unknown>;
  deleteBackupJob: (id: string) => Promise<unknown>;
  runBackup: (r: BackupRun) => Promise<{ task: string }>;
  restore: (r: RestoreSpec) => Promise<{ vmid: number; task: string }>;
  hardware: (vmid: number) => Promise<GuestHardware>;
  setHardware: (vmid: number, c: HardwareChange) => Promise<unknown>;
  resizeDisk: (vmid: number, disk: string, growGb: number) => Promise<{ task: string | null }>;
  saveNic: (vmid: number, n: NicSpec) => Promise<unknown>;
  deleteNic: (vmid: number, key: string) => Promise<unknown>;
  snapshots: (vmid: number) => Promise<{ snapshots: SnapshotInfo[]; current: string | null }>;
  takeSnapshot: (vmid: number, name: string, description: string, vmstate: boolean) => Promise<{ task: string }>;
  rollbackSnapshot: (vmid: number, name: string) => Promise<{ task: string }>;
  deleteSnapshot: (vmid: number, name: string) => Promise<{ task: string }>;
  clone: (vmid: number, name: string, storage: string | null, linked: boolean) => Promise<{ vmid: number; task: string; full: boolean }>;
  network: () => Promise<{ interfaces: NetIface[]; changes: string | null }>;
  saveIface: (existing: string | null, spec: IfaceSpec) => Promise<unknown>;
  deleteIface: (iface: string, confirm?: string) => Promise<unknown>;
  applyNetwork: () => Promise<{ task: string }>;
  revertNetwork: () => Promise<unknown>;
  firewallGet: <T>(scope: string, res: string, sub?: string) => Promise<T>;
  firewallPost: (scope: string, path: string, body?: unknown) => Promise<unknown>;
  dns: () => Promise<{ search: string; servers: string[] }>;
  setDns: (search: string, servers: string[]) => Promise<unknown>;
  hosts: () => Promise<{ data: string; digest: string | null }>;
  setHosts: (data: string, digest: string | null) => Promise<unknown>;
  sdn: () => Promise<SdnState>;
  sdnPost: (path: string, body?: unknown) => Promise<{ ok?: true; task?: string }>;
}

export const liveBackend: Backend = {
  content: api.content,
  deleteVolume: api.deleteVolume,
  catalog: api.catalog,
  downloadTemplate: api.downloadTemplate,
  downloadUrl: api.downloadUrl,
  libraryLatest: api.libraryLatest,
  upload: api.upload,
  tasks: api.tasks,
  destroyMachine: api.destroyMachine,
  convertToTemplate: api.convertToTemplate,
  task: api.task,
  machineOptions: api.machineOptions,
  backupJobs: api.backupJobs,
  saveBackupJob: api.saveBackupJob,
  toggleBackupJob: api.toggleBackupJob,
  deleteBackupJob: api.deleteBackupJob,
  runBackup: api.runBackup,
  restore: api.restore,
  hardware: api.hardware,
  setHardware: api.setHardware,
  resizeDisk: api.resizeDisk,
  saveNic: api.saveNic,
  deleteNic: api.deleteNic,
  snapshots: api.snapshots,
  takeSnapshot: api.takeSnapshot,
  rollbackSnapshot: api.rollbackSnapshot,
  deleteSnapshot: api.deleteSnapshot,
  clone: api.clone,
  network: api.network,
  saveIface: api.saveIface,
  deleteIface: api.deleteIface,
  applyNetwork: api.applyNetwork,
  revertNetwork: api.revertNetwork,
  firewallGet: api.firewallGet,
  firewallPost: api.firewallPost,
  dns: api.dns,
  setDns: api.setDns,
  hosts: api.hosts,
  setHosts: api.setHosts,
  sdn: api.sdn,
  sdnPost: api.sdnPost,
};

/** "vzdump-lxc-101-2025_10_10-21_00_02.tar.zst" -> { type, vmid, at (unix seconds) } */
export function parseBackupName(volid: string): { type: "lxc" | "qemu"; vmid: number; at: number | null } | null {
  const m = volid.match(/vzdump-(lxc|qemu|openvz)-(\d+)-(\d{4})_(\d{2})_(\d{2})-(\d{2})_(\d{2})_(\d{2})/);
  if (!m) return null;
  const at = Date.UTC(+m[3], +m[4] - 1, +m[5], +m[6], +m[7], +m[8]) / 1000;
  return { type: m[1] === "qemu" ? "qemu" : "lxc", vmid: Number(m[2]), at };
}

/** Plain words for a systemd calendar schedule, for the common shapes Proxmox's UI offers. */
export function describeSchedule(s: string | null): string {
  if (!s) return "No schedule";
  const t = s.trim();
  const time = t.match(/^(?:(\*-\*-\*)\s+)?(\d{1,2}):(\d{2})$/);
  if (time) return `Every day at ${time[2].padStart(2, "0")}:${time[3]}`;
  const day = t.match(/^(mon|tue|wed|thu|fri|sat|sun)(?:\.\.(mon|tue|wed|thu|fri|sat|sun))?\s+(\d{1,2}):(\d{2})$/i);
  const names: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
  if (day) {
    const at = `${day[3].padStart(2, "0")}:${day[4]}`;
    if (day[2]) return day[1].toLowerCase() === "mon" && day[2].toLowerCase() === "fri" ? `Weekdays at ${at}` : `${names[day[1].toLowerCase()]} to ${names[day[2].toLowerCase()]} at ${at}`;
    return `Every ${names[day[1].toLowerCase()]} at ${at}`;
  }
  const hourly = t.match(/^(?:\*:00|hourly)$/);
  if (hourly) return "Every hour";
  return t;
}

/** Human names for Proxmox task types, as its task log shows them. */
export const TASK_TYPES: Record<string, string> = {
  download: "Download",
  imgcopy: "Upload",
  aptupdate: "Update package database",
  vzcreate: "Create container",
  vzstart: "Start container",
  vzstop: "Stop container",
  vzshutdown: "Shut down container",
  vzreboot: "Reboot container",
  vzdestroy: "Destroy container",
  vzdump: "Backup",
  vzresize: "Resize disk",
  qmresize: "Resize disk",
  template: "Convert to template",
  qmreset: "Reset VM",
  vzrollback: "Roll back snapshot",
  qmrollback: "Roll back snapshot",
  vzdelsnapshot: "Delete snapshot",
  qmdelsnapshot: "Delete snapshot",
  vzclone: "Clone container",
  qmclone: "Clone VM",
  srvreload: "Apply network changes",
  reloadnetworkall: "Apply SDN changes",
  vzrestore: "Restore container",
  qmrestore: "Restore VM",
  qmcreate: "Create VM",
  qmstart: "Start VM",
  qmstop: "Stop VM",
  qmshutdown: "Shut down VM",
  qmreboot: "Reboot VM",
  qmdestroy: "Destroy VM",
  qmsnapshot: "Snapshot",
  vzsnapshot: "Snapshot",
  imgdel: "Delete file",
  startall: "Start all",
  stopall: "Stop all",
};

export const taskLabel = (t: { type: string; id: string | null }) => `${TASK_TYPES[t.type] ?? t.type}${t.id ? ` ${t.id}` : ""}`;

/** Splits UPID:node:pid:pstart:starttime:type:id:user: — the id may itself contain ":" (a volume id). */
export function parseUpid(upid: string): { node: string; type: string; id: string | null; user: string } | null {
  const p = upid.split(":");
  if (p[0] !== "UPID" || p.length < 9) return null;
  return { node: p[1], type: p[5], id: p.slice(6, -2).join(":") || null, user: p[p.length - 2] };
}

const DEMO_LATEST: Record<string, Omit<LibraryLatest, "id">> = {
  debian: { version: "13.7.0", filename: "debian-13.7.0-amd64-netinst.iso", url: "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.7.0-amd64-netinst.iso", checksum: "0".repeat(64), algorithm: "sha256" },
  "ubuntu-lts": { version: "24.04.5", filename: "ubuntu-24.04.5-live-server-amd64.iso", url: "https://releases.ubuntu.com/noble/ubuntu-24.04.5-live-server-amd64.iso", checksum: "1".repeat(64), algorithm: "sha256" },
  alpine: { version: "3.24.2", filename: "alpine-virt-3.24.2-x86_64.iso", url: "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/alpine-virt-3.24.2-x86_64.iso", checksum: "2".repeat(64), algorithm: "sha256" },
  "rocky-9": { version: "9.8", filename: "Rocky-9.8-x86_64-minimal.iso", url: "https://download.rockylinux.org/pub/rocky/9/isos/x86_64/Rocky-9.8-x86_64-minimal.iso", checksum: "3".repeat(64), algorithm: "sha256" },
  "alma-9": { version: "9.8", filename: "AlmaLinux-9.8-x86_64-minimal.iso", url: "https://repo.almalinux.org/almalinux/9/isos/x86_64/AlmaLinux-9.8-x86_64-minimal.iso", checksum: "4".repeat(64), algorithm: "sha256" },
  arch: { version: "2026.10.01", filename: "archlinux-2026.10.01-x86_64.iso", url: "https://geo.mirror.pkgbuild.com/iso/latest/archlinux-2026.10.01-x86_64.iso", checksum: "5".repeat(64), algorithm: "sha256" },
};

const DEMO_CATALOG: CatalogTemplate[] = [
  ["debian-12-standard_12.7-1_amd64.tar.zst", "Debian 12 (Bookworm)", "debian", "12", "system"],
  ["debian-13-standard_13.1-1_amd64.tar.zst", "Debian 13 (Trixie)", "debian", "13", "system"],
  ["ubuntu-24.04-standard_24.04-2_amd64.tar.zst", "Ubuntu 24.04 LTS", "ubuntu", "24.04", "system"],
  ["ubuntu-22.04-standard_22.04-1_amd64.tar.zst", "Ubuntu 22.04 LTS", "ubuntu", "22.04", "system"],
  ["alpine-3.22-default_20250617_amd64.tar.xz", "Alpine Linux 3.22", "alpine", "3.22", "system"],
  ["rockylinux-9-default_20240912_amd64.tar.xz", "Rocky Linux 9", "rockylinux", "9", "system"],
  ["fedora-42-default_20250428_amd64.tar.xz", "Fedora 42", "fedora", "42", "system"],
  ["archlinux-base_20240911-1_amd64.tar.zst", "Arch Linux", "archlinux", "base", "system"],
  ["debian-12-turnkey-nextcloud_18.1-1_amd64.tar.gz", "TurnKey Nextcloud", "debian-12", "18.1", "turnkeylinux"],
  ["debian-12-turnkey-gitea_18.0-1_amd64.tar.gz", "TurnKey Gitea", "debian-12", "18.0", "turnkeylinux"],
  ["debian-12-turnkey-wordpress_18.2-1_amd64.tar.gz", "TurnKey WordPress", "debian-12", "18.2", "turnkeylinux"],
  ["debian-12-turnkey-mediaserver_18.0-1_amd64.tar.gz", "TurnKey Media Server", "debian-12", "18.0", "turnkeylinux"],
].map(([template, headline, os, version, section]) => ({ template, headline, os, version, section, description: null, infopage: null }));

const KIND_OF: Record<string, ContentKind> = { "ISO images": "iso", Templates: "vztmpl", Backups: "backup", "Disk images": "images", Containers: "rootdir", Snippets: "snippets" };

/** An in-browser stand-in for Proxmox's storage and task APIs, for the demo. */
export function demoBackend(storages: () => HostStorage[], guests: () => Guest[] = () => [], user = "owner@pve"): Backend {
  const now = () => Math.floor(Date.now() / 1000);
  const items = new Map<string, StorageItem[]>();
  const tasks: (TaskEntry & { log: string[]; finishAt: number; fail?: string })[] = [];
  const item = (volid: string, content: ContentKind, size: number, daysAgo: number, vmid: number | null = null): StorageItem => ({ volid, content, format: volid.split(".").pop() ?? null, size, ctime: now() - daysAgo * 86400, vmid, notes: null, protected: false });

  const seed = (s: HostStorage): StorageItem[] => {
    const kinds = s.content.map((c) => KIND_OF[c]).filter(Boolean);
    const list: StorageItem[] = [];
    if (kinds.includes("iso")) list.push(item(`${s.id}:iso/debian-13.1.0-amd64-netinst.iso`, "iso", 783 * 1024 ** 2, 12), item(`${s.id}:iso/ubuntu-24.04.3-live-server-amd64.iso`, "iso", 3.1 * 1024 ** 3, 30));
    if (kinds.includes("vztmpl")) list.push(item(`${s.id}:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst`, "vztmpl", 126 * 1024 ** 2, 40));
    if (kinds.includes("backup") && s.id !== "local") list.push(item(`${s.id}:backup/vzdump-lxc-101-2025_10_10-21_00_02.tar.zst`, "backup", 1.4 * 1024 ** 3, 1, 101), item(`${s.id}:backup/vzdump-qemu-109-2025_10_10-21_04_40.vma.zst`, "backup", 6.2 * 1024 ** 3, 1, 109));
    if (kinds.includes("images") && s.id !== "local") list.push(item(`${s.id}:109/vm-109-disk-0.qcow2`, "images", 32 * 1024 ** 3, 60, 109));
    if (kinds.includes("rootdir") && s.id !== "local") list.push(item(`${s.id}:101/subvol-101-disk-0.subvol`, "rootdir", 8 * 1024 ** 3, 90, 101));
    return list;
  };
  const listFor = (storage: string) => {
    if (!items.has(storage)) {
      const s = storages().find((x) => x.id === storage);
      if (!s) throw new ApiError(400, "bad_request", "Unknown storage");
      items.set(storage, seed(s));
    }
    return items.get(storage)!;
  };
  const startTask = (type: string, id: string | null, seconds: number, log: string[], done?: () => void, fail?: string) => {
    const upid = `UPID:demo:${Date.now().toString(16).toUpperCase()}:${Math.random().toString(16).slice(2, 10).toUpperCase()}:${now().toString(16).toUpperCase()}:${type}:${id ?? ""}:${user}:`;
    const t: TaskEntry & { log: string[]; finishAt: number; fail?: string } = { upid, type, id, user, status: null, start: now(), end: null, log, finishAt: Date.now() + seconds * 1000, fail };
    tasks.unshift(t);
    setTimeout(() => {
      t.status = fail ? fail : "OK";
      t.end = now();
      t.log = [...t.log, fail ? `TASK ERROR: ${fail}` : "TASK OK"];
      if (!fail) done?.();
    }, seconds * 1000);
    return upid;
  };
  const exists = (storage: string, volid: string) => listFor(storage).some((i) => i.volid === volid);
  const hw = new Map<number, GuestHardware>();
  const snaps = new Map<number, SnapshotInfo[]>();
  const hwFor = (vmid: number): GuestHardware => {
    if (!hw.has(vmid)) {
      const g = guests().find((x) => x.vmid === vmid);
      if (!g) throw new ApiError(404, "not_found", "Unknown machine");
      const mac = `BC:24:11:${[vmid >> 8, vmid & 255, 0x2a].map((n) => n.toString(16).padStart(2, "0").toUpperCase()).join(":")}`;
      const disk = Math.max(1, Math.round(g.diskMax / 1e9));
      hw.set(vmid, {
        type: g.type, name: g.name, cores: g.cores, sockets: 1, memoryMb: Math.round(g.memMax / 1024 ** 2), swapMb: g.type === "lxc" ? 512 : null, balloonMb: null,
        onboot: g.protected, description: "", tags: g.tags ?? [], ostype: g.type === "qemu" ? "l26" : "debian",
        disks: g.type === "lxc" ? [{ key: "rootfs", storage: "local-lvm", volume: `local-lvm:vm-${vmid}-disk-0`, sizeGb: disk, mount: "/" }] : [{ key: "scsi0", storage: "local-lvm", volume: `local-lvm:vm-${vmid}-disk-0`, sizeGb: disk, mount: null }],
        nics: [{ key: "net0", model: g.type === "qemu" ? "virtio" : null, name: g.type === "lxc" ? "eth0" : null, mac, bridge: "vmbr0", tag: null, firewall: true, ip: g.type === "lxc" ? (g.ip ? `${g.ip}/24` : "dhcp") : null, gw: g.type === "lxc" && g.ip ? "192.168.1.254" : null, rate: null }],
        cdrom: g.type === "qemu" ? "local:iso/debian-13.1.0-amd64-netinst.iso" : null, pending: [], protection: g.protected, startup: { order: null, up: null, down: null }, boot: g.type === "qemu" ? ["scsi0", "net0"] : null, bootDevices: g.type === "qemu" ? ["ide2", "net0", "scsi0"] : [], agent: g.type === "qemu" ? true : null, status: g.status, template: false,
      });
    }
    const h = hw.get(vmid)!;
    return { ...h, status: guests().find((x) => x.vmid === vmid)?.status ?? h.status };
  };
  const snapsFor = (vmid: number) => {
    if (!snaps.has(vmid)) snaps.set(vmid, (guests().find((x) => x.vmid === vmid)?.snapshots ?? []).map((x, i, all) => ({ name: x.name, description: x.description, time: Date.parse(x.at) / 1000, parent: i ? all[i - 1].name : null, vmstate: false })));
    return snaps.get(vmid)!;
  };
  let ifaces: NetIface[] = [
    { iface: "nic0", type: "eth", active: true, autostart: true, cidr: null, gateway: null, ports: [], vlanAware: false, slaves: [], bondMode: null, vlanRaw: null, vlanId: null, comments: null, method: "manual" },
    { iface: "nic1", type: "eth", active: false, autostart: false, cidr: null, gateway: null, ports: [], vlanAware: false, slaves: [], bondMode: null, vlanRaw: null, vlanId: null, comments: null, method: "manual" },
    { iface: "vmbr0", type: "bridge", active: true, autostart: true, cidr: "192.168.1.10/24", gateway: "192.168.1.254", ports: ["nic0"], vlanAware: false, slaves: [], bondMode: null, vlanRaw: null, vlanId: null, comments: "Management and machines", method: "static" },
  ];
  let staged: NetIface[] | null = null;
  const stanza = (i: NetIface) => [`auto ${i.iface}`, `iface ${i.iface} inet ${i.cidr ? "static" : "manual"}`, ...(i.cidr ? [`\taddress ${i.cidr}`] : []), ...(i.gateway ? [`\tgateway ${i.gateway}`] : []), ...(i.type === "bridge" ? [`\tbridge-ports ${i.ports.join(" ") || "none"}`, "\tbridge-stp off", "\tbridge-fd 0", ...(i.vlanAware ? ["\tbridge-vlan-aware yes"] : [])] : []), ...(i.type === "bond" ? [`\tbond-slaves ${i.slaves.join(" ")}`, `\tbond-mode ${i.bondMode}`] : []), ...(i.comments ? [`#${i.comments}`] : [])];
  const diff = () => {
    if (!staged) return null;
    const before = new Map(ifaces.map((i) => [i.iface, stanza(i).join("\n")]));
    const after = new Map(staged.map((i) => [i.iface, stanza(i).join("\n")]));
    const out = ["--- /etc/network/interfaces", "+++ /etc/network/interfaces.new"];
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(k) === after.get(k)) continue;
      for (const l of (before.get(k) ?? "").split("\n").filter(Boolean)) out.push(`-${l}`);
      for (const l of (after.get(k) ?? "").split("\n").filter(Boolean)) out.push(`+${l}`);
    }
    return out.length > 2 ? out.join("\n") : null;
  };
  let jobs: BackupJob[] = [{ id: "backup-daily", schedule: "21:00", storage: "drive2", all: true, vmids: [], pool: null, mode: "snapshot", compress: "zstd", enabled: true, keepLast: 1, comment: null, nextRun: Math.floor(Date.now() / 1000) + 6 * 3600 }];
  const stamp = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}_${p(d.getUTCMonth() + 1)}_${p(d.getUTCDate())}-${p(d.getUTCHours())}_${p(d.getUTCMinutes())}_${p(d.getUTCSeconds())}`;
  };

  return {
    content: async (storage, kind) => listFor(storage).filter((i) => !kind || i.content === kind),
    deleteVolume: async (storage, volid) => {
      const list = listFor(storage);
      const i = list.findIndex((x) => x.volid === volid);
      if (i < 0) throw new ApiError(400, "proxmox_rejected", "volume does not exist");
      list.splice(i, 1);
      return { task: startTask("imgdel", volid, 0.3, [`removed ${volid}`]) };
    },
    catalog: async () => DEMO_CATALOG,
    downloadTemplate: async (storage, template) => {
      const volid = `${storage}:vztmpl/${template}`;
      if (exists(storage, volid)) throw new ApiError(400, "proxmox_rejected", `template '${template}' already exists`);
      return { task: startTask("download", template, 3, [`starting template download from: http://download.proxmox.com/images/system/${template}`, `target file: ${template}`, "download finished", "calculating checksum...OK"], () => listFor(storage).push(item(volid, "vztmpl", 130 * 1024 ** 2, 0))) };
    },
    downloadUrl: async (storage, d) => {
      const volid = `${storage}:${d.content}/${d.filename}`;
      if (exists(storage, volid)) throw new ApiError(400, "proxmox_rejected", "filename: refusing to override existing file");
      return { task: startTask("download", d.filename, 4, [`downloading ${d.url} to /var/lib/vz/template/${d.content}/${d.filename}`, ...(d.checksum ? [`validating checksum (${d.algorithm})...OK`] : []), "download of file finished"], () => listFor(storage).push(item(volid, d.content, 900 * 1024 ** 2, 0))) };
    },
    libraryLatest: async (id) => {
      const hit = DEMO_LATEST[id];
      if (!hit) throw new ApiError(404, "not_found", "That one has no automatic download");
      return { id, ...hit };
    },
    upload: (storage, content, file, onProgress, signal) =>
      new Promise((resolve, reject) => {
        const volid = `${storage}:${content}/${file.name}`;
        if (exists(storage, volid)) return reject(new ApiError(400, "proxmox_rejected", "refusing to override existing file"));
        let f = 0;
        const t = setInterval(() => {
          f = Math.min(1, f + 0.08);
          onProgress(f);
          if (f >= 1) {
            clearInterval(t);
            resolve({ task: startTask("imgcopy", file.name, 0.8, [`starting file import from: /var/tmp/pveupload-${Date.now()}`, `target file: ${file.name}`, `file size is: ${file.size}`], () => listFor(storage).push({ ...item(volid, content, file.size, 0) })) });
          }
        }, 120);
        signal?.addEventListener("abort", () => {
          clearInterval(t);
          reject(new ApiError(0, "aborted", "Upload cancelled"));
        });
      }),
    destroyMachine: async (vmid, confirm) => {
      const g = guests().find((x) => x.vmid === vmid);
      if (!g) throw new ApiError(404, "not_found", "Unknown machine");
      if (confirm !== g.name) throw new ApiError(409, "confirm", `Type the machine's name (${g.name}) to confirm.`);
      if (g.status === "running") throw new ApiError(409, "running", `${g.name} is running. Shut it down first.`);
      if (hwFor(vmid).protection) throw new ApiError(409, "protected", `${g.name} is protected. Turn protection off first.`);
      return { task: startTask(g.type === "lxc" ? "vzdestroy" : "qmdestroy", String(vmid), 1.5, [`destroy ${g.name}`, "purging from backup schedules", "removing disks"]) };
    },
    convertToTemplate: async (vmid, confirm) => {
      const g = guests().find((x) => x.vmid === vmid);
      if (!g) throw new ApiError(404, "not_found", "Unknown machine");
      if (confirm !== g.name) throw new ApiError(409, "confirm", `Type the machine's name (${g.name}) to confirm.`);
      if (g.status === "running") throw new ApiError(409, "running", `${g.name} is running. Shut it down first.`);
      if (g.template) throw new ApiError(409, "template", `${g.name} is already a template.`);
      return { task: startTask("template", String(vmid), 1, [`converting ${g.name} to a template`]) };
    },
    tasks: async (limit = 50, vmid) => tasks.filter((t) => vmid === undefined || t.id === String(vmid)).slice(0, limit).map(({ upid, type, id, user: u, status, start, end }) => ({ upid, type, id, user: u, status, start, end })),
    task: async (upid) => {
      const t = tasks.find((x) => x.upid === upid);
      if (!t) throw new ApiError(400, "bad_request", "Unknown task");
      return { status: t.end ? "stopped" : "running", exitstatus: t.end ? t.status : null, log: t.log };
    },
    hardware: async (vmid) => structuredClone(hwFor(vmid)),
    setHardware: async (vmid, c) => {
      const h = hwFor(vmid);
      hw.set(vmid, { ...h, ...(c.cores !== undefined ? { cores: c.cores } : {}), ...(c.sockets !== undefined ? { sockets: c.sockets } : {}), ...(c.memoryMb !== undefined ? { memoryMb: c.memoryMb } : {}), ...(c.swapMb !== undefined ? { swapMb: c.swapMb } : {}), ...(c.onboot !== undefined ? { onboot: c.onboot } : {}), ...(c.description !== undefined ? { description: c.description } : {}), ...(c.tags !== undefined ? { tags: c.tags } : {}), ...(c.name !== undefined ? { name: c.name } : {}), ...(c.protection !== undefined ? { protection: c.protection } : {}), ...(c.startup !== undefined ? { startup: c.startup } : {}), ...(c.boot !== undefined ? { boot: c.boot } : {}), ...(c.agent !== undefined ? { agent: c.agent } : {}), ...(c.ostype !== undefined ? { ostype: c.ostype } : {}), pending: h.type === "qemu" && h.status === "running" && (c.cores !== undefined || c.memoryMb !== undefined || c.sockets !== undefined) ? [...new Set([...h.pending, ...(c.cores !== undefined ? ["cores"] : []), ...(c.memoryMb !== undefined ? ["memory"] : [])])] : h.pending });
      return { ok: true };
    },
    resizeDisk: async (vmid, disk, growGb) => {
      const h = hwFor(vmid);
      hw.set(vmid, { ...h, disks: h.disks.map((d) => (d.key === disk ? { ...d, sizeGb: (d.sizeGb ?? 0) + growGb } : d)) });
      return { task: startTask(h.type === "lxc" ? "vzresize" : "qmresize", String(vmid), 1, [`resizing ${disk} by +${growGb}G`, "resize2fs: The filesystem is now larger."]) };
    },
    saveNic: async (vmid, n) => {
      const h = hwFor(vmid);
      if (!ifaces.some((i) => i.iface === n.bridge && i.type === "bridge")) throw new ApiError(400, "proxmox_rejected", `bridge '${n.bridge}' does not exist`);
      const key = n.key ?? `net${[...Array(32).keys()].find((i) => !h.nics.some((x) => x.key === `net${i}`))}`;
      const old = h.nics.find((x) => x.key === key);
      const nic = { key, model: h.type === "qemu" ? n.model ?? old?.model ?? "virtio" : null, name: h.type === "lxc" ? old?.name ?? `eth${key.slice(3)}` : null, mac: old?.mac ?? `BC:24:11:${Math.random().toString(16).slice(2, 8).toUpperCase().match(/../g)!.join(":")}`, bridge: n.bridge, tag: n.tag ?? null, firewall: n.firewall, ip: h.type === "lxc" ? n.ip ?? "dhcp" : null, gw: h.type === "lxc" ? n.gw ?? null : null, rate: n.rate ?? null };
      hw.set(vmid, { ...h, nics: old ? h.nics.map((x) => (x.key === key ? nic : x)) : [...h.nics, nic] });
      return { ok: true };
    },
    deleteNic: async (vmid, key) => {
      const h = hwFor(vmid);
      hw.set(vmid, { ...h, nics: h.nics.filter((x) => x.key !== key) });
      return { ok: true };
    },
    snapshots: async (vmid) => {
      const l = snapsFor(vmid);
      return { snapshots: l.map((x) => ({ ...x })), current: l.at(-1)?.name ?? null };
    },
    takeSnapshot: async (vmid, name, description, vmstate) => {
      const l = snapsFor(vmid);
      if (l.some((x) => x.name === name)) throw new ApiError(400, "proxmox_rejected", `snapshot name '${name}' already used`);
      return { task: startTask(hwFor(vmid).type === "lxc" ? "vzsnapshot" : "qmsnapshot", String(vmid), 1.2, [`snapshot '${name}'`], () => l.push({ name, description, time: Math.floor(Date.now() / 1000), parent: l.at(-1)?.name ?? null, vmstate })) };
    },
    rollbackSnapshot: async (vmid, name) => ({ task: startTask(hwFor(vmid).type === "lxc" ? "vzrollback" : "qmrollback", String(vmid), 1.5, [`rolling back to '${name}'`]) }),
    deleteSnapshot: async (vmid, name) => {
      const l = snapsFor(vmid);
      return { task: startTask(hwFor(vmid).type === "lxc" ? "vzdelsnapshot" : "qmdelsnapshot", String(vmid), 1, [`delete snapshot '${name}'`], () => snaps.set(vmid, l.filter((x) => x.name !== name))) };
    },
    clone: async (vmid, name) => {
      const g = guests().find((x) => x.vmid === vmid);
      if (!g) throw new ApiError(404, "not_found", "Unknown machine");
      const newid = Math.max(99, ...guests().map((x) => x.vmid)) + 1;
      return { vmid: newid, full: true, task: startTask(g.type === "lxc" ? "vzclone" : "qmclone", String(vmid), 2.5, [`create full clone of drive (${name})`, "transferred 8.0 GiB of 8.0 GiB (100.00%)"]) };
    },
    network: async () => ({ interfaces: structuredClone(staged ?? ifaces), changes: diff() }),
    saveIface: async (existing, spec) => {
      const list = structuredClone(staged ?? ifaces);
      if (!existing && list.some((i) => i.iface === spec.iface)) throw new ApiError(400, "proxmox_rejected", `interface '${spec.iface}' already exists`);
      const next: NetIface = { ...spec, iface: existing ?? spec.iface, active: false, method: spec.cidr ? "static" : "manual" };
      staged = existing ? list.map((i) => (i.iface === existing ? { ...next, active: i.active } : i)) : [...list, next].sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }));
      return { ok: true };
    },
    deleteIface: async (iface, confirm) => {
      const list = structuredClone(staged ?? ifaces);
      if (list.find((i) => i.iface === iface)?.gateway && confirm !== iface) throw new ApiError(409, "confirm", `${iface} carries this host's gateway. Type its name to delete it.`);
      staged = list.filter((i) => i.iface !== iface);
      return { ok: true };
    },
    applyNetwork: async () => {
      const next = staged;
      return { task: startTask("srvreload", "networking", 1.5, ["ifreload -a", "TASK OK"].slice(0, 1), () => {
        if (next) ifaces = next.map((i) => ({ ...i, active: i.autostart }));
        staged = null;
      }) };
    },
    revertNetwork: async () => {
      staged = null;
      return { ok: true };
    },
    ...demoNetworkConfig(startTask),
    backupJobs: async () => jobs.map((j) => ({ ...j })),
    saveBackupJob: async (id, spec) => {
      const next: BackupJob = { id: id ?? `backup-${Math.random().toString(16).slice(2, 10)}`, schedule: spec.schedule, storage: spec.storage, all: spec.all, vmids: spec.vmids, pool: null, mode: spec.mode, compress: "zstd", enabled: spec.enabled, keepLast: spec.keepLast, comment: spec.comment ?? null, nextRun: Math.floor(Date.now() / 1000) + 3600 };
      jobs = id ? jobs.map((j) => (j.id === id ? next : j)) : [...jobs, next];
      return { ok: true };
    },
    toggleBackupJob: async (id, enabled) => {
      jobs = jobs.map((j) => (j.id === id ? { ...j, enabled } : j));
      return { ok: true };
    },
    deleteBackupJob: async (id) => {
      jobs = jobs.filter((j) => j.id !== id);
      return { ok: true };
    },
    runBackup: async (r) => {
      if (!r.all && !r.vmids.length) throw new ApiError(400, "bad_request", "Pick the machines to back up");
      const ids = r.all ? [101, 105, 109] : r.vmids;
      return {
        task: startTask("vzdump", r.all ? null : ids.join(","), 2 + ids.length, ["INFO: starting new backup job: vzdump " + (r.all ? "--all 1" : ids.join(" ")) + ` --storage ${r.storage} --mode ${r.mode} --compress zstd`, ...ids.map((id) => `INFO: Starting Backup of VM ${id}`), "INFO: Backup job finished successfully"], () => {
          for (const id of ids) listFor(r.storage).push(item(`${r.storage}:backup/vzdump-${id >= 109 ? "qemu" : "lxc"}-${id}-${stamp()}.${id >= 109 ? "vma" : "tar"}.zst`, "backup", (1 + id % 5) * 1024 ** 3, 0, id));
        }),
      };
    },
    restore: async (r) => {
      const b = parseBackupName(r.volid);
      if (!b) throw new ApiError(400, "bad_request", "That isn't a machine backup");
      const vmid = r.replace ? b.vmid : 200 + Math.floor(Math.random() * 700);
      return { vmid, task: startTask(b.type === "lxc" ? "vzrestore" : "qmrestore", String(vmid), 2.5, [`restore ${r.volid} to ${r.storage}`, `machine ${vmid} restored`]) };
    },
    machineOptions: async () => {
      const all = storages();
      const vol = (kind: ContentKind) => all.flatMap((s) => listFor(s.id).filter((i) => i.content === kind));
      const disks = all.filter((s) => s.content.includes("Disk images") || s.content.includes("Containers")).map((s) => ({ storage: s.id, type: s.type, avail: s.total - s.used }));
      return {
        nextid: 0,
        templates: vol("vztmpl").map((i) => ({ volid: i.volid, name: i.volid.split("/").pop()!, size: i.size })),
        isos: vol("iso").map((i) => ({ volid: i.volid, name: i.volid.split("/").pop()!, size: i.size })),
        storages: disks,
        vmStorages: disks,
        pools: [],
      };
    },
  };
}
