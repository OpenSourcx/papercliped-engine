import { TOOLS, runTool, toolFailure, type PinToolHost } from "../pin.ts";
import type { FeatureCtx } from "./index.ts";

/**
 * A small, read-only MCP endpoint for outside AI apps and bridges (Papercliped, Claude, any MCP client): `POST /api/mcp`
 * with `Authorization: Bearer epc_...` (an ePaperclip API token, docs/API.md). It speaks MCP's streamable HTTP transport
 * in its simplest form: one JSON-RPC message per POST, answered with one JSON body.
 *
 * What it offers is Pin's read-only tools (host status, machines, storage, tasks, organizations), run as the token's
 * person with the token's own Proxmox permissions, so Proxmox decides what comes back. It offers no tool that changes
 * anything: changes stay in the console, where a person approves them. Only Bearer tokens are accepted, never the
 * console's cookie, so a web page can't drive it.
 */

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const READ_TOOLS = TOOLS.filter((t) => !t.action);
const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function mcpRoute(ctx: FeatureCtx): Promise<boolean> {
  if (ctx.path !== "/api/mcp") return false;
  const { HttpError } = ctx;
  if (ctx.method !== "POST") throw new HttpError(405, "method", "This MCP endpoint takes POST requests with one JSON-RPC message each.");
  const s = ctx.session();
  if (!s.apiToken) throw new HttpError(401, "token_required", "Send an ePaperclip API token as a Bearer credential (docs/API.md).");
  ctx.sameSite();
  const b = (await ctx.readJson(64 * 1024)) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (b.jsonrpc !== "2.0" || typeof b.method !== "string") return ctx.json(200, fail(b.id, -32600, "Send one JSON-RPC 2.0 request.")), true;
  const params = b.params && typeof b.params === "object" && !Array.isArray(b.params) ? (b.params as Record<string, unknown>) : {};
  const notification = b.id === undefined;

  switch (b.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ctx.json(200, rpc(b.id, { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "epaperclip", title: "ePaperclip (read-only)" }, instructions: "Read-only view of this Proxmox host and its organizations. Changes are made in the ePaperclip console." })), true;
    }
    case "ping":
      return ctx.json(200, rpc(b.id, {})), true;
    case "tools/list":
      return ctx.json(200, rpc(b.id, { tools: READ_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters, annotations: { readOnlyHint: true } })) })), true;
    case "tools/call": {
      const def = READ_TOOLS.find((t) => t.name === params.name);
      if (!def) return ctx.json(200, fail(b.id, -32602, `There is no read-only tool called ${String(params.name).slice(0, 60)}.`)), true;
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const gw = ctx.gateway;
      const host: PinToolHost = {
        node: ctx.node,
        username: s.username,
        pve: () => ctx.asUser(async (pve) => pve),
        engine: <T,>(p: string) => {
          if (!gw) throw new HttpError(503, "engine_unavailable", "The engine isn't set up on this host.");
          return gw.userJson<T>(s, "GET", p);
        },
      };
      try {
        const out = await runTool(def.name, args, host);
        const t = JSON.stringify(out);
        return ctx.json(200, rpc(b.id, { content: [{ type: "text", text: t.length > 100_000 ? `${t.slice(0, 100_000)}... (cut short)` : t }], isError: false })), true;
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) throw e;
        return ctx.json(200, rpc(b.id, { content: [{ type: "text", text: toolFailure(e) }], isError: true })), true;
      }
    }
  }
  if (notification) {
    ctx.res.writeHead(202, { "Cache-Control": "no-store" });
    ctx.res.end();
    return true;
  }
  return ctx.json(200, fail(b.id, -32601, "That MCP method isn't supported here.")), true;
}
