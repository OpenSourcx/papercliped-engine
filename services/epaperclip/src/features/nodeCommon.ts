import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import type { FeatureCtx } from "./index.ts";
import type { TlsReloader } from "./nodeTls.ts";
import { nodeName, scrub } from "./nodeValidate.ts";

export interface Route {
  method: string;
  re: RegExp;
  run(c: FeatureCtx, m: RegExpMatchArray): Promise<void>;
}

export interface Deps {
  tls: TlsReloader;
  /** How often to look at a running Proxmox task that will change the certificate. */
  pollMs: number;
}

export const seg = encodeURIComponent;
export const query = (c: FeatureCtx, k: string) => c.url.searchParams.get(k);

/** The node a request is about: the one named in the body or query, checked against the cluster, else this node. */
export async function resolveNode(c: FeatureCtx, pve: ProxmoxClient, body?: Record<string, unknown>): Promise<string> {
  const raw = body?.node ?? query(c, "node");
  if (raw === undefined || raw === null || raw === "") return c.node;
  const name = nodeName(raw);
  if (name === c.node) return name;
  const known = await pve.call<{ node: string }[]>("GET", "/nodes");
  if (!known.some((n) => n.node === name)) throw new HttpError(404, "unknown_node", `This cluster has no node called ${name}`);
  return name;
}

/** A read that may be refused for this person: the page shows what it can and says what it couldn't read. */
export async function soft<T>(p: Promise<T>): Promise<{ data: T | null; denied: boolean; error: string | null }> {
  try {
    return { data: await p, denied: false, error: null };
  } catch (e) {
    if (e instanceof ProxmoxError && e.status === 403) return { data: null, denied: true, error: null };
    if (e instanceof ProxmoxError) return { data: null, denied: false, error: (e.detail ?? "Proxmox couldn't answer").slice(0, 300) };
    throw e;
  }
}

/** Runs a call that carries secrets; Proxmox's error text is stripped of them before anything can show it. */
export async function guarded<T>(secrets: (string | undefined)[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProxmoxError && e.status === 403) throw e;
    if (e instanceof ProxmoxError) {
      const detail = e.detail ? scrub(e.detail, secrets) : null;
      throw new ProxmoxError("Proxmox refused the request", e.status, detail);
    }
    throw e;
  }
}

/** Typed confirmation: the person has to type the thing they are about to remove or interrupt. */
export function confirmed(body: Record<string, unknown>, phrase: string, what: string): void {
  if (body.confirm !== phrase) throw new HttpError(400, "confirm", `Type “${phrase}” to confirm ${what}`);
}

export const str = (v: unknown, max = 256): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

export function bad(message: string): never {
  throw new HttpError(400, "bad_request", message);
}

export function noExtra(body: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) bad(`Unknown field “${k}”`);
}
