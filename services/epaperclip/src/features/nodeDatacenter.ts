import { bad, confirmed, guarded, noExtra, query, resolveNode, seg, soft, str, type Deps, type Route } from "./nodeCommon.ts";
import { SCHEMAS, type Schema } from "./nodeSchema.ts";
import { checkGroup, configId, nodeName, parseProps, readGroup, upid } from "./nodeValidate.ts";

/** Datacenter: options, notifications, metric servers, resource mappings, tags, the cluster summary and tasks. */

const MASK = "••••";
/** http://user:password@host:port/ — the password is hidden on the way out and left alone when it comes back masked. */
const maskProxy = (v: unknown) => (typeof v === "string" ? v.replace(/^(https?:\/\/[^:@/]+):[^@/]*@/, `$1:${MASK}@`) : v);

const NOTIFY_TYPES = ["sendmail", "gotify", "smtp", "webhook"] as const;
type NotifyType = (typeof NOTIFY_TYPES)[number];
const notifyType = (v: string): NotifyType => ((NOTIFY_TYPES as readonly string[]).includes(v) ? (v as NotifyType) : bad("A notification target is sendmail, gotify, smtp or webhook"));

const TAG = /^[a-z0-9_][a-z0-9_.+-]{0,63}$/i;
const HEX = /^[0-9a-fA-F]{6}$/;

const secretNames = (schema: Schema) => Object.entries(schema).filter(([, f]) => f.secret).map(([k]) => k);

/** Secrets never leave the host service: webhook secret entries are reduced to their names. */
function readTarget(type: NotifyType, raw: Record<string, unknown>) {
  const schema = SCHEMAS[type];
  const values = readGroup(schema, raw);
  const secrets = secretNames(schema).filter((k) => raw[k] !== undefined && raw[k] !== "");
  if (type === "webhook") {
    const names = (list: unknown) => (Array.isArray(list) ? list.map((x) => String(x).match(/name=([^,]+)/)?.[1]).filter((x): x is string => !!x) : []);
    values.header = names(raw.header);
    values.secret = names(raw.secret);
  }
  return { type, values, digest: typeof raw.digest === "string" ? raw.digest : null, secretsSet: secrets };
}

export function datacenterRoutes(_d: Deps): Route[] {
  return [
    // ---- Options
    {
      method: "GET",
      re: /^\/api\/node\/datacenter\/options$/,
      run: async (c) => {
        const raw = await c.asUser((pve) => pve.call<Record<string, unknown>>("GET", "/cluster/options"));
        const values = readGroup(SCHEMAS.clusterOptions, raw);
        if (values.http_proxy) values.http_proxy = maskProxy(values.http_proxy);
        c.json(200, { values, schema: SCHEMAS.clusterOptions });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/datacenter\/options$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(200_000);
        noExtra(body, ["values"]);
        const input = { ...((body.values ?? {}) as Record<string, unknown>) };
        if (typeof input.http_proxy === "string" && input.http_proxy.includes(MASK)) delete input.http_proxy;
        const { params, remove } = checkGroup(SCHEMAS.clusterOptions, input);
        const nextId = parseProps(params["next-id"]);
        if (nextId.lower && nextId.upper && Number(nextId.lower) >= Number(nextId.upper)) bad("The lowest machine number must be below the highest");
        if (!Object.keys(params).length && !remove.length) bad("Nothing to change");
        await c.asUser((pve) => guarded([typeof input.http_proxy === "string" ? input.http_proxy : undefined], () => pve.call("PUT", "/cluster/options", { ...params, delete: remove.join(",") || undefined })));
        c.json(200, { ok: true });
      },
    },

    // ---- Notifications
    {
      method: "GET",
      re: /^\/api\/node\/datacenter\/notifications$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const [targets, matchers] = await Promise.all([soft(pve.call<Record<string, any>[]>("GET", "/cluster/notifications/targets")), soft(pve.call<Record<string, any>[]>("GET", "/cluster/notifications/matchers"))]);
          return {
            targets: (targets.data ?? []).map((t) => ({ name: t.name, type: t.type, comment: t.comment ?? "", disabled: t.disable === 1 || t.disable === true, builtin: t.origin === "builtin" })),
            matchers: (matchers.data ?? []).map((m) => ({ name: m.name, comment: m.comment ?? "", disabled: m.disable === 1 || m.disable === true, mode: m.mode ?? "all", targets: m.target ?? [], severities: m["match-severity"] ?? [], builtin: m.origin === "builtin" })),
            denied: targets.denied || matchers.denied,
            schemas: { sendmail: SCHEMAS.sendmail, gotify: SCHEMAS.gotify, smtp: SCHEMAS.smtp, webhook: SCHEMAS.webhook, matcher: SCHEMAS.matcher },
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/datacenter\/notifications\/targets\/(\w+)\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        const type = notifyType(m[1]);
        const name = configId(m[2]);
        const raw = await c.asUser((pve) => pve.call<Record<string, unknown>>("GET", `/cluster/notifications/endpoints/${type}/${seg(name)}`));
        c.json(200, { name, ...readTarget(type, raw) });
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/datacenter\/notifications\/targets\/(\w+)$/,
      run: async (c, m) => {
        c.sameSite();
        const type = notifyType(m[1]);
        const body = await c.readJson(200_000);
        const name = configId(body.name, "target name");
        const { params } = checkGroup(SCHEMAS[type], (body.values ?? {}) as Record<string, unknown>, { creating: true });
        await c.asUser((pve) => guarded(secretNames(SCHEMAS[type]).map((k) => String(params[k] ?? "")), () => pve.call("POST", `/cluster/notifications/endpoints/${type}`, { name, ...params })));
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/datacenter\/notifications\/targets\/(\w+)\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const type = notifyType(m[1]);
        const name = configId(m[2]);
        const body = await c.readJson(200_000);
        noExtra(body, ["values", "digest"]);
        const { params, remove } = checkGroup(SCHEMAS[type], (body.values ?? {}) as Record<string, unknown>);
        const digest = body.digest === undefined || body.digest === null ? undefined : str(body.digest, 64) ?? bad("Bad digest");
        await c.asUser((pve) => guarded(secretNames(SCHEMAS[type]).map((k) => String(params[k] ?? "")), () => pve.call("PUT", `/cluster/notifications/endpoints/${type}/${seg(name)}`, { ...params, delete: remove.length ? remove : undefined, digest })));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/datacenter\/notifications\/targets\/(\w+)\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const type = notifyType(m[1]);
        const name = configId(m[2]);
        const body = await c.readJson();
        confirmed(body, name, `deleting the target ${name}`);
        await c.asUser((pve) => pve.call("DELETE", `/cluster/notifications/endpoints/${type}/${seg(name)}`));
        c.json(200, { ok: true });
      },
    },
    {
      // Sends a test notification through the target. Proxmox answers once it has been handed over (or refuses with why).
      method: "POST",
      re: /^\/api\/node\/datacenter\/notifications\/targets\/([A-Za-z][\w-]{1,63})\/test$/,
      run: async (c, m) => {
        c.sameSite();
        await c.readJson();
        await c.asUser((pve) => pve.call("POST", `/cluster/notifications/targets/${seg(configId(m[1]))}/test`));
        c.json(200, { ok: true });
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/datacenter\/notifications\/matchers\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        const name = configId(m[1]);
        const raw = await c.asUser((pve) => pve.call<Record<string, unknown>>("GET", `/cluster/notifications/matchers/${seg(name)}`));
        c.json(200, { name, values: readGroup(SCHEMAS.matcher, raw), digest: typeof raw.digest === "string" ? raw.digest : null });
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/datacenter\/notifications\/matchers$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(200_000);
        const name = configId(body.name, "matcher name");
        const { params } = checkGroup(SCHEMAS.matcher, (body.values ?? {}) as Record<string, unknown>, { creating: true });
        await c.asUser((pve) => pve.call("POST", "/cluster/notifications/matchers", { name, ...params }));
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/datacenter\/notifications\/matchers\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const name = configId(m[1]);
        const body = await c.readJson(200_000);
        noExtra(body, ["values", "digest"]);
        const { params, remove } = checkGroup(SCHEMAS.matcher, (body.values ?? {}) as Record<string, unknown>);
        const digest = body.digest === undefined || body.digest === null ? undefined : str(body.digest, 64) ?? bad("Bad digest");
        await c.asUser((pve) => pve.call("PUT", `/cluster/notifications/matchers/${seg(name)}`, { ...params, delete: remove.length ? remove : undefined, digest }));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/datacenter\/notifications\/matchers\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const name = configId(m[1]);
        confirmed(await c.readJson(), name, `deleting the matcher ${name}`);
        await c.asUser((pve) => pve.call("DELETE", `/cluster/notifications/matchers/${seg(name)}`));
        c.json(200, { ok: true });
      },
    },

    // ---- Metric servers (the InfluxDB token is write-only)
    {
      method: "GET",
      re: /^\/api\/node\/datacenter\/metrics$/,
      run: async (c) => {
        const list = await c.asUser((pve) => pve.call<Record<string, any>[]>("GET", "/cluster/metrics/server"));
        c.json(200, { servers: list.map((s) => ({ id: s.id, type: s.type, server: s.server, port: s.port, disabled: s.disable === 1 || s.disable === true })), schema: SCHEMAS.metricServer });
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/datacenter\/metrics\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        const id = configId(m[1]);
        const raw = await c.asUser((pve) => pve.call<Record<string, unknown>>("GET", `/cluster/metrics/server/${seg(id)}`));
        c.json(200, { id, values: readGroup(SCHEMAS.metricServer, raw), hasToken: typeof raw.token === "string" && raw.token !== "", digest: typeof raw.digest === "string" ? raw.digest : null });
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/datacenter\/metrics$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(100_000);
        const id = configId(body.id, "server name");
        const { params } = checkGroup(SCHEMAS.metricServer, (body.values ?? {}) as Record<string, unknown>, { creating: true });
        await c.asUser((pve) => guarded([String(params.token ?? ""), String(params["otel-headers"] ?? "")], () => pve.call("POST", `/cluster/metrics/server/${seg(id)}`, params)));
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/datacenter\/metrics\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const id = configId(m[1]);
        const body = await c.readJson(100_000);
        noExtra(body, ["values", "digest"]);
        const { params, remove } = checkGroup(SCHEMAS.metricServer, (body.values ?? {}) as Record<string, unknown>, { skip: ["type"] });
        const digest = body.digest === undefined || body.digest === null ? undefined : str(body.digest, 64) ?? bad("Bad digest");
        await c.asUser((pve) => guarded([String(params.token ?? ""), String(params["otel-headers"] ?? "")], () => pve.call("PUT", `/cluster/metrics/server/${seg(id)}`, { ...params, delete: remove.join(",") || undefined, digest })));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/datacenter\/metrics\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const id = configId(m[1]);
        confirmed(await c.readJson(), id, `deleting the metric server ${id}`);
        await c.asUser((pve) => pve.call("DELETE", `/cluster/metrics/server/${seg(id)}`));
        c.json(200, { ok: true });
      },
    },

    // ---- Resource mappings (read only here)
    {
      method: "GET",
      re: /^\/api\/node\/datacenter\/mappings$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const one = async (kind: "pci" | "usb" | "dir") => {
            const r = await soft(pve.call<Record<string, any>[]>("GET", `/cluster/mapping/${kind}`));
            return { denied: r.denied, items: (r.data ?? []).map((x) => ({ id: x.id, description: x.description ?? "", map: (Array.isArray(x.map) ? x.map : []).map(String), problems: [...(Array.isArray(x.checks) ? x.checks.map((k: any) => String(k.message ?? k)) : []), ...(x.error ? [String(x.error)] : [])] })) };
          };
          const [pci, usb, dir] = await Promise.all([one("pci"), one("usb"), one("dir")]);
          return { pci, usb, dir };
        });
        c.json(200, out);
      },
    },

    // ---- Tags: colors and who may set which
    {
      method: "GET",
      re: /^\/api\/node\/datacenter\/tags$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const [opts, res] = await Promise.all([soft(pve.call<Record<string, unknown>>("GET", "/cluster/options")), soft(pve.call<{ tags?: string }[]>("GET", "/cluster/resources", { type: "vm" }))]);
          const style = parseProps(opts.data?.["tag-style"], SCHEMAS.clusterOptions["tag-style"]);
          const colors = new Map<string, { background: string; foreground: string | null }>();
          for (const e of (style["color-map"] ?? "").split(";")) {
            const [tag, bg, fg] = e.split(":");
            if (tag && bg) colors.set(tag.toLowerCase(), { background: bg.toLowerCase(), foreground: fg?.toLowerCase() ?? null });
          }
          const counts = new Map<string, number>();
          for (const r of res.data ?? []) for (const t of (r.tags ?? "").split(/[;,\s]+/).filter(Boolean)) counts.set(t.toLowerCase(), (counts.get(t.toLowerCase()) ?? 0) + 1);
          const registered = new Set(String(opts.data?.["registered-tags"] ?? "").split(";").filter(Boolean).map((t) => t.toLowerCase()));
          const all = new Set([...counts.keys(), ...colors.keys(), ...registered]);
          return {
            tags: [...all].sort().map((tag) => ({ tag, count: counts.get(tag) ?? 0, color: colors.get(tag) ?? null, registered: registered.has(tag) })),
            style: { shape: style.shape ?? "circle", ordering: style.ordering ?? "alphabetical", caseSensitive: style["case-sensitive"] === "1" },
            denied: opts.denied,
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/datacenter\/tags$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["colors", "shape", "ordering"]);
        const colors = (body.colors ?? {}) as Record<string, unknown>;
        if (typeof colors !== "object" || Array.isArray(colors) || Object.keys(colors).length > 500) bad("Colors are a map of tag to color");
        await c.asUser(async (pve) => {
          const opts = await pve.call<Record<string, unknown>>("GET", "/cluster/options");
          const style = parseProps(opts["tag-style"], SCHEMAS.clusterOptions["tag-style"]);
          const map = new Map<string, string>();
          for (const e of (style["color-map"] ?? "").split(";")) {
            const [tag, ...rest] = e.split(":");
            if (tag && rest.length) map.set(tag, rest.join(":"));
          }
          for (const [tag, v] of Object.entries(colors)) {
            if (!TAG.test(tag)) bad(`“${tag}” isn't a valid tag`);
            if (v === null) map.delete(tag);
            else {
              const o = v as { background?: unknown; foreground?: unknown };
              if (typeof o.background !== "string" || !HEX.test(o.background) || (o.foreground != null && (typeof o.foreground !== "string" || !HEX.test(o.foreground)))) bad("Colors are six hex digits such as 3366ff");
              map.set(tag, o.foreground ? `${o.background}:${o.foreground}` : o.background);
            }
          }
          const next: Record<string, string> = { ...style };
          if (map.size) next["color-map"] = [...map].map(([t, v]) => `${t}:${v}`).join(";");
          else delete next["color-map"];
          if (body.shape !== undefined) next.shape = ["full", "circle", "dense", "none"].includes(body.shape as string) ? (body.shape as string) : bad("A shape is full, circle, dense or none");
          if (body.ordering !== undefined) next.ordering = ["config", "alphabetical"].includes(body.ordering as string) ? (body.ordering as string) : bad("An order is config or alphabetical");
          const value = Object.entries(next).map(([k, v]) => `${k}=${v}`).join(",");
          await pve.call("PUT", "/cluster/options", value ? { "tag-style": value } : { delete: "tag-style" });
        });
        c.json(200, { ok: true });
      },
    },

    // ---- Cluster summary (works for one node and for many)
    {
      method: "GET",
      re: /^\/api\/node\/cluster$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const [status, nodesRes, vms, version, nodeList] = await Promise.all([
            soft(pve.call<Record<string, any>[]>("GET", "/cluster/status")),
            soft(pve.call<Record<string, any>[]>("GET", "/cluster/resources", { type: "node" })),
            soft(pve.call<Record<string, any>[]>("GET", "/cluster/resources", { type: "vm" })),
            soft(pve.version()),
            pve.call<{ node: string; status: string; cpu?: number; maxcpu?: number; mem?: number; maxmem?: number; uptime?: number }[]>("GET", "/nodes"),
          ]);
          const cluster = (status.data ?? []).find((s) => s.type === "cluster");
          const members = new Map((status.data ?? []).filter((s) => s.type === "node").map((s) => [s.name as string, s]));
          const res = new Map((nodesRes.data ?? []).map((r) => [r.node as string, r]));
          const guests = vms.data ?? [];
          const nodes = nodeList.map((n) => {
            const m = members.get(n.node);
            const r = res.get(n.node) ?? n;
            const mine = guests.filter((g) => g.node === n.node && g.template !== 1);
            return { name: n.node, online: (m ? m.online === 1 || m.online === true : n.status === "online"), local: n.node === c.node || m?.local === 1 || m?.local === true, ip: m?.ip ?? null, level: m?.level || null, cpu: r.cpu ?? null, maxcpu: r.maxcpu ?? null, mem: r.mem ?? null, maxmem: r.maxmem ?? null, uptime: r.uptime ?? null, guests: { running: mine.filter((g) => g.status === "running").length, total: mine.length } };
          }).sort((a, b) => a.name.localeCompare(b.name));
          return { clustered: !!cluster, name: cluster?.name ?? null, quorate: cluster ? cluster.quorate === 1 || cluster.quorate === true : true, configVersion: cluster?.version ?? null, version: version.data?.version ?? null, nodes, guests: { running: guests.filter((g) => g.status === "running" && g.template !== 1).length, total: guests.filter((g) => g.template !== 1).length }, statusDenied: status.denied };
        });
        c.json(200, out);
      },
    },

    // ---- Tasks, across nodes
    {
      method: "GET",
      re: /^\/api\/node\/tasks$/,
      run: async (c) => {
        const num = (k: string, lo: number, hi: number, dflt?: number) => {
          const v = query(c, k);
          if (v === null || v === "") return dflt;
          const n = Number(v);
          return Number.isInteger(n) && n >= lo && n <= hi ? n : bad(`${k} must be a whole number from ${lo} to ${hi}`);
        };
        const limit = num("limit", 1, 500, 100)!;
        const since = num("since", 0, 4_102_444_800);
        const until = num("until", 0, 4_102_444_800);
        const type = query(c, "type") || undefined;
        if (type !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(type)) bad("That isn't a task type");
        const user = query(c, "user") || undefined;
        if (user !== undefined && !/^[A-Za-z0-9._@!-]{1,64}$/.test(user)) bad("That isn't a user name");
        const status = query(c, "status") || undefined;
        if (status !== undefined && !["ok", "warning", "error", "running"].includes(status)) bad("A status is ok, warning, error or running");
        const wanted = query(c, "node") || "all";
        const out = await c.asUser(async (pve) => {
          const all = await pve.call<{ node: string; status: string }[]>("GET", "/nodes");
          let targets: string[];
          if (wanted === "all") targets = all.filter((n) => n.status === "online").map((n) => n.node);
          else {
            nodeName(wanted);
            if (!all.some((n) => n.node === wanted)) bad(`This cluster has no node called ${wanted}`);
            targets = [wanted];
          }
          const lists = await Promise.all(targets.map(async (n) => {
            const r = await soft(pve.call<Record<string, any>[]>("GET", `/nodes/${seg(n)}/tasks`, { limit, since, until, typefilter: type, userfilter: user, statusfilter: status && status !== "running" ? status : undefined, source: status === "running" ? "active" : undefined }));
            return (r.data ?? []).map((t) => ({ upid: t.upid as string, node: (t.node as string) ?? n, type: t.type as string, id: (t.id as string) || null, user: t.user as string, status: (t.status as string) ?? null, start: t.starttime as number, end: (t.endtime as number) ?? null }));
          }));
          return lists.flat().sort((a, b) => b.start - a.start).slice(0, limit);
        });
        c.json(200, { tasks: out });
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/tasks\/([^/]+)$/,
      run: async (c, m) => {
        const t = upid(decodeURIComponent(m[1]));
        const start = Number(query(c, "start") ?? 0);
        if (!Number.isInteger(start) || start < 0 || start > 10_000_000) bad("Bad start line");
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, { node: t.node });
          // Status first, then the log, so a task that ends in between is never reported finished with a log from before its last line.
          const status = await pve.taskStatus(node, t.upid);
          const log = await pve.callFull<{ n: number; t: string }[]>("GET", `/nodes/${seg(node)}/tasks/${seg(t.upid)}/log`, { start, limit: 1000 });
          // Proxmox answers an empty log with a placeholder line ("no content") so its own table isn't empty. It isn't output: it is
          // dropped, and the next read continues from the last real line number, not from a count that includes the placeholder
          // (which moved the cursor past lines that hadn't been written yet and lost them).
          const real = (log.data ?? []).filter((l) => l.t.trim() !== "no content");
          const next = real.length ? Math.max(...real.map((l) => l.n)) : start;
          return { node, status: status.status, exitstatus: status.exitstatus ?? null, lines: real.map((l) => l.t), next, total: typeof log.extra.total === "number" ? log.extra.total : null };
        });
        c.json(200, out);
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/tasks\/([^/]+)$/,
      run: async (c, m) => {
        c.sameSite();
        const t = upid(decodeURIComponent(m[1]));
        await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, { node: t.node });
          await pve.call("DELETE", `/nodes/${seg(node)}/tasks/${seg(t.upid)}`);
        });
        c.json(200, { ok: true });
      },
    },
  ];
}
