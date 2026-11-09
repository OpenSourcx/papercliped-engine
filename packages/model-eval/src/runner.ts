import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask, ModelAdapter, ModelResult, TaskResult } from "./types.ts";

/** Runs the task's test file against `code` in a throwaway directory. A timeout counts as a failure. */
export async function runTests(task: EvalTask, code: string, timeoutMs = 10_000): Promise<{ ok: boolean; output: string }> {
  const dir = await mkdtemp(join(tmpdir(), "model-eval-"));
  try {
    await writeFile(join(dir, "solution.mjs"), code);
    await writeFile(join(dir, "solution.test.mjs"), task.test);
    return await new Promise((resolve) => {
      const p = spawn(process.execPath, ["--test", "solution.test.mjs"], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const add = (b: Buffer) => { if (out.length < 8000) out += b.toString(); };
      p.stdout.on("data", add); p.stderr.on("data", add);
      const timer = setTimeout(() => { p.kill("SIGKILL"); out += "\n(timed out)"; }, timeoutMs);
      p.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.slice(0, 4000) }); });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Up to `maxAttempts` tries; each retry gets the previous test output. An adapter error ends the task as failed. */
export async function runTask(task: EvalTask, model: ModelAdapter, maxAttempts = 2): Promise<TaskResult> {
  const t0 = Date.now();
  let cost = 0, feedback: string | undefined, error: string | undefined, attempts = 0;
  for (let a = 1; a <= maxAttempts; a++) {
    attempts = a;
    try {
      const s = await model.solve(task, a, feedback);
      cost += s.costUsd ?? 0;
      const r = await runTests(task, s.code);
      if (r.ok) return { taskId: task.id, difficulty: task.difficulty, passed: true, attempts, costUsd: cost, ms: Date.now() - t0 };
      feedback = r.output;
      error = "tests failed";
    } catch (e) {
      error = (e as Error).message;
      break;
    }
  }
  return { taskId: task.id, difficulty: task.difficulty, passed: false, attempts, costUsd: cost, ms: Date.now() - t0, error };
}

export async function runEval(tasks: EvalTask[], models: ModelAdapter[], maxAttempts = 2): Promise<ModelResult[]> {
  const out: ModelResult[] = [];
  for (const m of models) {
    const results: TaskResult[] = [];
    for (const t of tasks) results.push(await runTask(t, m, maxAttempts));
    out.push({ model: m.id, tasks: results });
  }
  return out;
}
