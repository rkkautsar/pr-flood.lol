import { publicCharacter, renderLinks, scenarioFor } from "./packages.ts";
import type { Assessment, Run } from "./types.ts";
export function storyEnding(result: Assessment, run: Run): string {
  const s = scenarioFor(run);
  return result.success === null
    ? s.endings.partial
    : result.success
      ? s.endings.success
      : s.endings.incomplete;
}
export function revisionReply(run: Run, id: string): string {
  const p = scenarioFor(run).proposals.find((p) => p.id === id)!;
  return (
    publicCharacter(run, p.character) +
    (p.variants[run.prs[id].revision].reply ??
      "I have pushed the prepared revision. Please take another look.")
  );
}
export function contributorNote(run: Run, id: string) {
  return publicCharacter(
    run,
    scenarioFor(run).proposals.find((p) => p.id === id)?.character,
  );
}
export function followup(run: Run, id: string) {
  const p = scenarioFor(run).proposals.find((p) => p.id === id);
  return p?.followup
    ? publicCharacter(run, p.character) + p.followup
    : undefined;
}
export function storyBody(run: Run) {
  const stage = scenarioFor(run);
  if (stage.mode === "milestone")
    return [
      `# ${stage.title}`,
      stage.intro,
      run.base
        ? `[Browse the current stage code](https://github.com/${run.owner}/${run.repo}/tree/${encodeURIComponent(run.base)}) — branch \`${run.base}\`. Pull this branch and restart the local app after merging.`
        : "",
      "## Plan and deliver the milestone",
      `Create the GitHub issues you need and add each one to milestone #${run.milestone}. Write clear scope and acceptance criteria so Louibot can work from the issue without repeated clarification. You choose the issue breakdown; there is no minimum issue count.`,
      "Set up [Louibot](https://github.com/rkkautsar/louibot) locally and choose the worker model you want to use. On each issue, add a separate comment containing exactly `@louibot implement`. Review the resulting draft pull requests, link each PR to the issue it delivers, and merge the changes you accept. Louibot does not merge PRs for you.",
      `The milestone is complete when the trusted GitHub Actions check **${stage.requiredCheck}** passes on the current default branch. The full behavioral E2E suite runs after changes are merged to the default branch, not as a check on each pull request; its first successful run completes the milestone. You can comment \`/game finish\` here to end early and receive a partial result.`,
      "Your scorecard separates milestone completion from issue breakdown, issue clarity, pull request quality, and review quality. Completing the milestone earns its full credit even if the breakdown score is low.",
    ]
      .filter(Boolean)
      .join("\n\n");
  return renderLinks(
    [
      `# ${stage.title}`,
      stage.intro,
      run.base
        ? `[Browse the current stage code](https://github.com/${run.owner}/${run.repo}/tree/${encodeURIComponent(run.base)}) — branch \`${run.base}\`. Pull this branch and restart the local app after merging.`
        : "",
      "## This milestone",
      ...stage.issues.map((i) => `- #${run.issues[i.id] ?? "?"}: ${i.title}`),
      "## Contributions",
      ...stage.proposals.map(
        (p) => `- #${run.prs[p.id]?.number ?? "?"}: ${p.title}`,
      ),
      "## Playing",
      "Review, merge, close, or request changes using GitHub. You do not need to write code. Contributor portraits identify fictional characters; all posts come from the game App.",
      "The stage ends when every scenario PR is closed. Comment `/game finish` here to release early. To request a prepared revision when automatic review matching is unavailable, comment `/game revise <PR-number>` here. Revisions are limited and requesting one alone does not earn concern credit.",
      "Unsupported code changes do not stop the stage: affected assessments are marked unscored.",
    ].join("\n\n"),
    run,
  );
}
