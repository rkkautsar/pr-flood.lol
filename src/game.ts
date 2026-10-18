import { failureCode, report } from "./diagnostics.ts";
import { assess } from "./engine.ts";
import { postNotice, sendStoryTouches } from "./game/messages.ts";
import { advanceStage, rerollMilestoneCard } from "./game/progression.ts";
import { seedRun } from "./game/provisioning.ts";
import { publishResult } from "./game/publishing.ts";
import { reconcileRun } from "./game/reconciliation.ts";
import {
  assessMilestone,
  installMilestoneTests,
  milestoneTestReport,
  milestoneTestStatus,
} from "./game/milestone.ts";
import { assessReviews } from "./game/reviews.ts";
import { recoverRevision, revisePull } from "./game/revisions.ts";
import { GitHub } from "./github.ts";
import { scenarioFor } from "./packages.ts";
import type { Persistence, Reviewer } from "./persistence.ts";
import { command } from "./security.ts";
import type { Run } from "./types.ts";
import { parseWebhook } from "./webhooks.ts";
export class Game {
  store: Persistence;
  reviewer: Reviewer;
  judgeEnabled: boolean;
  connect: (r: Run) => Promise<GitHub>;
  constructor(
    store: Persistence,
    connect: (run: Run) => Promise<GitHub>,
    reviewer: Reviewer = { evaluate: async () => undefined },
    judgeEnabled = false,
  ) {
    this.reviewer = reviewer;
    this.judgeEnabled = judgeEnabled;
    this.store = store;
    this.connect = connect;
  }
  async seed(r: Run) {
    return seedRun(this.store, r, await this.connect(r));
  }
  async reconcile(r: Run, gh: GitHub, reviewPR?: number) {
    return reconcileRun(this.store, r, gh, reviewPR);
  }
  async humanTouches(r: Run, gh: GitHub) {
    return sendStoryTouches(this.store, r, gh);
  }
  async notice(r: Run, gh: GitHub, id: string, body: string) {
    return postNotice(this.store, r, gh, id, body);
  }
  async revise(r: Run, number: number, gh: GitHub) {
    return revisePull(this.store, r, number, gh);
  }
  async recoverRevision(r: Run, gh: GitHub) {
    return recoverRevision(this.store, r, gh);
  }
  async finish(r: Run, gh: GitHub) {
    r.phase = "finishing";
    r.result =
      scenarioFor(r).mode === "milestone"
        ? await assessMilestone(r, gh, this.reviewer, this.judgeEnabled)
        : assess(r);
    this.store.save(r);
    await this.publish(r, gh);
  }
  async publish(r: Run, gh: GitHub) {
    return publishResult(this.store, r, gh);
  }
  async nextStage(r: Run, gh: GitHub) {
    return advanceStage(this.store, r, gh);
  }
  async process(event: string, input: unknown) {
    const payload = parseWebhook(input);
    const runs = payload.repository
      ? this.store.forRepository(payload.repository.id)
      : this.store.all();
    for (const r of runs) {
      if (payload.installation?.id !== r.installation) continue;
      if (
        (event === "installation" &&
          ["deleted", "suspend"].includes(payload.action ?? "")) ||
        (event === "installation_repositories" &&
          payload.repositories_removed?.some((x) => x.id === r.repository))
      ) {
        if (["finished", "inaccessible"].includes(r.phase)) continue;
        r.phaseBeforeAccessLoss = r.phase;
        r.phase = "inaccessible";
        this.store.save(r);
        continue;
      }
      if (
        r.phase === "finished" &&
        event === "issue_comment" &&
        payload.action === "created" &&
        payload.repository?.id === r.repository &&
        payload.issue?.number === r.master &&
        payload.comment?.user?.id === r.player &&
        command(payload.comment?.body ?? "")?.kind === "next"
      ) {
        // Only the latest stage responds; old stages share the same story hub.
        const child = this.store.all().find((x) => x.previousRun === r.id);
        if (!child || child.phase === "seeding")
          await this.nextStage(r, await this.connect(r));
        continue;
      }
      const accessRestored =
        (event === "installation" &&
          ["created", "unsuspend"].includes(payload.action ?? "")) ||
        (event === "installation_repositories" &&
          payload.action === "added" &&
          payload.repositories_added?.some((x) => x.id === r.repository));
      if (r.phase === "inaccessible" && accessRestored) {
        r.phase = r.phaseBeforeAccessLoss ?? "active";
        delete r.phaseBeforeAccessLoss;
        this.store.save(r);
      }
      if (
        payload.repository?.id !== r.repository ||
        ["finished", "inaccessible", "seeding"].includes(r.phase)
      )
        continue;
      const stageMode = scenarioFor(r).mode ?? "review";
      if (r.mode !== stageMode) {
        r.mode = stageMode;
        this.store.save(r);
      }
      const milestoneMode = stageMode === "milestone";
      if (
        event === "issue_comment" &&
        (milestoneMode
          ? payload.comment?.user.id !== r.player &&
            payload.comment?.user.type !== "Bot"
          : payload.issue?.number !== r.master ||
            payload.comment?.user.id !== r.player ||
            !command(payload.comment?.body ?? ""))
      )
        continue;
      const gh = await this.connect(r);
      if (r.phase === "finishing") {
        await this.publish(r, gh);
        continue;
      }
      if (milestoneMode) {
        const cmd =
          event === "issue_comment" &&
          payload.action === "created" &&
          payload.issue?.number === r.master &&
          payload.comment?.user.id === r.player
            ? command(payload.comment.body)
            : undefined;
        if (cmd?.kind === "reroll") {
          const changed = await rerollMilestoneCard(
            this.store,
            r,
            gh,
            payload.comment?.id,
          );
          await this.notice(
            r,
            gh,
            "milestone-reroll-" +
              (changed.ok ? "changed-" : "blocked-") +
              (r.offeredCards?.length ?? 0) +
              (changed.ok ? "" : "-" + r.rerollsRemaining),
            changed.ok
              ? `🎲 New milestone card: **${changed.title}**. You have ${r.rerollsRemaining ?? 0} card change(s) left. Start planning with direct sub-issues under this issue.`
              : changed.message,
          );
          continue;
        }
        if (cmd?.kind === "done") {
          const head = (
            await gh.reference("/repos/" + r.owner + "/" + r.repo, r.base!)
          ).object.sha;
          const before = await milestoneTestReport(r, gh);
          const retryFailedSameHead =
            r.milestoneDoneRequested &&
            r.milestoneCheckHead === head &&
            before.status === "failed";
          const installed = await installMilestoneTests(
            r,
            gh,
            retryFailedSameHead ||
              (!r.milestoneDoneRequested && before.status === "missing"),
          );
          r.milestoneDoneRequested = true;
          r.milestoneCheckHead = installed.sha;
          this.store.save(r);
          const report = await milestoneTestReport(r, gh);
          if (report.status === "passed") {
            await this.notice(
              r,
              gh,
              "milestone-passed",
              "✅ The trusted milestone checks passed. I’m finalizing the scorecard and debrief now.",
            );
            await this.finish(r, gh);
          } else if (report.status === "failed") {
            await this.notice(
              r,
              gh,
              "milestone-failed-" + installed.sha,
              `The trusted milestone checks failed: ${report.failed.join(", ")}. Fix the milestone and push your changes; the checks will run again.`,
            );
          } else {
            await this.notice(
              r,
              gh,
              "milestone-running-" + installed.sha,
              "🧪 I’ve added the trusted milestone checks and started GitHub Actions. I’ll post your score and debrief when they finish.",
            );
          }
          continue;
        }
        const testStatus =
          cmd?.kind === "finish" ||
          (scenarioFor(r).evaluatorFiles && !r.milestoneDoneRequested)
            ? undefined
            : await milestoneTestStatus(r, gh);
        if (testStatus === "passed") {
          try {
            await this.notice(
              r,
              gh,
              "milestone-passed",
              "✅ The required E2E check passed. I’m finalizing the scorecard now and will post the result here.",
            );
          } catch (error) {
            report({
              component: "game",
              event: "milestone_status_notice_failed",
              reason: failureCode(error),
              run: r.id,
            });
          }
        }
        if (r.milestoneDoneRequested) {
          const report = await milestoneTestReport(r, gh);
          const head = (
            await gh.reference("/repos/" + r.owner + "/" + r.repo, r.base!)
          ).object.sha;
          if (r.milestoneCheckHead !== head) {
            r.milestoneCheckHead = head;
            this.store.save(r);
          }
          if (testStatus === "failed")
            await this.notice(
              r,
              gh,
              "milestone-failed-" + head,
              `The trusted milestone checks failed: ${report.failed.join(", ")}. Fix the milestone and push your changes; the checks will run again.`,
            );
        }
        if (
          cmd?.kind === "finish" ||
          (testStatus === "passed" &&
            (!scenarioFor(r).evaluatorFiles || r.milestoneDoneRequested))
        ) {
          await this.finish(r, gh);
        }
        report({
          component: "game",
          event: "milestone_reconciled",
          run: r.id,
          requests: gh.requestCount,
        });
        continue;
      }
      const { proposals } = scenarioFor(r);
      await this.recoverRevision(r, gh);
      await this.humanTouches(r, gh);
      await this.reconcile(
        r,
        gh,
        event.startsWith("pull_request_review")
          ? payload.pull_request?.number
          : undefined,
      );
      const cmd =
        event === "issue_comment" &&
        payload.action === "created" &&
        payload.issue?.number === r.master &&
        payload.comment?.user?.id === r.player
          ? command(payload.comment?.body ?? "")
          : undefined;

      await assessReviews(
        this.store,
        this.reviewer,
        this.judgeEnabled,
        r,
        gh,
        cmd?.kind === "finish",
      );
      if (cmd?.kind === "revise") {
        if (proposals.some((p) => r.prs[p.id].number === cmd.number))
          await this.revise(r, cmd.number, gh);
        else
          await this.notice(
            r,
            gh,
            "unknown-pr",
            "Use /game revise with a scenario PR number.",
          );
      }
      if (
        cmd?.kind === "finish" ||
        proposals.every((p) => r.prs[p.id].outcome !== "open")
      ) {
        await this.reconcile(r, gh);
        r.finishEarly = cmd?.kind === "finish";
        await this.finish(r, gh);
      }
      report({
        component: "game",
        event: "reconciled",
        run: r.id,
        requests: gh.requestCount,
      });
    }
  }
}
