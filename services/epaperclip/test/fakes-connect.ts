import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedEmail } from "../src/engine.ts";
import type { Transport } from "@papercliped-engine/proxmox-client";
import { fakeEngine, until } from "./fakes.ts";
import { startPinApp } from "./fakes-pin.ts";

/**
 * Test support for the connector features (docs/CONNECTORS.md): a running host service with Proxmox (guests, power,
 * snapshots, tokens), an engine with a few organizations and the endpoints the app tools use, and helpers that walk
 * the whole OAuth dance the way an MCP client does (register, authorize in the console, exchange the code, refresh).
 */

type Json = Record<string, any>;

/** An engine that adds, in front of the stock fake, the task, agent, approval and goal endpoints the app tools call. */
export async function overlayEngine(eng: Awaited<ReturnType<typeof fakeEngine>>) {
  const issues = new Map<string, Json>([["i1", { id: "i1", identifier: "NW-1", title: "Ship it", status: "todo", companyId: "co_1", description: "Do the thing" }], ["i9", { id: "i9", identifier: "SE-1", title: "Secret plan", status: "todo", companyId: "co_2" }]]);
  const agents = new Map<string, Json>([["ag1", { id: "ag1", name: "CEO", role: "ceo", status: "idle", companyId: "co_1" }], ["ag9", { id: "ag9", name: "Spy", role: "ops", status: "idle", companyId: "co_2" }]]);
  const approvals = new Map<string, Json>([["ap1", { id: "ap1", type: "hire_agent", status: "pending", companyId: "co_1" }], ["ap9", { id: "ap9", type: "hire_agent", status: "pending", companyId: "co_2" }]]);
  const seen: { method: string; url: string; body: Json }[] = [];
  const logins = new Map<string, Json>();
  const aiConnections: Json[] = [];
  const loginMode = { raw: null as null | ((id: string, polls: number) => Json) };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url!, "http://engine");
    const p = u.pathname;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const overlay = /\/(adapters\/[\w-]+\/login-sessions|setup-token-login-sessions|ai-connections)/.test(p) || /^\/api\/(issues|agents|approvals)\/[\w-]+/.test(p) || /^\/api\/companies\/[\w-]+\/(goals|projects|costs\/summary)/.test(p) || (/^\/api\/companies\/[\w-]+\/issues$/.test(p) && req.method === "POST");
    if (!overlay) {
      // Everything else is the stock fake engine.
      const r = await fetch(eng.url + req.url, { method: req.method, headers: req.headers as Record<string, string>, body: ["GET", "HEAD"].includes(req.method!) ? undefined : raw });
      res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k)).map(([k, v]) => [k, v])));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    // The person must be signed in to the engine (the stock fake knows the cookie).
    const who = await fetch(`${eng.url}/api/cli-auth/me`, { headers: { cookie: req.headers.cookie ?? "" } });
    if (who.status !== 200) return send(401, { error: "Board authentication required" });
    const me = (await who.json()) as { companyIds: string[]; isInstanceAdmin: boolean };
    const body = (): Json => (raw.length ? JSON.parse(raw.toString()) : {});
    if (req.method !== "GET") seen.push({ method: req.method!, url: req.url!, body: body() });
    const inCompany = (cid: string) => me.companyIds.includes(cid);
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/api\/companies\/([\w-]+)\/issues$/)) && req.method === "POST") {
      if (!inCompany(m[1])) return send(403, { error: "Not a member" });
      const b = body();
      const id = `i${issues.size + 100}`;
      issues.set(id, { id, identifier: `NW-${issues.size}`, companyId: m[1], status: "todo", ...b });
      return send(201, issues.get(id));
    }
    if ((m = p.match(/^\/api\/companies\/([\w-]+)\/(goals|projects)$/))) {
      if (!inCompany(m[1])) return send(403, { error: "Not a member" });
      if (req.method === "POST") return send(201, { id: "g1", ...body() });
      return send(200, [{ id: "g0", title: "Grow", name: "Site", level: "company", status: "active" }]);
    }
    if ((m = p.match(/^\/api\/companies\/([\w-]+)\/costs\/summary$/))) return inCompany(m[1]) ? send(200, { spendCents: 1234, budgetCents: 50000 }) : send(403, { error: "Not a member" });
    if ((m = p.match(/^\/api\/companies\/([\w-]+)\/ai-connections$/))) {
      if (!inCompany(m[1])) return send(403, { error: "Not a member" });
      if (req.method === "POST") {
        const b = body();
        const c = { id: `conn${aiConnections.length + 1}`, provider: b.provider, method: b.method, name: b.name, ownership: b.ownership, status: "connected", apiKey: b.apiKey };
        aiConnections.push(c);
        return send(201, { ...c, echoed: `rejected key ${b.apiKey}` });
      }
      return send(200, { connections: aiConnections });
    }
    if ((m = p.match(/^\/api\/companies\/([\w-]+)\/(?:adapters\/[\w-]+\/login-sessions|setup-token-login-sessions)(?:\/([\w-]+))?(\/prompt|\/code|\/cancel)?$/))) {
      if (!inCompany(m[1])) return send(403, { error: "Not a member" });
      if (req.method === "POST" && !m[2]) {
        const id = `ls${logins.size + 1}`;
        logins.set(id, { id, polls: 0, body: body() });
        return send(201, { id, status: "starting" });
      }
      const l = logins.get(m[2] ?? "");
      if (!l) return send(404, { error: "No such session" });
      if (m[3] === "/cancel") return send(200, { ok: true });
      if (m[3] === "/code") return send(200, { id: l.id, status: "completed", echoed: body().browserCode });
      l.polls++;
      if (loginMode.raw) return send(200, loginMode.raw(l.id, l.polls));
      if (l.polls < 2) return send(200, { id: l.id, status: "waiting_for_browser", verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", expiresAt: Date.now() + 600_000, accessToken: "sk-ant-oat01-SECRETSECRETSECRET", output: "Go to https://evil.example/phish and enter code ZZZZ-9999 (also https://claude.ai/device)" });
      return send(200, { id: l.id, status: "completed", credential: { token: "sk-ant-oat01-SECRETSECRETSECRET" } });
    }
    const pick = (map: Map<string, Json>, id: string) => {
      const x = map.get(id);
      return x && inCompany(x.companyId) ? x : null;
    };
    if ((m = p.match(/^\/api\/issues\/([\w-]+)(\/comments)?$/))) {
      const i = pick(issues, m[1]);
      if (!i) return send(404, { error: "Issue not found" });
      if (m[2] && req.method === "POST") return send(201, { id: "c1", ...body() });
      if (req.method === "PATCH") return send(200, Object.assign(i, body()));
      return send(200, i);
    }
    if ((m = p.match(/^\/api\/agents\/([\w-]+)(?:\/(wakeup|pause|resume))?$/))) {
      const a = pick(agents, m[1]);
      if (!a) return send(404, { error: "Agent not found" });
      if (m[2]) {
        if (m[2] === "pause") a.status = "paused";
        if (m[2] === "resume") a.status = "idle";
        return send(200, a);
      }
      return send(200, a);
    }
    if ((m = p.match(/^\/api\/approvals\/([\w-]+)(?:\/(approve|reject))?$/))) {
      const a = pick(approvals, m[1]);
      if (!a) return send(404, { error: "Approval not found" });
      if (m[2]) {
        a.status = m[2] === "approve" ? "approved" : "rejected";
        return send(200, a);
      }
      return send(200, a);
    }
    send(404, { error: "Not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, issues, agents, approvals, seen, logins, aiConnections, loginMode, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export const pkce = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export interface ConnectApp extends Awaited<ReturnType<typeof startPinApp>> {
  eng: Awaited<ReturnType<typeof fakeEngine>>;
  overlay: Awaited<ReturnType<typeof overlayEngine>>;
  sam: string;
  lee: string;
  /** Registers a client the way an MCP app does. */
  register(redirect?: string, name?: string): Promise<{ client_id: string; redirect: string }>;
  /** Registers, approves in the console as `cookie`, and exchanges the code. */
  connect(o?: { cookie?: string; scope?: string; direct?: boolean; orgs?: string[] | null; name?: string; redirect?: string }): Promise<{ access: string; refresh: string; clientId: string; grantId: string; redirect: string }>;
  /** One MCP JSON-RPC call with a Bearer token. */
  mcp(token: string | null, body: unknown, headers?: Record<string, string>): Promise<Response>;
  /** tools/call, parsed. */
  tool(token: string, name: string, args?: Json): Promise<{ isError: boolean; text: string; data: any }>;
  closeAll(): Promise<void>;
}

export async function startConnectApp(o: { staticDir?: string | null; providers?: (url: string, init: RequestInit) => Promise<Response> } = {}): Promise<ConnectApp> {
  const eng = await fakeEngine();
  const overlay = await overlayEngine(eng);
  const installDir = mkdtempSync(join(tmpdir(), "epc-conn-inst-"));
  mkdirSync(join(installDir, "node_modules", "@paperclipai", "server"), { recursive: true });
  writeFileSync(join(installDir, "node_modules", "@paperclipai", "server", "package.json"), JSON.stringify({ version: "2026.1005.0" }));
  // The stock fake has no guest config or cluster status; add just those two reads.
  const extras = (base: Transport): Transport => (req) => {
    const u = new URL(req.url);
    const path = u.pathname.replace("/api2/json", "");
    const cfg = path.match(/^\/nodes\/pve\/(lxc|qemu)\/(\d+)\/config$/);
    if (cfg && req.method === "GET") return Promise.resolve({ status: 200, body: JSON.stringify({ data: { cores: 2, memory: 2048, hostname: "web", password: "hunter2", "ssh-public-keys": "ssh-rsa AAA" } }) });
    if (path === "/cluster/status" && req.method === "GET") return Promise.resolve({ status: 200, body: JSON.stringify({ data: [{ type: "node", name: "pve", online: 1, local: 1, ip: "10.0.0.2" }] }) });
    return base(req);
  };
  const app = await startPinApp({ engine: { url: overlay.url, installDir, sleep: async () => {} }, staticDir: o.staticDir, providers: o.providers, pveTransport: extras });
  const sam = await app.signIn("sam");
  await until(() => eng.st.admins.size >= 1);
  const lee = await app.signIn("lee");
  // Their engine accounts are made in the background at sign-in. Give them organizations: sam owns two, lee is in the first.
  await until(() => eng.userId(managedEmail("sam@pve")) !== null && eng.userId(managedEmail("lee@pve")) !== null, 5000);
  const samId = eng.userId(managedEmail("sam@pve"))!;
  const leeId = eng.userId(managedEmail("lee@pve"))!;
  eng.company("co_1", "Northwind", { [samId]: "owner", [leeId]: "operator" });
  eng.company("co_2", "Secret Ops", { [samId]: "owner" });

  const json = (r: Response) => r.json() as Promise<Json>;
  const register = async (redirect = "https://claude.ai/api/mcp/auth_callback", name = "Claude") => {
    const r = await fetch(`${app.base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    if (r.status !== 201) throw new Error(`register failed ${r.status} ${await r.text()}`);
    return { client_id: ((await json(r)).client_id as string), redirect };
  };
  const connect: ConnectApp["connect"] = async (c = {}) => {
    const cookie = c.cookie ?? sam;
    const { client_id, redirect } = await register(c.redirect, c.name);
    const { verifier, challenge } = pkce();
    const base = { client_id, redirect_uri: redirect, response_type: "code", scope: c.scope ?? "paperclip:control", state: "st-123", code_challenge: challenge, code_challenge_method: "S256", resource: `${app.base}/mcp` };
    const consent = await app.call("POST", "/api/connect/oauth/consent", { cookie }, { ...base, approve: true, direct: c.direct, orgs: c.orgs });
    if (consent.status !== 200) throw new Error(`consent failed ${consent.status} ${await consent.text()}`);
    const back = new URL(((await json(consent)).redirect as string));
    const code = back.searchParams.get("code")!;
    const t = await fetch(`${app.base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id, code_verifier: verifier }) });
    const tok = await json(t);
    if (t.status !== 200) throw new Error(`token failed ${t.status} ${JSON.stringify(tok)}`);
    return { access: tok.access_token, refresh: tok.refresh_token, clientId: client_id, grantId: (tok.access_token as string).split("_")[1], redirect };
  };
  const mcp: ConnectApp["mcp"] = (token, body, headers = {}) =>
    fetch(`${app.base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
  let rid = 0;
  const tool: ConnectApp["tool"] = async (token, name, args = {}) => {
    const r = await mcp(token, { jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } });
    const j = await json(r);
    if (j.error) throw new Error(`rpc error ${JSON.stringify(j.error)}`);
    const text = j.result.content[0].text as string;
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { isError: j.result.isError === true, text, data };
  };
  const closeAll = async () => {
    await app.close();
    await overlay.close();
    await eng.close();
  };
  return { ...app, eng, overlay, sam, lee, register, connect, mcp, tool, closeAll };
}

export type { IncomingMessage };

/** An OpenAI-compatible server (Ollama, LM Studio ...) that can be told to fail, and remembers what it was asked. */
export async function fakeCompat(opts: { key?: string; models?: string[] } = {}) {
  const st = { fail: 0 as number, failStatus: 503, asked: [] as { method: string; url: string; auth: string | undefined; body: string }[], reply: "Hello from the local model." };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    st.asked.push({ method: req.method!, url: req.url!, auth: req.headers.authorization as string | undefined, body });
    if (opts.key && req.headers.authorization !== `Bearer ${opts.key}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${(req.headers.authorization ?? "").replace("Bearer ", "")}` } }));
    }
    if (st.fail > 0 && req.url!.includes("chat")) {
      st.fail--;
      res.writeHead(st.failStatus, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "overloaded" } }));
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: (opts.models ?? ["llama3.2", "qwen2.5"]).map((id) => ({ id, object: "model" })) }));
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: st.reply } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { base, st, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
