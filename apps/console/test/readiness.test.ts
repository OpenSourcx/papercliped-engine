import { describe, expect, it } from "vitest";
import type { Agent } from "@papercliped-engine/engine-client";
import { evaluateAgentReadiness } from "../src/data/engine/readiness.ts";

const agent = (status: Agent["status"] = "active", extra: Record<string, unknown> = {}) => ({ status, adapterType: "claude_local", ...extra });
const ok = { state: "ok" as const, detail: "ready" };
const no = (detail: string) => ({ state: "blocked" as const, detail });
const unknown = (detail: string) => ({ state: "unknown" as const, detail });

describe("agent readiness", () => {
  it("is ready only when all three real checks pass", () => {
    const r = evaluateAgentReadiness({ agent: agent(), adapter: ok, model: ok, environment: ok });
    expect(r.state).toBe("ready");
    expect(r.source).toBe("derived");
    expect(r.checks.map((c) => c.id)).toEqual(["adapter", "model", "environment"]);
  });

  it("never says ready when a check is missing", () => {
    const r = evaluateAgentReadiness({ agent: agent(), adapter: ok, model: ok, environment: unknown("the containers are still loading.") });
    expect(r.state).toBe("unknown");
    expect(r.summary).toContain("still loading");
  });

  it("shows the first blocking reason, not a canned 'ready'", () => {
    const r = evaluateAgentReadiness({ agent: agent(), adapter: no("Claude Code isn't installed."), model: ok, environment: ok });
    expect(r.state).toBe("blocked");
    expect(r.summary).toBe("Claude Code isn't installed.");
  });

  it("respects a stopped lifecycle even when every signal passes", () => {
    const r = evaluateAgentReadiness({ agent: agent("paused"), adapter: ok, model: ok, environment: ok });
    expect(r.state).toBe("blocked");
    expect(r.summary).toMatch(/paused/i);
  });

  it("uses the engine's own readiness when it is present", () => {
    const ready = evaluateAgentReadiness({ agent: agent("active", { readiness: { ready: true } }), adapter: ok, model: ok, environment: ok });
    expect(ready.source).toBe("backend");
    expect(ready.state).toBe("ready");
    const notReady = evaluateAgentReadiness({ agent: agent("active", { readiness: { ready: false, reasons: ["The provider key was rejected."] } }), adapter: ok, model: ok, environment: ok });
    expect(notReady.state).toBe("blocked");
    expect(notReady.summary).toBe("The provider key was rejected.");
  });

  it("does not let a backend 'ready' hide a derived blocker", () => {
    const r = evaluateAgentReadiness({ agent: agent("active", { readiness: { ready: true } }), adapter: ok, model: no("No model account or API key is connected."), environment: ok });
    expect(r.state).toBe("blocked");
    expect(r.summary).toContain("No model");
  });

  it("ignores a readiness field it cannot understand instead of guessing", () => {
    const r = evaluateAgentReadiness({ agent: agent("active", { readiness: { maybe: true } }), adapter: ok, model: ok, environment: ok });
    expect(r.source).toBe("derived");
    expect(r.state).toBe("ready");
  });

  it("shows the engine's error reason for an errored agent", () => {
    const r = evaluateAgentReadiness({ agent: agent("error", { errorReason: "The model refused the request." }), adapter: ok, model: ok, environment: ok });
    expect(r.state).toBe("blocked");
    expect(r.summary).toBe("The model refused the request.");
  });
});
