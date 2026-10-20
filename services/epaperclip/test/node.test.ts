import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeNodePve, KERNEL_RUNNING, makeCert } from "./fakes-node.ts";
import { until } from "./fakes.ts";
import { FEATURES } from "../src/features/index.ts";
import { createNodeFeature } from "../src/features/node.ts";
import { TlsReloader } from "../src/features/nodeTls.ts";

let pve: ReturnType<typeof fakeNodePve>;
let server: Server;
let base: string;
let seen: string[]; // everything the browser was given
const original = [...FEATURES];
let reloads = 0;

beforeEach(async () => {
  pve = fakeNodePve();
  seen = [];
  reloads = 0;
  const tls = new TlsReloader();
  const real = tls.reload.bind(tls);
  tls.reload = () => (reloads++, real());
  tls.reloadSoon = () => {};
  FEATURES.splice(0, FEATURES.length, { name: "node", handle: createNodeFeature({ tls, pollMs: 5 }) });
  const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false, state: new StateStore(mkdtempSync(join(tmpdir(), "epc-node-"))) });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  FEATURES.splice(0, FEATURES.length, ...original);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function signIn(username: string) {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username, password: "right", realm: "pve" }) });
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const send = async (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = { "X-EPC-Request": "1" }) => {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  seen.push(text);
  return { status: r.status, json: (text ? JSON.parse(text) : null) as any };
};
const bodiesFor = (method: string, path: string) => pve.calls.filter((c) => c.method === method && c.path === path);

describe("sign-in, same-site and nodes", () => {
  it("needs a Proxmox session and the same-site header", async () => {
    expect((await send("", "GET", "/api/node/services")).status).toBe(401);
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/services/chrony/restart", {}, {})).status).toBe(403);
    expect(bodiesFor("POST", "/nodes/pve/services/chrony/restart")).toHaveLength(0);
  });

  it("lists the nodes and refuses a node the cluster doesn't have", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/nodes");
    expect(r.json.nodes.map((n: any) => [n.node, n.online])).toEqual([["pve", true], ["pve2", false]]);
    expect(r.json.local).toBe("pve");
    expect((await send(sam, "GET", "/api/node/time?node=ghost")).status).toBe(404);
    expect((await send(sam, "GET", "/api/node/time?node=../etc")).status).toBe(400);
    expect((await send(sam, "GET", "/api/node/time?node=pve")).status).toBe(200);
  });
});

describe("services and time", () => {
  it("lists services and runs actions as the signed-in person", async () => {
    const sam = await signIn("sam");
    const list = await send(sam, "GET", "/api/node/services");
    expect(list.json.services.find((s: any) => s.service === "postfix")).toMatchObject({ state: "dead", canControl: true });
    const r = await send(sam, "POST", "/api/node/services/postfix/start", {});
    expect(r.status).toBe(202);
    expect(r.json.task).toMatch(/^UPID:pve:/);
    expect(bodiesFor("POST", "/nodes/pve/services/postfix/start")[0].user).toBe("sam@pve");
  });

  it("refuses unknown services and actions, and makes you type the name before stopping a critical one", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/services/evil/start", {})).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/services/sshd/destroy", {})).status).toBe(400);
    const no = await send(sam, "POST", "/api/node/services/pveproxy/stop", {});
    expect(no.status).toBe(400);
    expect(no.json.error).toMatch(/pveproxy/);
    expect(bodiesFor("POST", "/nodes/pve/services/pveproxy/stop")).toHaveLength(0);
    expect((await send(sam, "POST", "/api/node/services/pveproxy/stop", { confirm: "pveproxy" })).status).toBe(202);
    expect((await send(sam, "POST", "/api/node/services/chrony/stop", {})).status).toBe(202);
  });

  it("turns a Proxmox 403 into a clear message", async () => {
    const lee = await signIn("lee");
    const r = await send(lee, "POST", "/api/node/services/chrony/restart", {});
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/doesn't have permission/);
  });

  it("reads and sets the time zone", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "GET", "/api/node/time")).json).toMatchObject({ timezone: "Europe/Berlin", time: 1_760_000_000 });
    expect((await send(sam, "PUT", "/api/node/time", { timezone: "America/New_York" })).status).toBe(200);
    expect(pve.st.timezone).toBe("America/New_York");
    for (const tz of ["", "../../etc/passwd", "a b", "x".repeat(70), 5]) expect((await send(sam, "PUT", "/api/node/time", { timezone: tz })).status).toBe(400);
  });
});

describe("logs", () => {
  it("pages the syslog and passes the range through", async () => {
    const sam = await signIn("sam");
    const a = await send(sam, "GET", "/api/node/logs/syslog?limit=100&start=0");
    expect(a.json.lines).toHaveLength(100);
    expect(a.json.total).toBe(300);
    const b = await send(sam, "GET", "/api/node/logs/syslog?limit=100&start=250");
    expect(b.json.lines.at(-1).n).toBe(300);
    expect(b.json.lines).toHaveLength(50);
  });

  it("refuses bad ranges and filters before they reach Proxmox", async () => {
    const sam = await signIn("sam");
    for (const q of ["limit=0", "limit=5000", "start=-1", "since=yesterday", "service=a%0Ab", "since=2026-10-12%3B"]) expect((await send(sam, "GET", `/api/node/logs/syslog?${q}`)).status).toBe(400);
    for (const q of ["lastentries=0", "since=abc", "unit=a b", "priority=9", "priority=0..9"]) expect((await send(sam, "GET", `/api/node/logs/journal?${q}`)).status).toBe(400);
    expect(bodiesFor("GET", "/nodes/pve/syslog")).toHaveLength(0);
    expect((await send(sam, "GET", "/api/node/logs/journal?lastentries=50&unit=pveproxy&priority=0..4")).json.lines).toHaveLength(2);
  });
});

describe("power", () => {
  it("lists the running machines the reboot would stop, and needs the node name typed", async () => {
    const sam = await signIn("sam");
    const info = await send(sam, "GET", "/api/node/power");
    expect(info.json.running).toEqual([{ vmid: 101, name: "web", type: "lxc" }]);
    expect(info.json.others).toEqual([{ node: "pve2", online: false }]);
    const wrong = await send(sam, "POST", "/api/node/power", { command: "reboot", confirm: "yes" });
    expect(wrong.status).toBe(400);
    expect(pve.st.powered).toEqual([]);
    expect((await send(sam, "POST", "/api/node/power", { command: "halt", confirm: "pve" })).status).toBe(400);
    const ok = await send(sam, "POST", "/api/node/power", { command: "reboot", confirm: "pve" });
    expect(ok.status).toBe(202);
    expect(ok.json.selfAffected).toBe(true);
    expect(pve.st.powered).toEqual(["reboot"]);
  });

  it("wakes an offline node, and refuses this one", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/wakeonlan", { node: "pve" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/wakeonlan", { node: "pve2" })).status).toBe(202);
    expect(pve.st.woken).toEqual(["pve2"]);
  });

  it("leaves shutdown to people Proxmox allows", async () => {
    const lee = await signIn("lee");
    const r = await send(lee, "POST", "/api/node/power", { command: "shutdown", confirm: "pve" });
    expect(r.status).toBe(403);
    expect(pve.st.powered).toEqual([]);
  });
});

describe("subscription", () => {
  const KEY = "pve2c-0123456789";
  it("never returns the key, only its last four characters", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "PUT", "/api/node/subscription", { key: KEY })).status).toBe(200);
    const r = await send(sam, "GET", "/api/node/subscription");
    expect(r.json).toMatchObject({ status: "active", keyLast4: "6789" });
    expect(seen.join("\n")).not.toContain(KEY);
  });

  it("refuses a key that is the wrong shape before Proxmox sees it", async () => {
    const sam = await signIn("sam");
    for (const key of ["", "abc", "pve9z-0123456789", "pve2c-0123456789; rm", 7]) expect((await send(sam, "PUT", "/api/node/subscription", { key })).status).toBe(400);
    expect(bodiesFor("PUT", "/nodes/pve/subscription")).toHaveLength(0);
  });

  it("keeps the key out of Proxmox's error text", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "PUT", "/api/node/subscription", { key: "pve2c-ffffffffff" });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).toContain("invalid subscription key");
    expect(JSON.stringify(r.json)).not.toContain("pve2c-ffffffffff");
  });

  it("needs a typed confirmation to remove the key", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "DELETE", "/api/node/subscription", {})).status).toBe(400);
    expect((await send(sam, "DELETE", "/api/node/subscription", { confirm: "remove subscription" })).status).toBe(200);
    expect((await send(sam, "POST", "/api/node/subscription/check", {})).status).toBe(200);
  });
});

describe("updates and repositories", () => {
  it("lists upgradable packages, flags a pending kernel, and warns about no reboot needed yet", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/updates");
    expect(r.json.packages.map((p: any) => p.package)).toEqual(["proxmox-kernel-6.8.12-4-pve-signed", "pve-manager"]);
    expect(r.json).toMatchObject({ kernelUpdatePending: true, rebootRequired: false, runningKernel: KERNEL_RUNNING });
  });

  it("says a reboot is required once a newer kernel is installed than the one running", async () => {
    const sam = await signIn("sam");
    pve.st.versions.push({ Package: "proxmox-kernel-6.8.12-4-pve-signed", CurrentState: "Installed", Version: "6.8.12-4" });
    expect((await send(sam, "GET", "/api/node/updates")).json.rebootRequired).toBe(true);
  });

  it("explains when Proxmox won't show the list to this person", async () => {
    const lee = await signIn("lee");
    const r = await send(lee, "GET", "/api/node/updates");
    expect(r.status).toBe(200);
    expect(r.json.listDenied).toBe(true);
  });

  it("refreshes the index as a task and reads a changelog with validated names", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/updates/refresh", {})).json.task).toMatch(/aptupdate/);
    expect((await send(sam, "GET", "/api/node/updates/changelog?name=pve-manager&version=9.0.4")).json.text).toMatch(/pve-manager \(9.0.4\)/);
    for (const q of ["name=", "name=a%20b", "name=pve-manager&version=1;2", "name=../x"]) expect((await send(sam, "GET", `/api/node/updates/changelog?${q}`)).status).toBe(400);
  });

  it("warns about the enterprise repository without a subscription and switches with one click", async () => {
    const sam = await signIn("sam");
    const before = await send(sam, "GET", "/api/node/repos");
    expect(before.json.warnings.map((w: any) => w.id)).toContain("enterprise-no-subscription");
    expect(before.json.warnings.find((w: any) => w.id === "enterprise-no-subscription").fix).toBe("no-subscription");
    expect((await send(sam, "POST", "/api/node/repos/no-subscription", {})).json).toMatchObject({ disabledEnterprise: 1, noSubscriptionEnabled: true });
    const after = await send(sam, "GET", "/api/node/repos");
    expect(after.json.repositories.filter((r: any) => r.enabled).map((r: any) => r.kind).sort()).toEqual(["debian", "no-subscription"]);
    expect(after.json.warnings.map((w: any) => w.id)).not.toContain("enterprise-no-subscription");
  });

  it("toggles one repository and refuses odd paths and handles", async () => {
    const sam = await signIn("sam");
    const path = "/etc/apt/sources.list.d/pve-enterprise.sources";
    expect((await send(sam, "POST", "/api/node/repos/toggle", { path, index: 0, enabled: false, digest: "d1" })).status).toBe(200);
    for (const bad of [{ path: "/etc/passwd", index: 0, enabled: true }, { path: "/etc/apt/../passwd", index: 0, enabled: true }, { path, index: -1, enabled: true }, { path, index: 0, enabled: "yes" }]) expect((await send(sam, "POST", "/api/node/repos/toggle", bad)).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/repos/add", { handle: "evil" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/repos/add", { handle: "BAD HANDLE" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/repos/add", { handle: "test" })).status).toBe(200);
  });
});

describe("certificates", () => {
  it("lists certificates and marks the custom one", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/certificates");
    expect(r.json.certificates[0]).toMatchObject({ filename: "pve-ssl.pem", custom: false, keyBits: 2048 });
    expect(r.json.certificates[0].daysLeft).toBeGreaterThan(0);
  });

  it("uploads a certificate and key, reloads, and never returns or reports the key", async () => {
    const sam = await signIn("sam");
    const { cert, key } = makeCert("pve.example.com");
    const r = await send(sam, "POST", "/api/node/certificates/custom", { certificates: cert, key });
    expect(r.status).toBe(200);
    expect(r.json.certificate.subject).toContain("pve.example.com");
    expect(pve.st.certPosts).toHaveLength(1);
    expect(reloads).toBeGreaterThan(0);
    const keyBody = key.split("\n")[1];
    expect(seen.join("\n")).not.toContain(keyBody);
    expect(JSON.stringify(pve.calls.filter((c) => c.method === "GET"))).not.toContain(keyBody);
    expect((await send(sam, "GET", "/api/node/certificates")).json.certificates.some((c: any) => c.custom)).toBe(true);
  });

  it("warns when the certificate won't let this service reach Proxmox on loopback", async () => {
    const sam = await signIn("sam");
    const { cert, key } = makeCert("pve.example.com", { san: "DNS:pve.example.com" });
    const r = await send(sam, "POST", "/api/node/certificates/custom", { certificates: cert, key });
    expect(r.json.warnings.join(" ")).toMatch(/127\.0\.0\.1/);
  });

  it("refuses bad PEM, the wrong key, locked keys, extra text and oversized input without calling Proxmox", async () => {
    const sam = await signIn("sam");
    const a = makeCert("a.example.com");
    const b = makeCert("b.example.com");
    const cases: [string, unknown][] = [
      ["not a certificate", { certificates: "hello", key: a.key }],
      ["wrong key", { certificates: a.cert, key: b.key }],
      ["no key", { certificates: a.cert }],
      ["key in the chain", { certificates: a.cert + a.key, key: a.key }],
      ["extra text", { certificates: `junk\n${a.cert}`, key: a.key }],
      ["passphrase", { certificates: a.cert, key: "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n" }],
      ["a certificate as the key", { certificates: a.cert, key: a.cert }],
      ["too big", { certificates: a.cert + "A".repeat(70_000), key: a.key }],
      ["unknown field", { certificates: a.cert, key: a.key, restart: false }],
    ];
    for (const [name, body] of cases) expect((await send(sam, "POST", "/api/node/certificates/custom", body)).status, name).toBe(400);
    expect((await send(sam, "POST", "/api/node/certificates/custom", { certificates: "A".repeat(300_000), key: "x" })).status).toBe(413);
    expect(pve.st.certPosts).toHaveLength(0);
    const msgs = seen.join("\n");
    expect(msgs).not.toContain(a.key.split("\n")[1]);
    expect(msgs).not.toContain(b.key.split("\n")[1]);
  });

  it("removes the custom certificate only after a typed confirmation", async () => {
    const sam = await signIn("sam");
    pve.st.custom = { cert: "x", key: "y" };
    expect((await send(sam, "DELETE", "/api/node/certificates/custom", {})).status).toBe(400);
    expect(pve.st.custom).not.toBeNull();
    expect((await send(sam, "DELETE", "/api/node/certificates/custom", { confirm: "remove certificate" })).status).toBe(200);
    expect(pve.st.custom).toBeNull();
  });

  it("leaves certificate changes to people Proxmox allows", async () => {
    const lee = await signIn("lee");
    const { cert, key } = makeCert("c.example.com");
    expect((await send(lee, "POST", "/api/node/certificates/custom", { certificates: cert, key })).status).toBe(403);
    expect((await send(lee, "POST", "/api/node/certificates/reload", {})).status).toBe(403);
  });
});

describe("ACME", () => {
  it("shows accounts, plugins (without their settings), the schema and the node's domains", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/acme");
    expect(r.json.accounts).toEqual([{ name: "default" }]);
    expect(r.json.plugins[0]).toMatchObject({ id: "cf", hasSettings: true });
    expect(JSON.stringify(r.json)).not.toContain("Q0ZfVG9rZW49c2VjcmV0");
    expect(r.json.config).toMatchObject({ account: "default", domains: [{ index: 0, domain: "pve.example.com", plugin: "cf" }] });
    expect(r.json.challengeSchema[0].id).toBe("cf");
  });

  it("registers an account as a task, with the terms accepted, and keeps the binding key private", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/acme/accounts", { name: "le", contact: "ops@example.com" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/acme/accounts", { name: "le", contact: "not-an-email", acceptTos: true })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/acme/accounts", { name: "le", contact: "ops@example.com", acceptTos: true, directory: "http://insecure" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/acme/accounts", { name: "le", contact: "ops@example.com", acceptTos: true, eabKid: "k" })).status).toBe(400);
    const r = await send(sam, "POST", "/api/node/acme/accounts", { name: "le", contact: "ops@example.com", acceptTos: true, eabKid: "kid1", eabHmacKey: "HMACSECRETVALUE" });
    expect(r.status).toBe(202);
    expect(seen.join("\n")).not.toContain("HMACSECRETVALUE");
    expect(bodiesFor("POST", "/cluster/acme/account")[0].body).toContain("tos_url=");
  });

  it("deletes an account only when its name is typed", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "DELETE", "/api/node/acme/accounts/default", { confirm: "nope" })).status).toBe(400);
    expect((await send(sam, "DELETE", "/api/node/acme/accounts/default", { confirm: "default" })).status).toBe(202);
  });

  it("saves DNS plugin settings encoded, never returns them, and checks their shape", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/acme/plugins", { id: "cf2", type: "dns", api: "cf", settings: "rm -rf /" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/acme/plugins", { id: "cf2", type: "dns" })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/acme/plugins", { id: "cf2", type: "dns", api: "notaprovider", settings: "A=1" })).status).toBe(400);
    const ok = await send(sam, "POST", "/api/node/acme/plugins", { id: "cf2", type: "dns", api: "cf", settings: "CF_Token=sekrit-token-value\nCF_Account_ID=abc" });
    expect(ok.status).toBe(200);
    const sent = new URLSearchParams(bodiesFor("POST", "/cluster/acme/plugins")[0].body);
    expect(Buffer.from(sent.get("data")!, "base64").toString()).toContain("CF_Token=sekrit-token-value");
    expect(seen.join("\n")).not.toContain("sekrit-token-value");
  });

  it("sets the node's account and domains, with limits", async () => {
    const sam = await signIn("sam");
    const ok = await send(sam, "PUT", "/api/node/acme/config", { account: "default", domains: [{ domain: "pve.example.com", plugin: "cf" }, { domain: "alt.example.com", alias: "validation.example.net" }], digest: "n1" });
    expect(ok.status).toBe(200);
    expect(pve.st.nodeConfig.acmedomain1).toBe("domain=alt.example.com,alias=validation.example.net");
    expect(pve.st.nodeConfig.acmedomain5).toBeUndefined();
    expect((await send(sam, "PUT", "/api/node/acme/config", { account: "default", domains: Array.from({ length: 7 }, (_, i) => ({ domain: `d${i}.example.com` })) })).status).toBe(400);
    expect((await send(sam, "PUT", "/api/node/acme/config", { account: "default", domains: [{ domain: "bad domain" }] })).status).toBe(400);
    expect((await send(sam, "PUT", "/api/node/acme/config", { account: "default", domains: [{ domain: "a.example.com", plugin: "x;y" }] })).status).toBe(400);
  });

  it("orders and renews as tasks, then re-reads the served certificate when the task ends", async () => {
    const sam = await signIn("sam");
    const order = await send(sam, "POST", "/api/node/acme/order", {});
    expect(order.status).toBe(202);
    expect(order.json.task).toMatch(/acmenewcert/);
    await until(() => reloads > 0);
    const before = reloads;
    expect((await send(sam, "POST", "/api/node/acme/renew", { force: true })).json.task).toMatch(/acmerenew/);
    await until(() => reloads > before);
    pve.st.nodeConfig = { digest: "n2" };
    expect((await send(sam, "POST", "/api/node/acme/order", {})).status).toBe(400);
  });
});

describe("datacenter options", () => {
  it("reads values for the form, hides the proxy password and exposes the schema", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/datacenter/options");
    expect(r.json.values.keyboard).toBe("en-us");
    expect(r.json.values["next-id"]).toEqual({ lower: 100, upper: 999999 });
    expect(r.json.values["tag-style"]).toMatchObject({ shape: "full" });
    expect(r.json.values.http_proxy).toBe("http://u:••••@proxy:3128/");
    expect(r.json.schema.keyboard.enum).toContain("de");
    expect(seen.join("\n")).not.toContain("hunter2");
  });

  it("saves valid values, composes property strings and clears with null", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "PUT", "/api/node/datacenter/options", { values: { keyboard: "de", "next-id": { lower: 200, upper: 5000 }, migration: { type: "insecure", network: "10.9.0.0/24" }, max_workers: 8, console: null } });
    expect(r.status).toBe(200);
    const sent = new URLSearchParams(bodiesFor("PUT", "/cluster/options")[0].body);
    expect(sent.get("keyboard")).toBe("de");
    expect(sent.get("next-id")).toBe("lower=200,upper=5000");
    expect(sent.get("migration")!.split(",").sort()).toEqual(["network=10.9.0.0/24", "type=insecure"]);
    expect(sent.get("delete")).toBe("console");
  });

  it("leaves the stored proxy password alone when the masked value comes back", async () => {
    const sam = await signIn("sam");
    await send(sam, "PUT", "/api/node/datacenter/options", { values: { http_proxy: "http://u:••••@proxy:3128/", keyboard: "fr" } });
    expect(new URLSearchParams(bodiesFor("PUT", "/cluster/options")[0].body).has("http_proxy")).toBe(false);
    expect(pve.st.options.http_proxy).toBe("http://u:hunter2@proxy:3128/");
  });

  it("refuses unknown settings, wrong values and an impossible id range", async () => {
    const sam = await signIn("sam");
    const bad: unknown[] = [{ rogue: 1 }, { keyboard: "klingon" }, { max_workers: 0 }, { max_workers: "many" }, { mac_prefix: "zz:zz" }, { "next-id": { lower: 5000, upper: 200 } }, { "next-id": { lower: 5 } }, { "tag-style": { "color-map": "prod;ff0000" } }, { http_proxy: "ftp://x" }, { description: 5 }, { migration: { type: "secure", extra: 1 } }, { "tag-style": { shape: "triangle" } }];
    for (const values of bad) expect((await send(sam, "PUT", "/api/node/datacenter/options", { values })).status, JSON.stringify(values)).toBe(400);
    expect(bodiesFor("PUT", "/cluster/options")).toHaveLength(0);
  });

  it("leaves option changes to people Proxmox allows", async () => {
    const lee = await signIn("lee");
    expect((await send(lee, "PUT", "/api/node/datacenter/options", { values: { keyboard: "de" } })).status).toBe(403);
  });
});

describe("notifications and metric servers", () => {
  it("lists targets and matchers and never returns a target's token", async () => {
    const sam = await signIn("sam");
    const list = await send(sam, "GET", "/api/node/datacenter/notifications");
    expect(list.json.targets.map((t: any) => [t.name, t.type, t.builtin])).toEqual([["mail-to-root", "sendmail", true], ["ops", "gotify", false]]);
    const one = await send(sam, "GET", "/api/node/datacenter/notifications/targets/gotify/ops");
    expect(one.json.values.server).toBe("https://gotify.lan");
    expect(one.json.secretsSet).toEqual(["token"]);
    expect(seen.join("\n")).not.toContain("GOTIFYSECRETTOKEN");
  });

  it("creates targets from validated fields and keeps secrets out of errors", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/datacenter/notifications/targets/gotify", { name: "g2", values: { server: "https://g.lan", token: "tok-123456" } })).status).toBe(200);
    expect((await send(sam, "POST", "/api/node/datacenter/notifications/targets/gotify", { name: "g3", values: { server: "https://g.lan" } })).status).toBe(400);
    const refused = await send(sam, "POST", "/api/node/datacenter/notifications/targets/gotify", { name: "g4", values: { server: "https://g.lan", token: "BADTOKEN" } });
    expect(refused.status).toBe(502);
    expect(refused.json.error).toContain("gotify refused");
    expect(JSON.stringify(refused.json)).not.toContain("BADTOKEN");
    expect((await send(sam, "POST", "/api/node/datacenter/notifications/targets/ftp", { name: "x", values: {} })).status).toBe(400);
    const smtp = await send(sam, "POST", "/api/node/datacenter/notifications/targets/smtp", { name: "mail1", values: { server: "smtp.lan", "from-address": "pve@lan.example", mailto: ["a@lan.example", "b@lan.example"], mode: "starttls", password: "pw-secret" } }); expect(smtp.json, JSON.stringify(smtp.json)).toMatchObject({ ok: true });
    expect(new URLSearchParams((pve.st as any).smtpPost).getAll("mailto")).toEqual(["a@lan.example", "b@lan.example"]);
    expect((await send(sam, "POST", "/api/node/datacenter/notifications/targets/smtp", { name: "mail2", values: { server: "smtp.lan", "from-address": "x", mode: "plain" } })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/datacenter/notifications/targets/webhook", { name: "hook1", values: { url: "https://hook.lan", method: "post", secret: ["name=token,value=c2VjcmV0"] } })).status).toBe(200);
    expect((await send(sam, "POST", "/api/node/datacenter/notifications/targets/webhook", { name: "hook2", values: { url: "https://hook.lan", method: "post", header: ["bad header"] } })).status).toBe(400);
  });

  it("tests a target and deletes only with the name typed", async () => {
    const sam = await signIn("sam");
    expect((await send(sam, "POST", "/api/node/datacenter/notifications/targets/ops/test", {})).status).toBe(200);
    expect((await send(sam, "DELETE", "/api/node/datacenter/notifications/targets/gotify/ops", { confirm: "x" })).status).toBe(400);
  });

  it("creates a matcher with list fields sent as repeated keys", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "POST", "/api/node/datacenter/notifications/matchers", { name: "backups", values: { mode: "any", target: ["ops", "mail-to-root"], "match-severity": ["error", "warning"], "match-field": ["exact:type=vzdump"] } });
    expect(r.status).toBe(200);
    const sent = new URLSearchParams(bodiesFor("POST", "/cluster/notifications/matchers")[0].body);
    expect(sent.getAll("target")).toEqual(["ops", "mail-to-root"]);
    expect(sent.getAll("match-severity")).toEqual(["error", "warning"]);
    expect((await send(sam, "POST", "/api/node/datacenter/notifications/matchers", { name: "bad", values: { "match-severity": ["loud"] } })).status).toBe(400);
    expect((await send(sam, "POST", "/api/node/datacenter/notifications/matchers", { name: "bad2", values: { "match-field": ["nonsense"] } })).status).toBe(400);
  });

  it("lists metric servers without their token and writes validated changes", async () => {
    const sam = await signIn("sam");
    const list = await send(sam, "GET", "/api/node/datacenter/metrics");
    expect(list.json.servers).toEqual([{ id: "graf", type: "influxdb", server: "10.0.0.5", port: 8086, disabled: false }]);
    const one = await send(sam, "GET", "/api/node/datacenter/metrics/graf");
    expect(one.json.hasToken).toBe(true);
    expect(seen.join("\n")).not.toContain("INFLUXTOKENSECRET1");
    expect((await send(sam, "POST", "/api/node/datacenter/metrics", { id: "g1", values: { type: "graphite", server: "graphite.lan", port: 2003, proto: "udp", path: "proxmox.lab" } })).status).toBe(200);
    for (const values of [{ type: "graphite", server: "graphite.lan", port: 0 }, { type: "graphite", server: "bad host!", port: 2003 }, { type: "carbon", server: "x", port: 1 }, { type: "graphite", server: "x", port: 2003, path: "a b" }]) expect((await send(sam, "POST", "/api/node/datacenter/metrics", { id: "g2", values })).status).toBe(400);
  });
});

describe("mappings, tags and the cluster", () => {
  it("lists resource mappings with their problems", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/datacenter/mappings");
    expect(r.json.pci.items[0]).toMatchObject({ id: "gpu0", problems: ["IOMMU group shared"] });
    expect(r.json.usb.items).toEqual([]);
  });

  it("shows tag colors and counts, and changes colors without touching the other style options", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/datacenter/tags");
    expect(r.json.tags.find((t: any) => t.tag === "prod")).toMatchObject({ count: 2, color: { background: "ff0000", foreground: null } });
    expect(r.json.style.shape).toBe("full");
    expect((await send(sam, "PUT", "/api/node/datacenter/tags", { colors: { prod: { background: "00ff00" }, web: null, db: { background: "112233", foreground: "ffffff" } } })).status).toBe(200);
    const style = String(pve.st.options["tag-style"]);
    expect(style).toContain("shape=full");
    expect(style).toContain("prod:00ff00");
    expect(style).not.toContain("web:");
    expect(style).toContain("db:112233:ffffff");
    for (const colors of [{ "bad tag": { background: "000000" } }, { prod: { background: "red" } }, { prod: { background: "00ff00", foreground: "zzzzzz" } }]) expect((await send(sam, "PUT", "/api/node/datacenter/tags", { colors })).status).toBe(400);
  });

  it("summarizes a cluster with its nodes, quorum and machine counts", async () => {
    const sam = await signIn("sam");
    const r = await send(sam, "GET", "/api/node/cluster");
    expect(r.json).toMatchObject({ clustered: true, name: "lab", quorate: true, guests: { running: 1, total: 2 } });
    expect(r.json.nodes.map((n: any) => [n.name, n.online, n.local])).toEqual([["pve", true, true], ["pve2", false, false]]);
    expect(r.json.nodes[0].guests).toEqual({ running: 1, total: 2 });
  });

  it("works for a single node with no cluster", async () => {
    const sam = await signIn("sam");
    const original = pve.transport;
    // A lone node: Proxmox lists no cluster entry and one node.
    const single = fakeNodePve();
    const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: async (req) => (new URL(req.url).pathname.endsWith("/cluster/status") ? { status: 200, body: JSON.stringify({ data: [{ type: "node", name: "pve", online: 1, local: 1, id: "node/pve" }] }) } : new URL(req.url).pathname.endsWith("/nodes") && req.method === "GET" ? { status: 200, body: JSON.stringify({ data: [{ node: "pve", status: "online" }] }) } : single.transport(req)) }, sessions: new SessionStore(), staticDir: null, secureCookies: false, state: new StateStore(mkdtempSync(join(tmpdir(), "epc-node-"))) });
    const s2 = createServer(app);
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
    const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
    const login = await fetch(b2 + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "sam", password: "right", realm: "pve" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const r = (await (await fetch(b2 + "/api/node/cluster", { headers: { Cookie: cookie } })).json()) as any;
    expect(r).toMatchObject({ clustered: false, name: null, quorate: true });
    expect(r.nodes).toHaveLength(1);
    s2.closeAllConnections();
    s2.close();
    void sam;
    void original;
  });
});

describe("tasks", () => {
  beforeEach(() => {
    pve.task("pve", "aptupdate", "sam@pve", { end: 1_700_000_500, status: "OK" });
    pve.task("pve", "vzdump", "lee@pve", { end: 1_700_000_600, status: "backup failed" });
    pve.task("pve", "qmstart", "sam@pve");
    pve.task("pve2", "vzdump", "sam@pve", { end: 1_700_000_700, status: "OK" });
  });

  it("lists tasks across nodes, newest first, with filters", async () => {
    const sam = await signIn("sam");
    const all = await send(sam, "GET", "/api/node/tasks?node=all");
    // pve2 is offline, so "all" covers only the nodes that can answer; it can still be asked for by name.
    expect(all.json.tasks.map((t: any) => t.type)).toEqual(["qmstart", "vzdump", "aptupdate"]);
    expect((await send(sam, "GET", "/api/node/tasks?node=pve2")).json.tasks.map((t: any) => t.node)).toEqual(["pve2"]);
    expect((await send(sam, "GET", "/api/node/tasks?node=pve&type=vzdump")).json.tasks).toHaveLength(1);
    expect((await send(sam, "GET", "/api/node/tasks?node=pve&user=lee@pve")).json.tasks[0].type).toBe("vzdump");
    expect((await send(sam, "GET", "/api/node/tasks?node=pve&status=error")).json.tasks.map((t: any) => t.status)).toEqual(["backup failed"]);
    expect((await send(sam, "GET", "/api/node/tasks?node=pve&status=running")).json.tasks.map((t: any) => t.type)).toEqual(["qmstart"]);
    for (const q of ["limit=0", "limit=9999", "type=a b", "user=a%0Ab", "status=weird", "since=x", "node=ghost"]) expect((await send(sam, "GET", `/api/node/tasks?${q}`)).status, q).toBe(400);
  });

  it("reads a task's log from a line onward and refuses odd task ids", async () => {
    const sam = await signIn("sam");
    const t = pve.st.tasks[2];
    t.log = ["one", "two", "three"];
    const a = await send(sam, "GET", `/api/node/tasks/${encodeURIComponent(t.upid)}`);
    expect(a.json).toMatchObject({ status: "running", lines: ["one", "two", "three"], next: 3 });
    t.log.push("four");
    const b = await send(sam, "GET", `/api/node/tasks/${encodeURIComponent(t.upid)}?start=3`);
    expect(b.json.lines).toEqual(["four"]);
    expect((await send(sam, "GET", "/api/node/tasks/not-a-task")).status).toBe(400);
    expect((await send(sam, "GET", `/api/node/tasks/${encodeURIComponent("UPID:ghost:1:1:1:x::sam@pve:")}`)).status).toBe(404);
  });

  it("doesn't show Proxmox's empty-log placeholder, and doesn't lose the first real line that follows it", async () => {
    const sam = await signIn("sam");
    const t = pve.st.tasks[2];
    t.log = [];
    const url = (start: number) => `/api/node/tasks/${encodeURIComponent(t.upid)}?start=${start}`;
    // Polled several times while it has written nothing: no lines, and the cursor stays where it was.
    let next = 0;
    for (let i = 0; i < 4; i++) {
      const r = await send(sam, "GET", url(next));
      expect(r.json.lines).toEqual([]);
      next = r.json.next;
    }
    expect(next).toBe(0);
    // The first real line arrives: it is returned, whole.
    t.log.push("Get:1 http://deb.debian.org trixie InRelease");
    const first = await send(sam, "GET", url(next));
    expect(first.json).toMatchObject({ lines: ["Get:1 http://deb.debian.org trixie InRelease"], next: 1 });
    t.log.push("TASK OK");
    const last = await send(sam, "GET", url(first.json.next));
    expect(last.json).toMatchObject({ lines: ["TASK OK"], next: 2 });
  });

  it("stops a running task as the signed-in person, and Proxmox decides who may", async () => {
    const sam = await signIn("sam");
    const t = pve.st.tasks[2];
    expect((await send(sam, "DELETE", `/api/node/tasks/${encodeURIComponent(t.upid)}`, {})).status).toBe(200);
    expect(t.end).toBeDefined();
    const lee = await signIn("lee");
    expect((await send(lee, "DELETE", `/api/node/tasks/${encodeURIComponent(pve.st.tasks[0].upid)}`, {})).status).toBe(403);
    expect(bodiesFor("DELETE", `/nodes/pve/tasks/${encodeURIComponent(pve.st.tasks[2].upid)}`)[0].user).toBe("sam@pve");
  });
});
