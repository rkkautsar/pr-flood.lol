import { Octokit } from "@octokit/rest";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import * as schemas from "./github-schemas.ts";
import { parse } from "./validation.ts";
const MAX_GITHUB_BLOB_BYTES = 250_000;
export class GitHub {
  api: Octokit;
  requestCount = 0;
  constructor(token?: string, requestFetch?: typeof fetch) {
    this.api = new Octokit({
      auth: token,
      request: { timeout: 15000, fetch: requestFetch },
    });
    this.api.hook.wrap("request", async (request, options) => {
      this.requestCount++;
      return request(options);
    });
  }
  static async installation(id: number, repository: number) {
    const app = process.env.GITHUB_APP_ID,
      path = process.env.GITHUB_PRIVATE_KEY_PATH;
    if (!app || !path)
      throw new Error("Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY_PATH");
    return this.fromKey(id, repository, app, readFileSync(path, "utf8"));
  }
  static async fromKey(
    id: number,
    repository: number,
    app: string,
    key: string,
  ) {
    const api = this.app(app, key).api;
    const { data } = await api.apps.createInstallationAccessToken({
      installation_id: id,
      repository_ids: [repository],
    });
    return new GitHub(data.token);
  }
  static app(app: string, key: string) {
    const now = Math.floor(Date.now() / 1000),
      encode = (v: unknown) =>
        Buffer.from(JSON.stringify(v)).toString("base64url");
    const body =
      encode({ alg: "RS256", typ: "JWT" }) +
      "." +
      encode({ iat: now - 60, exp: now + 540, iss: app });
    const signature = createSign("RSA-SHA256")
      .update(body)
      .sign(key)
      .toString("base64url");
    return new GitHub(body + "." + signature);
  }
  async get(path: string) {
    return (await this.api.request("GET " + path)).data as unknown;
  }
  async post(path: string, body: Record<string, unknown>) {
    return (await this.api.request("POST " + path, body)).data as unknown;
  }
  async patch(path: string, body: Record<string, unknown>) {
    return (await this.api.request("PATCH " + path, body)).data as unknown;
  }
  async list(path: string) {
    return (await this.api.paginate("GET " + path, {
      per_page: 100,
    })) as unknown[];
  }
  async repository(root: string) {
    return parse(schemas.repositorySchema, await this.get(root));
  }
  async reference(root: string, branch: string) {
    return parse(
      schemas.referenceSchema,
      await this.get(root + "/git/ref/heads/" + branch),
    );
  }
  async pull(root: string, number: number) {
    return parse(schemas.pullSchema, await this.get(root + "/pulls/" + number));
  }
  async listIssues(root: string) {
    return (await this.list(root + "/issues?state=all")).map((x) =>
      parse(schemas.numberedSchema, x),
    );
  }
  async listMilestoneItems(root: string, milestone: number) {
    return (
      await this.list(root + "/issues?milestone=" + milestone + "&state=all")
    ).map((x) => parse(schemas.milestoneItemSchema, x));
  }
  async listSubIssues(root: string, parent: number) {
    return (await this.list(root + "/issues/" + parent + "/sub_issues")).map(
      (x) => parse(schemas.subIssueSchema, x),
    );
  }
  async listMilestones(root: string) {
    return (await this.list(root + "/milestones?state=all")).map((x) =>
      parse(schemas.numberedSchema, x),
    );
  }
  async listPulls(root: string) {
    return (await this.list(root + "/pulls?state=all")).map((x) =>
      parse(schemas.numberedSchema, x),
    );
  }
  async listPullDetails(root: string) {
    return (await this.list(root + "/pulls?state=all")).map((x) =>
      parse(schemas.pullListSchema, x),
    );
  }
  async listComments(path: string) {
    return (await this.list(path)).map((x) => parse(schemas.commentSchema, x));
  }
  async listReviews(root: string, number: number) {
    return (await this.list(root + "/pulls/" + number + "/reviews")).map((x) =>
      parse(schemas.reviewSchema, x),
    );
  }
  async listPullFiles(root: string, number: number) {
    return (await this.list(root + "/pulls/" + number + "/files")).map((x) =>
      parse(schemas.pullFileSchema, x),
    );
  }
  async checkRuns(root: string, sha: string) {
    return parse(
      schemas.checkRunsSchema,
      await this.get(root + "/commits/" + sha + "/check-runs?per_page=100"),
    ).check_runs;
  }
  async workflowRuns(root: string, sha: string) {
    return parse(
      schemas.workflowRunsSchema,
      await this.get(root + "/actions/runs?head_sha=" + sha + "&per_page=100"),
    ).workflow_runs;
  }
  async createNumbered(path: string, body: Record<string, unknown>) {
    return parse(schemas.numberedSchema, await this.post(path, body));
  }
  async createComment(path: string, body: string) {
    return parse(schemas.commentSchema, await this.post(path, { body }));
  }
  async readCommit(root: string, sha: string) {
    return parse(
      schemas.commitSchema,
      await this.get(root + "/git/commits/" + sha),
    );
  }
  async tree(root: string, sha: string) {
    const data = parse(
      schemas.treeSchema,
      await this.get(root + "/git/trees/" + sha + "?recursive=1"),
    );
    if (data.truncated) throw new Error("Unsupported truncated tree");
    const files: Record<string, string> = {};
    for (const entry of data.tree ?? []) {
      if (entry.type === "tree") continue;
      if (entry.type !== "blob" || entry.mode !== "100644")
        throw new Error("Unsupported file type");
      const blob = parse(
        schemas.blobSchema,
        await this.get(root + "/git/blobs/" + entry.sha),
      );
      if (blob.size > MAX_GITHUB_BLOB_BYTES) throw new Error("Oversized file");
      files[entry.path] = Buffer.from(blob.content, "base64").toString("utf8");
    }
    return files;
  }
  async treeFiles(root: string, sha: string, paths: string[]) {
    const data = parse(
      schemas.treeSchema,
      await this.get(root + "/git/trees/" + sha + "?recursive=1"),
    );
    if (data.truncated) throw new Error("Unsupported truncated tree");
    const entries = new Map(
      (data.tree ?? []).map((entry) => [entry.path, entry]),
    );
    const files: Record<string, string | undefined> = {};
    for (const path of paths) {
      const entry = entries.get(path);
      if (!entry) {
        files[path] = undefined;
        continue;
      }
      if (entry.type !== "blob" || entry.mode !== "100644")
        throw new Error("Unsupported file type");
      const blob = parse(
        schemas.blobSchema,
        await this.get(root + "/git/blobs/" + entry.sha),
      );
      if (blob.size > MAX_GITHUB_BLOB_BYTES) throw new Error("Oversized file");
      files[path] = Buffer.from(blob.content, "base64").toString("utf8");
    }
    return files;
  }
  async initialCommit(
    root: string,
    files: Record<string, string>,
    message: string,
  ) {
    const tree = parse(
      schemas.shaSchema,
      await this.post(root + "/git/trees", {
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          mode: "100644",
          type: "blob",
          content,
        })),
      }),
    );
    return parse(
      schemas.shaSchema,
      await this.post(root + "/git/commits", {
        message,
        tree: tree.sha,
        parents: [],
      }),
    );
  }
  async commit(
    root: string,
    parent: string,
    files: Record<string, string>,
    message: string,
    deletes: string[] = [],
  ) {
    const base = await this.readCommit(root, parent);
    const tree = parse(
      schemas.shaSchema,
      await this.post(root + "/git/trees", {
        base_tree: base.tree.sha,
        tree: [
          ...Object.entries(files).map(([path, content]) => ({
            path,
            mode: "100644",
            type: "blob",
            content,
          })),
          ...deletes.map((path) => ({
            path,
            mode: "100644",
            type: "blob",
            sha: null,
          })),
        ],
      }),
    );
    return parse(
      schemas.shaSchema,
      await this.post(root + "/git/commits", {
        message,
        tree: tree.sha,
        parents: [parent],
      }),
    );
  }
}
