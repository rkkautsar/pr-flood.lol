import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { decodeCoaching } from "../review-coaching.ts";
import type { Env } from "./env.ts";
const categories = ["absent", "vague", "identified", "consequence"];
function validMilestoneQuality(value: string) {
  const match =
    /^milestone-quality-v2:(\d{1,3}|unknown):(\d{1,3}|unknown):(\d{1,3}|unknown):(\d{1,3}|unknown)$/.exec(
      value,
    );
  return (
    !!match &&
    match.slice(1).every((score) => score === "unknown" || Number(score) <= 100)
  );
}
export class AIBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS charges(key TEXT PRIMARY KEY,day TEXT NOT NULL,reserved REAL NOT NULL,result TEXT,finalized INTEGER NOT NULL DEFAULT 0)",
    );
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS charges_by_day ON charges(day)",
    );
  }
  async fetch(request: Request): Promise<Response> {
    const result = z
      .object({
        key: z.string().regex(/^[a-f0-9]{64}$/),
        action: z.enum(["claim", "complete"]),
        result: z.string().nullable().optional(),
        inputTokens: z.number().int().nonnegative().max(32000).optional(),
      })
      .safeParse(await request.json());
    if (!result.success) return new Response(null, { status: 400 });
    const input = result.data;
    const key = input.key;
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))
      return new Response(null, { status: 400 });
    const sql = this.ctx.storage.sql;
    if (input.action === "claim") {
      const rate = Number(this.env.JUDGE_INPUT_USD_PER_MILLION),
        limit = Number(this.env.AI_DAILY_BUDGET_USD);
      if (
        !Number.isFinite(rate) ||
        rate <= 0 ||
        !Number.isFinite(limit) ||
        limit < 0
      )
        return Response.json({ claimed: false, reason: "configuration" });
      const cost = (32000 * rate) / 1e6,
        day = new Date().toISOString().slice(0, 10);
      const cutoff = new Date(Date.now() - 30 * 86400000)
        .toISOString()
        .slice(0, 10);
      // Expire cache/billing rows together, never current-day reservations.
      sql.exec("DELETE FROM charges WHERE day<?", cutoff);
      const result = this.ctx.storage.transactionSync(() => {
        const prior = sql
          .exec("SELECT result,finalized FROM charges WHERE key=?", key)
          .toArray()[0];
        if (prior)
          return {
            claimed: false,
            reason: prior.finalized ? "cached_unassessed" : "in_flight",
            result: prior.result ? JSON.parse(String(prior.result)) : null,
          };
        const total = Number(
          sql
            .exec(
              "SELECT COALESCE(SUM(reserved),0) AS n FROM charges WHERE day=?",
              day,
            )
            .toArray()[0].n,
        );
        if (total + cost > limit)
          return { claimed: false, reason: "budget_exhausted" };
        sql.exec(
          "INSERT INTO charges(key,day,reserved) VALUES(?,?,?)",
          key,
          day,
          cost,
        );
        return { claimed: true };
      });
      return Response.json(result);
    }
    if (
      input.action === "complete" &&
      (input.result === null ||
        (typeof input.result === "string" &&
          (categories.includes(input.result) ||
            validMilestoneQuality(input.result))) ||
        !!decodeCoaching(input.result))
    ) {
      const tokens = input.inputTokens;
      if (
        typeof tokens !== "number" ||
        !Number.isSafeInteger(tokens) ||
        tokens < 0 ||
        tokens > 32000
      )
        return new Response(null, { status: 400 });
      sql.exec(
        "UPDATE charges SET reserved=reserved*?/32000.0,result=?,finalized=1 WHERE key=? AND finalized=0",
        tokens,
        input.result === null ? null : JSON.stringify(input.result),
        key,
      );
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 400 });
  }
}
