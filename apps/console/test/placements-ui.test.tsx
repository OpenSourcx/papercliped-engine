// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/data/store.tsx", () => ({
  useEngine: () => ({
    live: true,
    setup: { deviceName: "pve" },
    data: { orgs: [{ slug: "acme", name: "Acme Works", engine: { companyId: "c1" } }] },
  }),
}));

import { machineLink, machineName, MachineRuns, PRESENCE, RunPlacement, runSentence } from "../src/pages/placements/PlacementViews.tsx";
import type { Placement, PlacementAnswer, Presence } from "../src/data/engine/placements.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const lxc = (o: Partial<Placement> = {}): Placement => ({
  leaseId: "l1", runId: "run1", companyId: "c1", issueId: "i1", provider: "proxmox", state: "active", acquiredAt: NOW - 120_000, releasedAt: null,
  resource: { kind: "lxc", device: "pve", node: "pve", vmid: 104 }, ...o,
});
const wk = (o: Partial<Placement> = {}): Placement => lxc({ leaseId: "w1", provider: "remote-worker", resource: { kind: "worker", device: "pve", workerId: "orion" }, ...o });
const answer = (status: Presence, placements: Placement[], hidden = 0): PlacementAnswer => ({ status, placements, hidden, lastSyncAt: NOW - 30_000 });

describe("the wording", () => {
  it("says something plain for every state, and never claims more than the host knows", () => {
    for (const s of Object.keys(PRESENCE) as Presence[]) expect(runSentence(s, lxc(), NOW).length).toBeGreaterThan(10);
    expect(runSentence("active", lxc(), NOW)).toBe("Running in container 104.");
    expect(runSentence("active", wk(), NOW)).toBe("Running in worker orion.");
    expect(runSentence("retired", lxc({ state: "retired", releasedAt: NOW - 3_600_000 }), NOW)).toBe("Ran in container 104, released 1 h ago.");
    expect(runSentence("stale", lxc(), NOW)).toMatch(/may be out of date/);
    expect(runSentence("unplaced", null, NOW)).toMatch(/No machine is recorded/);
    expect(runSentence("restricted", null, NOW)).toMatch(/can't see/);
    expect(machineName({ kind: "lxc", device: "pve", node: "pve", vmid: 7 })).toBe("container 7");
  });

  it("links a live container and any worker, but never a finished or failed container (its id may be reused)", () => {
    expect(machineLink("pve", lxc(), "active")).toBe("/pve/machines/104");
    expect(machineLink("pve", lxc(), "stale")).toBe("/pve/machines/104");
    expect(machineLink("pve", lxc({ state: "retired" }), "retired")).toBeNull();
    expect(machineLink("pve", lxc({ state: "failed" }), "failed")).toBeNull();
    expect(machineLink("pve", wk({ state: "retired" }), "retired")).toBe("/pve/datacenter/workers/orion");
    expect(machineLink("pve", lxc({ resource: null }), "unplaced")).toBeNull();
  });
});

let routes: Record<string, () => [number, unknown]>;
const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
beforeEach(() => {
  routes = {};
  vi.stubGlobal("fetch", async (input: string) => {
    const u = new URL(input, "http://pve.lan");
    const h = routes[u.pathname + u.search] ?? routes[u.pathname];
    const [status, body] = h ? h() : [404, { error: "Not found" }];
    return new Response(JSON.stringify(body), { status });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("on a run", () => {
  it("shows the container a running run is in, with a link to it", async () => {
    routes["/api/placements/runs/run1"] = () => [200, { runId: "run1", ...answer("active", [lxc()]) }];
    wrap(<RunPlacement runId="run1" />);
    expect(await screen.findByText("Running in container 104.")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open container 104" }).getAttribute("href")).toBe("/pve/machines/104");
  });

  it("shows where a finished run ran without linking a container that may be gone or reused", async () => {
    routes["/api/placements/runs/run1"] = () => [200, { runId: "run1", ...answer("retired", [lxc({ state: "retired", releasedAt: Date.now() - 60_000 })]) }];
    wrap(<RunPlacement runId="run1" />);
    expect(await screen.findByText(/Ran in container 104, released/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("links a worker run to the worker, and says an unconfirmed live run is stale", async () => {
    routes["/api/placements/runs/run1"] = () => [200, { runId: "run1", ...answer("stale", [wk()]) }];
    wrap(<RunPlacement runId="run1" />);
    expect(await screen.findByText(/may be out of date/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open worker orion" }).getAttribute("href")).toBe("/pve/datacenter/workers/orion");
    expect(screen.getByText("Not confirmed lately")).toBeTruthy();
  });

  it("says plainly when nothing is recorded, when the host hasn't looked yet, and when the run is another organization's", async () => {
    for (const [status, text] of [["unplaced", /No machine is recorded/], ["unavailable", /hasn't read where runs ran/], ["restricted", /organization you can't see/]] as const) {
      cleanup();
      routes["/api/placements/runs/run1"] = () => [200, { runId: "run1", ...answer(status, [], status === "restricted" ? 1 : 0) }];
      wrap(<RunPlacement runId="run1" />);
      expect(await screen.findByText(text)).toBeTruthy();
      expect(screen.queryByRole("link")).toBeNull();
    }
  });

  it("stays out of the way if the lookup fails", async () => {
    routes["/api/placements/runs/run1"] = () => [500, { error: "boom" }];
    wrap(<RunPlacement runId="run1" />);
    expect(await screen.findByText("Couldn't look up where this ran.")).toBeTruthy();
  });
});

describe("on a machine", () => {
  const target = { kind: "lxc", node: "pve", vmid: 104 } as const;

  it("renders nothing for a machine that never ran an agent, or when the host can't say", async () => {
    routes["/api/placements/resources"] = () => [200, answer("unplaced", [])];
    const { container } = wrap(<MachineRuns target={target} />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
    cleanup();
    routes["/api/placements/resources"] = () => [500, { error: "x" }];
    const again = wrap(<MachineRuns target={target} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(again.container.innerHTML).toBe("");
  });

  it("lists the runs it served, newest first, with the organization and a task link, and a bare count for the rest", async () => {
    const old = lxc({ leaseId: "a", runId: "r-old", issueId: "i0", state: "retired", acquiredAt: NOW - 7_200_000, releasedAt: NOW - 3_600_000 });
    const cur = lxc({ leaseId: "b", runId: "r-new", issueId: "i9" });
    routes["/api/placements/resources?kind=lxc&node=pve&vmid=104"] = () => [200, answer("active", [old, cur], 2)];
    wrap(<MachineRuns target={target} />);
    const list = await screen.findByRole("list", { name: "Runs this machine served" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/Running/);
    expect(rows[1]!.textContent).toMatch(/Finished/);
    expect(within(rows[0]!).getByRole("link", { name: "open task" }).getAttribute("href")).toBe("/pve/acme/tasks/i9");
    expect(rows[0]!.textContent).toContain("Acme Works");
    expect(screen.getByText("2 more runs in organizations you can't see.")).toBeTruthy();
  });

  it("shows a worker's runs, and notes that a stale answer may be out of date", async () => {
    routes["/api/placements/resources?kind=worker&workerId=orion"] = () => [200, answer("stale", [wk()])];
    wrap(<MachineRuns target={{ kind: "worker", workerId: "orion" }} />);
    expect(await screen.findByText(/may be out of date/)).toBeTruthy();
    expect(screen.getByText("Not confirmed lately")).toBeTruthy();
  });

  it("only mentions hidden runs when the person sees none of them", async () => {
    routes["/api/placements/resources?kind=lxc&node=pve&vmid=104"] = () => [200, answer("restricted", [], 1)];
    wrap(<MachineRuns target={target} />);
    expect(await screen.findByText("1 more run in organizations you can't see.")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
