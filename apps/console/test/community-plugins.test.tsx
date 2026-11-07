// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { CommunityPlugins } from "../src/pages/access/CommunityPlugins.tsx";
import { connectApi, type PluginList } from "../src/data/engine/connectApi.ts";

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
const list = (o: Partial<PluginList> = {}): PluginList => ({ plugins: [], available: [], updates: [], catalog: { trusted: true, problem: null }, engine: { ok: true }, note: "Permissions are what the publisher declares.", ...o });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Community plugins", () => {
  it("shows permissions before install and enables Install only after they are accepted, sending exactly those permissions", async () => {
    vi.spyOn(connectApi, "plugins").mockResolvedValue(list({ available: [{ id: "acme", name: "Acme Tools", vendor: "Acme", summary: "Adds tools", version: "1.0.0", permissions: ["net.acme.test", "secrets.read"], packageName: "@acme/x" }] }));
    const install = vi.spyOn(connectApi, "installPlugin").mockResolvedValue({ installed: true });
    wrap(<CommunityPlugins />);
    fireEvent.click(await screen.findByRole("button", { name: "Review and install" }));
    expect(screen.getByText("net.acme.test")).toBeTruthy();
    expect(screen.getByText("secrets.read")).toBeTruthy();
    const go = screen.getByRole("button", { name: "Install" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: /reviewed these permissions/ }));
    await waitFor(() => expect(go.disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() => expect(install).toHaveBeenCalledWith("acme", ["net.acme.test", "secrets.read"]));
  });
  it("explains an untrusted catalog, marks plugins not from the catalog, and revokes only after confirming", async () => {
    vi.spyOn(connectApi, "plugins").mockResolvedValue(list({ catalog: { trusted: false, problem: null }, plugins: [{ id: "pl1", key: "legacy", status: "ready", packageName: "legacy-thing", version: "0.1.0", verified: false, catalogId: null, grantedPermissions: null }] }));
    const revoke = vi.spyOn(connectApi, "revokePlugin").mockResolvedValue({ ok: true });
    wrap(<CommunityPlugins />);
    expect(await screen.findByText(/No trusted catalog on this device/)).toBeTruthy();
    expect(screen.getByText(/Not from the signed catalog/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke and remove" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("pl1"));
  });
  it("flags an upgrade that asks for new permissions", async () => {
    vi.spyOn(connectApi, "plugins").mockResolvedValue(list({ plugins: [{ id: "pl2", key: "acme", status: "ready", packageName: "@acme/x", version: "1.0.0", verified: true, catalogId: "acme", grantedPermissions: ["net.acme.test"] }], updates: [{ id: "acme", from: "1.0.0", to: "2.0.0", permissions: ["net.acme.test", "fs.write"], needsConsent: true }] }));
    wrap(<CommunityPlugins />);
    expect(await screen.findByRole("button", { name: /Review upgrade to 2.0.0 \(new permissions\)/ })).toBeTruthy();
  });
});
