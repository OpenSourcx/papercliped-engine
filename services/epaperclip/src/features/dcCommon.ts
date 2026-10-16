import { HttpError } from "../http.ts";
import type { Schema } from "./nodeSchema.ts";
import { checkGroup, type Checked } from "./nodeValidate.ts";

/**
 * Shared checks for the backup, SDN, mapping and hardware routes. `checkGroup` (nodeValidate.ts) validates against
 * Proxmox's own parameter definitions; the formats it doesn't know by name (vmid lists, calendar events, addresses…)
 * are checked here, so nothing odd reaches Proxmox.
 */

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9A-Fa-f:]{2,39}$/;
export const isIp = (s: string) => IPV4.test(s) || (IPV6.test(s) && s.includes(":"));
export const isCidr = (s: string) => {
  const [ip, len, extra] = s.split("/");
  if (extra !== undefined || ip === undefined || len === undefined || !/^\d{1,3}$/.test(len)) return false;
  return IPV4.test(ip) ? Number(len) <= 32 : isIp(ip) && Number(len) <= 128;
};
export const NODE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/;
export const STORAGE_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
/** 100–999999999, listed with commas (Proxmox accepts spaces too, but nothing here needs them). */
export const vmidList = (s: string) => s.split(",").every((x) => /^\d{3,9}$/.test(x.trim()) && Number(x) >= 100);

const FORMATS: Record<string, (s: string) => string | null> = {
  "pve-vmid-list": (s) => (vmidList(s) ? null : "must be machine numbers separated by commas"),
  "pve-storage-id": (s) => (STORAGE_ID.test(s) ? null : "isn't a storage name"),
  "pve-node-list": (s) => (s.split(",").every((n) => NODE_NAME.test(n)) ? null : "must be node names separated by commas"),
  "pve-node": (s) => (NODE_NAME.test(s) ? null : "isn't a node name"),
  "pve-calendar-event": (s) => (/^[A-Za-z0-9:*,./ -]{1,128}$/.test(s) ? null : "isn't a calendar event such as mon..fri 02:00"),
  ip: (s) => (isIp(s) ? null : "must be an IP address"),
  "ip-list": (s) => (s.split(",").every((x) => isIp(x.trim())) ? null : "must be IP addresses separated by commas"),
  "mac-addr": (s) => (/^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/.test(s) ? null : "must look like BC:24:11:AA:BB:CC"),
  "dns-name": (s) => (/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(s) ? null : "must be a domain name"),
  "pve-iface-list": (s) => (s.split(",").every((x) => /^[A-Za-z][A-Za-z0-9._-]{0,14}$/.test(x.trim())) ? null : "must be interface names separated by commas"),
  "pve-sdn-bgp-rt-list": (s) => (s.split(",").every((x) => /^\d{1,10}:\d{1,10}$/.test(x.trim())) ? null : "must look like 65000:100"),
  "pve-sdn-fabric-id": (s) => (/^[A-Za-z0-9_-]{1,32}$/.test(s) ? null : "isn't a fabric name"),
  "pve-sdn-route-map-id": (s) => (/^[A-Za-z0-9_-]{1,32}$/.test(s) ? null : "isn't a route map name"),
  "pve-sdn-isis-net": (s) => (/^[0-9a-f]{2}(?:\.[0-9a-f]{4}){3,}\.00$/i.test(s) ? null : "must look like 49.0001.1921.6800.1002.00"),
  "pve-configid": (s) => (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(s) ? null : "isn't a valid name"),
};

/** Validates `input` against a schema, then the named formats Proxmox's definitions mention. */
export function checkDc(schema: Schema, input: Record<string, unknown>, opts: { creating?: boolean; skip?: string[] } = {}): Checked {
  const out = checkGroup(schema, input, opts);
  for (const [k, v] of Object.entries(out.params)) {
    const fmt = schema[k]?.format;
    const check = fmt ? FORMATS[fmt] : undefined;
    if (!check) continue;
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) {
      const why = check(String(item));
      if (why) throw new HttpError(400, "bad_request", `${k} ${why}`);
    }
  }
  return out;
}

/** An id Proxmox accepts for an SDN object, mapping or job. */
export function objectId(v: unknown, what: string, re = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/): string {
  if (typeof v !== "string" || !re.test(v)) throw new HttpError(400, "bad_request", `The ${what} must start with a letter and use letters, numbers, - and _`);
  return v;
}

export const asNumber = (v: unknown, what: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, "bad_request", `${what} must be a whole number from ${min} to ${max}`);
  return v;
};

/** Booleans the browser sends become 1/0 for Proxmox. */
export const flag = (v: unknown): 1 | 0 | undefined => (v === true ? 1 : v === false ? 0 : undefined);

/** Turns the standard "values" body into Proxmox parameters (adds the delete list for cleared settings). */
export function withDelete(checked: Checked, extra: Record<string, unknown> = {}): Record<string, string | number | boolean | string[] | undefined> {
  return { ...checked.params, ...extra, delete: checked.remove.length ? checked.remove.join(",") : undefined } as Record<string, string | number | boolean | string[] | undefined>;
}
