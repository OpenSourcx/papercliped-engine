// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { RemoteAccess } from "../src/pages/access/RemoteAccess.tsx";
import { host, type ConnectStatusView } from "../src/data/engine/host.ts";

vi.mock("../src/pages/access/CloudflareAccess.tsx", () => ({ CloudflareAccess: () => <div>cloudflare section</div> }));
vi.mock("../src/data/engine/queries.ts", async (original) => ({ ...(await original<typeof import("../src/data/engine/queries.ts")>()), useConnectors: () => ({ data: { connectors: [{ id: "cloudflare", configured: true }], canManage: true }, isPending: false }) }));
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
const status = (s: Partial<ConnectStatusView> = {}): ConnectStatusView => ({ mode: "local", paired: false, ...s });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Access, Remote access", () => {
  it("shows the provider callback address and the exact fix when it does not match this console", async () => {
    vi.spyOn(host.connect, "status").mockResolvedValue(status());
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ callbackUrl: "http://127.0.0.1:3100/api/tools/oauth/callback" })));
    wrap(<RemoteAccess />);
    expect(await screen.findByText(/Does not match this console/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`--set-public-url ${window.location.origin}`))).toBeTruthy();
    vi.unstubAllGlobals();
  });
  it("offers local only, self-managed Cloudflare and Papercliped Connect, and describes tunnels accurately", async () => {
    vi.spyOn(host.connect, "status").mockResolvedValue(status());
    wrap(<RemoteAccess />);
    expect(await screen.findByRole("radio", { name: /Local only/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Self-managed Cloudflare/ }).textContent).toMatch(/does not deploy a Cloudflare Worker/);
    expect(screen.getByRole("radio", { name: /Papercliped Connect/ }).textContent).toMatch(/stay on this machine/);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Local only/ }).getAttribute("aria-checked")).toBe("true"));
  });
  it("switches between the two remote modes through local only", async () => {
    vi.spyOn(host.connect, "status").mockResolvedValue(status({ mode: "cloudflare-self" }));
    const mode = vi.spyOn(host.connect, "mode").mockImplementation(async (m) => status({ mode: m }));
    wrap(<RemoteAccess />);
    const connect = await screen.findByRole("radio", { name: /Papercliped Connect/ });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(connect);
    await waitFor(() => expect(mode.mock.calls.map((c) => c[0])).toEqual(["local", "connect"]));
  });
  it("shows the approving account and links nothing until the administrator confirms it", async () => {
    vi.spyOn(host.connect, "status").mockResolvedValue(status({ mode: "connect", pairing: { id: "p1", state: "approved", approvalUrl: "https://console.papercliped.co/devices/pair?id=p1", expiresAt: Date.now() + 60000, selectedOwner: "acc-123" } }));
    const confirm = vi.spyOn(host.connect, "pairingConfirm").mockResolvedValue(status({ mode: "connect", paired: true, device: { deviceId: "d", accountId: "acc-123", name: "ePaperclip", pairedAt: 1 } }));
    wrap(<RemoteAccess />);
    expect(await screen.findByText(/acc-123/)).toBeTruthy();
    expect(screen.getByText(/does not change any Proxmox permission/)).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm this account" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith("acc-123", "ePaperclip"));
  });
  it("refuses to render an unsafe approval address as a link", async () => {
    vi.spyOn(host.connect, "status").mockResolvedValue(status({ mode: "connect", pairing: { id: "p1", state: "pending", approvalUrl: "javascript:alert(1)", expiresAt: Date.now() + 60000 } }));
    wrap(<RemoteAccess />);
    expect(await screen.findByText(/not a safe web address/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open approval page/ })).toBeNull();
  });
});

describe("Self-managed Cloudflare", () => {
  const load = async () => (await vi.importActual<typeof import("../src/pages/access/CloudflareAccess.tsx")>("../src/pages/access/CloudflareAccess.tsx")).CloudflareAccess;
  const steps = (n: number) => (["token", "zone", "tunnel", "dns", "connector", "reachable"] as const).map((id, i) => ({ id, label: id, state: i < n ? "done" as const : "todo" as const }));
  it("creates the address from the chosen domain and says a Worker is not deployed", async () => {
    const CloudflareAccess = await load();
    vi.spyOn(host.publishing, "cloudflareZones").mockResolvedValue([{ id: "z", name: "example.com" }]);
    vi.spyOn(host.publishing, "cloudflareDeployment").mockResolvedValue({ state: "none", steps: steps(0), message: "" });
    const create = vi.spyOn(host.publishing, "cloudflareCreate").mockResolvedValue({ state: "connecting", hostname: "app.example.com", steps: steps(4), message: "Connecting" });
    wrap(<CloudflareAccess />);
    fireEvent.click(await screen.findByRole("button", { name: "Create address" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("example.com", "app", false));
    expect(await screen.findByText("app.example.com")).toBeTruthy();
    expect(screen.getByText(/does not deploy one/)).toBeTruthy();
  });
  it("asks before replacing a foreign DNS record", async () => {
    const CloudflareAccess = await load();
    vi.spyOn(host.publishing, "cloudflareZones").mockResolvedValue([{ id: "z", name: "example.com" }]);
    vi.spyOn(host.publishing, "cloudflareDeployment").mockResolvedValue({ state: "needs_confirmation", hostname: "app.example.com", steps: steps(3), message: "exists", conflict: { type: "A", content: "203.0.113.9" } });
    const create = vi.spyOn(host.publishing, "cloudflareCreate").mockResolvedValue({ state: "connecting", hostname: "app.example.com", steps: steps(5), message: "ok" });
    wrap(<CloudflareAccess />);
    fireEvent.click(await screen.findByRole("button", { name: "Replace the record" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("example.com", "app", true));
  });
  it("names missing permissions in the self-check", async () => {
    const CloudflareAccess = await load();
    vi.spyOn(host.publishing, "cloudflareZones").mockResolvedValue([{ id: "z", name: "example.com" }]);
    vi.spyOn(host.publishing, "cloudflareDeployment").mockResolvedValue({ state: "none", steps: steps(0), message: "" });
    vi.spyOn(host.publishing, "cloudflarePermissions").mockResolvedValue({ tokenOk: true, ready: false, accounts: [], guide: [], checks: [{ id: "dns-edit", label: "Zone: DNS: Edit", required: true, state: "missing", detail: "refused" }] });
    wrap(<CloudflareAccess />);
    fireEvent.click(await screen.findByRole("button", { name: "Check permissions" }));
    expect(await screen.findByText("A required permission is missing")).toBeTruthy();
    expect(screen.getByText("Zone: DNS: Edit")).toBeTruthy();
  });
});
