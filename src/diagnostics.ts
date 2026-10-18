import { asRecord } from "./validation.ts";
import { seedStepFrom, type SeedStep } from "./game/seed-steps.ts";

export type FailureCode =
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_data"
  | "timeout"
  | "provider_error"
  | "unexpected_error";
export function errorStatus(error: unknown): number | undefined {
  const status = asRecord(error).status;
  return typeof status === "number" ? status : undefined;
}
export function failureCode(error: unknown): FailureCode {
  const status = errorStatus(error);
  if (status === 429) return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.message === "Invalid boundary data")
    return "invalid_data";
  return status && status >= 500 ? "provider_error" : "unexpected_error";
}
export type Diagnostic = {
  component: "game" | "launch" | "judge" | "http";
  event: string;
  reason?: string;
  dimension?: string;
  run?: string;
  delivery?: string;
  requests?: number;
  step?: SeedStep;
};
export type Reporter = (diagnostic: Diagnostic) => void;
// Only allowlisted fields are serialized. Never accept raw errors or payloads.
export const report: Reporter = ({
  component,
  event,
  reason,
  dimension,
  run,
  delivery,
  requests,
  step,
}) => {
  console.info(
    JSON.stringify({
      component,
      event,
      reason,
      dimension,
      run,
      delivery,
      requests,
      step: seedStepFrom({ step }),
    }),
  );
};
