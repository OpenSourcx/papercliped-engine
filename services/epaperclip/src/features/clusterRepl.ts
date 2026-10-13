import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { comment, flag, intIn, knownNodes, rate, replId, requireNode, schedule, seg, vmidOf } from "./clusterCommon.ts";
import { bad, confirmed, noExtra, query, soft, type Route } from "./nodeCommon.ts";

/**
 * Storage replication: copying a machine's disks to another node on a schedule, so a node that fails (or a planned
 * move) loses at most the last interval. Jobs are cluster configuration; their status lives on the node the machine
 * runs on. Removing a job also removes the copies on the target unless asked to keep them, so it needs the id typed.
 */

interface Guest {
  vmid: number;
  node: string;
  name: string;
  type: "qemu" | "lxc";
  template: boolean;
}

async function guests(pve: ProxmoxClient): Promise<Guest[]> {
  const all = await pve.call<Record<string, any>[]>("GET", "/cluster/resources", { type: "vm" });
  return all
    .filter((r) => (r.type === "qemu" || r.type === "lxc") && typeof r.vmid === "number")
    .map((r) => ({ vmid: r.vmid as number, node: String(r.node), name: String(r.name ?? r.vmid), type: r.type as "qemu" | "lxc", template: r.template === 1 }));
}

type Json = Record<string, any>;

function state(j: Json): string {
  if (j.remove_job) return "removing";
  if (flag(j.disable)) return "disabled";
  if (j.error) return "error";
  if (j.pid) return "syncing";
  if (!j.last_sync) return "pending";
  return "ok";
}

function mapJob(cfg: Json, status: Json | undefined, g: Guest | undefined) {
  const j = { ...cfg, ...status };
  return {
    id: String(cfg.id),
    guest: Number(cfg.guest ?? String(cfg.id).split("-")[0]),
    guestName: g?.name ?? null,
    guestType: g?.type ?? null,
    jobnum: Number(cfg.jobnum ?? String(cfg.id).split("-")[1]),
    source: String(j.source ?? g?.node ?? ""),
    target: String(cfg.target),
    schedule: String(cfg.schedule ?? "*/15"),
    rate: typeof cfg.rate === "number" ? cfg.rate : null,
    comment: (cfg.comment as string | undefined) ?? "",
    disabled: flag(cfg.disable),
    digest: (cfg.digest as string | undefined) ?? null,
    lastSync: typeof status?.last_sync === "number" && status.last_sync > 0 ? status.last_sync : null,
    lastTry: typeof status?.last_try === "number" && status.last_try > 0 ? status.last_try : null,
    nextSync: typeof status?.next_sync === "number" && status.next_sync > 0 ? status.next_sync : null,
    duration: typeof status?.duration === "number" ? status.duration : null,
    failCount: typeof status?.fail_count === "number" ? status.fail_count : 0,
    error: typeof status?.error === "string" && status.error ? status.error.slice(0, 600) : null,
    syncing: !!status?.pid,
    state: state(j),
  };
}

export function clusterReplRoutes(): Route[] {
  return [
    {
      method: "GET",
      re: /^\/api\/cluster\/replication$/,
      run: async (c) => {
        const only = query(c, "guest") ? vmidOf(query(c, "guest")) : undefined;
        const out = await c.asUser(async (pve) => {
          const [cfg, gs, nodes] = await Promise.all([soft(pve.call<Json[]>("GET", "/cluster/replication")), guests(pve), knownNodes(pve)]);
          if (cfg.denied) return { jobs: [], denied: true, guests: [], nodes: nodes.map((n) => ({ node: n.node, online: n.status === "online" })), statusUnavailable: [] as string[] };
          if (cfg.error) throw new HttpError(502, "proxmox_error", cfg.error);
          const jobs = (cfg.data ?? []).filter((j) => (only === undefined ? true : Number(j.guest) === only));
          const byGuest = new Map(gs.map((g) => [g.vmid, g]));
          const sources = [...new Set(jobs.map((j) => String(j.source ?? byGuest.get(Number(j.guest))?.node ?? "")).filter(Boolean))];
          const unavailable: string[] = [];
          const statuses = new Map<string, Json>();
          await Promise.all(sources.map(async (node) => {
            if (nodes.find((n) => n.node === node)?.status !== "online") return void unavailable.push(node);
            const r = await soft(pve.call<Json[]>("GET", `/nodes/${seg(node)}/replication`, only !== undefined ? { guest: only } : undefined));
            if (!r.data) return void unavailable.push(node);
            for (const s of r.data) statuses.set(String(s.id), s);
          }));
          return {
            jobs: jobs.map((j) => mapJob(j, statuses.get(String(j.id)), byGuest.get(Number(j.guest)))).sort((a, b) => a.guest - b.guest || a.jobnum - b.jobnum),
            denied: false,
            guests: gs.filter((g) => !g.template).map((g) => ({ vmid: g.vmid, name: g.name, node: g.node, type: g.type })).sort((a, b) => a.vmid - b.vmid),
            nodes: nodes.map((n) => ({ node: n.node, online: n.status === "online" })),
            statusUnavailable: unavailable,
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/replication$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(10_000);
        noExtra(body, ["guest", "target", "schedule", "rate", "comment", "disable"]);
        const vmid = vmidOf(body.guest);
        const out = await c.asUser(async (pve) => {
          const [gs, nodes, existing] = await Promise.all([guests(pve), knownNodes(pve), pve.call<Json[]>("GET", "/cluster/replication")]);
          const g = gs.find((x) => x.vmid === vmid);
          if (!g) throw new HttpError(404, "not_found", `There is no machine ${vmid} in this cluster`);
          if (g.template) throw new HttpError(409, "template", "Templates can't be replicated");
          const target = requireNode(body.target, nodes, "node");
          if (target === g.node) throw new HttpError(409, "same_node", `${g.name} runs on ${target}; replicate it to a different node`);
          if (nodes.find((n) => n.node === target)?.status !== "online") throw new HttpError(409, "node_offline", `${target} is offline`);
          const mine = existing.filter((j) => Number(j.guest) === vmid);
          if (mine.some((j) => j.target === target)) throw new HttpError(409, "duplicate", `${g.name} already replicates to ${target}`);
          const used = new Set(mine.map((j) => Number(j.jobnum)));
          let jobnum = 0;
          while (used.has(jobnum)) jobnum++;
          const id = `${vmid}-${jobnum}`;
          await pve.call("POST", "/cluster/replication", {
            id,
            type: "local",
            target,
            schedule: body.schedule === undefined || body.schedule === "" ? undefined : schedule(body.schedule),
            rate: body.rate === undefined || body.rate === null || body.rate === "" ? undefined : rate(body.rate),
            comment: body.comment ? comment(body.comment) : undefined,
            disable: body.disable === true ? true : undefined,
          });
          return { id };
        });
        c.json(200, out);
      },
    },
    {
      method: "PUT",
      re: /^\/api\/cluster\/replication\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const { id } = replId(decodeURIComponent(m[1]));
        const body = await c.readJson(10_000);
        noExtra(body, ["schedule", "rate", "comment", "disable", "digest"]);
        const digest = body.digest === undefined || body.digest === null ? undefined : typeof body.digest === "string" && body.digest.length <= 64 ? body.digest : bad("Bad digest");
        const set: Record<string, string | number | boolean> = {};
        const remove: string[] = [];
        if (body.schedule !== undefined) body.schedule === null || body.schedule === "" ? remove.push("schedule") : (set.schedule = schedule(body.schedule));
        if (body.rate !== undefined) body.rate === null || body.rate === "" ? remove.push("rate") : (set.rate = rate(body.rate));
        if (body.comment !== undefined) body.comment === null || body.comment === "" ? remove.push("comment") : (set.comment = comment(body.comment));
        if (body.disable !== undefined) {
          if (typeof body.disable !== "boolean") bad("Disabled is on or off");
          set.disable = body.disable;
        }
        if (!Object.keys(set).length && !remove.length) bad("Nothing to change");
        await c.asUser((pve) => pve.call("PUT", `/cluster/replication/${seg(id)}`, { ...set, delete: remove.length ? remove.join(",") : undefined, digest }));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/replication\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const { id } = replId(decodeURIComponent(m[1]));
        const body = await c.readJson();
        noExtra(body, ["confirm", "keep", "force"]);
        confirmed(body, id, `removing the replication job ${id}`);
        await c.asUser((pve) => pve.call("DELETE", `/cluster/replication/${seg(id)}`, { keep: body.keep === true ? true : undefined, force: body.force === true ? true : undefined }));
        c.json(200, { ok: true });
      },
    },
    {
      method: "POST",
      re: /^\/api\/cluster\/replication\/([^/]+)\/run-now$/,
      run: async (c, m) => {
        c.sameSite();
        const { id, vmid } = replId(decodeURIComponent(m[1]));
        await c.readJson();
        await c.asUser(async (pve) => {
          const node = await sourceOf(pve, id, vmid);
          await pve.call("POST", `/nodes/${seg(node)}/replication/${seg(id)}/schedule_now`);
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "GET",
      re: /^\/api\/cluster\/replication\/([^/]+)\/log$/,
      run: async (c, m) => {
        const { id, vmid } = replId(decodeURIComponent(m[1]));
        const start = query(c, "start") ? intIn(query(c, "start"), 0, 10_000_000, "start") : 0;
        const out = await c.asUser(async (pve) => {
          const node = await sourceOf(pve, id, vmid);
          const r = await pve.callFull<{ n: number; t: string }[]>("GET", `/nodes/${seg(node)}/replication/${seg(id)}/log`, { start, limit: 500 });
          const lines = (r.data ?? []).map((l) => l.t);
          return { node, lines, next: start + lines.length, total: typeof r.extra.total === "number" ? r.extra.total : null };
        });
        c.json(200, out);
      },
    },
  ];
}

/** The node that runs a job: where the machine lives (the job's own `source` once it has run). */
async function sourceOf(pve: ProxmoxClient, id: string, vmid: number): Promise<string> {
  const job = await pve.call<Json>("GET", `/cluster/replication/${seg(id)}`).catch((e: unknown) => {
    if (e instanceof ProxmoxError && e.status !== 401 && e.status !== 403) throw new HttpError(404, "not_found", `There is no replication job ${id}`);
    throw e;
  });
  if (typeof job.source === "string" && job.source) return job.source;
  const g = (await guests(pve)).find((x) => x.vmid === vmid);
  if (!g) throw new HttpError(404, "not_found", `There is no machine ${vmid} in this cluster`);
  return g.node;
}

