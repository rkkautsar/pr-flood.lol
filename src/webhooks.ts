import { z } from "zod";
import { parse, positiveId } from "./validation.ts";

export const webhookEvents = new Set([
  "installation",
  "installation_repositories",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "issues",
  "push",
  "check_run",
]);
const repository = z.object({ id: positiveId });
export const webhookSchema = z.object({
  installation: z.object({ id: positiveId }),
  repository: repository.optional(),
  action: z.string().optional(),
  issue: z.object({ number: positiveId }).optional(),
  pull_request: z.object({ number: positiveId }).optional(),
  comment: z
    .object({
      id: positiveId.optional(),
      body: z.string(),
      user: z.object({ id: positiveId, type: z.string().optional() }),
    })
    .optional(),
  repositories_removed: z.array(repository).optional(),
  repositories_added: z.array(repository).optional(),
});
export type Webhook = z.infer<typeof webhookSchema>;
export function parseWebhook(input: unknown): Webhook {
  return parse(webhookSchema, input);
}
