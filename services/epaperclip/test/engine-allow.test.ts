import { describe, expect, it } from "vitest";
import { ENGINE_PATHS, ENGINE_PATHS_UNDOCUMENTED } from "../../../packages/engine-client/src/index.ts";
import { ENGINE_ALLOWED, compileAllow, engineAllowed } from "../src/engine-allow.ts";
import { enginePath } from "../src/engine.ts";

describe("the /engine/api allow-list", () => {
  it("covers exactly the routes the console's engine client calls", () => {
    const client = [...Object.values(ENGINE_PATHS), ...Object.values(ENGINE_PATHS_UNDOCUMENTED)].sort();
    expect([...ENGINE_ALLOWED].sort()).toEqual(client);
  });

  it("lets listed routes through, with ids, query strings, trailing slashes and any letter case", () => {
    expect(enginePath("/engine/api/companies")).toBe("/api/companies");
    expect(enginePath("/engine/api/companies/c1/issues?status=open")).toBe("/api/companies/c1/issues?status=open");
    expect(enginePath("/engine/api/Companies/c1/Issues/")).toBe("/api/Companies/c1/Issues/");
    expect(enginePath("/engine/api/cli-auth/me")).toBe("/api/cli-auth/me");
    expect(enginePath("/engine/api/agents/a%2D1/pause")).toBe("/api/agents/a%2D1/pause");
  });

  it("closes everything else, including engine areas that were never listed", () => {
    for (const p of [
      "/engine/api/echo",
      "/engine/api/routine-triggers/public/abc/fire", // the unauthenticated webhook ingress is separate, never through a session
      "/engine/api/instance/settings",
      "/engine/api/instance/users",
      "/engine/api/companies/c1/invites",
      "/engine/api/invites/tok/accept",
      "/engine/api/companies/c1/members/m1/archive",
      "/engine/api/auth/sign-in/email",
      "/engine/api/bootstrap/claim",
      "/engine/api/cli-auth/challenges",
      "/engine/api/companies/c1/issues/i1/extra/deep",
      "/engine/api/companies//issues",
      "/engine/api/agents/a1/keys",
      "/engine/api/openapi.json",
    ]) {
      expect(() => enginePath(p), p).toThrow();
    }
  });

  it("only extra routes given explicitly open more (test engines)", () => {
    expect(() => enginePath("/engine/api/echo")).toThrow();
    expect(enginePath("/engine/api/echo", [/^\/api\/echo$/])).toBe("/api/echo");
    expect(engineAllowed("/api/x", compileAllow(["/api/x/{id}"]))).toBe(false);
    expect(engineAllowed("/api/x/1", compileAllow(["/api/x/{id}"]))).toBe(true);
  });
});
