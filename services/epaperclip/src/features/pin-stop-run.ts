import { PlacementLedger } from "../placements.ts";
import { ActProblem } from "./act-problem.ts";
import type { ActDef, ActHost } from "./pin-act.ts";

/**
 * Pin's `stop_run`: cancel one of the person's agent runs (docs/PIN-STOP-RUN.md).
 *
 * The approval is for exactly the run Pin showed, as it was then. So:
 * - when Pin proposes it, the server reads the run as the person and binds what it looked like (its organization, agent,
 *   status and start time) into the step, together with a one-line summary written here from the engine's answer, never
 *   from the model's words;
 * - when the person approves, the server reads the run again, as them, and stops only if it is still the same run in the
 *   same state. A run that finished, started, or changed in between is NOT stopped: the person is told and asked to approve
 *   what it is now (a stale approval is rejected);
 * - the person's access is checked again at that moment, and a run they can no longer see is reported only as unavailable.
 *
 * It can only be proposed by calling the tool directly in Agent mode (`directOnly`), so a plan written by the model, by an
 * automation or by a connected app can't carry a binding that wasn't made here.
 */

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE = new Set(["queued", "running"]);

export interface RunBinding {
  companyId: string;
  agentId: string;
  status: string;
  /** The engine's start time as it reported it, or null if the run had not started. */
  startedAt: string | null;
  /** One line for the person to read on the approval, built from the engine's answer. */
  summary: string;
}

type Run = Record<string, unknown>;

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const shortId = (id: string) => id.slice(0, 8);

function binding(raw: unknown): RunBinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.companyId !== "string" || typeof b.agentId !== "string" || typeof b.status !== "string" || typeof b.summary !== "string") return null;
  if (b.startedAt !== null && typeof b.startedAt !== "string") return null;
  return { companyId: b.companyId.slice(0, 64), agentId: b.agentId.slice(0, 64), status: b.status.slice(0, 40), startedAt: (b.startedAt as string | null) === null ? null : (b.startedAt as string).slice(0, 40), summary: text(b.summary, 300) };
}

function engineOf(h: ActHost) {
  const call = h.apps?.call;
  if (!call) throw new ActProblem("The engine isn't set up on this host, so a run can't be stopped from here.");
  return call;
}

/** The organizations the person belongs to, as the engine reports them to them. */
async function mine(call: NonNullable<ActHost["apps"]>["call"]): Promise<Set<string>> {
  let rows: unknown;
  try {
    rows = await call("GET", "/api/companies");
  } catch {
    throw new ActProblem("Couldn't check which organizations you belong to right now, so NOTHING was stopped.");
  }
  return new Set((Array.isArray(rows) ? rows : []).flatMap((r) => (r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string" ? [(r as { id: string }).id] : [])));
}

/** The run as the engine reports it to this person, or null when it isn't theirs to see or isn't there. */
async function readRun(call: NonNullable<ActHost["apps"]>["call"], id: string, companies: Set<string>): Promise<Run | null> {
  try {
    const r = await call("GET", `/api/heartbeat-runs/${encodeURIComponent(id)}`);
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    const run = r as Run;
    return typeof run.companyId === "string" && companies.has(run.companyId) ? run : null;
  } catch (e) {
    const status = (e as { status?: unknown })?.status;
    if (status === 401 || status === 403 || status === 404) return null;
    throw new ActProblem("The engine couldn't be reached to check the run, so NOTHING was stopped.");
  }
}

export const STOP_RUN: ActDef = {
  name: "stop_run",
  description:
    "Cancel one agent run that is queued or running, by its run id. The person sees exactly which run (its agent and where it is running) and must approve with a typed phrase. A run that has already finished can't be stopped. Use only when the person asks to stop a specific run.",
  parameters: { type: "object", properties: { runId: { type: "string", description: "The run's id, as given in the verified context or a tool result" } }, required: ["runId"], additionalProperties: false },
  directOnly: true,
  parse(r) {
    for (const k of Object.keys(r)) if (k !== "runId" && k !== "expect") throw new ActProblem(`stop_run has no field ${k}. It takes one field, runId: the run's id.`);
    if (typeof r.runId !== "string" || !RUN_ID.test(r.runId)) throw new ActProblem("runId must be a run id");
    const expect = r.expect === undefined ? null : binding(r.expect);
    return { runId: r.runId, ...(expect ? { expect } : {}) };
  },
  // A stopped run can't be resumed, so this is in the class that needs a typed phrase, even in the permissive modes.
  risk: () => "destructive",
  describe: (a) => {
    const e = binding(a.expect);
    return { label: `Stop run ${shortId(String(a.runId))}${e ? `: ${e.summary}` : ""}`, phrase: `stop run ${shortId(String(a.runId))}` };
  },
  async prepare(h, a) {
    const call = engineOf(h);
    const id = String(a.runId);
    const companies = await mine(call);
    const run = await readRun(call, id, companies);
    // A run that doesn't exist and one that belongs to someone else read the same.
    if (!run) throw new ActProblem(`There is no run ${id} that you can see.`);
    const status = text(run.status, 40);
    if (!ACTIVE.has(status)) throw new ActProblem(`Run ${id} is already ${status || "finished"}; there is nothing to stop.`);
    const agentId = text(run.agentId, 64);
    let agent = agentId;
    try {
      const a2 = await call("GET", `/api/agents/${encodeURIComponent(agentId)}`);
      const n = a2 && typeof a2 === "object" ? text((a2 as { name?: unknown }).name, 80) : "";
      if (n) agent = n;
    } catch {
      /* the id stands in for the name */
    }
    const where = h.state ? whereOf(h.state, id, companies) : null;
    const startedAt = typeof run.startedAt === "string" ? run.startedAt : null;
    const summary = `${agent}'s ${status === "queued" ? "queued" : "running"} run${startedAt ? `, started ${startedAt}` : ", not started yet"}${where ? `, ${where}` : ""}`;
    const bound: RunBinding = { companyId: String(run.companyId), agentId, status, startedAt, summary: text(summary, 300) };
    return { runId: id, expect: bound };
  },
  async run(h, a) {
    const call = engineOf(h);
    const id = String(a.runId);
    const exp = binding(a.expect);
    if (!exp) throw new ActProblem("This approval doesn't carry what the run looked like when it was proposed, so it can't be checked. NOTHING was stopped. Ask Pin to propose it again.");
    const companies = await mine(call);
    const cur = await readRun(call, id, companies);
    if (!cur) throw new ActProblem(`Run ${id} isn't available to you any more, so NOTHING was stopped.`);
    if (cur.companyId !== exp.companyId || cur.agentId !== exp.agentId) throw new ActProblem("That isn't the run that was proposed, so NOTHING was stopped. Ask Pin to propose it again.");
    const status = text(cur.status, 40);
    if (!ACTIVE.has(status)) return { result: `Run ${shortId(id)} is no longer active (it is ${status || "finished"}), so NOTHING was stopped.` };
    const startedAt = typeof cur.startedAt === "string" ? cur.startedAt : null;
    if (status !== exp.status || startedAt !== exp.startedAt) {
      throw new ActProblem(`The run changed after it was proposed (it was ${exp.status}, it is now ${status}${startedAt && !exp.startedAt ? ", and has started" : ""}), so NOTHING was stopped. Ask Pin to propose it again so you approve what it is now.`);
    }
    try {
      await call("POST", `/api/heartbeat-runs/${encodeURIComponent(id)}/cancel`, {});
    } catch {
      throw new ActProblem("The engine refused to cancel the run (or couldn't be reached). It may still be running.");
    }
    // Read it again so the receipt says what the engine reports now, not what was asked for.
    let after = "unknown";
    try {
      const r = await call("GET", `/api/heartbeat-runs/${encodeURIComponent(id)}`);
      after = r && typeof r === "object" ? text((r as Run).status, 40) || "unknown" : "unknown";
    } catch {
      /* reported as unknown */
    }
    const settled = after === "cancelled" || !ACTIVE.has(after);
    return { result: `Cancelled run ${shortId(id)} (${exp.summary}). Status before: ${exp.status}. Status now: ${after}${settled ? "" : " (the engine is still stopping it)"}.` };
  },
};

/** Where the run is or was, from the placement ledger, limited to the person's organizations. */
function whereOf(state: NonNullable<ActHost["state"]>, runId: string, companies: Set<string>): string | null {
  const ledger = new PlacementLedger(state);
  const { placements } = ledger.forRun(runId, (c) => companies.has(c));
  const p = placements[placements.length - 1];
  if (!p?.resource) return null;
  const live = p.state === "active" || p.state === "retained" || p.state === "cleanup_pending";
  const name = p.resource.kind === "lxc" ? `container ${p.resource.vmid}` : `worker ${p.resource.workerId}`;
  return live ? `in ${name}` : `it was in ${name}`;
}

/**
 * `stop_run` as Pin offers it in Assistant mode and in Agent mode with the "plan" permission, where nothing runs inside the
 * chat: the call writes a one-step plan, bound to the run exactly as in Agent mode, which the person approves on Pin's Plans
 * tab by typing the phrase. The run is checked again when they approve, which may be much later.
 */
export const STOP_RUN_PROPOSAL = {
  name: "stop_run",
  action: true as const,
  description:
    "Propose stopping one agent run that is queued or running, by its run id. It is written down as a plan for the person to approve on Pin's Plans tab by typing a phrase; nothing is stopped until they do, and the run is checked again then. A run that has already finished can't be stopped. Use only when the person asks to stop a specific run.",
  parameters: STOP_RUN.parameters,
};
