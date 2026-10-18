import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishScenario, savePackage } from "../src/authoring.ts";
import { validatePackage } from "../src/package-registry.ts";
import { authoringRepository } from "./helpers/authoring.ts";

test("publisher derives a package from real refs and preserves deletions", () => {
  const { repo, git } = authoringRepository();
  try {
    const fresh = publishScenario(repo);
    assert.deepEqual(
      Object.keys(fresh.stages[0].proposals[0].variants[0]).slice(0, 2),
      ["explanation", "sound"],
    );
    assert.deepEqual(fresh.stages[0].proposals[0].variants[0].deletes, [
      "obsolete.ts",
    ]);
    assert.ok(
      !Object.keys(fresh.stages[0].baseline).some((p) =>
        p.includes("__scenario__"),
      ),
    );
    git(
      "update-ref",
      "-d",
      "refs/remotes/origin/review/stage/launch/example/initial",
    );
    assert.throws(() => publishScenario(repo));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("published package versions are immutable", () => {
  const { repo } = authoringRepository();
  const dest = mkdtempSync(join(tmpdir(), "package-version-"));
  try {
    const fresh = publishScenario(repo);
    savePackage(fresh, dest);
    savePackage(fresh, dest);
    assert.throws(
      () => savePackage({ ...fresh, title: "Mutated" }, dest),
      /immutable/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("publisher accepts a milestone stage with protected E2E files and no prepared work", () => {
  const { repo, git } = authoringRepository();
  try {
    rmSync(join(repo, "__scenario__/stages/launch/issues"), {
      recursive: true,
      force: true,
    });
    rmSync(join(repo, "__scenario__/stages/launch/prs"), {
      recursive: true,
      force: true,
    });
    const stage = [
      "---",
      "title: Private inbox",
      "mode: milestone",
      "requiredCheck: Inbox E2E / browser",
      "workflowPath: .github/workflows/inbox-e2e.yml",
      "protectedFiles:",
      "  - .github/workflows/inbox-e2e.yml",
      "  - test/e2e/inbox.spec.ts",
      "evaluation:",
      '  issueBreakdown: "Reward independently reviewable issues; one broad issue receives low breakdown credit."',
      '  issueClarity: "Reward clear scope and acceptance criteria."',
      '  pullRequestQuality: "Judge correctness and maintainability against the milestone."',
      '  reviewQuality: "Reward substantive feedback and discount cosmetic-only nitpicks."',
      "endings:",
      "  success: Ready",
      "  incomplete: More work",
      "  partial: Needs a check",
      "---",
      "Build the private inbox from the public acceptance criteria.",
    ].join("\n");
    writeFileSync(join(repo, "__scenario__/stages/launch/stage.md"), stage);
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    mkdirSync(join(repo, "test/e2e"), { recursive: true });
    writeFileSync(
      join(repo, ".github/workflows/inbox-e2e.yml"),
      "name: Inbox E2E\n",
    );
    writeFileSync(
      join(repo, "test/e2e/inbox.spec.ts"),
      "test('inbox', () => {});\n",
    );
    git("add", ".");
    git("commit", "-m", "Add milestone E2E workflow");
    const baseSha = git("rev-parse", "HEAD").toString().trim();
    git("update-ref", "refs/remotes/origin/review/stage/launch/base", baseSha);

    const pack = publishScenario(repo);
    assert.equal(pack.stages[0].mode, "milestone");
    assert.equal(pack.stages[0].requiredCheck, "Inbox E2E / browser");
    assert.deepEqual(pack.stages[0].issues, []);
    assert.deepEqual(pack.stages[0].proposals, []);
    assert.deepEqual(pack.stages[0].protectedFiles, [
      ".github/workflows/inbox-e2e.yml",
      "test/e2e/inbox.spec.ts",
    ]);
    assert.deepEqual(pack.stages[0].baseline, {
      "src/value.ts": "export const value=1;",
    });
    assert.deepEqual(pack.stages[0].evaluatorFiles, {
      ".github/workflows/inbox-e2e.yml": "name: Inbox E2E\n",
      "test/e2e/inbox.spec.ts": "test('inbox', () => {});\n",
    });
    assert.equal(validatePackage(pack).stages[0].mode, "milestone");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
