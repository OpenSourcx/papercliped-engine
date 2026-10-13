import type { IncomingMessage } from "node:http";
import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";

/**
 * The node selector for the screens that were built for one device (machines, storage, network, firewall, backups,
 * tasks, host figures). The console sends the node it is managing in the `X-EPC-Node` header; the host service checks
 * it against the cluster once (cached for 30 seconds per sign-in) and the existing routes read it through `of(req)`.
 * Without the header, or with this device's own name, nothing changes.
 */
export const NODE_HEADER = "x-epc-node";
const NODE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/;
const TTL_MS = 30_000;

export class NodeScope {
  private readonly chosen = new WeakMap<IncomingMessage, string>();
  private readonly cache = new Map<string, { at: number; nodes: Set<string> }>();

  private readonly local: string;
  private readonly now: () => number;

  constructor(local: string, now: () => number) {
    this.local = local;
    this.now = now;
  }

  /** The node this request is about: the one named in the header (once resolved), else this device. */
  of(req: IncomingMessage): string {
    return this.chosen.get(req) ?? this.local;
  }

  /** Validates the header against the cluster. Throws 400 for a malformed name and 404 for one the cluster doesn't have. */
  async resolve(req: IncomingMessage, sessionId: string, pve: () => Promise<ProxmoxClient>): Promise<void> {
    const raw = req.headers[NODE_HEADER];
    if (raw === undefined) return;
    const name = Array.isArray(raw) ? raw[0] : raw;
    if (!NODE_RE.test(name)) throw new HttpError(400, "bad_request", "That isn't a node name");
    if (name === this.local) return;
    let entry = this.cache.get(sessionId);
    if (!entry || this.now() - entry.at > TTL_MS) {
      const list = await (await pve()).call<{ node: string }[]>("GET", "/nodes");
      entry = { at: this.now(), nodes: new Set(list.map((n) => n.node)) };
      this.cache.set(sessionId, entry);
      if (this.cache.size > 500) for (const k of this.cache.keys()) { this.cache.delete(k); break; }
    }
    if (!entry.nodes.has(name)) throw new HttpError(404, "unknown_node", `This cluster has no node called ${name}`);
    this.chosen.set(req, name);
  }
}
