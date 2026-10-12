import { LIBRARY, matchesEntry, type Latest, type LibraryEntry } from "@papercliped-engine/os-library";
import type { CatalogTemplate } from "../../data/api.ts";
import { PLUGINS, type PluginEntry } from "../../data/storePlugins.ts";

/** The Store's categories, like the sections of an app store. */
export type Category = "os" | "app" | "tool" | "plugin";
export const CATEGORIES: { id: Category; label: string; blurb: string }[] = [
  { id: "os", label: "Operating systems", blurb: "Installers for virtual machines, and ready-made container systems." },
  { id: "app", label: "Apps", blurb: "Ready-to-run appliances: Nextcloud, WordPress, Gitea and more." },
  { id: "tool", label: "Drivers and tools", blurb: "Extras that make machines work better." },
  { id: "plugin", label: "Plugins", blurb: "Connectors, agent adapters and skills for ePaperclip and Pin." },
];

export type Status = "installed" | "update" | "available" | "manual";

export interface StoreItem {
  id: string;
  category: Category;
  name: string;
  vendor: string;
  summary: string;
  /** What installing it means. */
  kind: "iso" | "template" | "fixed" | "manual" | "connector" | "adapter" | "skill";
  /** "VM" for installers, "Container" for container templates. */
  badge: string | null;
  status: Status;
  /** Newest version known, and the version on a drive, when they are known. */
  latestVersion: string | null;
  haveVersion: string | null;
  /** Where the file already is, as a volume id such as local:iso/debian.iso. */
  volid: string | null;
  lib?: LibraryEntry;
  template?: CatalogTemplate;
  plugin?: PluginEntry;
}

export interface FilesByStorage {
  [storage: string]: string[]; // file names
}

export interface BuildInput {
  catalog: CatalogTemplate[];
  isoFiles: FilesByStorage;
  tplFiles: FilesByStorage;
  latest: Record<string, Latest | undefined>;
  installedPlugins: Set<string>;
  /** Entries from the signed marketplace catalog. Ones that ship with ePaperclip are ignored. */
  market?: PluginEntry[];
}

const where = (files: FilesByStorage, name: string) => Object.entries(files).find(([, list]) => list.includes(name))?.[0] ?? null;

function isoItem(e: Extract<LibraryEntry, { kind: "iso" }>, i: BuildInput): StoreItem {
  const latest = i.latest[e.id];
  // Anything on a drive that is some version of this installer counts as having it.
  const have = Object.entries(i.isoFiles).flatMap(([storage, list]) => list.flatMap((f) => { const m = matchesEntry(e, f); return m ? [{ storage, file: f, version: m.version }] : []; }));
  const exact = latest ? have.find((h) => h.file === latest.filename) : undefined;
  const any = exact ?? have[0];
  return {
    id: e.id, category: "os", name: e.name, vendor: e.vendor, summary: e.summary, kind: "iso", badge: "VM", lib: e,
    status: exact ? "installed" : any ? (latest ? "update" : "installed") : "available",
    latestVersion: latest?.version ?? null,
    haveVersion: any?.version ?? null,
    volid: any ? `${any.storage}:iso/${any.file}` : null,
  };
}

/** Everything the Store shows, with what's installed and what has an update, from what the drives and Proxmox say. */
export function buildStoreItems(i: BuildInput): StoreItem[] {
  const items: StoreItem[] = [];
  for (const e of LIBRARY) {
    if (e.kind === "iso") items.push(isoItem(e, i));
    else if (e.kind === "fixed") {
      const s = where(i.isoFiles, e.filename);
      items.push({ id: e.id, category: "tool", name: e.name, vendor: e.vendor, summary: e.summary, kind: "fixed", badge: null, lib: e, status: s ? "installed" : "available", latestVersion: null, haveVersion: null, volid: s ? `${s}:iso/${e.filename}` : null });
    } else items.push({ id: e.id, category: "os", name: e.name, vendor: e.vendor, summary: e.summary, kind: "manual", badge: "VM", lib: e, status: "manual", latestVersion: null, haveVersion: null, volid: null });
  }
  for (const t of i.catalog) {
    const s = where(i.tplFiles, t.template);
    const turnkey = t.section === "turnkeylinux";
    items.push({ id: `ct:${t.template}`, category: turnkey ? "app" : "os", name: t.headline ?? t.template, vendor: turnkey ? "TurnKey Linux" : (t.os ?? "Proxmox").replace(/^./, (c) => c.toUpperCase()), summary: t.description ?? (turnkey ? "A ready-to-run appliance in a container." : "A ready-made container system."), kind: "template", badge: "Container", template: t, status: s ? "installed" : "available", latestVersion: t.version, haveVersion: s ? t.version : null, volid: s ? `${s}:vztmpl/${t.template}` : null });
  }
  const known = new Set(PLUGINS.map((p) => p.id));
  for (const p of [...PLUGINS, ...(i.market ?? []).filter((m) => !known.has(m.id))]) {
    items.push({ id: p.id, category: "plugin", name: p.name, vendor: p.vendor, summary: p.summary, kind: p.kind, badge: p.kind === "connector" ? "Connector" : p.kind === "adapter" ? "Adapter" : "Skill", plugin: p, status: i.installedPlugins.has(p.id) ? "installed" : "available", latestVersion: p.version ?? null, haveVersion: null, volid: null });
  }
  return items;
}

export function filterItems(items: StoreItem[], category: Category | "home", query: string): StoreItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => (category === "home" || it.category === category) && (!q || `${it.name} ${it.vendor} ${it.summary}`.toLowerCase().includes(q)));
}

/** A steady colour for an item's tile, from its name. Identity only, never data. */
export function tileHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export const statusLabel = (s: StoreItem): string => (s.status === "installed" ? "Installed" : s.status === "update" ? "Update available" : s.status === "manual" ? "Bring your own ISO" : "Not installed");
