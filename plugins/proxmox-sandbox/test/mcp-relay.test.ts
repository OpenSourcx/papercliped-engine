import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_ROUTES, matchRoute, startMcpRelay, type McpRelay } from "../src/mcp-relay.js";

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
let engine: http.Server;
let seen: Seen[];
let relay: McpRelay;
let base: string;

beforeEach(async () => {
  seen = [];
  engine = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.headers.authorization !== "Bearer run-token") { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"unauthorized"}'); }
      if (req.url === "/mcp/runtime-tools" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "a=b" });
        res.write("data: one\n\n");
        return void setTimeout(() => res.end("data: two\n\n"), 30);
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1", "set-cookie": "a=b", "x-secret": "no" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "list_projects" }] } }));
    });
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
  relay = await startMcpRelay({ target: `http://127.0.0.1:${(engine.address() as AddressInfo).port}` });
  base = `http://127.0.0.1:${relay.port}`;
});
afterEach(async () => { await relay.close(); await new Promise<void>((r) => engine.close(() => r())); });

const call = (path: string, init: RequestInit = {}) => fetch(base + path, init);
const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("the MCP relay", () => {
  it("forwards tools/list on both Paperclip MCP servers with the caller's own bearer", async () => {
    for (const path of ["/mcp/runtime-tools", "/api/mcp/project-tools"]) {
      const r = await call(path, { method: "POST", headers: { authorization: "Bearer run-token", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(rpc) });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { result: { tools: { name: string }[] } }).result.tools[0]!.name).toBe("list_projects");
      expect(r.headers.get("mcp-session-id")).toBe("s1");
    }
    expect(seen.map((s) => s.url)).toEqual(["/mcp/runtime-tools", "/api/mcp/project-tools"]);
    expect(seen[0]!.body).toBe(JSON.stringify(rpc));
  });

  it("adds no credential and does not change a bad one: the engine's 401 comes straight back", async () => {
    const none = await call("/mcp/runtime-tools", { method: "POST", body: "{}" });
    expect(none.status).toBe(401);
    const wrong = await call("/api/mcp/project-tools", { method: "POST", headers: { authorization: "Bearer other" }, body: "{}" });
    expect(wrong.status).toBe(401);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[1]!.headers.authorization).toBe("Bearer other");
  });

  it("refuses every other route, method and path trick, without reaching the engine", async () => {
    const tries: [string, string][] = [
      ["GET", "/api/companies"], ["POST", "/api/companies"], ["GET", "/api/health"], ["GET", "/api/openapi.json"], ["POST", "/runtime-tools/github/credentials"],
      ["GET", "/api/mcp/project-tools"], ["DELETE", "/mcp/runtime-tools"], ["PUT", "/mcp/runtime-tools"],
      ["POST", "/mcp/runtime-tools/extra"], ["POST", "/mcp/runtime-tools/../../api/companies"], ["POST", "/mcp/%72untime-tools"],
      ["POST", "//mcp/runtime-tools"], ["POST", "/api/mcp/project-tools/.."], ["POST", "/mcp/runtime-tools%2f.."],
    ];
    for (const [method, path] of tries) {
      const r = await call(path, { method, headers: { authorization: "Bearer run-token" }, body: method === "POST" || method === "PUT" ? "{}" : undefined });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it("drops cookies and unlisted headers both ways, and sends the engine's own host", async () => {
    const r = await call("/mcp/runtime-tools", { method: "POST", headers: { authorization: "Bearer run-token", cookie: "session=1", "x-forwarded-for": "9.9.9.9", "x-paperclip-bridge-token": "t", "mcp-protocol-version": "2025-06-18" }, body: "{}" });
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-secret")).toBeNull();
    const h = seen[0]!.headers;
    expect(h.cookie).toBeUndefined(); expect(h["x-forwarded-for"]).toBeUndefined(); expect(h["x-paperclip-bridge-token"]).toBeUndefined();
    expect(h["mcp-protocol-version"]).toBe("2025-06-18");
    expect(h.host).toBe(`127.0.0.1:${(engine.address() as AddressInfo).port}`);
  });

  it("drops the query string, so nothing rides along to the engine", async () => {
    await call("/mcp/runtime-tools?token=abc&x=1", { method: "POST", headers: { authorization: "Bearer run-token" }, body: "{}" });
    expect(seen[0]!.url).toBe("/mcp/runtime-tools");
  });

  it("streams an event-stream answer instead of buffering it", async () => {
    const r = await call("/mcp/runtime-tools", { headers: { authorization: "Bearer run-token", accept: "text/event-stream" } });
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const reader = r.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("data: one");
    let rest = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    expect(rest).toContain("data: two");
  });

  it("refuses a body over the limit", async () => {
    const r = await call("/mcp/runtime-tools", { method: "POST", headers: { authorization: "Bearer run-token", "content-length": String(9 * 1024 * 1024) }, body: "x" }).catch(() => null);
    expect(r === null || r.status === 413).toBe(true);
    expect(seen).toEqual([]);
  });

  it("answers 502 when the engine is down", async () => {
    await new Promise<void>((r) => engine.close(() => r()));
    const r = await call("/mcp/runtime-tools", { method: "POST", headers: { authorization: "Bearer run-token" }, body: "{}" });
    expect(r.status).toBe(502);
    engine = http.createServer(); await new Promise<void>((r2) => engine.listen(0, "127.0.0.1", () => r2()));
  });

  it("listens on host loopback only, and only ever forwards to loopback", async () => {
    expect(relay.port).toBeGreaterThan(0);
    await expect(startMcpRelay({ target: "http://10.0.0.5:3100" })).rejects.toThrow(/loopback/);
    await expect(startMcpRelay({ target: "https://127.0.0.1:3100" })).rejects.toThrow(/loopback/);
    expect(MCP_ROUTES).toHaveLength(3);
  });

  it("matchRoute is exact", () => {
    expect(matchRoute("POST", "/mcp/runtime-tools")).not.toBeNull();
    expect(matchRoute("POST", "/mcp/runtime-tools/")).not.toBeNull();
    expect(matchRoute("post", "/api/mcp/project-tools?x=1")).not.toBeNull();
    expect(matchRoute("GET", "/api/mcp/project-tools")).toBeNull();
    expect(matchRoute(undefined, "/mcp/runtime-tools")).toBeNull();
  });
});
