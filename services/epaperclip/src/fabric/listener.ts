import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { FabricHub, Sock } from "./hub.ts";
import { HttpError, readJson, sendJson } from "../http.ts";

/**
 * Two small listeners, both narrow:
 *   worker listener   GET /fabric/v1/health and the WebSocket at /fabric/v1/connect. Nothing else. Everything that
 *                     matters happens inside the encrypted, authenticated channel (hub.accept).
 *   control listener  /control/v1/*, loopback only, a bearer token per organization. The provider plugin uses it.
 *                     It has no route that adds, removes or powers off a worker.
 */

export function workerListener(hub: FabricHub): Server {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/fabric/v1/health") return sendJson(res, 200, { ok: true });
    res.writeHead(404).end();
  });
  server.headersTimeout = 10_000;
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/fabric/v1/connect") return void socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    const remote = req.socket.remoteAddress ?? "unknown";
    wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws as unknown as Sock, remote));
  });
  return server;
}

const bearer = (req: IncomingMessage) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);

function requirements(v: unknown) {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  return {
    ...(typeof r.arch === "string" ? { arch: r.arch } : {}),
    ...(strs(r.tools) ? { tools: strs(r.tools) } : {}),
    ...(typeof r.gpu === "boolean" ? { gpu: r.gpu } : {}),
    ...(typeof r.localModel === "string" ? { localModel: r.localModel } : {}),
    ...(typeof r.minFreeMemMb === "number" ? { minFreeMemMb: r.minFreeMemMb } : {}),
  };
}

export function controlHandler(hub: FabricHub) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const company = hub.companyForToken(bearer(req));
      if (!company) throw new HttpError(401, "unauthorized", "A valid control token is required.");
      const path = (req.url ?? "").split("?")[0]!;
      if (req.method !== "POST" || !path.startsWith("/control/v1/")) throw new HttpError(404, "not_found", "Not found");
      const b = await readJson(req, 256 * 1024);
      const claimed = typeof b.companyId === "string" ? b.companyId : company;
      if (claimed !== company) throw new HttpError(403, "wrong_organization", "This token belongs to another organization.");
      if (path === "/control/v1/probe") {
        const { sel, candidates } = hub.probe(company, { workerId: typeof b.workerId === "string" ? b.workerId : null, requirements: requirements(b.requirements), needsInference: b.needsInference === true });
        return sendJson(res, 200, { ok: sel.ok, candidates, summary: sel.ok ? `Ready: ${sel.worker.name} (${sel.considered} considered).` : `No worker is ready (${sel.code}).` });
      }
      if (path === "/control/v1/leases") {
        const l = await hub.acquire(company, {
          agentId: String(b.agentId ?? ""), runId: String(b.runId ?? ""), environmentId: String(b.environmentId ?? ""),
          workerId: typeof b.workerId === "string" && b.workerId ? b.workerId : null, requirements: requirements(b.requirements), needsInference: b.needsInference === true,
          workspaceKey: typeof b.workspaceKey === "string" ? b.workspaceKey : undefined, reuse: b.reuse === true,
        });
        return sendJson(res, 201, { leaseId: l.id, workerId: l.workerId, workerName: hub.worker(l.workerId)?.name, workspace: l.workspace });
      }
      const m = /^\/control\/v1\/leases\/(wl_[0-9a-f]{16})\/(resume|workspace|exec|release|stop|destroy)$/.exec(path);
      if (!m) throw new HttpError(404, "not_found", "Not found");
      const [, id, action] = m as unknown as [string, string, string];
      switch (action) {
        case "resume": {
          const l = await hub.resume(company, id);
          return sendJson(res, 200, { leaseId: l.id, workspace: l.workspace, workerId: l.workerId });
        }
        case "workspace":
          return sendJson(res, 200, { cwd: await hub.realize(company, id, { mode: b.mode === "worktree" ? "worktree" : "directory", repo: typeof b.repo === "string" ? b.repo : undefined, ref: typeof b.ref === "string" ? b.ref : undefined }) });
        case "release":
          return sendJson(res, 200, { state: (await hub.release(company, id)).state });
        case "stop":
          return sendJson(res, 200, { state: (await hub.stop(company, id)).state });
        case "destroy":
          return sendJson(res, 200, { state: (await hub.destroy(company, id)).state });
        case "exec": {
          hub.lease(company, id);
          res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
          let execId: string | null = null;
          // The provider hanging up means nobody wants the result: stop the command.
          res.on("close", () => { if (!res.writableEnded && execId) void hub.stop(company, id).catch(() => {}); });
          const env: Record<string, string> = {};
          if (b.env && typeof b.env === "object") for (const [k, v] of Object.entries(b.env as Record<string, unknown>)) if (typeof v === "string") env[k] = v;
          try {
            const r = await hub.exec(company, id, { command: String(b.command ?? ""), args: strs(b.args), cwd: typeof b.cwd === "string" ? b.cwd : undefined, env, stdin: typeof b.stdin === "string" ? b.stdin : undefined, timeoutMs: typeof b.timeoutMs === "number" ? b.timeoutMs : undefined },
              (stream, data) => { if (!res.writableEnded) res.write(`${JSON.stringify({ ev: "out", stream, data })}\n`); }, (x) => { execId = x; });
            res.end(`${JSON.stringify({ ev: "exit", ...r })}\n`);
          } catch (e) {
            const err = e instanceof HttpError ? { code: e.code, error: e.message } : { code: "internal", error: "exec failed" };
            res.end(`${JSON.stringify({ ev: "error", ...err })}\n`);
          }
          return;
        }
      }
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
      return sendJson(res, 500, { error: "Internal error", code: "internal" });
    }
  };
}

export function controlListener(hub: FabricHub): Server {
  const s = createServer(controlHandler(hub));
  s.headersTimeout = 10_000;
  s.requestTimeout = 0;
  return s;
}
