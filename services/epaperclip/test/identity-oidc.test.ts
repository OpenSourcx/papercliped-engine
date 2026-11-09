import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAccessApp } from "./access-harness.ts";
import { fakeConnect } from "./fakes-papercliped.ts";

let h: Awaited<ReturnType<typeof startAccessApp>>;
let fc: ReturnType<typeof fakeConnect>;
let sam: string;
let lee: string;

const pair = async () => {
  await h.call("POST", "/api/papercliped/connect/pairing/start", { cookie: sam }, {});
  fc.approve("acct_owner");
  await h.call("POST", "/api/papercliped/connect/pairing/poll", { cookie: sam }, {});
  const done = await h.call("POST", "/api/papercliped/connect/pairing/confirm", { cookie: sam }, { accountId: "acct_owner", deviceName: "rack" });
  expect(done.status).toBe(200);
};
const enable = () => h.call("POST", "/api/papercliped/connect/identity/oidc/enable", { cookie: sam }, {});
const startFederated = () => h.call("POST", "/api/papercliped/connect/identity/link/start", { cookie: sam }, { kind: "federated" });

beforeEach(async () => {
  fc = fakeConnect();
  h = await startAccessApp({ fetch: fc.fetch, connectUrl: "https://connect.test" });
  fc.state.now = () => h.clock.t;
  sam = await h.signIn("sam");
  lee = await h.signIn("lee");
});
afterEach(async () => { await h.close(); });

describe("Sign in with Papercliped (device side, fake Connect and Proxmox)", () => {
  it("registers one client per device, creates only the agreed realm, and never returns the client secret", async () => {
    expect((await h.call("POST", "/api/papercliped/connect/identity/oidc/enable", { cookie: lee }, {})).status).toBe(403); // lee is not a node administrator
    await pair();
    const r = await enable();
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body).toMatchObject({ enabled: true, issuer: "https://auth.test/oidc", realm: "papercliped" });
    expect(JSON.stringify(body)).not.toContain(fc.oidcClients.values().next().value!.clientSecret);
    const realm = h.pve.realms.get("papercliped")!;
    expect(realm).toMatchObject({
      realm: "papercliped", type: "openid", "issuer-url": "https://auth.test/oidc", "client-id": fc.oidcClients.values().next().value!.clientId,
      "username-claim": "subject", scopes: "openid", autocreate: "0", "query-userinfo": "0",
    });
    expect(realm["client-key"]).toBe(fc.oidcClients.values().next().value!.clientSecret);
    expect((await h.call("GET", "/api/papercliped/connect/identity/oidc", { cookie: lee })).status).toBe(200);
    // Disabling removes exactly the realm ePaperclip created and the device's client.
    expect((await h.call("POST", "/api/papercliped/connect/identity/oidc/disable", { cookie: sam }, {})).status).toBe(200);
    expect(h.pve.realms.has("papercliped")).toBe(false);
    expect(fc.oidcClients.size).toBe(0);
  });

  it("refuses to take over a realm with different settings", async () => {
    await pair();
    h.pve.realms.set("papercliped", { realm: "papercliped", type: "openid", "issuer-url": "https://elsewhere.example", "client-id": "x" });
    const r = await enable();
    expect(r.status).toBe(409);
    expect((await r.json() as any).code).toBe("realm_conflict");
    expect(h.pve.realms.get("papercliped")!["issuer-url"]).toBe("https://elsewhere.example");
  });

  it("lets a federated link through the local link gate, and refuses a hand-made @papercliped user", async () => {
    await pair();
    await enable();
    const started = await startFederated();
    expect(started.status).toBe(201);
    const s = await started.json() as any;
    expect(s.principal).toMatchObject({ userid: "*", realm: "papercliped" });
    fc.approveIdentity("acct_owner", s.linkId);
    await h.call("POST", `/api/papercliped/connect/identity/link/${s.linkId}/poll`, { cookie: sam }, {});
    const active = await h.call("POST", `/api/papercliped/connect/identity/link/${s.linkId}/confirm`, { cookie: sam }, { accountId: "acct_owner" });
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({ state: "active", kind: "federated", principal: { userid: "acct_owner", realm: "papercliped" } });
    expect(h.pve.users.has("acct_owner@papercliped")).toBe(true);
    expect(h.pve.users.get("acct_owner@papercliped")!.groups).toEqual([]); // no group and no role was granted

    // The account holder can now sign in through Proxmox's OpenID realm; the session is tagged with the link.
    h.pve.openid.codes.set("good", "acct_owner@papercliped");
    const begin = await h.call("POST", "/api/login/openid/start", { headers: { "X-EPC-Request": "1" } }, { realm: "papercliped" });
    expect(begin.status).toBe(200);
    const auth = await begin.json() as any;
    const state = new URL(auth.url).searchParams.get("state")!;
    const cookie = begin.headers.get("set-cookie")!.split(";")[0];
    const fin = await h.call("POST", "/api/login/openid/finish", { headers: { "X-EPC-Request": "1", Cookie: cookie } }, { code: "good", state });
    expect(fin.status).toBe(200);
    const session = fin.headers.getSetCookie().find((c) => c.startsWith("epc_session"))!.split(";")[0];
    const me = await h.call("GET", "/api/me", { cookie: session });
    expect(me.status).toBe(200);
    expect((await me.json() as any).user.username).toBe("acct_owner@papercliped");
    // Unlinking ends exactly that federated session.
    expect((await h.call("DELETE", `/api/papercliped/connect/identity/links/${s.linkId}`, { cookie: sam })).status).toBe(200);
    expect((await h.call("GET", "/api/me", { cookie: session })).status).toBe(401);

    // A Proxmox user in the papercliped realm that was not created through an approved link is refused.
    h.pve.openid.codes.set("intruder", "intruder@papercliped");
    const begin2 = await h.call("POST", "/api/login/openid/start", { headers: { "X-EPC-Request": "1" } }, { realm: "papercliped" });
    const auth2 = await begin2.json() as any;
    const fin2 = await h.call("POST", "/api/login/openid/finish", { headers: { "X-EPC-Request": "1", Cookie: begin2.headers.get("set-cookie")!.split(";")[0] } }, { code: "intruder", state: new URL(auth2.url).searchParams.get("state")! });
    expect(fin2.status).toBe(403);
    expect((await fin2.json() as any).code).toBe("not_linked");
  });
});
