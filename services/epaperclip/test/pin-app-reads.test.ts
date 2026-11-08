import { describe, expect, it, vi } from "vitest";
import { runTool, type PinToolHost } from "../src/pin.ts";

describe("Pin organization apps", () => {
  it("uses the caller's engine routes and strips credential references and provider data", async () => {
    const engine = vi.fn(async (path: string) => path.endsWith("chat-endpoints") ? [{ id: "channel", provider: "discord", assignedAgentId: "agent", status: "active", setup: { secret: "hidden" } }] : { connections: [{ id: "app", name: "GitHub", enabled: true, connectionPurpose: "tools", healthStatus: "healthy", credentialSecretRefs: ["private-ref"], transportConfig: { secret: "hidden" } }] });
    const result = await runTool("list_organization_apps", { companyId: "co-a" }, { engine } as unknown as PinToolHost);
    expect(engine.mock.calls.map(([path]) => path)).toEqual(["/api/companies/co-a/tools/connections", "/api/companies/co-a/chat-endpoints"]);
    expect(JSON.stringify(result)).not.toMatch(/hidden|private-ref|transportConfig|credentialSecretRefs/);
    expect(result).toMatchObject({ connections: [{ id: "app", health: "healthy" }], channels: [{ assignedAgentId: "agent" }] });
  });
  it("does not turn an invalid company ID into an engine path", async () => {
    const engine = vi.fn();
    await expect(runTool("list_organization_apps", { companyId: "../other" }, { engine } as unknown as PinToolHost)).rejects.toMatchObject({ code: "bad_args" });
    expect(engine).not.toHaveBeenCalled();
  });
  it("lists held app actions in the engine's real shape without their inputs, never offers a way to decide them, and says where a person decides", async () => {
    const engine = vi.fn(async () => ({ actionRequests: [{ request: { id: "r1", status: "pending", createdAt: "2026-11-07T00:00:00Z", expiresAt: "2026-11-07T01:00:00Z", signedArguments: "eyJ-secret-blob", canonicalArgumentsSummary: { summary: "private text" }, previewMarkdown: "private text" }, toolName: "mcp.app:write-note", toolTitle: "Write note", connectionName: "Notes", riskLevel: "write" }] }));
    const result = await runTool("list_app_action_requests", { companyId: "co-a" }, { engine } as unknown as PinToolHost);
    expect(engine).toHaveBeenCalledWith("/api/companies/co-a/tools/action-requests?status=pending");
    expect(JSON.stringify(result)).not.toMatch(/private text|secret-blob|signedArguments|previewMarkdown/);
    expect(result).toMatchObject({ requests: [{ id: "r1", tool: "Write note", connection: "Notes", risk: "write", status: "pending" }], approveIn: expect.stringContaining("Held app actions") });
    await expect(runTool("list_app_action_requests", { companyId: "../x" }, { engine } as unknown as PinToolHost)).rejects.toMatchObject({ code: "bad_args" });
    const { TOOLS: PIN_TOOLS } = await import("../src/pin.ts");
    expect(PIN_TOOLS.filter((t) => /approve|decline|decide/.test(t.name))).toEqual([]);
  });
});
