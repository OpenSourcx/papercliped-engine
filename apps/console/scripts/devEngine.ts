import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ProxyOptions } from "vite";

/**
 * Development only: lets `vite dev` stand in for the host service so the console's live mode can be worked on against
 * a real Paperclip engine, with no Proxmox host. Off unless EPC_DEV_ENGINE is set (e.g. http://127.0.0.1:3100); it is
 * a dev-server plugin, so a production build never contains it.
 *
 * - /engine/api/* goes to the engine's /api/* as a throwaway engine account this plugin signs up, the way the host
 *   service forwards as the signed-in person's managed account. Browser cookies are never forwarded.
 * - /api/me answers as a pretend Proxmox user, so the console starts in live mode. /api/host answers with an empty host.
 * - /api/engine/status, /api/connectors and /api/resource-groups are small in-memory stand-ins shaped like the host
 *   service's (services/epaperclip). EPC_DEV_RG_FAIL=1 makes resource groups fail; EPC_DEV_CONNECTORS_ADMIN=0 makes
 *   connector writes 403. To test against the real host service instead, run it and point the console at it.
 *
 * The engine account's credentials stay in node_modules/.cache (never committed). EPC_DEV_ENGINE_COOKIE uses an existing
 * engine session instead, for example one with admin rights, since only instance admins may create organizations.
 */

interface Jar { email: string; password: string; cookie: string }

const cacheFile = join(dirname(new URL(import.meta.url).pathname), "..", "node_modules", ".cache", "epc-dev-engine.json");

async function session(engine: string): Promise<string> {
  if (process.env.EPC_DEV_ENGINE_COOKIE) return process.env.EPC_DEV_ENGINE_COOKIE;
  const headers = { "Content-Type": "application/json", Origin: engine };
  const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const save = (j: Jar) => {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(j), { mode: 0o600 });
  };
  let jar: Jar | null = existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, "utf8")) as Jar) : null;
  if (jar) {
    const me = await fetch(`${engine}/api/cli-auth/me`, { headers: { Cookie: jar.cookie } });
    if (me.ok) return jar.cookie;
    const r = await fetch(`${engine}/api/auth/sign-in/email`, { method: "POST", headers, body: JSON.stringify({ email: jar.email, password: jar.password }) });
    if (r.ok) {
      jar = { ...jar, cookie: cookieOf(r) };
      save(jar);
      return jar.cookie;
    }
  }
  const email = `console-dev-${Date.now()}@example.invalid`;
  const password = randomBytes(24).toString("base64url");
  const r = await fetch(`${engine}/api/auth/sign-up/email`, { method: "POST", headers, body: JSON.stringify({ email, password, name: "Console Developer" }) });
  if (!r.ok) throw new Error(`Engine sign-up failed (${r.status}): ${await r.text()}`);
  jar = { email, password, cookie: cookieOf(r) };
  save(jar);
  return jar.cookie;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

export function devEngine(): Plugin | null {
  const engine = process.env.EPC_DEV_ENGINE?.replace(/\/$/, "");
  if (!engine) return null;
  const connectors = new Map<string, { id: string; kind: string; label: string; configured: boolean; last4?: string; updatedAt?: string; updatedBy?: string; testedAt?: string; ok?: boolean; error?: string }>(
    [["anthropic", "Anthropic"], ["openai", "OpenAI"], ["gemini", "Google Gemini"], ["openrouter", "OpenRouter"]].map(([id, label]) => [id, { id, kind: "model", label, configured: false }]),
  );
  const admin = process.env.EPC_DEV_CONNECTORS_ADMIN !== "0";
  const groups = new Map<string, Record<string, unknown>>();
  let cookie = "";

  return {
    name: "epc-dev-engine",
    apply: "serve",
    async config() {
      cookie = await session(engine);
      const proxy: ProxyOptions = {
        target: engine,
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/engine\/api/, "/api"),
        configure: (p) => {
          const asEngineUser = (proxyReq: { setHeader: (k: string, v: string) => void; removeHeader: (k: string) => void }) => {
            proxyReq.removeHeader("x-epc-request");
            proxyReq.setHeader("cookie", cookie);
            proxyReq.setHeader("origin", engine);
          };
          p.on("proxyReq", asEngineUser);
          p.on("proxyReqWs", asEngineUser);
          p.on("proxyRes", (r) => delete r.headers["set-cookie"]);
        },
      };
      return { server: { proxy: { "/engine/api": proxy } } };
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://dev");
        const path = url.pathname;
        const method = req.method ?? "GET";
        // Like the host service: writes need the request header, so a plain form post can't drive the engine.
        if (path.startsWith("/engine/api/") && method !== "GET" && req.headers["x-epc-request"] !== "1") return send(res, 403, { error: "Missing request header", code: "csrf" });
        // Like the host service: the engine's own sign-in and setup routes are never reachable from a browser.
        if (/^\/engine\/api\/(auth|bootstrap)(\/|$)/.test(path) || (path.startsWith("/engine/api/cli-auth") && !(method === "GET" && path === "/engine/api/cli-auth/me"))) return send(res, 403, { error: "Not available through the console", code: "forbidden" });
        if (!path.startsWith("/api/")) return next();
        if (path === "/api/me") return send(res, 200, { user: { username: "developer@pve", name: "Developer", realm: "pve", node: "pve" } });
        if (path === "/api/host") return send(res, 200, { node: "pve", version: "dev", status: null, resources: [], storage: [] });
        if (path === "/api/engine/status") {
          try {
            const h = (await (await fetch(`${engine}/api/health`)).json()) as { status?: string; bootstrapStatus?: string; commit?: string };
            const ready = h.status === "ok" && h.bootstrapStatus === "ready";
            return send(res, 200, { installed: true, reachable: true, ready, version: h.commit ?? null, bootstrap: h.bootstrapStatus === "ready" ? "ready" : "pending", serviceAccount: "ours" });
          } catch (e) {
            return send(res, 200, { installed: true, reachable: false, ready: false, version: null, bootstrap: "pending", serviceAccount: "error", error: String(e) });
          }
        }
        if (path === "/api/connectors" && method === "GET") return send(res, 200, { connectors: [...connectors.values()], canManage: admin });
        const conn = path.match(/^\/api\/connectors\/([^/]+)\/(credential|test)$/);
        if (conn) {
          const c = connectors.get(decodeURIComponent(conn[1]));
          if (!c) return send(res, 404, { error: "Unknown connector", code: "not_found" });
          if (!admin) return send(res, 403, { error: "Only Proxmox administrators (Sys.Modify on /) can change connectors", code: "forbidden" });
          if (conn[2] === "credential" && method === "PUT") {
            const key = String((await readBody(req)).apiKey ?? "");
            if (key.length < 8) return send(res, 400, { error: "That doesn't look like a key", code: "invalid" });
            Object.assign(c, { configured: true, last4: key.slice(-4), updatedAt: new Date().toISOString(), updatedBy: "developer@pve", testedAt: undefined, ok: undefined, error: undefined });
            return send(res, 200, { connector: c });
          }
          if (conn[2] === "credential" && method === "DELETE") {
            Object.assign(c, { configured: false, last4: undefined, testedAt: undefined, ok: undefined });
            return send(res, 200, { ok: true });
          }
          if (conn[2] === "test" && method === "POST") {
            if (!c.configured) return send(res, 404, { error: `${c.label} has no API key yet`, code: "not_configured" });
            Object.assign(c, { testedAt: new Date().toISOString(), ok: true });
            return send(res, 200, { connector: c });
          }
        }
        if (path === "/api/resource-groups" && method === "GET") return send(res, 200, { groups: [...groups.values()] });
        const rg = path.match(/^\/api\/resource-groups\/([^/]+)$/);
        if (rg && method === "PUT") {
          const companyId = decodeURIComponent(rg[1]);
          if (process.env.EPC_DEV_RG_FAIL === "1") return send(res, 502, { error: "Proxmox refused to create the pool (dev failure)", code: "proxmox" });
          const b = await readBody(req);
          const name = String(b.name ?? "org");
          const g = { companyId, name, pool: `epc-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}`, cores: Number(b.cores), memoryMb: Number(b.memoryMb), diskGb: Number(b.diskGb), maxGuests: Number(b.maxGuests), updatedAt: new Date().toISOString(), updatedBy: "developer@pve" };
          groups.set(companyId, g);
          return send(res, 200, { group: g });
        }
        return send(res, 404, { error: "Not part of the engine dev setup", code: "dev_unavailable" });
      });
    },
  };
}
