/** All Jev question wording and the truth table live here, so they can be audited and edited in one place. */
import type { Tier } from "./types.ts";

export const FILES_OPTIONS = ["one_file", "two_or_three_files", "four_or_more_files"] as const;
export type FilesNeeded = (typeof FILES_OPTIONS)[number];

export const QUESTIONS = {
  risk: { type: "noul", instructions: "This change touches authentication, billing, tenancy or security." },
  files: {
    type: "choice",
    instructions: "How many files does this change realistically need?",
    criteria: {
      one_file: "One file is enough.",
      two_or_three_files: "Two or three files must change together.",
      four_or_more_files: "Four or more files must change together.",
    },
  },
  routine: { type: "noul", instructions: "This is routine work: a well-known kind of change with an obvious way to do it." },
} as const;

export type Band = "yes" | "no" | "unsure";
export interface Thresholds { yesAbove: number; noBelow: number }
/** Starting values from TypeSafe's guidance; between them is "unsure", which has its own rows below. */
export const DEFAULT_THRESHOLDS: Thresholds = { yesAbove: 0.7, noBelow: 0.3 };

export const band = (p: number, t: Thresholds): Band => (p >= t.yesAbove ? "yes" : p <= t.noBelow ? "no" : "unsure");

export interface TruthRow { risk: Band | "any"; files: FilesNeeded | "any"; routine: Band | "any"; tier: Tier; why: string }

/**
 * First matching row wins. Every combination of (risk, files, routine) has an outcome: the last row catches the rest.
 * When Jev cannot rule out risk, the answer is the strongest tier.
 */
export const DEFAULT_TRUTH_TABLE: TruthRow[] = [
  { risk: "yes", files: "any", routine: "any", tier: "claude", why: "touches auth, billing, tenancy or security" },
  { risk: "unsure", files: "any", routine: "any", tier: "claude", why: "risk could not be ruled out" },
  { risk: "any", files: "four_or_more_files", routine: "any", tier: "claude", why: "four or more files" },
  { risk: "no", files: "two_or_three_files", routine: "yes", tier: "free-cloud", why: "routine change across a few files" },
  { risk: "no", files: "two_or_three_files", routine: "any", tier: "claude", why: "a few files and not clearly routine" },
  { risk: "no", files: "one_file", routine: "yes", tier: "local-small", why: "routine one-file change" },
  { risk: "no", files: "one_file", routine: "unsure", tier: "free-cloud", why: "one file, routine-ness unclear" },
  { risk: "any", files: "any", routine: "any", tier: "claude", why: "no cheaper row matched" },
];

export function decide(table: TruthRow[], j: { risk: Band; files: FilesNeeded; routine: Band }): TruthRow {
  const row = table.find((r) => (r.risk === "any" || r.risk === j.risk) && (r.files === "any" || r.files === j.files) && (r.routine === "any" || r.routine === j.routine));
  if (!row) throw new Error("The truth table has no row for this combination; end it with a catch-all row.");
  return row;
}
