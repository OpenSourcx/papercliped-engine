// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { MachineSignInAdmin } from "../src/pages/access/MachineSignInAdmin.tsx";
import { RemoteAccess } from "../src/pages/access/RemoteAccess.tsx";
import { host, type IdentityLinkView, type IdentityPreapproval } from "../src/data/engine/host.ts";

vi.mock("../src/pages/access/CloudflareAccess.tsx", () => ({ CloudflareAccess: () => <div>cloudflare section</div> }));
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const LID = "5c1b7e22-3a4f-4d0e-9b6a-1f2e3d4c5b6a";
const link = (o: Partial<IdentityLinkView> = {}): IdentityLinkView => ({ linkId: LID, kind: "association", principal: { userid: "alice", realm: "pam" }, requestedBy: { userid: "alice", realm: "pam" }, state: "awaiting_admin", account: { id: "acc-123", displayName: "Alice" }, requestedAt: 1, expiresAt: Date.now() + 3_600_000, needsAdminApproval: true, ...o });
const pre = (o: Partial<IdentityPreapproval> = {}): IdentityPreapproval => ({ id: "p1", principal: { userid: "bob", realm: "pam" }, kind: "association", createdBy: "root@pam", createdAt: 1, expiresAt: Date.now() + 3_600_000, ...o });
const quiet = (o: { enabled?: boolean; requests?: IdentityLinkView[]; pre?: IdentityPreapproval[]; links?: IdentityLinkView[] } = {}) => {
  vi.spyOn(host.identity, "oidc").mockResolvedValue({ enabled: o.enabled ?? false, canManage: true });
  vi.spyOn(host.identity, "requests").mockResolvedValue(o.requests ?? []);
  vi.spyOn(host.identity, "preapprovals").mockResolvedValue(o.pre ?? []);
  vi.spyOn(host.identity, "links").mockResolvedValue({ links: o.links ?? [], canManageAll: true });
};

describe("Papercliped sign-in: administrators", () => {
  it("turns the realm on directly and off only after a second, explained click", async () => {
    quiet({ enabled: false });
    const on = vi.spyOn(host.identity, "oidcEnable").mockResolvedValue({ enabled: true });
    const off = vi.spyOn(host.identity, "oidcDisable").mockResolvedValue({ enabled: false });
    wrap(<MachineSignInAdmin canManage />);
    const turnOn = await screen.findByRole("button", { name: "Turn on" });
    vi.mocked(host.identity.oidc).mockResolvedValue({ enabled: true, canManage: true }); // what the host reports after it is switched on
    fireEvent.click(turnOn);
    await waitFor(() => expect(on).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(off).not.toHaveBeenCalled();
    expect(screen.getByText(/ends every sign-in link made with it/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Turn off" }).at(-1)!);
    await waitFor(() => expect(off).toHaveBeenCalled());
  });

  it("shows who asks to link which account, and approves with that exact account or denies", async () => {
    quiet({ requests: [link()] });
    const approve = vi.spyOn(host.identity, "adminApprove").mockResolvedValue(link({ state: "active" }));
    const deny = vi.spyOn(host.identity, "adminDeny").mockResolvedValue({ ok: true });
    wrap(<MachineSignInAdmin canManage />);
    expect(await screen.findByText(/alice@pam/)).toBeTruthy();
    expect(screen.getByText(/acc-123/)).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(LID, "acc-123"));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(deny).toHaveBeenCalledWith(LID));
  });

  it("lists pre-approvals, removes one, and adds one only with valid input", async () => {
    quiet({ pre: [pre()] });
    const add = vi.spyOn(host.identity, "addPreapproval").mockResolvedValue(pre({ id: "p2" }));
    const remove = vi.spyOn(host.identity, "removePreapproval").mockResolvedValue({});
    wrap(<MachineSignInAdmin canManage />);
    expect(await screen.findByText(/bob@pam/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("p1"));
    const submit = screen.getByRole("button", { name: "Add pre-approval" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);                                     // no user yet
    fireEvent.change(screen.getByLabelText("Proxmox user"), { target: { value: "carol" } });
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "80" } });
    expect(submit.disabled).toBe(true);                                     // more than 72 hours
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Account id"), { target: { value: "bad id!" } });
    expect(submit.disabled).toBe(true);                                     // not an account id
    fireEvent.change(screen.getByLabelText("Account id"), { target: { value: "acc-123" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(add).toHaveBeenCalledWith({ principal: { userid: "carol", realm: "pam" }, kind: "association", boundAccountId: "acc-123", ttlHours: 12 }));
  });

  it("offers 'Sign in' pre-approvals only while the realm is on, and lets an administrator unlink someone else's link after a second click", async () => {
    quiet({ enabled: false, links: [link({ state: "active", principal: { userid: "dave", realm: "pam" }, requestedBy: { userid: "dave", realm: "pam" }, account: { id: "acc-999" } })] });
    const unlink = vi.spyOn(host.identity, "unlink").mockResolvedValue({});
    wrap(<MachineSignInAdmin canManage />);
    expect(await screen.findByText(/dave@pam/)).toBeTruthy();
    expect(within(screen.getByLabelText("Kind")).queryByRole("option", { name: "Sign in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(unlink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(unlink).toHaveBeenCalledWith(LID));
  });

  it("is only on the Remote access page for administrators of a linked machine", async () => {
    vi.spyOn(host.connect, "status").mockResolvedValue({ mode: "local", paired: true, device: { deviceId: "d", accountId: "acc-1", name: "pve", pairedAt: 1 } });
    vi.spyOn(host.identity, "links").mockResolvedValue({ links: [], canManageAll: false });
    vi.spyOn(host.identity, "requests").mockResolvedValue([]); vi.spyOn(host.identity, "preapprovals").mockResolvedValue([]);
    vi.spyOn(host.identity, "oidc").mockResolvedValue({ enabled: false, canManage: false });
    const first = wrap(<RemoteAccess />);
    expect(await screen.findByText("Sign in with your Papercliped account")).toBeTruthy();
    expect(screen.queryByText(/Papercliped sign-in: administrators/)).toBeNull();
    first.unmount(); cleanup();
    vi.mocked(host.identity.oidc).mockResolvedValue({ enabled: false, canManage: true });
    wrap(<RemoteAccess />);
    expect(await screen.findByText(/Papercliped sign-in: administrators/)).toBeTruthy();
  });
});
