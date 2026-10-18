import "./fixtures/packages.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  initialRun,
  assess,
  expectedFiles,
  debrief,
  prDebrief,
} from "../src/engine.ts";
import { findPackage, selectScenario } from "../src/packages.ts";
const pack = findPackage("forum", "0.1.0");
const { baseline, proposals } = pack.stages[0];
import { Store } from "../src/store.ts";
import { validSignature, command } from "../src/security.ts";
export function fixture() {
  const r = initialRun({
    id: "run",
    installation: 1,
    repository: 2,
    owner: "owner",
    repo: "game",
    player: 3,
    scenario: selectScenario(pack),
  });
  r.phase = "active";
  r.master = 99;
  r.base = "main";
  r.baseline = "baseline";
  for (const [i, p] of proposals.entries())
    r.prs[p.id] = {
      number: i + 1,
      revision: 0,
      outcome: "open",
      head: "head-" + p.id,
      reviews: [],
    };
  return r;
}
test("sound implementations and prepared fixes deliver the Forum milestone", () => {
  const r = fixture();
  for (const state of Object.values(r.prs)) state.outcome = "closed";
  for (const id of [
    "voting-simple",
    "search-simple",
    "bookmarks",
    "comment-edit",
    "pagination",
  ])
    r.prs[id].outcome = "merged";
  for (const id of ["bookmarks", "comment-edit", "pagination"])
    r.prs[id].revision = 1;
  const score = assess(r);
  assert.equal(score.success, true);
  assert.equal(score.points, 20);
  assert.equal(score.complete.length, 5);
  assert.match(debrief(r), /Not assessed/);
});
test("rejecting every contribution does not deliver milestone", () => {
  const r = fixture();
  Object.values(r.prs).forEach((x) => (x.outcome = "closed"));
  assert.equal(assess(r).success, false);
  assert.equal(assess(r).complete.length, 0);
});
test("unauthorized comment editing prevents success", () => {
  const r = fixture();
  r.prs["comment-edit"].outcome = "merged";
  assert.deepEqual(assess(r).harmful, ["comment-edit"]);
  assert.equal(
    assess(r).decisions.find((x) => x.id === "comment-edit")?.points,
    -2,
  );
});
test("prepared alternative delivers competing issue without penalizing closure of clean alternative", () => {
  const r = fixture();
  r.prs["voting-framework"].revision = 1;
  r.prs["voting-framework"].outcome = "merged";
  r.prs["voting-simple"].outcome = "closed";
  assert.ok(assess(r).complete.includes("voting"));
  assert.equal(
    assess(r).decisions.find((d) => d.id === "voting-simple")?.points,
    2,
  );
});
test("early finish defers open contributions", () => {
  const score = assess(fixture());
  assert.ok(score.decisions.every((x) => x.outcome === "deferred"));
  assert.equal(score.success, false);
});
test("merged expected tree contains exactly authored effects", () => {
  const r = fixture();
  assert.deepEqual(expectedFiles(r), baseline);
  r.prs["comment-edit"].revision = 1;
  r.prs["comment-edit"].outcome = "merged";
  const proposal = proposals.find((p) => p.id === "comment-edit")!;
  for (const [path, content] of Object.entries(proposal.variants[1].files))
    assert.equal(expectedFiles(r)[path], content);
});
test("authoring annotations and rubric never enter public baseline", () => {
  assert.ok(baseline["src/server.ts"]);
  assert.ok(baseline["web/index.html"]);
  assert.ok(baseline["package.json"]);
  assert.ok(
    Object.keys(baseline).every(
      (p) => !p.includes("__scenario__") && !p.includes("rubric"),
    ),
  );
});
test("invalid revision rejected", () => {
  const r = fixture();
  r.prs["comment-edit"].revision = 99;
  assert.throws(() => assess(r), /Unknown authored/);
});
test("webhook signatures bind raw bytes", () => {
  const raw = Buffer.from('{"a":1}'),
    sig = "sha256=" + createHmac("sha256", "secret").update(raw).digest("hex");
  assert.equal(validSignature(raw, sig, "secret"), true);
  assert.equal(validSignature(Buffer.from('{"a":2}'), sig, "secret"), false);
  for (const bad of [undefined, "bad", "sha256=00"])
    assert.equal(validSignature(raw, bad, "secret"), false);
});
test("commands require exact syntax", () => {
  assert.deepEqual(command("/game finish"), { kind: "finish" });
  assert.deepEqual(command("/game done"), { kind: "done" });
  assert.deepEqual(command("/game revise 12"), { kind: "revise", number: 12 });
  assert.equal(command("hello /game finish"), undefined);
  assert.equal(command("/game revise -1"), undefined);
});
test("SQLite deduplicates delivery IDs and persists runs", () => {
  const s = new Store(":memory:");
  try {
    s.save(fixture());
    assert.equal(s.get("run").repository, 2);
    assert.equal(s.enqueue("delivery", "push", "{}"), true);
    assert.equal(s.enqueue("delivery", "push", "{}"), false);
  } finally {
    s.close();
  }
});
test("overengineered implementation delivers the feature but incurs maintainability penalty", () => {
  const r = fixture();
  r.prs["voting-framework"].outcome = "merged";
  const score = assess(r);
  assert.ok(score.complete.includes("voting"));
  assert.ok(score.debt.includes("Unneeded voting pipeline"));
  assert.equal(score.success, false);
});

test("coaching never changes any assessment field", () => {
  const r = fixture();
  const before = assess(r);
  r.coaching = {
    "comment-edit": [
      {
        reviewId: 7,
        revision: 0,
        fingerprint: "fixture",
        feedback: { constructiveness: "unconstructive", focus: "nitpick" },
      },
    ],
  };
  assert.deepEqual(assess(r), before);
  assert.match(
    prDebrief(r, Object.keys(r.coaching)[0]),
    /Review coaching \(no score impact\)/,
  );
});
