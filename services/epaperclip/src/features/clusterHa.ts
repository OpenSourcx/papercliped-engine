import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { asRecord, comment, flag, haNodes, haNodeString, haSid, haSidList, intIn, knownNodes, major, notImplemented, parseHaNodes, requireNode, seg } from "./clusterCommon.ts";
import { bad, confirmed, noExtra, type Route } from "./nodeCommon.ts";
import { configId } from "./nodeValidate.ts";

/**
 * High availability: the resources the HA manager keeps running, how it decides where (groups on older Proxmox,
 * rules on newer), the manager's status, and fencing. Which of groups and rules exists is decided by asking this
 * Proxmox, not by guessing from its version number. Every change needs the page's digest so a change made elsewhere
 * in the meantime is refused instead of overwritten.
 */

const STATES = ["started", "stopped", "enabled", "disabled", "ignored"] as const;
const FENCING = ["watchdog", "hardware", "both"] as const;

interface Probe<T> {
  data: T | null;
  supported: boolean;
  denied: boolean;
}
/** A standalone host answers the HA calls with a 500 that says there is no cluster; that is "not available here", not a failure. */
const noCluster = (e: unknown): boolean => e instanceof ProxmoxError && e.status === 500 && /corosync|no such cluster|not (part of )?a cluster|cluster not ready|no quorum/i.test(e.detail ?? "");
async function probe<T>(p: Promise<T>): Promise<Probe<T>> {
  try {
    return { data: await p, supported: true, denied: false };
  } catch (e) {
    if (e instanceof ProxmoxError && e.status === 403) return { data: null, supported: true, denied: true };
    if (notImplemented(e) || noCluster(e)) return { data: null, supported: false, denied: false };
    throw e;
  }
}

const toList = (v: unknown): string[] => (typeof v === "string" && v ? v.split(",").map((x) => x.trim()).filter(Boolean) : Array.isArray(v) ? v.map(String) : []);

async function support(pve: ProxmoxClient) {
  const rules = await probe(pve.call<Record<string, any>[]>("GET", "/cluster/ha/rules"));
  return { rules };
}

/** Finds the machine for an HA resource id, cluster-wide. */
async function findGuest(pve: ProxmoxClient, sid: ReturnType<typeof haSid>) {
  const all = await pve.call<Record<string, any>[]>("GET", "/cluster/resources", { type: "vm" });
  const g = all.find((r) => r.vmid === sid.vmid);
  if (!g || (g.type !== "lxc" && g.type !== "qemu")) throw new HttpError(404, "not_found", `There is no machine ${sid.vmid} in this cluster`);
  if ((sid.type === "ct") !== (g.type === "lxc")) throw new HttpError(400, "bad_request", `${sid.vmid} is ${g.type === "lxc" ? "a container, so use ct:" : "a virtual machine, so use vm:"}${sid.vmid}`);
  if (g.template === 1) throw new HttpError(409, "template", "A template can't be an HA resource");
  return g;
}

function mapResource(r: Record<string, any>, guests: Map<number, Record<string, any>>, status: Map<string, Record<string, any>>) {
  const m = String(r.sid).match(/^(vm|ct):(\d+)$/);
  const vmid = m ? Number(m[2]) : null;
  const g = vmid ? guests.get(vmid) : undefined;
  const s = status.get(`service:${r.sid}`);
  return {
    sid: String(r.sid),
    type: (m?.[1] ?? r.type) as string,
    vmid,
    name: (g?.name as string | undefined) ?? null,
    node: (s?.node ?? g?.node ?? null) as string | null,
    state: String(r.state ?? "started"),
    group: (r.group as string | undefined) ?? null,
    maxRestart: typeof r.max_restart === "number" ? r.max_restart : null,
    maxRelocate: typeof r.max_relocate === "number" ? r.max_relocate : null,
    failback: r.failback === undefined ? null : flag(r.failback),
    autoRebalance: r["auto-rebalance"] === undefined ? null : flag(r["auto-rebalance"]),
    comment: (r.comment as string | undefined) ?? "",
    digest: (r.digest as string | undefined) ?? null,
    current: (s?.state ?? s?.crm_state ?? null) as string | null,
    status: (s?.status ?? null) as string | null,
  };
}

export function clusterHaRoutes(): Route[] {
  return [
    {
      method: "GET",
      re: /^\/api\/cluster\/ha$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const [version, resources, status, manager, groups, sup, options, nodes, vms] = await Promise.all([
            pve.version().catch(() => null),
            probe(pve.call<Record<string, any>[]>("GET", "/cluster/ha/resources")),
            probe(pve.call<Record<string, any>[]>("GET", "/cluster/ha/status/current")),
            probe(pve.call<Record<string, any>>("GET", "/cluster/ha/status/manager_status")),
            probe(pve.call<Record<string, any>[]>("GET", "/cluster/ha/groups")),
            support(pve),
            probe(pve.call<Record<string, any>>("GET", "/cluster/options")),
            knownNodes(pve),
            pve.call<Record<string, any>[]>("GET", "/cluster/resources", { type: "vm" }).catch(() => [] as Record<string, any>[]),
          ]);
          const rulesSupported = sup.rules.supported;
          const rules = rulesSupported && sup.rules.data
            ? await Promise.all(sup.rules.data.map(async (r) => {
                const full = await pve.call<Record<string, any>>("GET", `/cluster/ha/rules/${seg(String(r.rule))}`).catch(() => r);
                return mapRule({ ...r, ...full });
              }))
            : [];
          const guests = new Map(vms.filter((g) => typeof g.vmid === "number").map((g) => [g.vmid as number, g]));
          const entries = status.data ?? [];
          const byId = new Map(entries.map((e) => [String(e.id), e]));
          const fencingEntry = entries.find((e) => e.type === "fencing");
          const opts = asRecord(options.data);
          const fencingMode = (FENCING as readonly string[]).includes(String(opts.fencing)) ? String(opts.fencing) : "watchdog";
          const quorum = entries.find((e) => e.type === "quorum");
          const master = entries.find((e) => e.type === "master");
          const mgr = asRecord(manager.data);
          return {
            pveVersion: version?.version ?? null,
            pveMajor: major(version?.version),
            mode: rulesSupported ? "rules" : "groups",
            rulesSupported,
            groupsSupported: groups.supported,
            denied: resources.denied || status.denied,
            available: resources.supported,
            resources: (resources.data ?? []).map((r) => mapResource(r, guests, byId)).sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0)),
            groups: (groups.data ?? []).map((g) => ({ group: String(g.group), nodes: parseHaNodes(g.nodes), restricted: flag(g.restricted), nofailback: flag(g.nofailback), comment: (g.comment as string | undefined) ?? "", digest: (g.digest as string | undefined) ?? null })),
            rules,
            status: {
              quorate: quorum ? flag(quorum.quorate) : null,
              quorumText: (quorum?.status as string | undefined) ?? null,
              master: master ? { node: String(master.node), status: String(master.status ?? ""), timestamp: master.timestamp ?? null } : null,
              lrms: entries.filter((e) => e.type === "lrm").map((e) => ({ node: String(e.node), status: String(e.status ?? ""), mode: (e.mode as string | undefined) ?? null, timestamp: e.timestamp ?? null })),
              armedState: (fencingEntry?.["armed-state"] as string | undefined) ?? null,
              resourceMode: (fencingEntry?.resource_mode as string | undefined) ?? null,
              managerNode: (mgr.manager_status as any)?.master_node ?? null,
            },
            fencing: { mode: fencingMode, armed: fencingEntry ? fencingEntry["armed-state"] ?? null : null, canArm: !!fencingEntry },
            nodes: nodes.map((n) => ({ node: n.node, online: n.status === "online" })),
          };
        });
        c.json(200, out);
      },
    },
    {
      // The HA state of one machine, for the machine page.
      method: "GET",
      re: /^\/api\/cluster\/ha\/guest\/(\d+)$/,
      run: async (c, m) => {
        const vmid = intIn(m[1], 100, 999_999_999, "The machine number");
        const out = await c.asUser(async (pve) => {
          const [resources, status] = await Promise.all([probe(pve.call<Record<string, any>[]>("GET", "/cluster/ha/resources")), probe(pve.call<Record<string, any>[]>("GET", "/cluster/ha/status/current"))]);
          const r = (resources.data ?? []).find((x) => new RegExp(`^(vm|ct):${vmid}$`).test(String(x.sid)));
          if (!r) return { available: resources.supported, managed: false, sid: null, state: null, current: null, group: null };
          const s = (status.data ?? []).find((e) => e.id === `service:${r.sid}`);
          return { available: true, managed: true, sid: String(r.sid), state: String(r.state ?? "started"), current: (s?.state as string | undefined) ?? null, group: (r.group as string | undefined) ?? null };
        });
        c.json(200, out);
      },
    },

    // ---- Resources
    {
      method: "POST",
      re: /^\/api\/cluster\/ha\/resources$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(20_000);
        noExtra(body, ["sid", "state", "group", "maxRestart", "maxRelocate", "failback", "autoRebalance", "comment"]);
        const sid = haSid(body.sid);
        const out = await c.asUser(async (pve) => {
          await findGuest(pve, sid);
          const sup = await support(pve);
          const params = await resourceParams(pve, body, sup.rules.supported, false);
          await pve.call("POST", "/cluster/ha/resources", { sid: sid.sid, ...params.set });
          return { ok: true };
        });
        c.json(200, out);
      },
    },
    {
      method: "PUT",
      re: /^\/api\/cluster\/ha\/resources\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const sid = haSid(decodeURIComponent(m[1]));
        const body = await c.readJson(20_000);
        noExtra(body, ["state", "group", "maxRestart", "maxRelocate", "failback", "autoRebalance", "comment", "digest"]);
        const digest = body.digest === undefined || body.digest === null ? undefined : typeof body.digest === "string" && body.digest.length <= 64 ? body.digest : bad("Bad digest");
        await c.asUser(async (pve) => {
          const sup = await support(pve);
          const params = await resourceParams(pve, body, sup.rules.supported, true);
          if (!Object.keys(params.set).length && !params.remove.length) bad("Nothing to change");
          await pve.call("PUT", `/cluster/ha/resources/${seg(sid.sid)}`, { ...params.set, delete: params.remove.length ? params.remove.join(",") : undefined, digest });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/ha\/resources\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const sid = haSid(decodeURIComponent(m[1]));
        await c.readJson();
        await c.asUser((pve) => pve.call("DELETE", `/cluster/ha/resources/${seg(sid.sid)}`));
        c.json(200, { ok: true });
      },
    },
    {
      // migrate keeps the machine running (online); relocate stops it here and starts it on the target.
      method: "POST",
      re: /^\/api\/cluster\/ha\/resources\/([^/]+)\/(migrate|relocate)$/,
      run: async (c, m) => {
        c.sameSite();
        const sid = haSid(decodeURIComponent(m[1]));
        const body = await c.readJson();
        noExtra(body, ["node"]);
        await c.asUser(async (pve) => {
          const known = await knownNodes(pve);
          const node = requireNode(body.node, known);
          if (known.find((n) => n.node === node)?.status !== "online") throw new HttpError(409, "node_offline", `${node} is offline`);
          const r = await pve.call<Record<string, any>[]>("GET", "/cluster/ha/status/current").catch(() => [] as Record<string, any>[]);
          const here = r.find((e) => e.id === `service:${sid.sid}`)?.node;
          if (here === node) throw new HttpError(409, "same_node", `${sid.sid} is already on ${node}`);
          await pve.call("POST", `/cluster/ha/resources/${seg(sid.sid)}/${m[2]}`, { node });
        });
        c.json(200, { ok: true, queued: true });
      },
    },

    // ---- Groups (older Proxmox; deprecated where rules exist)
    {
      method: "POST",
      re: /^\/api\/cluster\/ha\/groups$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(20_000);
        noExtra(body, ["group", "nodes", "restricted", "nofailback", "comment"]);
        const group = configId(body.group, "group name");
        await c.asUser(async (pve) => {
          const nodes = haNodes(body.nodes, await knownNodes(pve));
          await pve.call("POST", "/cluster/ha/groups", { group, nodes: haNodeString(nodes), restricted: body.restricted === true ? true : undefined, nofailback: body.nofailback === true ? true : undefined, comment: body.comment ? comment(body.comment) : undefined });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/cluster\/ha\/groups\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const group = configId(decodeURIComponent(m[1]), "group name");
        const body = await c.readJson(20_000);
        noExtra(body, ["nodes", "restricted", "nofailback", "comment", "digest"]);
        const digest = body.digest === undefined || body.digest === null ? undefined : typeof body.digest === "string" && body.digest.length <= 64 ? body.digest : bad("Bad digest");
        await c.asUser(async (pve) => {
          const params: Record<string, string | boolean | undefined> = {};
          const remove: string[] = [];
          if (body.nodes !== undefined) params.nodes = haNodeString(haNodes(body.nodes, await knownNodes(pve)));
          for (const k of ["restricted", "nofailback"] as const) if (body[k] !== undefined) params[k] = body[k] === true;
          if (body.comment !== undefined) body.comment === null || body.comment === "" ? remove.push("comment") : (params.comment = comment(body.comment));
          if (!Object.keys(params).length && !remove.length) bad("Nothing to change");
          await pve.call("PUT", `/cluster/ha/groups/${seg(group)}`, { ...params, delete: remove.length ? remove.join(",") : undefined, digest });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/ha\/groups\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const group = configId(decodeURIComponent(m[1]), "group name");
        const body = await c.readJson();
        confirmed(body, group, `deleting the group ${group}`);
        await c.asUser(async (pve) => {
          const used = (await pve.call<Record<string, any>[]>("GET", "/cluster/ha/resources").catch(() => [])).filter((r) => r.group === group).map((r) => String(r.sid));
          if (used.length) throw new HttpError(409, "in_use", `${used.join(", ")} still ${used.length === 1 ? "uses" : "use"} the group ${group}. Move ${used.length === 1 ? "it" : "them"} to another group first.`);
          await pve.call("DELETE", `/cluster/ha/groups/${seg(group)}`);
        });
        c.json(200, { ok: true });
      },
    },

    // ---- Rules (newer Proxmox)
    {
      method: "POST",
      re: /^\/api\/cluster\/ha\/rules$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(30_000);
        noExtra(body, ["rule", "type", "resources", "nodes", "strict", "affinity", "comment", "disable"]);
        const rule = configId(body.rule, "rule name");
        const type = body.type === "node-affinity" || body.type === "resource-affinity" ? body.type : bad("A rule is node-affinity or resource-affinity");
        await c.asUser(async (pve) => {
          const sup = await support(pve);
          if (!sup.rules.supported) throw new HttpError(409, "unsupported", "This Proxmox uses HA groups; it has no HA rules");
          const params = await ruleParams(pve, type, body, true);
          await pve.call("POST", "/cluster/ha/rules", { rule, type, ...params.set });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/cluster\/ha\/rules\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const rule = configId(decodeURIComponent(m[1]), "rule name");
        const body = await c.readJson(30_000);
        noExtra(body, ["type", "resources", "nodes", "strict", "affinity", "comment", "disable", "digest"]);
        const digest = body.digest === undefined || body.digest === null ? undefined : typeof body.digest === "string" && body.digest.length <= 64 ? body.digest : bad("Bad digest");
        await c.asUser(async (pve) => {
          // The rule's type is Proxmox's, not ours: it picks which settings apply.
          const current = await pve.call<Record<string, any>>("GET", `/cluster/ha/rules/${seg(rule)}`);
          const type = current.type === "node-affinity" || current.type === "resource-affinity" ? (current.type as "node-affinity" | "resource-affinity") : bad("Proxmox didn't say what kind of rule this is");
          if (body.type !== undefined && body.type !== type) throw new HttpError(409, "type", "A rule's type can't be changed; create a new rule instead");
          const params = await ruleParams(pve, type, body, false);
          if (!Object.keys(params.set).length && !params.remove.length) bad("Nothing to change");
          await pve.call("PUT", `/cluster/ha/rules/${seg(rule)}`, { type, ...params.set, delete: params.remove.length ? params.remove.join(",") : undefined, digest });
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/cluster\/ha\/rules\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const rule = configId(decodeURIComponent(m[1]), "rule name");
        await c.readJson();
        await c.asUser((pve) => pve.call("DELETE", `/cluster/ha/rules/${seg(rule)}`));
        c.json(200, { ok: true });
      },
    },

    // ---- Arm and disarm (releases the watchdogs cluster-wide)
    {
      method: "POST",
      re: /^\/api\/cluster\/ha\/arm$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["action", "resourceMode", "confirm"]);
        if (body.action !== "arm" && body.action !== "disarm") bad("The action is arm or disarm");
        if (body.action === "disarm") {
          confirmed(body, "disarm", "disarming high availability");
          if (body.resourceMode !== "freeze" && body.resourceMode !== "ignore") bad("Choose what happens to HA machines while disarmed: freeze or ignore");
        }
        await c.asUser(async (pve) => {
          try {
            if (body.action === "arm") await pve.call("POST", "/cluster/ha/status/arm-ha");
            else await pve.call("POST", "/cluster/ha/status/disarm-ha", { "resource-mode": body.resourceMode as string });
          } catch (e) {
            if (notImplemented(e)) throw new HttpError(409, "unsupported", "This Proxmox can't disarm high availability");
            throw e;
          }
        });
        c.json(200, { ok: true });
      },
    },
  ];
}

function mapRule(r: Record<string, any>) {
  return {
    rule: String(r.rule),
    type: String(r.type ?? "node-affinity"),
    resources: toList(r.resources),
    nodes: parseHaNodes(r.nodes),
    strict: r.strict === undefined ? null : flag(r.strict),
    affinity: (r.affinity as string | undefined) ?? null,
    comment: (r.comment as string | undefined) ?? "",
    disabled: flag(r.disable),
    digest: (r.digest as string | undefined) ?? null,
    state: (r.state as string | undefined) ?? null,
  };
}

/** Settings for an HA resource. On edit, null clears a setting; booleans that Proxmox 8 doesn't know are refused. */
async function resourceParams(pve: ProxmoxClient, body: Record<string, unknown>, rules: boolean, editing: boolean) {
  const set: Record<string, string | number | boolean> = {};
  const remove: string[] = [];
  if (body.state !== undefined) {
    if (!(STATES as readonly unknown[]).includes(body.state)) bad("The requested state is started, stopped, disabled or ignored");
    set.state = body.state as string;
  }
  if (body.group !== undefined) {
    if (body.group === null || body.group === "") {
      if (editing) remove.push("group");
    } else {
      const group = configId(body.group, "group name");
      const groups = await pve.call<Record<string, any>[]>("GET", "/cluster/ha/groups").catch(() => []);
      if (!groups.some((g) => g.group === group)) throw new HttpError(404, "unknown_group", `There is no HA group called ${group}`);
      set.group = group;
    }
  }
  for (const [key, wire] of [["maxRestart", "max_restart"], ["maxRelocate", "max_relocate"]] as const) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === "") {
      if (editing) remove.push(wire);
    } else set[wire] = intIn(body[key], 0, 100, key === "maxRestart" ? "Restart attempts" : "Relocate attempts");
  }
  for (const [key, wire] of [["failback", "failback"], ["autoRebalance", "auto-rebalance"]] as const) {
    if (body[key] === undefined) continue;
    if (!rules) throw new HttpError(409, "unsupported", "This Proxmox doesn't have that setting");
    if (body[key] === null) {
      if (editing) remove.push(wire);
    } else if (typeof body[key] === "boolean") set[wire] = body[key] as boolean;
    else bad(`${key} is on or off`);
  }
  if (body.comment !== undefined) {
    if (body.comment === null || body.comment === "") {
      if (editing) remove.push("comment");
    } else set.comment = comment(body.comment);
  }
  return { set, remove };
}

async function ruleParams(pve: ProxmoxClient, type: "node-affinity" | "resource-affinity", body: Record<string, unknown>, creating: boolean) {
  const set: Record<string, string | boolean> = {};
  const remove: string[] = [];
  if (body.resources !== undefined || creating) set.resources = haSidList(body.resources).join(",");
  if (type === "resource-affinity" && typeof set.resources === "string" && set.resources.split(",").length < 2) bad("A resource affinity rule needs at least two resources");
  if (type === "node-affinity") {
    if (body.nodes !== undefined || creating) set.nodes = haNodeString(haNodes(body.nodes, await knownNodes(pve)));
    if (body.strict !== undefined) {
      if (typeof body.strict !== "boolean") bad("Strict is on or off");
      set.strict = body.strict;
    }
  } else {
    if (body.nodes !== undefined) bad("A resource affinity rule has no nodes");
    if (body.strict !== undefined) bad("Strict only applies to node affinity rules");
  }
  if (body.affinity !== undefined || (creating && type === "resource-affinity")) {
    if (body.affinity !== "positive" && body.affinity !== "negative") bad("Affinity is positive or negative");
    set.affinity = body.affinity;
  }
  if (body.disable !== undefined) {
    if (typeof body.disable !== "boolean") bad("Disabled is on or off");
    set.disable = body.disable;
  }
  if (body.comment !== undefined) {
    if (body.comment === null || body.comment === "") {
      if (!creating) remove.push("comment");
    } else set.comment = comment(body.comment);
  }
  return { set, remove };
}

