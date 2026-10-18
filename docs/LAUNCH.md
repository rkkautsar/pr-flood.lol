# Configure the GitHub launch page

Cloudflare serves the launcher directly from `public/index.html`, `public/app.js`, and `public/style.css` through Workers Static Assets. Edit those files directly; no frontend framework or compilation step is required. `public/_headers` defines the static response security headers and revalidation policy.

The Worker handles the scenario catalog, portrait assets, GitHub App OAuth, and durable launch jobs. Unknown routes return 404 rather than the launcher HTML. No template repository is required. Player-owned repositories start private by default; the player can select public before creation. Personal accounts are supported first. Each authenticated account can create at most five playthroughs per UTC day.

Scenario packages are read from GitHub Releases in repositories listed by `SCENARIO_REPOSITORIES`, including the public `rkkautsar/forum-scenario` and `rkkautsar/forum-inbox-scenario`. Public releases publish a small `scenario-manifest.json` beside `scenario.json`; the catalog follows GitHub's designated latest stable release and downloads both files from the release CDN without GitHub REST API access or App installation. Catalog results refresh within five minutes. Version-pinned runs use that version's manifest, and older releases without a manifest use the repository-scoped GitHub API fallback. Private sources use a repository-scoped, Contents-read installation token and must be added to the existing GitHub App installation.

The scenario repository publishes version tags through the trusted workflow in [the authoring guide](AUTHORING.md). Keep older releases available. Each run's Durable Object persists its validated package by digest so an in-progress game can continue during a source outage. Source repositories contain answers and evidence; making them public lets players inspect those answers. Player repositories still exclude `__scenario__` and source history.

Set `SCENARIO_REPOSITORIES` in `wrangler.jsonc` to a comma-separated `owner/repository` allowlist. The same variable works for local development; it contains no credential.

Open [PR Flood settings](https://github.com/settings/apps/pr-flood) to configure the existing [GitHub App](https://github.com/apps/pr-flood). Its [installation page](https://github.com/apps/pr-flood/installations/new) grants access to player repositories.

Configure:

- Homepage: `https://pr-flood.lol/`
- Callback URL: `https://pr-flood.lol/auth/callback`
- Setup URL: `https://pr-flood.lol/setup`
- Leave automatic OAuth-during-installation disabled: the launcher initiates its own state/PKCE flow.
- Permit installation on any account if inviting other players.
- Keep Contents, Issues and Pull requests write access and Metadata read. Grant Workflows write access when a scenario seeds files under `.github/workflows` (including Forum Inbox); Actions read access does not grant permission to write workflow files. Milestone-driven stages also need Checks read, Actions read, and the `check_run` webhook subscription.
- Grant the App installation Contents read access to `SCENARIO_REPOSITORIES` so it can discover private scenario releases and download package assets.
- Add **Repository creation: write** if available. GitHub's create-repository API also accepts **Administration: write**, but prefer the narrower creation permission. If GitHub offers only Administration, review that broader permission before changing the registration.
- Existing installations must approve newly requested permissions.

Create an App client secret. Save it locally in ignored `.env` as `GITHUB_CLIENT_SECRET=...`; never paste it into a tracked file, URL, or browser code. Add it to Worker secrets through stdin (`wrangler secret put GITHUB_CLIENT_SECRET`). `GITHUB_CLIENT_ID` is a public Wrangler variable and is distinct from the numeric App ID. The App private key and webhook secret remain existing Worker secrets.

Installation and user authorization are separate. The launcher checks the GitHub user, verifies the personal-account installation, creates a new repository with a per-launch marker, verifies installation-token access to that exact repository, initializes public-only code, and queues game seeding. When installation/access is missing, the page provides a GitHub link and explicit retry. Newly App-created repositories are documented to receive App access automatically, but the implementation verifies this rather than assuming it.

OAuth uses one-use expiring state and PKCE. Access tokens stay in server-side Durable Object storage for at most one hour; refresh tokens are discarded. The opaque session cookie is Secure, HttpOnly and SameSite=Lax. Creation uses POST, an origin check and a CSRF token. Launch intent is persisted before GitHub mutation; uncertain creation responses are recovered using repository owner, random launch marker, and creation time. Existing unrelated names are refused. Setup errors preserve the repository and support retries. The browser receives only public job status, never private assessment state or tokens.

Required live verification after registration changes: sign in, choose a scenario, create a disposable private repository, verify its Game Master issue, milestone and scenario-specific seeded work, inspect the seeded app, retry a reload during preparation, then finish/advance a stage. Runtime tests intercept external GitHub calls and verify the same flow without creating real repositories or paid AI calls. Those tests cannot prove the App registration has the required grants.

References: [repository creation](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user), [App-created repository access](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party), [OAuth and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [setup URL validation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).

Static assets are configured in `wrangler.jsonc`. Run `npm run cf:dev` to test the page and Worker routes locally; this uses the Cloudflare runtime path, including the same Workers AI integration used in production. The Node webhook service is deterministic and does not provide a local substitute for that AI path. `npm run test:cf` exercises the real asset router alongside mocked GitHub calls, including asset content types, security headers, and dynamic route handling.

## Continuous deployment

`.github/workflows/ci.yml` checks pull requests and `main` using Node 24 and `npm ci`. It runs formatting, ESLint, TypeScript, service/scenario tests, and Cloudflare runtime tests. Only `main` can enter the production deployment job; pull requests do not receive deployment credentials. Workflow concurrency serializes main-branch runs.

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the repository’s Actions secrets. Create a dedicated deployment token using Cloudflare’s **Edit Cloudflare Workers** template, scoped to the account that owns this Worker. The workflow uses the pinned Wrangler dependency through `npm run cf:deploy`, uploading Worker code and `public/` assets together. GitHub App credentials and other runtime secrets stay configured on the Worker.

The deployment job probes `/health`, `/app.js`, and `/style.css`. Use Actions → Check and deploy → Run workflow on `main` to retry after configuring secrets. A successful check job alone does not mean production was deployed; inspect the separate deploy job and its probes.

References: [Cloudflare GitHub Actions setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) and [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).

Completed test runs from before scenario packages existed are preserved byte-for-byte in the `archived_runs` table during the additive storage migration. They no longer participate in current game processing. Protected `/admin/archives?installation=...` lists archive metadata; current `/admin/status` contains validated scenario runs. Future-version or active malformed records are not silently archived.
