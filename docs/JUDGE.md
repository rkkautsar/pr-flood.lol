# Review and milestone judge

The Cloudflare Worker uses `@cf/cloudflare/clef-flash` through the existing Workers AI binding when judging is enabled. The request includes the model selector, curated state, and typed questions. No provider API key or new service is needed. Use `npm run cf:dev` to exercise this same Cloudflare AI path locally. The Node webhook service (`npm start`) is deterministic and does not call an AI provider; its default reviewer leaves review text unassessed.

## Gameplay and coaching

Review-game outcome scores remain deterministic. Concern matching classifies a review as absent, vague, identified, or consequence. These labels are mutually exclusive; only the review is evidence of what the player identified. A confident identified/consequence result on a request-changes review can trigger the prepared revision. `/game revise <PR-number>` remains available when matching abstains.

Milestone stages use the same Clef integration for one fixed scorecard across all player-selected worker models. The trusted E2E files are withheld from the player baseline so Louibot cannot run or inspect them during issue work. When the player comments `/game done` on the Game Master issue, PR Flood adds those protected files to the default branch and GitHub Actions runs them. A failed run keeps the stage active; a passing run triggers the scorecard and debrief. The outcome is worth 50 points. Clef separately scores issue breakdown (15), issue clarity (15), pull request quality (10), and review quality (10), each mapped from poor/mixed/good/excellent to 0/40/75/100. These rubrics and weights do not change by worker model. One broad issue can earn full milestone credit after the E2E check passes while receiving low breakdown credit. Each Louibot clarification question followed by a player response on an issue without a merged linked PR reduces its clarity rating by 10 points before weighting. Louibot's signed clarification comment is identified even when it shares the player's GitHub account. If Clef is unavailable or uncertain, affected quality dimensions remain unassessed; a passing E2E check still earns its full milestone credit.

At stage finish, the milestone judge receives the public objective, the scenario-authored four-part rubric, bounded issue conversations, selected PR diffs, player review text, and the protected E2E result. It returns structured labels only. Issue and PR text are untrusted data. The scorecard is frozen with the stage result.

Coaching makes a separate request with two questions:

| Dimension        | Allowed observations                                                  |
| ---------------- | --------------------------------------------------------------------- |
| Constructiveness | Actionable, supportive, vague, unconstructive wording                 |
| Focus            | Substantive, subjective nitpick, automation candidate, mixed, unclear |

The rubric treats security, accessibility, duplication and concrete maintenance costs as substantive. Calling a real bug a “nit” does not make it cosmetic. Firm technical disagreement is not an insult. Formatting/lint feedback is described as a possible automation candidate; the model cannot claim an existing lint configuration enforces it.

Only validated, confident labels become fixed advice in the PR’s end-of-stage debrief, with links to the original reviews. Uncertain dimensions are omitted. Coaching has **no path into points, concern credit, release success or revision decisions**. Tests assert score invariance and that coaching cannot trigger revisions.

Coaching covers the latest submitted player review on the current authored PR head and its attached inline comments, including sound PRs with no hidden concern. Blank, foreign-user and unsupported-head reviews are excluded. Each stage PR gets at most four coaching attempts across distinct reviews/edits; replayed deliveries reuse the attempt. Failures do not block gameplay or finishing. Finished stage scores and assessment evidence remain frozen; report presentation can be refreshed without reassessing the run.

## Configuration and spending

Current Worker variables in `wrangler.jsonc`:

```text
JUDGE_ENABLED=true
JUDGE_CONFIDENCE_THRESHOLD=0.2
REVIEW_COACHING_ENABLED=true
COACH_CONFIDENCE_THRESHOLD=0.3
JUDGE_INPUT_USD_PER_MILLION=0.038
AI_DAILY_BUDGET_USD=1
```

These are model-specific operational cutoffs, not claims of 20% or 30% correctness. Clef-flash reports a different confidence distribution from Jev; Jev's former 0.9 cutoff abstained on all 32 comparison examples. New deployments should calibrate before enabling.

Concern, coaching, and milestone-quality calls share the same atomic daily budget, while using separate cache identities and result types. At the cap, invalid output, uncertainty or inference failure, the affected text stays unassessed. Conservative reservations cover 32K input tokens per request and settle to valid reported usage. Requests are capped at 20KB of serialized input, below Flash's 24K-token context. Only structured labels are cached; arbitrary model text cannot become a debrief or a score. No gateway override is sent, so inference uses standard Workers AI billing. The cap counts list-price equivalent usage before any free allocation; other Cloudflare products and credit-purchase fees are separate.

Cloudflare lists [Clef-flash at $0.038/M input tokens](https://developers.cloudflare.com/workers-ai/models/clef-flash/), with no output-token charge, and a shared [10,000 free Neurons/day allowance](https://developers.cloudflare.com/workers-ai/platform/pricing/). At 3,455 Neurons/M input tokens, an otherwise unused allowance covers about 2.89M input tokens/day. Using both concern matching and coaching consumes two requests, so free tokens should not be interpreted as the same number of reviews or stage completions.

## Live calibration

These commands make real remote inference calls, each with a separate in-memory **$0.05 experiment ceiling**. They never change deployed settings. Reports stay in ignored `var/`.

```bash
npm run judge:calibrate -- all @cf/cloudflare/clef-flash
npm run judge:calibrate -- test/fixtures/judge-flash-validation.json @cf/cloudflare/clef-flash
CALIBRATE_COACHING=true npm run judge:calibrate -- test/fixtures/review-coaching.json @cf/cloudflare/clef-flash
```

The calibration script intentionally retains comparison-provider support, including Jev:

```bash
npm run judge:calibrate -- all typesafe/jev
npm run judge:calibrate -- all @cf/cloudflare/clef
```

The comparison runner defaults to each model's stated test cutoff; `CALIBRATION_THRESHOLD` can run an explicitly exploratory cutoff experiment. It uses the production parser and request shape, adding/removing the provider's required selector field. Allowances reset per invocation; they do not change or consume the production budget ledger.

Recorded calibration observations from 2026-10-15:

- Original Jev prompt: 7/20 accepted at 0.9; revised prompt: 18/20 accepted, with no false concern credit. A fresh set accepted 10/12, also with no false credit. One additional rounding-related rejection was subsequently fixed.
- Clef comparison at 0.9: Flash raw labels matched 30/32; full Clef matched 21/32; all answers abstained. The two Flash raw errors were grading-command examples, both rejected by confidence.
- Selecting 0.2 from the initial Flash comparison accepted 27/32, recognized all 16 positive reviews and awarded no false credit. This was exploratory threshold selection, not fresh validation.
- A subsequent fresh 16-review Flash set at 0.2 accepted 12/16, recognized 6/8 positives and awarded no false credit. This misses the earlier 80% positive-coverage target; the requested Flash trial keeps the conservative cutoff and leaves the two positives unassessed with the manual-revision fallback. List-price equivalent inference: $0.000673.
- Coaching at 0.3 accepted 22 of 30 labelled dimensions across 16 reviews. Every accepted labelled dimension matched; eight were omitted. Examples covered praise, vague requests, personal insults, firm security objections, accessibility, duplication, formatting, mixed feedback and grading commands. List-price equivalent inference: $0.000758.

These small authored sets are prototype evidence, not a general accuracy guarantee. The coaching experiment is separate from concern matching; improved tone or more comments never earns gameplay points. These recorded observations describe the authored calibration exercises; they do not establish general accuracy or verify the current work. For a fresh operational check, submit a review in an active playthrough, verify any prepared revision, then finish and inspect the advisory debrief.

## Provider alternatives

[OpenCode Console](https://opencode.ai/v2/docs/console/models/) currently lists `jev-1.13-free` as a limited-time free API model. [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/pricing) includes monthly free credits for eligible models; verify Jev eligibility rather than assuming every model qualifies. No provider fallback is configured in the game.
