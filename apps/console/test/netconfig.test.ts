import { describe, expect, it } from "vitest";
import { demoBackend } from "../src/data/backend.ts";
import { demoData } from "../src/data/demo.ts";

const data = demoData(null);
const b = () => demoBackend(() => data.host.storage, () => data.guests);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("demo firewall", () => {
  it("won't turn on a dropping firewall that blocks the console, unless asked", async () => {
    const be = b();
    await expect(be.firewallPost("datacenter", "options", { enable: true })).rejects.toMatchObject({ code: "lockout" });
    await be.firewallPost("datacenter", "options", { enable: true, keepConsole: true });
    const host = await be.firewallGet<{ rules: { dport: string | null }[] }>("host", "rules");
    expect(host.rules[0].dport).toBe("443");
    await expect(be.firewallPost("host", "rules/0/delete", {})).rejects.toMatchObject({ code: "lockout" });
    await be.firewallPost("host", "rules/0/delete", { ignoreLockout: true });
    expect((await be.firewallGet<{ rules: unknown[] }>("host", "rules")).rules).toHaveLength(0);
  });

  it("adds, reorders and toggles rules; machines get their own firewall", async () => {
    const be = b();
    await be.firewallPost("datacenter", "rules", { type: "in", action: "DROP", proto: "tcp", dport: "23", comment: "no telnet" });
    let r = (await be.firewallGet<{ rules: { pos: number; comment: string | null }[] }>("datacenter", "rules")).rules;
    expect(r[0].comment).toBe("no telnet");
    await be.firewallPost("datacenter", "rules/0", { moveto: 2 });
    r = (await be.firewallGet<{ rules: { pos: number; comment: string | null }[] }>("datacenter", "rules")).rules;
    expect(r[2].comment).toBe("no telnet");
    await be.firewallPost("datacenter", "rules/2", { enable: false });
    expect((await be.firewallGet<{ rules: { enable: boolean }[] }>("datacenter", "rules")).rules[2].enable).toBe(false);
    await expect(be.firewallPost("datacenter", "rules", { type: "in", action: "ACCEPT", dport: "22" })).rejects.toThrow(/TCP or UDP/);
    expect((await be.firewallGet<{ rules: unknown[] }>("guest-101", "rules")).rules).toHaveLength(1);
    expect(((await be.firewallGet<{ options: Record<string, number> }>("guest-101", "options")).options).macfilter).toBe(1);
  });

  it("manages groups, aliases and IP sets", async () => {
    const be = b();
    await be.firewallPost("datacenter", "groups", { group: "databases" });
    expect((await be.firewallGet<{ groups: unknown[] }>("datacenter", "groups")).groups).toHaveLength(2);
    await be.firewallPost("datacenter", "aliases", { name: "office", cidr: "10.1.0.0/16" });
    await expect(be.firewallPost("datacenter", "aliases", { name: "office", cidr: "10.2.0.0/16" })).rejects.toThrow(/already/);
    await be.firewallPost("datacenter", "ipsets/management/entries", { cidr: "10.9.9.9" });
    expect((await be.firewallGet<{ entries: unknown[] }>("datacenter", "ipsets", "management")).entries).toHaveLength(2);
    await be.firewallPost("datacenter", "ipsets/management/entries/10.9.9.9/delete");
    expect((await be.firewallGet<{ entries: unknown[] }>("datacenter", "ipsets", "management")).entries).toHaveLength(1);
  });
});

describe("demo DNS, hosts and SDN", () => {
  it("saves DNS and refuses stale hosts edits", async () => {
    const be = b();
    await be.setDns("home.lan", ["10.0.0.1"]);
    expect(await be.dns()).toEqual({ search: "home.lan", servers: ["10.0.0.1"] });
    const h = await be.hosts();
    await be.setHosts(`${h.data}10.0.0.9 nas\n`, h.digest);
    await expect(be.setHosts("x", h.digest)).rejects.toThrow(/modified/);
  });

  it("stages SDN changes until applied", async () => {
    const be = b();
    await be.sdnPost("zones", { zone: "orgs", type: "simple", dhcp: true });
    await be.sdnPost("vnets", { vnet: "northw", zone: "orgs", alias: "Northwind" });
    await be.sdnPost("vnets/northw/subnets", { cidr: "10.20.0.0/24", gateway: "10.20.0.1", snat: true, dhcpStart: "10.20.0.100", dhcpEnd: "10.20.0.200" });
    let s = await be.sdn();
    expect(s.pending).toBe(3);
    expect(s.vnets[0].subnets[0]).toMatchObject({ cidr: "10.20.0.0/24", snat: true, state: "new" });
    await expect(be.sdnPost("zones/orgs/delete")).rejects.toThrow(/used by a vnet/);
    const { task } = await be.sdnPost("apply");
    await wait(1700);
    expect((await be.task(task!)).exitstatus).toBe("OK");
    s = await be.sdn();
    expect(s.pending).toBe(0);
    expect(s.zones[0].state).toBeNull();
  }, 6000);
});
