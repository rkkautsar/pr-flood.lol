import { z } from "zod";
import type { Run } from "../types.ts";
import { parse, positiveId } from "../validation.ts";
const strings = z.array(z.string());
const files = z.record(z.string(), z.string());
const finding = z.object({
  reviewId: positiveId,
  category: z.enum(["absent", "vague", "identified", "consequence"]),
  revision: z.number().int().nonnegative(),
  reviewText: z.string().optional(),
});
const assessment = z.object({
  complete: strings,
  total: z.number(),
  points: z.number(),
  maximum: z.number(),
  success: z.boolean().nullable(),
  unverified: strings.optional(),
  warnings: strings.optional(),
  harmful: strings,
  debt: strings,
  decisions: z.array(
    z.object({
      id: z.string(),
      outcome: z.string(),
      points: z.number().nullable(),
      explanation: z.string(),
    }),
  ),
  reasoning: z.string(),
  scorecard: z
    .object({
      milestone: z.number().nullable(),
      issueBreakdown: z.number().nullable(),
      issueClarity: z.number().nullable(),
      pullRequestQuality: z.number().nullable(),
      reviewQuality: z.number().nullable(),
      clarificationRounds: z.number().int().nonnegative(),
      testStatus: z.enum(["passed", "failed", "pending", "missing"]),
    })
    .optional(),
});
export const runSchema: z.ZodType<Run> = z.object({
  id: z.string(),
  installation: positiveId,
  repository: positiveId,
  owner: z.string(),
  repo: z.string(),
  player: positiveId,
  phase: z.enum(["seeding", "active", "finishing", "finished", "inaccessible"]),
  mode: z.enum(["review", "milestone"]).optional(),
  scenario: z.object({
    id: z.string(),
    version: z.string(),
    stage: z.string(),
    digest: z.string(),
  }),
  milestoneChecks: z
    .array(
      z.object({
        stage: z.string(),
        title: z.string(),
        requiredCheck: z.string(),
        workflowPath: z.string(),
        protectedFiles: files,
      }),
    )
    .optional(),
  previousRun: z.string().optional(),
  reason: z.string().optional(),
  phaseBeforeAccessLoss: z
    .enum(["seeding", "active", "finishing", "finished", "inaccessible"])
    .optional(),
  warnings: strings.optional(),
  unverifiedIssues: strings.optional(),
  baseline: z.string().optional(),
  baselineFiles: files.optional(),
  observedFiles: files.optional(),
  base: z.string().optional(),
  milestone: positiveId.optional(),
  master: positiveId.optional(),
  issues: z.record(z.string(), positiveId),
  prs: z.record(
    z.string(),
    z.object({
      number: positiveId,
      revision: z.number().int().nonnegative(),
      outcome: z.enum(["open", "merged", "closed"]),
      head: z.string(),
      reviews: z.array(
        z.object({
          id: positiveId,
          body: z.string(),
          state: z.string(),
          commit: z.string(),
          submitted: z.string(),
        }),
      ),
      unscored: z.string().optional(),
    }),
  ),
  tree: z.string().optional(),
  contentHash: z.string().optional(),
  findings: z.record(z.string(), z.array(finding)),
  coaching: z
    .record(
      z.string(),
      z.array(
        z.object({
          reviewId: positiveId,
          revision: z.number().int().nonnegative(),
          fingerprint: z.string(),
          feedback: z
            .object({
              constructiveness: z
                .enum(["actionable", "supportive", "vague", "unconstructive"])
                .optional(),
              focus: z
                .enum([
                  "substantive",
                  "nitpick",
                  "automation",
                  "mixed",
                  "unclear",
                ])
                .optional(),
            })
            .optional(),
        }),
      ),
    )
    .optional(),
  storySent: z.record(z.string(), z.boolean()).optional(),
  result: assessment.optional(),
  finishEarly: z.boolean().optional(),
});
const envelope = z.object({ schemaVersion: z.literal(1), run: runSchema });
export function encodeRun(run: Run): string {
  return JSON.stringify({ schemaVersion: 1, run: parse(runSchema, run) });
}
export function decodeRun(value: string): Run {
  const data: unknown = JSON.parse(value);
  // Version zero was a bare Run. New versions must have an explicit migration.
  if (data !== null && typeof data === "object" && "schemaVersion" in data)
    return parse(envelope, data).run;
  return parse(runSchema, data);
}
