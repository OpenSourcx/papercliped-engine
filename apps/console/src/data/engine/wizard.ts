import { useMemo, useRef } from "react";
import { buildCt, buildVm, maskSecrets, storageFormats, WizardError, CPU_TYPES, type CtWizardSpec, type Params, type VmWizardSpec, type WizardContext } from "@papercliped-engine/proxmox-client/wizard-schema";
import { ApiError, SIGNED_OUT } from "../api.ts";
import { useEngine } from "../store.tsx";

/**
 * The Create virtual machine and Create container wizards' data. Live, these calls go to the host service, which acts
 * as the signed-in person; in the demo the same shared checks (`wizard-schema`) run in the browser against in-browser
 * data, so both modes accept and refuse exactly the same requests. See docs/WIZARDS.md.
 */

export interface DiskStorageOption {
  storage: string;
  type: string;
  avail: number | null;
  formats: string[];
}
export interface WizardOptions {
  nextid: number;
  node: string;
  templates: { volid: string; name: string; size: number | null }[];
  isos: { volid: string; name: string; size: number | null }[];
  vmStorages: DiskStorageOption[];
  ctStorages: DiskStorageOption[];
  pools: string[];
  bridges: { id: string; kind: "bridge" | "vnet" }[];
  cpuTypes: { common: readonly string[]; custom: string[]; host: { name: string; vendor: string | null }[] };
  machines: string[];
  rawPassthrough: boolean;
  pci: { id: string; vendor: string; device: string; group: number | null }[];
  usb: { host: string; port: string; name: string }[];
  pciMappings: { id: string; description: string | null }[];
  usbMappings: { id: string; description: string | null }[];
  isAdmin: boolean;
  notes: string[];
}
export type WizardKind = "vm" | "ct";
export interface WizardPreview {
  vmid: number;
  params: Params;
  warnings: string[];
}
export interface WizardCreated {
  vmid: number;
  task: string | null;
  warnings: string[];
}
export interface WizardApi {
  options(): Promise<WizardOptions>;
  vmidFree(vmid: number): Promise<{ free: boolean; message: string }>;
  preview(kind: WizardKind, spec: unknown): Promise<WizardPreview>;
  /** `org` is only used by the demo, which keeps the owner on the machine; live, the owner is the spec's resource group. */
  create(kind: WizardKind, spec: unknown, org?: string | null): Promise<WizardCreated>;
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

export const liveWizardApi: WizardApi = {
  options: () => request<WizardOptions>("GET", "/api/wizard/options"),
  vmidFree: (vmid) => request("GET", `/api/wizard/vmid?vmid=${vmid}`),
  preview: (kind, spec) => request("POST", "/api/wizard/preview", { kind, spec }),
  create: (kind, spec) => request("POST", "/api/wizard/create", { kind, spec }),
};

/** What the checks may know in the browser: the same lists the form offers. */
export function contextOf(o: WizardOptions, kind: WizardKind): WizardContext {
  const stores = kind === "vm" ? o.vmStorages : o.ctStorages;
  return {
    diskStorages: Object.fromEntries(stores.map((s) => [s.storage, { type: s.type }])),
    bridges: o.bridges.map((b) => b.id),
    cpuModels: kind === "vm" ? [...o.cpuTypes.common, ...o.cpuTypes.custom] : undefined,
    pools: o.pools.length ? o.pools : undefined,
  };
}

/** Runs the shared check; the first problem comes back as a field and a sentence. */
export function checkSpec(kind: WizardKind, spec: unknown, o: WizardOptions | null): { ok: true; vmid: number | null; params: Params; warnings: string[] } | { ok: false; field: string; message: string } {
  try {
    const ctx = o ? contextOf(o, kind) : {};
    const b = kind === "vm" ? buildVm(spec, o?.nextid ?? null, ctx) : buildCt(spec, o?.nextid ?? null, ctx);
    return { ok: true, vmid: b.vmid, params: b.params, warnings: b.warnings };
  } catch (e) {
    if (e instanceof WizardError) return { ok: false, field: e.field, message: e.message };
    throw e;
  }
}

/** The demo has no host: storage, templates and ISOs come from its in-browser storage; the rest is a believable stand-in. */
export function useWizardApi(): WizardApi {
  const engine = useEngine();
  const { live, backend } = engine;
  const ref = useRef(engine);
  ref.current = engine;
  return useMemo<WizardApi>(() => {
    if (live) return liveWizardApi;
    let options: WizardOptions | null = null;
    const load = async (): Promise<WizardOptions> => {
      const o = await backend.machineOptions();
      const disk = (l: { storage: string; type: string; avail: number | null }[]): DiskStorageOption[] => l.map((s) => ({ ...s, formats: storageFormats(s.type) }));
      const nextid = Math.max(99, ...ref.current.data.guests.map((g) => g.vmid)) + 1;
      options = {
        nextid,
        node: "pve",
        templates: o.templates,
        isos: o.isos,
        vmStorages: disk(o.vmStorages),
        ctStorages: disk(o.storages),
        pools: o.pools,
        bridges: [{ id: "vmbr0", kind: "bridge" }, { id: "vmbr1", kind: "bridge" }],
        cpuTypes: { common: CPU_TYPES, custom: [], host: [] },
        machines: ["pc-q35-9.0", "pc-i440fx-9.0"],
        rawPassthrough: true,
        pci: [{ id: "0000:01:00.0", vendor: "Example GPU Co.", device: "Graphics card", group: 14 }],
        usb: [{ host: "0bda:0041", port: "1-2", name: "Zigbee dongle" }],
        pciMappings: [],
        usbMappings: [],
        isAdmin: true,
        notes: [],
      };
      return options;
    };
    const need = async () => options ?? load();
    return {
      options: load,
      vmidFree: async (vmid) => (ref.current.data.guests.some((g) => g.vmid === vmid) ? { free: false, message: `#${vmid} is already used by another machine` } : { free: true, message: "" }),
      preview: async (kind, spec) => {
        const o = await need();
        const r = checkSpec(kind, spec, o);
        if (!r.ok) throw new ApiError(400, "invalid", r.message);
        return { vmid: r.vmid ?? o.nextid, params: maskSecrets(r.params), warnings: r.warnings };
      },
      create: async (kind, spec, org = null) => {
        const o = await need();
        const r = checkSpec(kind, spec, o);
        if (!r.ok) throw new ApiError(400, "invalid", r.message);
        const p = r.params;
        const name = String(p.name ?? p.hostname);
        const engine = ref.current;
        if (engine.data.guests.some((g) => g.name === name)) throw new ApiError(409, "name_taken", "A machine with that name exists.");
        const memoryMb = Number(p.memory);
        const cores = Number(p.cores) * Number(p.sockets ?? 1);
        const diskGb = Object.entries(p).filter(([k]) => /^(scsi|virtio|sata|ide)\d+$|^rootfs$/.test(k)).reduce((n, [, v]) => n + (Number(String(v).match(/^[^:]+:(\d+)/)?.[1]) || 0), 0);
        const res =
          kind === "vm"
            ? await engine.createVm({ name, iso: (spec as VmWizardSpec).os.iso ?? null, ostype: (spec as VmWizardSpec).os.ostype === "win11" ? "win11" : (spec as VmWizardSpec).os.ostype.startsWith("l") ? "l26" : "other", cores, memoryMb, diskGb, storage: (spec as VmWizardSpec).disks[0]?.storage ?? "local-lvm", start: p.start !== false, org })
            : await engine.createMachine({ name, template: (spec as CtWizardSpec).template, storage: (spec as CtWizardSpec).disk.storage, cores, memoryMb, diskGb, org, os: o.templates.find((t) => t.volid === (spec as CtWizardSpec).template)?.name ?? "Linux" });
        if (!res.ok) throw new ApiError(400, "create_failed", res.error);
        return { vmid: res.vmid, task: null, warnings: r.warnings };
      },
    };
  }, [live, backend]);
}

export const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
