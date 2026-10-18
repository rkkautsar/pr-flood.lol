import { packages } from "../fixtures/packages.ts";
import { findPackage, selectScenario } from "../../src/packages.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { Miniflare } from "miniflare";
import { publicRequest } from "../../src/package-registry.ts";
import { report } from "../../src/diagnostics.ts";
const token = "a".repeat(64);
const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appPem = appKey.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

test("the old Worker hostname redirects pages while webhook ingress stays available", async () => {
  const mf = runtime({ bindings: { PUBLIC_ORIGIN: "https://pr-flood.lol" } });
  try {
    const home = await mf.dispatchFetch(
      "https://maintainer-sim.rkkautsar.workers.dev/",
      { redirect: "manual" },
    );
    assert.equal(home.status, 308);
    assert.equal(home.headers.get("location"), "https://pr-flood.lol/");
    const canonical = await mf.dispatchFetch("https://pr-flood.lol/");
    assert.equal(canonical.status, 200);
    assert.match(await canonical.text(), /PR Flood/);
    const response = await mf.dispatchFetch(
      "https://maintainer-sim.rkkautsar.workers.dev/auth/start",
      { redirect: "manual" },
    );
    assert.equal(response.status, 308);
    assert.equal(
      response.headers.get("location"),
      "https://pr-flood.lol/auth/start",
    );
    const webhook = await mf.dispatchFetch(
      "https://maintainer-sim.rkkautsar.workers.dev/webhooks",
      { method: "POST", body: "{}", redirect: "manual" },
    );
    assert.equal(webhook.status, 401);
    assert.equal(webhook.headers.get("location"), null);
  } finally {
    await mf.dispose();
  }
});
function registryService(
  options: {
    corrupt?: boolean;
    missingAsset?: boolean;
    repo?: string;
    delayReleasesMs?: number;
    offline?: () => boolean;
    onGameRepo?: () => void;
    private?: boolean;
    oversizedBody?: boolean;
    oversizedManifest?: boolean;
    malformedManifest?: boolean;
    badManifestDigest?: boolean;
    missingManifest?: boolean;
    forbiddenRest?: boolean;
    packageOverrides?: (typeof packages)[number][];
    metrics?: {
      appTokenRequests: number;
      appJwtRequests: number;
      authHeaders: number;
      cdnDownloads: number;
      assetApiDownloads: number;
      apiRequests?: number;
      manifestDownloads?: number;
    };
  } = {},
) {
  const repo = options.repo ?? "rkkautsar/forum-scenario";
  const repoPackages = options.packageOverrides ?? packages;
  const assetIds = new Map([
    [100, repoPackages[0]],
    [101, repoPackages[1]],
  ]);
  return async (request: any) => {
    const url = new URL(request.url),
      path = decodeURIComponent(url.pathname);
    if (options.metrics && url.hostname === "api.github.com")
      options.metrics.apiRequests = (options.metrics.apiRequests ?? 0) + 1;
    if (options.metrics && request.headers.get("authorization"))
      options.metrics.authHeaders++;
    if (path === "/repos/owner/game" && request.method === "GET") {
      options.onGameRepo?.();
      return Response.json({
        id: 91,
        default_branch: "main",
        owner: { id: 3 },
      }) as any;
    }
    if (path === "/repos/owner/game/git/ref/heads/main")
      return Response.json(
        { message: "No fixture branch" },
        { status: 404 },
      ) as any;
    if (options.offline?.() && path.startsWith(`/repos/${repo}/`))
      return new Response("registry offline", { status: 503 }) as any;
    if (
      options.forbiddenRest &&
      url.hostname === "api.github.com" &&
      path.startsWith(`/repos/${repo}`)
    )
      return Response.json(
        { message: "Forbidden" },
        { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      ) as any;
    const latestManifest =
      path === `/${repo}/releases/latest/download/scenario-manifest.json`;
    const versionManifest = new RegExp(
      `^/${repo.replaceAll("/", "\\/")}/releases/download/v(\\d+\\.\\d+\\.\\d+)/scenario-manifest\\.json$`,
    ).exec(path);
    if ((latestManifest || versionManifest) && request.method === "GET") {
      if (options.metrics)
        options.metrics.manifestDownloads =
          (options.metrics.manifestDownloads ?? 0) + 1;
      if (
        versionManifest &&
        !repoPackages.some((pack) => pack.version === versionManifest[1])
      )
        return new Response("Not found", { status: 404 }) as any;
      if (options.private || options.missingManifest)
        return new Response("Not found", { status: 404 }) as any;
      if (options.oversizedManifest)
        return new Response(new Uint8Array(16001)) as any;
      if (options.malformedManifest)
        return Response.json({ schema: 1, id: "bad" }) as any;
      const pack =
        latestManifest || versionManifest?.[1] === repoPackages[1].version
          ? repoPackages[1]
          : repoPackages[0];
      return Response.json({
        schema: 1,
        id: pack.id,
        version: pack.version,
        digest: options.badManifestDigest ? "0".repeat(64) : pack.digest,
        asset: "scenario.json",
      }) as any;
    }
    if (path === `/repos/${repo}` && request.method === "GET") {
      if (options.private)
        return Response.json({ message: "Not found" }, { status: 404 }) as any;
      return Response.json({ private: false }) as any;
    }
    if (path === `/repos/${repo}/installation`) {
      if (options.metrics) options.metrics.appJwtRequests++;
      return Response.json({ id: 171562073 }) as any;
    }
    if (
      /^\/app\/installations\/\d+\/access_tokens$/.test(path) &&
      request.method === "POST"
    ) {
      if (options.metrics) options.metrics.appTokenRequests++;
      return Response.json({ token: "fixture-installation-token" }) as any;
    }
    if (path === `/repos/${repo}/releases` && request.method === "GET") {
      if (options.delayReleasesMs)
        await new Promise((resolve) =>
          setTimeout(resolve, options.delayReleasesMs),
        );
      return Response.json([
        {
          tag_name: `v${repoPackages[1].version}`,
          body: `Scenario SHA-256: ${repoPackages[1].digest}`,
          draft: false,
          prerelease: false,
          assets: options.missingAsset
            ? []
            : [{ id: 101, name: "scenario.json", size: 1000 }],
        },
        {
          tag_name: `v${repoPackages[0].version}`,
          body: `Scenario SHA-256: ${repoPackages[0].digest}`,
          draft: false,
          prerelease: false,
          assets: [{ id: 100, name: "scenario.json", size: 1000 }],
        },
      ]) as any;
    }
    const download = new RegExp(
      `^/${repo.replaceAll("/", "\\/")}/releases/download/v(\\d+\\.\\d+\\.\\d+)/scenario\\.json$`,
    ).exec(path);
    if (download && request.method === "GET") {
      if (options.metrics) options.metrics.cdnDownloads++;
      if (options.private)
        return new Response("private download unavailable", {
          status: 404,
        }) as any;
      if (options.oversizedBody)
        return new Response(new Uint8Array(1_900_001), {
          headers: { "content-type": "application/json" },
        }) as any;
      const pack = repoPackages.find(
        (candidate) => candidate.version === download[1],
      )!;
      const body: any = structuredClone(pack);
      if (options.corrupt && download[1] === "0.1.1")
        body.digest = "0".repeat(64);
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }) as any;
    }
    const asset = new RegExp(
      `^/repos/${repo.replaceAll("/", "\\/")}/releases/assets/(100|101)$`,
    ).exec(path);
    if (asset && request.method === "GET") {
      if (options.metrics) options.metrics.assetApiDownloads++;
      const pack = assetIds.get(Number(asset[1]))!;
      const body: any = structuredClone(pack);
      if (options.corrupt && asset[1] === "101") body.digest = "0".repeat(64);
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/octet-stream" },
      }) as any;
    }
    return new Response("Unexpected fixture request", { status: 404 }) as any;
  };
}
function runtime(extra: any = {}) {
  const { bindings: bindingOverrides = {}, ...other } = extra;
  return new Miniflare({
    modules: true,
    scriptPath: "var/worker-build/worker.js",
    assets: {
      directory: "public",
      binding: "ASSETS",
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: true,
      },
    },
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      GAMES: { className: "GameSession", useSQLite: true },
      BUDGET: { className: "AIBudget", useSQLite: true },
    },
    bindings: {
      ADMIN_TOKEN: token,
      WEBHOOK_SECRET: "secret",
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: appPem,
      SCENARIO_REPOSITORIES: "rkkautsar/forum-scenario",
      JUDGE_ENABLED: "false",
      JUDGE_INPUT_USD_PER_MILLION: "31.25",
      AI_DAILY_BUDGET_USD: "2",
      JUDGE_CONFIDENCE_THRESHOLD: "0.9",
      ...bindingOverrides,
    },
    outboundService: registryService(),
    ...other,
  });
}
test("workerd handles health, authentication, malformed requests, signed delivery", async () => {
  const mf = runtime();
  try {
    assert.equal((await mf.dispatchFetch("https://app/health")).status, 200);
    assert.equal(
      (await mf.dispatchFetch("https://app/admin/status?installation=1"))
        .status,
      401,
    );
    const headers = { Authorization: "Bearer " + token };
    const response = await mf.dispatchFetch(
      "https://app/admin/status?installation=1",
      { headers },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    const archives = await mf.dispatchFetch(
      "https://app/admin/archives?installation=1",
      { headers },
    );
    assert.equal(archives.status, 200);
    assert.deepEqual(await archives.json(), []);
    assert.equal(
      (
        await mf.dispatchFetch("https://app/admin/seed", {
          method: "POST",
          headers,
          body: "invalid",
        })
      ).status,
      400,
    );
    const target = {
      installation: 1,
      repository: 2,
      owner: "owner",
      repo: "game",
      player: 3,
      confirmDisposable: true,
    };
    for (const scenario of [
      undefined,
      { id: "forum", version: "0.1.0", stage: "launch", digest: "invalid" },
    ]) {
      assert.equal(
        (
          await mf.dispatchFetch("https://app/admin/seed", {
            method: "POST",
            headers,
            body: JSON.stringify({ ...target, scenario }),
          })
        ).status,
        400,
        "seeding requires an explicit validated scenario package",
      );
    }
    const installationBody = JSON.stringify({
      action: "created",
      installation: { id: 1 },
      sender: { id: 3, type: "User" },
      repositories: [{ id: 2, full_name: "owner/game" }],
    });
    assert.equal(
      (
        await mf.dispatchFetch("https://app/webhooks", {
          method: "POST",
          body: installationBody,
          headers: {
            "x-github-event": "installation",
            "x-github-delivery": "installed",
            "x-hub-signature-256":
              "sha256=" +
              createHmac("sha256", "secret")
                .update(installationBody)
                .digest("hex"),
          },
        })
      ).status,
      202,
    );
    assert.deepEqual(
      await (
        await mf.dispatchFetch("https://app/admin/status?installation=1", {
          headers,
        })
      ).json(),
      [],
      "App installation alone does not start a playthrough",
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://app/webhooks", {
          method: "POST",
          body: "{}",
        })
      ).status,
      401,
    );
    const body = JSON.stringify({
        installation: { id: 1 },
        repository: { id: 2 },
      }),
      sig =
        "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
    assert.equal(
      (
        await mf.dispatchFetch("https://app/webhooks", {
          method: "POST",
          body,
          headers: {
            "x-hub-signature-256": sig,
            "x-github-event": "push",
            "x-github-delivery": "one",
          },
        })
      ).status,
      202,
    );
  } finally {
    await mf.dispose();
  }
});
test("release registry exposes latest public metadata without package internals", async () => {
  const mf = runtime();
  try {
    const response = await mf.dispatchFetch("https://app/api/scenarios");
    assert.equal(response.status, 200);
    const catalog = (await response.json()) as any[];
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, "forum");
    assert.equal(catalog[0].version, "0.1.1");
    const publicJson = JSON.stringify(catalog);
    for (const privateField of [
      "concern",
      "lesson",
      "satisfiesIssue",
      "fixture-installation-token",
    ])
      assert.equal(publicJson.includes(privateField), false);
    for (const pack of packages) {
      const portrait = await mf.dispatchFetch(
        `https://app/portraits/${pack.digest}/maya.svg`,
      );
      assert.equal(portrait.status, 200);
    }
    assert.equal(
      (
        await mf.dispatchFetch(
          `https://app/portraits/${"f".repeat(64)}/maya.svg`,
        )
      ).status,
      404,
    );
  } finally {
    await mf.dispose();
  }
});

test("anonymous rate limits do not block an authenticated private source", async () => {
  for (const status of [403, 429]) {
    const repo = `rkkautsar/private-rate-${status}`;
    const service = registryService({ repo, private: true });
    const mf = runtime({
      bindings: { SCENARIO_REPOSITORIES: repo },
      outboundService: async (request: any) => {
        if (new URL(request.url).pathname === `/repos/${repo}`)
          return Response.json(
            { message: "Rate limit exceeded" },
            { status },
          ) as any;
        return service(request);
      },
    });
    try {
      assert.equal(
        (await mf.dispatchFetch("https://app/api/scenarios")).status,
        200,
      );
    } finally {
      await mf.dispose();
    }
  }
});

test("public release downloads use anonymous CDN access without App secrets", async () => {
  const metrics = {
    appTokenRequests: 0,
    appJwtRequests: 0,
    authHeaders: 0,
    cdnDownloads: 0,
    assetApiDownloads: 0,
    apiRequests: 0,
    manifestDownloads: 0,
  };
  const mf = runtime({
    bindings: { GITHUB_APP_ID: "", GITHUB_PRIVATE_KEY: "" },
    outboundService: registryService({ metrics, forbiddenRest: true }),
  });
  try {
    const response = await mf.dispatchFetch("https://app/api/scenarios");
    assert.equal(response.status, 200);
    const body = (await response.json()) as any[];
    assert.equal(body[0].version, "0.1.1");
    assert.equal(metrics.appTokenRequests, 0);
    assert.equal(metrics.appJwtRequests, 0);
    assert.equal(metrics.authHeaders, 0);
    assert.equal(metrics.cdnDownloads, 1);
    assert.equal(metrics.assetApiDownloads, 0);
    assert.equal(metrics.apiRequests, 0);
    assert.equal(metrics.manifestDownloads, 1);
  } finally {
    await mf.dispose();
  }
});

test("pinned and digest lookups load public release manifests without REST", async () => {
  for (const path of [
    "/scenarios/forum/0.1.0/preview",
    `/portraits/${packages[1].digest}/maya.svg`,
  ]) {
    const metrics = {
      appTokenRequests: 0,
      appJwtRequests: 0,
      authHeaders: 0,
      cdnDownloads: 0,
      assetApiDownloads: 0,
      apiRequests: 0,
      manifestDownloads: 0,
    };
    const mf = runtime({
      bindings: { GITHUB_APP_ID: "", GITHUB_PRIVATE_KEY: "" },
      outboundService: registryService({ metrics, forbiddenRest: true }),
    });
    try {
      const response = await mf.dispatchFetch(`https://app${path}`);
      assert.equal(response.status, 200);
      assert.equal(metrics.apiRequests, 0);
      assert.equal(metrics.manifestDownloads, 1);
      assert.equal(metrics.assetApiDownloads, 0);
    } finally {
      await mf.dispose();
    }
  }
});

test("public manifests fail closed on invalid or oversized metadata", async () => {
  for (const options of [
    { malformedManifest: true },
    { oversizedManifest: true },
    { badManifestDigest: true },
  ]) {
    const mf = runtime({
      bindings: { GITHUB_APP_ID: "", GITHUB_PRIVATE_KEY: "" },
      outboundService: registryService(options),
    });
    try {
      assert.equal(
        (await mf.dispatchFetch("https://app/api/scenarios")).status,
        503,
      );
    } finally {
      await mf.dispose();
    }
  }
});

test("public source rejection diagnostics expose only a safe reason", async () => {
  const messages: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => messages.push(String(message));
  try {
    await publicRequest(
      "https://api.github.com/repos/example/source",
      undefined,
      null,
      async () =>
        new Response("private response body", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            authorization: "secret-token",
          },
        }),
    );
    await publicRequest(
      "https://api.github.com/repos/example/source",
      undefined,
      null,
      async () => new Response("private response body", { status: 403 }),
    );
  } finally {
    console.info = original;
  }
  assert.deepEqual(
    messages.map((message) => JSON.parse(message)),
    [
      {
        component: "http",
        event: "scenario_source_rejected",
        reason: "rate_limited",
      },
      {
        component: "http",
        event: "scenario_source_rejected",
        reason: "forbidden",
      },
    ],
  );
  assert.equal(messages.join(" ").includes("secret-token"), false);
  assert.equal(messages.join(" ").includes("private response body"), false);
});

test("seed diagnostic logs include only an allowlisted step", () => {
  const messages: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => messages.push(String(message));
  try {
    report({
      component: "game",
      event: "delivery_failed",
      reason: "unexpected_error",
      delivery: "seed:run-id",
      step: "create_milestone",
    });
    report({
      component: "game",
      event: "delivery_failed",
      reason: "unexpected_error",
      delivery: "seed:run-id",
      step: "private provider response" as any,
    });
  } finally {
    console.info = original;
  }
  assert.deepEqual(
    messages.map((message) => JSON.parse(message)),
    [
      {
        component: "game",
        event: "delivery_failed",
        reason: "unexpected_error",
        delivery: "seed:run-id",
        step: "create_milestone",
      },
      {
        component: "game",
        event: "delivery_failed",
        reason: "unexpected_error",
        delivery: "seed:run-id",
      },
    ],
  );
  assert.equal(messages.join(" ").includes("private provider response"), false);
});

test("private source repositories fall back to App-authenticated asset downloads", async () => {
  const metrics = {
    appTokenRequests: 0,
    appJwtRequests: 0,
    authHeaders: 0,
    cdnDownloads: 0,
    assetApiDownloads: 0,
  };
  const mf = runtime({
    outboundService: registryService({ metrics, private: true }),
  });
  try {
    const response = await mf.dispatchFetch("https://app/api/scenarios");
    assert.equal(response.status, 200);
    assert.equal(metrics.appTokenRequests, 1);
    assert.equal(metrics.appJwtRequests, 1);
    assert.equal(metrics.cdnDownloads, 0);
    assert.equal(metrics.assetApiDownloads, 1);
  } finally {
    await mf.dispose();
  }
});

test("mixed public and private sources keep public REST out of pinned fallback", async () => {
  const publicRepo = "rkkautsar/public-fixture";
  const privateRepo = "rkkautsar/private-fixture";
  const { digest: oldDigest, ...privateContent } = structuredClone(packages[1]);
  void oldDigest;
  privateContent.id = "private-forum";
  privateContent.version = "1.0.0";
  const privatePack = {
    ...privateContent,
    digest: createHash("sha256")
      .update(JSON.stringify(privateContent))
      .digest("hex"),
  };
  const publicMetrics = {
    appTokenRequests: 0,
    appJwtRequests: 0,
    authHeaders: 0,
    cdnDownloads: 0,
    assetApiDownloads: 0,
    apiRequests: 0,
    manifestDownloads: 0,
  };
  const privateMetrics = {
    appTokenRequests: 0,
    appJwtRequests: 0,
    authHeaders: 0,
    cdnDownloads: 0,
    assetApiDownloads: 0,
    apiRequests: 0,
    manifestDownloads: 0,
  };
  const publicSource = registryService({
    repo: publicRepo,
    metrics: publicMetrics,
    forbiddenRest: true,
  });
  const privateSource = registryService({
    repo: privateRepo,
    private: true,
    metrics: privateMetrics,
    packageOverrides: [packages[0], privatePack],
  });
  const createRuntime = () =>
    runtime({
      bindings: { SCENARIO_REPOSITORIES: `${publicRepo},${privateRepo}` },
      outboundService: (request: any) => {
        const path = new URL(request.url).pathname;
        return path.includes(privateRepo) ||
          path.startsWith("/app/installations/")
          ? privateSource(request)
          : publicSource(request);
      },
    });
  const mf = createRuntime();
  try {
    const catalog = await mf.dispatchFetch("https://app/api/scenarios");
    assert.equal(catalog.status, 200);
    assert.deepEqual(
      ((await catalog.json()) as any[]).map((scenario) => scenario.id).sort(),
      ["forum", "private-forum"],
    );
  } finally {
    await mf.dispose();
  }
  privateMetrics.apiRequests = 0;
  privateMetrics.assetApiDownloads = 0;
  const coldPinned = createRuntime();
  try {
    const preview = await coldPinned.dispatchFetch(
      "https://app/scenarios/private-forum/1.0.0/preview",
    );
    assert.equal(preview.status, 200);
    assert.equal(publicMetrics.apiRequests, 0);
    assert.ok(privateMetrics.apiRequests > 0);
    assert.equal(privateMetrics.assetApiDownloads, 1);
  } finally {
    await coldPinned.dispose();
  }
});

test("public CDN body exceeding the package limit is rejected", async () => {
  const metrics = {
    appTokenRequests: 0,
    appJwtRequests: 0,
    authHeaders: 0,
    cdnDownloads: 0,
    assetApiDownloads: 0,
  };
  const mf = runtime({
    bindings: { GITHUB_APP_ID: "", GITHUB_PRIVATE_KEY: "" },
    outboundService: registryService({ metrics, oversizedBody: true }),
  });
  try {
    const response = await mf.dispatchFetch("https://app/api/scenarios");
    assert.equal(response.status, 503);
    assert.equal(metrics.appTokenRequests, 0);
    assert.equal(metrics.appJwtRequests, 0);
    assert.equal(metrics.authHeaders, 0);
    assert.equal(metrics.cdnDownloads, 1);
    assert.equal(metrics.assetApiDownloads, 0);
  } finally {
    await mf.dispose();
  }
});

test("an older release remains available to a pinned seed", async () => {
  const mf = runtime();
  try {
    const selected = selectScenario(findPackage("forum", "0.1.0"));
    const preview = await mf.dispatchFetch(
      "https://app/scenarios/forum/0.1.0/preview",
    );
    const previewText = await preview.text();
    assert.equal(preview.status, 200, previewText);
    assert.ok(selected.digest.length === 64);
    assert.match(previewText, /Synthetic scenario fixture — starting app/);
    const response = await mf.dispatchFetch("https://app/admin/seed", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: JSON.stringify({
        installation: 1,
        repository: 91,
        owner: "owner",
        repo: "game",
        player: 3,
        confirmDisposable: true,
        scenario: selected,
      }),
    });
    assert.equal(response.status, 202);
    const { runId } = (await response.json()) as any;
    const status = await mf.dispatchFetch(
      "https://app/admin/status?installation=1",
      {
        headers: { Authorization: "Bearer " + token },
      },
    );
    const runs = (await status.json()) as any[];
    assert.equal(
      runs.find((run) => run.id === runId)?.scenario?.version,
      "0.1.0",
    );
  } finally {
    await mf.dispose();
  }
});

test("slow package lookup finishes before the seed alarm and the run survives a release outage", async () => {
  let offline = false;
  let gameRepositoryRequested = false;
  const service = registryService({
    delayReleasesMs: 350,
    offline: () => offline,
    onGameRepo: () => {
      gameRepositoryRequested = true;
    },
  });
  const mf = runtime({ outboundService: service });
  try {
    const selected = selectScenario(findPackage("forum", "0.1.0"));
    const seed = await mf.dispatchFetch("https://app/admin/seed", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: JSON.stringify({
        installation: 1,
        repository: 92,
        owner: "owner",
        repo: "game",
        player: 3,
        confirmDisposable: true,
        scenario: selected,
      }),
    });
    assert.equal(seed.status, 202);
    assert.equal(
      gameRepositoryRequested,
      false,
      "alarm must wait until package validation completes",
    );
    offline = true;
    for (let i = 0; i < 30 && !gameRepositoryRequested; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      gameRepositoryRequested,
      true,
      "the durable run should load its pinned package from storage while releases are unavailable",
    );
  } finally {
    await mf.dispose();
  }
});

test("invalid release digest and missing assets fail closed without leaking package data", async () => {
  for (const [index, options] of [
    { corrupt: true },
    { missingAsset: true, missingManifest: true },
  ].entries()) {
    const repo = `rkkautsar/forum-test-${index}`;
    const mf = runtime({
      bindings: {
        SCENARIO_REPOSITORIES: repo,
        GITHUB_APP_ID: `failure-${index}`,
      },
      outboundService: registryService({ ...options, repo }),
    });
    try {
      const response = await mf.dispatchFetch("https://app/api/scenarios");
      const text = await response.text();
      assert.ok(response.status >= 500, `${response.status}: ${text}`);
      assert.equal(text.includes("Synthetic 0.1.1"), false);
      assert.equal(text.includes("fixture-installation-token"), false);
    } finally {
      await mf.dispose();
    }
  }
});
test("global budget atomically caps concurrent claims and settles actual usage once", async () => {
  const mf = runtime();
  try {
    const ns = await mf.getDurableObjectNamespace("BUDGET"),
      stub = ns.get(ns.idFromName("global"));
    const call = async (body: any) =>
      (await (
        await stub.fetch("https://budget", {
          method: "POST",
          body: JSON.stringify(body),
        })
      ).json()) as any;
    const keys = Array.from({ length: 20 }, (_, i) =>
      createHash("sha256").update(String(i)).digest("hex"),
    );
    const results = await Promise.all(
      keys.map((key) => call({ action: "claim", key })),
    );
    assert.equal(results.filter((r) => r.claimed).length, 2);
    const claimed = keys[results.findIndex((r) => r.claimed)];
    await call({
      action: "complete",
      key: claimed,
      inputTokens: 2000,
      result: "identified",
    });
    await call({
      action: "complete",
      key: claimed,
      inputTokens: 0,
      result: "consequence",
    });
    const cached = await call({ action: "claim", key: claimed });
    assert.equal(cached.result, "identified");
    // After settlement, 1.0625 is used; another full 1-dollar reservation still cannot fit.
    assert.equal(
      (await call({ action: "claim", key: "f".repeat(64) })).claimed,
      false,
    );
    const second =
      keys[results.findIndex((r, i) => r.claimed && keys[i] !== claimed)];
    await call({
      action: "complete",
      key: second,
      inputTokens: 2000,
      result: null,
    });
    assert.equal(
      (await call({ action: "claim", key: "f".repeat(64) })).claimed,
      true,
    );
  } finally {
    await mf.dispose();
  }
});
test("actual workerd alarm signs GitHub App JWT for a packaged seed", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  let signed = false;
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const mf = runtime({
    bindings: {
      ADMIN_TOKEN: token,
      WEBHOOK_SECRET: "secret",
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: pem,
      SCENARIO_REPOSITORIES: "rkkautsar/forum-scenario",
      JUDGE_ENABLED: "false",
      JUDGE_INPUT_USD_PER_MILLION: "0.042",
      AI_DAILY_BUDGET_USD: "1",
      JUDGE_CONFIDENCE_THRESHOLD: "0.9",
    },
    outboundService: async (request: any) => {
      const path = new URL(request.url).pathname;
      if (
        path === "/repos/rkkautsar/forum-scenario/installation" ||
        /\/app\/installations\/\d+\/access_tokens$/.test(path)
      ) {
        const jwt = request.headers
          .get("Authorization")!
          .replace(/^(token|Bearer) /i, "");
        const [header, body, signature] = jwt.split(".");
        assert.equal(
          verify(
            "RSA-SHA256",
            Buffer.from(header + "." + body),
            publicKey,
            Buffer.from(signature, "base64url"),
          ),
          true,
        );
        assert.equal(
          JSON.parse(Buffer.from(body, "base64url").toString()).iss,
          "123",
        );
        signed = true;
        if (path.endsWith("/access_tokens"))
          return Response.json({
            token: "fixture-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }) as any;
      }
      return registryService()(request);
    },
  });
  try {
    const response = await mf.dispatchFetch("https://app/admin/seed", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: JSON.stringify({
        installation: 1,
        repository: 2,
        owner: "owner",
        repo: "game",
        player: 3,
        confirmDisposable: true,
        scenario: selectScenario(findPackage("forum", "0.1.0")),
      }),
    });
    assert.equal(response.status, 202);
    for (let i = 0; i < 40 && !signed; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(signed, true, "durable alarm must execute JWT signing");
    const status = await mf.dispatchFetch(
      "https://app/admin/status?installation=1",
      { headers: { Authorization: "Bearer " + token } },
    );
    assert.equal(((await status.json()) as any[]).length, 1);
  } finally {
    await mf.dispose();
  }
});

test("shared budget caches validated coaching and milestone scores", async () => {
  const mf = runtime();
  try {
    const ns = await mf.getDurableObjectNamespace("BUDGET");
    const stub = ns.get(ns.idFromName("coaching-budget"));
    const call = (body: any) =>
      stub.fetch("https://budget", {
        method: "POST",
        body: JSON.stringify(body),
      });
    const key = "c".repeat(64);
    assert.equal(
      ((await (await call({ action: "claim", key })).json()) as any).claimed,
      true,
    );
    assert.equal(
      (
        await call({
          action: "complete",
          key,
          result: "coach-v1:actionable:automation",
          inputTokens: 600,
        })
      ).status,
      200,
    );
    assert.equal(
      ((await (await call({ action: "claim", key })).json()) as any).result,
      "coach-v1:actionable:automation",
    );
    assert.equal(
      (
        await call({
          action: "complete",
          key,
          result: "coach-v1:perfect:award-points",
          inputTokens: 600,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call({
          action: "complete",
          key,
          result: { points: 100 },
          inputTokens: 600,
        })
      ).status,
      400,
    );
    const milestoneKey = "d".repeat(64);
    assert.equal(
      (
        (await (
          await call({ action: "claim", key: milestoneKey })
        ).json()) as any
      ).claimed,
      true,
    );
    const milestoneResult = "milestone-quality-v2:0:40:75:100";
    assert.equal(
      (
        await call({
          action: "complete",
          key: milestoneKey,
          result: milestoneResult,
          inputTokens: 900,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        (await (
          await call({ action: "claim", key: milestoneKey })
        ).json()) as any
      ).result,
      milestoneResult,
    );
    assert.equal(
      (
        await call({
          action: "complete",
          key: "e".repeat(64),
          result: "milestone-quality-v2:0:40:75:101",
          inputTokens: 900,
        })
      ).status,
      400,
    );
  } finally {
    await mf.dispose();
  }
});
