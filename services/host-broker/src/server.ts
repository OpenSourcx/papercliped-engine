import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ProxmoxError } from "@papercliped-engine/proxmox-client";
import { Broker, BrokerError, type GuestActionName } from "./broker.ts";
import type { Principal } from "./config.ts";

/**
 * The broker's HTTP API. Callers send `Authorization: Bearer <token>`; the broker compares the token's SHA-256 with the
 * configured principals in constant time.
 *
 *   GET    /v1/health                                  no auth
 *   GET    /v1/host                                    Pin
 *   GET    /v1/guests                                  Pin
 *   POST   /v1/guests/:vmid/actions  {action}          Pin
 *   GET    /v1/groups/:group/leases                    Pin or that group
 *   POST   /v1/groups/:group/leases  {profile, ...}    Pin or that group
 *   GET    /v1/groups/:group/leases/:id                Pin or that group
 *   DELETE /v1/groups/:group/leases/:id                Pin or that group
 */

const MAX_BODY = 16 * 1024;

export function authenticate(header: string | undefined, principals: Principal[]): Principal | null {
  const m = header?.match(/^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/);
  if (!m) return null;
  const got = createHash("sha256").update(m[1]).digest();
  let found: Principal | null = null;
  // Compare against every principal so timing does not reveal which (if any) matched.
  for (const p of principals) {
    if (timingSafeEqual(got, Buffer.from(p.tokenSha256, "hex"))) found = p;
  }
  return found;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BrokerError("Request body too large", 413, "too_large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new BrokerError("Body must be a JSON object", 400, "bad_json");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

const optStr = (v: unknown, what: string) => {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new BrokerError(`${what} must be a string`, 400, "bad_request");
  return v;
};

export async function handle(broker: Broker, principals: Principal[], req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? "/", "http://broker");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/v1/health") return send(res, 200, { ok: true });

    const who = authenticate(req.headers.authorization, principals);
    if (!who) return send(res, 401, { error: "Missing or invalid token", code: "unauthorized" });

    if (parts[0] !== "v1") throw new BrokerError("Not found", 404, "not_found");

    if (parts.length === 2 && parts[1] === "host" && method === "GET") return send(res, 200, await broker.hostStatus(who));
    if (parts.length === 2 && parts[1] === "guests" && method === "GET") return send(res, 200, { guests: await broker.listGuests(who) });
    if (parts.length === 4 && parts[1] === "guests" && parts[3] === "actions" && method === "POST") {
      const body = await readJson(req);
      const source = body.source === "automation" ? "automation" : "pin";
      return send(res, 200, await broker.guestAction(who, Number(parts[2]), String(body.action) as GuestActionName, source));
    }

    if (parts[1] === "groups" && parts[3] === "leases") {
      const group = parts[2];
      if (parts.length === 4 && method === "GET") return send(res, 200, { leases: await broker.listLeases(who, group) });
      if (parts.length === 4 && method === "POST") {
        const body = await readJson(req);
        const lease = await broker.createLease(who, group, {
          profile: optStr(body.profile, "profile") ?? "",
          sshPublicKey: optStr(body.sshPublicKey, "sshPublicKey"),
          runId: optStr(body.runId, "runId"),
          requestedExpiresAt: optStr(body.requestedExpiresAt, "requestedExpiresAt"),
        });
        return send(res, 201, lease);
      }
      if (parts.length === 5 && method === "GET") return send(res, 200, await broker.getLease(who, group, parts[4]));
      if (parts.length === 5 && method === "DELETE") return send(res, 200, await broker.destroyLease(who, group, parts[4]));
    }
    throw new BrokerError("Not found", 404, "not_found");
  } catch (error) {
    if (error instanceof BrokerError) return send(res, error.status, { error: error.message, code: error.code });
    if (error instanceof ProxmoxError) return send(res, 502, { error: error.message, code: "proxmox_error" });
    const net = (error as { code?: unknown })?.code;
    if (typeof net === "string" && /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY)/.test(net)) {
      return send(res, 502, { error: `Proxmox API unreachable (${net})`, code: "proxmox_unreachable" });
    }
    return send(res, 500, { error: "Internal error", code: "internal" });
  }
}

export function startServer(broker: Broker, principals: Principal[], listen: { host: string; port: number }): Server {
  const server = createServer((req, res) => void handle(broker, principals, req, res));
  server.listen(listen.port, listen.host);
  return server;
}
