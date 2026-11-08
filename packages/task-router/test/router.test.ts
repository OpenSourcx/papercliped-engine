import { describe, expect, it, vi } from "vitest";
import {
  classifyTask, createJevProvider, createJevSettings, createOrgRouter, createTaskRouter, createTypeSafeAsk, decide, DEFAULT_TRUTH_TABLE, DEFAULT_ROUTING_TABLE,
  parseRoutingTable, FILES_OPTIONS, JEV_CARD, type Ask, type Band, type JevOrgSettings, type SecretPort, type TaskContract, type RoutingTable,
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

// A fake Jev: scripted answers, no network. Tests check tiers, never exact probabilities.
const fakeAsk = (risk: number, files: (typeof FILES_OPTIONS)[number], routine: number): Ask => async () => ({
  risk: { type: "noul", noul: risk },
  routine: { type: "noul", noul: routine },
  files: { type: "choice", choice: files, probabilities: Object.fromEntries(FILES_OPTIONS.map((o) => [o, o === files ? 0.9 : 0.05])) },
});

describe("Jev decision provider", () => {
  it("maps judgments to tiers through the truth table", async () => {
    const tier = async (r: number, f: (typeof FILES_OPTIONS)[number], ro: number) => (await createJevProvider(fakeAsk(r, f, ro)).judge(small)).tier;
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
    const cheap = fakeAsk(0.02, "one_file", 0.95);
    const r = createTaskRouter({ jev: createJevProvider(cheap) });
    const d = await r.route({ ...small, expectedDiffLines: undefined });
    expect(d.source).toBe("jev");
    expect(d.tier).toBe("local-small"); // rules alone would say free-cloud
    const wide = await r.route({ ...small, filesAllowed: ["a", "b", "c", "d", "e"] });
    expect(wide.tier).toBe("claude");
  });
  it("never sends risky tasks to Jev", async () => {
    const ask = vi.fn(fakeAsk(0.02, "one_file", 0.95));
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

function harness() {
  const store = new Map<string, JevOrgSettings>();
  const secrets = new Map<string, string>();
  const port: SecretPort = {
    async create(_c, _n, v) { const id = `sec-${secrets.size + 1}`; secrets.set(id, v); return { id }; },
    async read(_c, id) { return secrets.get(id); },
    async remove(_c, id) { secrets.delete(id); },
  };
  const calls: string[] = [];
  const settings = createJevSettings({
    store: { get: async (c) => store.get(c), set: async (c, s) => void store.set(c, s) },
    secrets: port,
    ask: (key) => async (state, qs) => { calls.push(key); return fakeAsk(0.02, "one_file", 0.95)(state, qs); },
  });
  return { settings, store, secrets, calls };
}

describe("organization Jev switch", () => {
  const admin = { isAdmin: true };
  it("is off by default and the view never carries the key", async () => {
    const { settings } = harness();
    const r = await settings.handle("GET", "/", "org1", undefined, { isAdmin: false });
    expect(r.body).toMatchObject({ enabled: false, hasKey: false, active: false, disclosure: JEV_CARD.disclosure });
  });
  it("needs an administrator to change anything", async () => {
    const { settings } = harness();
    expect((await settings.handle("PUT", "/key", "org1", { apiKey: "tsk_abcdefgh" }, { isAdmin: false })).status).toBe(403);
  });
  it("cannot be turned on without a key and an explicit consent", async () => {
    const { settings } = harness();
    expect((await settings.handle("PUT", "/", "org1", { enabled: true }, admin)).status).toBe(409);
    await settings.handle("PUT", "/key", "org1", { apiKey: "tsk_abcdefgh" }, admin);
    expect((await settings.handle("PUT", "/", "org1", { enabled: true }, admin)).status).toBe(409);
    await settings.handle("PUT", "/", "org1", { consentSendTaskText: true }, admin);
    const on = await settings.handle("PUT", "/", "org1", { enabled: true }, admin);
    expect(on.body).toMatchObject({ enabled: true, hasKey: true, active: true });
    expect(JSON.stringify(on.body)).not.toContain("tsk_abcdefgh");
  });
  it("rejects obviously bad keys, and storing a key keeps it out of settings", async () => {
    const { settings, store } = harness();
    expect((await settings.handle("PUT", "/key", "org1", { apiKey: "x" }, admin)).status).toBe(400);
    await settings.handle("PUT", "/key", "org1", { apiKey: "tsk_abcdefgh" }, admin);
    expect(JSON.stringify([...store.values()])).not.toContain("tsk_abcdefgh");
  });
  it("routes with Jev only when active, per organization, and with no key it is the rules", async () => {
    const h = harness();
    await h.settings.handle("PUT", "/key", "orgA", { apiKey: "tsk_orgA_key" }, admin);
    await h.settings.handle("PUT", "/", "orgA", { consentSendTaskText: true }, admin);
    await h.settings.handle("PUT", "/", "orgA", { enabled: true }, admin);
    const org = createOrgRouter({ tables: { get: async () => undefined }, jev: h.settings });
    const withJev = await org.route("orgA", { ...small, expectedDiffLines: undefined });
    expect(withJev.source).toBe("jev");
    expect(h.calls).toEqual(["tsk_orgA_key"]);
    const other = await org.route("orgB", { ...small, expectedDiffLines: undefined });
    expect(other.source).toBe("rules");
    expect(h.calls.length).toBe(1);
    await h.settings.handle("PUT", "/", "orgA", { enabled: false }, admin);
    expect((await org.route("orgA", small)).source).toBe("rules");
    expect(h.calls.length).toBe(1);
  });
  it("taking consent back switches it off; removing the key deletes the secret", async () => {
    const h = harness();
    await h.settings.handle("PUT", "/key", "o", { apiKey: "tsk_abcdefgh" }, admin);
    await h.settings.handle("PUT", "/", "o", { consentSendTaskText: true }, admin);
    await h.settings.handle("PUT", "/", "o", { enabled: true }, admin);
    expect((await h.settings.view("o")).enabled).toBe(true);
    await h.settings.handle("PUT", "/", "o", { consentSendTaskText: false }, admin);
    expect((await h.settings.view("o")).enabled).toBe(false);
    await h.settings.handle("DELETE", "/key", "o", undefined, admin);
    expect(h.secrets.size).toBe(0);
    expect((await h.settings.view("o")).hasKey).toBe(false);
  });
  it("the connection test sends fixed text, not task text, and surfaces failures", async () => {
    const h = harness();
    expect((await h.settings.handle("POST", "/test", "o", undefined, admin)).status).toBe(409);
    await h.settings.handle("PUT", "/key", "o", { apiKey: "tsk_abcdefgh" }, admin);
    expect((await h.settings.handle("POST", "/test", "o", undefined, admin)).body).toEqual({ ok: true });
  });
  it("uses the organization's own table, and ignores a broken one with a visible note", async () => {
    const h = harness();
    const good = { targets: { claude: { adapterType: "claude_local", model: "mine" } }, chain: ["claude"] };
    const org = createOrgRouter({ tables: { get: async (c) => (c === "bad" ? { chain: [] } : good) }, jev: h.settings });
    expect((await org.route("ok", small)).target.model).toBe("mine");
    const bad = await org.route("bad", small);
    expect(bad.target).toEqual(DEFAULT_ROUTING_TABLE.targets["local-small"]);
    expect(bad.reasons.join(" ")).toMatch(/table ignored/i);
    const d = await org.route("ok", small);
    expect(await org.next("ok", d, { status: "escalate" })).toBeNull();
  });
});
