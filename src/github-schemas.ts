import { z } from "zod";
import { positiveId } from "./validation.ts";
export const userSchema = z.object({
  id: positiveId,
  login: z.string(),
  type: z.string().optional(),
});
export const repositorySchema = z.object({
  id: positiveId,
  default_branch: z.string(),
  owner: z.object({ id: positiveId }),
  archived: z.boolean().optional(),
  disabled: z.boolean().optional(),
});
export const createdRepositorySchema = z.object({
  id: positiveId,
  name: z.string(),
  owner: z.object({ id: positiveId }),
  html_url: z.string(),
  description: z.string().nullable().optional(),
  created_at: z.string().optional(),
});
export const referenceSchema = z.object({
  object: z.object({ sha: z.string() }),
});
export const shaSchema = z.object({ sha: z.string() });
export const commitSchema = shaSchema.extend({
  tree: z.object({ sha: z.string() }),
  parents: z.array(z.object({ sha: z.string() })),
});
export const numberedSchema = z.object({
  number: positiveId,
  body: z.string().nullable().optional(),
  title: z.string().optional(),
});
export const pullSchema = numberedSchema.extend({
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  merged_by: z.object({ id: positiveId }).nullable().optional(),
  head: z.object({
    sha: z.string(),
    repo: z.object({ id: positiveId }).nullable().optional(),
  }),
  base: z.object({ ref: z.string() }),
});
export type GitHubPull = z.infer<typeof pullSchema>;
export const pullListSchema = numberedSchema.extend({
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable().optional(),
});
export const commentSchema = z.object({
  id: positiveId,
  body: z.string().nullable().optional(),
  created_at: z.string().optional(),
  user: z
    .object({ id: positiveId.optional(), type: z.string().optional() })
    .nullable()
    .optional(),
  pull_request_review_id: positiveId.optional(),
});
export const reviewSchema = z.object({
  id: positiveId,
  body: z.string().nullable().optional(),
  user: z.object({ id: positiveId }).nullable().optional(),
  state: z.string(),
  commit_id: z.string(),
  submitted_at: z.string().nullable().optional(),
});
export const milestoneItemSchema = z.object({
  number: positiveId,
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]),
  user: z
    .object({ id: positiveId.optional(), type: z.string().optional() })
    .nullable()
    .optional(),
  pull_request: z.object({ url: z.string() }).optional(),
});
export const subIssueSchema = z.object({
  number: positiveId,
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]).optional(),
  user: z
    .object({ id: positiveId.optional(), type: z.string().optional() })
    .nullable()
    .optional(),
  pull_request: z.object({ url: z.string() }).optional(),
});
export const pullFileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  patch: z.string().optional(),
});
export const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
      app: z.object({ slug: z.string().optional() }).nullable().optional(),
      check_suite: z.object({ id: positiveId }).optional(),
    }),
  ),
});
export const workflowRunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      name: z.string().optional(),
      path: z.string(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
      check_suite_id: positiveId,
      created_at: z.string().optional(),
    }),
  ),
});
export const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string(),
    }),
  ),
});
export const blobSchema = z.object({ size: z.number(), content: z.string() });
