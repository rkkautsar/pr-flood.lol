import { errorStatus } from "../diagnostics.ts";
import type { GitHub } from "../github.ts";
import { scenarioFor, selectScenario } from "../packages.ts";
import type { Persistence } from "../persistence.ts";
import type { Run } from "../types.ts";
import { postNotice } from "./messages.ts";
import { seedRun } from "./provisioning.ts";
import { runMarker, equalFiles, runRoot } from "./shared.ts";
import { storyBody } from "../story.ts";

export async function advanceStage(store: Persistence, r: Run, gh: GitHub) {
  const stage = scenarioFor(r);
  const target = stage.pool
    ? stage.pack.stages.find(
        (card) =>
          card.pool === stage.pool && !r.offeredCards?.includes(card.id),
      )
    : stage.next
      ? stage.pack.stages.find((s) => s.id === stage.next)
      : undefined;
  if (!target) {
    await postNotice(
      store,
      r,
      gh,
      "campaign-complete",
      "You have reached the end of this scenario. Your decisions and debriefs are preserved. Start a fresh playthrough from the launch page to try another approach.",
    );
    return;
  }
  const existing = store.all().find((x) => x.previousRun === r.id);
  if (existing) {
    if (existing.phase === "seeding") await seedRun(store, existing, gh);
    return;
  }
  const root = runRoot(r);
  let base = r.base!;
  let sha: string;
  if (stage.pool) {
    // Cards in a pool assess the same evolving repository. Never reset to an
    // authored snapshot; take the latest accepted default-branch commit.
    sha = (await gh.reference(root, base)).object.sha;
  } else {
    const branch = `play/${r.id}/${target.id}`;
    try {
      sha = (await gh.reference(root, branch)).object.sha;
    } catch (error) {
      if (errorStatus(error) !== 404) throw error;
      const parent = (await gh.reference(root, r.base!)).object.sha;
      const files = await gh.tree(root, parent);
      const commit = await gh.commit(
        root,
        parent,
        target.baseline,
        "Begin " + target.title,
        Object.keys(files).filter((path) => !(path in target.baseline)),
      );
      await gh.post(root + "/git/refs", {
        ref: "refs/heads/" + branch,
        sha: commit.sha,
      });
      sha = commit.sha;
    }
    if (!equalFiles(await gh.tree(root, sha), target.baseline))
      throw Error("Next-stage branch was changed before setup");
    base = branch;
  }
  const next: Run = {
    id: r.id + "-" + target.id,
    installation: r.installation,
    repository: r.repository,
    owner: r.owner,
    repo: r.repo,
    player: r.player,
    phase: "seeding",
    issues: {},
    prs: {},
    findings: {},
    previousRun: r.id,
    master: r.master,
    base,
    baseline: sha,
    scenario: selectScenario(stage.pack, target.id),
    milestoneChecks: r.milestoneChecks ? [...r.milestoneChecks] : undefined,
    offeredCards: target.pool
      ? [...(r.offeredCards ?? [stage.id]), target.id]
      : undefined,
    rerollsRemaining: target.pool ? 2 : undefined,
  };
  store.save(next);
  await seedRun(store, next, gh);
}

export async function rerollMilestoneCard(
  store: Persistence,
  r: Run,
  gh: GitHub,
  commentId?: number,
) {
  const current = scenarioFor(r);
  if (commentId && r.rerollCommentIds?.includes(commentId))
    return { ok: true as const, title: current.title };
  if (!current.pool || !r.master || !r.base || !r.baseline)
    return {
      ok: false as const,
      message: "This milestone has no alternate cards.",
    };
  if ((r.rerollsRemaining ?? 0) <= 0)
    return {
      ok: false as const,
      message: "You have used both card changes for this milestone.",
    };
  const root = runRoot(r);
  const children = await gh.listSubIssues(root, r.master);
  const head = (await gh.reference(root, r.base)).object.sha;
  if (children.length || head !== r.baseline)
    return {
      ok: false as const,
      message:
        "A card can only change before you create sub-issues or push implementation commits.",
    };
  const target = current.pack.stages.find(
    (stage) =>
      stage.pool === current.pool && !r.offeredCards?.includes(stage.id),
  );
  if (!target)
    return {
      ok: false as const,
      message: "There are no other milestone cards in this pool.",
    };
  r.scenario = { ...r.scenario, stage: target.id };
  r.offeredCards = [...(r.offeredCards ?? [current.id]), target.id];
  r.rerollsRemaining = Math.max(0, (r.rerollsRemaining ?? 2) - 1);
  if (commentId)
    r.rerollCommentIds = [...(r.rerollCommentIds ?? []), commentId].slice(-32);
  r.milestoneChecks = (r.milestoneChecks ?? []).filter(
    (check) => check.stage !== current.id,
  );
  const stage = scenarioFor(r);
  r.milestoneChecks!.push({
    stage: stage.id,
    title: stage.title,
    requiredCheck: stage.requiredCheck!,
    workflowPath: stage.workflowPath!,
    protectedFiles: Object.fromEntries(
      (stage.protectedFiles ?? []).map((path) => [path, stage.baseline[path]]),
    ),
  });
  await gh.patch(root + "/milestones/" + r.milestone, {
    title: `${stage.pack.title} — ${r.id} [card:${stage.id}]`,
  });
  await gh.patch(root + "/issues/" + r.master, {
    title: "Game Master — " + stage.title,
    body: storyBody(r) + "\n\n" + runMarker(r, "master"),
  });
  await gh.patch(root + "/milestones/" + r.milestone, {
    description: stage.intro,
  });
  store.save(r);
  return { ok: true as const, title: stage.title };
}
