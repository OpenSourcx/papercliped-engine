import { describe, expect, it } from "vitest";
import { evaluateAgentReadiness, type ReadinessAgent, type ReadinessEnvironment } from "../src/agent-readiness.ts";

const sandbox: ReadinessEnvironment = { id: "env-1", companyId: "co-1", driver: "sandbox", status: "active" };

function agent(patch: Partial<ReadinessAgent> = {}): ReadinessAgent {
  return { id: "a1", companyId: "co-1", name: "Ada", status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, defaultEnvironmentId: "env-1", ...patch };
}

describe("agent readiness", () => {
  it("is not ready while the engine is still verifying the agent, and says why instead of calling it paused", () => {
    const env = { adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "s1" } } } };
    const r = evaluateAgentReadiness(agent({ ...env, status: "paused", lifecycleState: "verifying" }), { environment: sandbox, secrets: new Set(["s1"]) });
    expect(r).toMatchObject({ ready: false, configured: true });
    expect(r.issues.map((i) => i.code)).toEqual(["agent_setup_pending"]);
    // Once the engine says ready, the same agent is ready.
    expect(evaluateAgentReadiness(agent({ ...env, lifecycleState: "ready" }), { environment: sandbox, secrets: new Set(["s1"]) }).ready).toBe(true);
    // A pause somebody chose is still a pause.
    expect(evaluateAgentReadiness(agent({ ...env, status: "paused", lifecycleState: "paused" }), { environment: sandbox, secrets: new Set(["s1"]) }).issues.map((i) => i.code)).toEqual(["agent_paused"]);
  });

  it("is not ready without an adapter", () => {
    const r = evaluateAgentReadiness(agent({ adapterType: null }));
    expect(r.ready).toBe(false);
    expect(r.adapter.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("no_adapter");
  });

  it("is ready only with an adapter, a credential reference and an active sandbox default", () => {
    const r = evaluateAgentReadiness(agent({ adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "s1" } } } }), { environment: sandbox, secrets: new Set(["s1"]) });
    expect(r).toMatchObject({ ready: true, configured: true, credential: { ok: true, source: "agent_environment", detail: "ANTHROPIC_API_KEY" }, environment: { ok: true, driver: "sandbox" } });
    expect(r.issues).toEqual([]);
  });

  it("accepts a managed AI connection as the credential reference", () => {
    const r = evaluateAgentReadiness(agent({ runtimeConfig: { aiConnection: { mode: "responsible_user", provider: "anthropic", method: "subscription" } } }), { environment: sandbox });
    expect(r.ready).toBe(true);
    expect(r.credential.source).toBe("ai_connection");
  });

  it("accepts the engine's organization credential signal as present", () => {
    const r = evaluateAgentReadiness(agent(), { environment: sandbox, authSignal: "present" });
    expect(r.ready).toBe(true);
    expect(r.credential.source).toBe("organization_credential");
  });

  it("never treats an unknown credential signal as ready", () => {
    const r = evaluateAgentReadiness(agent(), { environment: sandbox, authSignal: "unknown" });
    expect(r.ready).toBe(false);
    expect(r.configured).toBe(false);
    expect(r.credential.source).toBe("unknown");
    expect(r.issues.map((i) => i.code)).toContain("credential_unknown");
  });

  it("does not count a secret reference whose secret no longer exists", () => {
    const r = evaluateAgentReadiness(agent({ adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "gone" } } } }), { environment: sandbox, secrets: new Set(["s1"]) });
    expect(r.ready).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("credential_missing");
  });

  it("requires a default environment that is an active sandbox", () => {
    const none = evaluateAgentReadiness(agent({ defaultEnvironmentId: null }), { environment: null });
    expect(none.ready).toBe(false);
    expect(none.issues.map((i) => i.code)).toContain("no_environment");

    const local = evaluateAgentReadiness(agent(), { environment: { ...sandbox, driver: "local" } });
    expect(local.ready).toBe(false);
    expect(local.issues.map((i) => i.code)).toContain("environment_not_sandbox");

    const stopped = evaluateAgentReadiness(agent(), { environment: { ...sandbox, status: "error" } });
    expect(stopped.ready).toBe(false);
    expect(stopped.issues.map((i) => i.code)).toContain("environment_inactive");

    const missing = evaluateAgentReadiness(agent(), { environment: null });
    expect(missing.ready).toBe(false);
    expect(missing.issues.map((i) => i.code)).toContain("environment_missing");
  });

  it("refuses an adapter the engine says cannot run in a sandbox", () => {
    const r = evaluateAgentReadiness(agent({ adapterType: "http", adapterConfig: {} }), { environment: sandbox, authSignal: "present", sandboxSupported: false });
    expect(r.ready).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("adapter_not_sandbox");
  });

  it("separates configuration from lifecycle: paused is configured but not ready", () => {
    const r = evaluateAgentReadiness(agent({ status: "paused", adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "plain", value: "sk-test" } } } }), { environment: sandbox });
    expect(r.configured).toBe(true);
    expect(r.ready).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("agent_paused");
  });

  it("stamps the check time so the console can show how fresh it is", () => {
    const r = evaluateAgentReadiness(agent(), { environment: sandbox, authSignal: "present", now: 1_700_000_000_000 });
    expect(r.checkedAt).toBe("2023-11-14T22:13:20.000Z");
  });
});
