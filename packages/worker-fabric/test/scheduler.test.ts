import { describe, expect, it } from "vitest";
import { select, type Candidate, type Capabilities } from "../src/index.ts";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  os: { name: "Ubuntu", version: "24.04" }, arch: "arm64", hostname: "h", cpu: { model: "x", cores: 6 }, memMb: 8000, gpu: { present: true, kind: "jetson" },
  execution: { user: "worker", uid: 1001, shellSlots: 1, reserveMemoryMb: 1600 },
  storage: [], tools: { git: "2", node: "22", aider: "0.86.2" }, inference: { runtime: "ollama", url: "http://x", models: [{ name: "qwen2.5-coder:3b", digest: "sha" }], maxContext: 4096, qualifications: [{ suite: "slug-v1", model: "qwen2.5-coder:3b", digest: "sha", aiderVersion: "0.86.2", executedAs: "1001:worker", maxContext: 4096, passed: true, testedAt: 1 }] }, networks: [], workspaceRoot: "/workspaces", ...over,
});
const w = (id: string, over: Partial<Candidate> = {}): Candidate => ({ id, name: id, state: "adopted", online: true, draining: false, disabled: false, companies: null, shellSlots: 2, inferenceSlots: 1, shellLeases: 0, inferenceLeases: 0, freeMemMb: 5500, capabilities: caps(), ...over });

describe("scheduler", () => {
  it("is deterministic and prefers the least loaded worker", () => {
    const ws = [w("b", { shellLeases: 1 }), w("a", { shellLeases: 1 }), w("c")];
    expect(select(ws, { companyId: "co" })).toMatchObject({ ok: true, worker: { id: "c" } });
    const tie = [w("b"), w("a")];
    for (let i = 0; i < 5; i++) expect(select([...tie].reverse(), { companyId: "co" })).toMatchObject({ worker: { id: "a" } });
  });
  it("filters by state, scope, arch, tools, gpu, model and memory", () => {
    const base = { companyId: "co" };
    expect(select([w("a", { state: "revoked" })], base)).toMatchObject({ ok: false });
    expect(select([w("a", { disabled: true })], base)).toMatchObject({ ok: false });
    expect(select([w("a", { draining: true })], base)).toMatchObject({ ok: false });
    expect(select([w("a", { companies: ["other"] })], base)).toMatchObject({ ok: false });
    expect(select([w("a")], { ...base, requirements: { arch: "amd64" } })).toMatchObject({ ok: false });
    expect(select([w("a")], { ...base, requirements: { tools: ["docker"] } })).toMatchObject({ ok: false });
    expect(select([w("a", { capabilities: caps({ gpu: { present: false } }) })], { ...base, requirements: { gpu: true } })).toMatchObject({ ok: false });
    expect(select([w("a")], { ...base, requirements: { localModel: "llama3" } })).toMatchObject({ ok: false });
    expect(select([w("a")], { ...base, requirements: { localModel: "qwen2.5-coder:3b", minFreeMemMb: 3000, tools: ["git"], arch: "arm64", gpu: true } })).toMatchObject({ ok: true });
    expect(select([w("a", { freeMemMb: 100 })], { ...base, requirements: { minFreeMemMb: 3000 } })).toMatchObject({ ok: false });
  });
  it("reports offline and capacity distinctly, and honours a pinned worker", () => {
    expect(select([w("a", { online: false })], { companyId: "co" })).toMatchObject({ ok: false, code: "offline" });
    expect(select([w("a", { shellLeases: 2 })], { companyId: "co" })).toMatchObject({ ok: false, code: "no_capacity" });
    expect(select([w("a"), w("b")], { companyId: "co", workerId: "b" })).toMatchObject({ ok: true, worker: { id: "b" } });
    expect(select([w("a")], { companyId: "co", workerId: "zzz" })).toMatchObject({ ok: false, code: "no_match" });
  });
  it("never picks a node without a local runtime for an inference need", () => {
    expect(select([w("a", { inferenceSlots: 0, capabilities: caps({ inference: null }) })], { companyId: "co", needsInference: true })).toMatchObject({ ok: false });
  });
  it("does not replace missing telemetry with total RAM or swap", () => {
    expect(select([w("a", { freeMemMb: null })], { companyId: "co" })).toMatchObject({ ok: false, reasons: [{ reasons: ["fresh available-memory telemetry is required"] }] });
    expect(select([w("a", { freeMemMb: 374, capabilities: caps({ memory: { availableMb: 374, swapUsedMb: 124, swapTotalMb: 4096 } }) })], { companyId: "co" })).toMatchObject({ ok: false, code: "no_capacity" });
  });
  it("reserves memory and rejects invalid budgets", () => {
    expect(select([w("a", { reservedMemoryMb: 3072 })], { companyId: "co", requirements: { memoryMb: 3072 } })).toMatchObject({ ok: false, code: "no_capacity" });
    for (const memoryMb of [-1, NaN, Infinity, 0, 0.5]) expect(select([w("a")], { companyId: "co", requirements: { memoryMb } }).ok).toBe(false);
  });
  it("credits a resident shared-memory model only for the same digest and context", () => {
    const node = w("orion", { freeMemMb: 3400, loadedModels: [{ name: "qwen2.5-coder:3b", digest: "sha", ramMb: 2250, context: 4096 }] });
    const request = { companyId: "co", requirements: { localModel: "qwen2.5-coder:3b" } };
    expect(select([node], request).ok).toBe(true);
    for (const change of [{ digest: "other" }, { context: 2048 }]) {
      expect(select([{ ...node, loadedModels: [{ ...node.loadedModels![0]!, ...change }] }], request).ok).toBe(false);
    }
    expect(select([{ ...node, reservedMemoryMb: 3072 }], request).ok).toBe(false);
  });
  it("requires matching coding evidence, but cloud execution needs no local model", () => {
    for (const change of ["failed", "digest", "tool", "context", "account", "missing"]) {
      const c = caps();
      if (change === "failed") c.inference!.qualifications![0]!.passed = false;
      if (change === "digest") c.inference!.models[0]!.digest = "different";
      if (change === "tool") c.tools.aider = "different";
      if (change === "context") c.inference!.maxContext = 2048;
      if (change === "account") c.execution!.user = "someone-else";
      if (change === "missing") c.inference!.qualifications = [];
      expect(select([w("a", { capabilities: c })], { companyId: "co", requirements: { localModel: "qwen2.5-coder:3b" } }).ok, change).toBe(false);
    }
    expect(select([w("cloud", { inferenceSlots: 0, capabilities: caps({ gpu: { present: false }, inference: null }) })], { companyId: "co", requirements: { tools: ["git"] } }).ok).toBe(true);
  });
});
