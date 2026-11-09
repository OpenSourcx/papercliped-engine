import { maxTier, type TaskContract, type Tier } from "./types.ts";

export interface ClassifierConfig {
  /** Tags that always go to `claude`. Compared case-insensitively. */
  riskTags: string[];
  /** A path containing one of these words is treated as risky even when the task carries no tag. */
  riskPathWords: string[];
  localMaxFiles: number;
  localMaxLines: number;
  cloudMaxFiles: number;
  cloudMaxLines: number;
}

export const DEFAULT_CLASSIFIER: ClassifierConfig = {
  riskTags: ["auth", "billing", "tenancy", "security", "payments", "secrets", "crypto", "migration", "permissions", "proxmox"],
  riskPathWords: ["auth", "billing", "tenan", "security", "secret", "crypto", "payment", "proxmox"],
  localMaxFiles: 1,
  localMaxLines: 40,
  cloudMaxFiles: 3,
  cloudMaxLines: 200,
};

export interface Classification {
  tier: Tier;
  /** The lowest tier code can prove is safe, from facts only (risk, declared file count). A model's opinion may not go below it. */
  floor: Tier;
  reasons: string[];
}

/** Hard facts first: risk and declared scope. Then size. Unknown size counts as medium. */
export function classifyTask(task: TaskContract, cfg: ClassifierConfig = DEFAULT_CLASSIFIER): Classification {
  const reasons: string[] = [];
  const tags = new Set((task.riskTags ?? []).map((t) => t.trim().toLowerCase()));
  const risky = cfg.riskTags.filter((t) => tags.has(t.toLowerCase()));
  if (risky.length) reasons.push(`risk tag: ${risky.join(", ")}`);
  const riskyPath = task.filesAllowed.find((f) => cfg.riskPathWords.some((w) => f.toLowerCase().includes(w)));
  if (riskyPath) reasons.push(`risky path: ${riskyPath}`);
  if (!task.filesAllowed.length) reasons.push("no file limit (treated as multi-file)");
  else if (task.filesAllowed.length > cfg.cloudMaxFiles) reasons.push(`${task.filesAllowed.length} files allowed (more than ${cfg.cloudMaxFiles})`);
  const floor: Tier = reasons.length ? "claude" : "local-small";
  if (floor === "claude") return { tier: "claude", floor, reasons };

  const files = task.filesAllowed.length;
  const lines = task.expectedDiffLines;
  let tier: Tier = "local-small";
  if (lines === undefined) { tier = "free-cloud"; reasons.push("diff size unknown"); }
  else if (lines > cfg.cloudMaxLines) { tier = "claude"; reasons.push(`large diff (${lines} lines)`); }
  else if (lines > cfg.localMaxLines) { tier = "free-cloud"; reasons.push(`medium diff (${lines} lines)`); }
  if (files > cfg.localMaxFiles) { tier = maxTier(tier, "free-cloud"); reasons.push(`${files} files`); }
  if (!task.testCommand) { tier = maxTier(tier, "free-cloud"); reasons.push("no test command to check the result"); }
  if (!reasons.length) reasons.push("one file, small diff, has a test");
  return { tier, floor, reasons };
}
