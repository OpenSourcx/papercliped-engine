import { useMemo } from "react";
import { ApiError, SIGNED_OUT } from "../api.ts";
import { useEngine } from "../store.tsx";
import { demoGuestApi } from "./guestDemo.ts";

/**
 * A machine's addresses, network devices, container DNS and features, resources, notes and tags, display / serial /
 * audio / EFI / TPM, host devices and access entries. Live, these calls go to the host service, which acts as the
 * signed-in person; in the demo the same calls run in this browser (guestDemo.ts) with the same rules.
 */

export interface GuestNic {
  key: string;
  /** VMs: the card model (virtio, e1000e ...). */
  model: string | null;
  /** Containers: the name inside the container (eth0). */
  name: string | null;
  mac: string | null;
  bridge: string | null;
  tag: number | null;
  trunks: string | null;
  firewall: boolean;
  linkDown: boolean;
  /** MB/s; null is unlimited. */
  rate: number | null;
  mtu: number | null;
  queues: number | null;
  /** Containers: dhcp, manual or an address with its prefix. */
  ip: string | null;
  gw: string | null;
  ip6: string | null;
  gw6: string | null;
  pending: boolean;
}

export interface GuestFeatures {
  nesting: boolean;
  keyctl: boolean;
  fuse: boolean;
  mknod: boolean;
  forceRwSys: boolean;
  mount: string[];
}

export interface PassthroughItem {
  key: string;
  kind: "pci" | "usb" | "dev";
  target: string;
  mapped: boolean;
  options: string[];
  raw: string;
}

export interface GuestDevices {
  type: "qemu" | "lxc";
  status: string;
  name: string;
  digest: string | null;
  locked: string | null;
  isAdmin: boolean;
  pendingKeys: string[];
  /** Bridges and networks a device may join. Empty when this account can't list them. */
  bridges: string[];
  nics: GuestNic[];
  dns: { nameserver: string[]; searchdomain: string[]; fromHost: boolean } | null;
  features: GuestFeatures | null;
  unprivileged: boolean | null;
  resources: { cores: number; sockets: number | null; memory: number; balloon: number | null; swap: number | null; cpulimit: number | null; cpuunits: number | null; arch: string | null };
  notes: string;
  tags: string[];
  vm: {
    bios: string;
    display: { type: string; memory: number | null; clipboard: string | null };
    serial: { key: string; value: string }[];
    audio: { device: string; driver: string } | null;
    efi: { volume: string; efitype: string; preEnrolledKeys: boolean } | null;
    tpm: { volume: string; version: string } | null;
    machine: string | null;
  } | null;
  passthrough: PassthroughItem[];
}

export interface GuestAddresses {
  type: "qemu" | "lxc";
  source: "running" | "config" | "none";
  hostname: string | null;
  note: string | null;
  interfaces: { name: string; mac: string | null; addresses: { ip: string; prefix: number | null; family: "ipv4" | "ipv6" }[] }[];
}

export interface HostDevices {
  pci: { id: string; vendor: string | null; device: string | null; class: string | null; iommuGroup: number; mdev: boolean }[];
  usb: { id: string; port: string; name: string; speed: string | null }[];
  mappings: { pci: { id: string; description: string; entries: number }[]; usb: { id: string; description: string; entries: number }[] };
  notes: { pci: string | null; usb: string | null };
}

export interface AclEntry {
  path: string;
  type: "user" | "group" | "token";
  id: string;
  role: string;
  propagate: boolean;
}

export interface GuestPermissions {
  path: string;
  canModify: boolean;
  /** False when this account may not list access entries at all. */
  visible: boolean;
  entries: AclEntry[];
  inherited: AclEntry[];
  roles: string[];
  users: string[];
  groups: string[];
}

export type ItemName = "display" | "bios" | "serial" | "audio" | "efi" | "tpm";
export type ActResult = { ok?: true; pending?: boolean; key?: string; warning?: string | null };

export interface GuestApi {
  devices(vmid: number): Promise<GuestDevices>;
  addresses(vmid: number): Promise<GuestAddresses>;
  hostDevices(vmid: number): Promise<HostDevices>;
  permissions(vmid: number): Promise<GuestPermissions>;
  grant(vmid: number, body: { type: AclEntry["type"]; id: string; role: string; propagate: boolean }): Promise<GuestPermissions>;
  revoke(vmid: number, body: { type: AclEntry["type"]; id: string; role: string; confirm: string }): Promise<GuestPermissions>;
  saveNic(vmid: number, body: Record<string, unknown>): Promise<ActResult>;
  removeNic(vmid: number, key: string, body: { digest: string; confirm: string }): Promise<ActResult>;
  saveDns(vmid: number, body: { digest: string; nameserver: string[]; searchdomain: string[] }): Promise<ActResult>;
  saveFeatures(vmid: number, body: Record<string, unknown>): Promise<ActResult>;
  saveResources(vmid: number, body: Record<string, unknown>): Promise<ActResult>;
  saveNotes(vmid: number, body: { digest: string; description?: string; tags?: string[] }): Promise<ActResult>;
  item(vmid: number, item: ItemName, body: Record<string, unknown>): Promise<ActResult>;
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

const g = (vmid: number, tail: string) => `/api/guests/${vmid}/${tail}`;

export const liveGuestApi: GuestApi = {
  devices: (v) => request("GET", g(v, "devices")),
  addresses: (v) => request("GET", g(v, "addresses")),
  hostDevices: (v) => request("GET", g(v, "passthrough")),
  permissions: (v) => request("GET", g(v, "permissions")),
  grant: (v, b) => request("POST", g(v, "permissions"), { action: "grant", ...b }),
  revoke: (v, b) => request("POST", g(v, "permissions"), { action: "revoke", ...b }),
  saveNic: (v, b) => request("POST", g(v, "network"), b),
  removeNic: (v, key, b) => request("POST", g(v, `network/${encodeURIComponent(key)}/delete`), b),
  saveDns: (v, b) => request("POST", g(v, "dns"), b),
  saveFeatures: (v, b) => request("POST", g(v, "features"), b),
  saveResources: (v, b) => request("POST", g(v, "resources"), b),
  saveNotes: (v, b) => request("POST", g(v, "notes"), b),
  item: (v, item, b) => request("POST", g(v, `items/${item}`), b),
};

/** Live against the host service, or the in-browser stand-in in the demo. */
export function useGuestApi(): GuestApi {
  const { live, backend } = useEngine();
  return useMemo(() => (live ? liveGuestApi : demoGuestApi(backend)), [live, backend]);
}

export const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
