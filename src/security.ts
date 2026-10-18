import { createHmac, timingSafeEqual } from "node:crypto";
export function validSignature(
  raw: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export function command(
  body: string,
):
  | { kind: "finish" }
  | { kind: "done" }
  | { kind: "next" }
  | { kind: "reroll" }
  | { kind: "revise"; number: number }
  | undefined {
  if (body.trim() === "/game next") return { kind: "next" as const };
  if (body.trim() === "/game reroll") return { kind: "reroll" as const };
  if (body.trim() === "/game finish") return { kind: "finish" };
  if (body.trim() === "/game done") return { kind: "done" };
  const m = /^\/game revise ([1-9][0-9]*)$/.exec(body.trim());
  if (m) return { kind: "revise", number: Number(m[1]) };
}
