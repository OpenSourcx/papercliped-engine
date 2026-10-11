import { describe, expect, it } from "vitest";
import { checkAlias, checkIpsetEntry, checkOptions, checkRule, consoleAllowed, portMatches, ruleParams } from "../src/firewall.ts";

describe("firewall rules", () => {
  it("accepts a typical rule and maps it for Proxmox", () => {
    const r = checkRule({ type: "in", action: "ACCEPT", proto: "tcp", dport: "80,443", source: "+lan", comment: "web" });
    expect(ruleParams(r, false)).toEqual({ type: "in", action: "ACCEPT", enable: 1, proto: "tcp", dport: "80,443", source: "+lan", comment: "web" });
    expect(ruleParams(r, true).delete).toBe("macro,sport,dest,iface,log");
  });

  it("uses a macro instead of protocol and ports", () => {
    expect(checkRule({ type: "in", action: "ACCEPT", macro: "SSH", proto: "udp", dport: "53" })).toMatchObject({ macro: "SSH", proto: null, dport: null });
  });

  it("refuses unsafe or impossible input", () => {
    for (const bad of [
      { type: "in", action: "ALLOW" },
      { type: "sideways", action: "ACCEPT" },
      { type: "in", action: "ACCEPT", dport: "22" },
      { type: "in", action: "ACCEPT", proto: "tcp", dport: "22; rm -rf /" },
      { type: "in", action: "ACCEPT", source: "10.0.0.0/8 any" },
      { type: "in", action: "ACCEPT", comment: "a\nb" },
      { type: "group", action: "1bad" },
    ]) expect(() => checkRule(bad)).toThrow();
  });

  it("checks options per level and refuses unknown keys", () => {
    expect(checkOptions("cluster", { enable: true, policy_in: "DROP" })).toEqual({ enable: 1, policy_in: "DROP" });
    expect(checkOptions("guest", { enable: false, macfilter: true, log_level_in: "info" })).toEqual({ enable: 0, macfilter: 1, log_level_in: "info" });
    expect(() => checkOptions("node", { policy_in: "DROP" })).toThrow();
    expect(() => checkOptions("cluster", { rogue: 1 })).toThrow();
    expect(() => checkOptions("cluster", { enable: "yes" })).toThrow();
  });

  it("validates aliases and ipset entries", () => {
    expect(checkAlias({ name: "lan", cidr: "192.168.1.0/24" })).toEqual({ name: "lan", cidr: "192.168.1.0/24", comment: undefined });
    expect(() => checkAlias({ name: "1lan", cidr: "x" })).toThrow();
    expect(checkIpsetEntry({ cidr: "10.0.0.5", nomatch: true })).toMatchObject({ cidr: "10.0.0.5", nomatch: true });
    expect(() => checkIpsetEntry({ cidr: "a b" })).toThrow();
  });
});

describe("console lock-out check", () => {
  it("reads port specs", () => {
    expect(portMatches("443", 443)).toBe(true);
    expect(portMatches("80,443", 443)).toBe(true);
    expect(portMatches("400:500", 443)).toBe(true);
    expect(portMatches("8006", 443)).toBe(false);
    expect(portMatches("https", 443)).toBe(true);
  });

  it("finds a rule that lets the console in", () => {
    expect(consoleAllowed([{ type: "in", action: "ACCEPT", proto: "tcp", dport: "443", enable: 1 }], 443)).toBe(true);
    expect(consoleAllowed([{ type: "in", action: "ACCEPT", macro: "HTTPS", enable: 1 }], 443)).toBe(true);
    expect(consoleAllowed([{ type: "in", action: "ACCEPT", proto: "tcp", dport: "443", enable: 0 }], 443)).toBe(false);
    expect(consoleAllowed([{ type: "in", action: "DROP", proto: "tcp", dport: "443", enable: 1 }], 443)).toBe(false);
    expect(consoleAllowed([{ type: "out", action: "ACCEPT", proto: "tcp", dport: "443", enable: 1 }], 443)).toBe(false);
    expect(consoleAllowed([{ type: "in", action: "ACCEPT", proto: "tcp", dport: "8443", enable: 1 }], 8443)).toBe(true);
    expect(consoleAllowed([], 443)).toBe(false);
  });
});
