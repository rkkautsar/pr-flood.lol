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
  if (stage.mode === "milestone") {
    return [
      `# ${stage.title}`,
      stage.intro,
      run.base
        ? `[Browse the current stage code](https://github.com/${run.owner}/${run.repo}/tree/${encodeURIComponent(run.base)}) — branch \`${run.base}\`. Pull this branch and restart the local app after merging.`
        : "",
      "## Plan and deliver the milestone",
      `[Open milestone #${run.milestone}](https://github.com/${run.owner}/${run.repo}/milestone/${run.milestone}) and [Game Master issue #${run.master}](https://github.com/${run.owner}/${run.repo}/issues/${run.master}). Create your work items as direct sub-issues of Game Master #${run.master}, yourself or with an issue-writing agent. Write clear scope and acceptance criteria so Louibot can work from the issue without repeated clarification. You choose the issue breakdown; there is no minimum issue count.`,
      "Set up [Louibot](https://github.com/rkkautsar/louibot) locally and choose the worker model you want to use. On each issue, add a separate comment containing exactly `@louibot implement`. Review the resulting draft pull requests, link each PR to the issue it delivers, and merge the changes you accept. Louibot does not merge PRs for you.",
      `When your changes are ready for grading, comment \`/game done\` here. PR Flood will add its trusted E2E checks and run them against the default branch; they are hidden while you plan and work issues. If a check fails, fix the milestone and push your changes. The score and debrief appear after all checks pass. Later cards rerun suites for previously completed milestones too. You can comment \`/game reroll\` before creating a sub-issue to request a different card (up to ${run.rerollsRemaining ?? 2} times), or comment \`/game finish\` here to end early and receive a partial result.`,
      "Your score is out of 100: milestone completion 50 points, issue breakdown 15, issue clarity 15, pull request quality 10, and review quality 10. Each quality rating is scaled by its weight. Passing every E2E suite earns all 50 milestone points even if the breakdown score is low. A failing suite is listed by milestone in the debrief; it means that milestone's required behavior is failing on the current code.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
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
