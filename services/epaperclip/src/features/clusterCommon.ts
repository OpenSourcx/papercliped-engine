import { isIP } from "node:net";
import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { bad } from "./nodeCommon.ts";
import { nodeName } from "./nodeValidate.ts";

/**
 * Checks shared by the cluster screens (cluster, HA, replication, migration, Ceph). Every rule here was taken from the
 * Proxmox API viewer data for the endpoint it guards; Proxmox still has the last word on values.
 */

export const seg = encodeURIComponent;

export const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const flag = (v: unknown): boolean => v === 1 || v === true || v === "1";

export function intIn(v: unknown, lo: number, hi: number, what: string): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi ? n : bad(`${what} must be a whole number from ${lo} to ${hi}`);
}

export const vmidOf = (v: unknown): number => intIn(v, 100, 999_999_999, "The machine number");

/** A comment: one line of up to `max` characters (Proxmox allows 4096). */
export function comment(v: unknown, max = 4096): string {
  if (typeof v !== "string" || v.length > max || /[\u0000-\u001f\u007f]/.test(v.replace(/\n/g, ""))) return bad(`Keep the note under ${max} characters`);
  return v;
}

/** Node names, checked against the cluster (a list from GET /nodes). */
export async function knownNodes(pve: ProxmoxClient): Promise<{ node: string; status: string }[]> {
  return pve.call<{ node: string; status: string }[]>("GET", "/nodes");
}
export function requireNode(v: unknown, known: { node: string }[], what = "node"): string {
  const name = nodeName(v);
  if (!known.some((n) => n.node === name)) throw new HttpError(404, "unknown_node", `This cluster has no ${what} called ${name}`);
  return name;
}

// ---- Corosync links (POST /cluster/config, POST /cluster/config/join): "[address=]<IP>[,priority=<0..255>]"

export interface LinkSpec {
  address: string;
  priority?: number;
}
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/;
export const isAddress = (v: unknown): v is string => typeof v === "string" && (isIP(v) !== 0 || HOSTNAME.test(v));

export function links(v: unknown, opts: { priority: boolean }): LinkSpec[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 8) return bad("A cluster can use up to 8 links");
  const out = v.map((raw, i) => {
    const l = asRecord(raw);
    for (const k of Object.keys(l)) if (k !== "address" && k !== "priority") bad(`Unknown field “${k}” in link ${i}`);
    if (!isAddress(l.address)) return bad(`Link ${i} needs an IP address (or a name that resolves to one)`);
    const priority = l.priority === undefined || l.priority === null || l.priority === "" ? undefined : intIn(l.priority, 0, 255, `The priority of link ${i}`);
    if (priority !== undefined && !opts.priority) bad("Link priority only applies when creating a cluster");
    return { address: l.address, priority };
  });
  if (new Set(out.map((l) => l.address)).size !== out.length) bad("Each link needs its own address");
  return out;
}
export const linkParams = (list: LinkSpec[]): Record<string, string> =>
  Object.fromEntries(list.map((l, i) => [`link${i}`, l.priority !== undefined ? `${l.address},priority=${l.priority}` : l.address]));

// ---- High availability

export const HA_SID = /^(vm|ct):([1-9]\d{2,8})$/;
export function haSid(v: unknown): { sid: string; type: "vm" | "ct"; vmid: number } {
  const m = typeof v === "string" ? v.match(HA_SID) : null;
  if (!m) return bad("An HA resource is written vm:100 or ct:100");
  return { sid: v as string, type: m[1] as "vm" | "ct", vmid: Number(m[2]) };
}
export function haSidList(v: unknown, what = "resources"): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!list || list.length < 1 || list.length > 100) return bad(`Pick between 1 and 100 ${what}`);
  const out = list.map((x) => haSid(typeof x === "string" ? x.trim() : x).sid);
  if (new Set(out).size !== out.length) bad(`Each of the ${what} can be listed once`);
  return out;
}

export interface HaNodeSpec {
  node: string;
  priority?: number;
}
/** pve-ha-node-list: <node>[:<pri>]{,<node>[:<pri>]}*, nodes known to the cluster. */
export function haNodes(v: unknown, known: { node: string }[]): HaNodeSpec[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 64) return bad("Pick at least one node");
  const out = v.map((raw) => {
    const n = asRecord(raw);
    for (const k of Object.keys(n)) if (k !== "node" && k !== "priority") bad(`Unknown field “${k}” in a node`);
    const node = requireNode(n.node, known);
    const priority = n.priority === undefined || n.priority === null || n.priority === "" ? undefined : intIn(n.priority, 0, 1000, "A priority");
    return { node, priority };
  });
  if (new Set(out.map((n) => n.node)).size !== out.length) bad("Each node can be listed once");
  return out;
}
export const haNodeString = (list: HaNodeSpec[]): string => list.map((n) => (n.priority !== undefined ? `${n.node}:${n.priority}` : n.node)).join(",");
export function parseHaNodes(v: unknown): HaNodeSpec[] {
  if (typeof v !== "string" || !v) return [];
  return v.split(",").map((x) => {
    const [node, pri] = x.split(":");
    return { node, priority: pri === undefined || pri === "" ? undefined : Number(pri) };
  });
}

// ---- Replication

/** <guest>-<jobnum> */
export function replId(v: unknown): { id: string; vmid: number } {
  const m = typeof v === "string" ? v.match(/^([1-9]\d{2,8})-(\d{1,9})$/) : null;
  if (!m) return bad("That isn't a replication job id (it looks like 100-0)");
  return { id: v as string, vmid: Number(m[1]) };
}

/** Proxmox's replication schedules are a subset of systemd calendar events; Proxmox checks the exact grammar. */
export function schedule(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 128 || !/^[\w :.,*/~-]+$/.test(v)) return bad("Enter when it runs, like */15, hourly, daily or mon..fri 02:00");
  return v.trim();
}

/** Bandwidth limit in MB/s, at least 1 (Proxmox's `rate`). */
export function rate(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 1_000_000 ? v : bad("The rate limit is a number of MB/s, at least 1");
}

// ---- Migration

const STORAGE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,254}$/;
/** storage-pair-list: a single storage id, or <source>:<target>{,<source>:<target>}*; "1" means identity mapping. */
export function storagePairs(v: unknown): string {
  if (typeof v !== "string" || !v || v.length > 1024) return bad("Pick the storage to migrate to");
  if (v === "1") return v;
  const parts = v.split(",");
  for (const p of parts) {
    const ids = p.split(":");
    if (ids.length > 2 || ids.some((id) => !STORAGE_ID.test(id))) return bad("Storage mappings are written source:target, separated by commas");
  }
  return v;
}

export function cidr(v: unknown): string {
  if (typeof v !== "string" || v.length > 64) return bad("Enter the migration network as an address and prefix, like 10.0.0.0/24");
  const [addr, len, ...rest] = v.split("/");
  const max = isIP(addr) === 6 ? 128 : 32;
  return rest.length === 0 && isIP(addr) !== 0 && /^\d{1,3}$/.test(len ?? "") && Number(len) <= max ? v : bad("Enter the migration network as an address and prefix, like 10.0.0.0/24");
}

// ---- Errors in words

/** Whether a Proxmox failure means "this isn't set up", which a screen reports calmly instead of as an error. */
export function notConfigured(e: unknown, words: RegExp): boolean {
  return e instanceof ProxmoxError && e.status !== 401 && e.status !== 403 && words.test(`${e.detail ?? ""} ${e.message}`);
}
/** Whether this Proxmox lacks the endpoint (an older version). */
export const notImplemented = (e: unknown): boolean => e instanceof ProxmoxError && (e.status === 501 || e.status === 404 || /not implemented/i.test(e.detail ?? ""));
export const major = (version: string | null | undefined): number | null => {
  const m = version?.match(/^(\d+)\./);
  return m ? Number(m[1]) : null;
};
