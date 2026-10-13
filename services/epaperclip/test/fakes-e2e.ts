import { randomBytes } from "node:crypto";
import type { Transport } from "@papercliped-engine/proxmox-client";
import { fakeCluster } from "./fakes-cluster.ts";
import { fakeDisks } from "./fakes-disks.ts";
import { fakeGuest } from "./fakes-guest.ts";
import { fakeNodePve } from "./fakes-node.ts";
import { fakePinPve } from "./fakes-pin.ts";
import { fakeWizard } from "./fakes-wizard.ts";

/**
 * One Proxmox for the end-to-end run (scripts/e2e-real-engine.mts). The separate fakes each cover one area and were
 * written to be used alone; this puts them behind one router so a single sign-in, one set of users and one ACL list
 * serve every screen:
 *
 *   - access and pools         the access fake (users, groups, roles, ACLs, tokens, pools) through Pin's, so the
 *                              ACLs that Integrated Access Control writes are the ones every other screen reads
 *   - machines (list)          Pin's three machines plus whatever the wizard created, with their pool
 *   - power and snapshots      Pin's fake (privilege checks, task list), for Pin's machines
 *   - machine page, disks,     the guest, disks and wizard fakes, layered
 *     wizard
 *   - cluster, HA, Ceph        the cluster fake (three nodes, one offline)
 *   - node, datacenter         the node fake, which has its own users, so tickets are translated per user
 *
 * Nothing here is a real Proxmox. The areas stay as faithful as the fakes they reuse (docs/E2E.md lists what that means).
 */

type Req = Parameters<Transport>[0];
type Res = Awaited<ReturnType<Transport>>;

const ok = (data: unknown): Res => ({ status: 200, body: JSON.stringify({ data }) });
const ticketOf = (req: Req) => decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", ""));

export function fakeE2ePve(opts: { clustered?: boolean } = {}) {
  const pin = fakePinPve();
  const wizard = fakeWizard(pin.transport);
  const disks = fakeDisks(wizard.transport);
  const guest = fakeGuest(disks.transport);
  const cluster = fakeCluster({ single: opts.clustered === false }, guest.transport);
  const node = fakeNodePve();

  // The guests every screen shows: Pin's, registered with the machine page's fake so their pages open.
  for (const [vmid, g] of pin.guests) {
    if (guest.guests.has(vmid)) continue;
    guest.guests.set(vmid, { type: g.type, name: g.name, status: g.status, pending: {}, cfg: g.type === "lxc" ? { hostname: g.name, cores: 2, memory: Math.round(g.maxmem / 1048576), swap: 512, unprivileged: 1, net0: "name=eth0,bridge=vmbr0,ip=dhcp,type=veth", rootfs: "local-lvm:vm-" + vmid + "-disk-0,size=8G", tags: g.tags } : { name: g.name, cores: 2, memory: Math.round(g.maxmem / 1048576), net0: "virtio=BC:24:11:AA:BB:" + String(vmid % 100).padStart(2, "0") + ",bridge=vmbr0", scsi0: "local-lvm:vm-" + vmid + "-disk-0,size=32G", tags: g.tags } });
  }
  const pinOwned = new Set(pin.guests.keys());

  const nodeTickets = new Map<string, string>();
  const nodeLogin = async (user: string): Promise<string | null> => {
    const have = nodeTickets.get(user);
    if (have) return have;
    const [name, realm] = user.split("@");
    const r = await node.transport({ method: "POST", url: "https://pve.test/api2/json/access/ticket", headers: {}, body: new URLSearchParams({ username: name, realm, password: "right" }).toString() });
    if (r.status !== 200) return null;
    const t = (JSON.parse(r.body).data?.ticket as string | undefined) ?? null;
    if (t) nodeTickets.set(user, t);
    return t;
  };

  const registerCreated = (type: "qemu" | "lxc", p: Record<string, string>) => {
    const vmid = Number(p.vmid);
    const name = p.name ?? p.hostname ?? `${type}-${vmid}`;
    guest.guests.set(vmid, { type, name, status: "stopped", pool: p.pool || undefined, pending: {}, cfg: { ...(type === "lxc" ? { hostname: name } : { name }), cores: Number(p.cores ?? 1), memory: Number(p.memory ?? 512), ...(p.net0 ? { net0: p.net0 } : {}), ...(p.tags ? { tags: p.tags } : {}) } });
    if (p.pool) pin.pools.get(p.pool)?.vms.add(vmid);
  };

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = decodeURIComponent(u.pathname.replace("/api2/json", ""));
    const m = req.method;
    const q = u.searchParams;

    if (path === "/access/ticket") return pin.transport(req);
    if (/^\/(access|pools)(\/|$)/.test(path)) return pin.transport(req);

    if (/^\/(nodes\/pve\/(services|time|syslog|journal|config|subscription|apt|certificates)|cluster\/(acme|notifications|metrics|options))(\/|$)/.test(path)) {
      const user = ticketOf(req).split(":")[1] ?? "";
      const t = ticketOf(req) && (await pin.transport({ ...req, method: "GET", url: `${u.origin}/api2/json/version`, body: undefined })).status === 200 ? await nodeLogin(user) : null;
      if (!t) return { status: 401, body: "" };
      return node.transport({ ...req, headers: { ...req.headers, Cookie: `PVEAuthCookie=${encodeURIComponent(t)}` } });
    }

    if (path === "/cluster/resources" && !q.get("type")) return pin.transport(req);
    if (path === "/cluster/resources" && q.get("type") === "vm") {
      const mine = await pin.transport(req);
      if (mine.status !== 200) return mine;
      const rows = JSON.parse(mine.body).data as Record<string, unknown>[];
      const who = pin.privs;
      void who;
      for (const [vmid, g] of guest.guests) {
        if (pinOwned.has(vmid) || vmid < 300 || [300, 301, 302, 303].includes(vmid)) continue;
        rows.push({ id: `${g.type}/${vmid}`, type: g.type, vmid, node: "pve", name: g.name, status: g.status, mem: 0, maxmem: Number(g.cfg.memory ?? 512) * 1048576, cpu: 0, maxcpu: Number(g.cfg.cores ?? 1), disk: 0, maxdisk: 8 * 1024 ** 3, tags: String(g.cfg.tags ?? ""), pool: g.pool });
      }
      return ok(rows);
    }
    if (path === "/cluster/resources" && q.get("type") === "storage") return disks.transport(req);

    if (m === "POST" && /^\/nodes\/pve\/(lxc|qemu)\/(\d+)\/(status\/(start|stop|shutdown|reboot)|snapshot)/.test(path) && pinOwned.has(Number(path.split("/")[4]))) return pin.transport(req);
    if (m === "GET" && /^\/nodes\/pve\/(lxc|qemu)\/(\d+)\/snapshot$/.test(path) && pinOwned.has(Number(path.split("/")[4]))) return pin.transport(req);

    const r = await cluster.transport(req);
    if (m === "POST" && /^\/nodes\/pve\/(qemu|lxc)$/.test(path) && r.status === 200) {
      const p = Object.fromEntries(new URLSearchParams(req.body ?? ""));
      registerCreated(path.endsWith("/qemu") ? "qemu" : "lxc", p);
    }
    return r;
  };

  return { transport, pin, wizard, disks, guest, cluster, node, acl: pin.acl, pools: pin.pools, users: pin.users, tokens: pin.tokens, calls: pin.calls };
}

// ---- A model provider that follows a script

export interface ProviderScript {
  /** Every request the host sent to a provider, in order. */
  asked: { url: string; method: string; body: string }[];
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** What Pin should do next time a person's message arrives. */
  next: "orgs" | "plan" | "text";
  /** Parameters of the plan Pin proposes when next is "plan". */
  plan: Record<string, unknown> | null;
}

const sse = (events: { event?: string; data: unknown }[]) =>
  new Response(events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });

const textTurn = (text: string) =>
  sse([
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
  ]);
const toolTurn = (name: string, input: unknown) => {
  const id = "toolu_" + randomBytes(6).toString("hex");
  return sse([
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" } } },
  ]);
};

/** A stand-in for the Anthropic API that answers Pin's models list, test request and streamed chat turns by script. */
export function scriptedProvider(): ProviderScript {
  const script: ProviderScript = {
    asked: [],
    next: "orgs",
    plan: null,
    fetch: async (url, init) => {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? init.body : "";
      script.asked.push({ url, method, body });
      if (!url.startsWith("https://api.anthropic.com/v1/")) return new Response("{}", { status: 404 });
      if (method === "GET") return new Response(JSON.stringify({ data: [{ id: "model-fast", display_name: "Fast" }, { id: "model-thorough", display_name: "Thorough" }] }), { status: 200 });
      const req = JSON.parse(body) as { stream?: boolean; messages: { role: string; content: unknown }[] };
      if (!req.stream) return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
      const last = req.messages.at(-1)!;
      const results = Array.isArray(last.content) ? (last.content as { type: string; content?: string }[]).filter((c) => c.type === "tool_result") : [];
      if (results.length) {
        // Hand back what the tool returned, so the run proves what Pin saw.
        const seen = results.map((r) => String(r.content ?? "")).join(" | ");
        return textTurn(`Pin saw: ${seen.slice(0, 1500)}`);
      }
      const asked = script.next;
      if (asked === "plan" && script.plan) return toolTurn("propose_plan", script.plan);
      if (asked === "orgs") return toolTurn("list_organizations", {});
      return textTurn("All quiet on this node.");
    },
  };
  return script;
}
