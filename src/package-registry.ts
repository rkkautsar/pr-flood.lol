import { createHash } from "node:crypto";
import { z } from "zod";
import { GitHub } from "./github.ts";
import { packageScope, type ScenarioPackage } from "./packages.ts";
import { parse } from "./validation.ts";
import { errorStatus, failureCode, report } from "./diagnostics.ts";

export async function publicRequest(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  cacheOverride?: Cache | null,
  sourceFetch: typeof fetch = fetch,
) {
  const request = new Request(input, init);
  const edge =
    cacheOverride !== undefined
      ? (cacheOverride ?? undefined)
      : typeof caches === "undefined"
        ? undefined
        : (caches as CacheStorage & { default?: Cache }).default;
  let cached: Response | undefined;
  try {
    cached = await edge?.match(request);
  } catch {
    // Cache availability must never block a successful source response.
  }
  if (cached) return cached;
  const response = await sourceFetch(request);
  if (!response.ok && new URL(request.url).hostname === "api.github.com") {
    const limited =
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after");
    report({
      component: "http",
      event: "scenario_source_rejected",
      reason: limited
        ? "rate_limited"
        : failureCode({ status: response.status }),
    });
  }
  if (edge && response.ok) {
    const copy = new Response(response.clone().body, response);
    copy.headers.set("cache-control", "public,max-age=300");
    // Public metadata is shared across cold isolates at the same edge location.
    // Cache availability must never block a successful source response.
    try {
      await edge.put(request, copy);
    } catch {
      /* best-effort cache */
    }
  }
  return response;
}

const id = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const manifestSchema = z
  .object({
    schema: z.literal(1),
    id,
    version,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    asset: z.literal("scenario.json"),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
const files = z.record(z.string(), z.string());
const variant = z
  .object({
    files,
    deletes: z.array(z.string()).optional(),
    sound: z.boolean(),
    satisfiesIssue: z.boolean().optional(),
    concern: z.string().optional(),
    explanation: z.string(),
    debt: z.string().optional(),
    serious: z.boolean().optional(),
    reply: z.string().optional(),
  })
  .strict();
const packageSchema = z
  .object({
    schema: z.literal(1),
    id,
    version,
    title: z.string(),
    description: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    characters: z.record(
      id,
      z
        .object({ name: z.string(), role: z.string(), avatar: z.string() })
        .strict(),
    ),
    stages: z
      .array(
        z
          .object({
            id,
            title: z.string(),
            intro: z.string(),
            baseline: files,
            mode: z.enum(["review", "milestone"]).optional(),
            requiredCheck: z.string().min(1).max(100).optional(),
            workflowPath: z.string().min(1).max(240).optional(),
            protectedFiles: z
              .array(z.string().min(1).max(240))
              .max(20)
              .optional(),
            evaluation: z
              .object({
                issueBreakdown: z.string().min(1).max(4000),
                issueClarity: z.string().min(1).max(4000),
                pullRequestQuality: z.string().min(1).max(4000),
                reviewQuality: z.string().min(1).max(4000),
              })
              .strict()
              .optional(),
            pool: z
              .string()
              .regex(/^[a-z][a-z0-9-]{0,47}$/)
              .optional(),
            issues: z
              .array(
                z.object({ id, title: z.string(), body: z.string() }).strict(),
              )
              .max(12),
            proposals: z
              .array(
                z
                  .object({
                    id,
                    title: z.string(),
                    body: z.string(),
                    issue: z.string().optional(),
                    group: z.string().optional(),
                    character: z.string().optional(),
                    followup: z.string().optional(),
                    lesson: z.string(),
                    variants: z.array(variant).min(1).max(4),
                  })
                  .strict(),
              )
              .max(15),
            endings: z
              .object({
                success: z.string(),
                incomplete: z.string(),
                partial: z.string(),
              })
              .strict(),
            next: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

export function validatePackage(value: unknown): ScenarioPackage {
  // Validate without reordering fields: historical package hashes cover authored
  // field order. A JSON parse/stringify round trip preserves that order.
  parse(packageSchema, value);
  const pack = value as ScenarioPackage;
  for (const stage of pack.stages) {
    const mode = stage.mode ?? "review";
    if (
      mode === "milestone" &&
      (!stage.requiredCheck ||
        !/^[A-Za-z0-9][A-Za-z0-9_. /-]{0,99}$/.test(stage.requiredCheck))
    )
      throw new Error("Invalid milestone check name");
    if (
      mode === "milestone" &&
      (!stage.requiredCheck ||
        !stage.workflowPath ||
        !stage.protectedFiles?.includes(stage.workflowPath) ||
        !stage.protectedFiles?.length ||
        !stage.evaluation ||
        stage.issues.length ||
        stage.proposals.length)
    )
      throw new Error("Invalid milestone stage configuration");
    if (
      mode === "review" &&
      (stage.requiredCheck || stage.workflowPath || stage.evaluation)
    )
      throw new Error("Review stages cannot define a milestone check");
    if (mode === "review" && stage.protectedFiles)
      throw new Error("Review stages cannot define protected milestone files");
    if (
      stage.protectedFiles &&
      (new Set(stage.protectedFiles).size !== stage.protectedFiles.length ||
        stage.protectedFiles.some(
          (path) =>
            path.startsWith("/") ||
            path
              .split("/")
              .some((part) => !part || part === "." || part === "..") ||
            !(path in stage.baseline),
        ))
    )
      throw new Error("Invalid protected milestone files");
    if (
      stage.evaluation &&
      Object.values(stage.evaluation).some(
        (value) => !value.trim() || value.length > 4000,
      )
    )
      throw new Error("Invalid milestone evaluation rubric");
    if (
      stage.workflowPath &&
      (!stage.workflowPath.startsWith(".github/workflows/") ||
        !(stage.workflowPath in stage.baseline))
    )
      throw new Error("Invalid milestone workflow path");
  }
  for (const pool of new Set(
    pack.stages.map((stage) => stage.pool).filter(Boolean),
  )) {
    const cards = pack.stages.filter((stage) => stage.pool === pool);
    if (cards.length < 2 || cards.some((stage) => stage.mode !== "milestone"))
      throw new Error("Milestone card pools need at least two milestone cards");
    const baseline = JSON.stringify(Object.entries(cards[0].baseline).sort());
    if (
      cards.some(
        (stage) =>
          JSON.stringify(Object.entries(stage.baseline).sort()) !== baseline,
      )
    )
      throw new Error(
        "Milestone cards in a pool must share one starting baseline",
      );
  }
  const { digest, ...content } = pack;
  const bytes = JSON.stringify(content);
  if (
    Buffer.byteLength(bytes) > 1800000 ||
    createHash("sha256").update(bytes).digest("hex") !== digest
  )
    throw new Error("Invalid scenario package digest or size");
  for (const character of Object.values(pack.characters)) {
    if (
      !/^<svg\s/.test(character.avatar) ||
      character.avatar.length > 20000 ||
      /<(?:script|foreignObject|image|use|style|a)\b|\bon\w+\s*=|(?:href|url\s*\()|<!|&/i.test(
        character.avatar,
      )
    )
      throw new Error("Unsafe scenario portrait");
  }
  return pack;
}

const releaseSchema = z.array(
  z.object({
    tag_name: z.string(),
    body: z.string().nullable().optional(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(
      z.object({
        id: z.number().int().positive(),
        name: z.string(),
        size: z.number(),
      }),
    ),
  }),
);
type Release = z.infer<typeof releaseSchema>[number];
export interface RegistryConfig {
  SCENARIO_REPOSITORIES?: string;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
}
export interface PackagePersistence {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<unknown>;
}

export class GitHubPackageRegistry {
  private metadata = new Map<
    string,
    {
      until: number;
      releases: Release[];
    }
  >();
  private tokens = new Map<string, { until: number; api: GitHub }>();
  private packages = new Map<string, ScenarioPackage>();
  private latestPackages?: { until: number; packages: ScenarioPackage[] };
  private publicRepositories = new Set<string>();
  private config: RegistryConfig;
  constructor(config: RegistryConfig) {
    this.config = config;
  }

  private repositories() {
    const repos = (this.config.SCENARIO_REPOSITORIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      !repos.length ||
      repos.length > 20 ||
      repos.some(
        (repo) =>
          !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo),
      )
    )
      throw new Error("Configure trusted SCENARIO_REPOSITORIES");
    return repos;
  }

  private async api(repo: string) {
    const cached = this.tokens.get(repo);
    if (cached && cached.until > Date.now()) return cached.api;
    const anonymous = new GitHub(undefined, publicRequest);
    try {
      const metadata = parse(
        z.object({ private: z.boolean() }),
        await anonymous.get(`/repos/${repo}`),
      );
      if (!metadata.private) {
        this.publicRepositories.add(repo);
        this.tokens.set(repo, {
          until: Date.now() + 50 * 60000,
          api: anonymous,
        });
        return anonymous;
      }
    } catch (error) {
      const status = errorStatus(error);
      if (
        status !== 404 &&
        !(
          [403, 429].includes(status ?? 0) &&
          this.config.GITHUB_APP_ID &&
          this.config.GITHUB_PRIVATE_KEY
        )
      )
        throw error;
    }
    this.publicRepositories.delete(repo);
    if (!this.config.GITHUB_APP_ID || !this.config.GITHUB_PRIVATE_KEY)
      throw new Error(
        "Private scenario repositories require GitHub App credentials and access",
      );
    const app = GitHub.app(
      this.config.GITHUB_APP_ID,
      this.config.GITHUB_PRIVATE_KEY,
    );
    const installation = parse(
      z.object({ id: z.number().int().positive() }),
      await app.get(`/repos/${repo}/installation`),
    );
    const token = parse(
      z.object({ token: z.string() }),
      await app.post(`/app/installations/${installation.id}/access_tokens`, {
        repositories: [repo.split("/")[1]],
        permissions: { contents: "read" },
      }),
    );
    const api = new GitHub(token.token);
    this.tokens.set(repo, { until: Date.now() + 50 * 60000, api });
    return api;
  }

  private async releases(repositories = this.repositories()) {
    const releases: { repo: string; release: Release }[] = [];
    for (const repo of repositories) {
      const cached = this.metadata.get(repo);
      if (cached && cached.until > Date.now()) {
        releases.push(...cached.releases.map((release) => ({ repo, release })));
        continue;
      }
      const repoReleases: Release[] = [];
      const api = await this.api(repo);
      for (let page = 1; page <= 10; page++) {
        const values = parse(
          releaseSchema,
          await api.get(`/repos/${repo}/releases?per_page=100&page=${page}`),
        );
        for (const release of values) {
          if (
            !release.draft &&
            !release.prerelease &&
            /^v\d+\.\d+\.\d+$/.test(release.tag_name)
          )
            repoReleases.push(release);
        }
        if (values.length < 100) break;
        if (page === 10)
          throw new Error("Scenario registry release limit exceeded");
      }
      this.metadata.set(repo, {
        until: Date.now() + 5 * 60000,
        releases: repoReleases,
      });
      releases.push(...repoReleases.map((release) => ({ repo, release })));
    }
    return releases;
  }

  private async manifest(repo: string, tag: "latest" | `v${string}`) {
    if (tag !== "latest" && !/^v\d+\.\d+\.\d+$/.test(tag))
      throw new Error("Invalid scenario release tag");
    const path =
      tag === "latest"
        ? `https://github.com/${repo}/releases/latest/download/scenario-manifest.json`
        : `https://github.com/${repo}/releases/download/${tag}/scenario-manifest.json`;
    const response = await fetch(path);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error("Scenario manifest download failed");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Scenario manifest download is empty");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 16000) {
        await reader.cancel();
        throw new Error("Scenario manifest exceeds size limit");
      }
      chunks.push(chunk.value);
    }
    const parsed = manifestSchema.safeParse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (!parsed.success) throw new Error("Invalid scenario manifest");
    return parsed.data;
  }

  private cachePackage(key: string, pack: ScenarioPackage) {
    if (this.packages.size >= 24)
      this.packages.delete(this.packages.keys().next().value!);
    this.packages.set(key, pack);
  }

  private async loadManifest(repo: string, manifest: Manifest) {
    const key = `${repo}:v${manifest.version}:${manifest.digest}`;
    const cached = this.packages.get(key);
    if (cached) return cached;
    const response = await fetch(
      `https://github.com/${repo}/releases/download/v${manifest.version}/${manifest.asset}`,
    );
    if (!response.ok) throw new Error("Scenario package download failed");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Scenario package download is empty");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 1900000) {
        await reader.cancel();
        throw new Error("Scenario package download exceeds size limit");
      }
      chunks.push(chunk.value);
    }
    const pack = validatePackage(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (
      pack.id !== manifest.id ||
      pack.version !== manifest.version ||
      pack.digest !== manifest.digest
    )
      throw new Error("Scenario manifest does not match package");
    this.cachePackage(key, pack);
    return pack;
  }

  private async load(repo: string, release: Release) {
    const assets = release.assets.filter((a) => a.name === "scenario.json");
    if (assets.length !== 1 || assets[0].size > 1900000)
      throw new Error("Missing or oversized scenario release asset");
    const key = `${repo}:${assets[0].id}`;
    const cached = this.packages.get(key);
    if (cached) return cached;
    const api = await this.api(repo);
    let raw: unknown;
    if (this.publicRepositories.has(repo)) {
      // Public release downloads use GitHub's asset CDN rather than spending
      // REST API quota on each package. Never attach App credentials here.
      const response = await fetch(
        `https://github.com/${repo}/releases/download/${release.tag_name}/scenario.json`,
      );
      if (!response.ok) throw new Error("Scenario package download failed");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Scenario package download is empty");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1900000) {
          await reader.cancel();
          throw new Error("Scenario package download exceeds size limit");
        }
        chunks.push(chunk.value);
      }
      raw = Buffer.concat(chunks);
    } else {
      const response = await api.api.request(
        "GET /repos/{owner}/{repo}/releases/assets/{asset_id}",
        {
          owner: repo.split("/")[0],
          repo: repo.split("/")[1],
          asset_id: assets[0].id,
          headers: { accept: "application/octet-stream" },
        },
      );
      raw = response.data;
    }
    const value =
      typeof raw === "string"
        ? JSON.parse(raw)
        : raw instanceof ArrayBuffer
          ? JSON.parse(new TextDecoder().decode(raw))
          : ArrayBuffer.isView(raw)
            ? JSON.parse(new TextDecoder().decode(raw))
            : raw;
    const pack = validatePackage(value);
    if (`v${pack.version}` !== release.tag_name)
      throw new Error("Scenario release tag does not match package");
    const advertisedDigest = release.body?.match(
      /^Scenario SHA-256: ([a-f0-9]{64})$/m,
    )?.[1];
    if (advertisedDigest !== pack.digest)
      throw new Error(
        "Scenario release digest metadata does not match package",
      );
    this.cachePackage(key, pack);
    return pack;
  }

  async latest() {
    if (this.latestPackages && this.latestPackages.until > Date.now())
      return this.latestPackages.packages;
    const packages: ScenarioPackage[] = [];
    for (const repo of this.repositories()) {
      const manifest = await this.manifest(repo, "latest");
      if (manifest) {
        packages.push(await this.loadManifest(repo, manifest));
        continue;
      }
      const candidates = (await this.releases([repo])).sort((a, b) =>
        b.release.tag_name
          .slice(1)
          .localeCompare(a.release.tag_name.slice(1), undefined, {
            numeric: true,
          }),
      );
      if (candidates[0])
        packages.push(await this.load(repo, candidates[0].release));
    }
    if (new Set(packages.map((p) => p.id)).size !== packages.length)
      throw new Error("Duplicate scenario IDs in registry");
    this.latestPackages = { until: Date.now() + 5 * 60000, packages };
    return packages;
  }

  async byDigest(digest: string) {
    const cached = [...this.packages.values()].find((p) => p.digest === digest);
    if (cached) return cached;
    const legacyRepos: string[] = [];
    const manifestRepos: string[] = [];
    for (const repo of this.repositories()) {
      const manifest = await this.manifest(repo, "latest");
      if (manifest?.digest === digest) {
        const pack = await this.loadManifest(repo, manifest);
        if (pack.digest !== digest)
          throw new Error("Scenario manifest digest mismatch");
        return pack;
      }
      (manifest ? manifestRepos : legacyRepos).push(repo);
    }
    for (const repo of [...legacyRepos, ...manifestRepos]) {
      const entry = (await this.releases([repo])).find(
        ({ release }) =>
          release.body?.match(/^Scenario SHA-256: ([a-f0-9]{64})$/m)?.[1] ===
          digest,
      );
      if (entry) {
        const pack = await this.load(entry.repo, entry.release);
        if (pack.digest !== digest)
          throw new Error("Release digest metadata mismatch");
        return pack;
      }
    }
    return undefined;
  }

  async pinned(
    selection: { id: string; version: string; digest?: string },
    storage?: PackagePersistence,
  ) {
    const cacheKey = selection.digest
      ? `scenario:${selection.digest}`
      : undefined;
    const saved =
      cacheKey && storage
        ? await storage.get<ScenarioPackage>(cacheKey)
        : undefined;
    if (saved) {
      const pack = validatePackage(saved);
      if (
        pack.id !== selection.id ||
        pack.version !== selection.version ||
        pack.digest !== selection.digest
      )
        throw new Error("Cached scenario identity mismatch");
      return pack;
    }
    if (!/^\d+\.\d+\.\d+$/.test(selection.version))
      throw new Error("Invalid scenario version");
    const legacyRepos: string[] = [];
    for (const repo of this.repositories()) {
      const manifest = await this.manifest(repo, `v${selection.version}`);
      if (!manifest) {
        const latestManifest = await this.manifest(repo, "latest");
        if (latestManifest && latestManifest.id !== selection.id) continue;
        legacyRepos.push(repo);
        continue;
      }
      if (manifest.version !== selection.version)
        throw new Error("Scenario manifest version mismatch");
      if (manifest.id !== selection.id) continue;
      if (selection.digest && manifest.digest !== selection.digest)
        throw new Error("Pinned scenario release changed");
      const pack = await this.loadManifest(repo, manifest);
      if (storage) await storage.put(`scenario:${pack.digest}`, pack);
      return pack;
    }
    for (const repo of legacyRepos) {
      for (const { release } of await this.releases([repo])) {
        if (release.tag_name !== `v${selection.version}`) continue;
        const pack = await this.load(repo, release);
        if (pack.id !== selection.id) continue;
        if (selection.digest && pack.digest !== selection.digest)
          throw new Error("Pinned scenario release changed");
        if (storage) await storage.put(`scenario:${pack.digest}`, pack);
        return pack;
      }
    }
    throw new Error("Scenario release is unavailable");
  }

  async scope<T>(
    selections: { id: string; version: string; digest?: string }[],
    storage: PackagePersistence | undefined,
    action: () => T,
  ): Promise<Awaited<T>> {
    const unique = [
      ...new Map(
        selections.map((s) => [`${s.id}:${s.version}:${s.digest ?? ""}`, s]),
      ).values(),
    ];
    const packages = await Promise.all(
      unique.map((s) => this.pinned(s, storage)),
    );
    return await packageScope.run(packages, action);
  }
}

// One bounded cache per configured source set; immutable packages are separately
// persisted by each Durable Object so in-progress games survive source outages.
let cached: { key: string; registry: GitHubPackageRegistry } | undefined;
export function registry(config: RegistryConfig) {
  const key = [
    config.SCENARIO_REPOSITORIES,
    config.GITHUB_APP_ID,
    createHash("sha256")
      .update(config.GITHUB_PRIVATE_KEY ?? "")
      .digest("hex"),
  ].join(":");
  if (!cached || cached.key !== key)
    cached = { key, registry: new GitHubPackageRegistry(config) };
  return cached.registry;
}
