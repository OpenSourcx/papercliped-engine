import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { clientIp, trustTunnelWhen } from "../src/clientIp.ts";
import { ConnectService } from "../src/features/connect-oauth.ts";
import { StateStore } from "../src/state.ts";

afterEach(() => trustTunnelWhen(() => false));
const req = (peer: string, cf?: string) => ({ socket: { remoteAddress: peer }, headers: cf === undefined ? {} : { "cf-connecting-ip": cf } }) as unknown as IncomingMessage;

describe("client address behind the tunnel", () => {
  it("believes CF-Connecting-IP only from loopback and only while the tunnel is ours", () => {
    expect(clientIp(req("127.0.0.1", "203.0.113.7"))).toBe("127.0.0.1"); // not in Connect mode
    trustTunnelWhen(() => true);
    expect(clientIp(req("127.0.0.1", "203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(req("::ffff:127.0.0.1", "203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(req("192.168.1.50", "203.0.113.7"))).toBe("192.168.1.50"); // a LAN client can't pick its address
    expect(clientIp(req("127.0.0.1"))).toBe("127.0.0.1");
    for (const bad of ["", "not-an-ip", "1.2.3.4, 5.6.7.8", "203.0.113.7\nx"]) expect(clientIp(req("127.0.0.1", bad)), bad).toBe("127.0.0.1");
  });
  it("buckets IPv6 clients by /64 and unwraps mapped IPv4", () => {
    trustTunnelWhen(() => true);
    expect(clientIp(req("127.0.0.1", "2001:db8:1:2:aaaa:bbbb:cccc:dddd"))).toBe(clientIp(req("127.0.0.1", "2001:0DB8:1:2::1")));
    expect(clientIp(req("127.0.0.1", "2001:db8:1:3::1"))).not.toBe(clientIp(req("127.0.0.1", "2001:db8:1:2::1")));
    expect(clientIp(req("127.0.0.1", "::ffff:198.51.100.4"))).toBe("198.51.100.4");
  });
});

describe("OAuth registration is bounded for internet exposure", () => {
  const svc = () => { let t = 1_000_000; return { s: new ConnectService({ state: new StateStore(null), now: () => t, pve: () => { throw new Error("unused"); }, epoch: () => 0, secure: true }), tick: (ms: number) => { t += ms; } }; };
  const body = { redirect_uris: ["https://a.example/cb"] };
  it("caps never-approved registrations so they can't crowd out real apps", () => {
    const { s } = svc();
    for (let i = 0; i < 100; i++) s.register(body, `198.51.100.${i}`);
    expect(() => s.register(body, "203.0.113.1")).toThrow(/waiting for approval/);
  });
  it("caps registrations across all addresses per hour", () => {
    const { s, tick } = svc();
    // a botnet of single-shot addresses: pending clients are forgotten after a day, so only the global rate stops it early
    let blocked = 0;
    for (let i = 0; i < 130; i++) { try { s.register(body, `10.1.${i >> 8}.${i & 255}`); } catch (e) { if (/right now|waiting/.test((e as Error).message)) blocked++; } }
    expect(blocked).toBeGreaterThan(0);
    tick(3_700_000);
    expect(() => s.register(body, "10.9.9.9")).not.toThrow(/right now/);
  });
  it("the issuer follows a function, so it can change with the mode", () => {
    let url: string | undefined;
    const s = new ConnectService({ state: new StateStore(null), now: () => 1, pve: () => { throw new Error("unused"); }, epoch: () => 0, secure: true, publicUrl: () => url });
    const r = { headers: { host: "10.0.0.5:8006" } } as unknown as IncomingMessage;
    expect(s.origin(r)).toBe("https://10.0.0.5:8006");
    url = "https://lab-1.connect.papercliped.co/";
    expect(s.origin(r)).toBe("https://lab-1.connect.papercliped.co");
  });
});
