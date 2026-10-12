import { HttpError } from "../http.ts";
import { bad, confirmed, guarded, noExtra, query, resolveNode, seg, soft, str, type Deps, type Route } from "./nodeCommon.ts";
import { CRITICAL_SERVICES, packageName, packageVersion, SERVICE_ACTIONS, SERVICES, subscriptionKey, timezone } from "./nodeValidate.ts";

/** Node system: services, time, logs, power, subscription, updates and repositories. */

const intIn = (v: string | null, lo: number, hi: number, dflt: number, what: string): number => {
  if (v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : bad(`${what} must be a whole number from ${lo} to ${hi}`);
};

/** Kernel releases compare part by part: 6.8.12-4-pve is newer than 6.8.12-3-pve. */
export function kernelNewer(a: string, b: string): boolean {
  const parts = (s: string) => s.replace(/-pve.*$/, "").split(/[.-]/).map(Number);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
const KERNEL_PKG = /^(?:proxmox|pve)-kernel-(\d+\.\d+\.\d+-\d+-pve)(?:-signed)?$/;
const KERNEL_UPDATE = /^(?:(?:proxmox|pve)-kernel-\d|proxmox-default-kernel|proxmox-kernel-helper)/;

type Repo = { Enabled: boolean; URIs: string[]; Suites: string[]; Components?: string[]; Types: string[]; Comment?: string; FileType: string };
export type RepoKind = "enterprise" | "no-subscription" | "test" | "ceph-enterprise" | "ceph-no-subscription" | "ceph-test" | "debian" | "other";
export function repoKind(r: Pick<Repo, "URIs" | "Suites" | "Components">): RepoKind {
  const uri = r.URIs.join(" ");
  const comps = (r.Components ?? []).join(" ");
  const suites = r.Suites.join(" ");
  const ceph = /\/debian\/ceph/.test(uri);
  if (/enterprise\.proxmox\.com/.test(uri)) return ceph ? "ceph-enterprise" : "enterprise";
  if (/download\.proxmox\.com/.test(uri)) {
    const t = comps + " " + suites;
    if (/no-subscription/.test(t)) return ceph ? "ceph-no-subscription" : "no-subscription";
    if (/test/.test(t)) return ceph ? "ceph-test" : "test";
  }
  if (/debian\.org|deb\.debian/.test(uri)) return "debian";
  return "other";
}

export function systemRoutes(d: Deps): Route[] {
  return [
    // ---- Nodes in this datacenter
    {
      method: "GET",
      re: /^\/api\/node\/nodes$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const list = await pve.call<{ node: string; status: string; cpu?: number; maxcpu?: number; mem?: number; maxmem?: number; uptime?: number }[]>("GET", "/nodes");
          return list.map((n) => ({ node: n.node, online: n.status === "online", cpu: n.cpu ?? null, maxcpu: n.maxcpu ?? null, mem: n.mem ?? null, maxmem: n.maxmem ?? null, uptime: n.uptime ?? null })).sort((a, b) => a.node.localeCompare(b.node));
        });
        c.json(200, { local: c.node, nodes: out });
      },
    },

    // ---- Services
    {
      method: "GET",
      re: /^\/api\/node\/services$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const list = await pve.call<{ service: string; name?: string; desc?: string; state?: string; "active-state"?: string; "unit-state"?: string }[]>("GET", `/nodes/${seg(node)}/services`);
          return { node, services: list.map((s) => ({ service: s.service, name: s.name ?? s.service, description: s.desc ?? "", state: s.state ?? "unknown", activeState: s["active-state"] ?? null, unitState: s["unit-state"] ?? null, canControl: (SERVICES as readonly string[]).includes(s.service) })).sort((a, b) => a.name.localeCompare(b.name)) };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/services\/([\w.-]{1,64})\/(\w{1,10})$/,
      run: async (c, m) => {
        c.sameSite();
        const service = m[1];
        const action = m[2];
        if (!(SERVICES as readonly string[]).includes(service)) bad("Proxmox doesn't let you control that service from here");
        if (!(SERVICE_ACTIONS as readonly string[]).includes(action)) bad("An action is start, stop, restart or reload");
        const body = await c.readJson();
        noExtra(body, ["node", "confirm"]);
        // Stopping (or restarting) a service the node and cluster depend on needs the name typed.
        if (CRITICAL_SERVICES.has(service) && (action === "stop" || (action === "restart" && (service === "pve-cluster" || service === "corosync")))) confirmed(body, service, `${action} of ${service}`);
        const task = await c.asUser(async (pve) => pve.call<string>("POST", `/nodes/${seg(await resolveNode(c, pve, body))}/services/${seg(service)}/${action}`));
        c.json(202, { task });
      },
    },

    // ---- Time
    {
      method: "GET",
      re: /^\/api\/node\/time$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const t = await pve.call<{ time: number; localtime: number; timezone: string }>("GET", `/nodes/${seg(node)}/time`);
          return { node, time: t.time, localtime: t.localtime, timezone: t.timezone };
        });
        c.json(200, out);
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/time$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "timezone"]);
        const tz = timezone(body.timezone);
        await c.asUser(async (pve) => pve.call("PUT", `/nodes/${seg(await resolveNode(c, pve, body))}/time`, { timezone: tz }));
        c.json(200, { ok: true });
      },
    },

    // ---- Logs
    {
      method: "GET",
      re: /^\/api\/node\/logs\/syslog$/,
      run: async (c) => {
        const limit = intIn(query(c, "limit"), 1, 1000, 200, "The line count");
        const start = intIn(query(c, "start"), 0, 100_000_000, 0, "The start line");
        const date = (k: string) => {
          const v = query(c, k);
          if (v === null || v === "") return undefined;
          return /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(v) ? v : bad("Dates look like 2026-10-12 or 2026-10-12 08:30");
        };
        const service = query(c, "service") || undefined;
        if (service !== undefined && !/^[A-Za-z0-9@._:*-]{1,128}$/.test(service)) bad("That isn't a service name");
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const r = await pve.callFull<{ n: number; t: string }[]>("GET", `/nodes/${seg(node)}/syslog`, { limit, start, since: date("since"), until: date("until"), service });
          return { node, lines: (r.data ?? []).map((l) => ({ n: l.n, t: l.t })), total: typeof r.extra.total === "number" ? r.extra.total : null, start };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/logs\/journal$/,
      run: async (c) => {
        const lastentries = intIn(query(c, "lastentries"), 1, 2000, 500, "The line count");
        const epoch = (k: string) => {
          const v = query(c, k);
          return v === null || v === "" ? undefined : intIn(v, 1, 4_102_444_800, 0, k);
        };
        const unit = query(c, "unit") || undefined;
        if (unit !== undefined && !/^[A-Za-z0-9@._:\\-]{1,256}$/.test(unit)) bad("That isn't a unit name");
        const priority = query(c, "priority") || undefined;
        if (priority !== undefined && !/^[0-7](?:\.\.[0-7])?$/.test(priority)) bad("A priority is 0 (emergency) to 7 (debug), or a range such as 0..4");
        const since = epoch("since");
        const until = epoch("until");
        const range = since !== undefined || until !== undefined;
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const lines = await pve.call<string[]>("GET", `/nodes/${seg(node)}/journal`, { lastentries: range ? undefined : lastentries, since, until, unit, priority, kernel: query(c, "kernel") === "1" ? true : undefined });
          return { node, lines: (lines ?? []).filter((l) => typeof l === "string") };
        });
        c.json(200, out);
      },
    },

    // ---- Power
    {
      method: "GET",
      re: /^\/api\/node\/power$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const [res, nodes, cfg] = await Promise.all([soft(pve.clusterResources()), soft(pve.call<{ node: string; status: string }[]>("GET", "/nodes")), soft(pve.call<Record<string, unknown>>("GET", `/nodes/${seg(node)}/config`, { property: "wakeonlan" }))]);
          const running = (res.data ?? []).filter((g) => (g.type === "lxc" || g.type === "qemu") && g.status === "running" && (g.node ?? c.node) === node && g.template !== 1).map((g) => ({ vmid: g.vmid, name: g.name ?? `${g.type === "lxc" ? "CT" : "VM"} ${g.vmid}`, type: g.type }));
          const others = (nodes.data ?? []).filter((n) => n.node !== node).map((n) => ({ node: n.node, online: n.status === "online" }));
          return { node, local: node === c.node, thisService: c.node, running, runningUnknown: res.denied, wakeOnLan: typeof cfg.data?.wakeonlan === "string" && cfg.data.wakeonlan !== "" ? "configured" : "not set", others };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/power$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "command", "confirm"]);
        if (body.command !== "reboot" && body.command !== "shutdown") bad("The command is reboot or shutdown");
        await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          confirmed(body, node, `${body.command} of ${node}`);
          await pve.call("POST", `/nodes/${seg(node)}/status`, { command: body.command as string });
          return node;
        });
        const node = typeof body.node === "string" && body.node ? body.node : c.node;
        c.json(202, { ok: true, selfAffected: node === c.node });
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/wakeonlan$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node"]);
        const mac = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          if (node === c.node) bad("This node is already running");
          const list = await pve.call<{ node: string; status: string }[]>("GET", "/nodes");
          if (list.find((n) => n.node === node)?.status === "online") bad(`${node} is already online`);
          return pve.call<string>("POST", `/nodes/${seg(node)}/wakeonlan`);
        });
        c.json(202, { ok: true, mac: typeof mac === "string" ? mac : null });
      },
    },

    // ---- Subscription (the key is write-only: only its last four characters are ever returned)
    {
      method: "GET",
      re: /^\/api\/node\/subscription$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const s = await pve.call<Record<string, unknown>>("GET", `/nodes/${seg(node)}/subscription`);
          const key = typeof s.key === "string" ? s.key : "";
          return { node, status: s.status ?? "notfound", level: s.level ?? null, productName: s.productname ?? null, message: s.message ?? null, serverId: s.serverid ?? null, sockets: s.sockets ?? null, nextDueDate: s.nextduedate ?? null, registered: s.regdate ?? null, checkedAt: s.checktime ?? null, url: s.url ?? null, keyLast4: key ? key.slice(-4) : null };
        });
        c.json(200, out);
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/subscription$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "key"]);
        const key = subscriptionKey(body.key);
        await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          await guarded([key], () => pve.call("PUT", `/nodes/${seg(node)}/subscription`, { key }));
          // Proxmox only knows whether the key is valid after asking its servers.
          await guarded([key], () => pve.call("POST", `/nodes/${seg(node)}/subscription`, { force: true })).catch(() => {});
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/subscription\/check$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node"]);
        await c.asUser(async (pve) => pve.call("POST", `/nodes/${seg(await resolveNode(c, pve, body))}/subscription`, { force: true }));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/subscription$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "confirm"]);
        confirmed(body, "remove subscription", "removing the subscription key");
        await c.asUser(async (pve) => pve.call("DELETE", `/nodes/${seg(await resolveNode(c, pve, body))}/subscription`));
        c.json(200, { ok: true });
      },
    },

    // ---- Updates
    {
      method: "GET",
      re: /^\/api\/node\/updates$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const [upd, versions, status] = await Promise.all([
            soft(pve.call<Record<string, string>[]>("GET", `/nodes/${seg(node)}/apt/update`)),
            soft(pve.call<Record<string, string>[]>("GET", `/nodes/${seg(node)}/apt/versions`)),
            soft(pve.call<{ "current-kernel"?: { release?: string }; pveversion?: string }>("GET", `/nodes/${seg(node)}/status`)),
          ]);
          const packages = (upd.data ?? []).map((p) => ({ package: p.Package, title: p.Title ?? "", description: p.Description ?? "", oldVersion: p.OldVersion ?? null, version: p.Version, origin: p.Origin ?? "", priority: p.Priority ?? "", section: p.Section ?? "", arch: p.Arch ?? "" })).sort((a, b) => a.package.localeCompare(b.package));
          const running = status.data?.["current-kernel"]?.release ?? versions.data?.find((v) => v.RunningKernel)?.RunningKernel?.replace(/^Linux\s+/, "").split(" ")[0] ?? null;
          let newest: string | null = null;
          for (const v of versions.data ?? []) {
            const m = KERNEL_PKG.exec(v.Package ?? "");
            if (m && v.CurrentState === "Installed" && (!newest || kernelNewer(m[1], newest))) newest = m[1];
          }
          const runningRelease = running && /^\d+\.\d+\.\d+-\d+-pve/.test(running) ? running.match(/^\d+\.\d+\.\d+-\d+-pve/)![0] : null;
          return {
            node,
            packages,
            // Reading the list needs Sys.Modify in Proxmox, because it is the same call that refreshes the index.
            listDenied: upd.denied,
            listError: upd.error,
            version: status.data?.pveversion ?? null,
            runningKernel: running,
            newestInstalledKernel: newest,
            rebootRequired: !!(runningRelease && newest && kernelNewer(newest, runningRelease)),
            kernelUpdatePending: packages.some((p) => KERNEL_UPDATE.test(p.package)),
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/updates\/refresh$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node"]);
        const task = await c.asUser(async (pve) => pve.call<string>("POST", `/nodes/${seg(await resolveNode(c, pve, body))}/apt/update`, { notify: false, quiet: true }));
        c.json(202, { task });
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/updates\/changelog$/,
      run: async (c) => {
        const name = packageName(query(c, "name"));
        const v = query(c, "version");
        const version = v ? packageVersion(v) : undefined;
        const text = await c.asUser(async (pve) => pve.call<string>("GET", `/nodes/${seg(await resolveNode(c, pve))}/apt/changelog`, { name, version }));
        c.json(200, { package: name, version: version ?? null, text: typeof text === "string" ? text.slice(0, 200_000) : "" });
      },
    },

    // ---- Repositories
    {
      method: "GET",
      re: /^\/api\/node\/repos$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const [repos, sub] = await Promise.all([pve.call<Record<string, any>>("GET", `/nodes/${seg(node)}/apt/repositories`), soft(pve.call<{ status?: string }>("GET", `/nodes/${seg(node)}/subscription`))]);
          return { node, ...describeRepos(repos, sub.data?.status ?? null) };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/repos\/toggle$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "path", "index", "enabled", "digest"]);
        const path = str(body.path, 200);
        if (!path || !/^\/etc\/apt\/[A-Za-z0-9._/-]+$/.test(path) || path.includes("..")) bad("That isn't a repository file");
        if (typeof body.index !== "number" || !Number.isInteger(body.index) || body.index < 0 || body.index > 999) bad("That isn't a repository position");
        if (typeof body.enabled !== "boolean") bad("Say whether the repository is on or off");
        const digest = body.digest === undefined ? undefined : str(body.digest, 80) ?? bad("Bad digest");
        await c.asUser(async (pve) => pve.call("POST", `/nodes/${seg(await resolveNode(c, pve, body))}/apt/repositories`, { path, index: body.index as number, enabled: body.enabled as boolean, digest }));
        c.json(200, { ok: true });
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/repos\/add$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "handle", "digest"]);
        const handle = str(body.handle, 64);
        if (!handle || !/^[a-z0-9-]+$/.test(handle)) bad("That isn't a standard repository");
        const digest = body.digest === undefined ? undefined : str(body.digest, 80) ?? bad("Bad digest");
        await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const cur = await pve.call<{ "standard-repos"?: { handle: string }[] }>("GET", `/nodes/${seg(node)}/apt/repositories`);
          if (!(cur["standard-repos"] ?? []).some((r) => r.handle === handle)) bad("Proxmox doesn't offer that repository for this node");
          await pve.call("PUT", `/nodes/${seg(node)}/apt/repositories`, { handle, digest });
        });
        c.json(200, { ok: true });
      },
    },
    {
      // The one-click fix for "enterprise repository without a subscription": turn the enterprise repositories off and
      // make sure the no-subscription one is there and on. Each write needs the digest the last one produced.
      method: "POST",
      re: /^\/api\/node\/repos\/no-subscription$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node"]);
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const path = `/nodes/${seg(node)}/apt/repositories`;
          const read = () => pve.call<Record<string, any>>("GET", path);
          let cur = await read();
          const disabled: string[] = [];
          const todo: { path: string; index: number }[] = [];
          for (const f of cur.files ?? []) (f.repositories as Repo[]).forEach((r, index) => r.Enabled && repoKind(r) === "enterprise" && todo.push({ path: f.path, index }));
          for (const t of todo) {
            await pve.call("POST", path, { path: t.path, index: t.index, enabled: false, digest: cur.digest });
            disabled.push(t.path);
            cur = await read();
          }
          let added = false;
          const have = (cur.files ?? []).flatMap((f: any) => (f.repositories as Repo[]).map((r, index) => ({ r, index, path: f.path as string }))).find((x: any) => repoKind(x.r) === "no-subscription");
          if (!have) {
            if (!(cur["standard-repos"] ?? []).some((r: any) => r.handle === "no-subscription")) throw new HttpError(409, "no_handle", "Proxmox doesn't offer the no-subscription repository for this node");
            await pve.call("PUT", path, { handle: "no-subscription", digest: cur.digest });
            added = true;
          } else if (!have.r.Enabled) {
            await pve.call("POST", path, { path: have.path, index: have.index, enabled: true, digest: cur.digest });
            added = true;
          }
          return { disabledEnterprise: todo.length, noSubscriptionEnabled: added || !!have };
        });
        c.json(200, out);
      },
    },
  ];
}

export function describeRepos(raw: Record<string, any>, subscriptionStatus: string | null) {
  const repositories: { path: string; fileType: string; index: number; enabled: boolean; types: string[]; uris: string[]; suites: string[]; components: string[]; comment: string | null; kind: RepoKind }[] = [];
  for (const f of raw.files ?? []) (f.repositories as Repo[]).forEach((r, index) => repositories.push({ path: f.path, fileType: f["file-type"] ?? r.FileType, index, enabled: r.Enabled, types: r.Types ?? [], uris: r.URIs ?? [], suites: r.Suites ?? [], components: r.Components ?? [], comment: r.Comment ?? null, kind: repoKind(r) }));
  const warnings: { id: string; tone: "warning" | "info"; message: string; fix?: "no-subscription" }[] = [];
  const active = subscriptionStatus === "active";
  const enterpriseOn = repositories.some((r) => r.enabled && r.kind === "enterprise");
  if (enterpriseOn && !active) warnings.push({ id: "enterprise-no-subscription", tone: "warning", message: "The enterprise repository is on, but this node has no active subscription. Updates from it will fail until you add a subscription or switch to the no-subscription repository.", fix: "no-subscription" });
  if (!repositories.some((r) => r.enabled && (r.kind === "enterprise" || r.kind === "no-subscription" || r.kind === "test"))) warnings.push({ id: "no-pve-repo", tone: "warning", message: "No Proxmox VE repository is on, so this node won't receive Proxmox updates.", fix: active ? undefined : "no-subscription" });
  if (repositories.some((r) => r.enabled && r.kind === "no-subscription")) warnings.push({ id: "no-subscription-on", tone: "info", message: "The no-subscription repository is on. It is fine for testing and home use; Proxmox recommends the enterprise repository for production." });
  if (repositories.some((r) => r.enabled && r.kind === "test")) warnings.push({ id: "test-on", tone: "warning", message: "The test repository is on. Packages from it have had the least testing." });
  const infos = ((raw.infos ?? []) as { path?: string; index?: string; kind?: string; message?: string }[]).map((i) => ({ path: i.path ?? null, index: i.index ?? null, kind: i.kind ?? "info", message: i.message ?? "" }));
  const errors = ((raw.errors ?? []) as { path?: string; error?: string }[]).map((e) => ({ path: e.path ?? "", error: e.error ?? "" }));
  const standardRepos = ((raw["standard-repos"] ?? []) as { handle: string; name?: string; status?: number | boolean }[]).map((s) => ({ handle: s.handle, name: s.name ?? s.handle, status: s.status === undefined ? "missing" : s.status === true || s.status === 1 ? "enabled" : s.status === 0 || s.status === false ? "disabled" : String(s.status) }));
  return { digest: typeof raw.digest === "string" ? raw.digest : null, repositories, infos, errors, standardRepos, subscriptionStatus, warnings };
}
