import { describe, expect, it } from "vitest";
import { CloudflareProvision } from "../src/cloudflareProvision.ts";
import { Publishing } from "../src/publishing.ts";
import { StateStore } from "../src/state.ts";
import { fakeCloudflare } from "./fakes-cloudflare.ts";
import { fakeTunnelHelper } from "./fakes-papercliped.ts";

const TOKEN = "cf-fake-token-0123456789abcdef";
function setup() {
  const cf = fakeCloudflare();
  const state = new StateStore(null);
  let probeOk = true;
  const probes: string[] = [];
  const fetch = async (u: string | URL, i: RequestInit) => {
    if (String(u).startsWith("https://api.cloudflare.com")) return cf.fetch(u, i);
    probes.push(String(u));
    return probeOk ? new Response(JSON.stringify({ ok: true })) : new Response("bad gateway", { status: 502 });
  };
  const pub = new Publishing(state, fetch, () => 1000);
  pub.setSleep(async () => {});
  pub.setToken(TOKEN, "sam@pam");
  const { h, helper } = fakeTunnelHelper();
  const prov = new CloudflareProvision(pub, state, helper, fetch, () => 1000);
  return { cf: cf.f, state, pub, prov, h, probes, setProbe: (v: boolean) => { probeOk = v; } };
}
const writes = (c: string[]) => c.filter((x) => !x.startsWith("GET"));

describe("self-managed Cloudflare provisioning (fake Cloudflare API)", () => {
  it("creates the tunnel, ingress, proxied CNAME and connector, then proves the address is reachable", async () => {
    const { cf, prov, h, probes } = setup();
    const v = await prov.provision("Example.com", "App");
    expect(v.state).toBe("connecting"); // the live probe belongs to status()
    expect(cf.tunnels).toHaveLength(1);
    expect(cf.tunnels[0]).toMatchObject({ config_src: "cloudflare" });
    expect(cf.configs.get(cf.tunnels[0]!.id)).toEqual({ config: { ingress: [{ hostname: "app.example.com", service: "https://127.0.0.1:443", originRequest: { noTLSVerify: true } }, { service: "http_status:404" }] } });
    expect(cf.records).toEqual([expect.objectContaining({ type: "CNAME", name: "app.example.com", content: `${cf.tunnels[0]!.id}.cfargotunnel.com`, proxied: true })]);
    expect(h).toMatchObject({ owner: "self", active: true });
    expect(h.token).toContain(cf.tunnels[0]!.id);
    const s = await prov.status();
    expect(s.state).toBe("running");
    expect(s.steps.every((x) => x.state === "done")).toBe(true);
    expect(probes).toEqual(["https://app.example.com/api/health"]);
    expect(prov.tunnelTrusted()).toBe(true);
  });

  it("never exposes the run token, the API token or a record of either in any view or saved setting", async () => {
    const { prov, h, state } = setup();
    const v = await prov.provision("example.com", "app");
    const all = JSON.stringify([v, await prov.status(), state.getSetting("publishing.cloudflare.deployment")]);
    expect(all).not.toContain(h.token!);
    expect(all).not.toContain(TOKEN);
  });

  it("is idempotent: running it again creates nothing new", async () => {
    const { cf, prov } = setup();
    await prov.provision("example.com", "app");
    const before = { t: cf.tunnels.length, r: cf.records.length, w: writes(cf.calls).filter((c) => !c.includes("/token")).length };
    await prov.provision("example.com", "app");
    expect(cf.tunnels).toHaveLength(before.t);
    expect(cf.records).toHaveLength(before.r);
    expect(writes(cf.calls).filter((c) => !c.includes("/token")).length).toBe(before.w);
  });

  it("allows one address per device", async () => {
    const { prov } = setup();
    await prov.provision("example.com", "app");
    await expect(prov.provision("example.com", "other")).rejects.toMatchObject({ code: "deployment_exists" });
  });

  it("validates the subdomain and the domain before touching Cloudflare", async () => {
    const { cf, prov } = setup();
    for (const bad of ["a.b", "-x", "x-", "", "has space", "www", "x".repeat(64)]) await expect(prov.provision("example.com", bad)).rejects.toMatchObject({ status: 400 });
    await expect(prov.provision("not a domain", "app")).rejects.toMatchObject({ code: "bad_zone" });
    expect(cf.calls).toEqual([]);
  });

  it("refuses a domain the token cannot see", async () => {
    const { prov } = setup();
    await expect(prov.provision("other.org", "app")).rejects.toMatchObject({ code: "zone_not_found" });
  });

  it("does not overwrite a foreign DNS record: it asks, and replaces only after confirmation", async () => {
    const { cf, prov } = setup();
    cf.records.push({ id: "old", type: "A", name: "app.example.com", content: "203.0.113.9", proxied: false });
    const v = await prov.provision("example.com", "app");
    expect(v.state).toBe("needs_confirmation");
    expect(v.conflict).toEqual({ type: "A", content: "203.0.113.9", proxied: false });
    expect(cf.records).toEqual([expect.objectContaining({ id: "old", content: "203.0.113.9" })]);
    expect(writes(cf.calls).some((c) => c.startsWith("DELETE /zones"))).toBe(false);
    const done = await prov.provision("example.com", "app", { confirmReplace: true });
    expect(done.state).toBe("connecting");
    expect(cf.records).toHaveLength(1);
    expect(cf.records[0]).toMatchObject({ type: "CNAME", proxied: true });
  });

  it("adopts a tunnel with our name (state lost) instead of creating a second one, and refuses a locally managed one", async () => {
    const a = setup();
    await a.prov.provision("example.com", "app");
    const name = a.cf.tunnels[0]!.name;
    expect(name).toMatch(/^epaperclip-[0-9a-f]{8}$/);
    // Same device id, record gone: re-run adopts by name.
    const c = setup();
    c.state.setSetting("publishing.cloudflare.device", "deadbeef");
    c.cf.tunnels.push({ id: "t-old", name: "epaperclip-deadbeef", config_src: "cloudflare" });
    await c.prov.provision("example.com", "app");
    expect(c.cf.tunnels).toHaveLength(1);
    expect(c.cf.records[0]!.content).toBe("t-old.cfargotunnel.com");
    const d = setup();
    d.state.setSetting("publishing.cloudflare.device", "deadbeef");
    d.cf.tunnels.push({ id: "t-local", name: "epaperclip-deadbeef", config_src: "local" });
    const v = await d.prov.provision("example.com", "app");
    expect(v.state).toBe("failed");
    expect(v.failure).toMatchObject({ step: "tunnel", code: "tunnel_foreign" });
  });

  it("resumes after a partial failure without duplicating anything", async () => {
    const { cf, prov, h } = setup();
    cf.failOn = { match: /POST \/zones\/z1\/dns_records/, status: 500 };
    const v = await prov.provision("example.com", "app");
    expect(v.state).toBe("failed");
    expect(v.failure).toMatchObject({ step: "dns", code: "cloudflare_unavailable" });
    expect(v.steps.map((s) => s.state)).toEqual(["done", "done", "done", "failed", "todo", "todo"]);
    expect(cf.tunnels).toHaveLength(1);
    cf.failOn = null;
    const ok = await prov.provision("example.com", "app");
    expect(ok.state).toBe("connecting");
    expect(cf.tunnels).toHaveLength(1);
    expect(cf.records).toHaveLength(1);
    expect(h.active).toBe(true);
  });

  it("reports a connector (helper) failure as a failed step that Resume fixes", async () => {
    const { prov, h } = setup();
    h.fail = true;
    const v = await prov.provision("example.com", "app");
    expect(v.failure).toMatchObject({ step: "connector", code: "helper_error" });
    h.fail = false;
    expect((await prov.provision("example.com", "app")).state).toBe("connecting");
  });

  it("survives a short rate limit and reports a persistent one without losing the record", async () => {
    const a = setup();
    a.cf.rateLimit = 2;
    expect((await a.prov.provision("example.com", "app")).state).toBe("connecting");
    const b = setup();
    await b.prov.provision("example.com", "app");
    b.cf.rateLimit = 99;
    await expect(b.prov.remove()).resolves.toMatchObject({ state: "failed", failure: { code: "rate_limited" } });
    expect(b.prov.has()).toBe(true);
    b.cf.rateLimit = 0;
    await expect(b.prov.remove()).resolves.toMatchObject({ state: "none" });
    expect(b.cf.tunnels.every((t) => t.deleted)).toBe(true);
    expect(b.cf.records).toEqual([]);
  });

  it("names the missing permission instead of a vague error", async () => {
    const a = setup();
    a.cf.missing.add("Zone: Zone: Read");
    await expect(a.pub.zones()).rejects.toMatchObject({ code: "missing_permission", message: expect.stringContaining("Zone: Zone: Read") });
    const b = setup();
    b.cf.missing.add("Account: Cloudflare Tunnel: Edit");
    const v = await b.prov.provision("example.com", "app");
    expect(v.failure).toMatchObject({ step: "tunnel", code: "missing_permission" });
    expect(v.failure!.message).toContain("Account: Cloudflare Tunnel: Edit");
    const c = setup();
    c.cf.missing.add("Zone: DNS: Edit");
    const w = await c.prov.provision("example.com", "app");
    expect(w.failure).toMatchObject({ step: "dns" });
    expect(w.failure!.message).toContain("Zone: DNS: Edit");
  });

  it("rejects a bad token plainly", async () => {
    const { cf, prov } = setup();
    cf.tokenOk = false;
    await expect(prov.provision("example.com", "app")).rejects.toMatchObject({ code: "token_invalid" });
    expect((await prov.permissions()).tokenOk).toBe(false);
  });

  it("self-check lists each permission as ok, missing or unknown", async () => {
    const { cf, prov } = setup();
    const ok = await prov.permissions("example.com");
    expect(ok.ready).toBe(true);
    expect(ok.checks.map((c) => [c.id, c.state])).toEqual([["zone-read", "ok"], ["account-read", "ok"], ["tunnel-edit", "ok"], ["dns-edit", "ok"]]);
    cf.missing.add("Zone: DNS: Edit"); cf.accountList = false;
    const bad = await prov.permissions("example.com");
    expect(bad.ready).toBe(false);
    expect(bad.checks.find((c) => c.id === "dns-edit")).toMatchObject({ state: "missing", label: "Zone: DNS: Edit" });
    expect(bad.checks.find((c) => c.id === "account-read")).toMatchObject({ state: "unknown", required: false });
    expect(bad.accounts).toEqual([{ id: "a1", name: "Acme" }]); // account taken from the domain
  });

  it("accepts a token with more permissions than needed: only a missing required one blocks", async () => {
    // The fake grants everything it is asked for, as a broad (for example account-wide) token would.
    const { prov } = setup();
    const broad = await prov.permissions("example.com");
    expect(broad.ready).toBe(true);
    expect(broad.checks.every((c) => c.state === "ok")).toBe(true);
    await expect(prov.provision("example.com", "app")).resolves.toMatchObject({ hostname: "app.example.com" });
  });

  it("handles no domains and pages through many", async () => {
    const a = setup();
    a.cf.zones.length = 0;
    await expect(a.pub.zones()).resolves.toEqual([]);
    expect((await a.prov.permissions()).checks.find((c) => c.id === "zone-read")!.detail).toMatch(/no active domain/);
    const b = setup();
    for (let i = 0; i < 120; i++) b.cf.zones.push({ id: `zz${i}`, name: `d${i}.org`, status: "active", account: { id: "a1", name: "Acme" } });
    expect(await b.pub.zones()).toHaveLength(121);
  });

  it("status says stopped if the connector was stopped and connecting while the address does not answer", async () => {
    const { prov, h, setProbe } = setup();
    await prov.provision("example.com", "app");
    setProbe(false);
    expect((await prov.status()).state).toBe("connecting");
    h.active = false;
    expect((await prov.status()).state).toBe("stopped");
    h.active = true; setProbe(true);
    expect((await prov.status()).state).toBe("running");
  });

  it("leaving the mode stops the connector but keeps the Cloudflare objects", async () => {
    const { cf, prov, h } = setup();
    await prov.provision("example.com", "app");
    await prov.stop();
    expect(h.owner).toBe(null);
    expect(cf.tunnels).toHaveLength(1);
    expect(cf.records).toHaveLength(1);
    expect((await prov.status()).state).toBe("stopped");
    expect((await prov.provision("example.com", "app")).state).toBe("connecting"); // Resume
    expect(cf.tunnels).toHaveLength(1);
  });

  it("remove deletes the DNS record, the tunnel and the connector, only what this device created", async () => {
    const { cf, prov, h } = setup();
    cf.records.push({ id: "keep", type: "A", name: "www.example.com", content: "203.0.113.1" });
    await prov.provision("example.com", "app");
    const v = await prov.remove();
    expect(v.state).toBe("none");
    expect(prov.has()).toBe(false);
    expect(h.owner).toBe(null);
    expect(cf.tunnels.every((t) => t.deleted)).toBe(true);
    expect(cf.records).toEqual([expect.objectContaining({ id: "keep" })]);
    expect((await prov.remove()).state).toBe("none"); // idempotent
  });

  it("remove resumes after a partial failure and tolerates objects already deleted in Cloudflare", async () => {
    const { cf, prov } = setup();
    await prov.provision("example.com", "app");
    cf.records.length = 0; // deleted by hand in the Cloudflare dashboard
    cf.failOn = { match: /DELETE \/accounts\/a1\/cfd_tunnel\/t\d+$/, status: 500 };
    const v = await prov.remove();
    expect(v.state).toBe("failed");
    expect(v.failure!.message).toMatch(/Remove again/);
    cf.failOn = null;
    expect((await prov.remove()).state).toBe("none");
  });
});
