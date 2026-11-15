// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MachineSignIn } from "../src/pages/access/MachineSignIn.tsx";
import { host, type IdentityLinkView, type IdentityStartView } from "../src/data/engine/host.ts";

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const LID = "5c1b7e22-3a4f-4d0e-9b6a-1f2e3d4c5b6a";
const link = (o: Partial<IdentityLinkView> = {}): IdentityLinkView => ({ linkId: LID, kind: "association", principal: { userid: "root", realm: "pam" }, requestedBy: { userid: "root", realm: "pam" }, state: "awaiting_account", requestedAt: 1, expiresAt: Date.now() + 600_000, needsAdminApproval: false, ...o });
const started = (o: Partial<IdentityStartView> = {}): IdentityStartView => ({ ...link(), userCode: "KLMN-7PQR", approvalUrl: "https://console.papercliped.co/devices/link?lid=" + LID, linkUrl: "https://link.papercliped.co/", ...o });

describe("Sign in with your Papercliped account (machine link)", () => {
  it("starts a link, shows the code and the portal, waits, then asks the administrator to confirm the approving account", async () => {
    let state: IdentityLinkView[] = [];
    vi.spyOn(host.identity, "oidc").mockResolvedValue({ enabled: false, canManage: true });
    vi.spyOn(host.identity, "links").mockImplementation(async () => ({ links: state, canManageAll: true }));
    const start = vi.spyOn(host.identity, "start").mockImplementation(async () => { state = [link()]; return started(); });
    vi.spyOn(host.identity, "poll").mockImplementation(async () => link());
    const confirm = vi.spyOn(host.identity, "confirm").mockImplementation(async () => { state = [link({ state: "active", account: { id: "acc-123" } })]; return state[0]!; });
    wrap(<MachineSignIn />);
    expect(screen.queryByRole("button", { name: /Let me sign in with Papercliped/ })).toBeNull(); // federation is off
    fireEvent.click(await screen.findByRole("button", { name: "Link my Papercliped account" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("association"));
    expect(await screen.findByText("KLMN-7PQR")).toBeTruthy();
    expect((screen.getByRole("link", { name: /link\.papercliped\.co/ }) as HTMLAnchorElement).href).toBe("https://link.papercliped.co/");
    // the owner approves on the website: the account that did so is shown and nothing is linked until it is confirmed here
    state = [link({ state: "awaiting_confirm", account: { id: "acc-123" } })];
    expect(await screen.findByText(/acc-123/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/does not change any Proxmox permission/)).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm this account" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(LID, "acc-123"));
    expect(await screen.findByText(/is linked to/)).toBeTruthy();
  }, 15000);

  it("lists an active link and unlinks it only after a second click", async () => {
    let state = [link({ state: "active", account: { id: "acc-123" } })];
    vi.spyOn(host.identity, "oidc").mockResolvedValue({ enabled: false, canManage: false });
    vi.spyOn(host.identity, "links").mockImplementation(async () => ({ links: state, canManageAll: false }));
    const unlink = vi.spyOn(host.identity, "unlink").mockImplementation(async () => { state = []; return {}; });
    wrap(<MachineSignIn />);
    expect(await screen.findByText(/acc-123/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(unlink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(unlink).toHaveBeenCalledWith(LID));
    expect(await screen.findByRole("button", { name: "Link my Papercliped account" })).toBeTruthy();
  });

  it("offers Sign in with Papercliped only when the realm is enabled, and says what a refusal was", async () => {
    vi.spyOn(host.identity, "oidc").mockResolvedValue({ enabled: true, canManage: true });
    vi.spyOn(host.identity, "links").mockResolvedValue({ links: [], canManageAll: true });
    vi.spyOn(host.identity, "start").mockRejectedValue(new Error("This Proxmox user already has a linked Papercliped account."));
    wrap(<MachineSignIn />);
    fireEvent.click(await screen.findByRole("button", { name: /Let me sign in with Papercliped/ }));
    expect(await screen.findByText(/already has a linked Papercliped account/)).toBeTruthy();
  });

  it("never renders an unsafe portal address as a link", async () => {
    let state: IdentityLinkView[] = [];
    vi.spyOn(host.identity, "oidc").mockResolvedValue({ enabled: false, canManage: false });
    vi.spyOn(host.identity, "links").mockImplementation(async () => ({ links: state, canManageAll: false }));
    vi.spyOn(host.identity, "start").mockImplementation(async () => { state = [link()]; return started({ linkUrl: "javascript:alert(1)" }); });
    vi.spyOn(host.identity, "poll").mockResolvedValue(link());
    wrap(<MachineSignIn />);
    fireEvent.click(await screen.findByRole("button", { name: "Link my Papercliped account" }));
    expect(await screen.findByText("KLMN-7PQR")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /link\.papercliped\.co/ })).toBeNull();
  });
});
