# Author and release a scenario

A scenario is a runnable application in a Git repository, with `__scenario__` on its default branch. Edit source files and Markdown, push the changes, and create a version tag to release. CI checks the annotations and every captured code branch on pull requests, pushes to `main`, and version tags. Publishing is handled by the trusted `maintainer-sim` workflow; the scenario repository does not need source issues or PRs. The publisher creates player content from the annotations and code branches.

```text
__scenario__/
  scenario.yaml
  characters/maya.svg
  stages/launch/
    stage.md
    issues/voting.md
    prs/voting-simple.md
```

Code branches use this convention:

```text
stage/launch/base
stage/launch/voting-simple/initial
stage/launch/voting-framework/initial
stage/launch/voting-framework/rev-1
stage/growing/base
```

Never create a branch named `stage/launch`: Git cannot store that ref alongside its nested names. Keep the base fixed while authoring contributions. Each initial contribution descends from its stage base; each revision descends from the previous captured revision. Normal working branches can have any other names. An agent can implement code on a working branch, commit, then capture the revision with the CLI.

The normal workflow is to edit these files and branches with Git, push them, and tag a release. `init`, `case`, and `capture` are optional scaffolding helpers; they are not required to author a scenario. Local validation and preview are also available from a maintainer-sim checkout:

```sh
npm run scenario -- validate /path/to/scenario
npm run scenario -- preview /path/to/scenario /tmp/forum-preview
```

CI requires a tag named `v<version>` to match `scenario.yaml`. Never move or reuse a published tag. Each GitHub Release retains its package asset, so active runs can continue resolving their pinned version. Set a new `refPrefix`, such as `v0.2.0/`, for changed capture branches instead of moving published refs.

The preview command exports a runnable clean baseline and a Markdown review of initial contributions. Run the exported app using its README. It does not create GitHub objects; the launch page is the end-to-end GitHub preview. Publishing validates content without executing repository scripts. Run trusted authored app tests separately, including defect witnesses and a canonical successful set of contributions.

## One-time CI setup

In the scenario repository, add two small caller workflows. Replace `MAINTAINER_SIM_SHA` below with the full commit SHA of a maintainer-sim commit that contains the reusable workflow, and use that same SHA for `engine_ref`. The reusable workflow checks out the scenario repository with full history and no saved Git credentials, then runs validation from the trusted engine checkout. Validation needs only read access; the tag caller grants write access for publishing the release assets.

`.github/workflows/scenario-check.yml`:

```yaml
name: Scenario validation
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  validate:
    uses: rkkautsar/pr-flood.lol/.github/workflows/scenario-release.yml@MAINTAINER_SIM_SHA
    with:
      engine_ref: MAINTAINER_SIM_SHA
```

`.github/workflows/scenario-publish.yml`:

```yaml
name: Scenario release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  release:
    uses: rkkautsar/pr-flood.lol/.github/workflows/scenario-release.yml@MAINTAINER_SIM_SHA
    with:
      engine_ref: MAINTAINER_SIM_SHA
```

No Cloudflare or publisher secret is needed. The publish job uses the caller's short-lived GitHub Actions token to create a draft release, upload `scenario.json` and `scenario-manifest.json`, compare those assets on retry, and publish the release. The tag and assets are immutable after publication. Pin updates should be reviewed as trusted build-tool changes.

Once configured, the authoring loop is:

```sh
git checkout main
# edit __scenario__/ and code, then capture contribution branches as needed
git add .
git commit -m "Improve the launch scenario"
# Push the annotation commit and every new captured branch before releasing.
git push origin main 'refs/heads/v0.2.0/*:refs/heads/v0.2.0/*'
# scenario.yaml already contains version: 0.2.0; wait for validation to pass.
git tag v0.2.0
git push origin v0.2.0
```

The tag workflow validates the complete repository before publishing. This trusted publishing workflow never executes scenario scripts. The scenario repository should separately run its application tests, build, and defect evidence in a job without release credentials.

`scenario.yaml`:

```yaml
schema: 1
id: forum
version: 0.2.0
refPrefix: v0.2.0/
title: Forum
description: Maintain a growing community forum.
characters:
  maya:
    name: Maya
    role: Regular contributor
stages: [launch, growing]
```

`refPrefix` is optional and scopes the captured Git refs. With the example above, branches use names such as `v0.2.0/stage/launch/base` and `v0.2.0/stage/launch/voting-simple/initial`. Leave it out to use the unprefixed branch names shown earlier. When you choose a prefix, use it consistently for every stage and contribution branch included in that release.

Provide one simple text SVG portrait at `__scenario__/characters/<character-id>.svg`. The publisher rejects scripting, embedded images, links, event handlers, styles, entities and external references. Names/roles are plain display text. The service hosts portraits under an immutable package digest; the player sees them inside App-authored Markdown. No GitHub identity is impersonated.

`stages/launch/stage.md`:

```markdown
---
title: The group chat is moving
endings:
  success: The release is ready for the community.
  incomplete: Some promises or accepted concerns still need attention.
  partial: Some changes need a manual check before release.
---

The community's problem, the release motivation, and the maintainer's brief.
```

`issues/voting.md`:

```markdown
---
id: voting
title: Vote once on useful threads
---

A member can vote once per thread. Repeated clicks must be idempotent.
Describe observable acceptance criteria rather than revealing an implementation.
```

`prs/voting-framework.md`:

```markdown
---
id: voting-framework
title: Add voting with an extensible pipeline
character: maya
issue: voting
group: voting
revisions: 1
assessment:
  initial:
    sound: false
    satisfiesIssue: true
    concern: The pipeline adds indirection without a current extension requirement.
    debt: Unnecessary voting pipeline
    explanation: Voting works, but the abstraction increases maintenance cost.
  rev-1:
    sound: true
    satisfiesIssue: true
    explanation: The revision uses a direct idempotent write.
    reply: I removed the pipeline. Reactions can wait for a concrete request.
---

Write a natural PR description with motivation, implementation scope, tests,
and any uncertainty the contributor would reasonably mention.

<!-- debrief -->

Explain the concrete review takeaway, evidence, and consequences.
```

`issue` and `group` are optional. An unsolicited PR omits `issue`; it still belongs to the stage. A competing implementation uses the same issue/group with a different case ID. There can be 0–3 prepared revisions. Initial assessment facts and each `rev-N` must be explicit; every flawed revision needs a concern, every revision needs an explanation, and fixed revisions need a contributor reply. Optional `followup` adds one initial contributor comment. `{{issue:some-id}}` and `{{pr:some-id}}` render destination numbers after creation; use stable IDs, not assumed GitHub numbers.

The Markdown separator is a publishing boundary, not secrecy. Everything after it and all YAML assessment data stay in the server package until debrief. `__scenario__` is excluded from every exported code tree and player commit. The player repository is created from fresh application commits, never forked from the authoring repository. Keep the authoring repository private if its answers should be hidden.

The v1 publisher supports regular UTF-8 files, at most 120 files / 1MB per snapshot, 250KB per file, a compact package up to 1.8MB, 15 PRs per stage, 12 issues, 8 stages, and three prepared revisions. These limits accommodate dependency lockfiles while keeping packages within Durable Object storage limits. It rejects committed credentials, runtime data, binaries, symlinks and submodules. Deletions are represented explicitly; renames are delete/add. Independent contributions may not edit the same files; declared alternatives may. This gives agents actionable validation failures instead of introducing an arbitrary dependency graph.

A stage's next entry is the next item in `scenario.yaml`. After debrief the player can comment `/game next`. A new branch starts from the next authored snapshot, preserving previous history and frozen results. The same Game Master issue #1 is updated with the next brief. All pending prepared revisions and scoring stay deterministic. Jev remains an optional classifier of review text against the authored concern, with the same global budget.

## Milestone-driven stages

A milestone-driven stage leaves issue planning and implementation to the player. Set `mode: milestone` in `stage.md`; omit the `issues/` and `prs/` folders. Setup creates only the Game Master brief and GitHub milestone. The player creates direct GitHub sub-issues under the Game Master issue, runs Louibot locally, and reviews the resulting PRs. The grader reads those direct children from GitHub's sub-issues API; adding a sub-issue to the milestone is optional.

Alternative milestone cards can share a pool by setting the same `pool` value on two or more milestone stages. Every card in a pool must have the exact same captured baseline. Launch selects one card for the playthrough; the player can request up to two changes with `/game reroll` before creating sub-issues or pushing commits. After finishing a card, `/game next` selects an unplayed card and starts from the current default-branch commit, preserving the app changes. Each chosen card's check is added to the cumulative required suite list.

For a pool, each trusted workflow should select its active test matrix from the repository's current open/completed PR Flood milestones. Include a stable `[card:<stage-id>]` suffix in the milestone title. The game changes the suffix when a player rerolls, so that discarded cards are excluded. This lets one workflow run only the selected card and previously completed cards on each merge, while keeping their test and workflow files protected in the shared baseline.

The trusted E2E workflow and every file it needs must be present in the captured authoring baseline. Configure it to run on pushes to the default branch, not on `pull_request`. Set `workflowPath` to that workflow file and list the workflow and its test dependencies under `protectedFiles`. By default, publishing separates these files into `evaluatorFiles` and removes them from the player baseline and exported template. To expose selected tests and their configuration from the beginning, list their paths in `visibleEvaluatorFiles`; those paths remain in the player baseline while canonical copies are also retained in `evaluatorFiles`. When the player comments `/game done` on the Game Master issue, PR Flood restores the protected files from those canonical copies on the default branch before grading. The game binds the named check to a run of that exact workflow path and current default-branch commit, so another Actions workflow cannot spoof the result. The check name is the workflow name plus job name (for example, `Inbox E2E / browser`). A passing run completes the stage and triggers judging and debrief; a failed run leaves the stage active for fixes and another push. `/game finish` gives an early partial result.

For a campaign with multiple milestone stages, keep each stage's acceptance suite in its captured authoring baseline and configure every suite workflow to run on default-branch pushes. PR Flood carries the trusted check names, workflow paths, and protected-file contents forward with the run. On `/game done`, it installs all accumulated suites together. A later stage passes only when its own suite and every previously completed milestone suite pass against the current code. This makes regressions part of the current delivery problem: players may need to identify and create a refactor issue before the new milestone can pass. Keep each suite's tests focused on observable behavior for its milestone, and make failure output identify which milestone regressed.

The trusted suite should test the public milestone behavior through the app's UI and API, with realistic users and data. Keep the outcomes explicit in the public brief; tests should verify those outcomes and edge cases. If tests are visible from the start, identify their paths and explain the observable contract in the brief, including seeded state, player action, and expected result. Describe user-visible behavior rather than prescribing internal architecture, selectors, or test IDs. Give each milestone suite isolated test data, but run completed suites again against the evolved app so cross-feature regressions are caught. Include the workflow, test files, test configuration, fixtures, and any helper files in `protectedFiles`. Player-authored tests can supplement the suite, but the required check must execute the protected scenario suite directly.

`stage.md` annotations for a milestone-driven stage:

```markdown
---
title: The community wants a private activity inbox
mode: milestone
requiredCheck: Inbox E2E / browser
workflowPath: .github/workflows/inbox-e2e.yml
protectedFiles:
  - .github/workflows/inbox-e2e.yml
  - test/e2e/inbox.spec.ts
  - test/e2e/helpers.ts
  - playwright.config.ts
evaluation:
  issueBreakdown: "Reward independent, reviewable slices that collectively cover replies, votes, read state, privacy, ordering, and navigation. A single broad issue should earn low breakdown credit; issue count itself is not a gate."
  issueClarity: "Reward concrete behavior, scope, and acceptance criteria that let Louibot proceed with few clarifications. Penalize repeated clarification loops when no linked PR is merged."
  pullRequestQuality: "Judge correctness, scope, accessibility, maintainability, and evidence in the submitted implementation against the brief and E2E result. Passing the suite establishes the milestone outcome, not excellent code quality."
  reviewQuality: "Reward reviews that explain real behavior, privacy, or regression risks and give actionable feedback. Give little credit for cosmetic-only nitpicks or generic praise."
endings:
  success: The private inbox is ready for the community.
  incomplete: The required behavior still needs work.
  partial: The milestone could not be fully assessed.
---

Members need one place to catch up on activity on their own threads. Build a private activity inbox for replies and votes on threads the signed-in member created. Exclude activity on other members' threads and activity authored by the signed-in member. Show the newest 20 matching events first, with a useful empty state. Opening an event takes the member to its thread. Unread events are distinguishable; opening one marks it read, and read state is private to that member.
```

There is no minimum issue count and no model-specific score adjustment. Clef scores issue breakdown, clarity, implementation quality, and review quality under the same rubric for every worker model. Passing the protected E2E check earns the full milestone-completion dimension, even when a single broad issue earns low breakdown credit. The clarity penalty applies to signed Louibot clarification comments followed by a player response on an issue with no merged linked PR; Louibot may use the player's GitHub identity.

A useful agent checklist: make the starting app genuinely usable; create changes across the natural UI/API/test boundaries; demonstrate each deliberate defect with an executable witness or reproduction; keep tests plausible rather than revealing the answer; check the canonical sound path; read the rendered story and descriptions; validate and publish. Prefer a few credible characters with specific motivations over a generic greeting on every PR.

## Code readability and released snapshots

Use blank lines between imports and declarations, between functions or object methods, and between logical blocks such as validation, database access, and assertions. Keep shared formatting consistent in the stage baseline and all contribution branches; a PR should show the feature rather than unrelated formatting churn. A formatter preserves existing spacing but does not always add these logical breaks for you.

Release changed snapshots under a new scenario version. The launcher offers the latest release of each scenario, while prior version releases remain available to existing runs. Preserve old branch captures in archive tags when advancing their branches, and never force-push a published capture. Forum 0.1.1 adds logical whitespace; 0.1.0 remains available for existing playthroughs.

Teaching prose after `<!-- debrief -->` is published in that PR’s thread when the stage ends. The game-master overview links to these comments and highlights at most three takeaways, prioritizing weaker decisions. Keep each takeaway specific and short enough to scan.
