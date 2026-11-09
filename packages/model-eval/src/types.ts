import type { TaskContract } from "@papercliped-engine/task-router";

export type Difficulty = "easy" | "medium" | "hard";

/** A small coding task: the model writes `solution.mjs`; `test` (node:test) decides pass or fail. */
export interface EvalTask {
  id: string;
  title: string;
  difficulty: Difficulty;
  /** What the model is shown. */
  prompt: string;
  /** Contents of `solution.test.mjs`, importing from ./solution.mjs. */
  test: string;
  /** A known-good solution. The fake model and the self-check use it; real models never see it. */
  reference: string;
  /** How the router would see this task. */
  contract: TaskContract;
}

export interface Solution { code: string; tokensIn?: number; tokensOut?: number; costUsd?: number }

/** Anything that can write a solution: an HTTP model, a CLI agent, or a fake. `feedback` is the previous attempt's test output. */
export interface ModelAdapter {
  id: string;
  solve(task: EvalTask, attempt: number, feedback?: string): Promise<Solution>;
}

export interface TaskResult { taskId: string; difficulty: Difficulty; passed: boolean; attempts: number; costUsd: number; ms: number; error?: string }
export interface ModelResult { model: string; tasks: TaskResult[] }
