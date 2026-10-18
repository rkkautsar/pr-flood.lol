import { errorStatus } from "../diagnostics.ts";
import type { GitHub } from "../github.ts";
import { scenarioFor, selectScenario } from "../packages.ts";
import type { Persistence } from "../persistence.ts";
import type { Run } from "../types.ts";
import { postNotice } from "./messages.ts";
import { seedRun } from "./provisioning.ts";
import { equalFiles, runRoot } from "./shared.ts";

export async function advanceStage(store: Persistence, r: Run, gh: GitHub) {
  const stage = scenarioFor(r);
  if (!stage.next) {
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
  const target = stage.pack.stages.find((s) => s.id === stage.next)!;
  const root = runRoot(r),
    branch = `play/${r.id}/${target.id}`;
  let sha: string;
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
    base: branch,
    baseline: sha,
    scenario: selectScenario(stage.pack, target.id),
    milestoneChecks: r.milestoneChecks ? [...r.milestoneChecks] : undefined,
  };
  store.save(next);
  await seedRun(store, next, gh);
}
