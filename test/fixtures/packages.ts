import forum010 from "./forum-0.1.0.json" with { type: "json" };
import forum011 from "./forum-0.1.1.json" with { type: "json" };
import {
  packageScope,
  type ScenarioPackage,
  type Stage,
} from "../../src/packages.ts";

const forum = forum011 as ScenarioPackage;
const baseline = {
  ...forum.stages[0].baseline,
  ".github/workflows/inbox-e2e.yml": "name: Inbox E2E\njob: browser\n",
  "test/e2e/inbox.spec.ts": "test('private inbox behavior', () => {});\n",
  ".github/workflows/mentions-e2e.yml": "name: Mentions E2E\njob: browser\n",
  "test/e2e/mentions.spec.ts": "test('mentions behavior', () => {});\n",
};
const inboxStage: Stage = {
  id: "private-inbox",
  title: "The community needs a private activity inbox",
  intro:
    "Build a private activity inbox for replies and votes on threads the signed-in member created. Exclude activity authored by that member and all activity on other members' threads. Show the newest 20 events first, provide an empty state, navigate to the source thread, and let each member mark events read.",
  baseline,
  mode: "milestone",
  pool: "inbox-cards",
  requiredCheck: "Inbox E2E / browser",
  workflowPath: ".github/workflows/inbox-e2e.yml",
  protectedFiles: [".github/workflows/inbox-e2e.yml", "test/e2e/inbox.spec.ts"],
  evaluation: {
    issueBreakdown:
      "Reward independent, reviewable slices for the stated inbox behaviors. One broad issue covering the full milestone earns low breakdown credit; issue count itself is not a gate.",
    issueClarity:
      "Reward concrete scope and acceptance criteria that allow Louibot to work with few questions.",
    pullRequestQuality:
      "Judge the implementation diff for correctness, accessibility, tests, and maintainability against the brief.",
    reviewQuality:
      "Reward substantive, accurate, actionable feedback about behavior or risk; give little credit for cosmetic-only nitpicks.",
  },
  issues: [],
  proposals: [],
  endings: {
    success: "The private activity inbox is ready for the community.",
    incomplete: "The milestone still needs work.",
    partial: "The milestone could not be fully assessed.",
  },
};
const mentionsStage: Stage = {
  ...inboxStage,
  id: "mentions",
  title: "Mention a teammate",
  intro: "Notify the people named in a message and take them to its source.",
  requiredCheck: "Mentions E2E / browser",
  workflowPath: ".github/workflows/mentions-e2e.yml",
  protectedFiles: [
    ".github/workflows/mentions-e2e.yml",
    "test/e2e/mentions.spec.ts",
  ],
};
export const milestonePackage: ScenarioPackage = {
  ...forum,
  id: "forum-inbox",
  version: "0.1.0",
  title: "Forum Inbox",
  description: "A milestone-driven Forum stage.",
  digest: "c".repeat(64),
  stages: [inboxStage, mentionsStage],
};

/** Compact synthetic release content for core/game/storage tests. */
export const packages = [
  forum010 as ScenarioPackage,
  forum011 as ScenarioPackage,
] as const;

// These test modules run in their own node:test worker context. Keep the fixture
// catalogue available to synchronous package helpers in each test file.
packageScope.enterWith(packages);
