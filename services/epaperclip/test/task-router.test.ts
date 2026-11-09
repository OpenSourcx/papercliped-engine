import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeJevAsk } from "@papercliped-engine/task-router";
import { setJevSettings } from "../src/features/task-router.ts";
import { createJevSettings, stateJevPorts } from "../src/task-router-jev.ts";
import { startConnectApp, type ConnectApp } from "./fakes-connect.ts";

let h: ConnectApp;
let asked: string[];
beforeEach(async () => {
  h = await startConnectApp();
  asked = [];
  // A fake Jev: no network. Tests check tiers, never probabilities.
  setJevSettings(h.state, createJevSettings({ ...stateJevPorts(h.state), ask: (key) => async (st, q) => { asked.push(key); return fakeJevAsk(0.02, "one_file", 0.95)(st, q); } }));
});
afterEach(() => h.closeAll());

const j = async (r: Response) => (await r.json()) as any;
const U = (co: string, p: string) => `/api/task-router/orgs/${co}/${p}`;
const KEY = "tsk_test_ABCDEFGH12345678";
const task = { goal: "Fix the label helper", filesAllowed: ["src/label.ts"], testCommand: "pnpm test" };

async function turnOn(co = "co_1") {
  expect((await h.call("PUT", U(co, "jev/key"), { cookie: h.sam }, { apiKey: KEY })).status).toBe(200);
  expect((await h.call("PUT", U(co, "jev"), { cookie: h.sam }, { consentSendTaskText: true })).status).toBe(200);
  return h.call("PUT", U(co, "jev"), { cookie: h.sam }, { enabled: true });
}

describe("Jev switch for an organization", () => {
  it("is off by default, readable by members, and says what is sent", async () => {
    const r = await j(await h.call("GET", U("co_1", "jev"), { cookie: h.lee }));
    expect(r).toMatchObject({ enabled: false, hasKey: false, active: false });
    expect(r.disclosure).toMatch(/sent to TypeSafe/);
    expect(r.disclosure).toMatch(/Nothing else is sent/);
  });
  it("is closed to people outside the organization", async () => {
    expect((await h.call("GET", U("co_2", "jev"), { cookie: h.lee })).status).toBe(403);
  });
  it("lets only owners and admins change it", async () => {
    for (const [m, p, b] of [["PUT", "jev/key", { apiKey: KEY }], ["PUT", "jev", { enabled: true }], ["DELETE", "jev/key", undefined], ["PUT", "table", { table: {} }]] as const)
      expect((await h.call(m, U("co_1", p), { cookie: h.lee }, b)).status, `${m} ${p}`).toBe(403);
  });
  it("needs a key and an explicit consent before it can be switched on", async () => {
    expect((await h.call("PUT", U("co_1", "jev"), { cookie: h.sam }, { enabled: true })).status).toBe(409);
    await h.call("PUT", U("co_1", "jev/key"), { cookie: h.sam }, { apiKey: KEY });
    expect((await h.call("PUT", U("co_1", "jev"), { cookie: h.sam }, { enabled: true })).status).toBe(409);
    const on = await turnOn();
    expect(await j(on)).toMatchObject({ enabled: true, hasKey: true, active: true });
  });
  it("seals the key in the vault: never returned, never in settings, never in the audit log", async () => {
    const on = await turnOn();
    expect(JSON.stringify(await j(on))).not.toContain(KEY);
    expect(JSON.stringify(h.state.getSetting("task-router-jev:co_1"))).not.toContain(KEY);
    expect(h.state.getSecret("task-router-typesafe:co_1")).toBe(KEY);
    const audit = JSON.stringify(await j(await h.call("GET", "/api/access/audit", { cookie: h.sam })));
    expect(audit).toContain("task-router.jev.on");
    expect(audit).not.toContain(KEY);
  });
  it("rejects a key that is obviously wrong", async () => {
    expect((await h.call("PUT", U("co_1", "jev/key"), { cookie: h.sam }, { apiKey: "x" })).status).toBe(400);
  });
  it("removing the key deletes it and switches Jev off", async () => {
    await turnOn();
    const r = await j(await h.call("DELETE", U("co_1", "jev/key"), { cookie: h.sam }));
    expect(r).toMatchObject({ hasKey: false, enabled: false });
    expect(h.state.getSecret("task-router-typesafe:co_1")).toBeNull();
  });
  it("tests the key with fixed text, and keeps organizations apart", async () => {
    await h.call("PUT", U("co_1", "jev/key"), { cookie: h.sam }, { apiKey: KEY });
    expect(await j(await h.call("POST", U("co_1", "jev/test"), { cookie: h.sam }))).toEqual({ ok: true });
    expect((await h.call("POST", U("co_2", "jev/test"), { cookie: h.sam })).status).toBe(409); // co_2 has no key
  });
});

describe("routing a task", () => {
  it("uses the rules when Jev is off, and sends nothing", async () => {
    const d = (await j(await h.call("POST", U("co_1", "route"), { cookie: h.lee }, { ...task, expectedDiffLines: 5 }))).decision;
    expect(d).toMatchObject({ tier: "local-small", source: "rules" });
    expect(asked).toEqual([]);
  });
  it("uses Jev when the organization turned it on, with that organization's key only", async () => {
    await turnOn("co_1");
    const d = (await j(await h.call("POST", U("co_1", "route"), { cookie: h.lee }, task))).decision; // no size: rules alone would say free-cloud
    expect(d).toMatchObject({ tier: "local-small", source: "jev" });
    expect(asked).toEqual([KEY]);
    const other = (await j(await h.call("POST", U("co_2", "route"), { cookie: h.sam }, task))).decision;
    expect(other.source).toBe("rules");
    expect(asked.length).toBe(1);
  });
  it("never sends a risky task to Jev", async () => {
    await turnOn();
    const d = (await j(await h.call("POST", U("co_1", "route"), { cookie: h.sam }, { ...task, riskTags: ["billing"] }))).decision;
    expect(d.tier).toBe("claude");
    expect(asked).toEqual([]);
  });
  it("validates the task", async () => {
    for (const bad of [{}, { goal: "x", filesAllowed: "a" }, { goal: "x", filesAllowed: [], expectedDiffLines: -1 }, { goal: "x", filesAllowed: [], riskTags: [5] }])
      expect((await h.call("POST", U("co_1", "route"), { cookie: h.sam }, bad)).status).toBe(400);
  });
  it("lets an organization set and read its own routing table, and rejects a bad one", async () => {
    const table = { targets: { claude: { adapterType: "claude_local", model: "mine" } }, chain: ["claude"] };
    expect(await j(await h.call("GET", U("co_1", "table"), { cookie: h.lee }))).toMatchObject({ isDefault: true });
    expect((await h.call("PUT", U("co_1", "table"), { cookie: h.sam }, { table: { chain: [] } })).status).toBe(400);
    expect((await h.call("PUT", U("co_1", "table"), { cookie: h.sam }, { table })).status).toBe(200);
    const d = (await j(await h.call("POST", U("co_1", "route"), { cookie: h.sam }, task))).decision;
    expect(d.target).toEqual({ adapterType: "claude_local", model: "mine" });
    expect((await j(await h.call("POST", U("co_2", "route"), { cookie: h.sam }, task))).decision.target.model).not.toBe("mine");
  });
});
