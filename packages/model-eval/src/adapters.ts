import { spawn } from "node:child_process";
import { TASKS } from "./tasks/index.ts";
import type { Difficulty, EvalTask, ModelAdapter, Solution } from "./types.ts";

const RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };

/** Finds the first fenced code block; if there is none, the whole reply is taken as code. */
export const extractCode = (reply: string): string => reply.match(/```[a-z]*\n([\s\S]*?)```/i)?.[1] ?? reply;

/**
 * A model that solves every task up to `skill` from the reference and fails the rest, so CI can run the whole harness
 * with no network. `fixesOnRetry` makes tasks one level above skill pass on the second attempt.
 */
export function fakeModel(id: string, skill: Difficulty | "none", o: { fixesOnRetry?: boolean; costPerTask?: number } = {}): ModelAdapter {
  return {
    id,
    async solve(task: EvalTask, attempt: number): Promise<Solution> {
      const level = skill === "none" ? -1 : RANK[skill];
      const solved = RANK[task.difficulty] <= level || (!!o.fixesOnRetry && attempt > 1 && RANK[task.difficulty] === level + 1);
      const ref = TASKS.find((t) => t.id === task.id)?.reference ?? task.reference;
      return { code: solved ? ref : "export {};", costUsd: o.costPerTask ?? 0 };
    },
  };
}

/** Any OpenAI-compatible Chat Completions endpoint: the Router (http://127.0.0.1:3120/v1), OpenRouter, Ollama, OpenAI. */
export function openAiCompatible(o: { id: string; baseUrl: string; model: string; apiKey?: string; usdPerMTokIn?: number; usdPerMTokOut?: number; fetch?: typeof fetch; timeoutMs?: number }): ModelAdapter {
  const f = o.fetch ?? fetch;
  return {
    id: o.id,
    async solve(task, _attempt, feedback) {
      const content = feedback ? `${task.prompt}\n\nYour previous attempt failed these tests:\n${feedback}\n\nFix it and reply with the complete file.` : task.prompt;
      const res = await f(`${o.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) },
        body: JSON.stringify({ model: o.model, messages: [{ role: "user", content }], temperature: 0 }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${o.id} answered ${res.status}: ${text.slice(0, 200).split(o.apiKey ?? "\0").join("[key]")}`);
      const body = JSON.parse(text) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const reply = body.choices?.[0]?.message?.content;
      if (!reply) throw new Error(`${o.id} sent no answer`);
      const tin = body.usage?.prompt_tokens ?? 0, tout = body.usage?.completion_tokens ?? 0;
      return { code: extractCode(reply), tokensIn: tin, tokensOut: tout, costUsd: (tin * (o.usdPerMTokIn ?? 0) + tout * (o.usdPerMTokOut ?? 0)) / 1e6 };
    },
  };
}

/** A CLI agent or script: the prompt goes to stdin, the reply (a code block or the file itself) is read from stdout. */
export function commandAdapter(o: { id: string; command: string; args?: string[]; costPerTask?: number; timeoutMs?: number }): ModelAdapter {
  return {
    id: o.id,
    solve: (task, _attempt, feedback) => new Promise((resolve, reject) => {
      const p = spawn(o.command, o.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      p.stdout.on("data", (b) => (out += b)); p.stderr.on("data", (b) => (err += b));
      const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${o.id} timed out`)); }, o.timeoutMs ?? 300_000);
      p.on("error", (e) => { clearTimeout(timer); reject(e); });
      p.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve({ code: extractCode(out), costUsd: o.costPerTask ?? 0 }) : reject(new Error(`${o.id} exited ${code}: ${err.slice(0, 200)}`)); });
      p.stdin.end(feedback ? `${task.prompt}\n\nYour previous attempt failed these tests:\n${feedback}\n` : task.prompt);
    }),
  };
}
