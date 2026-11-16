/**
 * A host-side relay that lets an agent container reach exactly two of Paperclip's routes, its MCP servers.
 *
 * Paperclip builds the MCP addresses it hands an agent from its own `PAPERCLIP_API_URL`, which on an ePaperclip host is
 * `http://127.0.0.1:<port>` (the engine listens on host loopback only, in authenticated mode). Inside a container that
 * address is the container's own loopback, so every MCP connection is refused. The sandbox bridge cannot carry them: its
 * route allowlist has no MCP routes. So the provider gives each container a loopback port with the engine's number that
 * ends here (see mcp-tunnel.ts), and this relay forwards only the MCP routes to the engine.
 *
 * What it keeps:
 *  - Paperclip's own authentication. The request's Authorization header (the run-scoped bearer) goes to the engine untouched;
 *    the relay holds no credential and never adds one. The engine still decides who may call.
 *  - The engine bound to host loopback. The relay listens on host loopback too, only reachable through the SSH tunnel the
 *    provider opens to a container it owns.
 *  - A closed surface: three method+path pairs, a short header allowlist, a body size limit, and one fixed destination.
 */
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface McpRoute { method: string; path: string }

/** The only routes forwarded: Paperclip's connections server (GET, POST) and projects server (POST). */
export const MCP_ROUTES: readonly McpRoute[] = [
  { method: "GET", path: "/mcp/runtime-tools" },
  { method: "POST", path: "/mcp/runtime-tools" },
  { method: "POST", path: "/api/mcp/project-tools" },
];

/** Request headers the MCP clients use (streamable HTTP). Everything else, cookies included, is dropped. */
const FORWARD_REQUEST_HEADERS = ["authorization", "content-type", "content-length", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id", "user-agent"];
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-length", "cache-control", "mcp-session-id", "www-authenticate", "retry-after"];
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface McpRelayOptions {
  /** The engine's base address, e.g. http://127.0.0.1:3100. Must be a loopback host. */
  target: string;
  log?: (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void;
}

export interface McpRelay {
  port: number;
  close(): Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

/** The route this request asks for, or null. The path must already be exact: no query, no encoded separators, no dot segments. */
export function matchRoute(method: string | undefined, rawUrl: string | undefined): McpRoute | null {
  if (!method || !rawUrl) return null;
  const q = rawUrl.indexOf("?");
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  if (/%|\\|\/\.{1,2}(\/|$)|\/\//.test(path)) return null;
  const canonical = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return MCP_ROUTES.find((r) => r.method === method.toUpperCase() && r.path === canonical) ?? null;
}

function deny(res: ServerResponse, status: number, code: string): void {
  if (res.headersSent) return void res.destroy();
  const body = JSON.stringify({ error: code });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

export async function startMcpRelay(options: McpRelayOptions): Promise<McpRelay> {
  const target = new URL(options.target);
  if (target.protocol !== "http:" || !isLoopbackHost(target.hostname)) {
    throw new Error("The MCP relay only forwards to the engine on host loopback.");
  }
  const log = options.log ?? (() => undefined);
  const server: Server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const route = matchRoute(req.method, req.url);
    if (!route) return deny(res, 404, "not_found");
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) return deny(res, 413, "too_large");
    const headers: Record<string, string> = {};
    for (const name of FORWARD_REQUEST_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string") headers[name] = v;
    }
    headers.host = target.host;
    const upstream = http.request({ host: target.hostname, port: target.port || 80, method: route.method, path: route.path, headers }, (up) => {
      const out: Record<string, string | string[]> = {};
      for (const name of FORWARD_RESPONSE_HEADERS) {
        const v = up.headers[name];
        if (v !== undefined) out[name] = v;
      }
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res); // streamed, so an event-stream answer is not buffered
      up.on("error", () => res.destroy());
    });
    let received = 0;
    req.on("data", (c: Buffer) => {
      received += c.length;
      if (received > MAX_BODY_BYTES) { upstream.destroy(); deny(res, 413, "too_large"); req.destroy(); }
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    upstream.on("error", (error) => {
      log("warn", "MCP relay could not reach the engine", { error: error.message });
      deny(res, 502, "engine_unreachable");
    });
    req.pipe(upstream);
  });
  server.requestTimeout = 0; // an MCP event stream stays open for the whole run
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  log("info", "MCP relay listening on host loopback", { port });
  return { port, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}
