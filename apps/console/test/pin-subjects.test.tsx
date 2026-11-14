// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/auth/session.tsx", () => ({
  useSession: () => ({ session: { mode: "live", user: { username: "ana@pve", name: "Ana", realm: "pve", node: "pve" } }, signOut: async () => {} }),
}));

import { EngineProvider } from "../src/data/store.tsx";
import { PinProvider, usePin, usePinSubject } from "../src/pin/PinContext.tsx";
import { PinSubjects, subjectSentence } from "../src/pin/PinSubjects.tsx";
import { toStreamEvent } from "../src/pin/live.ts";
import { setup, state } from "./engine-harness.tsx";

beforeEach(setup);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the context event", () => {
  it("reads what the host verified, and drops anything malformed", () => {
    expect(toStreamEvent({ event: "context", data: JSON.stringify({ items: [{ kind: "run", id: "r1", label: "Run", status: "unavailable" }, { kind: "machine", id: "104", label: "Container 104", status: "ok" }] }) })).toEqual({
      type: "context",
      items: [{ kind: "run", id: "r1", label: "Run", status: "unavailable" }, { kind: "machine", id: "104", label: "Container 104", status: "ok" }],
    });
    // an unknown kind, a missing id and a non-list are ignored; any status other than ok is treated as unavailable
    expect(toStreamEvent({ event: "context", data: JSON.stringify({ items: [{ kind: "vm", id: "1", label: "x" }, { kind: "run", label: "x" }, { kind: "run", id: "r2", label: "Run", status: "weird" }] }) })).toEqual({ type: "context", items: [{ kind: "run", id: "r2", label: "Run", status: "unavailable" }] });
    expect(toStreamEvent({ event: "context", data: "not json" })).toEqual({ type: "context", items: [] });
  });
});

describe("what a chip says", () => {
  it("says what Pin can see, what couldn't be read, and what was left out", () => {
    expect(subjectSentence({ label: "Container 104", included: true })).toBe("Container 104: Pin can see this. Press to leave it out.");
    expect(subjectSentence({ label: "Run: failed", included: true, status: "unavailable" })).toMatch(/couldn't read this for you.*organization you can't see/);
    expect(subjectSentence({ label: "Container 104", included: false })).toBe("Container 104: left out. Press to include it again.");
  });
});

function Probe({ run = true }: { run?: boolean }) {
  usePinSubject(run ? { kind: "run", id: "run1", label: "Run: failed", context: { runId: "run1", companyId: "c1" } } : null);
  usePinSubject({ kind: "machine", id: "104", label: "Container 104", context: { resource: { kind: "lxc", node: "pve", vmid: 104 } } });
  const pin = usePin();
  return <><PinSubjects /><button onClick={() => pin.send("why did it fail?")}>ask</button></>;
}

const bodies: any[] = [];
let verdict: unknown[] = [];
function stubChat() {
  const previous = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    if (new URL(input, "http://pve.lan").pathname === "/api/pin/chat") {
      bodies.push(JSON.parse(String(init.body)));
      const text = `event: context\ndata: ${JSON.stringify({ items: verdict })}\n\nevent: delta\ndata: ${JSON.stringify({ text: "ok" })}\n\nevent: done\ndata: {}\n\n`;
      return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return previous(input, init);
  });
}
function mount(run = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (r: boolean) => (
    <QueryClientProvider client={qc}><EngineProvider><MemoryRouter initialEntries={["/pve/home"]}><PinProvider><Probe run={r} /></PinProvider></MemoryRouter></EngineProvider></QueryClientProvider>
  );
  const view = render(tree(run));
  return { rerender: (r: boolean) => view.rerender(tree(r)) };
}
const ask = async () => { const n = bodies.length; fireEvent.click(screen.getByRole("button", { name: "ask" })); await waitFor(() => expect(bodies.length).toBe(n + 1)); return bodies.at(-1); };
const chip = (name: RegExp) => screen.getByRole("button", { name });

describe("what Pin is given from the page", () => {
  beforeEach(() => { bodies.length = 0; verdict = []; });

  it("shows what Pin sees, sends the ids of what is included, and sends nothing for what the person took out", async () => {
    state.routes["GET /api/pin/settings"] = () => [200, { provider: "anthropic", model: "m", mode: "assistant", permission: "plan", connectors: [] }];
    stubChat();
    mount();
    const group = await screen.findByRole("group", { name: "What Pin can see here" });
    expect(group.textContent).toContain("Run: failed");
    expect(group.textContent).toContain("Container 104");
    expect(chip(/^Run: failed/).getAttribute("aria-pressed")).toBe("true");

    const first = await ask();
    expect(first.context).toMatchObject({ device: "pve", companyId: "c1", runId: "run1", resource: { kind: "lxc", node: "pve", vmid: 104 } });

    fireEvent.click(chip(/^Run: failed/));
    expect(chip(/^Run: failed/).getAttribute("aria-pressed")).toBe("false");
    const second = await ask();
    expect(second.context.runId).toBeUndefined();
    expect(second.context.companyId).toBeUndefined();
    expect(second.context.resource).toEqual({ kind: "lxc", node: "pve", vmid: 104 });

    fireEvent.click(chip(/^Run: failed/)); // put it back
    expect((await ask()).context.runId).toBe("run1");
  });

  it("shows when the host couldn't read something for the person, without saying why", async () => {
    verdict = [{ kind: "run", id: "run1", label: "Run", status: "unavailable" }, { kind: "machine", id: "104", label: "Container 104", status: "ok" }];
    stubChat();
    mount();
    await screen.findByRole("group", { name: "What Pin can see here" });
    await ask();
    await waitFor(() => expect(chip(/^Run: failed/).getAttribute("aria-label")).toMatch(/couldn't read this for you/));
    expect(chip(/^Container 104/).getAttribute("aria-label")).toBe("Container 104: Pin can see this. Press to leave it out.");
  });

  it("forgets what the person took out when they leave that page, and drops the chip", async () => {
    stubChat();
    const m = mount();
    await screen.findByRole("group", { name: "What Pin can see here" });
    fireEvent.click(chip(/^Run: failed/));
    m.rerender(false); // the run is no longer on screen
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Run: failed/ })).toBeNull());
    expect(screen.getByRole("button", { name: /^Container 104/ })).toBeTruthy();
    m.rerender(true); // back on a run: included again
    await waitFor(() => expect(chip(/^Run: failed/).getAttribute("aria-pressed")).toBe("true"));
    act(() => {});
  });

  it("shows nothing when the page has nothing for Pin", async () => {
    const qc = new QueryClient();
    function Bare() { const pin = usePin(); return <><PinSubjects /><span>{pin.subjects.length}</span></>; }
    render(<QueryClientProvider client={qc}><EngineProvider><MemoryRouter><PinProvider><Bare /></PinProvider></MemoryRouter></EngineProvider></QueryClientProvider>);
    expect(await screen.findByText("0")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "What Pin can see here" })).toBeNull();
  });
});
