// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const pinSettings = { current: { provider: "anthropic", model: "claude-x" } as { provider: string | null; model: string | null } };
const orgList = { current: [] as { id: string; name: string; status: string; issuePrefix: string }[] };

vi.mock("../src/data/store.tsx", () => ({
  useEngine: () => ({ live: true, setup: { deviceName: "pve" }, host: { cpus: 8, memTotal: 32 * 1024 ** 3, memUsed: 0 }, data: { orgs: [] } }),
}));
vi.mock("../src/pin/PinContext.tsx", () => ({ usePin: () => ({ settings: pinSettings.current }) }));
vi.mock("../src/data/engine/queries.ts", async (orig) => ({
  ...(await orig<typeof import("../src/data/engine/queries.ts")>()),
  useOrgs: () => ({ data: orgList.current, isPending: false, error: null }),
  useEngineStatus: () => ({ state: "ready" }),
  useCanCreateOrgs: () => true,
}));

import { StartCompany } from "../src/pages/start/StartCompany.tsx";

interface Call { method: string; path: string; body: any }
let calls: Call[];
let handlers: Record<string, (c: Call) => unknown>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

beforeEach(() => {
  calls = [];
  handlers = {
    "GET /api/agent-containers": () => ({ state: "ready", canManage: true, steps: [], environments: [{ companyId: "c1", environmentId: "e1", ok: true }] }),
    "POST /engine/api/companies": () => ({ id: "c1", name: "Northwind", issuePrefix: "NOR" }),
    "PUT /api/resource-groups/c1": () => ({ group: {} }),
    "POST /engine/api/companies/c1/onboarding-seed": (c) => ({ companyId: "c1", revision: c.body.revision, applied: true, changed: true, goalId: "g1", agentId: "a1", issueId: c.body.firstTask ? "i1" : null }),
    "PATCH /engine/api/agents/a1": () => ({}),
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const call: Call = { method: init.method ?? "GET", path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const h = handlers[`${call.method} ${call.path}`];
    return h ? json(h(call)) : json({ error: "Not found" }, 404);
  });
  localStorage.clear();
  pinSettings.current = { provider: "anthropic", model: "claude-x" };
  orgList.current = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (onClose = () => undefined) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><StartCompany onClose={onClose} /></MemoryRouter></QueryClientProvider>);
const next = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

async function throughName() {
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Northwind" } });
  fireEvent.change(screen.getByLabelText(/What is it for/), { target: { value: "Build the best invoicing tool" } });
  next("Continue");
  await screen.findByText("Create your first agent");
}

describe("start a company", () => {
  it("makes the organization and its resource group on Continue, with the mission as its description", async () => {
    wrap();
    expect(screen.getByLabelText("Step 1 of 4")).toBeTruthy();
    await throughName();
    expect(sent("POST", "/engine/api/companies")[0].body).toMatchObject({ name: "Northwind", description: "Build the best invoicing tool" });
    expect(sent("PUT", "/api/resource-groups/c1")).toHaveLength(1);
    expect(screen.getByLabelText("Step 2 of 4")).toBeTruthy();
  });

  it("walks the CEO made by hand through to a launched first task, using the engine's own seed route", async () => {
    const onClose = vi.fn();
    wrap(onClose);
    await throughName();
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Chief of staff" } });
    next("Next");
    await screen.findByText("Connect a model");
    expect(sent("POST", "/engine/api/companies/c1/onboarding-seed")[0].body).toEqual({ revision: "1", mission: "Build the best invoicing tool", agent: { name: "Chief of staff" } });
    next("Skip for now");
    fireEvent.change(await screen.findByLabelText("First task"), { target: { value: "Plan the first week\nPropose a plan and the team we need." } });
    expect(screen.getByText("What should Chief of staff do first?")).toBeTruthy();
    next("Launch");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent("POST", "/engine/api/companies/c1/onboarding-seed")[1].body).toMatchObject({ revision: "2", agent: { name: "Chief of staff" }, firstTask: { title: "Plan the first week", details: "Propose a plan and the team we need." } });
    expect(localStorage.getItem("epc.start.draft")).toBeNull();
  });

  it("lets Pin draft the CEO, shows it for review, and creates what the person kept", async () => {
    handlers["POST /api/pin/draft-ceo"] = () => ({ name: "Ada", title: "Operations lead", summary: "Plans the first week." });
    wrap();
    await throughName();
    fireEvent.click(screen.getByRole("radio", { name: /Let Pin create it/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ask Pin" }));
    expect(await screen.findByDisplayValue("Ada")).toBeTruthy();
    expect(screen.getByText("Plans the first week.")).toBeTruthy();
    expect(sent("POST", "/api/pin/draft-ceo")[0].body).toEqual({ orgName: "Northwind", description: "Build the best invoicing tool" });
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Ada Lovelace" } });
    next("Next");
    await screen.findByText("Connect a model");
    expect(sent("POST", "/engine/api/companies/c1/onboarding-seed")[0].body.agent).toEqual({ name: "Ada Lovelace", role: "Operations lead" });
  });

  it("says plainly when Pin can't draft, and offers the manual way", async () => {
    handlers["POST /api/pin/draft-ceo"] = () => { throw new Error("x"); };
    wrap();
    await throughName();
    fireEvent.click(screen.getByRole("radio", { name: /Let Pin create it/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ask Pin" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Create it myself/ }));
    expect(screen.getByLabelText("Agent name")).toBeTruthy();
  });

  it("turns the Pin option off until Pin has a model", async () => {
    pinSettings.current = { provider: null, model: null };
    wrap();
    await throughName();
    expect((screen.getByRole("radio", { name: /Let Pin create it/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Connect a model for Pin first/)).toBeTruthy();
  });

  it("points the CEO at the harness being connected, then signs in inside the organization's container", async () => {
    handlers["POST /engine/api/companies/c1/setup-token-login-sessions"] = () => ({ sessionId: "s1", environmentId: "e1", status: "starting", expiresAt: null, failure: null, prompt: null });
    handlers["GET /engine/api/companies/c1/setup-token-login-sessions/s1"] = () => ({ sessionId: "s1", environmentId: "e1", status: "waiting_for_user", expiresAt: null, failure: null });
    handlers["POST /engine/api/companies/c1/setup-token-login-sessions/s1/cancel"] = () => ({});
    wrap();
    await throughName();
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Chief" } });
    next("Next");
    await screen.findByText("Connect a model");
    fireEvent.click(screen.getByRole("radio", { name: /Claude Code/ }));
    const signIn = await screen.findByRole("button", { name: /Sign in with your account/ });
    await waitFor(() => expect((signIn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(signIn);
    await waitFor(() => expect(sent("PATCH", "/engine/api/agents/a1")[0]?.body).toEqual({ adapterType: "claude_local" }));
    await waitFor(() => expect(sent("POST", "/engine/api/companies/c1/setup-token-login-sessions")).toHaveLength(1));
    expect(await screen.findByText("Sign in to Claude Code")).toBeTruthy();
  });

  it("offers an API key for Gemini and no account sign-in", async () => {
    wrap();
    await throughName();
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Chief" } });
    next("Next");
    await screen.findByText("Connect a model");
    fireEvent.click(screen.getByRole("radio", { name: /Gemini CLI/ }));
    expect(await screen.findByRole("button", { name: /Use an API key/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign in with your account/ })).toBeNull();
  });

  it("resumes where it was, while the company still exists, and forgets a company that is gone", async () => {
    localStorage.setItem("epc.start.draft", JSON.stringify({ step: "task", company: { id: "c1", issuePrefix: "NOR", name: "Northwind" }, mission: "", ceoName: "Ada", ceoTitle: "", agentId: "a1" }));
    orgList.current = [{ id: "c1", name: "Northwind", status: "active", issuePrefix: "NOR" }];
    wrap();
    expect(await screen.findByText("What should Ada do first?")).toBeTruthy();
    cleanup();
    orgList.current = [{ id: "zzz", name: "Other", status: "active", issuePrefix: "OTH" }];
    wrap();
    expect(await screen.findByText("What is the name of your organization?")).toBeTruthy();
    expect(localStorage.getItem("epc.start.draft")).toBeNull();
  });

  it("stays on the first screen and says so when the organization can't be created", async () => {
    handlers["POST /engine/api/companies"] = () => { throw new Error("x"); };
    wrap();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Northwind" } });
    next("Continue");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("What is the name of your organization?")).toBeTruthy();
  });
});
