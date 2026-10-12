import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_PATHS, EngineError, createEngineClient, engineEventsUrl } from "../src/index.ts";

const spec = JSON.parse(readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8")) as { paths: Record<string, Record<string, unknown>> };

describe("the engine client", () => {
  it("only calls paths the pinned engine actually has", () => {
    for (const [name, path] of Object.entries(ENGINE_PATHS)) expect(spec.paths[path], `${name}: ${path}`).toBeDefined();
  });

  it("goes through the host service with the request header on writes and encodes ids", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const c = createEngineClient({ fetch: async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ id: "x" }), { status: 200 }); } });
    await c.companies.list();
    await c.issues.create("co/1", { title: "Do it" });
    await c.issues.list("co1", { status: "todo", q: undefined });
    expect(seen[0].url).toBe("/engine/api/companies");
    expect((seen[0].init?.headers as Record<string, string>)["X-EPC-Request"]).toBeUndefined();
    expect(seen[1].url).toBe("/engine/api/companies/co%2F1/issues");
    expect((seen[1].init?.headers as Record<string, string>)["X-EPC-Request"]).toBe("1");
    expect(seen[2].url).toBe("/engine/api/companies/co1/issues?status=todo");
  });

  it("turns engine errors into EngineError with the engine's message", async () => {
    const c = createEngineClient({ fetch: async () => new Response(JSON.stringify({ error: "Board access required", code: "forbidden" }), { status: 403 }) });
    const e = await c.companies.list().catch((x) => x);
    expect(e).toBeInstanceOf(EngineError);
    expect(e).toMatchObject({ status: 403, message: "Board access required", code: "forbidden" });
  });

  it("builds the events socket address on the same origin", () => {
    expect(engineEventsUrl("abc", "https://pve.lan")).toBe("wss://pve.lan/engine/api/companies/abc/events/ws");
  });
});
