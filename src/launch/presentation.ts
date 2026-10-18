import type { Job } from "./types.ts";
export function publicLaunch(job: Job | undefined, slug = "pr-flood") {
  if (!job) return {};
  const labels: Record<string, [string, string]> = {
    creating: [
      "Creating your repository",
      "Preparing a new home for this playthrough.",
    ],
    connecting: [
      "Connecting the game master",
      "Checking GitHub App access to your new repository.",
    ],
    seeding: [
      job.mode === "milestone"
        ? "Preparing your milestone"
        : "Contributors are arriving",
      job.mode === "milestone"
        ? "Adding the release brief. You will create the issues and work them with Louibot locally; trusted grading checks are added when you are ready to finish."
        : "Adding the release brief, issues, and pull requests. This can take a minute or two.",
    ],
    ready: [
      "Your project is ready",
      "The release brief is waiting in Game Master issue #1.",
    ],
    "waiting-access": [
      "Finish connecting PR Flood",
      job.repository
        ? "PR Flood cannot access this repository yet. Install or update the app, select this repository, approve any requested permission changes, then return and check access again."
        : "Install PR Flood on your personal GitHub account and approve the requested access. Return here and check access again to continue creating your repository.",
    ],
    failed: [
      "Setup needs another try",
      job.error ??
        "Your repository is preserved. Confirm PR Flood can access it, then resume setup.",
    ],
  };
  return {
    id: job.id,
    scenario: job.scenario,
    state: job.state,
    title: labels[job.state]?.[0],
    message: labels[job.state]?.[1],
    url: job.url
      ? job.state === "ready"
        ? job.url + "/issues/1"
        : job.url
      : undefined,
    installUrl:
      job.state === "waiting-access"
        ? `https://github.com/apps/${slug}/installations/new`
        : undefined,
  };
}
