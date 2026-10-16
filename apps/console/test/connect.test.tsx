// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/auth/session.tsx", () => ({ useSession: () => ({ session: { mode: "live", user: { username: "sam@pve" } }, signOut: async () => {} }) }));

import { ConsentPage } from "../src/pages/connect/Consent.tsx";
import { LiveApps } from "../src/pages/connect/LiveApps.tsx";
import { LiveConnections } from "../src/pages/connect/LiveConnections.tsx";
import { AgentAccounts } from "../src/pages/connect/AgentAccounts.tsx";

type Call = { method: string; path: string; body: any };
let calls: Call[];
let routes: Record<string, (body: any, url: URL) => [number, unknown]>;
const scopes = [{ id: "paperclip:read", label: "Read only", description: "Look only." }, { id: "paperclip:control", label: "Full control", description: "Act for you." }];

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const h = routes[`${method} ${url.pathname}`];
    const [status, data] = h ? h(body, url) : [404, { error: "Not found" }];
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);

describe("the consent page", () => {
  const info = (scope: string) => ({ client: { id: "c1", name: "Claude", redirectHost: "claude.ai", loopback: false }, scope, scopes, user: "sam@pve", orgs: [{ id: "co_1", name: "Northwind" }, { id: "co_2", name: "Secret Ops" }], lifetimeDays: 90 });
  let assigned: string | null;
  beforeEach(() => {
    assigned = null;
    window.history.pushState({}, "", "/oauth/authorize?client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&response_type=code&scope=paperclip%3Aread&state=s1&code_challenge=abc&code_challenge_method=S256");
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, search: window.location.search, assign: (u: string) => (assigned = u) } });
  });

  it("says who is asking and where the person will land, and sends nothing until they choose", async () => {
    routes["GET /api/connect/oauth/request"] = () => [200, info("paperclip:read")];
    wrap(<ConsentPage />);
    expect(await screen.findByText("Connect Claude to ePaperclip?")).toBeTruthy();
    expect(screen.getByText("claude.ai")).toBeTruthy();
    expect(screen.getByText("sam@pve")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Full control" })).toBeNull(); // asked for read only: can't be widened here
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    routes["POST /api/connect/oauth/consent"] = () => [200, { redirect: "https://claude.ai/cb?code=XYZ&state=s1" }];
    fireEvent.click(screen.getByRole("button", { name: /Allow Read only/ }));
    await waitFor(() => expect(assigned).toBe("https://claude.ai/cb?code=XYZ&state=s1"));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ approve: true, scope: "paperclip:read", direct: false, orgs: null, client_id: "c1", state: "s1" });
  });

  it("lets the person narrow Full control, pick organizations and keeps 'act without asking' off by default", async () => {
    routes["GET /api/connect/oauth/request"] = () => [200, info("paperclip:control")];
    routes["POST /api/connect/oauth/consent"] = () => [200, { redirect: "https://claude.ai/cb?code=XYZ" }];
    wrap(<ConsentPage />);
    await screen.findByText("Connect Claude to ePaperclip?");
    fireEvent.click(screen.getByRole("radio", { name: "Only some" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Northwind" }));
    expect((screen.getByRole("switch", { name: "Let it act without asking me" }) as HTMLElement).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /Allow Full control/ }));
    await waitFor(() => expect(assigned).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ scope: "paperclip:control", direct: false, orgs: ["co_1"] });
  });

  it("Deny sends the refusal and nothing else", async () => {
    routes["GET /api/connect/oauth/request"] = () => [200, info("paperclip:read")];
    routes["POST /api/connect/oauth/consent"] = () => [200, { redirect: "https://claude.ai/cb?error=access_denied&state=s1" }];
    wrap(<ConsentPage />);
    await screen.findByText("Connect Claude to ePaperclip?");
    fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
    await waitFor(() => expect(assigned).toContain("access_denied"));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ approve: false });
    expect(calls.find((c) => c.method === "POST")!.body.direct).toBeUndefined();
  });

  it("shows why a request can't be approved and offers no Allow button", async () => {
    routes["GET /api/connect/oauth/request"] = () => [400, { error_description: "The app's redirect address doesn't match the one it registered.", code: "invalid_request" }];
    wrap(<ConsentPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("doesn't match");
    expect(screen.queryByRole("button", { name: /Allow/ })).toBeNull();
  });

  it("never navigates to an address that isn't a web address", async () => {
    routes["GET /api/connect/oauth/request"] = () => [200, info("paperclip:read")];
    routes["POST /api/connect/oauth/consent"] = () => [200, { redirect: "javascript:alert(1)" }];
    wrap(<ConsentPage />);
    await screen.findByText("Connect Claude to ePaperclip?");
    fireEvent.click(screen.getByRole("button", { name: /Allow Read only/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("web address");
    expect(assigned).toBeNull();
  });
});

describe("connected apps", () => {
  const overview = { mcpUrl: "https://pve.lan/mcp", issuer: "https://pve.lan", scopes, user: "sam@pve", canManageAll: false, orgs: [{ id: "co_1", name: "Northwind" }], fetchUrl: false, tools: [], grantDays: 90 };
  const app = { id: "a1a1a1a1a1a1a1a1", clientName: "Claude", clientHost: "claude.ai", userid: "sam@pve", scope: "paperclip:control", direct: false, orgs: null, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, lastUsedAt: null };
  beforeEach(() => {
    routes["GET /api/connect/overview"] = () => [200, overview];
    routes["GET /api/connect/apps"] = () => [200, { apps: [app], scope: "mine" }];
    routes["GET /api/connect/activity"] = () => [200, { calls: [{ at: Date.now(), grantId: app.id, user: "sam@pve", client: "Claude", tool: "list_machines", ok: true, control: false }], events: [] }];
  });
  it("shows the address, the apps and what they did", async () => {
    wrap(<LiveApps />);
    expect(await screen.findByText("https://pve.lan/mcp")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Claude, Full control" })).toBeTruthy();
    expect(await screen.findByText("list_machines")).toBeTruthy();
  });
  it("changes the level and revokes after a confirmation", async () => {
    routes["PATCH /api/connect/apps/a1a1a1a1a1a1a1a1"] = (b) => [200, { app: { ...app, ...b } }];
    routes["DELETE /api/connect/apps/a1a1a1a1a1a1a1a1"] = () => [200, { ok: true, warnings: [] }];
    wrap(<LiveApps />);
    fireEvent.click(await screen.findByRole("button", { name: "Claude, Full control" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Read only" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ scope: "paperclip:read" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false); // asks first
    fireEvent.click(screen.getByRole("button", { name: /End the connection/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});

describe("connections", () => {
  const conn = (o: object) => ({ id: "ollama", catalog: "ollama", label: "Ollama", baseUrl: "http://10.0.0.5:11434/v1", builtin: false, enabled: true, pin: true, orgs: [], model: "llama3.2", price: null, configured: true, entry: { kind: "local", protocol: "openai", keyRequired: false }, ...o });
  beforeEach(() => {
    routes["GET /api/connect/connections"] = () => [200, { connections: [conn({}), conn({ id: "anthropic", catalog: "anthropic", label: "Anthropic", builtin: true, baseUrl: undefined, last4: "WXYZ", model: null, entry: { kind: "hosted", protocol: "anthropic", keyRequired: true } }), conn({ id: "openai", catalog: "openai", label: "OpenAI", builtin: true, baseUrl: undefined, configured: false, model: null, entry: { kind: "hosted", protocol: "openai", keyRequired: true } })], canManage: true, fallbacks: [] }];
    routes["GET /api/connect/usage"] = () => [200, { days: 30, perDay: [], byConnection: [{ id: "x:ollama", label: "Ollama", calls: 3, tokensIn: 1200, tokensOut: 340, costUsd: null, priced: false }] }];
  });
  it("lists every connection without secrets and shows usage", async () => {
    wrap(<LiveConnections />);
    expect((await screen.findAllByText("Ollama")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Key ending in/).textContent).toContain("WXYZ");
    expect(await screen.findByText("No price set")).toBeTruthy();
    expect(screen.getByText("1.2k")).toBeTruthy();
  });
  it("sets a key without ever showing it again, and tests a connection in words", async () => {
    routes["PUT /api/connect/connections/openai/key"] = () => [200, { connection: conn({ id: "openai" }) }];
    routes["POST /api/connect/connections/ollama/test"] = () => [200, { connection: conn({ ok: true, modelCount: 4, latencyMs: 80 }) }];
    wrap(<LiveConnections />);
    await screen.findByText("OpenAI");
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    const input = screen.getByLabelText("OpenAI key") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "sk-secret-0123456789abcdefgh" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ apiKey: "sk-secret-0123456789abcdefgh" }));
    await waitFor(() => expect(screen.queryByLabelText("OpenAI key")).toBeNull());
    expect(document.body.textContent).not.toContain("sk-secret");
    fireEvent.click(screen.getAllByRole("button", { name: "Test" })[0]);
    expect((await screen.findByRole("status")).textContent).toContain("4 models available");
  });
  it("adds a local server from the catalog", async () => {
    routes["GET /api/connect/catalog"] = () => [200, { catalog: [{ id: "ollama", label: "Ollama", kind: "local", protocol: "openai", base: "http://localhost:11434/v1", baseEditable: true, keyRequired: false, note: "Run models on a machine you own." }, { id: "groq", label: "Groq", kind: "hosted", protocol: "openai", base: "https://api.groq.com/openai/v1", baseEditable: false, keyRequired: true, keysUrl: "https://console.groq.com/keys" }] }];
    routes["POST /api/connect/connections"] = () => [201, { connection: conn({}) }];
    wrap(<LiveConnections />);
    fireEvent.click(await screen.findByRole("button", { name: /Add a connection/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Ollama/ }));
    fireEvent.change(screen.getByPlaceholderText("http://192.168.1.20:11434/v1"), { target: { value: "http://10.0.0.9:11434/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ catalog: "ollama", baseUrl: "http://10.0.0.9:11434/v1" }));
  });
});

describe("an organization's agent AI accounts", () => {
  beforeEach(() => {
    routes["GET /api/connect/orgs/co_1/ai"] = () => [200, { connections: [] }];
    routes["GET /api/connect/connections"] = () => [200, { connections: [], canManage: false, fallbacks: [] }];
  });
  it("walks through a subscription sign-in showing only a provider address and a code", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    routes["POST /api/connect/orgs/co_1/login"] = () => [201, { login: { id: "ls1", status: "starting", verificationUrl: null, userCode: null, done: false, failed: false, needsCode: false, flow: "device", adapter: "codex_local", provider: "openai", expiresAt: null, message: null } }];
    routes["GET /api/connect/orgs/co_1/login/ls1"] = () => [200, { login: { id: "ls1", status: ++polls < 2 ? "waiting" : "completed", verificationUrl: polls < 2 ? "https://auth.openai.com/codex/device" : null, userCode: polls < 2 ? "ABCD-EFGH" : null, done: polls >= 2, failed: false, needsCode: false, flow: "device", adapter: "codex_local", provider: "openai", expiresAt: null, message: null } }];
    wrap(<AgentAccounts companyId="co_1" orgName="Northwind" />);
    fireEvent.click(await screen.findByRole("button", { name: /ChatGPT subscription/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start sign-in" }));
    await screen.findByText(/Starting the sign-in/);
    await vi.advanceTimersByTimeAsync(2600);
    const a = await screen.findByRole("link", { name: /auth\.openai\.com/ });
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2600);
    expect(await screen.findByText("Signed in")).toBeTruthy();
  });
});
