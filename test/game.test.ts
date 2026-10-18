import { milestonePackage, packages } from "./fixtures/packages.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { findPackage, packageScope, selectScenario } from "../src/packages.ts";
packageScope.enterWith([...packages, milestonePackage]);
import { Game } from "../src/game.ts";
import { Store } from "../src/store.ts";
const pack = findPackage("forum", "0.1.0");
const inboxPack = milestonePackage;
const { baseline, proposals } = pack.stages[0];
import { expectedFiles, initialRun } from "../src/engine.ts";
import { GitHub } from "../src/github.ts";
import type { Run } from "../src/types.ts";
class Fake extends GitHub {
  constructor() {
    super("fixture");
  }
  files: Record<string, Record<string, string>> = { baseline: { ...baseline } };
  refs: Record<string, string> = { main: "baseline" };
  prs: any[] = [];
  issues: any[] = [];
  milestones: any[] = [];
  comments: any[] = [];
  commits = 0;
  failMilestones = false;
  failRevision = false;
  reviews: any[] = [];
  checkRunItems: any[] = [];
  workflowRunItems: any[] = [];
  pullFiles: any[] = [];
  async get(path: string): Promise<any> {
    if (path === "/repos/owner/game")
      return { id: 2, default_branch: "main", owner: { id: 3 } };
    if (path.includes("/git/ref/heads/")) {
      const ref = path.split("/git/ref/heads/")[1];
      if (!this.refs[ref])
        throw Object.assign(new Error("missing"), { status: 404 });
      return { object: { sha: this.refs[ref] } };
    }
    if (path.includes("/check-runs")) return { check_runs: this.checkRunItems };
    if (path.includes("/actions/runs"))
      return { workflow_runs: this.workflowRunItems };
    if (/\/pulls\/\d+$/.test(path)) {
      const number = Number(path.split("/").at(-1));
      return this.prs.find((p) => p.number === number);
    }
    throw new Error("Unexpected GET " + path);
  }
  async list(path: string) {
    const subIssues = /\/issues\/(\d+)\/sub_issues/.exec(path);
    if (subIssues)
      return this.issues.filter(
        (issue) => issue.parent_number === Number(subIssues[1]),
      );
    if (/\/issues\?milestone=\d+&state=all/.test(path)) {
      const number = Number(path.match(/\?milestone=(\d+)/)?.[1]);
      return this.issues.filter((issue) => issue.milestone === number);
    }
    if (/\/pulls\/\d+\/files/.test(path)) return this.pullFiles;
    if (path.includes("/reviews")) return this.reviews;
    if (path.includes("/comments"))
      return this.comments.filter((c) => c.path === path);
    if (path.includes("/milestones")) {
      if (this.failMilestones) throw new Error("private provider response");
      return this.milestones;
    }
    if (path.includes("/issues")) return this.issues;
    if (path.includes("/pulls")) return this.prs;
    throw new Error(path);
  }
  async tree(_root: string, sha: string) {
    return this.files[sha];
  }
  async treeFiles(_root: string, sha: string, paths: string[]) {
    return Object.fromEntries(
      paths.map((path) => [path, this.files[sha]?.[path]]),
    );
  }
  async commit(
    _root: string,
    parent: string,
    files: Record<string, string>,
    _message?: string,
    deletes: string[] = [],
  ) {
    const sha = "commit" + ++this.commits;
    this.files[sha] = { ...this.files[parent], ...files };
    for (const path of deletes) delete this.files[sha][path];
    return { sha };
  }
  async post(path: string, body: any) {
    if (path.endsWith("/git/refs")) {
      this.refs[body.ref.replace("refs/heads/", "")] = body.sha;
      return {};
    }
    if (path.endsWith("/milestones")) {
      const m = { ...body, number: this.milestones.length + 1 };
      this.milestones.push(m);
      return m;
    }
    if (path.endsWith("/issues")) {
      const i = {
        ...body,
        state: "open",
        user: { id: 3, type: "User" },
        number: 1 + this.issues.length + this.prs.length,
      };
      this.issues.push(i);
      return i;
    }
    if (path.endsWith("/pulls")) {
      const p = {
        ...body,
        number: 1 + this.issues.length + this.prs.length,
        state: "open",
        merged: false,
        head: { sha: this.refs[body.head], ref: body.head, repo: { id: 2 } },
        base: { ref: body.base },
      };
      this.prs.push(p);
      return p;
    }
    if (path.endsWith("/comments")) {
      const comment = {
        ...body,
        id: this.comments.length + 1,
        path,
        user: { type: "Bot" },
      };
      this.comments.push(comment);
      return comment;
    }
    throw new Error(path);
  }
  async patch(path: string, body: any) {
    if (path.includes("/issues/comments/")) {
      const comment = this.comments.find(
        (c) => c.id === Number(path.split("/").at(-1)),
      );
      Object.assign(comment, body);
      return comment;
    }
    if (path.includes("/milestones/")) {
      Object.assign(
        this.milestones.find(
          (m) => m.number === Number(path.split("/").at(-1)),
        ),
        body,
      );
      return {};
    }
    if (path.includes("/issues/")) {
      const issue = this.issues.find(
        (i) => i.number === Number(path.split("/").at(-1)),
      );
      Object.assign(issue, body);
      return issue;
    }
    const branch = path.split("/git/refs/heads/")[1];
    this.refs[branch] = body.sha;
    const pull = this.prs.find((p) => p.head.ref === branch);
    if (pull) pull.head.sha = body.sha;
    if (this.failRevision) {
      this.failRevision = false;
      throw Object.assign(new Error("network response lost"), { status: 500 });
    }
    return {};
  }
  merge(id: string, r: Run) {
    const pr = this.prs.find((p) => p.number === r.prs[id].number);
    pr.merged = true;
    pr.state = "closed";
    r.prs[id].outcome = "merged";
    const sha = "merged" + ++this.commits;
    this.files.final = expectedFiles(r);
    this.files[sha] = this.files.final;
    this.refs[r.base ?? "main"] = sha;
  }
}
async function setup(
  selection: Run["scenario"] = selectScenario(pack),
  seed = true,
) {
  const s = new Store(":memory:"),
    fake = new Fake(),
    game = new Game(s, async () => fake as unknown as GitHub);
  const r = initialRun({
    id: "run",
    installation: 1,
    repository: 2,
    owner: "owner",
    repo: "game",
    player: 3,
    scenario: selection,
  });
  if (selection) {
    r.scenario = selection;
    fake.files.baseline = {
      ...findPackage(selection.id, selection.version).stages.find(
        (s) => s.id === selection.stage,
      )!.baseline,
    };
  }
  s.save(r);
  if (seed) await game.seed(r);
  return { s, fake, game, r };
}
function payload(r: Run, body?: string, user = 3, commentId?: number) {
  return {
    installation: { id: 1 },
    repository: { id: 2 },
    action: "created",
    issue: { number: r.master },
    ...(body !== undefined
      ? { comment: { body, id: commentId, user: { id: user } } }
      : {}),
  };
}
test("seeding resumes with exact object counts and no duplicate creation", async () => {
  const { s, fake, game, r } = await setup();
  try {
    r.phase = "seeding";
    s.save(r);
    await game.seed(r);
    assert.equal(fake.milestones.length, 1);
    assert.equal(fake.issues.length, 6);
    assert.equal(r.master, 1);
    assert.match(fake.issues[0].body, /Synthetic scenario fixture/);
    assert.match(fake.issues[0].body, /Contributions/);
    assert.equal(fake.prs.length, 10);
    assert.equal(s.get("run").phase, "active");
  } finally {
    s.close();
  }
});
test("seed errors carry a safe step without replacing the original error", async () => {
  const { s, fake, game, r } = await setup(selectScenario(inboxPack), false);
  try {
    fake.failMilestones = true;
    await assert.rejects(game.seed(r), (error: any) => {
      assert.equal(error.step, "create_milestone");
      assert.equal(error.message, "private provider response");
      return true;
    });
  } finally {
    s.close();
  }
});
test("milestone stage withholds evaluator files until /game done, then grades and debriefs after Actions", async () => {
  const { s, fake, game, r } = await setup(selectScenario(inboxPack));
  try {
    assert.equal(fake.issues.length, 1);
    assert.equal(fake.prs.length, 0);
    assert.match(fake.issues[0].body, /direct sub-issues of Game Master #1/);
    assert.equal(fake.milestones.length, 1);
    assert.match(fake.issues[0].body, /comment `\/game done` here/);
    assert.ok(!fake.files.baseline[".github/workflows/inbox-e2e.yml"]);
    assert.ok(!fake.files.baseline["test/e2e/inbox.spec.ts"]);

    fake.issues.push(
      {
        number: 2,
        parent_number: r.master,
        title: "Add activity records",
        body: "Show private replies and votes, newest first.",
        state: "open",
        user: { id: 3, type: "User" },
        milestone: r.milestone,
      },
      {
        number: 4,
        parent_number: r.master,
        title: "Add private inbox",
        body: "Build a private inbox for replies and votes.",
        state: "open",
        user: { id: 3, type: "User" },
        milestone: r.milestone,
      },
    );
    const louibotQuestion = [
      "## Clarification needed",
      "",
      "Should read state be shared or private?",
      "",
      "---",
      "",
      "_Generated by [Louibot](https://github.com/rkkautsar/louibot), a local-first issue implementer._",
    ].join("\n");
    fake.comments.push(
      {
        id: 399,
        path: `/repos/${r.owner}/${r.repo}/issues/2/comments`,
        body: louibotQuestion,
        created_at: "2026-10-16T00:02:00Z",
        user: { id: r.player, type: "User" },
      },
      {
        id: 400,
        path: `/repos/${r.owner}/${r.repo}/issues/2/comments`,
        body: "Use private read state for each member.",
        created_at: "2026-10-16T00:03:00Z",
        user: { id: r.player, type: "User" },
      },
      {
        id: 401,
        path: `/repos/${r.owner}/${r.repo}/issues/4/comments`,
        body: louibotQuestion,
        created_at: "2026-10-16T00:00:00Z",
        user: { id: r.player, type: "User" },
      },
      {
        id: 402,
        path: `/repos/${r.owner}/${r.repo}/issues/4/comments`,
        body: "Read state should be private to each member.",
        created_at: "2026-10-16T00:01:00Z",
        user: { id: r.player, type: "User" },
      },
    );
    fake.prs.push({
      number: 3,
      title: "Build the inbox",
      body: "Closes #2",
      state: "closed",
      merged: true,
      merged_at: "2026-10-16T00:00:00Z",
      head: { sha: "head", repo: { id: 2 } },
      base: { ref: "main" },
    });
    fake.pullFiles = [
      { filename: "web/app.js", status: "modified", patch: "+renderInbox();" },
    ];
    game.judgeEnabled = true;
    game.reviewer.gradeMilestone = async () => ({
      issueBreakdown: 0,
      issueClarity: 75,
      pullRequestQuality: 75,
      reviewQuality: 0,
    });

    await game.process("check_run", payload(r));
    assert.equal(s.get(r.id).phase, "active");
    assert.ok(!fake.files[fake.refs.main]["test/e2e/inbox.spec.ts"]);
    assert.equal(r.milestoneDoneRequested, undefined);

    await game.process("issue_comment", payload(r, "/game done"));
    assert.equal(s.get(r.id).phase, "active");
    assert.equal(s.get(r.id).milestoneDoneRequested, true);
    const gradingHead = fake.refs.main;
    assert.ok(fake.files[gradingHead][".github/workflows/inbox-e2e.yml"]);
    assert.ok(fake.files[gradingHead]["test/e2e/inbox.spec.ts"]);
    assert.ok(
      fake.comments.some((comment) =>
        comment.body.includes("started GitHub Actions"),
      ),
    );

    fake.checkRunItems = [
      {
        name: "browser",
        head_sha: gradingHead,
        status: "completed",
        conclusion: "failure",
        app: { slug: "github-actions" },
        check_suite: { id: 77 },
      },
    ];
    fake.workflowRunItems = [
      {
        name: "Inbox E2E",
        path: ".github/workflows/inbox-e2e.yml",
        head_sha: gradingHead,
        status: "completed",
        conclusion: "failure",
        check_suite_id: 77,
      },
    ];
    await game.process("check_run", payload(r));
    assert.equal(s.get(r.id).phase, "active");
    assert.ok(
      fake.comments.some((comment) => comment.body.includes("checks failed")),
    );

    const repair = await fake.commit(
      "/repos/owner/game",
      gradingHead,
      { "src/fix.ts": "export const fix = true;" },
      "Fix inbox behavior",
    );
    fake.refs.main = repair.sha;
    await game.process("push", payload(r));
    fake.checkRunItems = [
      {
        name: "browser",
        head_sha: repair.sha,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
        check_suite: { id: 78 },
      },
    ];
    fake.workflowRunItems = [
      {
        name: "Inbox E2E",
        path: ".github/workflows/inbox-e2e.yml",
        head_sha: repair.sha,
        status: "completed",
        conclusion: "success",
        check_suite_id: 78,
      },
    ];
    await game.process("check_run", payload(r));
    const result = s.get(r.id).result!;
    assert.equal(s.get(r.id).phase, "finished");
    assert.equal(result.success, true);
    assert.deepEqual(result.complete, ["milestone"]);
    assert.equal(result.scorecard?.milestone, 100);
    assert.equal(result.scorecard?.issueBreakdown, 0);
    assert.equal(result.scorecard?.clarificationRounds, 1);
    assert.equal(result.scorecard?.issueClarity, 65);
    assert.equal(result.points, 68);
  } finally {
    s.close();
  }
});
test("milestone reroll changes the card only before planning begins", async () => {
  const { s, fake, game, r } = await setup(selectScenario(inboxPack));
  try {
    assert.equal(r.rerollsRemaining, 2);
    await game.process("issue_comment", payload(r, "/game reroll", 3, 123));
    await game.process("issue_comment", payload(r, "/game reroll", 3, 123));
    assert.equal(s.get(r.id).scenario.stage, "mentions");
    assert.equal(s.get(r.id).rerollsRemaining, 1);
    assert.match(fake.issues[0].body, /Mention a teammate/);
    assert.match(fake.milestones[0].title, /\[card:mentions\]/);
    fake.issues.push({
      number: 2,
      parent_number: r.master,
      title: "Notification requirements",
      body: "Create recipient specific notifications.",
      user: { id: r.player, type: "User" },
    });
    await game.process("issue_comment", payload(r, "/game reroll"));
    assert.equal(s.get(r.id).scenario.stage, "mentions");
    assert.equal(s.get(r.id).rerollsRemaining, 1);
    assert.match(
      fake.comments.at(-1).body,
      /only change before you create sub-issues/,
    );
  } finally {
    s.close();
  }
});
test("next milestone card starts from the evolved default branch and keeps prior checks", async () => {
  const { s, fake, game, r } = await setup(selectScenario(inboxPack));
  try {
    fake.files["merged-after-inbox"] = {
      ...fake.files.baseline,
      "web/app.ts": "accepted implementation stays in place\n",
    };
    fake.refs.main = "merged-after-inbox";
    await game.process("issue_comment", payload(r, "/game finish"));
    await game.process("issue_comment", payload(r, "/game next"));
    const next = s.all().find((run) => run.previousRun === r.id)!;
    assert.equal(next.scenario.stage, "mentions");
    assert.equal(next.base, "main");
    assert.equal(next.baseline, "merged-after-inbox");
    assert.equal(
      next.baselineFiles?.["web/app.ts"],
      "accepted implementation stays in place\n",
    );
    assert.deepEqual(
      next.milestoneChecks?.map((check) => check.stage),
      ["private-inbox", "mentions"],
    );
    assert.deepEqual(next.offeredCards, ["private-inbox", "mentions"]);
  } finally {
    s.close();
  }
});
test("changing a protected E2E file keeps a passing Actions check from completing the milestone", async () => {
  const { s, fake, game, r } = await setup(selectScenario(inboxPack));
  try {
    fake.files.baseline["test/e2e/inbox.spec.ts"] = "test.skip('bypass');";
    fake.checkRunItems = [
      {
        name: "browser",
        head_sha: "baseline",
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
        check_suite: { id: 77 },
      },
    ];
    fake.workflowRunItems = [
      {
        name: "Inbox E2E",
        path: ".github/workflows/inbox-e2e.yml",
        head_sha: "baseline",
        status: "completed",
        conclusion: "success",
        check_suite_id: 77,
      },
    ];
    await game.process("check_run", payload(r));
    assert.equal(s.get(r.id).phase, "active");
  } finally {
    s.close();
  }
});
test("a same-named check from a different workflow cannot complete the milestone", async () => {
  const { s, fake, game, r } = await setup(selectScenario(inboxPack));
  try {
    fake.checkRunItems = [
      {
        name: "browser",
        head_sha: "baseline",
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
        check_suite: { id: 77 },
      },
    ];
    fake.workflowRunItems = [
      {
        name: "Fake workflow",
        path: ".github/workflows/fake.yml",
        head_sha: "baseline",
        status: "completed",
        conclusion: "success",
        check_suite_id: 77,
      },
    ];
    await game.process("check_run", payload(r));
    assert.equal(s.get(r.id).phase, "active");
  } finally {
    s.close();
  }
});
test("authorized prepared revision updates same PR", async () => {
  const { s, fake, game, r } = await setup();
  try {
    await game.process(
      "issue_comment",
      payload(r, `/game revise ${r.prs["comment-edit"].number}`),
    );
    assert.equal(s.get("run").prs["comment-edit"].revision, 1);
    assert.equal(fake.prs.length, 10);
    await game.process(
      "issue_comment",
      payload(r, `/game revise ${r.prs["comment-edit"].number}`),
    );
    assert.equal(s.get("run").prs["comment-edit"].revision, 1);
  } finally {
    s.close();
  }
});
test("unauthorized finish ignored", async () => {
  const { s, game, r } = await setup();
  try {
    await game.process("issue_comment", payload(r, "/game finish", 9));
    assert.equal(s.get("run").phase, "active");
  } finally {
    s.close();
  }
});
test("early finish freezes and publishes once", async () => {
  const { s, fake, game, r } = await setup();
  try {
    await game.process("issue_comment", payload(r, "/game finish"));
    assert.equal(s.get("run").phase, "finished");
    assert.equal(s.get("run").result?.complete.length, 0);
    await game.process("issue_comment", payload(r, "/game finish"));
    assert.equal(
      fake.comments.filter((c) => c.body.includes("Stage debrief")).length,
      1,
    );
  } finally {
    s.close();
  }
});
test("closing every scenario PR finishes automatically", async () => {
  const { s, fake, game, r } = await setup();
  try {
    fake.prs.forEach((p) => (p.state = "closed"));
    await game.process("pull_request", payload(r));
    assert.equal(s.get("run").phase, "finished");
  } finally {
    s.close();
  }
});
test("unexpected source changes still allow finishing with partial assessment", async () => {
  const { s, fake, game, r } = await setup();
  try {
    fake.files.bad = { ...baseline, "evil.ts": "unexpected" };
    fake.refs.main = "bad";
    await game.process("push", payload(r));
    assert.equal(s.get("run").phase, "active");
    await game.process("issue_comment", payload(r, "/game finish"));
    assert.equal(s.get("run").phase, "finished");
    assert.equal(s.get("run").result?.success, null);
    assert.deepEqual(s.get("run").result?.unverified, [
      ...pack.stages[0].issues.map((i) => i.id),
    ]);
    assert.ok(fake.comments.some((c) => c.body.includes("partially assessed")));
  } finally {
    s.close();
  }
});
test("known authored merged content works regardless of commit identity", async () => {
  const { s, fake, game, r } = await setup();
  try {
    fake.merge("voting-simple", r);
    await game.process("pull_request", payload(r));
    assert.equal(s.get("run").phase, "active");
    assert.equal(s.get("run").prs["voting-simple"].outcome, "merged");
  } finally {
    s.close();
  }
});
test("revision response loss recovers persisted intent", async () => {
  const { s, fake, game, r } = await setup();
  try {
    fake.failRevision = true;
    await assert.rejects(() =>
      game.process(
        "issue_comment",
        payload(r, `/game revise ${r.prs["comment-edit"].number}`),
      ),
    );
    assert.equal(s.get("run").prs["comment-edit"].revision, 0);
    await game.process(
      "issue_comment",
      payload(r, `/game revise ${r.prs["comment-edit"].number}`),
    );
    assert.equal(s.get("run").prs["comment-edit"].revision, 1);
    assert.equal(s.get("run").phase, "active");
  } finally {
    s.close();
  }
});
test("installation removal disables run", async () => {
  const { s, game } = await setup();
  try {
    await game.process("installation", {
      installation: { id: 1 },
      action: "deleted",
    });
    assert.equal(s.get("run").phase, "inaccessible");
  } finally {
    s.close();
  }
});

test("complete winning session revises, merges, closes and debriefs automatically", async () => {
  const { s, fake, game, r } = await setup();
  try {
    await game.process(
      "issue_comment",
      payload(r, `/game revise ${r.prs["comment-edit"].number}`),
    );
    await game.process(
      "issue_comment",
      payload(r, `/game revise ${r.prs["pagination"].number}`),
    );
    await game.process(
      "issue_comment",
      payload(r, `/game revise ${r.prs.bookmarks.number}`),
    );
    const current = s.get("run");
    for (const id of [
      "voting-simple",
      "comment-edit",
      "pagination",
      "bookmarks",
      "search-simple",
      "empty-state",
    ]) {
      fake.merge(id, current);
      await game.process("pull_request", payload(r));
    }
    for (const pr of fake.prs) if (!pr.merged) pr.state = "closed";
    await game.process("pull_request", payload(r));
    const finished = s.get("run");
    assert.equal(finished.phase, "finished");
    assert.equal(finished.result?.success, true);
    assert.equal(finished.result?.points, 20);
    assert.equal(
      fake.comments.filter((c) => c.body.includes("Stage debrief")).length,
      1,
    );
  } finally {
    s.close();
  }
});

test("missing webhook can be recovered through authoritative reconciliation", async () => {
  const { s, fake, game, r } = await setup();
  try {
    fake.prs.forEach((p) => (p.state = "closed"));
    await game.process("push", payload(r));
    assert.equal(s.get("run").phase, "finished");
  } finally {
    s.close();
  }
});

test("identified native request-changes review triggers revision and preserves finding", async () => {
  const { s, fake, r } = await setup();
  const game = new Game(
    s,
    async () => fake as unknown as GitHub,
    { evaluate: async () => "consequence" },
    true,
  );
  try {
    fake.reviews = [
      {
        id: 50,
        user: { id: r.player },
        body: "The route trusts client authorId instead of stored comment.authorId, so another member can edit someone else’s comment.",
        state: "CHANGES_REQUESTED",
        commit_id: r.prs["comment-edit"].head,
        submitted_at: "2026-10-15T00:00:00Z",
      },
    ];
    await game.process("pull_request_review", payload(r));
    assert.equal(s.get("run").prs["comment-edit"].revision, 1);
    assert.equal(s.get("run").findings["comment-edit"][0].revision, 0);
    await game.process("issue_comment", payload(r, "/game finish"));
    assert.match(
      fake.comments.find(
        (c) =>
          c.body.includes("PR debrief") &&
          c.path.includes("/" + r.prs["comment-edit"].number + "/"),
      ).body,
      /review 50, revision 0: consequence/,
    );
  } finally {
    s.close();
  }
});

test("unavailable judge leaves revision command available without concern credit", async () => {
  const { s, fake, r } = await setup();
  const game = new Game(
    s,
    async () => fake as unknown as GitHub,
    { evaluate: async () => undefined },
    true,
  );
  try {
    fake.reviews = [
      {
        id: 50,
        user: { id: r.player },
        body: "Please check ownership",
        state: "CHANGES_REQUESTED",
        commit_id: r.prs["comment-edit"].head,
        submitted_at: "2026-10-15T00:00:00Z",
      },
    ];
    await game.process("pull_request_review", payload(r));
    assert.equal(s.get("run").prs["comment-edit"].revision, 0);
    await game.process(
      "issue_comment",
      payload(r, `/game revise ${r.prs["comment-edit"].number}`),
    );
    assert.equal(s.get("run").prs["comment-edit"].revision, 1);
    assert.deepEqual(s.get("run").findings, {});
  } finally {
    s.close();
  }
});

test("authored contributor exchanges are replay-safe without implying concern credit", async () => {
  const { s, fake, game, r } = await setup();
  try {
    const proposal = proposals.find((p) => p.id === "pagination")!;
    await game.process(
      "issue_comment",
      payload(r, `/game revise ${r.prs.pagination.number}`),
    );
    await game.process("push", payload(r));
    assert.equal(
      fake.comments.filter((c) => c.body.includes(proposal.variants[1].reply!))
        .length,
      1,
    );
    assert.deepEqual(s.get(r.id).findings, {});
    await game.process("issue_comment", payload(r, "/game finish"));
    assert.match(fake.comments.at(-1).body, /Stage debrief/);
  } finally {
    s.close();
  }
});
test("a merge during reconciliation retries instead of pausing the run", async () => {
  const { s, fake, game, r } = await setup();
  try {
    const get = fake.get.bind(fake);
    let merged = false;
    fake.get = async (path: string) => {
      if (!merged && path.endsWith("/pulls/" + r.prs["voting-simple"].number)) {
        merged = true;
        fake.merge("voting-simple", r);
      }
      return get(path);
    };
    await assert.rejects(
      game.process("push", payload(r)),
      /Repository changed during assessment/,
    );
    assert.equal(s.get(r.id).phase, "active");
    await game.process("push", payload(r));
    assert.equal(s.get(r.id).phase, "active");
    assert.equal(s.get(r.id).prs["voting-simple"].outcome, "merged");
  } finally {
    s.close();
  }
});

test("edited PR is unscored, not judged or overwritten, and stage finishes once", async () => {
  const { s, fake, game, r } = await setup();
  try {
    let judgeCalls = 0;
    game.judgeEnabled = true;
    game.reviewer = {
      evaluate: async () => {
        judgeCalls++;
        return "identified";
      },
    };
    const pr = fake.prs.find((p) => p.number === r.prs["comment-edit"].number);
    pr.head.sha = "external-edit";
    fake.files[pr.head.sha] = {
      ...baseline,
      "features/comment-edit.ts": "custom implementation",
    };
    fake.reviews = [
      {
        user: { id: r.player },
        id: 99,
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-10-15",
        commit_id: pr.head.sha,
        body: "Check ownership",
      },
    ];
    await game.process(
      "issue_comment",
      payload(r, `/game revise ${pr.number}`),
    );
    assert.equal(s.get(r.id).phase, "active");
    assert.ok(s.get(r.id).prs["comment-edit"].unscored);
    assert.equal(
      fake.refs[`game/${r.id}/comment-edit`],
      r.prs["comment-edit"].head,
    );
    assert.equal(s.get(r.id).prs["comment-edit"].revision, 0);
    assert.equal(judgeCalls, 0);
    pr.merged = true;
    pr.state = "closed";
    fake.refs.main = pr.head.sha;
    for (const other of fake.prs) other.state = "closed";
    await game.process("pull_request", payload(r));
    await game.process("pull_request", payload(r));
    const result = s.get(r.id).result!;
    assert.equal(s.get(r.id).phase, "finished");
    assert.equal(
      result.decisions.find((d) => d.id === "comment-edit")?.points,
      null,
    );
    assert.equal(result.maximum, 18);
    assert.equal(result.success, null);
    assert.ok(result.unverified?.includes("edit-comments"));
    assert.equal(
      fake.comments.filter((c) => c.body.includes("Stage debrief")).length,
      1,
    );
  } finally {
    s.close();
  }
});
test("both competing merges finish with unscored alternatives, not a pause", async () => {
  const { s, fake, game, r } = await setup();
  try {
    fake.merge("voting-simple", r);
    fake.merge("voting-framework", r);
    for (const pr of fake.prs) pr.state = "closed";
    await game.process("pull_request", payload(r));
    const result = s.get(r.id).result!;
    assert.equal(s.get(r.id).phase, "finished");
    assert.equal(result.success, null);
    assert.ok(result.unverified?.includes("voting"));
    assert.equal(
      result.decisions.find((d) => d.id === "voting-simple")?.points,
      null,
    );
    assert.equal(
      result.decisions.find((d) => d.id === "voting-framework")?.points,
      null,
    );
    assert.equal(result.maximum, 16);
  } finally {
    s.close();
  }
});
test("documentation changes do not invalidate known milestone contributions", async () => {
  const { s, fake, game, r } = await setup();
  try {
    fake.merge("voting-simple", r);
    fake.files.final["README.md"] = "Player notes";
    await game.process("push", payload(r));
    const current = s.get(r.id);
    assert.equal(current.phase, "active");
    assert.equal(current.prs["voting-simple"].unscored, undefined);
    assert.deepEqual(current.unverifiedIssues, []);
    assert.ok(current.warnings?.length);
  } finally {
    s.close();
  }
});
test("API failures retry without changing the game phase", async () => {
  const { s, fake, game, r } = await setup();
  try {
    const get = fake.get.bind(fake);
    fake.get = async () => {
      throw Object.assign(new Error("unavailable"), { status: 503 });
    };
    await assert.rejects(game.process("push", payload(r)), /unavailable/);
    assert.equal(s.get(r.id).phase, "active");
    fake.get = get;
    await game.process("push", payload(r));
    assert.equal(s.get(r.id).phase, "active");
  } finally {
    s.close();
  }
});
test("repository access restoration resumes processing and preserves finished results", async () => {
  const { s, fake, game, r } = await setup();
  try {
    await game.process("installation_repositories", {
      installation: { id: 1 },
      action: "removed",
      repositories_removed: [{ id: 2 }],
    });
    assert.equal(s.get(r.id).phase, "inaccessible");
    await game.process("installation_repositories", {
      installation: { id: 1 },
      action: "added",
      repositories_added: [{ id: 2 }],
    });
    assert.equal(s.get(r.id).phase, "active");
    await game.process("issue_comment", payload(r, "/game finish"));
    const result = s.get(r.id).result;
    await game.process("installation", {
      installation: { id: 1 },
      action: "deleted",
    });
    assert.equal(s.get(r.id).phase, "finished");
    assert.deepEqual(s.get(r.id).result, result);
  } finally {
    s.close();
  }
});
test("repository comparison limits produce a partial debrief without blocking finish", async () => {
  const { s, fake, game, r } = await setup();
  try {
    fake.merge("voting-simple", r);
    fake.tree = async () => {
      throw new Error("Unsupported file type");
    };
    for (const pr of fake.prs) pr.state = "closed";
    await game.process("push", payload(r));
    const finished = s.get(r.id);
    assert.equal(finished.phase, "finished");
    assert.equal(finished.result?.success, null);
    assert.equal(
      finished.result?.decisions.find((d) => d.id === "voting-simple")?.points,
      null,
    );
    assert.ok(
      finished.result?.warnings?.some((w) => w.includes("exercise limits")),
    );
  } finally {
    s.close();
  }
});

test("published forum runs resolve their own content and advance idempotently", async () => {
  const pack = findPackage("forum", "0.1.0"),
    { s, fake, game, r } = await setup(selectScenario(pack));
  try {
    assert.equal(Object.keys(r.prs).length, 10);
    assert.ok(fake.issues[0].body.includes("Synthetic scenario fixture"));
    assert.ok(fake.prs.some((p) => p.body.includes("/portraits/")));
    await game.process("issue_comment", payload(r, "/game finish"));
    assert.equal(s.get(r.id).result?.maximum, 20);
    await game.process("issue_comment", payload(r, "/game next"));
    const child = s.all().find((x) => x.previousRun === r.id)!;
    assert.equal(child.scenario?.stage, "growing");
    assert.equal(child.phase, "active");
    assert.equal(child.master, 1);
    assert.equal(s.get(r.id).phase, "finished");
    assert.equal(fake.refs.main, "baseline");
    assert.ok(child.base?.startsWith("play/"));
    assert.equal(Object.keys(child.prs).length, 1);
    await game.process("issue_comment", payload(r, "/game next"));
    assert.equal(s.all().length, 2);
  } finally {
    s.close();
  }
});

test("interrupted next-stage seeding resumes on repeated next command", async () => {
  const { s, fake, game, r } = await setup(
    selectScenario(findPackage("forum", "0.1.0")),
  );
  try {
    await game.process("issue_comment", payload(r, "/game finish"));
    const post = fake.post.bind(fake);
    let fail = true;
    fake.post = async (path: string, body: any) => {
      if (fail && path.endsWith("/pulls")) {
        fail = false;
        throw Object.assign(Error("Temporary GitHub failure"), { status: 503 });
      }
      return post(path, body);
    };
    await assert.rejects(
      game.process("issue_comment", payload(r, "/game next")),
      /Temporary/,
    );
    assert.equal(s.all().find((x) => x.previousRun === r.id)?.phase, "seeding");
    await game.process("issue_comment", payload(r, "/game next"));
    const child = s.all().find((x) => x.previousRun === r.id)!;
    assert.equal(child.phase, "active");
    assert.equal(s.all().length, 2);
  } finally {
    s.close();
  }
});

test("advisory coaching covers sound PRs, is replay safe and cannot trigger revisions", async () => {
  const { s, fake, r } = await setup();
  let calls = 0;
  const game = new Game(
    s,
    async () => fake as unknown as GitHub,
    {
      evaluate: async () => undefined,
      coach: async () => {
        calls++;
        return { constructiveness: "actionable", focus: "automation" };
      },
    },
    true,
  );
  try {
    const id = "empty-state";
    fake.reviews = [
      {
        id: 90,
        user: { id: r.player },
        body: "Please remove trailing whitespace.",
        state: "CHANGES_REQUESTED",
        commit_id: r.prs[id].head,
        submitted_at: "2026-10-15T00:00:00Z",
      },
    ];
    await game.process("pull_request_review", payload(r));
    await game.process("pull_request_review", payload(r));
    assert.equal(calls, 1);
    assert.equal(s.get(r.id).prs[id].revision, 0);
    assert.deepEqual(s.get(r.id).findings, {});
    assert.equal(s.get(r.id).coaching?.[id][0].feedback?.focus, "automation");
    for (let n = 91; n <= 95; n++) {
      fake.reviews[0].id = n;
      await game.process("pull_request_review", payload(r));
    }
    assert.equal(calls, 4);
    assert.equal(s.get(r.id).coaching?.[id].length, 4);
    await game.process("issue_comment", payload(r, "/game finish"));
    assert.match(
      fake.comments.find(
        (c) =>
          c.body.includes("PR debrief") &&
          c.path.includes("/" + r.prs[id].number + "/"),
      ).body,
      /Review coaching \(no score impact\)/,
    );
  } finally {
    s.close();
  }
});
test("coaching failure cannot prevent finishing a stage", async () => {
  const { s, fake, r } = await setup();
  const game = new Game(
    s,
    async () => fake as unknown as GitHub,
    {
      evaluate: async () => undefined,
      coach: async () => {
        throw new Error("Unavailable");
      },
    },
    true,
  );
  try {
    fake.reviews = [
      {
        id: 99,
        user: { id: r.player },
        body: "Looks good",
        state: "APPROVED",
        commit_id: r.prs["empty-state"].head,
        submitted_at: "2026-10-15T00:00:00Z",
      },
    ];
    await game.process("issue_comment", payload(r, "/game finish"));
    assert.equal(s.get(r.id).phase, "finished");
    assert.ok(
      !fake.comments.some((c) =>
        c.body.includes("Review coaching (no score impact)"),
      ),
    );
  } finally {
    s.close();
  }
});

test("feedback stays hidden during play and publishing resumes after a lost PR-comment response", async () => {
  const { s, fake, game, r } = await setup();
  try {
    assert.ok(!fake.comments.some((c) => c.body.includes("PR debrief")));
    const post = fake.post.bind(fake);
    let loseResponse = true;
    fake.post = async (path, body) => {
      const comment = await post(path, body);
      if (loseResponse && body.body?.includes("PR debrief")) {
        loseResponse = false;
        throw new Error("Response lost after GitHub saved the comment");
      }
      return comment;
    };
    await assert.rejects(
      game.process("issue_comment", payload(r, "/game finish")),
      /Response lost/,
    );
    assert.equal(s.get(r.id).phase, "finishing");
    assert.ok(!fake.comments.some((c) => c.body.includes("Stage debrief")));
    const frozen = s.get(r.id).result;
    await game.publish(s.get(r.id), fake as unknown as GitHub);
    await game.publish(s.get(r.id), fake as unknown as GitHub);
    assert.deepEqual(s.get(r.id).result, frozen);
    const details = fake.comments.filter(
      (c) => c.body.includes("PR debrief") && !c.body.includes("Stage debrief"),
    );
    assert.equal(details.length, proposals.length);
    const overview = fake.comments.find((c) =>
      c.body.includes("Stage debrief"),
    );
    assert.equal(
      fake.comments.filter((c) => c.body.includes("Stage debrief")).length,
      1,
    );
    assert.ok(!overview.body.includes("Expected concern:"));
    assert.ok(!overview.body.includes("Files in the authored change"));
    for (const detail of details) {
      const number = detail.path.split("/").at(-2);
      assert.ok(
        overview.body.includes(`/pull/${number}#issuecomment-${detail.id}`),
      );
    }
  } finally {
    s.close();
  }
});

test("review events refresh only the target review list and retain other evidence", async () => {
  const { s, fake, game, r } = await setup();
  try {
    const reviewPaths: string[] = [];
    const list = fake.list.bind(fake);
    fake.list = async (path) => {
      if (path.endsWith("/reviews")) reviewPaths.push(path);
      return list(path);
    };
    r.prs["voting-simple"].reviews = [
      {
        id: 99,
        body: "Previous evidence",
        state: "COMMENTED",
        commit: r.prs["voting-simple"].head,
        submitted: "2026-10-15T00:00:00Z",
      },
    ];
    s.save(r);
    await game.process("pull_request_review", {
      ...payload(r),
      pull_request: { number: r.prs["comment-edit"].number },
    });
    assert.deepEqual(reviewPaths, [
      `/repos/owner/game/pulls/${r.prs["comment-edit"].number}/reviews`,
    ]);
    assert.equal(
      s.get(r.id).prs["voting-simple"].reviews[0].body,
      "Previous evidence",
    );
  } finally {
    s.close();
  }
});

test("bot and unrelated issue comments do not trigger GitHub reconciliation", async () => {
  const { s, game, r } = await setup();
  try {
    game.connect = async () => {
      throw Error("Should not contact GitHub for unrelated comments");
    };
    await game.process(
      "issue_comment",
      payload(r, "Automated contributor update", 99),
    );
    await game.process("issue_comment", {
      ...payload(r, "/game finish"),
      issue: { number: r.prs["comment-edit"].number },
    });
    assert.equal(s.get(r.id).phase, "active");
  } finally {
    s.close();
  }
});
