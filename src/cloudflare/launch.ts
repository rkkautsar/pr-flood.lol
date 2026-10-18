import { DurableObject } from "cloudflare:workers";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { errorStatus, failureCode, report } from "../diagnostics.ts";
import { authorize } from "../launch/auth.ts";
import { LaunchError } from "../launch/errors.ts";
import { publicLaunch } from "../launch/presentation.ts";
import { provisionLaunch } from "../launch/provisioning.ts";
import { same } from "../launch/security.ts";
import type { Job, Login } from "../launch/types.ts";
import { registry } from "../package-registry.ts";
import { parse } from "../validation.ts";
import type { Env } from "./env.ts";
export { launchRoute } from "../launch/routes.ts";
export class LaunchSession extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === "/auth-limit") {
        const ok = await this.ctx.storage.transaction(async (txn) => {
          const now = Date.now(),
            rate = (await txn.get<{ until: number; count: number }>(
              "rate",
            )) ?? { until: now + 3600000, count: 0 };
          if (rate.until < now) {
            rate.until = now + 3600000;
            rate.count = 0;
          }
          if (rate.count >= 60) return false;
          rate.count++;
          await txn.put("rate", rate);
          return true;
        });
        await this.ctx.storage.setAlarm(Date.now() + 3600000);
        return Response.json(
          ok
            ? { ok: true }
            : { error: "Too many sign-in attempts. Try again later." },
          { status: ok ? 200 : 429 },
        );
      }
      if (path === "/quota") {
        const { id } = parse(
          z.object({ id: z.string() }),
          await request.json(),
        );
        const day = new Date().toISOString().slice(0, 10);
        const ok = await this.ctx.storage.transaction(async (txn) => {
          const value = (await txn.get<{ day: string; ids: string[] }>(
            "quota",
          )) ?? { day, ids: [] };
          if (value.day !== day) {
            value.day = day;
            value.ids = [];
          }
          if (value.ids.includes(id)) return true;
          if (value.ids.length >= 5) return false;
          value.ids.push(id);
          await txn.put("quota", value);
          return true;
        });
        if (!ok)
          return Response.json(
            { error: "You can create up to five playthroughs per day." },
            { status: 429 },
          );
        await this.ctx.storage.setAlarm(Date.now() + 86400000);
        return Response.json({ ok: true });
      }

      const auth = await authorize(request, this.env, this.ctx.storage);
      if (auth) return auth;
      const login = await this.login();
      if (path === "/api/session")
        return Response.json({
          ready: !!this.env.GITHUB_CLIENT_SECRET,
          user: login?.user ?? null,
          csrf: login?.csrf,
        });
      if (!login)
        throw new LaunchError(
          "Your session expired. Connect GitHub again.",
          401,
        );
      if (
        request.method === "POST" &&
        !same(request.headers.get("x-csrf-token") ?? "", login.csrf)
      )
        throw new LaunchError("Invalid request token. Reload the page.", 403);
      if (path === "/api/logout" && request.method === "POST") {
        await this.ctx.storage.delete("login");
        return Response.json({ ok: true });
      }
      if (path === "/api/launch/status" && request.method === "GET")
        return Response.json(await this.publicJob());
      if (path === "/api/launch" && request.method === "POST") {
        const raw = await request.text();
        if (raw.length > 16000)
          throw new LaunchError("Request too large.", 413);
        const input = parse(
            z.object({
              scenario: z.string(),
              version: z.string(),
              private: z.boolean(),
              name: z.string().optional(),
            }),
            JSON.parse(raw),
          ),
          pack = (await registry(this.env).latest()).find(
            (pack) =>
              pack.id === input.scenario && pack.version === input.version,
          );
        if (!pack)
          throw new LaunchError(
            "Scenario is not available for new games.",
            400,
          );
        if (typeof input.private !== "boolean")
          throw new LaunchError("Choose repository visibility.", 400);
        const previous = await this.ctx.storage.get<Job>("job");
        if (previous && !["ready", "failed"].includes(previous.state))
          return Response.json(await this.publicJob(), { status: 202 });
        if (
          previous?.state === "failed" &&
          previous.createSent &&
          !previous.repository
        )
          throw new LaunchError(
            "Retry the existing launch before creating another repository.",
            409,
          );
        const id = randomUUID(),
          name = input.name || `pr-flood-${pack.id}-${id.slice(0, 8)}`;
        if (
          typeof name !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name) ||
          name.endsWith(".git")
        )
          throw new LaunchError(
            "Use a repository name up to 80 letters, numbers, dots, underscores or hyphens.",
            400,
          );
        const pool = pack.stages[0].pool;
        const cards = pool
          ? pack.stages.filter((stage) => stage.pool === pool)
          : [];
        const stage = cards.length
          ? cards[
              parseInt(
                createHash("sha256").update(id).digest("hex").slice(0, 8),
                16,
              ) % cards.length
            ]
          : pack.stages[0];
        const job: Job = {
          id,
          owner: login.user.id,
          scenario: pack.id,
          version: pack.version,
          stage: stage.id,
          mode: stage.mode ?? "review",
          digest: pack.digest,
          marker: "PR Flood playthrough · " + id,
          name,
          private: input.private,
          state: "creating",
          attempts: 0,
          createdAt: Date.now(),
        };
        await this.ctx.storage.put(`scenario:${pack.digest}`, pack);
        let reserved = false;
        await this.ctx.storage.transaction(async (txn) => {
          const current = await txn.get<Job>("job");
          if (current && !["ready", "failed"].includes(current.state)) return;
          await txn.put("job", job);
          reserved = true;
        });
        if (!reserved)
          return Response.json(await this.publicJob(), { status: 202 });
        const quota = await this.env
          .LAUNCHES!.get(
            this.env.LAUNCHES!.idFromName("quota:" + login.user.id),
          )
          .fetch("https://launch/quota", {
            method: "POST",
            body: JSON.stringify({ id }),
          });
        if (!quota.ok) {
          job.state = "failed";
          job.error = "Daily playthrough limit reached.";
          await this.ctx.storage.put("job", job);
          return quota;
        }
        job.quotaGranted = true;
        await this.ctx.storage.put("job", job);
        await this.ctx.storage.setAlarm(Date.now() + 100);
        return Response.json(await this.publicJob(), { status: 202 });
      }
      if (path === "/api/launch/retry" && request.method === "POST") {
        const job = await this.ctx.storage.get<Job>("job");
        if (!job) throw new LaunchError("No playthrough to retry.", 404);
        if (job.state === "ready") return Response.json(await this.publicJob());
        if (!job.quotaGranted) {
          const quota = await this.env
            .LAUNCHES!.get(
              this.env.LAUNCHES!.idFromName("quota:" + login.user.id),
            )
            .fetch("https://launch/quota", {
              method: "POST",
              body: JSON.stringify({ id: job.id }),
            });
          if (!quota.ok) return quota;
          job.quotaGranted = true;
        }
        if (job.installation)
          await this.env.GAMES.get(
            this.env.GAMES.idFromName(String(job.installation)),
          ).fetch("https://game/retry", { method: "POST", body: "{}" });
        job.attempts = 0;
        job.state = job.repository ? "connecting" : "creating";
        delete job.error;
        await this.ctx.storage.put("job", job);
        await this.ctx.storage.setAlarm(Date.now() + 100);
        return Response.json(await this.publicJob(), { status: 202 });
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      report({
        component: "launch",
        event: "request_failed",
        reason: failureCode(error),
      });
      return Response.json(
        {
          error:
            error instanceof LaunchError
              ? error.message
              : "The request could not be completed. Try again.",
        },
        { status: error instanceof LaunchError ? error.status : 400 },
      );
    }
  }
  async login() {
    const login = await this.ctx.storage.get<Login>("login");
    if (login && login.expires > Date.now()) return login;
    await this.ctx.storage.delete("login");
    return undefined;
  }
  async publicJob() {
    return publicLaunch(
      await this.ctx.storage.get<Job>("job"),
      this.env.GITHUB_APP_SLUG,
    );
  }
  async alarm() {
    const login = await this.login(),
      job = await this.ctx.storage.get<Job>("job");
    if (!login) {
      await this.ctx.storage.delete("oauth");
      if (job && Date.now() < job.createdAt + 86400000)
        await this.ctx.storage.setAlarm(job.createdAt + 86400000);
      else await this.ctx.storage.deleteAll();
      return;
    }
    if (!job || ["ready", "failed", "waiting-access"].includes(job.state)) {
      await this.ctx.storage.setAlarm(login.expires);
      return;
    }
    try {
      await provisionLaunch(job, login, this.env, this.ctx.storage);
      job.attempts = 0;
      await this.ctx.storage.put("job", job);
      await this.ctx.storage.setAlarm(
        ["ready", "waiting-access"].includes(job.state)
          ? login.expires
          : Date.now() + 1500,
      );
    } catch (error) {
      report({
        component: "launch",
        event: "provision_failed",
        reason: failureCode(error),
      });
      job.attempts++;
      if (errorStatus(error) === 401) {
        job.state = "failed";
        job.error = "GitHub access expired. Connect GitHub again.";
      } else if (
        job.attempts >= 5 ||
        [403, 409, 422].includes(errorStatus(error) ?? 0)
      ) {
        job.state = "failed";
        job.error =
          errorStatus(error) === 409 || errorStatus(error) === 422
            ? "That repository name is already taken or cannot be created. Existing repositories were left unchanged."
            : errorStatus(error) === 403
              ? "GitHub denied a setup request. Confirm PR Flood is installed with access to this repository and approve any pending permission update, then resume setup."
              : "Setup could not finish after several attempts. Your repository is preserved; confirm PR Flood can access it, then resume setup. If access is already correct, try again later.";
      }
      await this.ctx.storage.put("job", job);
      await this.ctx.storage.setAlarm(
        job.state === "failed"
          ? login.expires
          : Date.now() + Math.min(60000, 2000 * 2 ** job.attempts),
      );
    }
  }
}
