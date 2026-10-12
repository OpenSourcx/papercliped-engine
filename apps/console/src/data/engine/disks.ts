import { useMemo } from "react";
import type { BwLimit, PruneSettings } from "@papercliped-engine/proxmox-client/storage-schema";
import { ApiError, SIGNED_OUT } from "../api.ts";
import { useEngine } from "../store.tsx";
import { demoDisksApi } from "./disksDemo.ts";

/**
 * Disks, storage definitions and per-machine disks. Live, these calls go to the host service, which acts as the
 * signed-in person; in the demo the same calls run against in-browser data (disksDemo.ts) so every screen works.
 */

export interface PhysDisk {
  devpath: string;
  name: string;
  type: string;
  sizeBytes: number;
  model: string | null;
  vendor: string | null;
  serial: string | null;
  wwn: string | null;
  usedBy: string | null;
  mounted: boolean;
  gpt: boolean;
  health: string | null;
  wearoutPct: number | null;
  rpm: number | null;
  parent: string | null;
  /** Why it can't be wiped or formatted, in words, or null when it is free. */
  inUseReason: string | null;
}

export interface SmartInfo {
  disk: string;
  health: string | null;
  type: string | null;
  text: string | null;
  attributes: { id?: number; name: string; value?: number; worst?: number; threshold?: number; raw?: string; fail?: string }[];
}

export type DiskStorageKind = "directory" | "lvm" | "lvmthin" | "zfs";

export interface ZfsNode {
  name: string;
  state?: string;
  read?: number;
  write?: number;
  cksum?: number;
  msg?: string;
  children?: ZfsNode[];
}

export interface ZfsDetail {
  name: string;
  state?: string;
  status?: string;
  action?: string;
  scan?: string;
  errors?: string;
  children?: ZfsNode[];
}

export interface StorageDef {
  id: string;
  type: string;
  content: string[];
  nodes: string[];
  enabled: boolean;
  shared: boolean;
  prune: PruneSettings | null;
  bwlimit: BwLimit | null;
  config: Record<string, unknown>;
  /** Which write-only settings are stored. Their values are never sent to the console. */
  secretsSet: string[];
  digest: string | null;
}

export interface StorageUsage {
  counts: Record<string, number>;
  readable: boolean;
  guests: { vmid: number; name: string | null; volumes: number }[];
  backupJobs: string[];
}

export type ScanKind = "nfs" | "cifs" | "pbs" | "iscsi" | "lvm" | "lvmthin" | "zfs";

export interface GuestDisk {
  key: string;
  kind: "disk" | "cdrom" | "cloudinit" | "efidisk" | "tpm" | "rootfs" | "mount" | "bind";
  staged: boolean;
  volume: string;
  storage: string | null;
  sizeGb: number | null;
  bus?: string;
  format?: string | null;
  media?: string;
  cache?: string | null;
  aio?: string | null;
  discard?: boolean;
  ssd?: boolean;
  iothread?: boolean;
  backup?: boolean;
  ro?: boolean;
  replicate?: boolean;
  mbpsRd?: number | null;
  mbpsWr?: number | null;
  iopsRd?: number | null;
  iopsWr?: number | null;
  mp?: string | null;
  acl?: boolean;
  quota?: boolean;
  mountoptions?: string[];
}

export interface GuestDisks {
  type: "qemu" | "lxc";
  status: string;
  digest: string | null;
  locked: string | null;
  isAdmin: boolean;
  pendingKeys: string[];
  disks: GuestDisk[];
  unused: { key: string; volume: string; name: string; storage: string | null }[];
  hotplug: boolean;
}

export interface DisksApi {
  disks(): Promise<PhysDisk[]>;
  smart(devpath: string): Promise<SmartInfo>;
  initGpt(devpath: string, confirm: string): Promise<{ task: string | null }>;
  wipe(devpath: string, confirm: string): Promise<{ task: string | null }>;
  listOnDisks(kind: DiskStorageKind): Promise<Record<string, unknown>[]>;
  zfsDetail(name: string): Promise<ZfsDetail>;
  createOnDisk(kind: DiskStorageKind, body: Record<string, unknown>): Promise<{ task: string | null }>;
  deleteOnDisk(kind: DiskStorageKind, name: string, body: Record<string, unknown>): Promise<{ task: string | null }>;
  storageDefs(): Promise<StorageDef[]>;
  storageDef(id: string): Promise<StorageDef>;
  createStorage(body: Record<string, unknown>): Promise<unknown>;
  updateStorage(id: string, body: Record<string, unknown>): Promise<unknown>;
  removeStorage(id: string, body: { confirm: string; acknowledgeInUse?: boolean }): Promise<unknown>;
  storageUsage(id: string): Promise<StorageUsage>;
  scan(kind: ScanKind, body: Record<string, unknown>): Promise<Record<string, string>[]>;
  volumeAttributes(storage: string, volid: string, body: { notes?: string; protected?: boolean }): Promise<unknown>;
  /** `hint` is the machine kind; only the demo needs it. */
  guestDisks(vmid: number, hint?: "qemu" | "lxc"): Promise<GuestDisks>;
  guestAct(vmid: number, tail: string, body: Record<string, unknown>): Promise<{ task?: string; key?: string; staleUnused?: boolean; ok?: boolean }>;
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: "same-origin", headers: method === "POST" ? { "Content-Type": "application/json", "X-EPC-Request": "1" } : { Accept: "application/json" }, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined });
  } catch {
    throw new ApiError(0, "offline", "Can't reach this device");
  }
  if (!(res.headers.get("content-type") ?? "").startsWith("application/json")) throw new ApiError(res.status, "no_service", "The host service isn't running");
  const data = (await res.json()) as T & { error?: string; code?: string };
  if (!res.ok) {
    const err = new ApiError(res.status, data.code ?? "error", data.error ?? `Request failed (${res.status})`);
    if (res.status === 401 && err.code === "signed_out") window.dispatchEvent(new Event(SIGNED_OUT));
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

export const liveDisksApi: DisksApi = {
  disks: () => request<{ disks: PhysDisk[] }>("GET", "/api/disks/list?partitions=0").then((r) => r.disks),
  smart: (d) => request<SmartInfo>("GET", `/api/disks/smart?disk=${enc(d)}`),
  initGpt: (disk, confirm) => request("POST", "/api/disks/initgpt", { disk, confirm }),
  wipe: (disk, confirm) => request("POST", "/api/disks/wipe", { disk, confirm }),
  listOnDisks: (k) => request<{ items: Record<string, unknown>[] }>("GET", `/api/disks/${k}`).then((r) => r.items),
  zfsDetail: (n) => request<ZfsDetail>("GET", `/api/disks/zfs/${enc(n)}`),
  createOnDisk: (k, body) => request("POST", `/api/disks/${k}`, body),
  deleteOnDisk: (k, n, body) => request("POST", `/api/disks/${k}/${enc(n)}/delete`, body),
  storageDefs: () => request<{ storages: StorageDef[] }>("GET", "/api/storage-config").then((r) => r.storages),
  storageDef: (id) => request<StorageDef>("GET", `/api/storage-config/${enc(id)}`),
  createStorage: (b) => request("POST", "/api/storage-config", b),
  updateStorage: (id, b) => request("POST", `/api/storage-config/${enc(id)}`, b),
  removeStorage: (id, b) => request("POST", `/api/storage-config/${enc(id)}/delete`, b),
  storageUsage: (id) => request<StorageUsage>("GET", `/api/storage-config/${enc(id)}/usage`),
  scan: (k, b) => request<{ items: Record<string, string>[] }>("POST", `/api/storage-config/scan/${k}`, b).then((r) => r.items),
  volumeAttributes: (s, volid, b) => request("POST", `/api/storage/${enc(s)}/attributes`, { volid, ...b }),
  guestDisks: (vmid) => request<GuestDisks>("GET", `/api/guests/${vmid}/disks`),
  guestAct: (vmid, tail, body) => request("POST", `/api/guests/${vmid}/disks/${tail}`, body),
};

/** Live against the host service, or the in-browser stand-in in the demo. */
export function useDisksApi(): DisksApi {
  const { live } = useEngine();
  return useMemo(() => (live ? liveDisksApi : demoDisksApi), [live]);
}

export const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
