// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { caps, overview, worker } from "./workers.fixtures.ts";

let live = true;
vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live, setup: { deviceName: "pve" } }) }));
vi.mock("../src/auth/session.tsx", () => ({ useSession: () => ({ session: { mode: live ? "live" : "demo" } }) }));
vi.mock("../src/data/engine/queries.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/data/engine/queries.ts")>("../src/data/engine/queries.ts");
  return {
    ...actual,
    useOrgs: () => ({ data: [{ id: "c1", name: "Acme" }, { id: "c2", name: "Globex" }], isPending: false }),
    useAgents: () => ({ data: [{ id: "a1", name: "Builder" }, { id: "a2", name: "Reviewer" }], isPending: false }),
  };
});

import { WorkersPage } from "../src/pages/workers/Workers.tsx";
import { WorkerDetailPage } from "../src/pages/workers/WorkerDetail.tsx";
import { AdoptWorkerModal } from "../src/pages/workers/AdoptWorker.tsx";
import { UseWorkerModal } from "../src/pages/workers/UseWorker.tsx";
import { countdown, healthOf } from "../src/pages/workers/util.ts";

interface Call { method: string; path: string; body: any }
let calls: Call[];
let handlers: Record<string, (c: Call) => unknown>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(() => {
  live = true;
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
  vi.useRealTimers();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (ui: React.ReactElement, at = "/pve/datacenter/workers") => render(<QueryClientProvider client={client()}><MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter></QueryClientProvider>);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe("honest states", () => {
  it("says so in the demo and fetches nothing", () => {
    live = false;
    wrap(<WorkersPage />);
    expect(screen.getByText("Workers need a connected device")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
  it("says the host doesn't offer the Fabric on 404", async () => {
    wrap(<WorkersPage />);
    expect(await screen.findByText("This device doesn't offer the Worker Fabric")).toBeTruthy();
  });
  it("says it is turned off when the host reports enabled: false", async () => {
    handlers["GET /api/fabric"] = () => overview({ enabled: false });
    wrap(<WorkersPage />);
    expect(await screen.findByText("The Worker Fabric is turned off")).toBeTruthy();
  });
  it("treats the host's 503 fabric_unavailable as turned off", async () => {
    handlers["GET /api/fabric"] = () => json({ error: "The Worker Fabric isn't enabled on this host.", code: "fabric_unavailable" }, 503);
    wrap(<WorkersPage />);
    expect(await screen.findByText("The Worker Fabric is turned off")).toBeTruthy();
  });
  it("explains a 403 and an unreachable device", async () => {
    handlers["GET /api/fabric"] = () => json({ error: "Forbidden", code: "forbidden" }, 403);
    wrap(<WorkersPage />);
    expect(await screen.findByText("Only Proxmox administrators can manage workers")).toBeTruthy();
    cleanup();
    vi.stubGlobal("fetch", async () => { throw new TypeError("network"); });
    wrap(<WorkersPage />);
    expect(await screen.findByText("Can't reach this device")).toBeTruthy();
  });
});

describe("workers list", () => {
  it("explains adoption when there are no workers", async () => {
    handlers["GET /api/fabric"] = () => overview();
    wrap(<WorkersPage />);
    expect(await screen.findByText("No workers yet")).toBeTruthy();
    expect(screen.getByText(/No passwords are copied to it/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Add a worker/ }).length).toBeGreaterThan(0);
  });

  it("shows what a worker reports, with no invented values", async () => {
    handlers["GET /api/fabric"] = () => overview({
      workers: [
        worker(),
        worker({ id: "w2", name: "Spare", online: false, lastSeen: Date.now() - 2 * 3_600_000, usage: { shellLeases: 0, inferenceRunning: 0, inferenceQueued: 0, loadAvg: null, freeMemMb: null }, capabilities: caps({ gpu: { present: false }, inference: null, arch: "x64", os: { name: "Debian", version: "12" } }) }),
        worker({ id: "w3", name: "Old box", state: "revoked", online: false }),
      ],
    });
    wrap(<WorkersPage />);
    const orion = (await screen.findByRole("link", { name: "Orion" })).closest("div.relative")!;
    const o = within(orion as HTMLElement);
    expect(o.getByText("Online")).toBeTruthy();
    expect(o.getByText(/qwen2.5-coder:3b, qwen2.5-coder:1.5b/)).toBeTruthy();
    expect(o.getByText("Orin (nvgpu) (jetson)")).toBeTruthy();
    expect(o.getByText("100.93.29.26")).toBeTruthy();
    expect(o.getByText("2 of 3")).toBeTruthy();
    expect(o.getByRole("meter", { name: "CPU load" })).toBeTruthy();
    const spare = within(screen.getByRole("link", { name: "Spare" }).closest("div.relative") as HTMLElement);
    expect(spare.getByText("Offline")).toBeTruthy();
    expect(spare.getByText("2 h ago")).toBeTruthy();
    expect(spare.getByText("No runtime")).toBeTruthy();
    expect(spare.getByText("None")).toBeTruthy();
    expect(spare.getByText("Not reported", { selector: "dd" })).toBeTruthy();
    expect(spare.queryByRole("meter")).toBeNull();
    expect(screen.getByText("Revoked", { selector: "h2 span" })).toBeTruthy();
  });

  it("shows a worker that has not reported hardware yet without inventing any", async () => {
    handlers["GET /api/fabric"] = () => overview({ workers: [worker({ capabilities: null, online: false, lastSeen: null })] });
    wrap(<WorkersPage />);
    expect(await screen.findByText("Hardware not reported yet")).toBeTruthy();
    expect(screen.getByText(/Waiting for the worker's first hardware report/)).toBeTruthy();
  });

  it("approves a pending worker after showing its hardware and check string", async () => {
    handlers["GET /api/fabric"] = () => overview({ pending: [{ id: "p1", name: "jetson-2", verification: "ABCD-EFGH", fingerprint: "SHA256:zzz", requestedAt: Date.now(), expiresAt: Date.now() + 600_000, capabilities: caps(), remote: "100.93.29.30" }] });
    handlers["POST /api/fabric/pending/p1/approve"] = () => ({ worker: worker({ id: "w9" }) });
    wrap(<WorkersPage />);
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByText("Cortex-A78AE, 6 cores")).toBeTruthy();
    expect(sent("POST", "/api/fabric/pending/p1/approve")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Approve jetson-2/ }));
    await waitFor(() => expect(sent("POST", "/api/fabric/pending/p1/approve")).toHaveLength(1));
  });

  it("denies a pending worker", async () => {
    handlers["GET /api/fabric"] = () => overview({ pending: [{ id: "p1", name: "jetson-2", verification: "ABCD-EFGH", fingerprint: "SHA256:zzz", requestedAt: Date.now(), expiresAt: Date.now() + 600_000, capabilities: caps(), remote: "100.93.29.30" }] });
    handlers["POST /api/fabric/pending/p1/deny"] = () => ({ ok: true });
    wrap(<WorkersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(sent("POST", "/api/fabric/pending/p1/deny")).toHaveLength(1));
  });

  it("lists environments and keeps model choice separate", async () => {
    handlers["GET /api/fabric"] = () => overview({ workers: [worker()], environments: [{ id: "e1", companyId: "c1", name: "GPU workers", workerId: "w1", requirements: { gpu: true, localModel: "qwen2.5-coder:3b" }, agents: ["a1"] }] });
    wrap(<WorkersPage />);
    expect(await screen.findByText("GPU workers")).toBeTruthy();
    expect(screen.getByText(/separate choice on the agent/)).toBeTruthy();
    expect(screen.getByText("model qwen2.5-coder:3b")).toBeTruthy();
  });
});

describe("worker detail", () => {
  const detail = (w = worker()) => {
    handlers["GET /api/fabric"] = () => overview({ workers: [w] });
    handlers["GET /api/fabric/workers/w1"] = () => ({
      worker: w,
      leases: [{ id: "l1", workerId: "w1", companyId: "c1", agentId: "agent-9", agentName: "Builder bot", runId: "run-7", environmentId: "e1", workspace: "/workspaces/c1/agent-9", state: "active", createdAt: Date.now() - 60_000 }],
      audit: [{ n: 1, at: Date.now(), actor: "admin@pam", action: "worker.adopted", workerId: "w1", detail: "via pairing" }],
    });
    return wrap(<Routes><Route path="/pve/datacenter/workers/:id" element={<WorkerDetailPage />} /></Routes>, "/pve/datacenter/workers/w1");
  };

  it("shows capabilities, connection, leases and activity", async () => {
    detail();
    expect(await screen.findByRole("heading", { name: "Orion" })).toBeTruthy();
    expect(screen.getByText("Orin (nvgpu) (jetson)")).toBeTruthy();
    expect(screen.getByText("Connection")).toBeTruthy();
    expect(screen.getByText("SHA256:abcd1234")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Leases/ }));
    expect(await screen.findByText("/workspaces/c1/agent-9")).toBeTruthy();
    expect(screen.getByText("Builder bot")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    expect(await screen.findByText("worker.adopted")).toBeTruthy();
  });

  it("drains and disables through PATCH", async () => {
    handlers["PATCH /api/fabric/workers/w1"] = () => ({});
    detail();
    fireEvent.click(await screen.findByRole("button", { name: "Drain" }));
    await waitFor(() => expect(sent("PATCH", "/api/fabric/workers/w1")[0]?.body).toEqual({ drain: true }));
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(sent("PATCH", "/api/fabric/workers/w1")[1]?.body).toEqual({ disabled: true }));
  });

  it("asks before revoking, says it is permanent, and revokes only on confirm", async () => {
    handlers["POST /api/fabric/workers/w1/revoke"] = () => ({ ok: true });
    detail();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke Orion?" });
    expect(within(dialog).getByText(/permanent for this identity/)).toBeTruthy();
    expect(within(dialog).getByText(/never connect to this device again/)).toBeTruthy();
    expect(within(dialog).getByText(/not touched or powered off/)).toBeTruthy();
    expect(sent("POST", "/api/fabric/workers/w1/revoke")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent("POST", "/api/fabric/workers/w1/revoke")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke permanently" }));
    await waitFor(() => expect(sent("POST", "/api/fabric/workers/w1/revoke")).toHaveLength(1));
  });

  it("offers re-pair only when offline and record removal only when revoked", async () => {
    detail(worker({ online: false }));
    expect(await screen.findByRole("button", { name: /Re-pair/ })).toBeTruthy();
    cleanup();
    detail(worker({ state: "revoked", online: false }));
    expect(await screen.findByRole("button", { name: /Remove record/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Drain" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("says when the worker doesn't exist", async () => {
    handlers["GET /api/fabric"] = () => overview();
    wrap(<Routes><Route path="/pve/datacenter/workers/:id" element={<WorkerDetailPage />} /></Routes>, "/pve/datacenter/workers/nope");
    expect(await screen.findByText("No worker with this address")).toBeTruthy();
  });
});

async function createCode() {
  await screen.findByRole("radiogroup", { name: "Connection provider" });
  const b = screen.getByRole("button", { name: "Create pairing code" }) as HTMLButtonElement;
  await waitFor(() => expect(b.disabled).toBe(false));
  fireEvent.click(b);
}

describe("adopt a worker", () => {
  it("offers providers honestly, with Tailscale recommended and others marked", async () => {
    handlers["GET /api/fabric"] = () => overview();
    wrap(<AdoptWorkerModal onClose={() => {}} />);
    const group = await screen.findByRole("radiogroup", { name: "Connection provider" });
    const radios = within(group).getAllByRole("radio");
    const ts = radios.find((r) => r.textContent?.includes("Tailscale"))!;
    expect(ts.getAttribute("aria-checked")).toBe("true");
    expect(ts.textContent).toMatch(/Recommended/);
    expect(ts.textContent).toMatch(/Detected/);
    const custom = radios.find((r) => r.textContent?.includes("Custom"))!;
    expect((custom as HTMLButtonElement).disabled).toBe(true);
    expect(custom.textContent).toMatch(/Not detected/);
    expect(within(group).getByText(/Headscale/)).toBeTruthy();
    expect(within(group).getAllByText(/Not available yet/).length).toBe(2);
  });

  it("creates a one-use code, shows it with a countdown, then the worker's hardware when it arrives", async () => {
    let arrived = false;
    const exp = Date.now() + 15 * 60_000;
    handlers["GET /api/fabric"] = () => overview({ workers: arrived ? [worker({ id: "new", name: "Jetson-2" })] : [], pairings: arrived ? [] : [{ id: "pr1", name: "", createdAt: Date.now(), expiresAt: exp }] });
    handlers["POST /api/fabric/pairings"] = () => ({ id: "pr1", code: "epw1.abcDEF", expiresAt: exp, installCommand: "epaperclip-worker adopt epw1.abcDEF" });
    wrap(<AdoptWorkerModal onClose={() => {}} />);
    await createCode();
    expect(await screen.findByText("epw1.abcDEF", { selector: "pre" })).toBeTruthy();
    expect(sent("POST", "/api/fabric/pairings")[0].body).toEqual({ companies: null, transport: "tailscale" });
    expect(screen.getByText(/Waiting for the worker to connect/)).toBeTruthy();
    expect(screen.getByLabelText(/^Expires in 1[45]:/)).toBeTruthy();
    expect(screen.getByText(/Shown once/)).toBeTruthy();
    arrived = true;
    await waitFor(() => expect(screen.queryByText(/Waiting for the worker/)).toBeNull(), { timeout: 8000 });
    expect(await screen.findByText("Jetson-2 is connected")).toBeTruthy();
    expect(screen.getByText("Cortex-A78AE, 6 cores")).toBeTruthy();
  }, 15000);

  it("shows an expired code and a code that was used without a worker arriving", async () => {
    handlers["GET /api/fabric"] = () => overview();
    handlers["POST /api/fabric/pairings"] = () => ({ id: "pr1", code: "epw1.x", expiresAt: Date.now() - 1000, installCommand: "x" });
    wrap(<AdoptWorkerModal onClose={() => {}} />);
    await createCode();
    expect(await screen.findByText("This code expired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create a new code" })).toBeTruthy();
    cleanup();
    handlers["POST /api/fabric/pairings"] = () => ({ id: "pr2", code: "epw1.y", expiresAt: Date.now() + 600_000, installCommand: "y" });
    wrap(<AdoptWorkerModal onClose={() => {}} />);
    await createCode();
    expect(await screen.findByText("This code is no longer valid")).toBeTruthy();
    expect(screen.getByText(/can't be replayed/)).toBeTruthy();
  });

  it("shows a failure to create a code in the dialog and keeps the choices", async () => {
    handlers["GET /api/fabric"] = () => overview();
    handlers["POST /api/fabric/pairings"] = () => json({ error: "The host can't be reached from the tailnet", code: "unreachable" }, 502);
    wrap(<AdoptWorkerModal onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText(/Name \(optional\)/), { target: { value: "bench" } });
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    expect(await screen.findByText("The host can't be reached from the tailnet")).toBeTruthy();
    expect((screen.getByLabelText(/Name \(optional\)/) as HTMLInputElement).value).toBe("bench");
  });

  it("uses the host's pairing state: used without a worker, and cancelled", async () => {
    const exp = Date.now() + 600_000;
    let st = "used";
    handlers["GET /api/fabric"] = () => overview({ pairings: [{ id: "pr1", name: "", createdAt: Date.now(), expiresAt: exp, state: st as "used" }] });
    handlers["POST /api/fabric/pairings"] = () => ({ id: "pr1", code: "epw1.q", expiresAt: exp, installCommand: "q" });
    wrap(<AdoptWorkerModal onClose={() => {}} />);
    await createCode();
    expect(await screen.findByText("This code is no longer valid")).toBeTruthy();
    cleanup();
    st = "cancelled";
    wrap(<AdoptWorkerModal onClose={() => {}} />);
    await createCode();
    expect(await screen.findByText("This code was cancelled")).toBeTruthy();
  });

  it("cancels an unused code", async () => {
    handlers["GET /api/fabric"] = () => overview({ pairings: [{ id: "pr1", name: "", createdAt: Date.now(), expiresAt: Date.now() + 600_000 }] });
    handlers["POST /api/fabric/pairings"] = () => ({ id: "pr1", code: "epw1.z", expiresAt: Date.now() + 600_000, installCommand: "z" });
    handlers["DELETE /api/fabric/pairings/pr1"] = () => ({ ok: true });
    wrap(<AdoptWorkerModal onClose={() => {}} />);
    await createCode();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel this code" }));
    await waitFor(() => expect(sent("DELETE", "/api/fabric/pairings/pr1")).toHaveLength(1));
  });
});

describe("run agents on a worker", () => {
  it("creates an environment with requirements and agents, and never mentions a model for the agent", async () => {
    handlers["GET /api/fabric"] = () => overview({ workers: [worker()] });
    handlers["POST /api/fabric/environments"] = () => ({ environment: { id: "e1", companyId: "c1", name: "GPU", workerId: "w1", requirements: {}, agents: ["a1"] } });
    wrap(<UseWorkerModal onClose={() => {}} />);
    await screen.findByRole("option", { name: "Orion" });
    fireEvent.change(screen.getByLabelText("Worker"), { target: { value: "w1" } });
    fireEvent.click(screen.getByLabelText("Needs a GPU"));
    fireEvent.change(screen.getByLabelText("Local model"), { target: { value: "qwen2.5-coder:3b" } });
    fireEvent.click(screen.getByLabelText("git"));
    fireEvent.click(screen.getByLabelText("Builder"));
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    await waitFor(() => expect(sent("POST", "/api/fabric/environments")).toHaveLength(1));
    expect(sent("POST", "/api/fabric/environments")[0].body).toEqual({ companyId: "c1", workerId: "w1", requirements: { gpu: true, localModel: "qwen2.5-coder:3b", tools: ["git"] }, assignAgents: ["a1"] });
    expect(await screen.findByText("Environment ready")).toBeTruthy();
  });

  it("keeps the dialog open and says why when creation fails", async () => {
    handlers["GET /api/fabric"] = () => overview({ workers: [] });
    handlers["POST /api/fabric/environments"] = () => json({ error: "Unknown organization", code: "bad_company" }, 400);
    wrap(<UseWorkerModal onClose={() => {}} />);
    expect(await screen.findByText("No adopted workers yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create environment" }));
    expect(await screen.findByText("Unknown organization")).toBeTruthy();
  });
});

describe("helpers", () => {
  it("maps state to the status vocabulary", () => {
    expect(healthOf(worker()).label).toBe("Online");
    expect(healthOf(worker({ online: false })).label).toBe("Offline");
    expect(healthOf(worker({ draining: true })).label).toBe("Draining");
    expect(healthOf(worker({ disabled: true })).label).toBe("Disabled");
    expect(healthOf(worker({ state: "revoked" })).kind).toBe("critical");
    expect(healthOf(worker({ usage: { shellLeases: 0, inferenceRunning: 0, inferenceQueued: 0, loadAvg: 0, freeMemMb: 100 } })).label).toBe("Low memory");
  });
  it("counts down and ends", () => {
    expect(countdown(1000 + 90_000, 1000)).toBe("1:30");
    expect(countdown(1000, 1000)).toBeNull();
  });
});
