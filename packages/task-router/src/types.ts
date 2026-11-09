/** The three places a task can go, cheapest first. */
export const TIERS = ["local-small", "free-cloud", "claude"] as const;
export type Tier = (typeof TIERS)[number];
export const tierRank = (t: Tier): number => TIERS.indexOf(t);
export const maxTier = (a: Tier, b: Tier): Tier => (tierRank(a) >= tierRank(b) ? a : b);

/** What a task states about itself. This is the only input to routing. */
export interface TaskContract {
  goal: string;
  /** Files the agent may touch. Empty means "anywhere", which is treated as multi-file. */
  filesAllowed: string[];
  testCommand?: string;
  /** Expected size of the change, in changed lines. Unknown is treated as medium. */
  expectedDiffLines?: number;
  /** auth, billing, tenancy, security ... Any tag in the organization's risk list sends the task to `claude`. */
  riskTags?: string[];
}

/** Where a tier runs: an ePaperclip adapter type, a model, and (optionally) an environment id or name. */
export interface RouteTarget {
  adapterType: string;
  model?: string;
  environment?: string;
}

/** What a finished run tells the router. Only "escalate" moves a task up the chain. */
export type RunStatus = "ok" | "escalate" | "failed";
export interface RunReport { status: RunStatus; note?: string }

export type DecisionSource = "rules" | "jev" | "rules-fallback";

export interface RouteDecision {
  tier: Tier;
  target: RouteTarget;
  source: DecisionSource;
  /** Plain-language reasons, for the run log. */
  reasons: string[];
  /** Set when Jev was on but could not answer: the rules decided, and this says why. Never silent. */
  jevError?: string;
}
