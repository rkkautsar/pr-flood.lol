export type Outcome = "open" | "merged" | "closed";
export type Phase =
  "seeding" | "active" | "finishing" | "finished" | "inaccessible";
export type PRState = {
  number: number;
  revision: number;
  outcome: Outcome;
  head: string;
  reviews: Review[];
  unscored?: string;
};
export type Review = {
  id: number;
  body: string;
  state: string;
  commit: string;
  submitted: string;
};
export type Finding = {
  reviewId: number;
  category: "absent" | "vague" | "identified" | "consequence";
  revision: number;
  reviewText?: string;
};
export type ReviewCoaching = {
  constructiveness?: "actionable" | "supportive" | "vague" | "unconstructive";
  focus?: "substantive" | "nitpick" | "automation" | "mixed" | "unclear";
};
export type CoachingAttempt = {
  reviewId: number;
  revision: number;
  fingerprint: string;
  feedback?: ReviewCoaching;
};
export type Run = {
  id: string;
  installation: number;
  repository: number;
  owner: string;
  repo: string;
  player: number;
  phase: Phase;
  mode?: "review" | "milestone";
  scenario: { id: string; version: string; stage: string; digest: string };
  /** Trusted milestone suites accumulated along this playthrough. */
  milestoneChecks?: MilestoneCheckSnapshot[];
  /** Milestone cards already shown in this playthrough. */
  offeredCards?: string[];
  rerollsRemaining?: number;
  rerollCommentIds?: number[];
  previousRun?: string;
  reason?: string;
  phaseBeforeAccessLoss?: Phase;
  warnings?: string[];
  unverifiedIssues?: string[];
  baseline?: string;
  baselineFiles?: Record<string, string>;
  observedFiles?: Record<string, string>;
  base?: string;
  milestone?: number;
  master?: number;
  issues: Record<string, number>;
  prs: Record<string, PRState>;
  tree?: string;
  contentHash?: string;
  findings: Record<string, Finding[]>;
  coaching?: Record<string, CoachingAttempt[]>;
  storySent?: Record<string, boolean>;
  result?: Assessment;
  finishEarly?: boolean;
};
export type MilestoneCheckSnapshot = {
  stage: string;
  title: string;
  requiredCheck: string;
  workflowPath: string;
  protectedFiles: Record<string, string>;
};
export type Assessment = {
  complete: string[];
  total: number;
  points: number;
  maximum: number;
  success: boolean | null;
  unverified?: string[];
  warnings?: string[];
  harmful: string[];
  debt: string[];
  decisions: {
    id: string;
    outcome: string;
    points: number | null;
    explanation: string;
  }[];
  reasoning: string;
  scorecard?: {
    milestone: number | null;
    issueBreakdown: number | null;
    issueClarity: number | null;
    pullRequestQuality: number | null;
    reviewQuality: number | null;
    clarificationRounds: number;
    testStatus: "passed" | "failed" | "pending" | "missing";
  };
};
export type Variant = {
  files: Record<string, string>;
  sound: boolean;
  satisfiesIssue?: boolean;
  concern?: string;
  explanation: string;
  debt?: string;
  serious?: boolean;
  deletes?: string[];
  reply?: string;
};
export type Proposal = {
  id: string;
  title: string;
  body: string;
  issue?: string;
  group?: string;
  variants: Variant[];
  character?: string;
  lesson?: string;
  followup?: string;
};
