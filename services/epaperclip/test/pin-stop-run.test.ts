import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTS } from "../src/features/pin-act.ts";
import { approvalWait } from "../src/features/pin-act-run.ts";
import { parseStep } from "../src/features/pin-agent.ts";
import { STOP_RUN } from "../src/features/pin-stop-run.ts";
import { PlacementLedger } from "../src/placements.ts";
import { StateStore } from "../src/state.ts";
import { sseEvents } from "../src/pin.ts";
import { fakeEngine, fakeProviders } from "./fakes.ts";
import { startPinApp } from "./fakes-pin.ts";

const RUN = "r1234567-89ab";
const SHORT = "r1234567";
const T0 = "2026-11-14T12:00:00.000Z";
const run = (o: Record<string, unknown> = {}) => ({ id: RUN, companyId: "co-a", agentId: "ag-1", status: "running", startedAt: T0, error: null, ...o });

/** A stand-in engine: serves controllable run routes and passes everything else to the engine fake. */
async function engineStub(real: { url: string }) {
  const st = { runs: new Map<string, Record<string, unknown>>(), mine: ["co-a"], cancels: [] as string[], cancelResult: "cancelled" as string | "refuse", agentName: "Forge" as string | null };
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const p = new URL(req.url!, "http://x").pathname;
    let m: RegExpExecArray | null;
    if (req.method === "GET" && p === "/api/companies") return json(res, 200, st.mine.map((id) => ({ id, name: id === "co-a" ? "Acme Works" : "Globex", status: "active" })));
    if (req.method === "GET" && (m = /^\/api\/heartbeat-runs\/([^/]+)$/.exec(p))) { const r = st.runs.get(decodeURIComponent(m[1]!)); return r ? json(res, 200, r) : json(res, 404, { error: "Run not found" }); }
    if (req.method === "GET" && (m = /^\/api\/agents\/([^/]+)$/.exec(p)) && m[1] === "ag-1") return st.agentName ? json(res, 200, { id: "ag-1", name: st.agentName }) : json(res, 404, { error: "no" });
    if (req.method === "POST" && (m = /^\/api\/heartbeat-runs\/([^/]+)\/cancel$/.exec(p))) {
      const id = decodeURIComponent(m[1]!);
      st.cancels.push(id);
      if (st.cancelResult === "refuse") return json(res, 409, { error: "nope" });
      const r = st.runs.get(id);
      if (r) r.status = st.cancelResult;
      return json(res, 200, {});
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k)).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));
    try {
      const r = await fetch(real.url + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) });
      const out: Record<string, string | string[]> = {};
      r.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "transfer-encoding" && k !== "content-length") out[k] = v; });
      const sc = r.headers.getSetCookie?.() ?? [];
      if (sc.length) out["set-cookie"] = sc;
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch {
      // The real engine went away (the test is ending): answer like an engine that is down.
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { st, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => { server.closeAllConnections(); return new Promise<void>((r) => server.close(() => r())); } };
}

// ---- the action on its own, against a stub engine call

type Call = { method: string; path: string };
function host(o: { runs?: Record<string, Record<string, unknown>>; mine?: string[]; cancel?: "ok" | "refuse" | "stuck"; state?: StateStore; down?: boolean } = {}) {
  const calls: Call[] = [];
  const runs = new Map(Object.entries(o.runs ?? { [RUN]: run() }));
  const mine = { ids: o.mine ?? ["co-a"] };
  const call = async (method: string, path: string): Promise<unknown> => {
    calls.push({ method, path });
    if (o.down) throw Object.assign(new Error("down"), { status: 502 });
    let m: RegExpExecArray | null;
    if (path === "/api/companies") return mine.ids.map((id) => ({ id }));
    if ((m = /^\/api\/heartbeat-runs\/([^/]+)$/.exec(path))) { const r = runs.get(decodeURIComponent(m[1]!)); if (!r) throw Object.assign(new Error("nf"), { status: 404 }); return r; }
    if (/^\/api\/agents\//.test(path)) return { name: "Forge" };
    if ((m = /^\/api\/heartbeat-runs\/([^/]+)\/cancel$/.exec(path))) {
      if (o.cancel === "refuse") throw Object.assign(new Error("no"), { status: 409 });
      if (o.cancel !== "stuck") runs.get(decodeURIComponent(m[1]!))!.status = "cancelled";
      return {};
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const h = { node: "pve", username: "sam@pve", pve: async () => { throw new Error("no proxmox"); }, apps: { pin: {} as never, call: call as never }, ...(o.state ? { state: o.state } : {}) };
  return { h, calls, runs, mine, cancels: () => calls.filter((c) => c.method === "POST") };
}

describe("stop_run, proposing", () => {
  it("only accepts a run id; a binding the model supplies is not trusted", () => {
    expect(STOP_RUN.parse({ runId: RUN })).toEqual({ runId: RUN });
    expect(() => STOP_RUN.parse({ runId: "../x" })).toThrow(/run id/);
    expect(() => STOP_RUN.parse({ runId: RUN, force: true })).toThrow(/no field force\. It takes one field, runId/);
    expect(STOP_RUN.parse({ runId: RUN, expect: { nonsense: 1 } })).toEqual({ runId: RUN });
    expect(STOP_RUN.risk({})).toBe("destructive");
    expect(STOP_RUN.describe({ runId: RUN })).toEqual({ label: `Stop run ${SHORT}`, phrase: `stop run ${SHORT}` });
  });

  it("reads the run as the person and binds what it looks like, in words from the engine", async () => {
    const state = new StateStore(null);
    new PlacementLedger(state).sync("pve", [{ id: "l1", companyId: "co-a", heartbeatRunId: RUN, status: "active", provider: "proxmox", providerLeaseId: "pve/104", acquiredAt: T0, metadata: {} }], { complete: true });
    const { h } = host({ state });
    const a = await STOP_RUN.prepare!(h as never, { runId: RUN }, new Map());
    expect(a).toEqual({ runId: RUN, expect: { companyId: "co-a", agentId: "ag-1", status: "running", startedAt: T0, summary: `Forge's running run, started ${T0}, in container 104` } });
    expect(STOP_RUN.describe(a).label).toBe(`Stop run ${SHORT}: Forge's running run, started ${T0}, in container 104`);
  });

  it("refuses a run that is another organization's, or doesn't exist, in the same words, and one that is finished", async () => {
    const other = await STOP_RUN.prepare!(host({ runs: { [RUN]: run({ companyId: "co-b" }) } }).h as never, { runId: RUN }, new Map()).catch((e) => e.message);
    const missing = await STOP_RUN.prepare!(host({ runs: {} }).h as never, { runId: RUN }, new Map()).catch((e) => e.message);
    expect(other).toBe(`There is no run ${RUN} that you can see.`);
    expect(missing).toBe(other);
    await expect(STOP_RUN.prepare!(host({ runs: { [RUN]: run({ status: "succeeded" }) } }).h as never, { runId: RUN }, new Map())).rejects.toThrow(/already succeeded; there is nothing to stop/);
  });

  it("says so when the engine can't be asked, or isn't set up", async () => {
    await expect(STOP_RUN.prepare!(host({ down: true }).h as never, { runId: RUN }, new Map())).rejects.toThrow(/Couldn't check which organizations/);
    await expect(STOP_RUN.prepare!({ node: "pve", username: "x", pve: async () => { throw new Error("x"); } } as never, { runId: RUN }, new Map())).rejects.toThrow(/engine isn't set up/);
  });
});

describe("stop_run, approving", () => {
  const bound = async (o: Parameters<typeof host>[0] = {}) => {
    const x = host(o);
    const a = await STOP_RUN.prepare!(x.h as never, { runId: RUN }, new Map());
    x.calls.length = 0;
    return { ...x, a };
  };

  it("stops the run it was shown, and writes what the engine says now", async () => {
    const { h, a, calls, runs } = await bound();
    const r = await STOP_RUN.run(h as never, a);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: `/api/heartbeat-runs/${RUN}/cancel` }]);
    expect(runs.get(RUN)!.status).toBe("cancelled");
    expect(r.result).toBe(`Cancelled run ${SHORT} (Forge's running run, started ${T0}). Status before: running. Status now: cancelled.`);
  });

  it("says when the engine is still stopping it, rather than claiming it stopped", async () => {
    const { h, a } = await bound({ cancel: "stuck" });
    expect((await STOP_RUN.run(h as never, a)).result).toMatch(/Status now: running \(the engine is still stopping it\)\./);
  });

  it("rejects a stale approval: the run changed after it was proposed, and nothing is stopped", async () => {
    const queued = await bound({ runs: { [RUN]: run({ status: "queued", startedAt: null }) } });
    queued.runs.set(RUN, run({ status: "running", startedAt: T0 })); // it started while the person was deciding
    await expect(STOP_RUN.run(queued.h as never, queued.a)).rejects.toThrow(/changed after it was proposed \(it was queued, it is now running, and has started\), so NOTHING was stopped/);
    expect(queued.cancels()).toHaveLength(0);

    const restarted = await bound();
    restarted.runs.set(RUN, run({ startedAt: "2026-11-14T12:30:00.000Z" })); // a different attempt
    await expect(STOP_RUN.run(restarted.h as never, restarted.a)).rejects.toThrow(/changed after it was proposed/);
    expect(restarted.cancels()).toHaveLength(0);
  });

  it("does nothing, and says so, when the run has already finished", async () => {
    const x = await bound();
    x.runs.set(RUN, run({ status: "succeeded" }));
    expect((await STOP_RUN.run(x.h as never, x.a)).result).toBe(`Run ${SHORT} is no longer active (it is succeeded), so NOTHING was stopped.`);
    expect(x.cancels()).toHaveLength(0);
  });

  it("checks the person's access again at approval, and stops nothing if it is gone", async () => {
    const x = await bound();
    x.mine.ids = ["co-z"]; // they were removed from the organization
    await expect(STOP_RUN.run(x.h as never, x.a)).rejects.toThrow(/isn't available to you any more, so NOTHING was stopped/);
    expect(x.cancels()).toHaveLength(0);
    const y = await bound();
    y.runs.delete(RUN);
    await expect(STOP_RUN.run(y.h as never, y.a)).rejects.toThrow(/isn't available to you any more/);
  });

  it("refuses an approval that doesn't carry the run it was proposed against, or one for another run", async () => {
    const x = await bound();
    await expect(STOP_RUN.run(x.h as never, { runId: RUN })).rejects.toThrow(/doesn't carry what the run looked like/);
    await expect(STOP_RUN.run(x.h as never, { runId: RUN, expect: { ...(x.a.expect as object), agentId: "ag-2" } })).rejects.toThrow(/isn't the run that was proposed/);
    expect(x.cancels()).toHaveLength(0);
  });

  it("reports an engine that refuses the cancel, without claiming it stopped", async () => {
    const x = await bound({ cancel: "refuse" });
    await expect(STOP_RUN.run(x.h as never, x.a)).rejects.toThrow(/refused to cancel the run.*may still be running/);
  });
});

describe("stop_run can't be smuggled in", () => {
  it("is refused inside a written plan, an automation or a connected app's plan, and allowed only on Pin's own path", () => {
    const step = { kind: "act", tool: "stop_run", params: { runId: RUN } };
    expect(() => parseStep(step)).toThrow(/can only be proposed by calling it directly/);
    expect(parseStep(step, { direct: true })).toMatchObject({ kind: "act", args: { tool: "stop_run", params: { runId: RUN } } });
    expect(ACTS.stop_run!.directOnly).toBe(true);
  });
});

// ---- the whole path: Pin proposes, the person approves with the typed phrase, the engine cancels, the receipt is written

const KEY = "sk-test-0123456789abcdefWXYZ";
let eng: Awaited<ReturnType<typeof fakeEngine>>;
let stub: Awaited<ReturnType<typeof engineStub>>;
let prov: Awaited<ReturnType<typeof fakeProviders>>;
let h: Awaited<ReturnType<typeof startPinApp>>;
let sam: string;
type Ev = { event: string; data: any };

beforeEach(async () => {
  Object.assign(approvalWait, { pollMs: 15, pingMs: 60_000, maxMs: 15 * 60_000 });
  eng = await fakeEngine({ bootstrap: "ready" });
  stub = await engineStub(eng);
  stub.st.runs.set(RUN, run());
  prov = await fakeProviders();
  h = await startPinApp({ providers: prov.fetch, engine: { url: stub.url, sleep: async () => {} } });
  sam = await h.signIn("sam");
  await h.call("PUT", "/api/connectors/anthropic/credential", { cookie: sam }, { apiKey: KEY });
  await h.call("PUT", "/api/pin/settings", { cookie: sam }, { provider: "anthropic", model: "m-1", mode: "agent" });
});
afterEach(async () => {
  await h.close();
  await prov.close();
  await stub.close();
  await eng.close();
});

const script = (input: unknown, name = "stop_run") => {
  prov.set((req, res) => {
    const body = JSON.parse(req.body);
    const answered = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    if (answered) {
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } });
    } else {
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu0", name, input: {} } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } });
    }
    res.end();
  });
};
const startChat = async () => {
  const r = await h.call("POST", "/api/pin/chat", { cookie: sam }, { messages: [{ role: "user", content: "Stop this run" }], context: {} });
  const out: Ev[] = [];
  const done = (async () => { for await (const e of sseEvents(r.body as unknown as AsyncIterable<Uint8Array>)) out.push({ event: e.event, data: JSON.parse(e.data) }); return out; })();
  return { out, done };
};
const waitFor = async (f: () => boolean) => { for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); expect(f()).toBe(true); };
const decide = (planId: string, stepId: string, action: "approve" | "reject", confirm?: string) => h.call("POST", `/api/pin/plans/${planId}/steps/${stepId}/${action}`, { cookie: sam }, confirm ? { confirm } : {});
const audit = async () => JSON.stringify(await (await h.call("GET", "/api/access/audit", { cookie: sam })).json());

describe("Pin stops a run, end to end", () => {
  it("proposes the exact run, waits for the typed phrase, cancels only then, and leaves a receipt", async () => {
    script({ runId: RUN });
    const { out, done } = await startChat();
    await waitFor(() => out.some((e) => e.event === "approval"));
    const a = out.find((e) => e.event === "approval")!.data;
    expect(a).toMatchObject({ name: "stop_run", destructive: true, confirmPhrase: `stop run ${SHORT}`, risk: "destructive" });
    expect(a.label).toBe(`Stop run ${SHORT}: Forge's running run, started ${T0}`);
    expect(stub.st.cancels).toEqual([]); // nothing happened yet

    expect((await decide(a.planId, a.stepId, "approve")).status).toBe(409); // no phrase
    expect((await decide(a.planId, a.stepId, "approve", "stop run")).status).toBe(409); // wrong phrase
    expect(stub.st.cancels).toEqual([]);
    expect((await decide(a.planId, a.stepId, "approve", `stop run ${SHORT}`)).status).toBe(200);

    const ev = await done;
    expect(ev.find((e) => e.event === "tool" && e.data.status === "done")!.data.result).toBe(`Cancelled run ${SHORT} (Forge's running run, started ${T0}). Status before: running. Status now: cancelled.`);
    expect(stub.st.cancels).toEqual([RUN]);
    const trail = await audit();
    expect(trail).toContain("pin.plan.propose");
    expect(trail).toContain("pin.plan.approve");
    expect(trail).toContain("(typed confirmation)");
    expect(trail).toContain(`Cancelled run ${SHORT}`); // the receipt carries what actually happened
    expect(trail).toContain("sam@pve");
  });

  it("rejects the approval if the run finished while the person was deciding", async () => {
    script({ runId: RUN });
    const { out, done } = await startChat();
    await waitFor(() => out.some((e) => e.event === "approval"));
    const a = out.find((e) => e.event === "approval")!.data;
    stub.st.runs.set(RUN, run({ status: "succeeded" }));
    expect((await decide(a.planId, a.stepId, "approve", `stop run ${SHORT}`)).status).toBe(200);
    const ev = await done;
    expect(ev.find((e) => e.event === "tool" && e.data.status === "done")!.data.result).toMatch(/no longer active \(it is succeeded\), so NOTHING was stopped/);
    expect(stub.st.cancels).toEqual([]);
  });

  it("rejects the approval, with the reason in words, if the run restarted or the person lost access", async () => {
    script({ runId: RUN });
    const first = await startChat();
    await waitFor(() => first.out.some((e) => e.event === "approval"));
    const a = first.out.find((e) => e.event === "approval")!.data;
    stub.st.runs.set(RUN, run({ startedAt: "2026-11-14T12:45:00.000Z" }));
    await decide(a.planId, a.stepId, "approve", `stop run ${SHORT}`);
    const ev = await first.done;
    expect(ev.find((e) => e.event === "tool" && e.data.status === "error")!.data.error).toMatch(/changed after it was proposed.*NOTHING was stopped/);

    stub.st.runs.set(RUN, run());
    const second = await startChat();
    await waitFor(() => second.out.some((e) => e.event === "approval"));
    const b = second.out.find((e) => e.event === "approval")!.data;
    stub.st.mine = ["co-z"];
    await decide(b.planId, b.stepId, "approve", `stop run ${SHORT}`);
    const ev2 = await second.done;
    expect(ev2.find((e) => e.event === "tool" && e.data.status === "error")!.data.error).toMatch(/isn't available to you any more, so NOTHING was stopped/);
    expect(stub.st.cancels).toEqual([]);
  });

  it("never proposes a run the person can't see or that already finished, and ignores a binding the model makes up", async () => {
    stub.st.runs.set("r-foreign", run({ id: "r-foreign", companyId: "co-b" }));
    stub.st.mine = ["co-a"];
    script({ runId: "r-foreign" });
    const foreign = await (await startChat()).done;
    expect(foreign.some((e) => e.event === "approval")).toBe(false);
    expect(foreign.find((e) => e.event === "tool" && e.data.status === "error")!.data.error).toBe("There is no run r-foreign that you can see.");

    stub.st.runs.set(RUN, run({ status: "failed" }));
    script({ runId: RUN });
    const finished = await (await startChat()).done;
    expect(finished.find((e) => e.event === "tool" && e.data.status === "error")!.data.error).toMatch(/already failed/);

    stub.st.runs.set(RUN, run());
    script({ runId: RUN, expect: { companyId: "co-a", agentId: "ag-1", status: "running", startedAt: T0, summary: "A harmless cleanup of nothing important" } });
    const forged = await startChat();
    await waitFor(() => forged.out.some((e) => e.event === "approval"));
    const label = forged.out.find((e) => e.event === "approval")!.data.label as string;
    expect(label).toContain("Forge's running run");
    expect(label).not.toContain("harmless");
    const ap = forged.out.find((e) => e.event === "approval")!.data;
    await decide(ap.planId, ap.stepId, "reject");
    await forged.done;
    expect(stub.st.cancels).toEqual([]);
  });

  it("can't be put into a written plan by the model: propose_plan refuses it and nothing is waiting for approval", async () => {
    await h.call("PUT", "/api/pin/settings", { cookie: sam }, { provider: "anthropic", model: "m-1", mode: "agent", permission: "plan" });
    script({ title: "Tidy up", steps: [{ kind: "act", tool: "stop_run", params: { runId: RUN, expect: { companyId: "co-a", agentId: "ag-1", status: "running", startedAt: T0, summary: "made up" } } }] }, "propose_plan");
    const ev = await (await startChat()).done;
    const failed = ev.find((e) => e.event === "tool" && e.data.status === "error");
    expect(JSON.stringify(failed?.data)).toMatch(/can only be proposed by calling it directly/);
    expect(ev.some((e) => e.event === "approval")).toBe(false);
    const plans = await (await h.call("GET", "/api/pin/plans", { cookie: sam })).json() as { plans?: unknown[] };
    expect(plans.plans ?? []).toHaveLength(0);
    expect(stub.st.cancels).toEqual([]);
  });
});
