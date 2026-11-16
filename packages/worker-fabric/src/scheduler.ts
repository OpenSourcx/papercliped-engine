import type { Capabilities, Heartbeat } from "./protocol.ts";
import { codingProfile, DEFAULT_JOB_MEMORY_MB, workerLimits } from "./resources.ts";

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
  /** Physical memory reserved until this lease is released. */
  memoryMb?: number;
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
  reservedMemoryMb?: number;
  loadedModels?: Heartbeat["loadedModels"];
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

export function reservationMb(r: SchedRequest): number {
  const req = r.requirements ?? {};
  return Math.max(DEFAULT_JOB_MEMORY_MB, req.memoryMb ?? 0, req.minFreeMemMb ?? 0,
    req.localModel ? codingProfile(req.localModel)?.memoryMb ?? 0 : r.needsInference ? 2048 : 0);
}

export function requirementErrors(req: Requirements = {}): string[] {
  return ["memoryMb", "minFreeMemMb"].flatMap((key) => {
    const n = req[key as "memoryMb" | "minFreeMemMb"];
    return n !== undefined && (!Number.isSafeInteger(n) || n < 1) ? [`${key} must be a positive integer in MiB`] : [];
  });
}

export function rejections(w: Candidate, r: SchedRequest): string[] {
  const why: string[] = [];
  if (w.state !== "adopted") why.push(`not adopted (${w.state})`);
  if (w.disabled) why.push("disabled");
  if (w.draining) why.push("draining");
  if (!w.online) why.push("offline");
  if (w.companies && !w.companies.includes(r.companyId)) why.push("not allowed for this organization");
  const c = w.capabilities;
  const req = r.requirements ?? {};
  why.push(...requirementErrors(req));
  if (req.arch && c && c.arch !== req.arch) why.push(`architecture is ${c.arch}, needs ${req.arch}`);
  if (c) {
    for (const t of req.tools ?? []) if (!c.tools[t]) why.push(`missing tool ${t}`);
    if (req.gpu && !c.gpu.present) why.push("no GPU");
    if (req.localModel && !(c.inference?.models ?? []).some((m) => m.name === req.localModel)) why.push(`model ${req.localModel} is not installed`);
    if (req.localModel) {
      const model = c.inference?.models.find((m) => m.name === req.localModel);
      const context = Math.min(c.inference?.maxContext ?? 4096, codingProfile(req.localModel)?.maxContext ?? Infinity);
      const qualified = c.inference?.qualifications?.some((q) => q.suite === "slug-v1" && q.passed && q.model === model?.name && !!model.digest && q.digest === model.digest && q.aiderVersion === c.tools.aider && c.execution && q.executedAs === `${c.execution.uid}:${c.execution.user}` && q.maxContext === context);
      if (!qualified) why.push(`model ${req.localModel} has no passing coding qualification for this worker account and context`);
      if (!codingProfile(req.localModel) && !req.memoryMb) why.push("unknown model memory budget; set memoryMb after measurement");
    }
  } else if (req.arch || req.tools?.length || req.gpu || req.localModel) why.push("capabilities not reported yet");
  const reserve = c ? workerLimits(c).reserveMemoryMb : 1024;
  const budget = reservationMb(r);
  // A warm model already occupies physical RAM. Credit only a matching digest AND context;
  // otherwise its memory must be budgeted again for a cold load. Physical total still caps admission.
  const model = c?.inference?.models.find((m) => m.name === req.localModel);
  const context = Math.min(c?.inference?.maxContext ?? 4096, codingProfile(req.localModel ?? "")?.maxContext ?? Infinity);
  const loaded = model?.digest ? w.loadedModels?.find((m) => m.name === model.name && m.digest === model.digest && m.context === context) : undefined;
  const credit = loaded && Number.isFinite(loaded.ramMb) ? Math.max(0, Math.min(loaded.ramMb, budget - DEFAULT_JOB_MEMORY_MB)) : 0;
  if (w.freeMemMb === null || !Number.isFinite(w.freeMemMb)) why.push("fresh available-memory telemetry is required");
  else if (Math.min(w.freeMemMb + credit, c?.memMb ?? 0) - reserve - (w.reservedMemoryMb ?? 0) < budget) {
    why.push(`memory capacity: needs ${budget} MiB plus ${reserve} MiB headroom; ${w.reservedMemoryMb ?? 0} MiB already reserved`);
  }
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
    const capacity = reasons.some((x) => x.reasons.some((why) => why.startsWith("memory capacity:")));
    return { ok: false, code: pool.length && offline ? "offline" : capacity ? "no_capacity" : "no_match", reasons };
  }
  const free = ok.filter((w) => w.shellLeases < w.shellSlots);
  if (!free.length) return { ok: false, code: "no_capacity", reasons: ok.map((w) => ({ workerId: w.id, name: w.name, reasons: [`all ${w.shellSlots} shell slots are in use`] })) };
  free.sort((a, b) => (a.shellLeases + 1) / a.shellSlots - (b.shellLeases + 1) / b.shellSlots || a.shellLeases + a.inferenceLeases - (b.shellLeases + b.inferenceLeases) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { ok: true, worker: free[0]!, considered: pool.length };
}
