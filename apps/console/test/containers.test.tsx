// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/auth/session.tsx", () => ({
  useSession: () => ({ session: { mode: "live", user: { username: "sam@pve", name: "Sam", realm: "pve", node: "pve" } }, signOut: async () => {} }),
}));

import { AgentContainers } from "../src/pages/containers/AgentContainers.tsx";
import { AgentContainersBanner, useAgentsCanRun } from "../src/pages/containers/Banner.tsx";

interface Call { method: string; path: string; body: any }
let calls: Call[];
let status: any;
let job: any;
let setupFails: string | null;

const steps = (done: string[]) =>
  ["access", "key", "template", "grant", "plugin", "environments", "enforce"].map((id) => ({ id, label: `step ${id}`, done: done.includes(id) }));
const baseStatus = (over: Record<string, unknown> = {}) => ({ state: "not_set_up", steps: steps([]), pluginInstalled: false, environments: [], template: { exists: false }, token: { exists: false }, canManage: true, job: null, ...over });

beforeEach(() => {
  calls = [];
  status = baseStatus();
  job = null;
  setupFails = null;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const json = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s });
    if (method === "GET" && url.pathname === "/api/agent-containers") return json(status);
    if (method === "POST" && url.pathname === "/api/agent-containers/setup") {
      if (setupFails) return json({ error: setupFails, code: "engine_not_ready" }, 409);
      job = { id: "abc123abc123", kind: "setup", status: "running", startedAt: 1, startedBy: "sam@pve", steps: [{ id: "check", label: "Check this host", state: "done" }, { id: "access", label: "step access", state: "running" }], log: [{ t: 1, level: "info", text: "Creating role EPCSandbox" }] };
      return json({ jobId: job.id, alreadyRunning: false }, 202);
    }
    if (method === "GET" && url.pathname.startsWith("/api/agent-containers/jobs/")) {
      // The second poll sees the job end.
      if (job.status === "running" && calls.filter((c) => c.path.includes("/jobs/")).length >= 2) {
        job = { ...job, status: "done", steps: job.steps.map((s: any) => ({ ...s, state: "done" })), log: [...job.log, { t: 2, level: "info", text: "Agent containers are ready." }] };
        status = baseStatus({ state: "ready", steps: steps(["access", "key", "template", "grant", "plugin", "environments", "enforce"]) });
      }
      return json(job);
    }
    if (method === "DELETE" && url.pathname === "/api/agent-containers") {
      job = { id: "def456def456", kind: "teardown", status: "done", startedAt: 1, startedBy: "sam@pve", steps: [], log: [{ t: 1, level: "info", text: "Removed token" }] };
      return json({ jobId: job.id }, 202);
    }
    return json({ error: "Not found" }, 404);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const wrap = (ui: React.ReactNode) => render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider></MemoryRouter>);

describe("the Agent containers screen", () => {
  it("shows the checklist and says agents can't run yet", async () => {
    wrap(<AgentContainers />);
    await screen.findByText("step access");
    expect(screen.getAllByText(/Agents can't run until agent containers are set up/).length).toBeGreaterThan(0);
    expect(screen.getByText("Not set up")).toBeTruthy();
    expect(screen.getAllByLabelText("Not done")).toHaveLength(7);
    expect(screen.getByText("Set up agent containers")).toBeTruthy();
  });

  it("sets up with the chosen options, follows the job's progress and log, and ends ready", async () => {
    wrap(<AgentContainers />);
    await screen.findByText("step access");
    fireEvent.change(screen.getByLabelText("Container storage"), { target: { value: "tank" } });
    fireEvent.change(screen.getByLabelText("Container size"), { target: { value: "large" } });
    fireEvent.click(screen.getByText("Set up agent containers"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/agent-containers/setup")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ storage: "tank", templateStorage: "local", bridge: "vmbr0", pool: "epc-agents", size: { cores: 4, memoryMb: 8192, diskGb: 32 } });
    await screen.findByText("Creating role EPCSandbox");
    await screen.findByText("Agent containers are ready.", {}, { timeout: 6000 });
    await waitFor(() => expect(screen.getByText("Ready")).toBeTruthy());
    expect(screen.queryByText(/Nothing runs on the host in the meantime/)).toBeNull();
    expect(screen.getByText("Check and repair")).toBeTruthy();
  }, 10000);

  it("shows what failed and offers to resume", async () => {
    status = baseStatus({ state: "error", steps: steps(["access", "key"]), error: "storage 'local-lvm' is full" });
    wrap(<AgentContainers />);
    await screen.findByText("Needs attention");
    expect(screen.getByText("storage 'local-lvm' is full")).toBeTruthy();
    expect(screen.getByText("Resume setup")).toBeTruthy();
  });

  it("explains a refusal from the host", async () => {
    setupFails = "The engine isn't ready yet. Wait for it to finish starting, then try again.";
    wrap(<AgentContainers />);
    fireEvent.click(await screen.findByText("Set up agent containers"));
    await screen.findByText(/The engine isn't ready yet/);
  });

  it("is read-only for people who aren't Proxmox administrators", async () => {
    status = baseStatus({ canManage: false, steps: [] });
    wrap(<AgentContainers />);
    await screen.findByText(/Only Proxmox administrators can set up or change agent containers/);
    expect(screen.queryByText("Set up agent containers")).toBeNull();
    expect(screen.queryByText("Advanced")).toBeNull();
    expect(screen.getByText(/Ask a Proxmox administrator to set them up/)).toBeTruthy();
  });

  it("picks up a job that is already running when the page opens", async () => {
    job = { id: "abc123abc123", kind: "setup", status: "running", startedAt: 1, startedBy: "sam@pve", steps: [{ id: "access", label: "step access", state: "running" }], log: [{ t: 1, level: "info", text: "Still going" }] };
    status = baseStatus({ state: "partial", steps: steps(["access"]), job: { id: job.id, status: "running" } });
    wrap(<AgentContainers />);
    await screen.findByText("Still going");
    expect((screen.getByText("Working…").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes only after the confirmation is typed", async () => {
    status = baseStatus({ state: "ready", steps: steps(["access", "key", "template", "grant", "plugin", "environments", "enforce"]) });
    wrap(<AgentContainers />);
    await screen.findByText("Advanced");
    const button = screen.getByText("Remove agent containers").closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "remove agent" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "remove agent containers" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ confirm: "remove agent containers" }));
    await screen.findByText("Removed token");
  });
});

function Probe() {
  return <span>{useAgentsCanRun() ? "can run" : "blocked"}</span>;
}

describe("the banner and the wake guard", () => {
  it("shows a calm note with a way to fix it for administrators", async () => {
    wrap(<AgentContainersBanner />);
    await screen.findByText(/Agents can't run until agent containers are set up/);
    expect(screen.getByText("Set up agent containers").getAttribute("href")).toBe("/?settings=agent-containers");
  });

  it("tells other people to ask an administrator, without a link", async () => {
    status = baseStatus({ canManage: false, steps: [] });
    wrap(<AgentContainersBanner />);
    await screen.findByText(/Ask a Proxmox administrator/);
    expect(screen.queryByText("Set up agent containers")).toBeNull();
  });

  it("shows nothing once ready, and the guard lets agents run", async () => {
    status = baseStatus({ state: "ready", steps: steps(["access", "key", "template", "grant", "plugin", "environments", "enforce"]) });
    wrap(<><AgentContainersBanner /><Probe /></>);
    await screen.findByText("can run");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("blocks waking agents while containers aren't ready", async () => {
    wrap(<Probe />);
    await waitFor(() => expect(screen.getByText("blocked")).toBeTruthy());
  });
});
