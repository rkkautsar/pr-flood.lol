import { z } from "zod";
import type { Env } from "../cloudflare/env.ts";
import { errorStatus } from "../diagnostics.ts";
import { GitHub } from "../github.ts";
import { selectScenario } from "../packages.ts";
import { registry } from "../package-registry.ts";
import { parse } from "../validation.ts";
import type { Job, Login } from "./types.ts";
import {
  createdRepositorySchema,
  installationsSchema,
  userRequest,
} from "./user-api.ts";
export async function provisionLaunch(
  job: Job,
  login: Login,
  env: Env,
  storage: DurableObjectStorage,
) {
  // Persist the visible marker for new launches; older in-flight creation intents
  // must still match the exact description sent before the rebrand.
  const marker = job.marker ?? "Maintainer Sim playthrough · " + job.id;
  const pack = await registry(env).pinned(
      { id: job.scenario, version: job.version, digest: job.digest },
      storage,
    ),
    selection = selectScenario(pack, job.stage ?? pack.stages[0].id),
    root = "/repos/" + login.user.login + "/" + job.name;
  if (!job.quotaGranted)
    throw Object.assign(Error("Launch quota not granted"), { status: 403 });
  if (job.owner !== login.user.id) throw Error("Wrong launch owner");
  if (!job.installation) {
    const installed = await userRequest(
      login.token,
      "GET",
      "/user/installations?per_page=100",
      installationsSchema,
    );
    const installation = installed.installations?.find(
      (i) =>
        i.app_id === Number(env.GITHUB_APP_ID) &&
        i.account?.id === login.user.id &&
        !i.suspended_at,
    );
    if (!installation) {
      job.state = "waiting-access";
      return;
    }
    job.installation = installation.id;
    return;
  }
  if (!job.repository) {
    if (!job.createSent) {
      // Refuse existing names before recording the creation intent.
      let existing:
        import("zod").infer<typeof createdRepositorySchema> | undefined;
      try {
        existing = await userRequest(
          login.token,
          "GET",
          root,
          createdRepositorySchema,
        );
      } catch (error) {
        if (errorStatus(error) !== 404) throw error;
      }
      if (existing) {
        if (
          existing.owner?.id === login.user.id &&
          existing.description === marker &&
          Date.parse(existing.created_at ?? "") >= job.createdAt - 60000
        ) {
          job.repository = existing.id;
          job.url = existing.html_url;
          job.state = "connecting";
          return;
        }
        throw Object.assign(new Error("Repository exists"), { status: 409 });
      }
      job.createSent = true;
      await storage.put("job", job);
      let repo: import("zod").infer<typeof createdRepositorySchema>;
      try {
        repo = await userRequest(
          login.token,
          "POST",
          "/user/repos",
          createdRepositorySchema,
          {
            name: job.name,
            private: job.private,
            auto_init: true,
            description: marker,
          },
        );
      } catch (error) {
        if ([400, 401, 403, 422].includes(errorStatus(error) ?? 0)) {
          job.createSent = false;
          await storage.put("job", job);
        }
        throw error;
      }
      if (repo.owner?.id !== login.user.id || repo.name !== job.name)
        throw Error("Unexpected repository");
      job.repository = repo.id;
      job.url = repo.html_url;
      job.state = "connecting";
      return;
    }
    // A lost POST response is recoverable only for the exact empty repository we marked.
    let repo: import("zod").infer<typeof createdRepositorySchema>;
    try {
      repo = await userRequest(
        login.token,
        "GET",
        root,
        createdRepositorySchema,
      );
    } catch (error) {
      if (errorStatus(error) === 404) {
        job.createSent = false;
        return;
      }
      throw error;
    }
    if (
      repo.owner?.id !== login.user.id ||
      repo.description !== marker ||
      (repo.created_at && Date.parse(repo.created_at) < job.createdAt - 60000)
    )
      throw Object.assign(Error("Repository identity mismatch"), {
        status: 409,
      });
    job.repository = repo.id;
    job.url = repo.html_url;
    job.state = "connecting";
    return;
  }
  if (!job.connected) {
    try {
      await GitHub.fromKey(
        job.installation!,
        job.repository!,
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
      );
    } catch (error) {
      if ([403, 404, 422].includes(errorStatus(error) ?? 0)) {
        job.state = "waiting-access";
        return;
      }
      throw error;
    }
    job.connected = true;
    return;
  }
  const gh = await GitHub.fromKey(
    job.installation,
    job.repository,
    env.GITHUB_APP_ID,
    env.GITHUB_PRIVATE_KEY,
  );
  if (!job.baseline) {
    const repo = await gh.repository(root);
    if (repo.id !== job.repository || repo.owner.id !== login.user.id)
      throw Error("Unexpected repository identity");
    const branch = repo.default_branch || "main",
      ref = await gh.reference(root, branch),
      current = await gh.tree(root, ref.object.sha),
      target = pack.stages[0].baseline;
    const matches =
      JSON.stringify(Object.entries(current).sort()) ===
      JSON.stringify(Object.entries(target).sort());
    if (matches) {
      job.baseline = ref.object.sha;
      job.state = "seeding";
      return;
    }
    const parent = await gh.readCommit(root, ref.object.sha);
    if (
      parent.parents?.length ||
      Object.keys(current).some((p) => p !== "README.md")
    )
      throw Error("Repository was edited during setup");
    const commit = await gh.commit(
      root,
      ref.object.sha,
      target,
      "Start " + pack.title + " · " + job.id,
    );
    await gh.patch(root + "/git/refs/heads/" + branch, {
      sha: commit.sha,
      force: false,
    });
    job.baseline = commit.sha;
    job.state = "seeding";
    return;
  }
  const stub = env.GAMES.get(env.GAMES.idFromName(String(job.installation)));
  const status = await stub.fetch("https://game/status"),
    runs = parse(
      z.array(
        z.object({ id: z.string(), repository: z.number(), phase: z.string() }),
      ),
      await status.json(),
    ),
    run = runs.find((r) => r.repository === job.repository);
  if (run) {
    if (run.phase === "active" || run.phase === "finished") {
      job.run = run.id;
      job.state = "ready";
    } else {
      const response = await stub.fetch(
          "https://game/progress?repository=" + job.repository,
        ),
        progress = parse(
          z.object({ failed: z.boolean().optional() }),
          await response.json(),
        );
      if (progress.failed) {
        job.state = "failed";
        job.error =
          "Game setup could not finish. Check App permissions, then retry to resume.";
      }
    }
    return;
  }
  const response = await stub.fetch("https://game/seed", {
    method: "POST",
    body: JSON.stringify({
      installation: job.installation,
      repository: job.repository,
      owner: login.user.login,
      repo: job.name,
      player: login.user.id,
      confirmDisposable: true,
      scenario: selection,
    }),
  });
  if (!response.ok && response.status !== 409)
    throw Error("Could not queue game setup");
}
