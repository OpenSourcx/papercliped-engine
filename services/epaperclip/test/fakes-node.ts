import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@papercliped-engine/proxmox-client";
import { fakePve } from "./fakes.ts";

/**
 * A Proxmox with the node and datacenter endpoints: two nodes (pve online, pve2 offline), services, time, logs,
 * subscription, apt, repositories, certificates, ACME, cluster options, notifications, metric servers, mappings and
 * tasks. It wraps the shared fake (sign-in, tickets, users) and answers everything the node screens ask for first.
 * sam@pve is an administrator; lee@pve may read a little and change nothing (403 on writes, as Proxmox answers).
 */

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, body: JSON.stringify({ data, ...extra }) });
const fail = (status: number, message: string) => ({ status, body: JSON.stringify({ message: `${message}\n` }) });
const deny = { status: 403, body: JSON.stringify({ message: "Permission check failed\n" }) };

export const KERNEL_RUNNING = "6.8.12-3-pve";

/** Makes a throwaway self-signed certificate and key with openssl (test material only). */
export function makeCert(cn: string, opts: { days?: number; san?: string } = {}): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "epc-cert-"));
  const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", String(opts.days ?? 90), "-subj", `/CN=${cn}`, "-addext", `subjectAltName=${opts.san ?? `DNS:${cn},IP:127.0.0.1`}`];
  execFileSync("openssl", args, { stdio: "ignore" });
  return { cert: readFileSync(join(dir, "c.pem"), "utf8"), key: readFileSync(join(dir, "k.pem"), "utf8") };
}

export function fakeNodePve() {
  const base = fakePve();
  const calls: { method: string; path: string; body: string; user: string }[] = [];
  const st = {
    services: new Map<string, string>([["pveproxy", "running"], ["sshd", "running"], ["chrony", "running"], ["pve-cluster", "running"], ["postfix", "dead"]]),
    timezone: "Europe/Berlin",
    syslog: Array.from({ length: 300 }, (_, i) => `Oct 12 10:${String(i % 60).padStart(2, "0")}:00 pve pvedaemon[1]: line ${i + 1}`),
    journal: ["Oct 12 10:00:00 pve kernel: boot", "Oct 12 10:00:05 pve sshd[7]: accepted"],
    subscription: { status: "notfound" as string, key: "" },
    updates: [
      { Package: "pve-manager", Title: "Proxmox VE manager", Description: "manager", OldVersion: "9.0.3", Version: "9.0.4", Origin: "Proxmox", Priority: "optional", Section: "admin", Arch: "all" },
      { Package: "proxmox-kernel-6.8.12-4-pve-signed", Title: "kernel", Description: "kernel", Version: "6.8.12-4", Origin: "Proxmox", Priority: "optional", Section: "admin", Arch: "amd64" },
    ] as Record<string, string>[],
    versions: [
      { Package: "proxmox-kernel-6.8.12-3-pve-signed", CurrentState: "Installed", Version: "6.8.12-3" },
      { Package: "proxmox-ve", CurrentState: "Installed", RunningKernel: `${KERNEL_RUNNING}`, Version: "9.0.0" },
    ] as Record<string, string>[],
    repos: {
      digest: "d1",
      files: [
        { path: "/etc/apt/sources.list.d/pve-enterprise.sources", "file-type": "sources", repositories: [{ Enabled: true, Types: ["deb"], URIs: ["https://enterprise.proxmox.com/debian/pve"], Suites: ["trixie"], Components: ["pve-enterprise"], FileType: "sources" }] },
        { path: "/etc/apt/sources.list", "file-type": "list", repositories: [{ Enabled: true, Types: ["deb"], URIs: ["http://deb.debian.org/debian"], Suites: ["trixie"], Components: ["main"], FileType: "list" }] },
      ] as any[],
      "standard-repos": [{ handle: "enterprise", name: "Enterprise", status: 1 }, { handle: "no-subscription", name: "No-Subscription" }, { handle: "test", name: "Test" }],
      infos: [] as any[],
      errors: [] as any[],
    },
    custom: null as { cert: string; key: string } | null,
    certPosts: [] as { certificates: string; key: string }[],
    acmeAccounts: new Map<string, { contact: string }>([["default", { contact: "mailto:ops@example.com" }]]),
    acmePlugins: new Map<string, Record<string, unknown>>([["cf", { plugin: "cf", type: "dns", api: "cf", data: "Q0ZfVG9rZW49c2VjcmV0", digest: "p1" }]]),
    nodeConfig: { digest: "n1", acme: "account=default", acmedomain0: "domain=pve.example.com,plugin=cf" } as Record<string, unknown>,
    options: { keyboard: "en-us", "tag-style": "color-map=prod:ff0000;web:3366ff:ffffff,shape=full", http_proxy: "http://u:hunter2@proxy:3128/", "next-id": "lower=100,upper=999999" } as Record<string, unknown>,
    targets: [{ name: "mail-to-root", type: "sendmail", origin: "builtin", comment: "" }, { name: "ops", type: "gotify", origin: "user-created", comment: "ops" }] as Record<string, unknown>[],
    gotify: { ops: { name: "ops", server: "https://gotify.lan", comment: "ops", digest: "g1", token: "GOTIFYSECRETTOKEN" } } as Record<string, Record<string, unknown>>,
    matchers: [{ name: "default-matcher", mode: "all", target: ["mail-to-root"], origin: "builtin" }] as Record<string, unknown>[],
    metrics: [{ id: "graf", type: "influxdb", server: "10.0.0.5", port: 8086, token: "INFLUXTOKENSECRET1" }] as Record<string, unknown>[],
    tasks: [] as { upid: string; node: string; type: string; user: string; start: number; end?: number; status?: string; log: string[] }[],
    /** Stands in for Proxmox writing its certificate files. */
    onCustomCert: undefined as undefined | ((cert: string, key: string) => void),
    powered: [] as string[],
    woken: [] as string[],
  };
  let n = 0;
  const task = (node: string, type: string, user: string, over: Partial<(typeof st.tasks)[number]> = {}) => {
    const upid = `UPID:${node}:0000${++n}:00000001:${(0x65000000 + n).toString(16)}:${type}::${user}:`;
    st.tasks.push({ upid, node, type, user, start: 1_700_000_000 + n, log: [`${type} started`], ...over });
    return upid;
  };

  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    const ticket = decodeURIComponent((req.headers.Cookie ?? "").replace("PVEAuthCookie=", ""));
    const user = ticket.split(":")[1] ?? "";
    const known = path !== "/access/ticket" && ticket && (await base.transport({ ...req, method: "GET", url: `${u.origin}/api2/json/version`, body: undefined })).status === 200;
    if (!known) return base.transport(req);
    const admin = user === "sam@pve";
    const f = new URLSearchParams(req.body ?? "");
    const q = u.searchParams;
    const m = req.method;
    calls.push({ method: m, path, body: req.body ?? "", user });
    const write = m !== "GET";
    if (write && !admin) return deny;

    if (path === "/nodes" && m === "GET") return ok([{ node: "pve", status: "online", cpu: 0.1, maxcpu: 4, mem: 2e9, maxmem: 8e9, uptime: 5000 }, { node: "pve2", status: "offline" }]);
    if (path === "/cluster/status") return admin ? ok([{ type: "cluster", name: "lab", nodes: 2, quorate: 1, version: 3, id: "cluster" }, { type: "node", name: "pve", online: 1, local: 1, ip: "10.0.0.2", nodeid: 1, id: "node/pve" }, { type: "node", name: "pve2", online: 0, ip: "10.0.0.3", nodeid: 2, id: "node/pve2" }]) : deny;
    if (path === "/cluster/resources" && q.get("type") === "node") return ok([{ type: "node", node: "pve", status: "online", cpu: 0.1, maxcpu: 4, mem: 2e9, maxmem: 8e9, uptime: 5000 }]);
    if (path === "/cluster/resources" && q.get("type") === "vm") return ok([{ type: "lxc", vmid: 101, node: "pve", name: "web", status: "running", tags: "prod;web" }, { type: "qemu", vmid: 102, node: "pve", name: "db", status: "stopped", tags: "prod" }, { type: "qemu", vmid: 9000, node: "pve", name: "tpl", status: "stopped", template: 1 }]);
    if (path === "/cluster/options") {
      if (m === "GET") return admin ? ok(st.options) : ok({ keyboard: "en-us" });
      for (const [k, v] of f.entries()) if (k !== "delete") st.options[k] = v;
      for (const k of (f.get("delete") ?? "").split(",").filter(Boolean)) delete st.options[k];
      return ok(null);
    }

    // Services
    if (path === "/nodes/pve/services") return ok([...st.services].map(([service, state]) => ({ service, name: service, desc: `${service} service`, state, "active-state": state === "running" ? "active" : "inactive", "unit-state": "enabled" })));
    const sv = path.match(/^\/nodes\/pve\/services\/([\w-]+)\/(start|stop|restart|reload)$/);
    if (sv && m === "POST") {
      st.services.set(sv[1], sv[2] === "stop" ? "dead" : "running");
      return ok(task("pve", `srv${sv[2]}`, user));
    }
    // Time
    if (path === "/nodes/pve/time") {
      if (m === "PUT") return (st.timezone = f.get("timezone")!), ok(null);
      return ok({ timezone: st.timezone, time: 1_760_000_000, localtime: 1_760_003_600 });
    }
    if (path === "/nodes/pve/syslog") {
      const start = Number(q.get("start") ?? 0);
      const limit = Number(q.get("limit") ?? 50);
      return ok(st.syslog.slice(start, start + limit).map((t, i) => ({ n: start + i + 1, t })), { total: st.syslog.length });
    }
    if (path === "/nodes/pve/journal") return ok(st.journal);
    // Status and power
    if (path === "/nodes/pve/status") {
      if (m === "POST") return st.powered.push(f.get("command")!), ok(null);
      return ok({ cpu: 0.2, memory: { total: 16, used: 4, free: 12 }, uptime: 100, pveversion: "pve-manager/9.0.3", "current-kernel": { release: KERNEL_RUNNING } });
    }
    if (path === "/nodes/pve/config" || path === "/nodes/pve2/config") {
      if (m === "GET") return q.get("property") === "wakeonlan" ? ok({ wakeonlan: "aa:bb:cc:dd:ee:ff" }) : ok(st.nodeConfig);
      for (const [k, v] of f.entries()) if (k !== "delete" && k !== "digest") st.nodeConfig[k] = v;
      for (const k of (f.get("delete") ?? "").split(",").filter(Boolean)) delete st.nodeConfig[k];
      return ok(null);
    }
    if (path === "/nodes/pve2/wakeonlan") return st.woken.push("pve2"), ok("aa:bb:cc:dd:ee:ff");
    // Subscription
    if (path === "/nodes/pve/subscription") {
      if (m === "GET") return ok({ status: st.subscription.status, key: st.subscription.key || undefined, level: st.subscription.key ? "c" : undefined, serverid: "SERVERID123", sockets: 1, message: st.subscription.key ? "Checked" : "There is no subscription key" });
      if (m === "PUT") {
        if (f.get("key") === "pve2c-ffffffffff") return fail(500, "invalid subscription key 'pve2c-ffffffffff'");
        return (st.subscription = { status: "new", key: f.get("key")! }), ok(null);
      }
      if (m === "POST") return (st.subscription.status = st.subscription.key ? "active" : "notfound"), ok(null);
      if (m === "DELETE") return (st.subscription = { status: "notfound", key: "" }), ok(null);
    }
    // Updates
    if (path === "/nodes/pve/apt/update") return !admin ? deny : m === "POST" ? ok(task("pve", "aptupdate", user, { end: 1_700_000_100, status: "OK" })) : ok(st.updates);
    if (path === "/nodes/pve/apt/versions") return ok(st.versions);
    if (path === "/nodes/pve/apt/changelog") return ok(`${q.get("name")} (${q.get("version") ?? "?"}) stable; urgency=medium\n  * fixes`);
    if (path === "/nodes/pve/apt/repositories") {
      if (m === "GET") return ok({ ...st.repos });
      const digest = f.get("digest");
      if (digest && digest !== st.repos.digest) return fail(500, "digest mismatch - repository configuration changed");
      st.repos.digest = `d${Number(st.repos.digest.slice(1)) + 1}`;
      if (m === "POST") {
        const file = st.repos.files.find((x: any) => x.path === f.get("path"));
        if (!file) return fail(500, "no such file");
        file.repositories[Number(f.get("index"))].Enabled = f.get("enabled") === "1";
        return ok(null);
      }
      if (m === "PUT") {
        const h = f.get("handle");
        if (h === "no-subscription") st.repos.files.push({ path: "/etc/apt/sources.list.d/proxmox.sources", "file-type": "sources", repositories: [{ Enabled: true, Types: ["deb"], URIs: ["http://download.proxmox.com/debian/pve"], Suites: ["trixie"], Components: ["pve-no-subscription"], FileType: "sources" }] });
        return ok(null);
      }
    }
    // Certificates
    if (path === "/nodes/pve/certificates/info") {
      const list: Record<string, unknown>[] = [{ filename: "pve-ssl.pem", fingerprint: "AA:BB", issuer: "CN=Proxmox Virtual Environment", subject: "CN=pve", san: ["DNS:pve", "IP:127.0.0.1"], notbefore: 1_700_000_000, notafter: 1_900_000_000, "public-key-type": "rsaEncryption", "public-key-bits": 2048 }];
      if (st.custom) list.push({ filename: "pveproxy-ssl.pem", fingerprint: "CC:DD", issuer: "CN=custom", subject: "CN=custom", san: [], notbefore: 1_700_000_000, notafter: 1_900_000_000 });
      return ok(list);
    }
    if (path === "/nodes/pve/certificates/custom") {
      if (m === "POST") {
        st.certPosts.push({ certificates: f.get("certificates")!, key: f.get("key")! });
        if (f.get("certificates") === "REFUSE") return fail(500, `unable to use key ${f.get("key")}`);
        st.custom = { cert: f.get("certificates")!, key: f.get("key")! };
        st.onCustomCert?.(st.custom.cert, st.custom.key);
        return ok({ filename: "pveproxy-ssl.pem", fingerprint: "CC:DD" });
      }
      return (st.custom = null), ok(null);
    }
    if (path === "/nodes/pve/certificates/acme/certificate") return ok(task("pve", m === "POST" ? "acmenewcert" : m === "PUT" ? "acmerenew" : "acmerevoke", user, { end: 1_700_000_050, status: "OK" }));
    // ACME
    if (path === "/cluster/acme/account" && m === "GET") return ok([...st.acmeAccounts.keys()].map((name) => ({ name })));
    if (path === "/cluster/acme/account" && m === "POST") {
      st.acmeAccounts.set(f.get("name") ?? "default", { contact: f.get("contact")! });
      (st as any).lastAccountBody = req.body;
      return ok(task("pve", "acmeregister", user, { end: 1_700_000_020, status: "OK" }));
    }
    const ac = path.match(/^\/cluster\/acme\/account\/([\w-]+)$/);
    if (ac) {
      if (!st.acmeAccounts.has(ac[1])) return fail(500, "ACME account config file does not exist");
      if (m === "GET") return ok({ account: { contact: [st.acmeAccounts.get(ac[1])!.contact], status: "valid", createdAt: "2026-01-01" }, directory: "https://acme-v02.api.letsencrypt.org/directory", tos: "https://letsencrypt.org/terms" });
      if (m === "DELETE") return st.acmeAccounts.delete(ac[1]), ok(task("pve", "acmedeactivate", user));
      return ok(task("pve", "acmeupdate", user));
    }
    if (path === "/cluster/acme/directories") return ok([{ name: "Let's Encrypt V2", url: "https://acme-v02.api.letsencrypt.org/directory" }, { name: "Let's Encrypt V2 Staging", url: "https://acme-staging-v02.api.letsencrypt.org/directory" }]);
    if (path === "/cluster/acme/tos") return ok("https://letsencrypt.org/terms");
    if (path === "/cluster/acme/meta") return ok({ externalAccountRequired: false });
    if (path === "/cluster/acme/challenge-schema") return ok([{ id: "cf", name: "Cloudflare", type: "dns", schema: { fields: { CF_Token: { type: "string", description: "API token" } } } }]);
    if (path === "/cluster/acme/plugins") {
      if (m === "GET") return admin ? ok([...st.acmePlugins.values()]) : deny;
      st.acmePlugins.set(f.get("id")!, { plugin: f.get("id"), type: f.get("type"), api: f.get("api"), data: f.get("data") });
      return ok(null);
    }
    const ap = path.match(/^\/cluster\/acme\/plugins\/([\w-]+)$/);
    if (ap) return m === "DELETE" ? (st.acmePlugins.delete(ap[1]), ok(null)) : ok(null);
    // Notifications
    if (path === "/cluster/notifications/targets") return ok(st.targets);
    if (path === "/cluster/notifications/matchers" && m === "GET") return ok(st.matchers);
    if (path === "/cluster/notifications/matchers" && m === "POST") return st.matchers.push({ name: f.get("name"), mode: f.get("mode") ?? "all", target: f.getAll("target") }), ok(null);
    const ge = path.match(/^\/cluster\/notifications\/endpoints\/gotify\/([\w-]+)$/);
    if (ge && m === "GET") return st.gotify[ge[1]] ? ok(st.gotify[ge[1]]) : fail(500, "not found");
    if (path === "/cluster/notifications/endpoints/webhook" && m === "POST") return (st as any).webhook = req.body, ok(null);
    if (path === "/cluster/notifications/endpoints/gotify" && m === "POST") {
      if (f.get("token") === "BADTOKEN") return fail(500, "gotify refused token BADTOKEN");
      return (st as any).gotifyPost = req.body, ok(null);
    }
    if (path === "/cluster/notifications/endpoints/smtp" && m === "POST") return (st as any).smtpPost = req.body, ok(null);
    if (path === "/cluster/notifications/endpoints/sendmail" && m === "POST") return (st as any).sendmailPost = req.body, ok(null);
    const nt = path.match(/^\/cluster\/notifications\/targets\/([\w-]+)\/test$/);
    if (nt) return st.targets.some((t) => t.name === nt[1]) ? ok(null) : fail(500, "unknown target");
    // Metrics and mappings
    if (path === "/cluster/metrics/server") return ok(st.metrics.map(({ token: _t, ...rest }) => rest));
    const me = path.match(/^\/cluster\/metrics\/server\/([\w-]+)$/);
    if (me) {
      if (m === "GET") return ok(st.metrics.find((x) => x.id === me[1]) ?? null);
      (st as any).metricsPost = { method: m, body: req.body };
      return ok(null);
    }
    if (path === "/cluster/mapping/pci") return ok([{ id: "gpu0", description: "GPU", map: ["node=pve,path=0000:01:00,id=10de:2204"], checks: [{ severity: "warning", message: "IOMMU group shared" }] }]);
    if (path === "/cluster/mapping/usb") return ok([]);
    if (path === "/cluster/mapping/dir") return ok([]);
    // Tasks
    const tl = path.match(/^\/nodes\/(pve|pve2)\/tasks$/);
    if (tl) {
      const type = q.get("typefilter");
      const who = q.get("userfilter");
      const status = q.get("statusfilter");
      const active = q.get("source") === "active";
      return ok(st.tasks.filter((t) => t.node === tl[1] && (!type || t.type === type) && (!who || t.user === who) && (!status || (status === "error" ? t.status && t.status !== "OK" && !t.status.startsWith("WARN") : t.status === status.toUpperCase())) && (!active || t.end === undefined)).map((t) => ({ upid: t.upid, node: t.node, type: t.type, user: t.user, starttime: t.start, endtime: t.end, status: t.status, id: "" })));
    }
    const td = path.match(/^\/nodes\/(pve|pve2)\/tasks\/([^/]+)(?:\/(status|log))?$/);
    if (td) {
      const t = st.tasks.find((x) => x.upid === decodeURIComponent(td[2]));
      if (!t) return fail(500, "no such task");
      if (m === "DELETE") return t.end !== undefined ? fail(500, "task already finished") : ((t.end = t.start + 1), (t.status = "interrupted"), ok(null));
      if (td[3] === "log") {
        const start = Number(q.get("start") ?? 0);
        return ok(t.log.slice(start).map((l, i) => ({ n: start + i + 1, t: l })), { total: t.log.length });
      }
      return ok({ status: t.end === undefined ? "running" : "stopped", exitstatus: t.status });
    }
    return base.transport(req);
  };

  return { ...base, transport, calls, st, task };
}
