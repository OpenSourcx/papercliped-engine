// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live: true, setup: { deviceName: "pve", pinMode: "assistant" } }) }));

import { AutomationsLive, InboxTab, PlansTab, UpdatesTab } from "../src/pages/pin/runtime.tsx";
import { PinSettingsPanel } from "../src/pin/PinSettings.tsx";

interface Call { method: string; path: string; body: any }
let calls: Call[];
let handlers: Record<string, (c: Call) => unknown>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const NOW = Date.now();

beforeEach(() => {
  calls = [];
  handlers = {};
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const call: Call = { method: init.method ?? "GET", path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const h = handlers[`${call.method} ${call.path}`];
    if (!h) return json({ error: "Not found" }, 404);
    const out = h(call);
    return out instanceof Response ? out : json(out);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

const prefs = { muted: [], quiet: ["task_finished"], quietHours: { enabled: false, from: "22:00", to: "07:00" } };
const notice = (over: Record<string, unknown> = {}) => ({ id: "aaaaaaaaaaaa", key: "k", kind: "backup_failed", level: "critical", title: "Backup of 101 failed", body: "job errors. Open Tasks for the log.", at: NOW - 120_000, read: false, peek: true, ...over });
const inbox = (list: unknown[]) => ({ notifications: list, unread: (list as { read: boolean }[]).filter((n) => !n.read).length, prefs, kinds: ["task_finished", "backup_failed", "node_event", "approval", "automation", "proposal", "update"] });

describe("inbox", () => {
  it("lists notices with their level in words, marks them read, and clears what was read", async () => {
    handlers["GET /api/pin/notifications"] = () => inbox([notice(), notice({ id: "bbbbbbbbbbbb", key: "k2", kind: "task_finished", level: "info", title: "Start 200 finished", read: true })]);
    handlers["POST /api/pin/notifications/read"] = () => ({ ok: true });
    handlers["POST /api/pin/notifications/clear"] = () => ({ ok: true });
    wrap(<InboxTab />);
    expect(await screen.findByText("Backup of 101 failed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Info")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(sent("POST", "/api/pin/notifications/read")[0].body).toEqual({ ids: ["aaaaaaaaaaaa"] }));
    fireEvent.click(screen.getByRole("button", { name: "Clear read" }));
    await waitFor(() => expect(sent("POST", "/api/pin/notifications/clear")).toHaveLength(1));
  });

  it("says nothing needs you, and shows a load error with a way to retry", async () => {
    handlers["GET /api/pin/notifications"] = () => inbox([]);
    wrap(<InboxTab />);
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
    cleanup();
    handlers["GET /api/pin/notifications"] = () => json({ error: "Proxmox is unreachable" }, 502);
    wrap(<InboxTab />);
    expect(await screen.findByText("Proxmox is unreachable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("saves what to be told about and quiet hours", async () => {
    handlers["GET /api/pin/notifications"] = () => inbox([]);
    handlers["PUT /api/pin/notification-prefs"] = () => ({ prefs });
    wrap(<InboxTab />);
    fireEvent.click(await screen.findByRole("button", { name: /What to be told/ }));
    fireEvent.click(await screen.findByRole("switch", { name: "Tell me about Updates" }));
    fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "23:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(sent("PUT", "/api/pin/notification-prefs")).toHaveLength(1));
    const b = sent("PUT", "/api/pin/notification-prefs")[0].body;
    expect(b.muted).toEqual(["update"]);
    expect(b.quietHours).toEqual({ enabled: true, from: "23:00", to: "07:00" });
  });
});

const step = (over: Record<string, unknown>) => ({ id: "s0000001", kind: "power", label: "Start machine 200 (db)", destructive: false, confirmPhrase: null, state: "pending", ...over });
const plan = (steps: unknown[], over: Record<string, unknown> = {}) => ({ id: "p".repeat(16), title: "Maintenance", summary: "Back up, then stop the web server.", createdAt: NOW - 60_000, createdBy: "pin", status: "pending", steps, ...over });

describe("plans", () => {
  it("approves a plain step in order and runs nothing by itself", async () => {
    const first = step({ id: "s0000001", kind: "snapshot", label: "Take snapshot before of machine 101 (web)" });
    const second = step({ id: "s0000002", label: "Shut down machine 101 (web)", destructive: true, confirmPhrase: "shutdown 101" });
    handlers["GET /api/pin/plans"] = () => ({ plans: [plan([first, second])], waiting: 1 });
    handlers[`POST /api/pin/plans/${"p".repeat(16)}/steps/s0000001/approve`] = () => ({ plan: plan([{ ...first, state: "done" }, second]) });
    wrap(<PlansTab />);
    expect(await screen.findByText("Maintenance")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    // Only the first pending step has buttons.
    expect(screen.getAllByRole("button", { name: /Approve step|Review and approve/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Approve step" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({});
  });

  it("a step that interrupts a machine is approved only with its typed phrase", async () => {
    const s = step({ label: "Shut down machine 101 (web)", destructive: true, confirmPhrase: "shutdown 101" });
    handlers["GET /api/pin/plans"] = () => ({ plans: [plan([s])], waiting: 1 });
    handlers[`POST /api/pin/plans/${"p".repeat(16)}/steps/s0000001/approve`] = () => ({ plan: plan([{ ...s, state: "done" }], { status: "done" }) });
    wrap(<PlansTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Review and approve" }));
    const dialog = await screen.findByRole("dialog");
    const go = within(dialog).getByRole("button", { name: "Approve and run" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "shutdown 10" } });
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "shutdown 101" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ confirm: "shutdown 101" });
  });

  it("shows a failed step's reason and the plan as stopped", async () => {
    handlers["GET /api/pin/plans"] = () => ({ plans: [plan([step({ state: "failed", error: "Proxmox says you don't have permission for this." }), step({ id: "s0000002", state: "skipped" })], { status: "failed" })], waiting: 0 });
    wrap(<PlansTab />);
    expect(await screen.findByText("Proxmox says you don't have permission for this.")).toBeTruthy();
    expect(screen.getByText("Stopped by a failure")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("explains what plans are when there are none", async () => {
    handlers["GET /api/pin/plans"] = () => ({ plans: [], waiting: 0 });
    wrap(<PlansTab />);
    expect(await screen.findByText("No plans yet")).toBeTruthy();
  });
});

const auto = (over: Record<string, unknown> = {}) => ({ id: "a0000001", name: "Memory guard", owner: "sam@pve", readBack: "If a container uses more than 50% of its memory, shut it down, checking every minute.", permissions: "scoped", permissionsNote: "", paused: null, running: false, createdAt: NOW - 1e6, lastRunAt: NOW - 90_000, lastStatus: "ok", consecutiveFailures: 0, nextRunAt: NOW + 30_000, spec: { trigger: { type: "condition" } }, ...over });

describe("automations", () => {
  it("shows each automation in words with its status, pauses, runs now and keeps history", async () => {
    handlers["GET /api/pin/automations"] = () => ({ automations: [auto(), auto({ id: "a0000002", name: "Nightly snapshot", paused: { at: NOW, reason: "It failed 3 times in a row. Last error: Proxmox refused.", by: "runner" }, lastStatus: "failed" })], canSeeAll: false, runnerReady: true });
    handlers["POST /api/pin/automations/a0000001/pause"] = () => ({ automation: auto({ paused: { at: NOW, reason: "Paused by you.", by: "user" } }) });
    handlers["POST /api/pin/automations/a0000001/run"] = () => ({ run: {} });
    handlers["GET /api/pin/automations/runs"] = () => ({ runs: [{ id: "r1", automationId: "a0000001", automationName: "Memory guard", trigger: "schedule", startedAt: NOW - 60_000, finishedAt: NOW, status: "failed", error: "Proxmox: refused", steps: [{ vmid: 101, name: "web", action: "shutdown", result: "failed", detail: "Proxmox refused: the automation's token doesn't have permission for this.", attempts: 1 }] }] });
    wrap(<AutomationsLive />);
    expect(await screen.findByText("Memory guard")).toBeTruthy();
    expect(screen.getByText("Paused after failing")).toBeTruthy();
    expect(screen.getByText(/It failed 3 times in a row/)).toBeTruthy();
    expect(screen.getByText("Resume")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Pause" })[0]);
    await waitFor(() => expect(sent("POST", "/api/pin/automations/a0000001/pause")).toHaveLength(1));
    fireEvent.click(screen.getAllByRole("button", { name: /Run now/ })[0]);
    await waitFor(() => expect(sent("POST", "/api/pin/automations/a0000001/run")).toHaveLength(1));
    fireEvent.click(screen.getAllByRole("button", { name: /Run history/ })[0]);
    expect(await screen.findByText("Proxmox: refused")).toBeTruthy();
    expect(screen.getByText(/token doesn't have permission/)).toBeTruthy();
  });

  it("a failed run request is shown, not swallowed", async () => {
    handlers["GET /api/pin/automations"] = () => ({ automations: [auto()], canSeeAll: false, runnerReady: true });
    handlers["POST /api/pin/automations/a0000001/run"] = () => json({ error: "This automation is already running." }, 409);
    wrap(<AutomationsLive />);
    fireEvent.click((await screen.findAllByRole("button", { name: /Run now/ }))[0]);
    expect(await screen.findByText("This automation is already running.")).toBeTruthy();
  });

  it("builds one with a plain read-back and asks before using the owner's permissions", async () => {
    handlers["GET /api/pin/automations"] = () => ({ automations: [], canSeeAll: false, runnerReady: true });
    handlers["POST /api/pin/automations/preview"] = () => ({ ok: true, readBack: "If a container uses more than 80% of its memory for 300 seconds, notify me, checking every minute." });
    let attempt = 0;
    handlers["POST /api/pin/automations"] = (c) => (attempt++ === 0 ? json({ error: "You don't have the right to give an automation its own limited permissions here.", code: "needs_permissions" }, 409) : { automation: auto(c.body) });
    wrap(<AutomationsLive />);
    fireEvent.click((await screen.findAllByRole("button", { name: /New automation/ }))[0]);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Memory watch" } });
    expect(await screen.findByText(/If a container uses more than 80%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
    expect(await screen.findByText(/don't have the right to give an automation/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Let it act with all my permissions" }));
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
    await waitFor(() => expect(sent("POST", "/api/pin/automations")).toHaveLength(2));
    expect(sent("POST", "/api/pin/automations")[0].body.allowOwnerPermissions).toBeUndefined();
    expect(sent("POST", "/api/pin/automations")[1].body).toMatchObject({ name: "Memory watch", allowOwnerPermissions: true, trigger: { type: "condition", when: { metric: "memory_percent", op: ">", value: 80, forSeconds: 300 } }, then: { action: "notify" } });
  });

  it("warns when the runner isn't running", async () => {
    handlers["GET /api/pin/automations"] = () => ({ automations: [], canSeeAll: false, runnerReady: false });
    wrap(<AutomationsLive />);
    expect(await screen.findByText("The runner isn't running")).toBeTruthy();
  });
});

const info = (over: Record<string, unknown> = {}) => ({ installed: "0.1.0", latest: { version: "0.2.0", notes: "A calmer inbox.\n<script>x</script>", url: "https://github.com/OpenSourcx/papercliped-engine/releases/tag/v0.2.0", publishedAt: null }, state: "available", checkedAt: NOW, error: null, checkEnabled: true, canManage: true, canUpdate: true, previous: "0.0.9", status: null, inProgress: false, manual: "sudo ./deploy/install.sh", ...over });

describe("updates", () => {
  it("shows installed against latest, the notes as plain text, and updates only after the typed phrase", async () => {
    handlers["GET /api/pin/update"] = () => info();
    handlers["POST /api/pin/update"] = () => json({ requested: true }, 202);
    wrap(<UpdatesTab />);
    expect(await screen.findByText("An update is available")).toBeTruthy();
    expect(screen.getByText("0.1.0")).toBeTruthy();
    expect(screen.getAllByText("0.2.0").length).toBeGreaterThan(0);
    // The notes are text, never markup.
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>x<\/script>/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Update to 0.2.0/ }));
    const dialog = await screen.findByRole("dialog");
    const go = within(dialog).getByRole("button", { name: "Start the update" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "update 0.2.0" } });
    fireEvent.click(go);
    await waitFor(() => expect(sent("POST", "/api/pin/update")).toHaveLength(1));
    expect(sent("POST", "/api/pin/update")[0].body).toEqual({ action: "update", confirm: "update 0.2.0" });
  });

  it("rolls back with its own phrase", async () => {
    handlers["GET /api/pin/update"] = () => info({ state: "current" });
    handlers["POST /api/pin/update"] = () => json({ requested: true }, 202);
    wrap(<UpdatesTab />);
    expect(await screen.findByText("You're up to date")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Update to/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Go back to 0.0.9/ }));
    fireEvent.change(within(await screen.findByRole("dialog")).getByRole("textbox"), { target: { value: "rollback" } });
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(sent("POST", "/api/pin/update")[0]?.body).toEqual({ action: "rollback", confirm: "rollback" }));
  });

  it("falls back to the shell command without the helper, and hides actions from non-administrators", async () => {
    handlers["GET /api/pin/update"] = () => info({ canUpdate: false });
    wrap(<UpdatesTab />);
    expect(await screen.findByText("Update from the shell on this device")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Update to/ })).toBeNull();
    cleanup();
    handlers["GET /api/pin/update"] = () => info({ canManage: false });
    wrap(<UpdatesTab />);
    expect(await screen.findByText("Only Proxmox administrators can update ePaperclip.")).toBeTruthy();
  });

  it("reports an unreachable feed without alarm, a running update, and a rolled-back one", async () => {
    handlers["GET /api/pin/update"] = () => info({ latest: null, state: "unknown", error: "Couldn't reach the release feed." });
    wrap(<UpdatesTab />);
    expect(await screen.findByText("The release feed didn't answer")).toBeTruthy();
    expect(screen.getByText(/Your installed version is unaffected/)).toBeTruthy();
    cleanup();
    handlers["GET /api/pin/update"] = () => info({ inProgress: true, status: { phase: "installing", message: "Installing 0.2.0.", version: "0.2.0", at: Date.now() } });
    wrap(<UpdatesTab />);
    expect(await screen.findByText("Installing")).toBeTruthy();
    expect(screen.getByText(/reconnects by itself/)).toBeTruthy();
    cleanup();
    handlers["GET /api/pin/update"] = () => info({ status: { phase: "rolled_back", message: "The update didn't come up healthy, so the previous version was put back and is running.", version: "0.2.0", at: Date.now() } });
    wrap(<UpdatesTab />);
    expect(await screen.findByText("The update was rolled back")).toBeTruthy();
  });

  it("can turn checks off", async () => {
    handlers["GET /api/pin/update"] = () => info();
    handlers["PUT /api/pin/update/settings"] = () => info({ checkEnabled: false, state: "off" });
    wrap(<UpdatesTab />);
    fireEvent.click(await screen.findByRole("switch", { name: "Check for updates" }));
    await waitFor(() => expect(sent("PUT", "/api/pin/update/settings")[0].body).toEqual({ check: false }));
    expect(await screen.findByText("Checks are off")).toBeTruthy();
  });
});

describe("model settings", () => {
  const source = (test: () => Promise<unknown>) => ({
    load: async () => ({ settings: { provider: "anthropic", model: "m-1", mode: "assistant" as const, connectors: [] }, connectors: [{ id: "anthropic", kind: "provider", name: "Anthropic", configured: true, last4: "WXYZ" }] }),
    models: async () => [{ id: "m-1", name: "m-1" }],
    save: async (s: never) => s,
    test: test as never,
  });
  it("tests the connection and shows the provider's answer in words, never a key", async () => {
    const test = vi.fn().mockResolvedValueOnce({ ok: false, provider: "anthropic", model: "m-1", error: "Anthropic rejected the API key. An administrator can replace it in Connectors." }).mockResolvedValueOnce({ ok: true, provider: "anthropic", model: "m-1", ms: 800 });
    wrap(<PinSettingsPanel source={source(test)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/rejected the API key/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Working \(0.8 s\)/)).toBeTruthy();
    expect(test).toHaveBeenCalledWith("anthropic", "m-1");
  });
});
