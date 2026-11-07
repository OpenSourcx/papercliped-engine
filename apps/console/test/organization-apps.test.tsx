// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AppSetup, ChannelSetup, ToolReview } from "../src/pages/org/live/OrganizationAppSetup.tsx";
import { engine } from "../src/data/engine/queries.ts";
import type { PickedApp } from "../src/pages/org/live/LiveOrganizationApps.tsx";

vi.mock("../src/data/engine/queries.ts", async (original) => ({
  ...await original<typeof import("../src/data/engine/queries.ts")>(),
  useAgents: () => ({ data: [{ id: "a1", name: "Ada", status: "idle" }], error: null }),
}));
const picked = (provider: string, method: Record<string, unknown> = {}): PickedApp => ({ app: { slug: provider, name: provider, methods: [] }, method: { key: "mcp-oauth", auth: "oauth", whenToUse: "Connect your account", guidanceMd: "Select the resources to share.", ...method } } as unknown as PickedApp);
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
beforeEach(() => { vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ callbackUrl: `${window.location.origin}/api/tools/oauth/callback` }))); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("native organization apps", () => {
  it("starts provider OAuth using the engine and offers the real provider URL", async () => {
    const connect = vi.spyOn(engine.apps, "connect").mockResolvedValue({ connectionId: "x1", auth: { kind: "oauth", startUrl: "https://provider.example/authorize" } } as never);
    wrap(<AppSetup companyId="c1" picked={picked("notion")} onClose={() => {}} onReview={() => {}} />);
    const signIn = screen.getByRole("button", { name: "Sign in with notion" });
    await waitFor(() => expect((signIn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(signIn);
    expect((await screen.findByRole("link", { name: "Continue to notion" })).getAttribute("href")).toBe("https://provider.example/authorize");
    expect(connect).toHaveBeenCalledWith("c1", expect.objectContaining({ galleryKey: "notion", connectionMethodKey: "mcp-oauth", grantKind: "organization" }));
  });
  it("does not start OAuth with a loopback callback on a remote console", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ callbackUrl: "http://127.0.0.1:3100/api/tools/oauth/callback" })));
    const connect = vi.spyOn(engine.apps, "connect");
    wrap(<AppSetup companyId="c1" picked={picked("notion")} onClose={() => {}} onReview={() => {}} />);
    expect(await screen.findByText(/does not match the console address/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sign in with notion" }) as HTMLButtonElement).disabled).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });
  it("grants only the selected agents and reviewed actions, with approval separate from allow", async () => {
    vi.spyOn(engine.apps, "catalog").mockResolvedValue({ catalog: [{ id: "read", title: "Read page", isReadOnly: true, status: "active" }, { id: "write", title: "Edit page", isWrite: true, status: "quarantined" }, { id: "delete", title: "Delete page", isDestructive: true, status: "disabled" }] } as never);
    const finish = vi.spyOn(engine.apps, "finish").mockResolvedValue({} as never);
    wrap(<ToolReview companyId="c1" connectionId="x1" onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Read page"), { target: { value: "allow" } });
    fireEvent.change(screen.getByLabelText("Edit page"), { target: { value: "ask" } });
    fireEvent.click(screen.getByRole("switch", { name: "Ada" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace access" }));
    expect((screen.getByLabelText("Delete page") as HTMLSelectElement).disabled).toBe(true);
    await waitFor(() => expect(finish).toHaveBeenCalledWith("c1", "x1", { preserveExistingAccess: false, access: { agentIds: ["a1"] }, enabledCatalogEntryIds: ["read", "write"], askFirstCatalogEntryIds: ["write"], reviewedCatalogEntryIds: ["write"] }));
  });
  it("creates a Discord endpoint for one selected agent, then saves its bot credentials through native setup", async () => {
    vi.spyOn(engine.channels, "resources").mockResolvedValue([]);
    const endpoint = { id: "ep1", provider: "discord", status: "draft", setup: {} };
    const create = vi.spyOn(engine.channels, "create").mockResolvedValue(endpoint as never);
    const configure = vi.spyOn(engine.channels, "configure").mockResolvedValue({ ...endpoint, status: "active" } as never);
    wrap(<ChannelSetup companyId="c1" picked={picked("discord", { key: "chat-agent", provider: "discord", purpose: "channel", auth: "api_key", credentialFields: [{ key: "botToken", label: "Bot token", type: "password", secret: true, required: true }] })} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "a1" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to provider setup" }));
    fireEvent.change(await screen.findByLabelText("Bot token *"), { target: { value: "test-only-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith("ep1", { action: "configure", credentials: { botToken: "test-only-token" } }));
    expect(create).toHaveBeenCalledWith("c1", { provider: "discord", assignedAgentId: "a1" });
    await waitFor(() => expect((screen.getByLabelText("Bot token *") as HTMLInputElement).value).toBe(""));
  });
});
