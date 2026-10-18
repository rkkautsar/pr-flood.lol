import { DurableObject } from "cloudflare:workers";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { failureCode, report } from "../diagnostics.ts";
import { seedStepFrom } from "../game/seed-steps.ts";
import { initialRun } from "../engine.ts";
import { Game } from "../game.ts";
import { GitHub } from "../github.ts";
import { registry } from "../package-registry.ts";
import { validSignature } from "../security.ts";
import { InvalidData, parse, positiveId } from "../validation.ts";
import { parseWebhook, webhookEvents } from "../webhooks.ts";
import type { Env } from "./env.ts";
import { CloudJudge } from "./judge.ts";
import { launchRoute } from "./launch.ts";
import { CloudStore } from "./store.ts";
export { AIBudget } from "./budget.ts";
export { LaunchSession } from "./launch.ts";
const seedInput = z.object({
  installation: positiveId,
  repository: positiveId,
  player: positiveId,
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  confirmDisposable: z.literal(true),
  scenario: z.object({
    id: z.string(),
    version: z.string(),
    stage: z.string(),
    digest: z.string(),
  }),
});
async function limitedBody(request: Request, max = 1000000) {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      await reader.cancel();
      throw new Error("Body too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
function authorized(request: Request, token: string) {
  if (!token || token.length < 32) return false;
  const supplied = request.headers.get("Authorization") ?? "";
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256")
      .update("Bearer " + token)
      .digest(),
  );
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        env.PUBLIC_ORIGIN &&
        url.hostname.endsWith(".workers.dev") &&
        url.origin !== new URL(env.PUBLIC_ORIGIN).origin &&
        (["/", "/about", "/setup", "/auth/start"].includes(url.pathname) ||
          url.pathname.startsWith("/scenarios/"))
      ) {
        return Response.redirect(
          new URL(url.pathname + url.search, env.PUBLIC_ORIGIN),
          308,
        );
      }
      if (request.method === "GET" && url.pathname === "/" && env.ASSETS)
        return env.ASSETS.fetch(request);
      const launcher = await launchRoute(request, env);
      if (launcher) {
        const response = new Response(launcher.body, launcher);
        response.headers.set("cache-control", "no-store");
        response.headers.set("vary", "Cookie");
        response.headers.set("referrer-policy", "no-referrer");
        response.headers.set("x-content-type-options", "nosniff");
        return response;
      }
      if (request.method === "GET" && url.pathname === "/setup")
        return Response.redirect(
          new URL("/", env.PUBLIC_ORIGIN ?? url.origin),
          302,
        );
      if (request.method === "GET" && url.pathname === "/api/scenarios")
        return Response.json(
          (await registry(env).latest()).map((p) => ({
            id: p.id,
            version: p.version,
            title: p.title,
            description: p.description,
            stages: p.stages.length,
            mode: p.stages[0].mode ?? "review",
            prs: p.stages.reduce((n, s) => n + s.proposals.length, 0),
            preview: {
              title: p.stages[0].title,
              items:
                p.stages[0].mode === "milestone"
                  ? [
                      {
                        title: "Plan the issues yourself",
                        detail:
                          "Run Louibot locally against your GitHub issues",
                      },
                    ]
                  : p.stages[0].issues.slice(0, 3).map((issue) => ({
                      title: issue.title,
                      detail: "Roadmap issue",
                    })),
            },
            milestoneCards: p.stages
              .filter((stage) => stage.pool && stage.mode === "milestone")
              .map((stage) => ({ id: stage.id, title: stage.title })),
          })),
          { headers: { "cache-control": "no-store" } },
        );
      const portrait = /^\/portraits\/([a-f0-9]{64})\/([a-z0-9-]+)\.svg$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && portrait) {
        const pack = await registry(env).byDigest(portrait[1]),
          image = pack?.characters[portrait[2]]?.avatar;
        return image
          ? new Response(image, {
              headers: {
                "content-type": "image/svg+xml",
                "cache-control": "public,max-age=31536000,immutable",
                "content-security-policy":
                  "default-src 'none'; style-src 'none'; sandbox",
                "x-content-type-options": "nosniff",
              },
            })
          : new Response(null, { status: 404 });
      }
      const preview = /^\/scenarios\/([a-z0-9-]+)\/([0-9.]+)\/preview$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && (preview || url.pathname === "/about")) {
        const esc = (s: string) =>
          s.replace(
            /[&<>"']/g,
            (c) =>
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              })[c]!,
          );
        const p = preview
          ? await registry(env).pinned({ id: preview[1], version: preview[2] })
          : undefined;
        const heading = p ? p.title + " — starting app" : "About PR Flood";
        const body = p
          ? "<p>" +
            esc(p.description) +
            "</p><pre>" +
            esc(p.stages[0].baseline["README.md"] ?? "") +
            "</pre><h2>Application files</h2><pre>" +
            esc(Object.keys(p.stages[0].baseline).join("\n")) +
            "</pre>"
          : "<p>Practise maintaining an open-source project in GitHub. Review contributions, reach a milestone, and learn what your decisions mean for the project.</p><p>Scenarios contain a real runnable app and authored contributions. Contributor names and portraits are fictional; all GitHub posts come from the PR Flood App.</p><p>Start from the launch page, connect GitHub, and choose a new repository in your own account. You can finish early with <code>/game finish</code> and advance after debrief with <code>/game next</code>.</p>";
        return new Response(
          '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
            esc(heading) +
            '</title><style>body{font:16px/1.7 system-ui;max-width:850px;margin:40px auto;padding:24px;background:#f7f6f1;color:#26352b}a{color:#35674a}h1{font:42px Georgia}pre{white-space:pre-wrap;background:white;padding:24px;border:1px solid #dde2d6;border-radius:8px;font-size:13px}</style><a href="/">← PR Flood</a><h1>' +
            esc(heading) +
            "</h1>" +
            body +
            "</html>",
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy":
                "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
            },
          },
        );
      }
      if (url.pathname === "/health" && request.method === "GET")
        return new Response("ok");
      if (url.pathname === "/webhooks" && request.method === "POST") {
        const raw = await limitedBody(request);
        if (
          !validSignature(
            raw,
            request.headers.get("x-hub-signature-256") ?? undefined,
            env.WEBHOOK_SECRET,
          )
        )
          return new Response(null, { status: 401 });
        const id = request.headers.get("x-github-delivery"),
          event = request.headers.get("x-github-event");
        if (!id || id.length > 100 || !event)
          return new Response(null, { status: 400 });
        const rawPayload: unknown = JSON.parse(raw.toString());
        if (!webhookEvents.has(event))
          return new Response(null, { status: 202 });
        const payload = parseWebhook(rawPayload);
        if (
          !webhookEvents.has(event) ||
          !Number.isSafeInteger(payload.installation?.id)
        )
          return new Response(null, { status: 202 });
        const object = env.GAMES.get(
          env.GAMES.idFromName(String(payload.installation.id)),
        );
        return await object.fetch("https://game/enqueue", {
          method: "POST",
          body: JSON.stringify({ id, event, payload }),
        });
      }
      if (url.pathname.startsWith("/admin/")) {
        if (!authorized(request, env.ADMIN_TOKEN))
          return new Response(null, { status: 401 });
        if (
          ["/admin/status", "/admin/diagnostics", "/admin/archives"].includes(
            url.pathname,
          ) &&
          request.method === "GET"
        ) {
          const installation = Number(url.searchParams.get("installation"));
          if (!Number.isSafeInteger(installation) || installation <= 0)
            return new Response(null, { status: 400 });
          return env.GAMES.get(
            env.GAMES.idFromName(String(installation)),
          ).fetch("https://game/" + url.pathname.split("/").at(-1));
        }
        if (
          request.method === "POST" &&
          ["/admin/seed", "/admin/retry"].includes(url.pathname)
        ) {
          const data: unknown = JSON.parse(
            (await limitedBody(request, 16000)).toString(),
          );
          const input =
            url.pathname === "/admin/seed"
              ? parse(seedInput, data)
              : parse(z.object({ installation: positiveId }), data);
          if (
            !Number.isSafeInteger(input.installation) ||
            input.installation <= 0
          )
            return new Response(null, { status: 400 });
          return env.GAMES.get(
            env.GAMES.idFromName(String(input.installation)),
          ).fetch("https://game/" + url.pathname.split("/").at(-1), {
            method: "POST",
            body: JSON.stringify(input),
          });
        }
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      report({
        component: "http",
        event: "request_failed",
        reason: failureCode(error),
      });
      return new Response(
        error instanceof SyntaxError
          ? "Invalid JSON"
          : error instanceof InvalidData
            ? "Invalid request"
            : "Temporarily unavailable",
        {
          headers: { "cache-control": "no-store" },
          status:
            error instanceof SyntaxError || error instanceof InvalidData
              ? 400
              : 503,
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;

// One object per installation also receives installation-wide removal events.
// Only alarm() mutates game state asynchronously; ingress only persists jobs.
export class GameSession extends DurableObject<Env> {
  store: CloudStore;
  game: Game;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new CloudStore(ctx.storage.sql);
    this.game = new Game(
      this.store,
      (r) =>
        GitHub.fromKey(
          r.installation,
          r.repository,
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
        ),
      new CloudJudge(env),
      env.JUDGE_ENABLED === "true",
    );
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/status") return Response.json(this.store.all());
    if (path === "/archives") return Response.json(this.store.archives());
    if (path === "/diagnostics") return Response.json(this.store.failures());
    if (path === "/progress") {
      const run = this.store
        .all()
        .find(
          (r) =>
            r.repository ===
            Number(new URL(request.url).searchParams.get("repository")),
        );
      return Response.json({
        phase: run?.phase,
        failed: !!(run && this.store.hasFailed("seed:" + run.id)),
      });
    }
    const rawInput: unknown = await request.json();
    if (path === "/seed") {
      const input = parse(seedInput, rawInput);
      if (
        input.confirmDisposable !== true ||
        ![input.repository, input.player].every(
          (x) => Number.isSafeInteger(x) && x > 0,
        ) ||
        ![input.owner, input.repo].every(
          (x) =>
            typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(x),
        )
      )
        return new Response(
          "Invalid target or missing disposable-repository confirmation",
          { status: 400 },
        );
      if (this.store.all().some((r) => r.repository === input.repository))
        return new Response(
          "Repository already has a run; retry or use a fresh repository",
          { status: 409 },
        );
      const run = initialRun({
        id: randomUUID(),
        installation: input.installation,
        repository: input.repository,
        owner: input.owner,
        repo: input.repo,
        player: input.player,
        scenario: input.scenario,
      });
      try {
        const pack = await registry(this.env).pinned(
          run.scenario,
          this.ctx.storage,
        );
        if (!pack.stages.some((stage) => stage.id === run.scenario.stage))
          throw new Error("Unknown stage");
      } catch {
        return new Response("Unknown scenario package", { status: 400 });
      }
      // No external await may separate scheduling from the synchronous enqueue:
      // a cold registry lookup can outlast the alarm and leave work stranded.
      await this.ctx.storage.setAlarm(Date.now() + 100);
      let duplicate = false;
      this.ctx.storage.transactionSync(() => {
        if (this.store.all().some((r) => r.repository === input.repository)) {
          duplicate = true;
          return;
        }
        this.store.save(run);
        this.store.enqueue(
          "seed:" + run.id,
          "seed",
          JSON.stringify({ id: run.id }),
        );
      });
      if (duplicate)
        return new Response("Repository already has a run", { status: 409 });
      return Response.json(
        { runId: run.id, status: "queued" },
        { status: 202 },
      );
    }
    if (path === "/retry") {
      this.store.retryFailed();
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return Response.json({ status: "queued" });
    }
    if (path === "/enqueue") {
      const input = parse(
        z.object({ id: z.string(), event: z.string(), payload: z.unknown() }),
        rawInput,
      );
      const payload = parseWebhook(input.payload);
      if (!payload.repository && !this.store.all().length)
        return new Response(null, { status: 202 });
      if (
        payload.repository &&
        this.store.forRepository(payload.repository.id).length === 0
      )
        return new Response(null, { status: 202 });
      await this.ctx.storage.setAlarm(Date.now() + 100);
      this.store.enqueue(input.id, input.event, JSON.stringify(payload));
      return new Response(null, { status: 202 });
    }
    return new Response(null, { status: 404 });
  }
  async alarm() {
    try {
      await this.work();
    } catch (error) {
      report({
        component: "game",
        event: "scenario_unavailable",
        reason: failureCode(error),
      });
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    }
  }
  async work() {
    this.store.prune();
    const row = this.store.nextDelivery();
    try {
      if (row) {
        try {
          const payload: unknown = JSON.parse(row.body);
          const repository =
            row.event === "seed"
              ? undefined
              : parseWebhook(payload).repository?.id;
          const runs =
            row.event === "seed"
              ? [
                  this.store.get(
                    parse(z.object({ id: z.string() }), payload).id,
                  ),
                ]
              : repository
                ? this.store.forRepository(repository)
                : [];
          await registry(this.env).scope(
            runs.map((run) => run.scenario),
            this.ctx.storage,
            async () => {
              if (row.event === "seed") {
                const run = runs[0];
                if (run.phase === "seeding") await this.game.seed(run);
              } else await this.game.process(row.event, payload);
            },
          );
          this.store.completeDelivery(row.id);
        } catch (error) {
          this.store.failDelivery(row, error);
          report({
            component: "game",
            event: "delivery_failed",
            reason: failureCode(error),
            delivery: row.id,
            step: seedStepFrom(error),
          });
        }
      } else {
        for (const r of this.store.all())
          if (["active", "finishing"].includes(r.phase)) {
            const interval =
              r.phase === "finishing"
                ? 60000
                : r.mode === "milestone"
                  ? 120000
                  : 600000;
            this.store.enqueue(
              "reconcile:" + r.id + ":" + Math.floor(Date.now() / interval),
              "push",
              JSON.stringify({
                installation: { id: r.installation },
                repository: { id: r.repository },
              }),
            );
          }
      }
    } finally {
      const due = this.store.nextDeliveryTime();
      if (due !== undefined)
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, due));
      else {
        const runs = this.store
          .all()
          .filter((r) => ["active", "finishing"].includes(r.phase));
        if (runs.length)
          await this.ctx.storage.setAlarm(
            Date.now() +
              (runs.some((r) => r.phase === "finishing")
                ? 60000
                : runs.some((r) => r.mode === "milestone")
                  ? 120000
                  : 600000),
          );
      }
    }
  }
}
