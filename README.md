# PR Flood

Practice maintaining a real open-source project through GitHub. Review-game stages provide competing contributions to triage; milestone-driven stages ask you to plan issues, run Louibot locally, and deliver a tested milestone. Both modes end with a scorecard and debrief.

[Play](https://pr-flood.lol/) · [GitHub App](https://github.com/apps/pr-flood) · [App settings](https://github.com/settings/apps/pr-flood) · [Install App](https://github.com/apps/pr-flood/installations/new)

The launch page offers **Forum** and **Group Chat**. Forum is a runnable Express, React, and SQLite application with review-based gameplay. Group Chat is a familiar, local-first messaging app with four alternative milestone cards: threads, @mentions, search, and channel muting. Its [public template repository](https://github.com/rkkautsar/group-chat-scenario) includes protected browser tests that rerun cumulatively as cards are completed. In milestone gameplay, players plan as direct sub-issues under Game Master #1 and work them with Louibot locally.

## Play

1. Open the launcher and sign in with GitHub.
2. Choose a scenario and a new repository name. Repositories are private by default; public is an option.
3. Install the App or approve repository access when prompted, then retry setup.
4. Follow Game Master issue #1 in the created repository. Clone the repository and run its app to investigate behavior while reviewing.

Review-game stages end when all their PRs are merged or closed. In milestone-driven stages, the trusted E2E suite is withheld while the player plans and implements issues. Comment `/game done` on Game Master issue #1 when the milestone is ready: PR Flood installs the protected suite, GitHub Actions runs it, and the scorecard and debrief are published after it passes. A failure leaves the stage active while the player fixes the milestone. Comment `/game finish` to end early with a partial result, or `/game next` after a stage finishes to advance.

Direct code edits remain possible on GitHub. Unsupported changes mark affected assessments unscored; they do not pause the game. Contributor portraits identify fictional characters. GitHub shows the App as the actual author.

## Run and verify

Requires Node.js 24 or newer.

```bash
npm install
npm run format:check
npm run check
npm test
npm run test:cf
npm run demo
```

`npm run format` formats the repository. The launcher is plain HTML, JavaScript, and CSS in `public/`.

`demo` reads the latest public scenario release and prints a deterministic debrief without calling an AI service. Private scenario sources require local App credentials. Tests use compact synthetic scenarios and mocked GitHub calls; `test:cf` builds and exercises the actual Cloudflare runtime. Runnable application and defect evidence tests belong to the scenario repository.

Copy `.env.example` to ignored `.env` for local configuration. Never commit credentials. For local Worker development:

```bash
npm run cf:dev
```

The Node webhook service is also available with `npm start`; it processes outcomes deterministically and leaves review text unassessed. Use `npm run cf:dev` for local development on the same Cloudflare AI path used in production. The Worker serves the launcher, OAuth callbacks, public catalog, contributor portraits, signed webhooks, and protected operator endpoints. Durable Objects persist sessions, launch jobs, game state, webhook retries, and the shared AI budget. Completed delivery deduplication records and AI cache/billing rows are retained for 30 days; pending and failed deliveries and revision intents are preserved, and historical runs remain available for stage history and `/game next`.

## GitHub App and deployment

See [launch configuration](docs/LAUNCH.md) for the App callback, setup URL, permissions, and secrets. Sign-in stays unavailable until the App client secret is configured. Existing installations must approve permission changes before repository creation works.

```bash
npm run cf:deploy
```

GitHub Actions runs formatting, ESLint, TypeScript, service/scenario tests, and Cloudflare runtime tests on pull requests and pushes to `main`. ESLint rejects explicit `any` and unused declarations in source files. After those checks pass, pushes to `main` deploy the Worker and static assets, then probe the public health and asset URLs. Manual runs are available through Actions. Configure repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` first; the token should use the Edit Cloudflare Workers template scoped to your deployment account. Existing Worker secrets stay in Cloudflare. See [launch and deployment configuration](docs/LAUNCH.md).

The [code quality review](docs/CODE_REVIEW.md) describes the integrated module boundaries, typed data validation, storage policy, and deliberate tradeoffs.

The App needs Contents, Issues, and Pull requests write access and Metadata read access. Grant Workflows write access when a scenario seeds files under `.github/workflows`; GitHub requires this separately from Actions access. Milestone stages also need Checks and Actions read access and the `check_run` webhook event. The launcher also needs repository-creation permission through user authorization. Installation and repository-access events handle access changes; installing the App alone does not create a game.

Webhook payloads require a valid signature. Commands and review credit are restricted to the designated player. Tokens stay on the server, and player repository code is never executed in the game service. GitHub, webhook, AI, and persisted-run data are parsed through Zod boundaries before use. Run records use a `schemaVersion: 1` envelope; existing bare run records are migrated on read. OAuth uses expiring one-use state, PKCE, a secure session cookie, and CSRF protection. New games are limited to five per authenticated account per UTC day. Repository creation and seeding are durable and retryable.

## Author scenarios

See [the authoring guide](docs/AUTHORING.md). A scenario is a real Git repository with `__scenario__` annotations, contributor portraits, stage baseline branches, initial PR branches, and revision branches. For example:

```text
stage/launch/base
stage/launch/comment-edit/initial
stage/launch/comment-edit/rev-1
```

The authoring CLI validates branch diffs and annotations, previews content, and exports clean application code. A pinned Git tag publishes the validated package as a GitHub Release asset in the scenario repository. The Worker reads public releases anonymously and private releases using its GitHub App installation access, caches packages by digest, and resolves each run by scenario ID, version, stage, and digest. Keep prior releases available while their playthroughs exist. See [the authoring guide](docs/AUTHORING.md) and [release registry setup](docs/LAUNCH.md).

```bash
npm run scenario -- validate /path/to/scenario
npm run scenario -- preview /path/to/scenario
npm run scenario -- export /path/to/scenario /tmp/playthrough
```

Run `npm run scenario` for all local authoring commands and arguments. The Worker discovers package assets from GitHub Releases at runtime.

## Scoring and AI

Roadmap progress and merge/close outcomes use the authored rubric. The debrief explains accepted defects, maintenance debt, and missed requirements. Review effort is informational. Without a calibrated judge, review wording is explicitly unassessed; requesting a revision alone does not earn concern-identification credit.

The Cloudflare Worker can use **Cloudflare Clef-flash** to match review text to curated concerns. The Node webhook mode stays deterministic; use `npm run cf:dev` to try the production AI integration locally. Read [judge configuration and calibration](docs/JUDGE.md) for the measured results and limitations. A matching request-changes review can trigger its prepared revision; `/game revise <PR-number>` remains available when matching abstains.

The game-master issue ends with a short score overview, up to three takeaways, and a linked decision table. Each PR receives its own debrief after the stage ends: the outcome, explanation, teaching takeaway, and any review coaching. Publishing retries reuse comments, so interrupted delivery does not duplicate feedback.

Optional review coaching appears in the PR debrief: clarity and constructiveness, substantive concerns, subjective nits, and possible formatter/lint candidates. It is advisory and has no effect on points, concern credit, prepared revisions or release success. It covers submitted GitHub reviews and their attached inline comments, with at most four coaching attempts per PR. Uncertain dimensions are omitted.

All judge and coaching calls use bounded context, cached results and atomic reservations against the shared **$1 per UTC day** inference cap. At the cap or on model failure, deterministic outcomes and debriefs continue. Clef-flash uses the existing Workers AI binding and standard billing, eligible for the shared daily Neuron allowance. The cap conservatively counts list-price usage before that free allowance. There is no live AI code generation in this version.

## Operator commands

Set `WORKER_URL` and `ADMIN_TOKEN` in ignored `.env`:

```bash
npm run cf:cli -- status INSTALLATION_ID
npm run cf:cli -- retry INSTALLATION_ID
```

The authenticated `GET /admin/diagnostics?installation=...` endpoint reports safe failure categories for an installation. Structured logs include GitHub request counts without raw webhook bodies or credentials.

For manual troubleshooting, export the selected stage into a fresh disposable repository first, then seed with an explicit package:

```bash
DISPOSABLE_REPO_CONFIRMED=true npm run cf:cli -- seed INSTALLATION_ID REPOSITORY_ID OWNER REPO PLAYER_ID forum 0.1.1 launch
```

The local CLI provides equivalent `seed`, `status`, and `retry-deliveries` commands. `resume RUN_ID` retries interrupted local seeding or result publication. Authored game work is split across `src/game/` modules for reconciliation, reviews, revisions, progression, provisioning, messages, and publishing; launch routes, authentication, security, presentation, and provisioning live under `src/launch/`, with orchestration at the entry points.
