import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeJevAsk } from "@papercliped-engine/task-router";
import { chooseAgent, describeTask, titleOf } from "../src/task-router-assign.ts";
import { setJevSettings } from "../src/features/task-router.ts";
import { createJevSettings, getDecision, listDecisions, stateJevPorts, saveTierAgents } from "../src/task-router-jev.ts";
import { startConnectApp, type ConnectApp } from "./fakes-connect.ts";

let h: ConnectApp;
let asked: { key: string; state: unknown }[];

beforeEach(async () => {
  h = await startConnectApp();
  asked = [];
  // The fake engine's organization agent: it runs the adapter the default local tiers use.
  h.eng.st.agents.set("co_1", [
    { id: "ag1", name: "Builder", role: "engineer", status: "idle", companyId: "co_1", adapterType: "opencode_local", defaultEnvironmentId: "env_local" },
  ]);
  // A fake Jev: no network. Tests check tiers and payloads, never probabilities.
  setJevSettings(h.state, createJevSettings({
    ...stateJevPorts(h.state),
    ask: (key) => async (st, q) => { asked.push({ key, state: st }); return fakeJevAsk(0.02, "one_file", 0.95)(st, q); },
  }));
});
afterEach(async () => {
  delete process.env.TYPESAFE_API_KEY;
  await h.closeAll();
});

const j = async (r: Response) => (await r.json()) as any;
const U = (co: string, p: string) => `/api/task-router/orgs/${co}/${p}`;
const KEY = "tsk_test_ABCDEFGH12345678";
const task = { goal: "Fix the label helper", filesAllowed: ["src/label.ts"], testCommand: "pnpm test" };

async function turnOn(co = "co_1") {
  expect((await h.call("PUT", U(co, "jev/key"), { cookie: h.sam }, { apiKey: KEY })).status).toBe(200);
  expect((await h.call("PUT", U(co, "jev"), { cookie: h.sam }, { consentSendTaskText: true })).status).toBe(200);
  expect((await h.call("PUT", U(co, "jev"), { cookie: h.sam }, { enabled: true })).status).toBe(200);
}

describe("task assignment through the engine", () => {
  it("creates the engine task for the selected adapter and keeps the decision", async () => {
    const r = await h.call("POST", U("co_1", "assign"), { cookie: h.lee }, { ...task, expectedDiffLines: 5 });
    expect(r.status).toBe(200);
    const body = await j(r);
    expect(body.decision).toMatchObject({ tier: "local-small", source: "rules" });
    expect(body.delegation).toMatchObject({ status: "assigned", agentId: "ag1", agentName: "Builder", adapterType: "opencode_local", environmentId: "env_local" });
    expect(typeof body.issueId).toBe("string");
    expect(asked).toEqual([]); // Jev is off: nothing left the host.

    const issue = h.overlay.issues.get(body.issueId)!;
    expect(issue).toMatchObject({ companyId: "co_1", title: "Fix the label helper", assigneeAgentId: "ag1", status: "todo" });
    expect(String(issue.description)).toContain("Files allowed: src/label.ts");
    expect(String(issue.description)).toContain("Expected change: 5 lines");

    // The same decision is readable by a member, with the task it was made for and the issue it created.
    const one = getDecision(h.state, "co_1", body.recordId)!;
    expect(one).toMatchObject({ id: body.recordId, companyId: "co_1", issueId: body.issueId, agentId: "ag1", delegationStatus: "assigned" });
    const listed = await j(await h.call("GET", U("co_1", "decisions"), { cookie: h.lee }));
    expect(listed.decisions).toHaveLength(1);
    expect(listed.decisions[0]).toMatchObject({ id: body.recordId, task: { goal: task.goal }, decision: { tier: "local-small" } });
    const read = await j(await h.call("GET", U("co_1", `decisions/${body.recordId}`), { cookie: h.lee }));
    expect(read.decision.id).toBe(body.recordId);
  });

  it("sends only the task facts to Jev, and only when the organization consented", async () => {
    await turnOn();
    const r = await h.call("POST", U("co_1", "assign"), { cookie: h.lee }, task); // no size: rules alone would say free-cloud
    const body = await j(r);
    expect(body.decision).toMatchObject({ tier: "local-small", source: "jev" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.key).toBe(KEY);
    // Goal text, file paths and size only: no test command, no risk tags, no file contents.
    expect(asked[0]!.state).toEqual({ goal: task.goal, files_allowed: task.filesAllowed });
  });

  it("uses the same rules when TypeSafe is unreachable, and says so in the kept decision", async () => {
    setJevSettings(h.state, createJevSettings({
      ...stateJevPorts(h.state),
      ask: () => async () => { throw new Error("TypeSafe unreachable"); },
    }));
    await turnOn();
    const body = await j(await h.call("POST", U("co_1", "assign"), { cookie: h.lee }, { ...task, expectedDiffLines: 5 }));
    expect(body.decision).toMatchObject({ tier: "local-small", source: "rules-fallback" });
    expect(body.decision.jevError).toMatch(/unreachable/);
    expect(body.delegation.status).toBe("assigned");
    expect(getDecision(h.state, "co_1", body.recordId)!.decision).toMatchObject({ source: "rules-fallback", tier: "local-small" });
  });

  it("does not send task text without explicit consent, even when a key and an internal dev env key exist", async () => {
    // A settings record that is switched on but has no consent (as a half-finished change, or an internal setup, could leave).
    h.state.setSecret("task-router-typesafe:co_1", KEY);
    h.state.setSetting("task-router-jev:co_1", { enabled: true, secretId: "task-router-typesafe:co_1", consentSendTaskText: false });
    // Internal dev use is not the customer's consent: the host never reads this environment variable when routing.
    process.env.TYPESAFE_API_KEY = "tsk_internal_dev_key";
    const body = await j(await h.call("POST", U("co_1", "assign"), { cookie: h.lee }, { ...task, expectedDiffLines: 5 }));
    expect(body.decision).toMatchObject({ tier: "local-small", source: "rules" });
    expect(asked).toEqual([]);
  });

  it("never sends a high-risk task, and escalates it to Claude rather than a cheap agent", async () => {
    await turnOn();
    const before = h.overlay.issues.size;
    const r = await h.call("POST", U("co_1", "assign"), { cookie: h.sam }, { ...task, expectedDiffLines: 5, riskTags: ["proxmox"] });
    const body = await j(r);
    expect(body.decision).toMatchObject({ tier: "claude", source: "rules" });
    expect(asked).toEqual([]);
    expect(body.delegation).toMatchObject({ status: "unassigned", adapterType: "claude_local" });
    expect(body.delegation.reason).toMatch(/claude_local/);
    expect(getDecision(h.state, "co_1", body.recordId)).toMatchObject({ delegationStatus: "unassigned", delegationReason: expect.stringMatching(/claude_local/) });
    expect(h.overlay.issues.size).toBe(before); // no cheap agent was given the risky task

    // With an agent that runs the strong adapter, the same task is delegated to it.
    h.eng.st.agents.set("co_1", [
      { id: "ag1", name: "Builder", role: "engineer", status: "idle", companyId: "co_1", adapterType: "opencode_local", defaultEnvironmentId: "env_local" },
      { id: "ag2", name: "Reviewer", role: "security", status: "idle", companyId: "co_1", adapterType: "claude_local", defaultEnvironmentId: "env_claude" },
    ]);
    const strong = await j(await h.call("POST", U("co_1", "assign"), { cookie: h.sam }, { ...task, expectedDiffLines: 5, riskTags: ["auth"] }));
    expect(strong.decision.tier).toBe("claude");
    expect(strong.delegation).toMatchObject({ status: "assigned", agentId: "ag2", adapterType: "claude_local", environmentId: "env_claude" });
    expect(h.overlay.issues.get(strong.issueId)).toMatchObject({ assigneeAgentId: "ag2" });
  });

  it("escalates the same task up the chain and records each step", async () => {
    h.eng.st.agents.set("co_1", [
      { id: "ag1", name: "Builder", role: "engineer", status: "idle", companyId: "co_1", adapterType: "opencode_local", defaultEnvironmentId: "env_local" },
      { id: "ag2", name: "Reviewer", role: "security", status: "idle", companyId: "co_1", adapterType: "claude_local", defaultEnvironmentId: "env_claude" },
    ]);
    const first = await j(await h.call("POST", U("co_1", "assign"), { cookie: h.lee }, { ...task, expectedDiffLines: 5 }));
    expect(first.decision.tier).toBe("local-small");

    const up1 = await j(await h.call("POST", U("co_1", `decisions/${first.recordId}/report`), { cookie: h.lee }, { status: "escalate", note: "tests still fail" }));
    expect(up1.decision).toMatchObject({ tier: "free-cloud" });
    expect(up1.delegation).toMatchObject({ status: "assigned", agentId: "ag1" });
    expect(up1.previous.escalation).toMatchObject({ status: "escalate", note: "tests still fail" });

    const up2 = await j(await h.call("POST", U("co_1", `decisions/${up1.recordId}/report`), { cookie: h.lee }, { status: "escalate" }));
    expect(up2.decision).toMatchObject({ tier: "claude" });
    expect(up2.delegation).toMatchObject({ status: "assigned", agentId: "ag2" });
    expect(h.overlay.issues.get(first.issueId)).toMatchObject({ assigneeAgentId: "ag2" }); // the same task moved

    const chain = listDecisions(h.state, "co_1", 10);
    expect(chain.map((d) => d.decision.tier)).toEqual(["claude", "free-cloud", "local-small"]);
    expect(chain[0]!.previousId).toBe(chain[1]!.id);
    expect(chain[1]!.previousId).toBe(chain[2]!.id);
    expect(chain[0]!.issueId).toBe(first.issueId);

    const done = await j(await h.call("POST", U("co_1", `decisions/${up2.recordId}/report`), { cookie: h.lee }, { status: "ok" }));
    expect(done.decision).toBeNull();
    expect(done.previous.escalation.status).toBe("ok");
    // Replaying a report does not move anything again or spend more.
    const replay = await j(await h.call("POST", U("co_1", `decisions/${up2.recordId}/report`), { cookie: h.lee }, { status: "escalate" }));
    expect(replay.decision).toBeNull();
    expect(listDecisions(h.state, "co_1", 10)).toHaveLength(3);
  });

  it("uses an explicit tier -> agent mapping, and keeps organizations apart", async () => {
    h.eng.st.agents.set("co_1", [
      { id: "ag1", name: "Builder", role: "engineer", status: "idle", companyId: "co_1", adapterType: "opencode_local", defaultEnvironmentId: "env_local" },
      { id: "ag2", name: "Reviewer", role: "security", status: "idle", companyId: "co_1", adapterType: "claude_local", defaultEnvironmentId: "env_claude" },
    ]);
    saveTierAgents(h.state, "co_1", { "local-small": "ag2" });
    const body = await j(await h.call("POST", U("co_1", "assign"), { cookie: h.lee }, { ...task, expectedDiffLines: 5 }));
    expect(body.decision.tier).toBe("local-small");
    expect(body.delegation.agentId).toBe("ag2"); // the mapping wins over adapter matching
    // The other organization has neither the mapping nor the agents.
    const other = await j(await h.call("POST", U("co_2", "assign"), { cookie: h.sam }, { ...task, expectedDiffLines: 5 }));
    expect(other.delegation.status).toBe("unassigned");
    expect(getDecision(h.state, "co_1", body.recordId)).toBeDefined();
    expect(getDecision(h.state, "co_2", body.recordId)).toBeUndefined();
  });

  it("validates a report, a bad mapping and a non-member", async () => {
    const first = await j(await h.call("POST", U("co_1", "assign"), { cookie: h.lee }, { ...task, expectedDiffLines: 5 }));
    expect((await h.call("POST", U("co_1", `decisions/${first.recordId}/report`), { cookie: h.lee }, { status: "maybe" })).status).toBe(400);
    expect((await h.call("PUT", U("co_1", "agents"), { cookie: h.sam }, { tierAgents: { gpu: "ag1" } })).status).toBe(400);
    expect((await h.call("PUT", U("co_1", "agents"), { cookie: h.lee }, { tierAgents: { "local-small": "ag1" } })).status).toBe(403);
    expect((await h.call("GET", U("co_2", "decisions"), { cookie: h.lee })).status).toBe(403);
    expect((await h.call("POST", U("co_1", "assign"), { cookie: h.sam }, { ...task, createIssue: "yes" })).status).toBe(400);
  });
});

describe("assignment helpers", () => {
  const agents = [
    { id: "b", name: "Beta", adapterType: "opencode_local", defaultEnvironmentId: "env_2" },
    { id: "a", name: "Alpha", adapterType: "opencode_local", defaultEnvironmentId: "env_1" },
  ];
  it("picks the target environment first, then name, and never a terminated agent", () => {
    expect(chooseAgent(agents, { adapterType: "opencode_local", environment: "env_2" }).agent?.id).toBe("b");
    expect(chooseAgent(agents, { adapterType: "opencode_local", environment: "none" }).agent?.id).toBe("a");
    expect(chooseAgent([...agents, { id: "c", name: "Aardvark", adapterType: "opencode_local", status: "terminated" }], { adapterType: "opencode_local" }).agent?.id).toBe("a");
  });
  it("follows an explicit mapping and explains a missing one", () => {
    expect(chooseAgent(agents, { adapterType: "claude_local" }, "b").agent?.id).toBe("b");
    expect(chooseAgent(agents, { adapterType: "claude_local" }, "gone").reason).toMatch(/no such active agent/);
    expect(chooseAgent(agents, { adapterType: "claude_local" }).reason).toMatch(/claude_local/);
  });
  it("builds a bounded issue title and description from the task facts", () => {
    expect(titleOf("\n\n  Fix   the label\nmore detail")).toBe("Fix the label");
    expect(titleOf("x".repeat(500))).toHaveLength(200);
    const d = describeTask({ goal: "Do it", filesAllowed: ["a.ts", "b.ts"], expectedDiffLines: 12, testCommand: "pnpm test", riskTags: ["auth"] });
    expect(d).toContain("Files allowed: a.ts, b.ts");
    expect(d).toContain("Expected change: 12 lines");
    expect(d).toContain("Test: pnpm test");
    expect(d).toContain("Risk tags: auth");
  });
});
