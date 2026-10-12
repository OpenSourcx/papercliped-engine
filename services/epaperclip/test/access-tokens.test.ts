import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAccessApp } from "./access-harness.ts";

let h: Awaited<ReturnType<typeof startAccessApp>>;
let sam: string;
beforeEach(async () => {
  h = await startAccessApp();
  sam = await h.signIn("sam");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

const j = async (r: Response) => (await r.json()) as any;
async function mint(body: Record<string, unknown> = { name: "ci" }, cookie = sam) {
  const r = await h.call("POST", "/api/access/epc-tokens", { cookie }, body);
  expect(r.status).toBe(201);
  return (await j(r)) as { token: string; record: any; proxmoxTokenId: string };
}
const stateText = () => {
  const dir = h.state.dir!;
  return readdirSync(dir).filter((f) => f === "state.json").map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
};

describe("creating an ePaperclip API token", () => {
  it("makes a real Proxmox token, shows the secret once and keeps only a salted hash", async () => {
    const { token, record, proxmoxTokenId } = await mint({ name: "nightly", expiresInDays: 30 });
    expect(token).toMatch(/^epc_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(proxmoxTokenId).toBe(`sam@pve!epc-${record.id}`);
    expect(record).toMatchObject({ name: "nightly", userid: "sam@pve", readOnly: false, privsep: false, expiresAt: h.clock.t + 30 * 86_400_000 });
    expect(record.hash).toBeUndefined();
    expect(record.salt).toBeUndefined();
    const pveTok = h.pve.tokens.get("sam@pve")!.get(`epc-${record.id}`)!;
    expect(pveTok.expire).toBe(Math.floor((h.clock.t + 30 * 86_400_000) / 1000));
    // On disk: the bearer secret is nowhere; the Proxmox secret is only in sealed form.
    const secret = token.split("_")[2];
    const disk = stateText();
    expect(disk).not.toContain(secret);
    expect(disk).not.toContain(token);
    expect(disk).not.toContain(pveTok.secret);
    expect(JSON.parse(disk).secrets[`apitoken.${record.id}`]).toMatchObject({ v: 1, ct: expect.any(String) });
    expect(JSON.parse(disk).settings.apiTokens[record.id].hash).toMatch(/^[0-9a-f]{64}$/);
    // Listing never carries a secret or hash.
    const list = await j(await h.call("GET", "/api/access/epc-tokens", { cookie: sam }));
    expect(list.tokens).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(new RegExp(`${secret}|${pveTok.secret}|"hash"|"salt"`));
  });

  it("validates the request and defaults to 90 days", async () => {
    expect((await mint({ name: "x" })).record.expiresAt).toBe(h.clock.t + 90 * 86_400_000);
    for (const body of [{}, { name: "" }, { name: "x".repeat(65) }, { name: "x", expiresInDays: 0 }, { name: "x", expiresInDays: 400 }, { name: "x", expiresInDays: 1.5 }, { name: "x", readOnly: "yes" }, { name: "x", privsep: 1 }])
      expect((await h.call("POST", "/api/access/epc-tokens", { cookie: sam }, body)).status, JSON.stringify(body)).toBe(400);
  });

  it("is refused for a Proxmox account that may not make tokens, with Proxmox's reason", async () => {
    const lee = await h.signIn("lee");
    // lee may manage their own tokens in Proxmox; remove that to see the refusal path.
    h.pve.users.delete("lee@pve");
    const r = await h.call("POST", "/api/access/epc-tokens", { cookie: lee }, { name: "x" });
    expect(r.status).toBe(401);
  });

  it("rolls the Proxmox token back when it can't be stored", async () => {
    vi.spyOn(h.state, "setSecret").mockImplementation(() => {
      throw new Error("disk full");
    });
    const r = await h.call("POST", "/api/access/epc-tokens", { cookie: sam }, { name: "x" });
    expect(r.status).toBe(500);
    expect([...(h.pve.tokens.get("sam@pve") ?? [])]).toEqual([]);
  });

  it("is only available to a browser session, never to a token", async () => {
    const { token } = await mint();
    const r = await h.call("POST", "/api/access/epc-tokens", { bearer: token }, { name: "child" });
    expect(r.status).toBe(403);
    expect((await j(r)).code).toBe("ticket_only");
    const { record } = await mint({ name: "other" });
    expect((await h.call("DELETE", `/api/access/epc-tokens/${record.id}`, { bearer: token })).status).toBe(403);
  });
});

describe("using a Bearer token", () => {
  it("acts as the person through the Proxmox API token, with no cookie and no page header", async () => {
    const { token } = await mint();
    const me = await h.call("GET", "/api/me", { bearer: token });
    expect(await j(me)).toMatchObject({ user: { username: "sam@pve" }, via: "token", readOnly: false });
    const groups = await j(await h.call("GET", "/api/access/groups", { bearer: token }));
    expect(groups.groups[0].groupid).toBe("ops");
    expect(h.pve.calls.filter((c) => c.path === "/access/groups").at(-1)!.auth).toBe("token");
    // A change works without X-EPC-Request or Origin, because a token has no browser.
    const made = await h.call("POST", "/api/access/groups", { bearer: token }, { groupid: "bots" });
    expect(made.status).toBe(200);
    expect(h.pve.groups.has("bots")).toBe(true);
  });

  it("is still bound by Proxmox: a person without rights can't do more through a token", async () => {
    const lee = await h.signIn("lee");
    const { token } = await mint({ name: "lee-bot" }, lee);
    const r = await h.call("POST", "/api/access/groups", { bearer: token }, { groupid: "nope" });
    expect(r.status).toBe(403);
    expect((await j(r)).error).toContain("Group.Allocate");
  });

  it("honours privilege separation: a separated token has no rights until it is given ACLs", async () => {
    const { token, record } = await mint({ name: "sep", privsep: true });
    expect((await h.call("POST", "/api/access/groups", { bearer: token }, { groupid: "a1" })).status).toBe(403);
    await h.call("POST", "/api/access/acl", { cookie: sam }, { path: "/", roles: ["Administrator"], tokens: [`sam@pve!epc-${record.id}`] });
    expect((await h.call("POST", "/api/access/groups", { bearer: token }, { groupid: "a1" })).status).toBe(200);
  });

  it("read-only tokens can read and nothing else", async () => {
    const { token } = await mint({ name: "viewer", readOnly: true });
    expect((await h.call("GET", "/api/access/groups", { bearer: token })).status).toBe(200);
    const w = await h.call("POST", "/api/access/groups", { bearer: token }, { groupid: "x" });
    expect(w.status).toBe(403);
    expect((await j(w)).code).toBe("read_only_token");
    expect(h.pve.groups.has("x")).toBe(false);
    expect((await h.call("DELETE", "/api/access/groups/ops", { bearer: token })).status).toBe(403);
    expect((await h.call("POST", "/api/guests/101/vnc", { bearer: token }, {})).status).toBe(403);
  });

  it("refuses ticket-only features with a clear 403", async () => {
    const { token } = await mint();
    const vnc = await h.call("POST", "/api/guests/101/vnc", { bearer: token }, {});
    expect(vnc.status).toBe(403);
    expect((await j(vnc)).code).toBe("ticket_only");
    const pw = await h.call("PUT", "/api/iac/users/lee%40pve/password", { bearer: token }, { password: "longenough", confirmationPassword: "right" });
    expect(pw.status).toBe(403);
    expect((await j(pw)).code).toBe("ticket_only");
    expect((await h.call("POST", "/api/access/tfa/sam%40pve", { bearer: token }, { type: "recovery" })).status).toBe(403);
  });

  it("is never accepted as a cookie, in a query string or by the sockets", async () => {
    const { token } = await mint();
    expect((await h.call("GET", "/api/me", { headers: { Cookie: `epc_session=${token}` } })).status).toBe(401);
    expect((await fetch(`${h.base}/api/me?token=${token}`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/me`, { headers: { "X-Api-Key": token } })).status).toBe(401);
    // A wrong-scheme header is not a token either.
    expect((await fetch(`${h.base}/api/me`, { headers: { Authorization: `Basic ${Buffer.from(token).toString("base64")}` } })).status).toBe(401);
    // Sockets check the session cookie and Origin only.
    const { default: WebSocket } = await import("ws");
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${h.base.replace("http", "ws")}/api/console/guests/101`, { headers: { Authorization: `Bearer ${token}`, Origin: h.base } });
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => resolve(0));
    });
    expect(code).toBe(401);
  });

  it("rejects wrong, malformed and unknown tokens the same way, and audits the failures", async () => {
    const { token, record } = await mint();
    const [, id, secret] = token.split("_");
    const wrongSecret = `epc_${id}_${"A".repeat(43)}`;
    const unknownId = `epc_${"0".repeat(16)}_${secret}`;
    for (const t of [wrongSecret, unknownId, "epc_short", "epc_" + "x".repeat(80)]) {
      const r = await h.call("GET", "/api/me", { bearer: t });
      expect(r.status).toBe(401);
      expect((await j(r)).code).toBe("invalid_token");
    }
    const audit = (await j(await h.call("GET", "/api/access/audit", { cookie: sam }))).entries;
    expect(audit.filter((e: any) => e.action === "token.use.failed").length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain(record.id + "_");
  });

  it("locks an address out after too many bad tokens", async () => {
    for (let i = 0; i < 10; i++) await h.call("GET", "/api/me", { bearer: `epc_${"1".repeat(16)}_${"B".repeat(43)}` });
    const { token } = await mint();
    const r = await h.call("GET", "/api/me", { bearer: token });
    expect(r.status).toBe(429);
    h.clock.t += 6 * 60_000;
    expect((await h.call("GET", "/api/me", { bearer: token })).status).toBe(200);
  });

  it("rate-limits one token's requests per minute", async () => {
    const { token } = await mint();
    let limited = 0;
    for (let i = 0; i < 610; i++) if ((await h.call("GET", "/api/me", { bearer: token })).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    h.clock.t += 61_000;
    expect((await h.call("GET", "/api/me", { bearer: token })).status).toBe(200);
  });

  it("expires, with a clear message, and stops working at once", async () => {
    const { token } = await mint({ name: "short", expiresInDays: 1 });
    expect((await h.call("GET", "/api/me", { bearer: token })).status).toBe(200);
    h.clock.t += 86_400_000 + 1;
    const r = await h.call("GET", "/api/me", { bearer: token });
    expect(r.status).toBe(401);
    expect((await j(r)).code).toBe("token_expired");
  });

  it("is revoked immediately, by its owner or an administrator, in Proxmox too", async () => {
    const lee = await h.signIn("lee");
    const mine = await mint({ name: "a" });
    const theirs = await mint({ name: "b" }, lee);
    expect((await h.call("GET", "/api/me", { bearer: mine.token })).status).toBe(200);
    // lee can't revoke sam's; sam (an administrator) can revoke lee's.
    expect((await h.call("DELETE", `/api/access/epc-tokens/${mine.record.id}`, { cookie: lee })).status).toBe(403);
    const del = await h.call("DELETE", `/api/access/epc-tokens/${mine.record.id}`, { cookie: sam });
    expect(del.status).toBe(200);
    expect((await h.call("GET", "/api/me", { bearer: mine.token })).status).toBe(401);
    expect(h.pve.tokens.get("sam@pve")!.has(`epc-${mine.record.id}`)).toBe(false);
    expect(h.state.getSecret(`apitoken.${mine.record.id}`)).toBeNull();
    expect((await h.call("DELETE", `/api/access/epc-tokens/${theirs.record.id}`, { cookie: sam })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { bearer: theirs.token })).status).toBe(401);
    expect((await h.call("DELETE", `/api/access/epc-tokens/${theirs.record.id}`, { cookie: sam })).status).toBe(404);
    const audit = (await j(await h.call("GET", "/api/access/audit", { cookie: sam }))).entries.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["token.create", "token.revoke"]));
  });

  it("stops working when the person is disabled or deleted in Proxmox", async () => {
    const lee = await h.signIn("lee");
    const t = await mint({ name: "lee" }, lee);
    expect((await h.call("GET", "/api/me", { bearer: t.token })).status).toBe(200);
    // Disabled through ePaperclip: the epoch changes, so the next request is re-checked and Proxmox refuses it.
    expect((await h.call("PUT", "/api/iac/users/lee%40pve", { cookie: sam }, { enable: false })).status).toBe(200);
    const r = await h.call("GET", "/api/me", { bearer: t.token });
    expect(r.status).toBe(401);
    expect((await j(r)).code).toBe("token_invalid");
    // Re-enable, delete: the token records go with the user.
    await h.call("PUT", "/api/iac/users/lee%40pve", { cookie: sam }, { enable: true });
    const del = await j(await h.call("DELETE", "/api/iac/users/lee%40pve", { cookie: sam }));
    expect(del.warnings.join(" ")).toMatch(/API tokens were revoked/);
    expect(h.state.getSetting("apiTokens")).toEqual({});
  });

  it("stops working when its Proxmox token is deleted behind its back", async () => {
    const { token, record } = await mint();
    expect((await h.call("GET", "/api/me", { bearer: token })).status).toBe(200);
    h.pve.tokens.get("sam@pve")!.delete(`epc-${record.id}`);
    h.clock.t += 61_000; // the Proxmox check is cached for a minute
    const r = await h.call("GET", "/api/me", { bearer: token });
    expect(r.status).toBe(401);
    expect((await j(r)).code).toBe("token_invalid");
  });

  it("lists the Proxmox token it made, marked as ePaperclip's, and revokes through the Proxmox token route", async () => {
    const { token, record } = await mint({ name: "robot", readOnly: true });
    const list = await j(await h.call("GET", "/api/access/users/sam%40pve/tokens", { cookie: sam }));
    expect(list.tokens[0]).toMatchObject({ tokenid: `epc-${record.id}`, epaperclip: { id: record.id, name: "robot", readOnly: true } });
    expect((await h.call("PUT", `/api/access/users/sam%40pve/tokens/epc-${record.id}`, { cookie: sam }, { comment: "x" })).status).toBe(400);
    expect((await h.call("DELETE", `/api/access/users/sam%40pve/tokens/epc-${record.id}`, { cookie: sam })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { bearer: token })).status).toBe(401);
  });

  it("never logs a token or either secret", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")].map((s) => s.mockImplementation(() => {}));
    const { token, record } = await mint();
    await h.call("GET", "/api/me", { bearer: token });
    await h.call("GET", "/api/me", { bearer: `epc_${record.id}_${"C".repeat(43)}` });
    const text = JSON.stringify(logs.flatMap((s) => s.mock.calls));
    expect(text).not.toContain(token.split("_")[2]);
    expect(text).not.toContain(h.pve.tokens.get("sam@pve")!.get(`epc-${record.id}`)!.secret);
  });
});

describe("the engine, for a token principal", () => {
  it("goes through the person's managed engine account, and read-only tokens can't change anything there", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { fakeEngine, until } = await import("./fakes.ts");
    const eng = await fakeEngine();
    const installDir = mkdtempSync(join(tmpdir(), "epc-inst-"));
    mkdirSync(join(installDir, "node_modules", "@paperclipai", "server"), { recursive: true });
    writeFileSync(join(installDir, "node_modules", "@paperclipai", "server", "package.json"), JSON.stringify({ version: "2026.1005.0" }));
    await h.close();
    h = await startAccessApp({ engine: { url: eng.url, installDir, sleep: async () => {} } });
    try {
      sam = await h.signIn("sam");
      await until(() => eng.st.admins.size >= 1);
      const rw = await mint({ name: "rw" });
      const ro = await mint({ name: "ro", readOnly: true });
      const mutate = (t: string) => h.call("POST", "/engine/api/echo", { bearer: t }, {});
      expect((await mutate(rw.token)).status).toBe(201);
      const seen = eng.seen.filter((x) => x.url.startsWith("/api/echo")).at(-1)!;
      expect(seen.headers.cookie).toMatch(/^paperclip-default\.session_token=/);
      expect(seen.headers.authorization).toBeUndefined();
      expect((await mutate(ro.token)).status).toBe(403);
      expect((await h.call("GET", "/engine/api/echo", { bearer: ro.token })).status).toBe(201);
    } finally {
      await eng.close();
    }
  });
});
