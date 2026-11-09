import { createTaskRouter, type JevProvider, type Tier } from "@papercliped-engine/task-router";
import type { Difficulty, EvalTask } from "./types.ts";

/** The tier each difficulty is expected to need. A starting hypothesis that `recommend()` then confirms or corrects. */
export const EXPECTED_TIER: Record<Difficulty, Tier> = { easy: "local-small", medium: "free-cloud", hard: "claude" };

/** Runs every task's contract through the router (rules, or rules plus Jev) and counts how often the tier matches the expectation. */
export async function routingAgreement(tasks: EvalTask[], jev?: JevProvider) {
  const r = createTaskRouter({ jev });
  const rows = [];
  for (const t of tasks) {
    const d = await r.route(t.contract);
    rows.push({ taskId: t.id, expected: EXPECTED_TIER[t.difficulty], got: d.tier, source: d.source, jevError: d.jevError });
  }
  return { rows, agree: rows.filter((x) => x.expected === x.got).length, total: rows.length };
}
