import { describe, expect, it } from "vitest";
import { commandAdapter, extractCode, fakeModel, openAiCompatible, recommend, routingAgreement, runEval, runTask, summarize, table, TASKS } from "../src/index.ts";

describe("task set", () => {
  it("has 10-20 tasks, starting with makeLabel, with unique ids", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(10);
    expect(TASKS.length).toBeLessThanOrEqual(20);
    expect(TASKS[0].id).toBe("make-label");
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
  });
  it("every reference solution passes its own tests, and an empty module fails them", async () => {
    for (const t of TASKS) {
      expect((await runTask(t, fakeModel("ref", "hard"), 1)).passed, t.id).toBe(true);
      expect((await runTask(t, fakeModel("none", "none"), 1)).passed, t.id).toBe(false);
    }
  }, 120_000);
});

describe("harness", () => {
  it("measures pass rate, attempts and cost per model, and builds a table", async () => {
    const results = await runEval(TASKS, [fakeModel("cheap", "easy", { fixesOnRetry: true }), fakeModel("strong", "hard", { costPerTask: 0.01 })], 2);
    const [cheap, strong] = results.map(summarize);
    expect(strong.passRate).toBe(1);
    expect(strong.costUsd).toBeCloseTo(0.01 * TASKS.length, 5);
    expect(cheap.byDifficulty.easy.passed).toBe(cheap.byDifficulty.easy.total);
    expect(cheap.byDifficulty.medium.passed).toBe(cheap.byDifficulty.medium.total); // fixed on the second try
    expect(cheap.byDifficulty.hard.passed).toBe(0);
    expect(cheap.meanAttempts).toBeGreaterThan(1);
    expect(table(results)).toMatch(/\| cheap \| \d+% \|/);
    expect(recommend(results)).toEqual({ easy: "cheap", medium: "cheap", hard: "strong" });
  }, 120_000);

  it("retries with the test output and gives up after maxAttempts", async () => {
    const seen: (string | undefined)[] = [];
    const t = TASKS[0];
    const r = await runTask(t, { id: "bad", solve: async (_t, _a, fb) => { seen.push(fb); return { code: "export {};" }; } }, 3);
    expect(r).toMatchObject({ passed: false, attempts: 3 });
    expect(seen[0]).toBeUndefined();
    expect(seen[2]).toMatch(/makeLabel|not ok|fail/i);
  });
  it("counts an adapter error as a failed task and carries on", async () => {
    const r = await runTask(TASKS[0], { id: "boom", solve: async () => { throw new Error("503 from provider"); } });
    expect(r).toMatchObject({ passed: false, error: "503 from provider" });
  });
  it("does not hang on code that never returns", async () => {
    const r = await runTask(TASKS[0], { id: "loop", solve: async () => ({ code: "while (true) {}" }) }, 1);
    expect(r.passed).toBe(false);
  }, 30_000);
});

describe("adapters", () => {
  it("extracts a fenced block or takes the reply as code", () => {
    expect(extractCode("Here:\n```js\nexport const a = 1;\n```\nDone")).toBe("export const a = 1;\n");
    expect(extractCode("export const a = 1;")).toBe("export const a = 1;");
  });
  it("openAiCompatible reads the reply and prices the tokens", async () => {
    const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "```js\nexport {};\n```" } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }), { status: 200 })) as never;
    const a = openAiCompatible({ id: "m", baseUrl: "http://x/v1", model: "m", fetch: f, usdPerMTokIn: 1, usdPerMTokOut: 2 });
    const s = await a.solve(TASKS[0], 1);
    expect(s.code).toBe("export {};\n");
    expect(s.costUsd).toBeCloseTo(0.002, 6);
  });
  it("openAiCompatible hides the key in errors", async () => {
    const a = openAiCompatible({ id: "m", baseUrl: "http://x/v1", model: "m", apiKey: "sk-secret-abc", fetch: (async () => new Response("bad key sk-secret-abc", { status: 401 })) as never });
    await expect(a.solve(TASKS[0], 1)).rejects.not.toThrow(/sk-secret-abc/);
  });
  it("commandAdapter pipes the prompt in and the code out", async () => {
    const a = commandAdapter({ id: "cat", command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"] });
    expect((await a.solve(TASKS[0], 1)).code).toContain("makeLabel");
  });
});

describe("routing agreement", () => {
  it("scores the rule classifier against the expected tiers", async () => {
    const r = await routingAgreement(TASKS);
    expect(r.total).toBe(TASKS.length);
    expect(r.rows.every((x) => x.source === "rules")).toBe(true);
  });
});
