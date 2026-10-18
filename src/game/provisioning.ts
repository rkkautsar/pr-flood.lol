import { errorStatus } from "../diagnostics.ts";
import { atSeedStep } from "./seed-steps.ts";
import type { GitHub } from "../github.ts";
import { applyVariant, renderLinks, scenarioFor } from "../packages.ts";
import type { Persistence } from "../persistence.ts";
import { contributorNote, storyBody } from "../story.ts";
import type { Run } from "../types.ts";
import { sendStoryTouches } from "./messages.ts";
import { equalFiles, pinBaseline, runMarker, runRoot } from "./shared.ts";

export async function seedRun(store: Persistence, r: Run, gh: GitHub) {
  const { baseline, issues, proposals, pack, title } = await atSeedStep(
    "load_scenario",
    () => scenarioFor(r),
  );
  r.mode = scenarioFor(r).mode ?? "review";
  if (r.mode === "milestone") {
    const stage = scenarioFor(r);
    r.milestoneChecks ??= [];
    if (!r.milestoneChecks.some((check) => check.stage === stage.id))
      r.milestoneChecks.push({
        stage: stage.id,
        title: stage.title,
        requiredCheck: stage.requiredCheck!,
        workflowPath: stage.workflowPath!,
        protectedFiles: Object.fromEntries(
          (stage.protectedFiles ?? []).map((path) => [
            path,
            stage.baseline[path],
          ]),
        ),
      });
  }
  store.save(r);
  const root = runRoot(r);
  const repository = await atSeedStep("read_repository", () =>
    gh.repository(root),
  );
  if (
    repository.id !== r.repository ||
    repository.archived ||
    repository.disabled
  )
    throw new Error("Invalid target repository");
  if (r.phase !== "seeding") throw new Error("Run is not seeding");
  if (!r.baseline) {
    await atSeedStep("validate_baseline", async () => {
      r.base = repository.default_branch;
      const ref = await gh.reference(root, r.base!);
      if (!equalFiles(await gh.tree(root, ref.object.sha), baseline))
        throw new Error(
          "Target does not exactly match selected scenario baseline",
        );
      if ((await gh.listIssues(root)).length)
        throw new Error("Start in a fresh repository without issues or PRs");
      r.baseline = ref.object.sha;
      store.save(r);
    });
  }
  await atSeedStep("pin_baseline", () => pinBaseline(store, r, gh));
  if (!r.milestone) {
    await atSeedStep("create_milestone", async () => {
      const title = pack.title + " — " + r.id;
      const existing = (await gh.listMilestones(root)).find(
        (x) => x.title === title,
      );
      r.milestone = (
        existing ??
        (await gh.createNumbered(root + "/milestones", {
          title,
          description:
            issues.map((i) => i.title).join("; ") ||
            (scenarioFor(r).mode === "milestone" ? scenarioFor(r).intro : ""),
        }))
      ).number;
      store.save(r);
    });
  }
  const all = await atSeedStep("list_issues", () => gh.listIssues(root));
  if (!r.master) {
    await atSeedStep("create_master_issue", async () => {
      const body = storyBody(r) + "\n\n" + runMarker(r, "master");
      r.master = (
        all.find((x) => x.body?.includes(runMarker(r, "master"))) ??
        (await gh.createNumbered(root + "/issues", {
          title: "Game Master — " + title,
          body,
        }))
      ).number;
      store.save(r);
    });
  }
  if (r.master !== 1)
    throw new Error(
      "Game Master must be issue #1; start in a fresh repository with no previous issues or PRs",
    );
  await atSeedStep("create_player_issues", async () => {
    for (const issue of issues) {
      if (!r.issues[issue.id]) {
        const body = issue.body + "\n\n" + runMarker(r, issue.id);
        r.issues[issue.id] = (
          all.find((x) => x.body?.includes(runMarker(r, issue.id))) ??
          (await gh.createNumbered(root + "/issues", {
            title: issue.title,
            body,
            milestone: r.milestone,
          }))
        ).number;
        store.save(r);
      }
    }
  });
  await atSeedStep("seed_proposals", async () => {
    const prs = await gh.listPulls(root);
    for (const p of proposals) {
      if (r.prs[p.id]) continue;
      const branch = `game/${r.id}/${p.id}`;
      let head: string;
      try {
        head = (await gh.reference(root, branch)).object.sha;
      } catch (e) {
        if (errorStatus(e) !== 404) throw e;
        head = (
          await gh.commit(
            root,
            r.baseline!,
            p.variants[0].files,
            "Community contribution",
            p.variants[0].deletes,
          )
        ).sha;
        await gh.post(root + "/git/refs", {
          ref: "refs/heads/" + branch,
          sha: head,
        });
      }
      if (
        !equalFiles(await gh.tree(root, head), {
          ...applyVariant({ ...r.baselineFiles }, p.variants[0]),
        })
      )
        throw new Error("Unexpected seeded branch");
      const body =
        contributorNote(r, p.id) +
        "\n\n" +
        renderLinks(p.body, r) +
        (p.issue ? "\n\nCloses #" + r.issues[p.issue] : "") +
        "\n\n" +
        runMarker(r, p.id);
      const pr =
        prs.find((x) => x.body?.includes(runMarker(r, p.id))) ??
        (await gh.createNumbered(root + "/pulls", {
          title: p.title,
          body,
          head: branch,
          base: r.base,
        }));
      r.prs[p.id] = {
        number: pr.number,
        revision: 0,
        outcome: "open",
        head,
        reviews: [],
      };
      store.save(r);
    }
    for (const p of proposals.filter((p) => p.body.includes("{{pr:"))) {
      const body =
        contributorNote(r, p.id) +
        "\n\n" +
        renderLinks(p.body, r) +
        (p.issue ? "\n\nCloses #" + r.issues[p.issue] : "") +
        "\n\n" +
        runMarker(r, p.id);
      const pr = await gh.pull(root, r.prs[p.id].number);
      if (pr.body !== body)
        await gh.patch(root + "/pulls/" + r.prs[p.id].number, { body });
    }
  });
  await atSeedStep("update_master_issue", () =>
    gh.patch(root + "/issues/" + r.master, {
      body: storyBody(r) + "\n\n" + runMarker(r, "master"),
    }),
  );
  await atSeedStep("send_story_touches", () => sendStoryTouches(store, r, gh));
  await atSeedStep("activate_run", async () => {
    r.phase = "active";
    store.save(r);
  });
}
