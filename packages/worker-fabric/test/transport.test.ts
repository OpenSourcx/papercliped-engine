import { describe, expect, it } from "vitest";
import { detectTransports, endpointsFor, orderEndpoints } from "../src/index.ts";

const status = JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.113.98.16", "fd7a::1"], DNSName: "agent-dev.tail.ts.net." } });
const base = { tailscaleStatus: null, tailscaleIp: null, interfaces: [], customUrl: null };

describe("transport providers", () => {
  it("detects tailscale as recommended and LAN/custom as optional", () => {
    const t = detectTransports({ ...base, tailscaleStatus: status, tailscaleIp: "100.113.98.16", interfaces: [{ name: "eth0", address: "192.168.1.5", family: "IPv4" }, { name: "ts", address: "100.113.98.16", family: "IPv4" }], customUrl: "wss://e.example:7843" }, 7843);
    expect(t.find((x) => x.provider === "tailscale")).toMatchObject({ available: true, recommended: true, address: "ws://100.113.98.16:7843" });
    expect(t.find((x) => x.provider === "lan")).toMatchObject({ available: true, address: "ws://192.168.1.5:7843" });
    expect(t.find((x) => x.provider === "custom")).toMatchObject({ available: true });
  });
  it("works without tailscale", () => {
    const t = detectTransports({ ...base, interfaces: [{ name: "eth0", address: "10.0.0.7", family: "IPv4" }] }, 7843);
    expect(t.find((x) => x.provider === "tailscale")).toMatchObject({ available: false, recommended: true });
    expect(endpointsFor(t).map((e) => e.provider)).toEqual(["lan"]);
  });
  it("orders endpoints by preference, then recommendation", () => {
    const t = detectTransports({ ...base, tailscaleStatus: status, tailscaleIp: "100.113.98.16", interfaces: [{ name: "eth0", address: "192.168.1.5", family: "IPv4" }], customUrl: "wss://e.example:7843" }, 7843);
    expect(endpointsFor(t).map((e) => e.provider)).toEqual(["tailscale", "lan", "custom"]);
    expect(endpointsFor(t, "custom")[0]!.provider).toBe("custom");
    expect(endpointsFor(t)[0]!.url).toBe("ws://100.113.98.16:7843/fabric/v1/connect");
  });
  it("a worker without tailscale tries usable providers first", () => {
    const urls = [{ provider: "tailscale", url: "a" }, { provider: "lan", url: "b" }, { provider: "custom", url: "c" }];
    expect(orderEndpoints(urls, { tailscale: false, lan: true }).map((e) => e.provider)).toEqual(["lan", "custom", "tailscale"]);
    expect(orderEndpoints(urls, { tailscale: true, lan: true }, "custom").map((e) => e.provider)[0]).toBe("custom");
  });
  it("treats a stopped tailscale as unavailable", () => {
    const t = detectTransports({ ...base, tailscaleStatus: JSON.stringify({ BackendState: "Stopped" }) }, 7843);
    expect(t[0]).toMatchObject({ available: false });
  });
});
