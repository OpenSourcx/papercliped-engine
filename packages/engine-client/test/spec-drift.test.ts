import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_PATHS, ENGINE_PATHS_UNDOCUMENTED } from "../src/index.ts";

const rd = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const spec = JSON.parse(rd("../spec/openapi.json")) as { paths: Record<string, Record<string, unknown>> };
const src = rd("../src/index.ts");
const pin = JSON.parse(rd("../../../engine/package.json")).dependencies.paperclipai as string;

describe("the engine client against the engine it is pinned to", () => {
  it("is one version everywhere: engine pin, spec snapshot, shared types, plugin SDK, engine lockfile", () => {
    expect(rd("../spec/ENGINE_VERSION").trim(), "spec/ENGINE_VERSION: run scripts/refresh-engine-spec.mjs (docs/UPGRADING.md)").toBe(pin);
    expect(JSON.parse(rd("../package.json")).dependencies["@paperclipai/shared"]).toBe(pin);
    expect(JSON.parse(rd("../../../plugins/proxmox-sandbox/package.json")).dependencies["@paperclipai/plugin-sdk"]).toBe(pin);
    expect(JSON.parse(rd("../../../engine/package-lock.json")).packages["node_modules/paperclipai"].version).toBe(pin);
  });

  it("calls every route with a method the engine documents for it", () => {
    const named = { ...ENGINE_PATHS, ...ENGINE_PATHS_UNDOCUMENTED } as Record<string, string>;
    const uses = [...src.matchAll(/"(GET|POST|PUT|PATCH|DELETE)",\s*(?:P|ENGINE_PATHS_UNDOCUMENTED)\.(\w+)/g)].map((m) => ({ method: m[1].toLowerCase(), name: m[2] }));
    expect(uses.length).toBeGreaterThan(100);
    const wrong: string[] = [];
    for (const { method, name } of uses) {
      const path = named[name];
      if (!path) wrong.push(`${name}: not in the path tables`);
      else if (path in ENGINE_PATHS_UNDOCUMENTED || name in ENGINE_PATHS_UNDOCUMENTED) continue; // not in the spec by design
      else if (!spec.paths[path]?.[method]) wrong.push(`${method.toUpperCase()} ${path} (${name}) is not in the engine's OpenAPI document`);
    }
    expect(wrong).toEqual([]);
  });

  it("wakes an agent on the modern route, which the engine documents, not the legacy heartbeat/invoke", () => {
    expect(ENGINE_PATHS.agentWakeup).toBe("/api/agents/{id}/wakeup");
    expect(spec.paths["/api/agents/{id}/wakeup"]?.post).toBeDefined();
  });

  it("does not leave a path in the table that nothing calls (the table is the used set, not a copy of the spec)", () => {
    const used = new Set([...src.matchAll(/\b(?:P|ENGINE_PATHS)\.(\w+)/g)].map((m) => m[1]));
    const unused = Object.keys(ENGINE_PATHS).filter((k) => !used.has(k));
    expect(unused).toEqual([]);
  });
});
