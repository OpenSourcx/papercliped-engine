import { describe, expect, it } from "vitest";
import { signInFailureHelp } from "../src/data/engine/signInHelp.ts";
import { agentStatusOf } from "../src/data/engine/labels.tsx";
import { setupState } from "../src/data/engine/lifecycle.ts";
import { evaluateAgentReadiness } from "../src/data/engine/readiness.ts";

describe("sign-in failure help", () => {
  it("always says what to do, whatever the server said", () => {
    for (const m of ["Internal server error", "", "Quota exceeded for container count", "Something odd", "Forbidden", "Failed to fetch"]) expect(signInFailureHelp(m).length).toBeGreaterThan(20);
  });
  it("points a bare server error and a quota message at the resource group", () => {
    expect(signInFailureHelp("Internal server error")).toMatch(/resource group/);
    expect(signInFailureHelp("The organization has reached its container limit")).toMatch(/no room/);
  });
});

describe("agents being set up", () => {
  const ok = { state: "ok" as const, detail: "fine" };
  it("reads verifying as setting up, not as a person's pause", () => {
    expect(setupState({ lifecycleState: "verifying" })).toBe("verifying");
    expect(setupState({ lifecycleState: "ready" })).toBeNull();
    expect(agentStatusOf("paused", "verifying")[1]).toBe("Verifying");
    expect(agentStatusOf("paused", "paused")[1]).toBe("Paused");
  });
  it("names what the agent is waiting on instead of saying it is paused", () => {
    const r = evaluateAgentReadiness({ agent: { status: "paused", adapterType: "claude_local", lifecycleState: "verifying" }, adapter: ok, model: { state: "blocked", detail: "No model account or API key is visible for this agent." }, environment: ok });
    expect(r.state).toBe("blocked");
    expect(r.summary).toMatch(/being verified/);
    expect(r.summary).toMatch(/No model account/);
    expect(r.summary).not.toMatch(/resumed/);
    expect(r.settingUp).toBe(true);
  });
  it("uses the host service's own agent_setup_pending text when it sends one", () => {
    const r = evaluateAgentReadiness({ agent: { status: "paused", adapterType: "claude_local", lifecycleState: "verifying", readiness: { ready: false, issues: [{ code: "agent_setup_pending", detail: "The engine is still verifying this agent." }] } }, adapter: ok, model: ok, environment: ok });
    expect(r.summary).toMatch(/^Still setting up\. The engine is still verifying/);
  });
});
