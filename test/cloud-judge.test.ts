import { constructiveCriteria, focusCriteria } from "../src/review-coaching.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { CloudJudge } from "../src/cloudflare/judge.ts";
import type { Env } from "../src/cloudflare/env.ts";
function fixture(answer: any, claimed = true) {
  const calls: any[] = [];
  let requests = 0;
  const requestArgs: any[][] = [];
  const env = {
    JUDGE_ENABLED: "true",
    JUDGE_CONFIDENCE_THRESHOLD: "0.9",
    BUDGET: {
      idFromName: () => "global",
      get: () => ({
        fetch: async (_url: string, options: any) => {
          const body = JSON.parse(options.body);
          calls.push(body);
          return Response.json(
            body.action === "claim" ? { claimed } : { ok: true },
          );
        },
      }),
    },
    AI: {
      run: async (...args: any[]) => {
        requestArgs.push(args);
        requests++;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  } as unknown as Env;
  return {
    env,
    calls,
    requestArgs,
    requests: () => requests,
    judge: new CloudJudge(env),
  };
}
const response = (confidence = 0.99) => ({
  answers: {
    identification: {
      type: "choice",
      choice: "consequence",
      confidence,
      probabilities: { absent: 0, vague: 0, identified: 0, consequence: 1 },
    },
  },
  usage: { input_tokens: 500 },
});
test("Cloudflare judge reserves before inference and settles actual tokens", async () => {
  const f = fixture(response());
  assert.equal(
    await f.judge.evaluate("A specific concern", "Expected concern", {}),
    "consequence",
  );
  assert.equal(f.requests(), 1);
  assert.equal(f.requestArgs[0][0], "@cf/cloudflare/clef-flash");
  assert.equal(f.requestArgs[0][1].model, "clef-flash");
  assert.equal(f.requestArgs[0].length, 2);
  assert.deepEqual(
    f.calls.map((c) => c.action),
    ["claim", "complete"],
  );
  assert.equal(f.calls[1].inputTokens, 500);
  assert.equal(f.calls[1].result, "consequence");
});
test("disabled or exhausted Cloudflare judge makes no paid inference", async () => {
  const disabled = fixture(response());
  disabled.env.JUDGE_ENABLED = "false";
  assert.equal(
    await disabled.judge.evaluate("review", "concern", {}),
    undefined,
  );
  assert.equal(disabled.calls.length, 0);
  const exhausted = fixture(response(), false);
  assert.equal(
    await exhausted.judge.evaluate("review", "concern", {}),
    undefined,
  );
  assert.equal(exhausted.requests(), 0);
});
test("uncertain Cloudflare answer stays unassessed but settles its usage", async () => {
  const f = fixture(response(0.6));
  assert.equal(await f.judge.evaluate("review", "concern", {}), undefined);
  assert.equal(f.calls[1].result, null);
  assert.equal(f.calls[1].inputTokens, 500);
});
test("Cloudflare billing failure falls back without releasing its conservative reservation", async () => {
  const f = fixture(new Error("2021: Insufficient AI Gateway credits"));
  assert.equal(await f.judge.evaluate("review", "concern", {}), undefined);
  assert.deepEqual(
    f.calls.map((c) => c.action),
    ["claim"],
  );
});

test("live Cloudflare completion envelope is parsed and its actual usage settled", async () => {
  const f = fixture({ state: "Completed", result: response() });
  assert.equal(await f.judge.evaluate("review", "concern", {}), "consequence");
  assert.equal(f.calls[1].inputTokens, 500);
});
test("incomplete or failed Cloudflare envelopes cannot grant review credit", async () => {
  for (const state of ["Running", "Failed"]) {
    const f = fixture({ state, result: response() });
    assert.equal(await f.judge.evaluate("review", "concern", {}), undefined);
    assert.equal(f.calls.length, 1);
  }
});

test("two-decimal Jev probabilities tolerate rounding but reject malformed distributions", async () => {
  const rounded = response();
  rounded.answers.identification.probabilities = {
    absent: 0,
    vague: 0.02,
    identified: 0.04,
    consequence: 0.93,
  };
  assert.equal(
    await fixture(rounded).judge.evaluate("review", "concern", {}),
    "consequence",
  );
  const invalid = response();
  invalid.answers.identification.probabilities = {
    absent: 0,
    vague: 0.2,
    identified: 0.1,
    consequence: 0.93,
  };
  assert.equal(
    await fixture(invalid).judge.evaluate("review", "concern", {}),
    undefined,
  );
});

function choice(
  criteria: Record<string, string>,
  selected: string,
  confidence = 0.8,
) {
  return {
    type: "choice",
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(
      Object.keys(criteria).map((k) => [k, k === selected ? 1 : 0]),
    ),
  };
}
function score(value: number, confidence = 0.9) {
  return { type: "score", score: value, confidence };
}
test("coaching has separate questions, cache value, and low-confidence dimensions", async () => {
  const f = fixture({
    answers: {
      constructiveness: choice(constructiveCriteria, "actionable"),
      focus: choice(focusCriteria, "automation", 0.1),
    },
    usage: { input_tokens: 600 },
  });
  f.env.REVIEW_COACHING_ENABLED = "true";
  assert.deepEqual(await f.judge.coach("Please format this", {}), {
    constructiveness: "actionable",
  });
  assert.equal(f.calls[1].result, "coach-v1:actionable:unknown");
  assert.equal(f.requestArgs[0][1].questions.identification, undefined);
  assert.equal(f.requestArgs[0][1].state.expectedConcern, undefined);
});
test("disabled or empty coaching makes no inference request", async () => {
  const f = fixture({});
  assert.equal(await f.judge.coach("Looks good", {}), undefined);
  f.env.REVIEW_COACHING_ENABLED = "true";
  assert.equal(await f.judge.coach(" ", {}), undefined);
  assert.equal(f.requests(), 0);
});
test("coaching cannot substitute a fabricated choice or mismatched probabilities", async () => {
  const invalid = choice(focusCriteria, "substantive");
  invalid.choice = "nitpick";
  const f = fixture({
    answers: { focus: invalid },
    usage: { input_tokens: 100 },
  });
  f.env.REVIEW_COACHING_ENABLED = "true";
  assert.equal(await f.judge.coach("Missing owner check", {}), undefined);
});

test("milestone judge accepts score answers without a confidence cutoff", async () => {
  const f = fixture({
    answers: {
      issueBreakdown: score(0, 0.1),
      issueClarity: score(2),
      pullRequestQuality: score(3),
      reviewQuality: score(1),
    },
    usage: { input_tokens: 900 },
  });
  assert.deepEqual(
    await f.judge.gradeMilestone({
      objective: "Build a private inbox",
      testStatus: "passed",
      clarificationRounds: 0,
      issues: [],
      pullRequests: [],
    }),
    {
      issueBreakdown: 0,
      issueClarity: 75,
      pullRequestQuality: 100,
      reviewQuality: 40,
    },
  );
  assert.equal(f.requestArgs[0][1].questions.issueBreakdown.type, "score");
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ["claim", "complete"],
  );
  assert.equal(f.calls[1].inputTokens, 900);
  assert.match(f.calls[1].result, /^milestone-quality-v2:/);
});

test("invalid milestone score remains unassessed independently", async () => {
  const f = fixture({
    answers: {
      issueBreakdown: score(2),
      issueClarity: score(1),
      pullRequestQuality: score(3),
      reviewQuality: score(4),
    },
    usage: { input_tokens: 700 },
  });
  assert.deepEqual(
    await f.judge.gradeMilestone({
      objective: "Build a private inbox",
      testStatus: "passed",
      clarificationRounds: 0,
      issues: [],
      pullRequests: [],
    }),
    {
      issueBreakdown: 75,
      issueClarity: 40,
      pullRequestQuality: 100,
      reviewQuality: null,
    },
  );
});
