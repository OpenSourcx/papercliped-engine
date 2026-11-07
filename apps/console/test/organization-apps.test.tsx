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
  const grants = (profile: Record<string, unknown> = {}, policies: unknown[] = []) => { vi.spyOn(engine.apps, "profiles").mockResolvedValue({ profiles: [{ profileKey: "app:x1", defaultAction: "deny", bindings: [{ targetType: "agent", targetId: "a1" }], entries: [{ selectorType: "catalog_entry", effect: "include", catalogEntryId: "read", conditions: null }, { selectorType: "catalog_entry", effect: "include", catalogEntryId: "write", conditions: null }], ...profile }] } as never); vi.spyOn(engine.apps, "policies").mockResolvedValue({ policies } as never); };
  const catalog = () => vi.spyOn(engine.apps, "catalog").mockResolvedValue({ catalog: [{ id: "read", title: "Read page", isReadOnly: true, status: "active" }, { id: "write", title: "Edit page", isWrite: true, status: "active" }, { id: "other", title: "Other", status: "active" }] } as never);
  it("reopens with existing grants and saves them unchanged", async () => {
    grants({}, [{ enabled: true, policyType: "require_approval", config: { source: "app_gallery_finish", connectionId: "x1", catalogEntryId: "write" } }]);
    catalog();
    const finish = vi.spyOn(engine.apps, "finish").mockResolvedValue({} as never);
    wrap(<ToolReview companyId="c1" connectionId="x1" onClose={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText("Read page") as HTMLSelectElement).value).toBe("allow"));
    expect((screen.getByLabelText("Edit page") as HTMLSelectElement).value).toBe("ask");
    expect((screen.getByLabelText("Other") as HTMLSelectElement).value).toBe("off");
    expect(screen.getByRole("switch", { name: "Ada" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(finish).toHaveBeenCalledWith("c1", "x1", { preserveExistingAccess: false, access: { agentIds: ["a1"] }, enabledCatalogEntryIds: ["read", "write"], askFirstCatalogEntryIds: ["write"], reviewedCatalogEntryIds: [] }));
  });
  it("keeps all-agents access when the company binding exists", async () => {
    grants({ bindings: [{ targetType: "company", targetId: "c1" }] });
    catalog();
    const finish = vi.spyOn(engine.apps, "finish").mockResolvedValue({} as never);
    wrap(<ToolReview companyId="c1" connectionId="x1" onClose={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText("Read page") as HTMLSelectElement).value).toBe("allow"));
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(finish).toHaveBeenCalledWith("c1", "x1", expect.objectContaining({ access: "all_agents" })));
  });
  it("refuses to save over grants it cannot represent, and when grants cannot be read", async () => {
    grants({ entries: [{ selectorType: "risk_level", effect: "exclude", conditions: null }] });
    catalog();
    const finish = vi.spyOn(engine.apps, "finish").mockResolvedValue({} as never);
    wrap(<ToolReview companyId="c1" connectionId="x1" onClose={() => {}} />);
    expect(await screen.findByText(/cannot show/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save access" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    vi.spyOn(engine.apps, "profiles").mockRejectedValue(new Error("down"));
    wrap(<ToolReview companyId="c1" connectionId="x1" onClose={() => {}} />);
    await screen.findByText(/down/);
    expect((screen.getByRole("button", { name: "Save access" }) as HTMLButtonElement).disabled).toBe(true);
    expect(finish).not.toHaveBeenCalled();
  });
  it("grants only the selected agents and reviewed actions, with approval separate from allow", async () => {
    vi.spyOn(engine.apps, "profiles").mockResolvedValue({ profiles: [] } as never);
    vi.spyOn(engine.apps, "policies").mockResolvedValue({ policies: [] } as never);
    vi.spyOn(engine.apps, "catalog").mockResolvedValue({ catalog: [{ id: "read", title: "Read page", isReadOnly: true, status: "active" }, { id: "write", title: "Edit page", isWrite: true, status: "quarantined" }, { id: "delete", title: "Delete page", isDestructive: true, status: "disabled" }] } as never);
    const finish = vi.spyOn(engine.apps, "finish").mockResolvedValue({} as never);
    wrap(<ToolReview companyId="c1" connectionId="x1" onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Read page"), { target: { value: "allow" } });
    fireEvent.change(screen.getByLabelText("Edit page"), { target: { value: "ask" } });
    fireEvent.click(screen.getByRole("switch", { name: "Ada" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Save access" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
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
  it("renders every provider field type, submits defaults and typed values, and blocks invalid input", async () => {
    const connect = vi.spyOn(engine.apps, "connect").mockResolvedValue({ connectionId: "x2" } as never);
    const method = { key: "api", auth: "api_key", tenantFields: [
      { key: "region", label: "Region", type: "select", required: true, options: [{ value: "eu", label: "EU" }, { value: "us", label: "US" }], defaultValue: "eu" },
      { key: "notes", label: "Notes", type: "textarea" },
      { key: "expires", label: "Expires", type: "datetime" },
      { key: "readonly", label: "Read only", type: "checkbox", defaultValue: true },
      { key: "mode", label: "Mode", type: "text", hidden: true, defaultValue: "strict" },
      { key: "proxy", label: "Proxy", type: "text", advanced: true },
    ], credentialFields: [{ key: "token", label: "Token", type: "password", secret: true, required: true, prefix: "sk-", validation: { pattern: "^[a-z0-9]+$" } }] };
    wrap(<AppSetup companyId="c1" picked={picked("acme", method)} onClose={() => {}} onReview={() => {}} />);
    expect(screen.queryByLabelText("Proxy")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Token is required.")).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Token *"), { target: { value: "ABC" } });
    expect(await screen.findByText("Token is not in the expected format.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Token *"), { target: { value: "abc123" } });
    fireEvent.change(screen.getByLabelText("Expires"), { target: { value: "2026-11-07T15:30" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connect).toHaveBeenCalled());
    const body = connect.mock.calls[0]![1] as { credentialValues: Record<string, string>; configValues: Record<string, unknown> };
    expect(body.credentialValues).toEqual({ token: "sk-abc123" });
    expect(body.configValues).toMatchObject({ region: "eu", notes: "hello", readonly: true, mode: "strict" });
    expect(body.configValues.expires).toBe(new Date("2026-11-07T15:30").toISOString());
    expect(body.configValues).not.toHaveProperty("proxy");
  });
  it("collects a preregistered OAuth client when the provider supports no automatic registration, resuming the same draft", async () => {
    const connect = vi.spyOn(engine.apps, "connect")
      .mockResolvedValueOnce({ connectionId: "draft1", auth: { kind: "oauth", startUrl: null, manualClientRequired: true } } as never)
      .mockResolvedValueOnce({ connectionId: "draft1", auth: { kind: "oauth", startUrl: "https://provider.example/authorize" } } as never);
    wrap(<AppSetup companyId="c1" picked={picked("vercel")} onClose={() => {}} onReview={() => {}} />);
    const signIn = screen.getByRole("button", { name: "Sign in with vercel" });
    await waitFor(() => expect((signIn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(signIn);
    expect(await screen.findByText(/Register an OAuth client first/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save client and continue" }));
    expect(await screen.findByText("Client ID is required.")).toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Client ID *"), { target: { value: "client-123" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "s3cret-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save client and continue" }));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(connect.mock.calls[1]![1]).toMatchObject({ resumeConnectionId: "draft1", oauthClient: { clientId: "client-123", clientSecret: "s3cret-test" } });
    expect((await screen.findByRole("link", { name: "Continue to vercel" })).getAttribute("href")).toBe("https://provider.example/authorize");
    expect(screen.queryByDisplayValue("s3cret-test")).toBeNull();
  });
});

import { ConnectionRow, appForConnection } from "../src/pages/org/live/ConnectionRow.tsx";
describe("existing connection rows", () => {
  const apps = [{ slug: "github", name: "GitHub", methods: [] }, { slug: "notion", name: "Notion", methods: [] }] as never;
  const conn = (o: Record<string, unknown> = {}) => ({ id: "x1", name: "GitHub (acme)", enabled: true, healthStatus: "healthy", transportConfig: {}, ...o }) as never;
  it("finds the provider by recorded key, else by name, never by a loose substring", () => {
    expect(appForConnection(conn({ config: { galleryKey: "notion" } }), apps)?.slug).toBe("notion");
    expect(appForConnection(conn(), apps)?.slug).toBe("github");
    expect(appForConnection(conn({ name: "Githubber" }), apps)).toBeUndefined();
  });
  it("shows health with a label, action count, and revokes only after confirmation", async () => {
    vi.spyOn(engine.apps, "catalog").mockResolvedValue({ catalog: [{ id: "a", status: "active" }, { id: "b", status: "disabled" }] } as never);
    const remove = vi.spyOn(engine.apps, "remove").mockResolvedValue({} as never);
    const refresh = vi.fn();
    wrap(<ConnectionRow connection={conn({ requiresReauthorization: true, healthStatus: "healthy", healthMessage: "Token expired" })} apps={apps} canManage onReview={() => {}} refresh={refresh} />);
    expect(await screen.findByText("Sign in again")).toBeTruthy();
    expect(await screen.findByText(/1 action available/)).toBeTruthy();
    expect(screen.getByLabelText("GitHub")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke and disconnect" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("x1"));
  });
});

import { PinAppAccess } from "../src/pages/org/live/PinAppAccess.tsx";
import { connectApi } from "../src/data/engine/connectApi.ts";
describe("Pin's access to organization apps", () => {
  const conn = { id: "x1", name: "GitHub (acme)", transport: "mcp_remote" } as never;
  it("starts Off, enables explicitly, saves per-action choices, and revokes only after confirmation", async () => {
    const get = vi.spyOn(connectApi.pinApps, "get").mockResolvedValueOnce({ enabled: false, agentId: null, entries: [] }).mockResolvedValue({ enabled: true, agentId: "p", entries: [{ connectionId: "x1", catalogEntryId: "read", mode: "allow" }] });
    const enable = vi.spyOn(connectApi.pinApps, "enable").mockResolvedValue({ enabled: true });
    const set = vi.spyOn(connectApi.pinApps, "set").mockResolvedValue({ enabled: true, agentId: "p", entries: [] });
    const revoke = vi.spyOn(connectApi.pinApps, "revoke").mockResolvedValue({ ok: true });
    vi.spyOn(engine.apps, "catalog").mockResolvedValue({ catalog: [{ id: "read", title: "Read", isReadOnly: true, status: "active" }, { id: "write", title: "Write", status: "active" }] } as never);
    wrap(<PinAppAccess companyId="c1" connections={[conn]} canManage />);
    fireEvent.click(await screen.findByRole("button", { name: "Let Pin use apps here" }));
    await waitFor(() => expect(enable).toHaveBeenCalledWith("c1"));
    fireEvent.click(await screen.findByRole("button", { name: "Set Pin access" }));
    await waitFor(() => expect((screen.getByLabelText("Read") as HTMLSelectElement).value).toBe("allow"));
    expect((screen.getByLabelText("Write") as HTMLSelectElement).value).toBe("off");
    fireEvent.change(screen.getByLabelText("Write"), { target: { value: "ask" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("c1", "x1", [{ catalogEntryId: "read", mode: "allow" }, { catalogEntryId: "write", mode: "ask" }]));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Pin’s access" }));
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("c1"));
    expect(get).toHaveBeenCalled();
  });
});
