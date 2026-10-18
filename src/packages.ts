import { AsyncLocalStorage } from "node:async_hooks";
import type { Proposal, Run, Variant } from "./types.ts";
export type Character = { name: string; role: string; avatar: string };
export type StageMode = "review" | "milestone";
export type Stage = {
  id: string;
  title: string;
  intro: string;
  baseline: Record<string, string>;
  /** Missing on historical releases; those stages use the original PR game. */
  mode?: StageMode;
  /** A trusted GitHub Actions check that proves the stage's behavioral tests. */
  requiredCheck?: string;
  /** Exact seeded workflow path used to bind the check to the trusted suite. */
  workflowPath?: string;
  /** Test and workflow files that must remain identical to the seeded baseline. */
  protectedFiles?: string[];
  /** Scenario-specific rubric for the four non-outcome scorecard dimensions. */
  evaluation?: {
    issueBreakdown: string;
    issueClarity: string;
    pullRequestQuality: string;
    reviewQuality: string;
  };
  /** Cards sharing a pool are alternative milestone briefs over one evolving app. */
  pool?: string;
  issues: { id: string; title: string; body: string }[];
  proposals: Proposal[];
  endings: { success: string; incomplete: string; partial: string };
  next?: string;
};
export type ScenarioPackage = {
  schema: 1;
  id: string;
  version: string;
  title: string;
  description: string;
  digest: string;
  characters: Record<string, Character>;
  stages: Stage[];
};
// Package context belongs to one request or background job. Pure game functions
// remain synchronous without sharing a mutable catalogue across concurrent runs.
export const packageScope = new AsyncLocalStorage<readonly ScenarioPackage[]>();
function packages() {
  const value = packageScope.getStore();
  if (!value) throw new Error("Scenario package context has not been loaded");
  return value;
}
// Keep old immutable releases available for existing runs, but offer the latest
// version of each scenario when starting a new playthrough.
export const catalog = (): ScenarioPackage[] => {
  const latest = new Map<string, ScenarioPackage>();
  for (const pack of packages()) {
    const current = latest.get(pack.id);
    if (
      !current ||
      pack.version.localeCompare(current.version, undefined, {
        numeric: true,
      }) > 0
    )
      latest.set(pack.id, pack);
  }
  return [...latest.values()];
};
export function findPackage(id: string, version?: string): ScenarioPackage {
  const candidates = (version ? packages() : catalog()).filter(
    (p) => p.id === id && (!version || p.version === version),
  );
  if (candidates.length !== 1)
    throw new Error("Unknown or ambiguous scenario package");
  return candidates[0];
}
export function scenarioFor(run: Run): Stage & { pack: ScenarioPackage } {
  const pack = findPackage(run.scenario.id, run.scenario.version);
  if (pack.digest !== run.scenario.digest)
    throw new Error("Scenario package digest mismatch");
  const stage = pack.stages.find((s) => s.id === run.scenario.stage);
  if (!stage) throw new Error("Unknown scenario stage");
  return { ...stage, pack };
}
export function selectScenario(
  pack: ScenarioPackage,
  stage = pack.stages[0].id,
): NonNullable<Run["scenario"]> {
  if (!pack.stages.some((s) => s.id === stage))
    throw new Error("Unknown scenario stage");
  return { id: pack.id, version: pack.version, digest: pack.digest, stage };
}
export function authoredVariant(
  run: Run,
  id: string,
  revision: number,
): Variant {
  const p = scenarioFor(run).proposals.find((p) => p.id === id);
  if (!p || !Number.isInteger(revision) || !p.variants[revision])
    throw new Error("Unknown authored revision");
  return p.variants[revision];
}
export function applyVariant(files: Record<string, string>, v: Variant) {
  Object.assign(files, v.files);
  for (const path of v.deletes ?? []) delete files[path];
  return files;
}
export function publicCharacter(run: Run, id?: string): string {
  const { pack } = scenarioFor(run),
    c = id ? pack.characters[id] : undefined;
  if (!c) return "";
  const origin = process.env.PUBLIC_ORIGIN ?? "https://pr-flood.lol";
  return `<img src="${origin}/portraits/${pack.digest}/${id}.svg" width="56" height="56" alt="${c.name}" />\n\n**${c.name} · ${c.role}**\n\n`;
}
export function renderLinks(text: string, run: Run) {
  return text.replace(/\{\{(issue|pr):([a-z0-9-]+)\}\}/g, (_, kind, id) => {
    const number = kind === "issue" ? run.issues[id] : run.prs[id]?.number;
    return number ? "#" + number : "(pending " + id + ")";
  });
}
