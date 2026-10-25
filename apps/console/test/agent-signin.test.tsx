// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live: true }) }));
const setup = { orgs: [{ id: "c1", name: "Acme", status: "active" }] as { id: string; name: string; status: string }[], containers: { state: "ready", canManage: true, environments: [{ companyId: "c1", environmentId: "e1", ok: true }] } as { state: string; canManage: boolean; environments: { companyId: string; environmentId: string; ok: boolean }[] } };
vi.mock("../src/data/engine/queries.ts", async (orig) => ({
  ...(await orig<typeof import("../src/data/engine/queries.ts")>()),
  useOrgs: () => ({ data: setup.orgs, isPending: false, error: null }),
  useAgentContainers: () => ({ data: setup.containers }),
}));

import { AgentSignIn } from "../src/pages/AgentSignIn.tsx";

interface Call { method: string; path: string; body: any }
let calls: Call[];
let handlers: Record<string, (c: Call) => unknown>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const A = "/engine/api/companies/c1";

beforeEach(() => {
  setup.orgs = [{ id: "c1", name: "Acme", status: "active" }];
  setup.containers = { state: "ready", canManage: true, environments: [{ companyId: "c1", environmentId: "e1", ok: true }] };
  calls = [];
  handlers = {};
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const call: Call = { method: init.method ?? "GET", path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const h = handlers[`${call.method} ${call.path}`];
    return h ? json(h(call)) : json({ error: "Not found" }, 404);
  });
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AgentSignIn /></MemoryRouter></QueryClientProvider>);

describe("agent sign-in", () => {
  it("lists the harnesses per organization, with Gemini pointing at the Vault instead of a button", async () => {
    handlers[`GET ${A}/adapters/claude_local/auth-signal`] = () => ({ status: "authenticated" });
    handlers[`GET ${A}/adapters/codex_local/auth-signal`] = () => ({ status: "unknown" });
    wrap();
    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(await screen.findByText("Signed in")).toBeTruthy();
    expect(screen.getByText("Gemini CLI")).toBeTruthy();
    expect(screen.getByText(/Gemini has no account sign-in/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Use an API key/ })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: /Sign in/ })).toHaveLength(3);
  });

  it("signs in with a device code (Codex): opens the page, shows the code, finishes when the engine says so", async () => {
    let polls = 0;
    handlers[`POST ${A}/adapters/codex_local/login-sessions`] = () => ({ sessionId: "s1", environmentId: "e1", status: "starting", expiresAt: null, failure: null, prompt: null });
    handlers[`GET ${A}/adapters/codex_local/login-sessions/s1`] = () => (++polls < 2
      ? { sessionId: "s1", environmentId: "e1", status: "waiting_for_user", expiresAt: null, failure: null, prompt: { url: "https://auth.example/device", code: "ABCD-1234" } }
      : { sessionId: "s1", environmentId: "e1", status: "authenticated", expiresAt: null, failure: null, prompt: null });
    wrap();
    await screen.findByText("Acme");
    fireEvent.click(screen.getAllByRole("button", { name: "Sign in" })[1]);
    expect(await screen.findByText("ABCD-1234", {}, { timeout: 6000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open the Codex sign-in page/ }));
    expect(window.open).toHaveBeenCalledWith("https://auth.example/device", "_blank", "noopener,noreferrer");
    expect(sent("POST", `${A}/adapters/codex_local/login-sessions`)[0].body).toEqual({ environmentId: "e1" });
    expect(await screen.findByText("Signed in", {}, { timeout: 6000 })).toBeTruthy();
    expect(sent("POST", `${A}/adapters/codex_local/login-sessions/s1/cancel`)).toHaveLength(0);
  }, 20_000);

  it("signs in to Claude with a pasted browser code and stores the token", async () => {
    handlers[`POST ${A}/setup-token-login-sessions`] = () => ({ sessionId: "s2", environmentId: "e1", status: "starting", expiresAt: null, failure: null, panelMode: "submitted_browser_code", prompt: null });
    let authed = false;
    handlers[`GET ${A}/setup-token-login-sessions/s2`] = () => ({ sessionId: "s2", environmentId: "e1", status: authed ? "authenticated" : "waiting_for_user", expiresAt: null, failure: null });
    handlers[`GET ${A}/setup-token-login-sessions/s2/prompt`] = () => ({ authorizationUrl: "https://claude.example/oauth", transportAdvisory: null });
    handlers[`POST ${A}/setup-token-login-sessions/s2/code`] = () => { authed = true; return { sessionId: "s2", environmentId: "e1", status: "waiting_for_user", expiresAt: null, failure: null }; };
    handlers[`POST ${A}/setup-token-login-sessions/s2/completion`] = () => ({ storedSessionId: "x" });
    wrap();
    await screen.findByText("Acme");
    fireEvent.click(screen.getAllByRole("button", { name: "Sign in" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: /Open the Claude Code sign-in page/ }, { timeout: 6000 }));
    expect(window.open).toHaveBeenCalledWith("https://claude.example/oauth", "_blank", "noopener,noreferrer");
    fireEvent.change(screen.getByLabelText("Paste the code Claude shows you"), { target: { value: " abc#123 " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    await waitFor(() => expect(sent("POST", `${A}/setup-token-login-sessions/s2/code`)[0].body).toEqual({ browserCode: "abc#123" }));
    expect(await screen.findByText("Signed in", {}, { timeout: 6000 })).toBeTruthy();
    expect(sent("POST", `${A}/setup-token-login-sessions/s2/completion`)).toHaveLength(1);
  }, 20_000);

  it("cancels the engine's session when the window is closed before the end", async () => {
    handlers[`POST ${A}/adapters/grok_local/login-sessions`] = () => ({ sessionId: "s3", environmentId: "e1", status: "waiting_for_user", expiresAt: null, failure: null, prompt: { url: "https://x.example", code: "ZZZ" } });
    handlers[`GET ${A}/adapters/grok_local/login-sessions/s3`] = () => ({ sessionId: "s3", environmentId: "e1", status: "waiting_for_user", expiresAt: null, failure: null, prompt: { url: "https://x.example", code: "ZZZ" } });
    handlers[`POST ${A}/adapters/grok_local/login-sessions/s3/cancel`] = () => ({});
    wrap();
    await screen.findByText("Acme");
    fireEvent.click(screen.getAllByRole("button", { name: "Sign in" })[2]);
    await screen.findByText("ZZZ");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(sent("POST", `${A}/adapters/grok_local/login-sessions/s3/cancel`)).toHaveLength(1), { timeout: 4000 });
  }, 20_000);

  it("gives an organization's Gemini agents an API key through the Vault, keeping other organizations' shares", async () => {
    handlers[`GET ${A}/agents`] = () => [
      { id: "g1", name: "Researcher", adapterType: "gemini_local", status: "idle" },
      { id: "x1", name: "Coder", adapterType: "claude_local", status: "idle" },
      { id: "g2", name: "Old", adapterType: "gemini_local", status: "terminated" },
    ];
    handlers["GET /api/vault"] = () => ({ canManage: true, items: [{ id: "v1", name: "GEMINI_API_KEY", description: "", share: "ceos", targets: [{ companyId: "other", agentId: "o1" }], last4: "wxyz", createdAt: 1, updatedAt: 1, updatedBy: "root@pam", syncedTo: ["other"] }] });
    handlers["PATCH /api/vault/v1"] = () => ({ item: {}, problems: [] });
    wrap();
    await screen.findByText("Acme");
    fireEvent.click(screen.getAllByRole("button", { name: /Use an API key/ })[3]);
    expect(await screen.findByText(/Shared as/)).toBeTruthy();
    expect(screen.getByText(/Researcher/)).toBeTruthy();
    expect(screen.queryByText(/Coder/)).toBeNull();
    fireEvent.change(screen.getByLabelText("New key (optional)"), { target: { value: "AIza-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("PATCH", "/api/vault/v1")).toHaveLength(1));
    expect(sent("PATCH", "/api/vault/v1")[0].body).toEqual({ share: "ceos", value: "AIza-new", targets: [{ companyId: "other", agentId: "o1" }, { companyId: "c1", agentId: "g1" }] });
    expect(await screen.findByText(/will use this key on their next run/)).toBeTruthy();
  });

  it("creates the Vault item the first time and refuses to save with nothing typed", async () => {
    handlers[`GET ${A}/agents`] = () => [{ id: "x1", name: "Coder", adapterType: "claude_local", status: "idle" }];
    handlers["GET /api/vault"] = () => ({ canManage: true, items: [] });
    handlers["POST /api/vault"] = () => ({ item: {}, problems: [] });
    wrap();
    await screen.findByText("Acme");
    fireEvent.click(screen.getAllByRole("button", { name: /Use an API key/ })[0]);
    await screen.findByText(/Shared as/);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent("POST", "/api/vault")).toHaveLength(1));
    expect(sent("POST", "/api/vault")[0].body).toMatchObject({ name: "ANTHROPIC_API_KEY", share: "ceos", value: "sk-ant-1", targets: [{ companyId: "c1", agentId: "x1" }] });
  });

  it("shows what to do first, in order, instead of a dead end, when there are no containers and no organization", async () => {
    setup.orgs = [];
    setup.containers = { state: "not_set_up", canManage: true, environments: [] };
    wrap();
    expect(await screen.findByText("Two things first")).toBeTruthy();
    expect(screen.getByText("Set up agent containers")).toBeTruthy();
    expect(screen.getByText("Create an organization")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a company" })).toBeTruthy();
    expect(screen.queryByText("No organizations yet")).toBeNull();
  });

  it("asks a non-administrator to ask one, and drops the checklist once both are in place", async () => {
    setup.orgs = [];
    setup.containers = { state: "not_set_up", canManage: false, environments: [] };
    wrap();
    expect(await screen.findByText("Ask an administrator")).toBeTruthy();
    cleanup();
    setup.orgs = [{ id: "c1", name: "Acme", status: "active" }];
    setup.containers = { state: "ready", canManage: true, environments: [{ companyId: "c1", environmentId: "e1", ok: true }] };
    wrap();
    await screen.findByText("Acme");
    expect(screen.queryByText("Two things first")).toBeNull();
  });
});
