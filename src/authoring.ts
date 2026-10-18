import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { ScenarioPackage, Stage } from "./packages.ts";
import type { Proposal, Variant } from "./types.ts";
import { parse as parseBoundary } from "./validation.ts";
/** These strict schemas validate without transforms or defaults. Preserve the
 * original key order: released package digests include the serialized metadata. */
function annotation<T>(schema: z.ZodType<T>, value: unknown): T {
  parseBoundary(schema, value);
  return value as T;
}
const idPattern = /^[a-z][a-z0-9-]{0,47}$/;
const characterSchema = z
  .object({
    name: z.string(),
    role: z.string(),
    avatar: z.string().optional(),
  })
  .strict();
const scenarioSchema = z
  .object({
    schema: z.number(),
    id: z.string(),
    version: z.string(),
    title: z.string(),
    description: z.string(),
    characters: z.record(z.string(), characterSchema),
    stages: z.array(z.string()),
    refPrefix: z.string().optional(),
  })
  .strict();
const stageSchema = z
  .object({
    title: z.string(),
    mode: z.enum(["review", "milestone"]).optional(),
    requiredCheck: z.string().optional(),
    workflowPath: z.string().optional(),
    protectedFiles: z.array(z.string()).optional(),
    visibleEvaluatorFiles: z.array(z.string()).max(20).optional(),
    evaluation: z
      .object({
        issueBreakdown: z.string(),
        issueClarity: z.string(),
        pullRequestQuality: z.string(),
        reviewQuality: z.string(),
      })
      .strict()
      .optional(),
    pool: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,47}$/)
      .optional(),
    endings: z
      .object({
        success: z.string(),
        incomplete: z.string(),
        partial: z.string(),
      })
      .strict(),
  })
  .strict();
const issueSchema = z.object({ id: z.string(), title: z.string() }).strict();
const assessmentFactsSchema = z
  .object({
    sound: z.boolean(),
    satisfiesIssue: z.boolean().optional(),
    concern: z.string().optional(),
    debt: z.string().optional(),
    explanation: z.string(),
    reply: z.string().optional(),
  })
  .strict();
const prSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    character: z.string(),
    issue: z.string().optional(),
    group: z.string().optional(),
    revisions: z.number(),
    assessment: z.record(z.string(), assessmentFactsSchema),
    followup: z.string().optional(),
  })
  .strict();
function need(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function text(v: unknown, name: string, max = 16000): asserts v is string {
  need(
    typeof v === "string" &&
      v.trim().length > 0 &&
      v.length <= max &&
      v.trim() !== "TODO",
    "Invalid " + name,
  );
}
function yaml(source: string): unknown {
  need(Buffer.byteLength(source) <= 32000, "Annotation exceeds 32KB");
  const doc = parseDocument(source, { uniqueKeys: true });
  need(!doc.errors.length, "Invalid YAML: " + doc.errors[0]?.message);
  return doc.toJS({ maxAliasCount: 0 }) as unknown;
}
export function markdown(source: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  need(match, "Markdown needs YAML frontmatter");
  const meta = annotation(z.record(z.string(), z.unknown()), yaml(match[1]));
  return { meta, body: match[2].trim() };
}
function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], {
    maxBuffer: 2000000,
    stdio: "pipe",
  });
}
function commit(repo: string, ref: string) {
  need(
    /^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(ref) && !ref.includes(".."),
    "Invalid ref",
  );
  let sha: string;
  try {
    sha = git(repo, "rev-parse", "--verify", `refs/heads/${ref}^{commit}`)
      .toString()
      .trim();
  } catch {
    // CI checks out one branch, while fetch-depth: 0 retains other captures as
    // remote-tracking refs. Resolve those without accepting ambiguous tags.
    sha = git(
      repo,
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${ref}^{commit}`,
    )
      .toString()
      .trim();
  }
  need(/^[0-9a-f]{40,64}$/.test(sha), "Invalid commit");
  return sha;
}
export function snapshot(repo: string, sha: string): Record<string, string> {
  const entries = git(repo, "ls-tree", "-rz", "--full-tree", sha)
    .toString()
    .split("\0")
    .filter(Boolean);
  const files: Record<string, string> = {};
  let total = 0;
  for (const entry of entries) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(entry);
    need(match, "Unsupported Git tree");
    const [, mode, type, blob, path] = match;
    if (path.split("/").includes("__scenario__")) continue;
    need(
      path.length < 240 &&
        !path
          .split("/")
          .some((x) => ["..", ".git", "node_modules", "data"].includes(x)),
      "Unsafe or generated application path: " + path,
    );
    need(
      !/(^|\/)\.env($|\.)|\.(pem|sqlite|sqlite3)$|(^|\/)\.dev\.vars/.test(path),
      "Secret/runtime file in application: " + path,
    );
    need(
      mode === "100644" && type === "blob",
      "Only regular text files supported: " + path,
    );
    const raw = git(repo, "cat-file", "blob", blob);
    total += raw.length;
    need(
      raw.length <= 250000 &&
        total <= 1000000 &&
        Object.keys(files).length < 120,
      "Scenario code exceeds publish limits",
    );
    const content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    need(
      !content.includes("\0") &&
        !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}/.test(
          content,
        ),
      "Binary/credential content in " + path,
    );
    files[path] = content;
  }
  need(Object.keys(files).length > 0, "Empty starting tree");
  return files;
}
const docs = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
    : [];
function change(base: Record<string, string>, next: Record<string, string>) {
  return {
    files: Object.fromEntries(
      Object.entries(next).filter(([p, c]) => base[p] !== c),
    ),
    deletes: Object.keys(base).filter((p) => !(p in next)),
  };
}
function allowedKeys(
  value: unknown,
  keys: string[],
  where: string,
): asserts value is Record<string, unknown> {
  need(
    value && typeof value === "object" && !Array.isArray(value),
    "Invalid " + where,
  );
  need(
    Object.keys(value).every((k) => keys.includes(k)),
    "Unknown field in " + where,
  );
}
export function publishScenario(repoInput: string): ScenarioPackage {
  const repo = resolve(repoInput),
    root = join(repo, "__scenario__"),
    config = annotation(
      scenarioSchema,
      yaml(readFileSync(join(root, "scenario.yaml"), "utf8")),
    );
  allowedKeys(
    config,
    [
      "schema",
      "id",
      "version",
      "title",
      "description",
      "characters",
      "stages",
      "refPrefix",
    ],
    "scenario",
  );
  need(
    config.schema === 1 && idPattern.test(config.id),
    "Invalid scenario schema/id",
  );
  need(/^\d+\.\d+\.\d+$/.test(config.version), "Version must be x.y.z");
  const refPrefix = config.refPrefix ?? "";
  need(
    !refPrefix || /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)+$/.test(refPrefix),
    "Invalid refPrefix",
  );
  text(config.title, "title", 100);
  text(config.description, "description", 1000);
  need(
    Array.isArray(config.stages) &&
      config.stages.length > 0 &&
      config.stages.length <= 8 &&
      new Set(config.stages).size === config.stages.length,
    "Invalid/duplicate stages",
  );
  const characters: ScenarioPackage["characters"] = {};
  for (const [id, raw] of Object.entries(config.characters ?? {})) {
    need(idPattern.test(id), "Invalid character ID");
    const c = annotation(characterSchema, raw);
    allowedKeys(c, ["name", "role", "avatar"], "character");
    text(c.name, "character name", 60);
    text(c.role, "character role", 100);
    const avatar = readFileSync(join(root, "characters", id + ".svg"), "utf8");
    // Portraits are deliberately restricted to simple locally-authored vector shapes.
    need(
      avatar.length < 20000 &&
        /^<svg\s/.test(avatar) &&
        !/<(?:script|foreignObject|image|use|style|a)\b|\bon\w+\s*=|(?:href|url\s*\()|<!|&/i.test(
          avatar,
        ),
      "Unsafe SVG portrait",
    );
    need(
      /^[\w .'-]+$/.test(c.name) && /^[\w .'-]+$/.test(c.role),
      "Invalid character display text",
    );
    characters[id] = { name: c.name, role: c.role, avatar };
  }
  const stages: Stage[] = [];
  for (const stageId of config.stages) {
    need(idPattern.test(stageId), "Invalid stage ID");
    const dir = join(root, "stages", stageId),
      doc = markdown(readFileSync(join(dir, "stage.md"), "utf8")),
      stageMeta = annotation(stageSchema, doc.meta);
    allowedKeys(
      stageMeta,
      [
        "title",
        "endings",
        "mode",
        "requiredCheck",
        "workflowPath",
        "protectedFiles",
        "visibleEvaluatorFiles",
        "evaluation",
        "pool",
      ],
      "stage",
    );
    text(stageMeta.title, "stage title", 150);
    text(doc.body, "stage brief");
    allowedKeys(
      stageMeta.endings,
      ["success", "incomplete", "partial"],
      "endings",
    );
    for (const value of Object.values(stageMeta.endings))
      text(value, "stage ending");
    need(
      Object.keys(stageMeta.endings).length === 3,
      "All three endings required",
    );
    const baseSha = commit(repo, `${refPrefix}stage/${stageId}/base`),
      baseline = snapshot(repo, baseSha);
    const issues = docs(join(dir, "issues")).map((file) => {
      const { meta, body } = markdown(
        readFileSync(join(dir, "issues", file), "utf8"),
      );
      const issueMeta = annotation(issueSchema, meta);
      allowedKeys(issueMeta, ["id", "title"], "issue");
      need(idPattern.test(issueMeta.id), "Invalid issue ID");
      text(issueMeta.title, "issue title", 150);
      text(body, "issue body");
      return { id: issueMeta.id, title: issueMeta.title, body };
    });
    const mode = stageMeta.mode ?? "review";
    if (mode === "review")
      need(
        issues.length > 0 &&
          issues.length <= 12 &&
          new Set(issues.map((i) => i.id)).size === issues.length,
        "Invalid/duplicate issues",
      );
    if (mode === "review")
      need(
        !stageMeta.requiredCheck &&
          !stageMeta.workflowPath &&
          !stageMeta.protectedFiles &&
          !stageMeta.visibleEvaluatorFiles &&
          !stageMeta.evaluation,
        "Review stages cannot define milestone-only fields",
      );
    const proposals: Proposal[] = docs(join(dir, "prs")).map((file) => {
      const { meta, body } = markdown(
        readFileSync(join(dir, "prs", file), "utf8"),
      );
      const prMeta = annotation(prSchema, meta);
      allowedKeys(
        prMeta,
        [
          "id",
          "title",
          "character",
          "issue",
          "group",
          "revisions",
          "assessment",
          "followup",
        ],
        "PR",
      );
      need(idPattern.test(prMeta.id), "Invalid PR ID");
      text(prMeta.title, "PR title", 150);
      need(characters[prMeta.character], "Unknown character");
      need(
        !prMeta.issue || issues.some((i) => i.id === prMeta.issue),
        "Unknown issue",
      );
      need(!prMeta.group || idPattern.test(prMeta.group), "Invalid group");
      need(
        Number.isInteger(prMeta.revisions) &&
          prMeta.revisions >= 0 &&
          prMeta.revisions <= 3,
        "revisions must be 0..3",
      );
      const parts = body.split("<!-- debrief -->");
      need(parts.length === 2, "PR needs one <!-- debrief --> separator");
      text(parts[0], "PR description");
      text(parts[1], "PR debrief");
      need(
        prMeta.assessment && typeof prMeta.assessment === "object",
        "Missing assessment",
      );
      const variants: Variant[] = [];
      let previous = baseSha;
      for (let n = 0; n <= prMeta.revisions; n++) {
        const label = n ? "rev-" + n : "initial",
          ref = `${refPrefix}stage/${stageId}/${prMeta.id}/${label}`,
          sha = commit(repo, ref);
        git(repo, "merge-base", "--is-ancestor", previous, sha);
        const facts = annotation(
          assessmentFactsSchema,
          prMeta.assessment[label],
        );
        allowedKeys(
          facts,
          [
            "sound",
            "satisfiesIssue",
            "concern",
            "debt",
            "explanation",
            "reply",
          ],
          "assessment " + label,
        );
        need(typeof facts.sound === "boolean", "sound must be boolean");
        text(facts.explanation, "explanation");
        if (facts.satisfiesIssue !== undefined)
          need(
            typeof facts.satisfiesIssue === "boolean",
            "satisfiesIssue must be boolean",
          );
        if (!facts.sound) text(facts.concern, "concern");
        if (facts.sound)
          need(
            !facts.concern && !facts.debt,
            "Sound revisions cannot retain concerns/debt",
          );
        if (n) text(facts.reply, "revision reply");
        const changes = change(baseline, snapshot(repo, sha));
        need(
          Object.keys(changes.files).length + changes.deletes.length > 0,
          "Empty PR revision",
        );
        variants.push({ ...facts, ...changes });
        previous = sha;
      }
      need(
        Object.keys(prMeta.assessment).length === variants.length,
        "Unexpected/missing assessment revision",
      );
      return {
        id: prMeta.id,
        title: prMeta.title,
        body: parts[0].trim(),
        lesson: parts[1].trim(),
        character: prMeta.character,
        issue: prMeta.issue,
        group: prMeta.group,
        followup: prMeta.followup,
        variants,
      };
    });
    if (mode === "review") {
      need(
        proposals.length > 0 &&
          proposals.length <= 15 &&
          new Set(proposals.map((p) => p.id)).size === proposals.length,
        "Invalid/duplicate PRs",
      );
      for (const issue of issues)
        need(
          proposals.some((p) => p.issue === issue.id),
          "Issue has no contribution: " + issue.id,
        );
    } else {
      need(
        issues.length === 0 && proposals.length === 0,
        "Milestone stages cannot pre-author issues or PRs",
      );
      need(
        typeof stageMeta.requiredCheck === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9_. /-]{0,99}$/.test(stageMeta.requiredCheck),
        "Milestone stages need a valid requiredCheck",
      );
      need(
        Array.isArray(stageMeta.protectedFiles) &&
          stageMeta.protectedFiles.length > 0 &&
          stageMeta.protectedFiles.length <= 20 &&
          new Set(stageMeta.protectedFiles).size ===
            stageMeta.protectedFiles.length,
        "Milestone stages need unique protected test and workflow files",
      );
      for (const path of stageMeta.protectedFiles) {
        need(
          typeof path === "string" &&
            path.length < 240 &&
            !path.startsWith("/") &&
            !path
              .split("/")
              .some((part) => !part || part === "." || part === "..") &&
            path in baseline,
          "Protected milestone files must be safe paths in the stage baseline",
        );
      }
      need(
        stageMeta.visibleEvaluatorFiles === undefined ||
          (new Set(stageMeta.visibleEvaluatorFiles).size ===
            stageMeta.visibleEvaluatorFiles.length &&
            stageMeta.visibleEvaluatorFiles.every((path) =>
              stageMeta.protectedFiles!.includes(path),
            )),
        "Visible evaluator files must be unique protected files",
      );
      need(
        typeof stageMeta.workflowPath === "string" &&
          stageMeta.workflowPath.startsWith(".github/workflows/") &&
          stageMeta.workflowPath in baseline &&
          stageMeta.protectedFiles.includes(stageMeta.workflowPath),
        "Milestone workflowPath must be a protected workflow in the stage baseline",
      );
      need(stageMeta.evaluation, "Milestone stages need an evaluation rubric");
      for (const value of Object.values(stageMeta.evaluation))
        text(value, "milestone evaluation rubric", 4000);
    }
    // Prevent accidental overlap between independent contributions; alternatives may share files.
    for (let a = 0; a < proposals.length; a++)
      for (let b = a + 1; b < proposals.length; b++) {
        const x = proposals[a],
          y = proposals[b];
        if (x.group && x.group === y.group) continue;
        const paths = (p: Proposal) =>
          new Set(
            p.variants.flatMap((v) => [
              ...Object.keys(v.files),
              ...(v.deletes ?? []),
            ]),
          );
        need(
          ![...paths(x)].some((path) => paths(y).has(path)),
          "Independent PRs overlap: " + x.id + " and " + y.id,
        );
      }
    for (const content of [
      doc.body,
      ...issues.map((i) => i.body),
      ...proposals.map((p) => p.body),
    ])
      for (const match of content.matchAll(/\{\{(issue|pr):([a-z0-9-]+)\}\}/g))
        need(
          match[1] === "issue"
            ? issues.some((i) => i.id === match[2])
            : proposals.some((p) => p.id === match[2]),
          "Unknown reference " + match[0],
        );
    for (const group of new Set(
      proposals.map((p) => p.group).filter(Boolean),
    )) {
      const members = proposals.filter((p) => p.group === group);
      need(
        members.length >= 2 && new Set(members.map((p) => p.issue)).size === 1,
        "Competing group must contain alternatives for the same issue",
      );
    }
    const stage = {
      id: stageId,
      title: stageMeta.title,
      intro: doc.body,
      baseline:
        mode === "milestone"
          ? Object.fromEntries(
              Object.entries(baseline).filter(
                ([path]) =>
                  !stageMeta.protectedFiles!.includes(path) ||
                  stageMeta.visibleEvaluatorFiles?.includes(path),
              ),
            )
          : baseline,
      ...(mode === "milestone"
        ? {
            mode,
            requiredCheck: stageMeta.requiredCheck,
            workflowPath: stageMeta.workflowPath,
            protectedFiles: stageMeta.protectedFiles,
            ...(stageMeta.visibleEvaluatorFiles
              ? { visibleEvaluatorFiles: stageMeta.visibleEvaluatorFiles }
              : {}),
            evaluatorFiles: Object.fromEntries(
              stageMeta.protectedFiles!.map((path) => [path, baseline[path]]),
            ),
            evaluation: stageMeta.evaluation,
            ...(stageMeta.pool ? { pool: stageMeta.pool } : {}),
          }
        : {}),
      issues,
      proposals,
      endings: stageMeta.endings,
    };
    stages.push(stage);
  }
  for (let i = 0; i < stages.length - 1; i++) stages[i].next = stages[i + 1].id;
  const data = {
    schema: 1 as const,
    id: config.id,
    version: config.version,
    title: config.title,
    description: config.description,
    characters,
    stages,
  };
  const serialized = JSON.stringify(data);
  need(
    Buffer.byteLength(serialized) <= 1800000,
    "Published package exceeds 1.8MB",
  );
  return {
    ...data,
    digest: createHash("sha256").update(serialized).digest("hex"),
  };
}
export function savePackage(pack: ScenarioPackage, dest: string) {
  mkdirSync(dest, { recursive: true });
  const file = join(dest, `${pack.id}-${pack.version}.json`),
    content = JSON.stringify(pack, null, 2) + "\n";
  if (existsSync(file))
    need(
      JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) ===
        JSON.stringify(pack),
      "Published version is immutable; increment version",
    );
  else writeFileSync(file, content);
  return file;
}
export function exportBaseline(
  pack: ScenarioPackage,
  dest: string,
  stageId = pack.stages[0].id,
) {
  need(!existsSync(dest), "Destination must not exist");
  const stage = pack.stages.find((s) => s.id === stageId);
  need(stage, "Unknown stage");
  for (const [path, content] of Object.entries(stage.baseline)) {
    const file = join(dest, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}
