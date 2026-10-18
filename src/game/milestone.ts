import type { GitHub } from "../github.ts";
import type {
  MilestoneJudgement,
  MilestoneQuality,
  Reviewer,
} from "../persistence.ts";
import { scenarioFor } from "../packages.ts";
import type { Assessment, Run } from "../types.ts";
import { runRoot } from "./shared.ts";

export type MilestoneTestStatus = "passed" | "failed" | "pending" | "missing";

export type MilestoneTestReport = {
  status: MilestoneTestStatus;
  failed: string[];
  pending: string[];
  missing: string[];
};

export async function installMilestoneTests(
  run: Run,
  gh: GitHub,
  forceCommit = false,
): Promise<{ sha: string; changed: boolean }> {
  const suites = run.milestoneChecks?.length
    ? run.milestoneChecks
    : (() => {
        const stage = scenarioFor(run);
        return [
          {
            stage: stage.id,
            title: stage.title,
            requiredCheck: stage.requiredCheck!,
            workflowPath: stage.workflowPath!,
            protectedFiles: Object.fromEntries(
              (stage.protectedFiles ?? []).map((path) => [
                path,
                (stage.evaluatorFiles ?? stage.baseline)[path],
              ]),
            ),
          },
        ];
      })();
  const files: Record<string, string> = {};
  for (const suite of suites) {
    for (const [path, content] of Object.entries(suite.protectedFiles)) {
      if (path in files && files[path] !== content)
        throw new Error("Milestone suites define conflicting evaluator files");
      files[path] = content;
    }
  }
  if (!Object.keys(files).length)
    throw new Error("Milestone package has no trusted evaluator files");
  const root = runRoot(run);
  const head = (await gh.reference(root, run.base!)).object.sha;
  const current = await gh.treeFiles(root, head, Object.keys(files));
  const changed = Object.entries(files).some(
    ([path, value]) => current[path] !== value,
  );
  if (!changed && !forceCommit) return { sha: head, changed: false };
  const commit = await gh.commit(
    root,
    head,
    files,
    "PR Flood: install trusted milestone checks",
  );
  await gh.patch(root + "/git/refs/heads/" + run.base, {
    sha: commit.sha,
    force: false,
  });
  return { sha: commit.sha, changed: true };
}

export async function milestoneTestReport(
  run: Run,
  gh: GitHub,
): Promise<MilestoneTestReport> {
  const stage = scenarioFor(run);
  if (!stage.requiredCheck || !stage.workflowPath)
    return {
      status: "missing",
      failed: [],
      pending: [],
      missing: [stage.id],
    };
  const root = runRoot(run);
  const sha = (await gh.reference(root, run.base!)).object.sha;
  const suites = run.milestoneChecks?.length
    ? run.milestoneChecks
    : [
        {
          stage: stage.id,
          title: stage.title,
          requiredCheck: stage.requiredCheck,
          workflowPath: stage.workflowPath,
          protectedFiles: Object.fromEntries(
            (stage.protectedFiles ?? []).map((path) => [
              path,
              (stage.evaluatorFiles ?? stage.baseline)[path],
            ]),
          ),
        },
      ];
  const workflows = await gh.workflowRuns(root, sha);
  const checks = await gh.checkRuns(root, sha);
  const failed: string[] = [];
  const pending: string[] = [];
  const missing: string[] = [];
  for (const suite of suites) {
    const workflow = workflows
      .filter(
        (item) =>
          (item.path === suite.workflowPath ||
            item.path.startsWith(suite.workflowPath + "@")) &&
          item.head_sha === sha,
      )
      .sort((a, b) =>
        (b.created_at ?? "").localeCompare(a.created_at ?? ""),
      )[0];
    if (!workflow) {
      missing.push(suite.title);
      continue;
    }
    if (workflow.status !== "completed") {
      pending.push(suite.title);
      continue;
    }
    if (workflow.conclusion !== "success") {
      failed.push(suite.title);
      continue;
    }
    const check = checks.find(
      (item) =>
        (item.name === suite.requiredCheck ||
          (workflow.name &&
            suite.requiredCheck === `${workflow.name} / ${item.name}`)) &&
        item.head_sha === sha &&
        item.app?.slug === "github-actions" &&
        item.check_suite?.id === workflow.check_suite_id,
    );
    if (!check) {
      missing.push(suite.title);
      continue;
    }
    if (check.status !== "completed") {
      pending.push(suite.title);
      continue;
    }
    if (check.conclusion !== "success") {
      failed.push(suite.title);
      continue;
    }
    const protectedPaths = Object.keys(suite.protectedFiles);
    const observed = await gh.treeFiles(root, sha, protectedPaths);
    if (
      protectedPaths.some(
        (path) => observed[path] !== suite.protectedFiles[path],
      )
    )
      failed.push(suite.title);
  }
  const status: MilestoneTestStatus = failed.length
    ? "failed"
    : pending.length
      ? "pending"
      : missing.length
        ? "missing"
        : "passed";
  return { status, failed, pending, missing };
}

export async function milestoneTestStatus(
  run: Run,
  gh: GitHub,
): Promise<MilestoneTestStatus> {
  return (await milestoneTestReport(run, gh)).status;
}

const compact = (value: string | null | undefined, max: number) =>
  (value ?? "").slice(0, max);

function louibotPlayerRounds(
  comments: {
    body?: string | null;
    created_at?: string;
    user?: { id?: number; type?: string } | null;
  }[],
  player: number,
) {
  let awaitingReply = false;
  let rounds = 0;
  for (const comment of [...comments].sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? ""),
  )) {
    const body = comment.body ?? "";
    if (isLouibotClarification(body)) {
      awaitingReply = true;
    } else if (comment.user?.id === player && awaitingReply) {
      rounds++;
      awaitingReply = false;
    }
  }
  return rounds;
}

function isLouibotClarification(body: string) {
  return (
    /^## Clarification needed(?:\r?\n|$)/m.test(body) &&
    /Generated by \[Louibot\]\(https:\/\/github\.com\/rkkautsar\/louibot\)/.test(
      body,
    )
  );
}

function linksIssue(body: string, number: number) {
  const escaped = String(number).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${escaped}\\b`,
    "i",
  ).test(body);
}

async function judgementInput(
  run: Run,
  gh: GitHub,
  status: MilestoneTestStatus,
): Promise<MilestoneJudgement> {
  const stage = scenarioFor(run);
  const root = runRoot(run);
  const items = await gh.listSubIssues(root, run.master!);
  const issueItems = items.filter((item) => !item.pull_request).slice(0, 30);
  // PRs do not always inherit their linked issue's milestone in GitHub, so
  // include repository PRs and grade their linked issue references.
  const pullList = await gh.listPullDetails(root);
  const issueComments = new Map<
    number,
    Awaited<ReturnType<GitHub["listComments"]>>
  >();
  for (const issue of issueItems)
    issueComments.set(
      issue.number,
      await gh.listComments(`${root}/issues/${issue.number}/comments`),
    );
  const clarificationByIssue = new Map(
    [...issueComments].map(([number, comments]) => [
      number,
      louibotPlayerRounds(comments, run.player),
    ]),
  );
  const pullStates = new Map(
    pullList.map((pull) => [
      pull.number,
      {
        merged: !!pull.merged_at,
        body: pull.body ?? "",
        title: pull.title ?? `Pull request #${pull.number}`,
      },
    ]),
  );
  const mergedLinked = new Set(
    [...pullStates.values()]
      .filter((pull) => pull.merged)
      .flatMap((pull) =>
        issueItems
          .filter((issue) => linksIssue(pull.body, issue.number))
          .map((issue) => issue.number),
      ),
  );
  // Only clarification rounds on issues without a merged PR incur the penalty.
  // There is deliberately no issue-count gate.
  const clarificationRounds = [...clarificationByIssue].reduce(
    (count, [number, rounds]) =>
      count + (mergedLinked.has(number) ? 0 : rounds),
    0,
  );
  const issues = issueItems.map((issue) => ({
    number: issue.number,
    title: compact(issue.title, 150),
    body: compact(issue.body, 400),
    conversation: (issueComments.get(issue.number) ?? [])
      .filter(
        (x) =>
          isLouibotClarification(x.body ?? "") || x.user?.id === run.player,
      )
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
      .slice(-8)
      .map(
        (x) =>
          `${
            isLouibotClarification(x.body ?? "") ? "Louibot" : "Player"
          }: ${compact(x.body, 300)}`,
      ),
  }));
  const pullRequests = [];
  const selectedPulls = [...pullStates.entries()]
    .sort((a, b) => Number(b[1].merged) - Number(a[1].merged))
    .slice(0, 3);
  for (const [number, pull] of selectedPulls) {
    const [files, reviews, comments] = await Promise.all([
      gh.listPullFiles(root, number),
      gh.listReviews(root, number),
      gh.listComments(`${root}/pulls/${number}/comments`),
    ]);
    const diff = files
      .slice(0, 5)
      .map(
        (file) =>
          `--- ${file.status} ${file.filename}\n${compact(file.patch, 400)}`,
      )
      .join("\n")
      .slice(0, 700);
    pullRequests.push({
      number,
      title: compact(pull.title, 120),
      body: compact(pull.body, 350),
      merged: pull.merged,
      diff,
      reviews: [
        ...reviews
          .filter((review) => review.user?.id === run.player)
          .map((review) => compact(review.body, 180)),
        ...comments
          .filter((comment) => comment.user?.id === run.player)
          .map((comment) => compact(comment.body, 150)),
      ].slice(0, 3),
    });
  }
  return {
    objective: compact(stage.intro, 2000),
    evaluation: stage.evaluation
      ? {
          issueBreakdown: compact(stage.evaluation.issueBreakdown, 500),
          issueClarity: compact(stage.evaluation.issueClarity, 500),
          pullRequestQuality: compact(stage.evaluation.pullRequestQuality, 500),
          reviewQuality: compact(stage.evaluation.reviewQuality, 500),
        }
      : undefined,
    testStatus: status,
    clarificationRounds,
    issues,
    pullRequests,
  };
}

function validQuality(
  value: MilestoneQuality | undefined,
): value is MilestoneQuality {
  const scores = value && [
    value.issueBreakdown,
    value.issueClarity,
    value.pullRequestQuality,
    value.reviewQuality,
  ];
  return (
    !!scores &&
    scores.some(
      (score) =>
        score !== null && Number.isInteger(score) && score >= 0 && score <= 100,
    ) &&
    scores.every(
      (score) =>
        score === null ||
        (Number.isInteger(score) && score >= 0 && score <= 100),
    )
  );
}

export async function assessMilestone(
  run: Run,
  gh: GitHub,
  reviewer: Reviewer,
  judgeEnabled: boolean,
): Promise<Assessment> {
  const testReport = await milestoneTestReport(run, gh);
  const status = testReport.status;
  const input =
    judgeEnabled && reviewer.gradeMilestone
      ? await judgementInput(run, gh, status)
      : undefined;
  let quality: MilestoneQuality | undefined;
  if (reviewer.gradeMilestone && input) {
    quality = await reviewer.gradeMilestone(input);
    if (!validQuality(quality)) quality = undefined;
  }
  const clarificationRounds = input?.clarificationRounds ?? 0;
  const clarificationPenalty = clarificationRounds * 10;
  const issueClarity =
    quality?.issueClarity === null || quality?.issueClarity === undefined
      ? null
      : Math.max(0, quality.issueClarity - clarificationPenalty);
  const milestone = status === "passed" ? 100 : status === "failed" ? 0 : null;
  const scorecard = {
    milestone,
    issueBreakdown: quality?.issueBreakdown ?? null,
    issueClarity,
    pullRequestQuality: quality?.pullRequestQuality ?? null,
    reviewQuality: quality?.reviewQuality ?? null,
    clarificationRounds,
    testStatus: status,
  } as const;
  const dimensions = [
    [scorecard.milestone, 50],
    [scorecard.issueBreakdown, 15],
    [scorecard.issueClarity, 15],
    [scorecard.pullRequestQuality, 10],
    [scorecard.reviewQuality, 10],
  ] as const;
  const points = dimensions.reduce(
    (sum, [score, weight]) =>
      sum + (score === null ? 0 : Math.round((score / 100) * weight)),
    0,
  );
  const maximum = dimensions.reduce(
    (sum, [score, weight]) => sum + (score === null ? 0 : weight),
    0,
  );
  const explanation =
    status === "passed"
      ? "The active milestone and all previously completed milestone E2E suites passed on the current default branch."
      : status === "failed"
        ? `Milestone E2E suite(s) failed on the current default branch: ${testReport.failed.join(", ")}.`
        : status === "pending"
          ? `Milestone E2E suite(s) are still running: ${testReport.pending.join(", ")}.`
          : `No run was found for milestone E2E suite(s): ${testReport.missing.join(", ")}.`;
  const qualityLabels = {
    issueBreakdown: "issue breakdown",
    issueClarity: "issue clarity",
    pullRequestQuality: "pull request quality",
    reviewQuality: "review quality",
  } as const;
  const assessed = quality
    ? (Object.keys(qualityLabels) as (keyof typeof qualityLabels)[]).filter(
        (key) => quality[key] !== null,
      )
    : [];
  const unassessed = (
    Object.keys(qualityLabels) as (keyof typeof qualityLabels)[]
  ).filter((key) => !assessed.includes(key));
  const qualityReasoning =
    assessed.length === 0
      ? "Quality dimensions were not assessed by Clef."
      : [
          `Clef assessed ${assessed.map((key) => qualityLabels[key]).join(", ")}.`,
          unassessed.length
            ? `${unassessed.map((key) => qualityLabels[key]).join(", ")} ${unassessed.length === 1 ? "was" : "were"} not assessed.`
            : undefined,
        ]
          .filter((part): part is string => !!part)
          .join(" ");
  return {
    complete: status === "passed" ? ["milestone"] : [],
    total: 1,
    points,
    maximum,
    success: status === "passed" ? true : status === "failed" ? false : null,
    harmful: [],
    debt: [],
    decisions: [
      {
        id: "milestone",
        outcome: status,
        points: milestone === null ? null : Math.round((milestone / 100) * 50),
        explanation,
      },
    ],
    reasoning:
      qualityReasoning +
      (clarificationRounds
        ? ` ${clarificationRounds} Louibot clarification round(s) on issues without a merged linked PR reduced issue clarity.`
        : ""),
    scorecard,
  };
}
