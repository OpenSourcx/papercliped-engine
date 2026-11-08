import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { fakePve } from "./fakes.ts";

const servers: Server[] = [];
async function listen(server: Server) { servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });

describe("native chat provider ingress", () => {
  it("preserves signed bytes and forwards only provider headers without an engine session", async () => {
    const received: { path: string; body: string; headers: Record<string, unknown> }[] = [];
    const upstream = await listen(createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push({ path: req.url!, body: Buffer.concat(chunks).toString(), headers: req.headers });
      res.writeHead(req.headers["x-slack-signature"] === "test-signature" ? 200 : 401, { "Content-Type": "application/json" });
      res.end('{"challenge":"verified-by-engine"}');
    }));
    const app = createApp({ pve: { baseUrl: "https://pve.test:8006", node: "pve", transport: fakePve().transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false, engine: { url: upstream } });
    const base = await listen(createServer(app));
    const path = `/api/chat-webhooks/${"a".repeat(32)}/slack`;
    const bytes = '{ "type": "url_verification", "challenge": "one" }\n';
    const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Slack-Signature": "test-signature", "X-Slack-Request-Timestamp": "123", Cookie: "private-cookie=never-forward", Authorization: "Bearer never-forward", "X-Paperclip-Cloud-Identity": "never-forward" }, body: bytes });
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ path, body: bytes, headers: { "x-slack-signature": "test-signature", "x-slack-request-timestamp": "123" } });
    expect(received[0].headers.cookie).toBeUndefined();
    expect(received[0].headers.authorization).toBeUndefined();
    expect(received[0].headers["x-paperclip-cloud-identity"]).toBeUndefined();
    expect((await fetch(base + path, { method: "POST", body: bytes })).status).toBe(401);
    expect((await fetch(base + "/api/native-apps/complete", { method: "POST", body: bytes })).status).toBe(403);
    expect((await fetch(base + `/api/chat-webhooks/${"a".repeat(32)}/unknown`, { method: "POST", body: bytes })).status).toBe(403);
    expect(received).toHaveLength(2);
    expect((await fetch(base + path, { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect(received).toHaveLength(2);
  });
});
