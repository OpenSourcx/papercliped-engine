import type { Difficulty, ModelResult } from "./types.ts";

export interface Summary { model: string; passRate: number; meanAttempts: number | null; costUsd: number; seconds: number; byDifficulty: Record<Difficulty, { passed: number; total: number }> }

export function summarize(r: ModelResult): Summary {
  const by: Summary["byDifficulty"] = { easy: { passed: 0, total: 0 }, medium: { passed: 0, total: 0 }, hard: { passed: 0, total: 0 } };
  for (const t of r.tasks) { by[t.difficulty].total++; if (t.passed) by[t.difficulty].passed++; }
  const ok = r.tasks.filter((t) => t.passed);
  return {
    model: r.model,
    passRate: r.tasks.length ? ok.length / r.tasks.length : 0,
    meanAttempts: ok.length ? ok.reduce((a, t) => a + t.attempts, 0) / ok.length : null,
    costUsd: r.tasks.reduce((a, t) => a + t.costUsd, 0),
    seconds: r.tasks.reduce((a, t) => a + t.ms, 0) / 1000,
    byDifficulty: by,
  };
}

/** A Markdown table: one row per model. "attempts" is the mean over the tasks that passed. */
export function table(results: ModelResult[]): string {
  const head = "| model | pass rate | attempts | cost (USD) | time (s) | easy | medium | hard |\n| --- | --- | --- | --- | --- | --- | --- | --- |";
  const cell = (c: { passed: number; total: number }) => (c.total ? `${c.passed}/${c.total}` : "-");
  const rows = results.map(summarize).map((s) =>
    `| ${s.model} | ${(s.passRate * 100).toFixed(0)}% | ${s.meanAttempts === null ? "-" : s.meanAttempts.toFixed(2)} | ${s.costUsd.toFixed(4)} | ${s.seconds.toFixed(1)} | ${cell(s.byDifficulty.easy)} | ${cell(s.byDifficulty.medium)} | ${cell(s.byDifficulty.hard)} |`);
  return [head, ...rows].join("\n");
}

/**
 * For each difficulty, the first model (in the order given: cheapest first) whose pass rate on that difficulty is at
 * least `minPassRate`. Null means no model cleared the bar. Needs at least `minTasks` tasks of that difficulty.
 */
export function recommend(results: ModelResult[], opts: { minPassRate?: number; minTasks?: number } = {}): Record<Difficulty, string | null> {
  const min = opts.minPassRate ?? 0.8, minTasks = opts.minTasks ?? 3;
  const pick = (d: Difficulty) => results.map(summarize).find((s) => s.byDifficulty[d].total >= minTasks && s.byDifficulty[d].passed / s.byDifficulty[d].total >= min)?.model ?? null;
  return { easy: pick("easy"), medium: pick("medium"), hard: pick("hard") };
}
