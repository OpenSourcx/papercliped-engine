import { describe, expect, it } from "vitest";
import { demoData, demoHost } from "../src/data/demo.ts";
import { orgNameError } from "../src/data/store.tsx";
import { draftRule, suggestSize, think } from "../src/pin/brain.ts";

const ctx = (mode: "assistant" | "agent" = "assistant") => ({ host: demoHost("pve"), data: demoData("BEHIVE"), mode, device: "pve" });

describe("Pin turns sentences into validated automations", () => {
  it("drafts the memory example and reads it back", () => {
    const r = draftRule("If a container uses more than 50% of its memory, shut it down");
    expect(r?.ok).toBe(true);
    if (r?.ok) {
      expect(r.rule).toMatchObject({ when: { metric: "memory_percent", op: ">", value: 50, forSeconds: 60 }, scope: { guestType: "lxc" }, then: { action: "shutdown" }, createdBy: "pin" });
      expect(r.readBack).toBe("If a container uses more than 50% of its memory for 60 seconds, shut it down.");
    }
  });

  it("understands VMs, CPU, durations and notify", () => {
    const r = draftRule("If a VM uses more than 80% CPU for 5 minutes, notify me");
    expect(r?.ok && r.rule).toMatchObject({ when: { metric: "cpu_percent", value: 80, forSeconds: 300 }, scope: { guestType: "qemu" }, then: { action: "notify" } });
  });

  it("refuses rules the validator rejects instead of guessing", () => {
    const r = draftRule("If a container uses more than 150% of its memory, shut it down");
    expect(r?.ok).toBe(false);
    expect(draftRule("Delete everything")).toBeNull();
  });

  it("answers in the right voice for the mode", () => {
    const s = "If a container uses more than 50% of its memory, shut it down";
    expect(think(s, ctx("assistant")).text).toMatch(/ask you before acting/);
    expect(think(s, ctx("agent")).text).toMatch(/act right away/);
  });

  it("proposes an org sized from what is free, never more than the host has", () => {
    const reply = think("Create a company called Lumen", ctx());
    expect(reply.card?.type).toBe("org");
    const size = suggestSize(demoHost("pve"), demoData("BEHIVE"));
    expect(size.cores).toBeGreaterThanOrEqual(1);
    expect(size.cores).toBeLessThanOrEqual(8);
    expect(size.memoryMb).toBeLessThanOrEqual(8192);
  });
});

describe("org names and routing", () => {
  it("keeps system page names free so /<device>/<org> never collides", () => {
    expect(orgNameError("Home", [])).toMatch(/reserved/);
    expect(orgNameError("Access", [])).toMatch(/reserved/);
    expect(orgNameError("!!!", [])).toMatch(/letter or number/);
    expect(orgNameError("BEHIVE", demoData("BEHIVE").orgs)).toMatch(/already exists/);
    expect(orgNameError("Lumen", demoData("BEHIVE").orgs)).toBeNull();
  });
});

describe("Papercliped, native", () => {
  it("points app connection requests at Connected apps", () => {
    const r = think("How do I connect Claude?", ctx());
    expect(r.text).toMatch(/built into this device/);
    expect(r.card).toEqual({ type: "link", label: "Open connected apps", to: "?settings=apps" });
  });

  it("reserves the apps route", () => {
    expect(orgNameError("Apps", [])).toMatch(/reserved/);
  });
});
