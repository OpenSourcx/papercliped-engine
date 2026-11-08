import { describe, expect, it, vi } from "vitest";
import {
  classifyTask, createJevProvider, createTaskRouter, createTypeSafeAsk, decide, DEFAULT_TRUTH_TABLE, DEFAULT_ROUTING_TABLE, fakeJevAsk,
  parseRoutingTable, FILES_OPTIONS, type Band, type TaskContract, type RoutingTable,
} from "../src/index.ts";

const small: TaskContract = { goal: "Fix the typo in makeLabel", filesAllowed: ["src/label.ts"], testCommand: "pnpm test", expectedDiffLines: 5 };

describe("classifier", () => {
  it("sends a small one-file task with a test to local-small", () => expect(classifyTask(small).tier).toBe("local-small"));
  it("sends every risk tag to claude, whatever the size", () => {
    for (const tag of ["auth", "billing", "tenancy", "security", "AUTH"]) expect(classifyTask({ ...small, riskTags: [tag] }).tier).toBe("claude");
  });
  it("treats a risky path like a risk tag", () => expect(classifyTask({ ...small, filesAllowed: ["src/billing/invoice.ts"] }).tier).toBe("claude"));
  it("sends unbounded file access to claude", () => expect(classifyTask({ ...small, filesAllowed: [] }).tier).toBe("claude"));
  it("moves up with files and diff size", () => {
    expect(classifyTask({ ...small, filesAllowed: ["a", "b"] }).tier).toBe("free-cloud");
    expect(classifyTask({ ...small, expectedDiffLines: 100 }).tier).toBe("free-cloud");
    expect(classifyTask({ ...small, expectedDiffLines: 500 }).tier).toBe("claude");
    expect(classifyTask({ ...small, filesAllowed: ["a", "b", "c", "d"] }).tier).toBe("claude");
  });
  it("does not trust a cheap tier without a test or a known size", () => {
    expect(classifyTask({ ...small, testCommand: undefined }).tier).toBe("free-cloud");
    expect(classifyTask({ ...small, expectedDiffLines: undefined }).tier).toBe("free-cloud");
  });
});

describe("routing table", () => {
  it("accepts the default and rejects bad ones with a sentence", () => {
    expect(parseRoutingTable(DEFAULT_ROUTING_TABLE)).toEqual(DEFAULT_ROUTING_TABLE);
    expect(() => parseRoutingTable(null)).toThrow(/targets/);
    expect(() => parseRoutingTable({ targets: {}, chain: [] })).toThrow(/empty/);
    expect(() => parseRoutingTable({ targets: {}, chain: ["gpu"] })).toThrow(/Unknown tier/);
    expect(() => parseRoutingTable({ targets: {}, chain: ["claude", "local-small"] })).toThrow(/cheapest/);
    expect(() => parseRoutingTable({ targets: { claude: {} }, chain: ["claude"] })).toThrow(/adapterType/);
  });
});

describe("fallback chain", () => {
  const r = createTaskRouter();
  it("climbs one tier per escalate and stops at the end", async () => {
    const d1 = await r.route(small);
    expect(d1.tier).toBe("local-small");
    const d2 = r.next(d1, { status: "escalate" })!;
    expect(d2.tier).toBe("free-cloud");
    expect(d2.target).toEqual(DEFAULT_ROUTING_TABLE.targets["free-cloud"]);
    const d3 = r.next(d2, { status: "escalate", note: "tests still fail" })!;
    expect(d3.tier).toBe("claude");
    expect(d3.reasons[0]).toMatch(/tests still fail/);
    expect(r.next(d3, { status: "escalate" })).toBeNull();
  });
  it("does not move on success or plain failure", async () => {
    const d = await r.route(small);
    expect(r.next(d, { status: "ok" })).toBeNull();
    expect(r.next(d, { status: "failed" })).toBeNull();
  });
  it("honours an organization's own chain and never goes below the wanted tier", async () => {
    const table: RoutingTable = { targets: { "free-cloud": { adapterType: "opencode_local", model: "m1" }, claude: { adapterType: "claude_local" } }, chain: ["free-cloud", "claude"] };
    const rr = createTaskRouter({ table });
    expect((await rr.route(small)).target.model).toBe("m1"); // local-small wanted, first available is free-cloud
    expect((await rr.route({ ...small, riskTags: ["auth"] })).tier).toBe("claude");
    const noClaude = createTaskRouter({ table: { targets: { "free-cloud": { adapterType: "x" } }, chain: ["free-cloud"] } });
    await expect(noClaude.route({ ...small, riskTags: ["auth"] })).rejects.toThrow(/needs it/);
  });
});

describe("Jev decision provider", () => {
  it("maps judgments to tiers through the truth table", async () => {
    const tier = async (r: number, f: (typeof FILES_OPTIONS)[number], ro: number) => (await createJevProvider(fakeJevAsk(r, f, ro)).judge(small)).tier;
    expect(await tier(0.95, "one_file", 0.95)).toBe("claude");
    expect(await tier(0.5, "one_file", 0.95)).toBe("claude");
    expect(await tier(0.02, "four_or_more_files", 0.95)).toBe("claude");
    expect(await tier(0.02, "one_file", 0.95)).toBe("local-small");
    expect(await tier(0.02, "one_file", 0.5)).toBe("free-cloud");
    expect(await tier(0.02, "two_or_three_files", 0.95)).toBe("free-cloud");
  });
  it("has an outcome for every combination", () => {
    const bands: Band[] = ["yes", "no", "unsure"];
    for (const risk of bands) for (const files of FILES_OPTIONS) for (const routine of bands) expect(decide(DEFAULT_TRUTH_TABLE, { risk, files, routine }).tier).toBeTruthy();
  });
  it("raises an error on a malformed answer instead of guessing", async () => {
    await expect(createJevProvider(async () => ({}) as never).judge(small)).rejects.toThrow(/Jev/);
  });
  it("uses Jev to go cheaper, but never below the facts code knows", async () => {
    const cheap = fakeJevAsk(0.02, "one_file", 0.95);
    const r = createTaskRouter({ jev: createJevProvider(cheap) });
    const d = await r.route({ ...small, expectedDiffLines: undefined });
    expect(d.source).toBe("jev");
    expect(d.tier).toBe("local-small"); // rules alone would say free-cloud
    const wide = await r.route({ ...small, filesAllowed: ["a", "b", "c", "d", "e"] });
    expect(wide.tier).toBe("claude");
  });
  it("never sends risky tasks to Jev", async () => {
    const ask = vi.fn(fakeJevAsk(0.02, "one_file", 0.95));
    const d = await createTaskRouter({ jev: createJevProvider(ask) }).route({ ...small, riskTags: ["billing"] });
    expect(d.tier).toBe("claude");
    expect(ask).not.toHaveBeenCalled();
  });
  it("falls back to the rules and reports the error when Jev fails", async () => {
    const d = await createTaskRouter({ jev: createJevProvider(async () => { throw new Error("TypeSafe answered 500"); }) }).route(small);
    expect(d.source).toBe("rules-fallback");
    expect(d.jevError).toMatch(/500/);
    expect(d.tier).toBe("local-small");
  });
});

describe("TypeSafe client", () => {
  it("sends the key as a bearer header, never in the payload, and redacts it from errors", async () => {
    const seen: unknown[] = [];
    const f = vi.fn(async (_u: string, init?: RequestInit) => { seen.push(init); return new Response(JSON.stringify({ answers: { x: { type: "noul", noul: 0.1 } } }), { status: 200 }); });
    const payloads: unknown[] = [];
    const ask = createTypeSafeAsk({ apiKey: "tsk_secret_123", fetch: f as never, onRequest: (p) => payloads.push(p) });
    await ask("state", { x: { type: "noul", instructions: "q" } });
    expect((seen[0] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tsk_secret_123" });
    expect(JSON.stringify(payloads)).not.toContain("tsk_secret_123");
    const bad = createTypeSafeAsk({ apiKey: "tsk_secret_123", fetch: (async () => { throw new Error("connect failed for tsk_secret_123"); }) as never });
    await expect(bad("s", {})).rejects.not.toThrow(/tsk_secret_123/);
    const rejected = createTypeSafeAsk({ apiKey: "tsk_secret_123", fetch: (async () => new Response("no", { status: 401 })) as never });
    await expect(rejected("s", {})).rejects.toThrow(/rejected the API key/);
  });
});
