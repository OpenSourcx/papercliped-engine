import { api, ApiError, type CatalogTemplate, type ContentKind, type MachineOptions, type StorageItem, type TaskDetail, type TaskEntry, type UrlDownload } from "./api.ts";
import type { HostStorage } from "./types.ts";

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
  upload: (storage: string, content: "iso" | "vztmpl", file: File, onProgress: (f: number) => void, signal?: AbortSignal) => Promise<{ task: string }>;
  tasks: (limit?: number) => Promise<TaskEntry[]>;
  task: (upid: string) => Promise<TaskDetail>;
  machineOptions: () => Promise<MachineOptions>;
}

export const liveBackend: Backend = {
  content: api.content,
  deleteVolume: api.deleteVolume,
  catalog: api.catalog,
  downloadTemplate: api.downloadTemplate,
  downloadUrl: api.downloadUrl,
  upload: api.upload,
  tasks: api.tasks,
  task: api.task,
  machineOptions: api.machineOptions,
};

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
  qmcreate: "Create VM",
  qmstart: "Start VM",
  qmstop: "Stop VM",
  qmshutdown: "Shut down VM",
  qmreboot: "Reboot VM",
  qmdestroy: "Destroy VM",
  qmsnapshot: "Snapshot",
  vzsnapshot: "Snapshot",
  imgdel: "Delete file",
  srvreload: "Reload service",
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
export function demoBackend(storages: () => HostStorage[], user = "owner@pve"): Backend {
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
    tasks: async (limit = 50) => tasks.slice(0, limit).map(({ upid, type, id, user: u, status, start, end }) => ({ upid, type, id, user: u, status, start, end })),
    task: async (upid) => {
      const t = tasks.find((x) => x.upid === upid);
      if (!t) throw new ApiError(400, "bad_request", "Unknown task");
      return { status: t.end ? "stopped" : "running", exitstatus: t.end ? t.status : null, log: t.log };
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
