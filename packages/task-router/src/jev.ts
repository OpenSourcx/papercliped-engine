import { band, decide, DEFAULT_THRESHOLDS, DEFAULT_TRUTH_TABLE, FILES_OPTIONS, QUESTIONS, type Band, type FilesNeeded, type Thresholds, type TruthRow } from "./questions.ts";
import type { Ask } from "./typesafe.ts";
import type { TaskContract, Tier } from "./types.ts";

export interface JevJudgment { tier: Tier; why: string; risk: Band; files: FilesNeeded; routine: Band }

/** What is sent to TypeSafe for one task: the goal text, the file paths and the expected diff size. Nothing else. */
export const jevState = (t: TaskContract) => ({ goal: t.goal, files_allowed: t.filesAllowed, ...(t.expectedDiffLines !== undefined ? { expected_diff_lines: t.expectedDiffLines } : {}) });

export interface JevProvider { judge(task: TaskContract): Promise<JevJudgment> }

/** Jev answers three small questions; the truth table (code) picks the tier. A malformed answer is an error, never a guess. */
export function createJevProvider(ask: Ask, opts: { thresholds?: Thresholds; table?: TruthRow[] } = {}): JevProvider {
  const th = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const table = opts.table ?? DEFAULT_TRUTH_TABLE;
  return {
    async judge(task) {
      const a = await ask(jevState(task), { ...QUESTIONS });
      const noul = (k: string) => {
        const v = (a[k] as { noul?: unknown } | undefined)?.noul;
        if (typeof v !== "number" || !(v >= 0 && v <= 1)) throw new Error(`Jev's answer to "${k}" was missing or not a probability.`);
        return v;
      };
      const probs = (a.files as { probabilities?: Record<string, number> } | undefined)?.probabilities;
      if (!probs) throw new Error('Jev\'s answer to "files" had no probabilities.');
      // The top option is the default reading of a Choice.
      const files = FILES_OPTIONS.reduce((best, o) => ((probs[o] ?? -1) > (probs[best] ?? -1) ? o : best), FILES_OPTIONS[0]);
      if (probs[files] === undefined) throw new Error('Jev\'s answer to "files" named none of the options.');
      const j = { risk: band(noul("risk"), th), files, routine: band(noul("routine"), th) };
      const row = decide(table, j);
      return { ...j, tier: row.tier, why: row.why };
    },
  };
}
