import { afterEach, describe, expect, it } from "vitest";
import { ConnectLink } from "../src/connectLink.ts";
import { IdentityLinks, type LinkView, type StartView } from "../src/identityLinks.ts";
import { StateStore } from "../src/state.ts";
import { fakeConnect, fakeTunnelHelper } from "./fakes-papercliped.ts";

async function setup(opts: { federation?: boolean; onLinkRevoked?: (id: string) => void } = {}) {
  const fc = fakeConnect();
  const state = new StateStore(null);
  const link = new ConnectLink(state, fc.fetch, "https://connect.test", () => fc.state.now(), { helper: fakeTunnelHelper().helper });
  await link.start(); fc.approve("acct_owner"); await link.poll(); await link.confirm("acct_owner", "rack");
  const identity = new IdentityLinks(state, fc.fetch, "https://connect.test", () => fc.state.now(), {
    device: () => link.status().device,
    audit: () => {},
    federationEnabled: () => opts.federation === true,
    ...(opts.onLinkRevoked ? { onLinkRevoked: opts.onLinkRevoked } : {}),
  });
  return { fc, state, link, identity };
}

const start = (identity: IdentityLinks, over: Partial<{ sessionId: string; username: string; isAdmin: boolean; returnTo: string; kind: string }> = {}) =>
  identity.start({ sessionId: "session-a", username: "sam@pve", origin: "https://pve.example", returnTo: "/access", isAdmin: true, ...over });

const approveAndConfirm = async (fc: ReturnType<typeof fakeConnect>, identity: IdentityLinks, s: StartView, accountId = "acct_owner", opts: { sessionId?: string; isAdmin?: boolean } = {}): Promise<LinkView> => {
  fc.approveIdentity(accountId, s.linkId);
  await identity.poll(s.linkId, opts.sessionId ?? "session-a", opts.isAdmin ?? true);
  return identity.confirm({ linkId: s.linkId, sessionId: opts.sessionId ?? "session-a", accountId, username: "sam@pve", isAdmin: opts.isAdmin ?? true });
};

afterEach(() => { /* nothing global */ });

describe("identity links (device side, fake Connect)", () => {
  it("links one local principal to the account that approved it, after the exact account is confirmed", async () => {
    const { fc, state, identity } = await setup();
    const s = await start(identity);
    expect(s).toMatchObject({ kind: "association", principal: { userid: "sam", realm: "pve" }, state: "awaiting_account", needsAdminApproval: false });
    expect(s.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(s.approvalUrl).toContain("/devices/link?lid=");
    expect(JSON.stringify(s)).not.toContain("verifier");
    expect(state.getSecret(`identity.link.${s.linkId}.verifier`)).toBeTruthy();
    expect((await identity.poll(s.linkId, "session-a", true)).state).toBe("awaiting_account");
    fc.approveIdentity("acct_owner", s.linkId);
    expect((await identity.poll(s.linkId, "session-a", true)).state).toBe("awaiting_confirm");
    await expect(identity.confirm({ linkId: s.linkId, sessionId: "session-a", accountId: "acct_other", username: "sam@pve", isAdmin: true })).rejects.toMatchObject({ code: "wrong_account" });
    const active = await identity.confirm({ linkId: s.linkId, sessionId: "session-a", accountId: "acct_owner", username: "sam@pve", isAdmin: true });
    expect(active).toMatchObject({ state: "active", role: "owner", account: { id: "acct_owner" }, approvedBy: "owner-account" });
    expect(state.getSecret(`identity.link.${s.linkId}.verifier`)).toBeNull(); // sealed verifier is gone
    expect(identity.linksFor("sam", "pve", false)).toEqual([expect.objectContaining({ linkId: s.linkId, state: "active" })]);
    expect(JSON.stringify(identity.linksFor("sam", "pve", false))).not.toContain("sessionBinding");
    const out = await identity.unlink(s.linkId, { username: "sam@pve", isAdmin: false });
    expect(out).toEqual({ ok: true, remote: "revoked" });
    expect(identity.linksFor("sam", "pve", false)[0]!.state).toBe("revoked");
  });

  it("refuses another link for the same principal until the first is unlinked, and a second start for one in flight", async () => {
    const { fc, identity } = await setup();
    const s = await start(identity);
    await expect(start(identity, { sessionId: "session-c" })).rejects.toMatchObject({ code: "link_in_progress" });
    await approveAndConfirm(fc, identity, s);
    await expect(start(identity, { sessionId: "session-b" })).rejects.toMatchObject({ code: "already_linked" });
    await identity.unlink(s.linkId, { username: "sam@pve", isAdmin: false });
    await expect(start(identity, { sessionId: "session-b" })).resolves.toMatchObject({ state: "awaiting_account" });
  });

  it("does not let a person confirm a link from another session, and leaves the sealed verifier on a Connect outage", async () => {
    const { fc, state, identity } = await setup();
    const s = await start(identity);
    await expect(identity.poll(s.linkId, "another-session", true)).rejects.toMatchObject({ code: "session_mismatch" });
    fc.approveIdentity("acct_owner", s.linkId);
    await identity.poll(s.linkId, "session-a", true);
    fc.state.down = true;
    await expect(identity.confirm({ linkId: s.linkId, sessionId: "session-a", accountId: "acct_owner", username: "sam@pve", isAdmin: true })).rejects.toMatchObject({ code: "connect_unreachable" });
    expect(state.getSecret(`identity.link.${s.linkId}.verifier`)).toBeTruthy();
    expect(identity.link(s.linkId)!.state).toBe("awaiting_confirm");
  });

  it("requires a local administrator for a member account, and creates no permission or session by itself", async () => {
    const { fc, identity } = await setup();
    const s = await start(identity, { username: "lee@pve", isAdmin: false });
    fc.approveIdentity("acct_member", s.linkId);
    await identity.poll(s.linkId, "session-a", false);
    const waiting = await identity.confirm({ linkId: s.linkId, sessionId: "session-a", accountId: "acct_member", username: "lee@pve", isAdmin: false });
    expect(waiting).toMatchObject({ state: "awaiting_admin", needsAdminApproval: true });
    expect(identity.requests()).toHaveLength(1);
    await expect(identity.adminApprove(s.linkId, "acct_other", "sam@pve")).rejects.toMatchObject({ code: "wrong_account" });
    const active = await identity.adminApprove(s.linkId, "acct_member", "sam@pve");
    expect(active).toMatchObject({ state: "active", role: "member", approvedBy: "admin:sam@pve", principal: { userid: "lee", realm: "pve" } });
  });

  it("honours a device-local pre-approval, and refuses to create one for a malformed principal", async () => {
    const { fc, identity } = await setup();
    expect(() => identity.addPreapproval({ principal: { userid: "bad user", realm: "pve" }, admin: "sam@pve" })).toThrow(/principal/);
    identity.addPreapproval({ principal: { userid: "lee", realm: "pve" }, boundAccountId: "acct_member", ttlHours: 2, admin: "sam@pve" });
    const s = await start(identity, { username: "lee@pve", isAdmin: false });
    expect(s.needsAdminApproval).toBe(false);
    fc.approveIdentity("acct_member", s.linkId);
    await identity.poll(s.linkId, "session-a", false);
    const active = await identity.confirm({ linkId: s.linkId, sessionId: "session-a", accountId: "acct_member", username: "lee@pve", isAdmin: false });
    expect(active).toMatchObject({ state: "active", approvedBy: expect.stringMatching(/^preapproval:/) });
    expect(identity.preapprovalList()).toEqual([]); // consumed once
  });

  it("keeps working through an outage for reads, and retries a local unlink's revoke in reconcile", async () => {
    const { fc, identity } = await setup();
    const s = await start(identity);
    const active = await approveAndConfirm(fc, identity, s);
    expect(active.state).toBe("active");
    fc.state.down = true;
    const out = await identity.unlink(s.linkId, { username: "sam@pve", isAdmin: false });
    expect(out.remote).toBe("pending");
    expect(identity.link(s.linkId)).toMatchObject({ state: "revoked" });
    fc.state.down = false;
    await identity.reconcile();
    expect((fc.identityLinks.get(s.linkId) as { state: string }).state).toBe("revoked");
  });

  it("revokes every link on unpair and calls the federated cleanup hook only for federated links", async () => {
    const revoked: string[] = [];
    const { fc, identity } = await setup({ onLinkRevoked: (id) => { revoked.push(id); } });
    const s = await start(identity);
    await approveAndConfirm(fc, identity, s);
    expect(await identity.revokeAll("device", "unpair")).toBe(1);
    expect(revoked).toEqual([]); // an association link derives no session or token
    expect(identity.linksFor("sam", "pve", false)[0]!.state).toBe("revoked");
  });

  it("does not offer federation until the local Papercliped sign-in is enabled", async () => {
    const { identity } = await setup();
    await expect(start(identity, { kind: "federated" })).rejects.toMatchObject({ code: "federation_off" });
    const enabled = await setup({ federation: true });
    const s = await start(enabled.identity, { kind: "federated" });
    expect(s).toMatchObject({ kind: "federated", principal: { userid: "*", realm: "papercliped" } });
  });
});
