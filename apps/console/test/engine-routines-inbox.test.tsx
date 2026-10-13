// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

vi.mock("../src/auth/session.tsx", () => ({
  useSession: () => ({ session: { mode: "live", user: { username: "ana@pve", name: "Ana", realm: "pve", node: "pve" } }, signOut: async () => {} }),
}));

import { callsTo, issue, renderOrg, setup, state } from "./engine-harness.tsx";

beforeEach(setup);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const routine = (over: object = {}) => ({
  id: "r1", companyId: "c1", title: "Daily standup", description: "Summarise yesterday.", assigneeAgentId: "a1", priority: "medium", status: "active", projectId: null,
  latestRevisionNumber: 2, lastTriggeredAt: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  triggers: [{ id: "t1", kind: "schedule", label: "Weekdays", enabled: true, cronExpression: "0 9 * * 1-5", timezone: "UTC", nextRunAt: null, lastFiredAt: null, lastResult: null }],
  lastRun: null, activeIssue: null, ...over,
});

describe("routines", () => {
  it("lists them with their schedule, runs one now and pauses another", async () => {
    let status = "active";
    state.routes["GET /engine/api/companies/c1/routines"] = () => [200, [routine({ status })]];
    state.routes["POST /engine/api/routines/r1/run"] = () => [202, { id: "run1", status: "issue_created" }];
    state.routes["PATCH /engine/api/routines/r1"] = (b) => { status = (b as { status: string }).status; return [200, routine({ status })]; };
    renderOrg("/pve/acme/routines");
    expect(await screen.findByText("Daily standup")).toBeTruthy();
    expect(screen.getByText(/Weekdays at 9:00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Run now/ }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/routines/r1/run")).toHaveLength(1));
    expect(callsTo("POST", "/engine/api/routines/r1/run")[0].headers["X-EPC-Request"]).toBe("1");
    fireEvent.click(screen.getByRole("switch", { name: "Pause Daily standup" }));
    await waitFor(() => expect(callsTo("PATCH", "/engine/api/routines/r1")[0]?.body).toEqual({ status: "paused" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Daily standup" })).toBeTruthy());
  });

  it("creates one with a schedule: the routine first, then its schedule trigger", async () => {
    state.routes["GET /engine/api/companies/c1/routines"] = () => [200, []];
    state.routes["POST /engine/api/companies/c1/routines"] = () => [201, routine({ id: "r9", title: "Weekly report" })];
    state.routes["POST /engine/api/routines/r9/triggers"] = () => [201, { trigger: { id: "t9", kind: "schedule" }, secretMaterial: null }];
    state.routes["GET /engine/api/routines/r9"] = () => [200, { ...routine({ id: "r9", title: "Weekly report" }), project: null, assignee: null, parentIssue: null, recentRuns: [] }];
    state.routes["GET /engine/api/routines/r9/runs"] = () => [200, []];
    renderOrg("/pve/acme/routines");
    fireEvent.click((await screen.findAllByRole("button", { name: /New routine/ }))[0]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekly report" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Write it." } });
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "a2" } });
    fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "weekly" } });
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/routines/r9/triggers")).toHaveLength(1));
    expect(callsTo("POST", "/engine/api/companies/c1/routines")[0].body).toEqual({ title: "Weekly report", description: "Write it.", assigneeAgentId: "a2", priority: "medium" });
    expect(callsTo("POST", "/engine/api/routines/r9/triggers")[0].body).toMatchObject({ kind: "schedule", cronExpression: "0 9 * * 1" });
    expect(await screen.findByRole("heading", { name: "Weekly report" })).toBeTruthy();
  });

  it("shows a webhook's secret once, after rotating it, and never in the list", async () => {
    const hook = { id: "t2", kind: "webhook", label: "Deploy hook", enabled: true, cronExpression: null, timezone: null, nextRunAt: null, lastFiredAt: null, publicId: "pub1", webhookUrl: "http://engine/hook", archived: false };
    state.routes["GET /engine/api/routines/r1"] = () => [200, { ...routine(), project: null, assignee: { id: "a1", name: "Forge" }, parentIssue: null, recentRuns: [], triggers: [hook] }];
    state.routes["GET /engine/api/routines/r1/runs"] = () => [200, [{ id: "run1", status: "failed", source: "manual", failureReason: "Agent was paused", triggeredAt: "2026-10-01T00:00:00Z", linkedIssue: null, trigger: null }]];
    state.routes["POST /engine/api/routine-triggers/t2/rotate-secret"] = () => [200, { trigger: hook, secretMaterial: { webhookUrl: "http://engine/hook", webhookSecret: "s3cret-value-123" } }];
    renderOrg("/pve/acme/routines/r1");
    expect(await screen.findByText(/Agent was paused/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("s3cret-value-123");
    fireEvent.click(screen.getByRole("button", { name: /Rotate secret/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/shown once/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Webhook secret") as HTMLInputElement).value).toBe("s3cret-value-123");
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.body.textContent).not.toContain("s3cret-value-123"));
  });

  it("shows a past revision's contents and restores it", async () => {
    const rev = (n: number, title: string) => ({ id: `rev${n}`, revisionNumber: n, title, changeSummary: `Change ${n}`, createdAt: "2026-10-01T00:00:00Z", snapshot: { routine: { title, status: "active", priority: "medium", description: `Text ${n}` }, triggers: [] } });
    state.routes["GET /engine/api/routines/r1"] = () => [200, { ...routine(), project: null, assignee: null, parentIssue: null, recentRuns: [], triggers: [] }];
    state.routes["GET /engine/api/routines/r1/runs"] = () => [200, []];
    state.routes["GET /engine/api/routines/r1/revisions"] = () => [200, [rev(1, "Old name"), rev(2, "Daily standup")]];
    state.routes["POST /engine/api/routines/r1/revisions/rev1/restore"] = () => [200, {}];
    renderOrg("/pve/acme/routines/r1");
    fireEvent.click(await screen.findByRole("button", { name: /Revisions/ }));
    fireEvent.click(await screen.findByText(/Change 1/));
    expect(await screen.findByText("Text 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/routines/r1/revisions/rev1/restore")).toHaveLength(1));
  });
});

const approvalItem = (over: object = {}) => ({
  id: "approval:ap1", companyId: "c1", sourceKind: "approval", subject: { kind: "approval", id: "ap1", title: "Buy more CPU", identifier: null, status: "pending" },
  whyNow: "Approval is pending a board decision.", severity: "medium", createdAt: "2026-10-01T00:00:00Z", dismissalKey: "attention:approval:ap1", dismissal: null, relatedIssue: null, originAgentName: "Forge",
  detail: { kind: "approval", approvalType: "request_board_approval", summaryExcerpt: "We need budget", images: [] }, ...over,
});
const feed = (items: object[]) => ({ companyId: "c1", generatedAt: "2026-10-01T00:00:00Z", totalCount: items.length, deskBadgeCount: items.length, nextCursor: null, countsBySourceKind: { approval: items.length }, items });

describe("the inbox", () => {
  it("lets you approve with a note, reject, ask for changes and dismiss without leaving the page", async () => {
    let items = [approvalItem()];
    state.routes["GET /engine/api/companies/c1/attention"] = () => [200, feed(items)];
    state.routes["GET /engine/api/companies/c1/approvals"] = () => [200, []];
    state.routes["POST /engine/api/approvals/ap1/approve"] = (b) => { items = []; return [200, { id: "ap1", status: "approved", ...(b as object) }]; };
    state.routes["POST /engine/api/approvals/ap1/request-revision"] = () => [200, {}];
    state.routes["POST /engine/api/companies/c1/inbox-dismissals"] = () => [201, {}];
    renderOrg("/pve/acme/inbox");
    expect(await screen.findByText("Buy more CPU")).toBeTruthy();
    expect(screen.getByText("We need budget")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Note for Buy more CPU"), { target: { value: "Go ahead" } });
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/approvals/ap1/request-revision")[0]?.body).toEqual({ decisionNote: "Go ahead" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/companies/c1/inbox-dismissals")[0]?.body).toEqual({ itemKey: "attention:approval:ap1" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/approvals/ap1/approve")[0]?.body).toEqual({ decisionNote: "Go ahead" }));
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  });

  it("answers an agent's question in place with the option the person picked", async () => {
    const q = approvalItem({ id: "interaction:i1", sourceKind: "issue_thread_interaction", subject: { kind: "interaction", id: "x1", title: "Which database?" }, relatedIssue: { kind: "issue", id: "i1", title: "Pick a database", identifier: "ACME-1" }, detail: { kind: "questions", questionCount: 1, firstQuestionText: "Which database?", images: [] }, dismissalKey: "attention:interaction:x1" });
    state.routes["GET /engine/api/companies/c1/attention"] = () => [200, feed([q])];
    state.routes["GET /engine/api/issues/i1/interactions"] = () => [200, [{ id: "x1", kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [{ id: "q1", prompt: "Which database?", selectionMode: "single", options: [{ id: "pg", label: "Postgres" }, { id: "my", label: "MySQL" }] }] } }]];
    state.routes["POST /engine/api/issues/i1/interactions/x1/respond"] = () => [200, {}];
    renderOrg("/pve/acme/inbox");
    fireEvent.click(await screen.findByLabelText("Postgres"));
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/issues/i1/interactions/x1/respond")[0]?.body).toEqual({ answers: [{ questionId: "q1", optionIds: ["pg"], otherText: null }] }));
  });

  it("marks assigned and mentioned tasks read, and says which are unread", async () => {
    state.routes["GET /engine/api/companies/c1/issues"] = (_b, url) => [200, url.searchParams.get("touchedByUserId") ? [issue("i1", 1, "Review the plan", "in_review", { isUnreadForMe: true, assigneeUserId: "u1" }), issue("i2", 2, "Old thing", "done", { isUnreadForMe: false })] : []];
    state.routes["POST /engine/api/issues/i1/read"] = () => [200, {}];
    renderOrg("/pve/acme/inbox");
    fireEvent.click(await screen.findByText(/Assigned and mentioned/));
    expect(await screen.findByText("Review the plan")).toBeTruthy();
    expect(screen.getAllByLabelText("Unread")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/issues/i1/read")).toHaveLength(1));
    expect(state.calls.find((c) => c.path === "/engine/api/companies/c1/issues" && c.search.includes("touchedByUserId=me"))).toBeTruthy();
  });

  it("decisions keeps a history of what was decided, with the note", async () => {
    state.routes["GET /engine/api/companies/c1/approvals"] = () => [200, [{ id: "ap2", type: "hire_agent", status: "approved", payload: { name: "Quinn", role: "designer" }, requestedByAgentId: "a1", requestedByUserId: null, decisionNote: "Welcome", createdAt: "2026-10-01T00:00:00Z" }]];
    renderOrg("/pve/acme/decisions");
    fireEvent.click(await screen.findByText("History"));
    expect(await screen.findByText("Hire Quinn (designer)")).toBeTruthy();
    expect(screen.getByText(/Welcome/)).toBeTruthy();
  });

  it("names who is being hired, since the engine's feed only says \"hire agent\"", async () => {
    const hire = (n: number, name: string) => approvalItem({ id: `approval:ap${n}`, subject: { kind: "approval", id: `ap${n}`, title: "hire agent", identifier: null, status: "pending" }, dismissalKey: `attention:approval:ap${n}`, detail: { kind: "approval", approvalType: "hire_agent", images: [] }, originAgentName: null, _name: name });
    state.routes["GET /engine/api/companies/c1/attention"] = () => [200, feed([hire(1, "Probe One"), hire(2, "Probe Two")])];
    state.routes["GET /engine/api/companies/c1/approvals"] = () => [200, [
      { id: "ap1", type: "hire_agent", status: "pending", payload: { name: "Probe One", role: "qa" }, requestedByAgentId: null, requestedByUserId: "u1", createdAt: "2026-10-01T00:00:00Z" },
      { id: "ap2", type: "hire_agent", status: "pending", payload: { name: "Probe Two", role: "researcher" }, requestedByAgentId: null, requestedByUserId: "u1", createdAt: "2026-10-01T00:00:00Z" },
    ]];
    renderOrg("/pve/acme/inbox");
    expect(await screen.findByText("Hire Probe One (qa)")).toBeTruthy();
    expect(screen.getByText("Hire Probe Two (researcher)")).toBeTruthy();
    expect(screen.getByLabelText("Note for Hire Probe Two (researcher)")).toBeTruthy();
  });
});
