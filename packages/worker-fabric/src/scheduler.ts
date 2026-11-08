import type { Capabilities } from "./protocol.ts";

/**
 * Worker selection: a pure, deterministic function. The same workers and request always give the same answer, and
 * every refusal says why, so the console and the provider can show it. Shell capacity (`shellSlots`) and inference
 * capacity (`inferenceSlots`) are separate budgets.
 */

export interface Requirements {
  arch?: string;
  tools?: string[];
  gpu?: boolean;
  localModel?: string;
  minFreeMemMb?: number;
}

export interface Candidate {
  id: string;
  name: string;
  state: "pending" | "adopted" | "revoked";
  online: boolean;
  draining: boolean;
  disabled: boolean;
  /** Organizations that may use this worker; null means all. */
  companies: string[] | null;
  shellSlots: number;
  inferenceSlots: number;
  /** Active shell leases and total leases on the worker. */
  shellLeases: number;
  inferenceLeases: number;
  freeMemMb: number | null;
  capabilities: Capabilities | null;
}

export interface SchedRequest {
  companyId: string;
  /** A specific worker, when the environment is pinned to one. */
  workerId?: string | null;
  requirements?: Requirements;
  needsInference?: boolean;
}

export interface Rejection { workerId: string; name: string; reasons: string[] }
export type Selection =
  | { ok: true; worker: Candidate; considered: number }
  | { ok: false; code: "no_match" | "offline" | "no_capacity"; reasons: Rejection[] };

export function rejections(w: Candidate, r: SchedRequest): string[] {
  const why: string[] = [];
  if (w.state !== "adopted") why.push(`not adopted (${w.state})`);
  if (w.disabled) why.push("disabled");
  if (w.draining) why.push("draining");
  if (!w.online) why.push("offline");
  if (w.companies && !w.companies.includes(r.companyId)) why.push("not allowed for this organization");
  const c = w.capabilities;
  const req = r.requirements ?? {};
  if (req.arch && c && c.arch !== req.arch) why.push(`architecture is ${c.arch}, needs ${req.arch}`);
  if (c) {
    for (const t of req.tools ?? []) if (!c.tools[t]) why.push(`missing tool ${t}`);
    if (req.gpu && !c.gpu.present) why.push("no GPU");
    if (req.localModel && !(c.inference?.models ?? []).some((m) => m.name === req.localModel)) why.push(`model ${req.localModel} is not installed`);
  } else if (req.arch || req.tools?.length || req.gpu || req.localModel) why.push("capabilities not reported yet");
  if (req.minFreeMemMb && (w.freeMemMb ?? c?.memMb ?? 0) < req.minFreeMemMb) why.push(`less than ${req.minFreeMemMb} MiB free memory`);
  if ((req.localModel || r.needsInference) && (w.inferenceSlots < 1 || !c?.inference)) why.push("no local inference runtime");
  return why;
}

export function select(workers: Candidate[], r: SchedRequest): Selection {
  const pool = r.workerId ? workers.filter((w) => w.id === r.workerId) : workers;
  const reasons: Rejection[] = [];
  const ok: Candidate[] = [];
  for (const w of pool) {
    const why = rejections(w, r);
    if (why.length) reasons.push({ workerId: w.id, name: w.name, reasons: why });
    else ok.push(w);
  }
  if (!ok.length) {
    const offline = reasons.length > 0 && reasons.every((x) => x.reasons.includes("offline"));
    return { ok: false, code: pool.length && offline ? "offline" : "no_match", reasons };
  }
  const free = ok.filter((w) => w.shellLeases < w.shellSlots);
  if (!free.length) return { ok: false, code: "no_capacity", reasons: ok.map((w) => ({ workerId: w.id, name: w.name, reasons: [`all ${w.shellSlots} shell slots are in use`] })) };
  free.sort((a, b) => (a.shellLeases + 1) / a.shellSlots - (b.shellLeases + 1) / b.shellSlots || a.shellLeases + a.inferenceLeases - (b.shellLeases + b.inferenceLeases) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { ok: true, worker: free[0]!, considered: pool.length };
}
