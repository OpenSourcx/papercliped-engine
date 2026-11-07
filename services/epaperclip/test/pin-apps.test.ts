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
});
