import { describe, expect, it } from "vitest";
import { select, type Candidate, type Capabilities } from "../src/index.ts";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  os: { name: "Ubuntu", version: "24.04" }, arch: "arm64", hostname: "h", cpu: { model: "x", cores: 6 }, memMb: 8000, gpu: { present: true, kind: "jetson" },
  storage: [], tools: { git: "2", node: "22" }, inference: { runtime: "ollama", url: "http://x", models: [{ name: "qwen2.5-coder:3b" }], maxContext: 4096 }, networks: [], workspaceRoot: "/workspaces", ...over,
});
const w = (id: string, over: Partial<Candidate> = {}): Candidate => ({ id, name: id, state: "adopted", online: true, draining: false, disabled: false, companies: null, shellSlots: 2, inferenceSlots: 1, shellLeases: 0, inferenceLeases: 0, freeMemMb: 4000, capabilities: caps(), ...over });

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
});
