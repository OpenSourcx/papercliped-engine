// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route } from "react-router-dom";
import type { ReactNode } from "react";

vi.mock("../src/auth/session.tsx", () => ({
  useSession: () => ({ session: { mode: "live", user: { username: "ana@pve", name: "Ana", realm: "pve", node: "pve" } }, signOut: async () => {} }),
}));

import { EngineProvider } from "../src/data/store.tsx";
import { keysForEvent, tapEvents, applyEvent } from "../src/data/engine/events.ts";
import { qk } from "../src/data/engine/keys.ts";
import { useInboxCounts } from "../src/data/engine/more.ts";
import { chatBlock, chatDisabled } from "../src/data/engine/chat.ts";
import { EngineError } from "@papercliped-engine/engine-client";
import { previewKind } from "../src/pages/org/live/LiveArtifacts.tsx";
import { logText } from "../src/pages/org/live/LiveAgentTabs.tsx";
import { LiveMembers } from "../src/pages/org/live/LiveWork.tsx";
import { CommandPalette } from "../src/search/CommandPalette.tsx";
import { agent, callsTo, issue, renderOrg, setup, state } from "./engine-harness.tsx";

beforeEach(setup);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("chat", () => {
  it("says it is switched off, and lets an administrator turn it on", async () => {
    let on = false;
    state.routes["GET /engine/api/companies/c1/chats"] = () => (on ? [200, []] : [404, { error: "Agent Chat is disabled" }]);
    state.routes["PATCH /engine/api/instance/settings/experimental"] = () => { on = true; return [200, { enableAgentChat: true }]; };
    renderOrg("/pve/acme/chat");
    expect(await screen.findByText("Chat is switched off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on chat" }));
    await waitFor(() => expect(callsTo("PATCH", "/engine/api/instance/settings/experimental")[0]?.body).toEqual({ enableAgentChat: true }));
    expect(await screen.findByText("Pick an agent")).toBeTruthy();
  });

  it("opens the conversation on the first message and sends it with a request id", async () => {
    state.routes["GET /engine/api/companies/c1/chats"] = () => [200, []];
    state.routes["POST /engine/api/companies/c1/chats/a1"] = () => [200, issue("chat1", 1, "Chat with Forge", "in_review", { conversationAgentId: "a1" })];
    state.routes["POST /engine/api/issues/chat1/comments"] = () => [201, { id: "c1" }];
    renderOrg("/pve/acme/chat");
    fireEvent.click(await screen.findByRole("button", { name: /Forge/ }));
    fireEvent.change(screen.getByLabelText("Message Forge"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/issues/chat1/comments")).toHaveLength(1));
    const body = callsTo("POST", "/engine/api/issues/chat1/comments")[0].body as { body: string; clientRequestId: string };
    expect(body.body).toBe("Hello");
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows new messages when the live socket reports activity", async () => {
    let comments: { id: string; body: string; authorAgentId: string | null; authorUserId: string | null; createdAt: string }[] = [{ id: "m1", body: "Hi there", authorAgentId: null, authorUserId: "u1", createdAt: "2026-10-01T00:00:00Z" }];
    state.routes["GET /engine/api/companies/c1/chats"] = () => [200, [issue("chat1", 1, "Chat with Forge", "in_review", { conversationAgentId: "a1", conversationState: "waiting" })]];
    state.routes["GET /engine/api/issues/chat1/comments"] = () => [200, comments];
    renderOrg("/pve/acme/chat");
    fireEvent.click(await screen.findByRole("button", { name: /Forge/ }));
    expect(await screen.findByText("Hi there")).toBeTruthy();
    comments = [...comments, { id: "m2", body: "Hello back", authorAgentId: "a1", authorUserId: null, createdAt: "2026-10-01T00:01:00Z" }];
    const { FakeSocket } = await import("./engine-harness.tsx");
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    act(() => FakeSocket.all[0].emit({ companyId: "c1", type: "activity.logged", payload: { entityType: "issue", entityId: "chat1", action: "issue.comment_added" } }));
    expect(await screen.findByText("Hello back")).toBeTruthy();
  });

  it("says why an agent that cannot run cannot answer, instead of writing forever, and retries", async () => {
    state.routes["GET /engine/api/companies/c1/agents"] = () => [200, [agent("a1", "c1", "Forge", "idle")]];
    state.routes["GET /engine/api/companies/c1/chats"] = () => [200, [issue("chat1", 1, "Chat with Forge", "in_review", { conversationAgentId: "a1", conversationState: "active" })]];
    state.routes["GET /engine/api/issues/chat1/comments"] = () => [200, []];
    state.routes["GET /api/agent-containers"] = () => [200, { state: "missing", steps: [], pluginInstalled: false, environments: [], template: { exists: false }, token: { exists: false }, canManage: true, job: null }];
    state.routes["GET /engine/api/companies/c1/heartbeat-runs"] = () => [200, []];
    state.routes["POST /engine/api/agents/a1/wakeup"] = () => [202, {}];
    renderOrg("/pve/acme/chat");
    fireEvent.click(await screen.findByRole("button", { name: /Forge/ }));
    expect(await screen.findByText(/Forge can't run: no agent container is set up yet/)).toBeTruthy();
    expect(screen.getByText("Open Agent containers")).toBeTruthy();
    expect(screen.queryByText("Forge is writing")).toBeNull();
    // Fixed: containers are ready, so trying again wakes the agent and the notice goes.
    state.routes["GET /api/agent-containers"] = () => [200, { state: "ready", steps: [], pluginInstalled: true, environments: [], template: { exists: true }, token: { exists: true }, canManage: true, job: null }];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/agents/a1/wakeup")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/no agent container is set up yet/)).toBeNull());
    expect(await screen.findByText("Forge is writing")).toBeTruthy();
  });

  it("works out the reason from the agent and its last run", () => {
    const a = (status: string) => ({ name: "Runner", status });
    expect(chatBlock({ agent: a("idle") })).toBeNull();
    expect(chatBlock({ agent: a("running"), containersReady: true })).toBeNull();
    expect(chatBlock({ agent: a("error"), containersReady: true })?.code).toBe("error");
    expect(chatBlock({ agent: a("paused") })?.code).toBe("paused");
    expect(chatBlock({ agent: a("terminated") })?.code).toBe("terminated");
    expect(chatBlock({ agent: a("pending_approval") })?.code).toBe("pending");
    const none = chatBlock({ agent: a("idle"), containersReady: false, canManageContainers: false });
    expect(none?.code).toBe("containers");
    expect(none?.fix).toBeUndefined();
    expect(none?.todo).toMatch(/administrator/);
    expect(chatBlock({ agent: a("idle"), containersReady: false, canManageContainers: true })?.fix).toBe("agent-containers");
    const sandbox = chatBlock({ agent: a("idle"), run: { status: "failed", error: "Managed sandbox only: local execution is disabled" } });
    expect(sandbox?.code).toBe("no-sandbox");
    expect(chatBlock({ agent: a("idle"), run: { status: "failed", error: "adapter exited 2" }, conversationStartedAt: "2026-10-01T00:00:00Z", })?.code).toBe("run-failed");
    // A run that failed before this conversation began is not about it.
    expect(chatBlock({ agent: a("idle"), run: { status: "failed", error: "x", createdAt: "2026-09-01T00:00:00Z" }, conversationStartedAt: "2026-10-01T00:00:00Z" })).toBeNull();
    expect(chatBlock({ agent: a("idle"), run: { status: "succeeded" } })).toBeNull();
  });

  it("recognises the engine's 'disabled' answer", () => {
    expect(chatDisabled(new EngineError(404, "Agent Chat is disabled"))).toBe(true);
    expect(chatDisabled(new EngineError(500, "Agent Chat is disabled"))).toBe(false);
    expect(chatDisabled(new EngineError(404, "Agent not found"))).toBe(false);
  });
});

describe("costs and settings", () => {
  it("shows spend by project and provider, alerts, and saves a budget in cents through /budgets", async () => {
    state.routes["GET /engine/api/companies/c1/costs/summary"] = () => [200, { companyId: "c1", spendCents: 12500, budgetCents: 50000, utilizationPercent: 25 }];
    state.routes["GET /engine/api/companies/c1/costs/by-agent"] = () => [200, [{ agentId: "a1", agentName: "Forge", costCents: 12500, inputTokens: 10, outputTokens: 5, apiRunCount: 2, subscriptionRunCount: 0 }]];
    state.routes["GET /engine/api/companies/c1/costs/by-project"] = () => [200, [{ projectId: "p1", projectName: "Portal", costCents: 9000, inputTokens: 1, outputTokens: 1 }]];
    state.routes["GET /engine/api/companies/c1/costs/by-provider"] = () => [200, [{ provider: "anthropic", biller: "anthropic", billingType: "metered_api", model: "model-x", costCents: 12500, inputTokens: 1, outputTokens: 1 }]];
    state.routes["GET /engine/api/companies/c1/costs/by-agent-model"] = () => [200, []];
    state.routes["GET /engine/api/companies/c1/budgets/overview"] = () => [200, { companyId: "c1", policies: [{ policyId: "pol1", scopeType: "agent", scopeId: "a1", scopeName: "Forge", amount: 10000, observedAmount: 9000, utilizationPercent: 90, status: "warning", paused: false, isActive: true }], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 }];
    state.routes["PATCH /engine/api/companies/c1/budgets"] = () => [200, {}];
    renderOrg("/pve/acme/costs");
    expect((await screen.findAllByText("$125.00")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Forge is at 90% of its budget")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "By project" }));
    expect(await screen.findByText("Portal")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "By provider" }));
    expect(await screen.findByText("anthropic")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Monthly budget in dollars"), { target: { value: "750.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(callsTo("PATCH", "/engine/api/companies/c1/budgets")[0]?.body).toEqual({ budgetMonthlyCents: 75050 }));
  });

  it("saves a rename, and only archives after the name is typed", async () => {
    state.routes["PATCH /engine/api/companies/c1"] = () => [200, {}];
    state.routes["POST /engine/api/companies/c1/archive"] = () => [200, {}];
    renderOrg("/pve/acme/settings");
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Acme Labs" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(callsTo("PATCH", "/engine/api/companies/c1")[0]?.body).toEqual({ name: "Acme Labs" }));
    fireEvent.click(screen.getByRole("button", { name: /Archive organization/ }));
    const confirm = screen.getAllByRole("button", { name: "Archive organization" }).pop()!;
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type Acme Works to confirm"), { target: { value: "Acme Works" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(callsTo("POST", "/engine/api/companies/c1/archive")).toHaveLength(1));
  });

  it("points to Access for membership changes", async () => {
    renderOrg("/pve/acme/settings");
    const link = await screen.findByRole("link", { name: /Open Access/ });
    expect(link.getAttribute("href")).toBe("/pve/home?settings=access");
  });
});

describe("skills, artifacts and workspaces", () => {
  it("lists skills and shows a skill's file as plain text", async () => {
    const skill = { id: "s1", key: "acme/web", slug: "web", name: "web", description: "Browse", sourceBadge: "paperclip", sourceLabel: "Bundled", attachedAgentCount: 1, fileInventory: [{ path: "SKILL.md", kind: "skill" }], trustLevel: "markdown_only", editable: false, usedByAgents: [{ id: "a1", name: "Forge", desired: true }] };
    state.routes["GET /engine/api/companies/c1/skills"] = () => [200, [skill]];
    state.routes["GET /engine/api/companies/c1/skills/s1"] = () => [200, skill];
    state.routes["GET /engine/api/companies/c1/skills/s1/files"] = () => [200, { path: "SKILL.md", content: "# Web <script>alert(1)</script>", encoding: "utf8" }];
    state.routes["POST /engine/api/agents/a2/skills/sync"] = () => [200, {}];
    renderOrg("/pve/acme/skills");
    fireEvent.click(await screen.findByText("web"));
    expect(await screen.findByText(/# Web/)).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(await screen.findByRole("switch", { name: "Add web for Sage" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/agents/a2/skills/sync")[0]?.body).toEqual({ mode: "add", desiredSkills: ["acme/web"] }));
  });

  it("previews only what is safe: images in an image, text as text, everything else a download", () => {
    expect(previewKind("image/png", "image")).toBe("image");
    expect(previewKind("application/json; charset=utf-8", "text")).toBe("json");
    expect(previewKind("text/markdown", "text")).toBe("text");
    expect(previewKind("text/html", "text")).toBe("download");
    expect(previewKind("application/pdf", "document")).toBe("download");
    expect(previewKind("application/octet-stream", "file")).toBe("download");
  });

  it("previews a text artifact through the proxy and never renders engine markup", async () => {
    const art = { id: "work_product:w1", source: "work_product", mediaKind: "text", title: "Notes", previewText: "short", contentType: "text/plain", contentPath: "/api/attachments/at1/content", downloadPath: "/api/attachments/at1/content?download=1", issue: { id: "i1", identifier: "ACME-1", title: "Task" }, updatedAt: "2026-10-01T00:00:00Z" };
    const html = { ...art, id: "work_product:w2", title: "Page", contentType: "text/html", contentPath: "/api/attachments/at2/content", downloadPath: "/api/attachments/at2/content?download=1" };
    state.routes["GET /engine/api/companies/c1/artifacts"] = () => [200, { artifacts: [art, html], nextCursor: null }];
    state.routes["GET /engine/api/attachments/at1/content"] = () => [200, "<b>not bold</b> plain words"];
    renderOrg("/pve/acme/artifacts");
    fireEvent.click(await screen.findByText("Notes"));
    expect(await screen.findByText("<b>not bold</b> plain words")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(await screen.findByText("Page"));
    expect(await screen.findByText(/isn't previewed here/)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(callsTo("GET", "/engine/api/attachments/at2/content")).toHaveLength(0);
  });

  it("lists execution workspaces", async () => {
    state.routes["GET /engine/api/companies/c1/execution-workspaces"] = () => [200, [{ id: "w1", name: "feature-x", status: "active", providerType: "git_worktree", mode: "isolated_workspace", branchName: "feature-x", cwd: "/work/x", lastUsedAt: "2026-10-01T00:00:00Z" }]];
    renderOrg("/pve/acme/workspaces");
    expect((await screen.findAllByText("feature-x")).length).toBeGreaterThan(0);
    expect(screen.getByText("Active")).toBeTruthy();
  });
});

describe("the agent page", () => {
  const forge = () => agent("a1", "c1", "Forge", "idle", { adapterConfig: { command: "echo", env: { TOKEN: { type: "secret_ref", secretId: "sec1", version: "latest" } } } });
  beforeEach(() => {
    state.routes["GET /engine/api/agents/a1"] = () => [200, forge()];
    state.routes["GET /engine/api/companies/c1/heartbeat-runs"] = () => [200, []];
    state.routes["GET /engine/api/adapters"] = () => [200, [{ type: "process", label: "Process", source: "builtin", modelsCount: 0, loaded: true, disabled: false }]];
    state.routes["GET /engine/api/companies/c1/secrets"] = () => [200, [{ id: "sec1", name: "Service token", status: "active", provider: "local_encrypted" }]];
  });

  it("binds environment variables to secrets by reference, creating one through the engine without ever showing its value", async () => {
    state.routes["POST /engine/api/companies/c1/secrets"] = () => [201, { id: "sec2", name: "New key", status: "active" }];
    state.routes["PATCH /engine/api/agents/a1"] = () => [200, forge()];
    renderOrg("/pve/acme/agents/a1?tab=configuration");
    expect(await screen.findByText("Service token")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    const names = screen.getAllByLabelText("Variable name");
    fireEvent.change(names[1], { target: { value: "API_KEY" } });
    fireEvent.change(screen.getByLabelText("Secret for API_KEY"), { target: { value: "__new" } });
    fireEvent.change(await screen.findByLabelText("Name", { selector: "#sec-name" }), { target: { value: "New key" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "hunter2-very-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Create secret" }));
    await waitFor(() => expect(callsTo("POST", "/engine/api/companies/c1/secrets")[0]?.body).toEqual({ name: "New key", value: "hunter2-very-secret" }));
    await waitFor(() => expect((screen.getByLabelText("Secret for API_KEY") as HTMLSelectElement).value).toBe("sec2"));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(callsTo("PATCH", "/engine/api/agents/a1")).toHaveLength(1));
    const sent = callsTo("PATCH", "/engine/api/agents/a1")[0].body as { adapterConfig: { env: Record<string, unknown> } };
    expect(sent.adapterConfig.env).toEqual({ TOKEN: { type: "secret_ref", secretId: "sec1", version: "latest" }, API_KEY: { type: "secret_ref", secretId: "sec2", version: "latest" } });
    expect(document.body.textContent).not.toContain("hunter2-very-secret");
  });

  it("edits instructions against the revision that was read", async () => {
    state.routes["GET /engine/api/agents/a1/instructions-bundle"] = () => [200, { agentId: "a1", mode: "managed", entryFile: "AGENTS.md", editable: true, warnings: [], files: [{ path: "AGENTS.md", size: 5 }] }];
    state.routes["GET /engine/api/agents/a1/instructions-bundle/file"] = () => [200, { path: "AGENTS.md", content: "# Forge", revision: { id: "rev7" } }];
    state.routes["GET /engine/api/agents/a1/instructions-bundle/history"] = () => [200, { revisions: [{ id: "rev7", createdAt: "2026-10-01T00:00:00Z", source: "api", byteLength: 7 }], nextCursor: null }];
    state.routes["PUT /engine/api/agents/a1/instructions-bundle/file"] = () => [200, {}];
    renderOrg("/pve/acme/agents/a1?tab=instructions");
    const box = (await screen.findByLabelText("Contents of AGENTS.md")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("# Forge"));
    fireEvent.change(box, { target: { value: "# Forge\nBe kind." } });
    fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));
    await waitFor(() => expect(callsTo("PUT", "/engine/api/agents/a1/instructions-bundle/file")[0]?.body).toEqual({ path: "AGENTS.md", content: "# Forge\nBe kind.", baseRevisionId: "rev7" }));
  });

  it("shows a running run's output and appends lines from the live socket once", async () => {
    const run = { id: "run1", status: "running", invocationSource: "on_demand", createdAt: "2026-10-01T00:00:00Z", startedAt: "2026-10-01T00:00:00Z", error: null };
    state.routes["GET /engine/api/companies/c1/heartbeat-runs"] = () => [200, [run]];
    state.routes["GET /engine/api/heartbeat-runs/run1/log"] = () => [200, { content: `${JSON.stringify({ seq: 1, chunk: "first line\n" })}\n` }];
    renderOrg("/pve/acme/agents/a1?tab=runs");
    fireEvent.click(await screen.findByText(/on demand/));
    expect(await screen.findByText(/first line/)).toBeTruthy();
    const { FakeSocket } = await import("./engine-harness.tsx");
    const sock = FakeSocket.all[0];
    await waitFor(() => expect(sock).toBeTruthy());
    act(() => { sock.emit({ companyId: "c1", type: "heartbeat.run.log", payload: { runId: "run1", seq: 2, chunk: "second line\n" } }); sock.emit({ companyId: "c1", type: "heartbeat.run.log", payload: { runId: "run1", seq: 2, chunk: "second line\n" } }); sock.emit({ companyId: "c1", type: "heartbeat.run.log", payload: { runId: "other", seq: 9, chunk: "elsewhere\n" } }); });
    await waitFor(() => expect(screen.getByLabelText("Run output").textContent).toBe("first line\nsecond line\n"));
  });

  it("turns NDJSON log text into what the agent printed", () => {
    expect(logText(`${JSON.stringify({ chunk: "a\n" })}\n${JSON.stringify({ chunk: "b" })}\n`)).toBe("a\nb");
  });
});

describe("tasks, beyond the basics", () => {
  it("uploads a file within the cap, refuses one over it, and adds sub-tasks and labels", async () => {
    const t = issue("i1", 1, "Ship it", "todo");
    state.routes["GET /engine/api/issues/ACME-1"] = () => [200, t];
    state.routes["GET /engine/api/issues/ACME-1/comments"] = () => [200, []];
    state.routes["GET /engine/api/companies/c1/labels"] = () => [200, [{ id: "l1", name: "bug" }]];
    state.routes["GET /engine/api/issues/i1/attachments"] = () => [200, []];
    state.routes["POST /engine/api/companies/c1/issues/i1/attachments"] = () => [201, { id: "at1" }];
    state.routes["PATCH /engine/api/issues/i1"] = () => [200, t];
    state.routes["POST /engine/api/companies/c1/issues"] = () => [201, issue("i2", 2, "Child")];
    renderOrg("/pve/acme/tasks/ACME-1");
    fireEvent.click(await screen.findByRole("button", { name: "bug" }));
    await waitFor(() => expect(callsTo("PATCH", "/engine/api/issues/i1")[0]?.body).toEqual({ labelIds: ["l1"] }));
    fireEvent.change(screen.getByLabelText("New sub-task"), { target: { value: "Child" } });
    fireEvent.submit(screen.getByLabelText("New sub-task").closest("form")!);
    await waitFor(() => expect(callsTo("POST", "/engine/api/companies/c1/issues")[0]?.body).toMatchObject({ title: "Child", parentId: "i1" }));
    const input = screen.getByLabelText("Choose a file to attach") as HTMLInputElement;
    const big = new File([new Uint8Array(1)], "huge.bin");
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/huge.bin is 11.*Files can be up to 10/)).toBeTruthy();
    expect(callsTo("POST", "/engine/api/companies/c1/issues/i1/attachments")).toHaveLength(0);
    fireEvent.change(input, { target: { files: [new File(["hello"], "ok.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(callsTo("POST", "/engine/api/companies/c1/issues/i1/attachments")).toHaveLength(1));
  });
});

describe("search and counts", () => {
  const wrap = (children: ReactNode, path = "/pve/acme") => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}><EngineProvider><MemoryRouter initialEntries={[path]}>{children}</MemoryRouter></EngineProvider></QueryClientProvider>);
  };

  it("opens on / and finds tasks from the engine and agents already loaded", async () => {
    state.routes["GET /engine/api/companies/c1/search"] = () => [200, { query: "forge", results: [{ id: "i1", type: "issue", title: "ACME-1 Ship it", issue: { id: "i1", identifier: "ACME-1", title: "Ship it" } }] }];
    state.routes["GET /engine/api/companies/c1/projects"] = () => [200, []];
    wrap(<CommandPalette />);
    await waitFor(() => expect(state.calls.some((c) => c.path === "/engine/api/companies")).toBe(true));
    await new Promise((r) => setTimeout(r, 200));
    fireEvent.keyDown(window, { key: "/" });
    const box = await screen.findByRole("combobox");
    fireEvent.change(box, { target: { value: "forge" } });
    expect(await screen.findByText("Ship it")).toBeTruthy();
    expect(callsTo("GET", "/engine/api/companies/c1/search")[0].search).toContain("q=forge");
  });

  it("does not open while typing in a field", async () => {
    wrap(<><input aria-label="field" /><CommandPalette /></>);
    const f = screen.getByLabelText("field");
    f.focus();
    fireEvent.keyDown(f, { key: "/" });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("counts what is waiting per organization for the rail", async () => {
    state.routes["GET /engine/api/companies/c1/sidebar-badges"] = () => [200, { inbox: 3, approvals: 2, failedRuns: 1, joinRequests: 0 }];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}><EngineProvider>{children}</EngineProvider></QueryClientProvider>;
    const { result } = renderHook(() => useInboxCounts(["c1"]), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.get("c1")).toBe(3));
  });
});

describe("live events for the new screens", () => {
  it("refresh routines, the inbox and workspaces, and can be tapped for raw events", () => {
    expect(keysForEvent("c1", { companyId: "c1", type: "activity.logged", payload: { entityType: "routine", action: "routine.updated" } })).toEqual(expect.arrayContaining([qk.routines("c1"), qk.anyRoutine("c1"), qk.attention("c1"), qk.badges("c1")]));
    expect(keysForEvent("c1", { companyId: "c1", type: "activity.logged", payload: { entityType: "execution_workspace", action: "workspace.updated" } })).toEqual(expect.arrayContaining([qk.workspaces("c1")]));
    expect(keysForEvent("c1", { companyId: "c1", type: "heartbeat.run.status", payload: { agentId: "a1" } })).toEqual(expect.arrayContaining([qk.attention("c1"), qk.badges("c1")]));
    const seen: string[] = [];
    const off = tapEvents("c1", (e) => seen.push(e.type));
    applyEvent(new QueryClient(), "c1", { companyId: "c1", type: "heartbeat.run.log", payload: {} });
    off();
    applyEvent(new QueryClient(), "c1", { companyId: "c1", type: "heartbeat.run.log", payload: {} });
    expect(seen).toEqual(["heartbeat.run.log"]);
  });
});

describe("creating an agent", () => {
  const adapters = [
    { type: "process", label: "process", source: "builtin", modelsCount: 0, loaded: true, disabled: false },
    { type: "http", label: "http", source: "builtin", modelsCount: 0, loaded: true, disabled: false },
    { type: "cli_local", label: "cli_local", source: "builtin", modelsCount: 0, loaded: true, disabled: false },
  ];
  const caps = (sandbox: string[]) => ({ adapters: adapters.map((a) => ({ adapterType: a.type, drivers: { local: "supported", sandbox: sandbox.includes(a.type) ? "supported" : "unsupported" } })) });

  it("starts from an adapter that can run in a container, never from a bare command that can't", async () => {
    state.routes["GET /engine/api/adapters"] = () => [200, adapters];
    state.routes["GET /engine/api/companies/c1/environments/capabilities"] = () => [200, caps(["cli_local"])];
    renderOrg("/pve/acme/agents");
    fireEvent.click(await screen.findByRole("button", { name: "New agent" }));
    await waitFor(() => expect((screen.getByLabelText(/Runs with/) as HTMLSelectElement).value).toBe("cli_local"));
  });

  it("still avoids process and http when the engine can't say which adapters fit", async () => {
    state.routes["GET /engine/api/adapters"] = () => [200, adapters];
    state.routes["GET /engine/api/companies/c1/environments/capabilities"] = () => [500, { error: "nope" }];
    renderOrg("/pve/acme/agents");
    fireEvent.click(await screen.findByRole("button", { name: "New agent" }));
    await waitFor(() => expect((screen.getByLabelText(/Runs with/) as HTMLSelectElement).value).toBe("cli_local"));
  });
});

describe("members", () => {
  it("never shows the engine's made-up address for a managed account", async () => {
    const member = (id: string, name: string | null, email: string, role = "operator") => ({ id: `m-${id}`, companyId: "c1", principalType: "user", principalId: id, membershipRole: role, status: "active", createdAt: "2026-10-01T00:00:00Z", user: { id, name, email } });
    state.routes["GET /engine/api/companies/c1/members"] = () => [200, { members: [member("u1", "sam", "sam.pve-35093ab3@epaperclip.invalid", "owner"), member("u2", null, "kim.pve-0a1b2c3d@epaperclip.invalid"), member("u3", "Lee", "lee@example.com")], access: { currentUserRole: "owner", canManageMembers: true, canInviteUsers: true } }];
    renderOrg("/pve/acme/members", <Route path="members" element={<LiveMembers />} />);
    expect(await screen.findByText("sam")).toBeTruthy();
    expect(screen.getByText("Lee")).toBeTruthy();
    expect(screen.getByText("lee@example.com")).toBeTruthy();
    expect(screen.getByText("Someone")).toBeTruthy();
    expect(document.body.textContent).not.toContain("epaperclip.invalid");
  });
});
